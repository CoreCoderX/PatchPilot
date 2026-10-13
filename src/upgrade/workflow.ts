import * as fs from "node:fs/promises";
import type { Dirent } from "node:fs";
import * as path from "node:path";
import type { ChatProvider } from "../ai/types";
import type { ConsentMessage } from "../ui/consentText";
import { buildConsentMessage } from "../ui/consentText";
import { EXCLUDED_DIRECTORIES } from "../analysis/detect";
import { describeUnknownError } from "../log";
import { sha256 } from "./edits";
import { checkCommand, COMMAND_TEMPLATES, executableFor } from "./commands";
import { runExec, type ExecRequest, type ExecResult } from "./exec";
import { buildRepairPrompt, applyRepairEdits, failureSignature, isModelEditable, parseRepairReply } from "./repair";
import { safeWorkspacePath, SnapshotStore, type CommandRecord, type PlanRecord, type RollbackReport } from "./store";
import type { PlannedCommand, UpgradePlan } from "./types";

export interface ExecutorOptions {
  readonly root: string;
  readonly timeoutMs: number;
  readonly maxOutputBytes: number;
  readonly knownSecrets: () => readonly string[];
}

/** Builds the command runner. Checks each command again immediately before it starts. */
export function createExecutor(options: ExecutorOptions): (command: PlannedCommand, signal: AbortSignal) => Promise<ExecResult> {
  return async (command, signal) => {
    const check = checkCommand(command, options.root);
    if (!check.ok) {
      return {
        exitCode: null,
        timedOut: false,
        cancelled: false,
        spawnError: `refused: ${check.reason}`,
        durationMs: 0,
        output: "",
        outputTruncated: false
      };
    }
    const template = COMMAND_TEMPLATES[command.template];
    const args = template.takesFile && command.fileArg !== undefined ? [...template.args, command.fileArg] : [...template.args];
    const request: ExecRequest = {
      executable: executableFor(template),
      args,
      cwd: path.resolve(options.root, command.cwd),
      timeoutMs: options.timeoutMs,
      maxOutputBytes: options.maxOutputBytes,
      knownSecrets: options.knownSecrets(),
      signal
    };
    return runExec(request);
  };
}

export interface WorkflowDeps {
  readonly root: string;
  readonly store: SnapshotStore;
  readonly exec: (command: PlannedCommand, signal: AbortSignal) => Promise<ExecResult>;
  readonly now: () => Date;
  readonly log: (message: string) => void;
}

export type ApplyOutcome =
  | { readonly status: "applied"; readonly message: string }
  | { readonly status: "refused"; readonly message: string }
  | { readonly status: "conflict"; readonly message: string; readonly files: readonly string[] }
  | { readonly status: "failed-reverted"; readonly message: string; readonly rollback: RollbackReport };

async function readWorkspaceFile(root: string, relative: string): Promise<string | undefined> {
  try {
    return await fs.readFile(safeWorkspacePath(root, relative), "utf8");
  } catch {
    return undefined;
  }
}

function lockfileFor(command: PlannedCommand): string {
  return command.cwd === "." ? "package-lock.json" : `${command.cwd}/package-lock.json`;
}

function selectCommands(plan: UpgradePlan, selectedIds: readonly string[], phase: "apply" | "validate"): PlannedCommand[] {
  const wanted = new Set(selectedIds);
  return plan.commands.filter((command) => command.phase === phase && wanted.has(command.id));
}

/**
 * Applies the plan's edits and any selected apply-phase commands as one step. Every file is
 * hash-checked first; any change since the review refuses the whole apply. If a write or
 * command fails, the step is rolled back and the result says so.
 */
export async function applyPlan(record: PlanRecord, selectedCommandIds: readonly string[], deps: WorkflowDeps, signal: AbortSignal): Promise<ApplyOutcome> {
  const plan = record.plan;
  if (plan.status !== "proposed") {
    return { status: "refused", message: `This plan is ${plan.status}. Create a new plan to make further changes.` };
  }
  const changed: string[] = [];
  for (const edit of plan.edits) {
    const current = await readWorkspaceFile(deps.root, edit.path);
    if (current === undefined || sha256(current) !== edit.originalHash) {
      changed.push(edit.path);
    }
  }
  if (changed.length > 0) {
    return { status: "conflict", message: "These files changed after the plan was made. Nothing was written. Create a new plan.", files: changed };
  }

  const commands = selectCommands(plan, selectedCommandIds, "apply");
  for (const command of commands) {
    const check = checkCommand(command, deps.root);
    if (!check.ok) {
      return { status: "refused", message: `Command ${command.id} refused: ${check.reason}.` };
    }
  }
  const paths = [
    ...plan.edits.map((edit) => edit.path),
    ...commands.filter((command) => command.template === "npm-lock-refresh").map(lockfileFor)
  ];
  const stepIndex = await deps.store.beginStep(record, deps.root, "apply planned edits and selected commands", paths, deps.now().toISOString());
  const startedAt = deps.now().toISOString();
  try {
    for (const edit of plan.edits) {
      await fs.writeFile(safeWorkspacePath(deps.root, edit.path), edit.proposedText, "utf8");
    }
  } catch (error) {
    const rollback = await deps.store.rollback(record, deps.root);
    record.plan = { ...plan, status: rollback.verified ? "apply-failed" : "rollback-failed" };
    await deps.store.saveRecord(record);
    return { status: "failed-reverted", message: `Writing files failed: ${describeUnknownError(error)}`, rollback };
  }

  for (const command of commands) {
    const started = deps.now().toISOString();
    const result = await deps.exec(command, signal);
    const run: CommandRecord = SnapshotStore.commandRecord(command.id, command.displayLine, "apply", started, result);
    record.commandRuns.push(run);
    if (!run.passed) {
      await deps.store.finishStep(record, deps.root, stepIndex).catch(() => undefined);
      const rollback = await deps.store.rollback(record, deps.root);
      record.plan = { ...plan, status: rollback.verified ? "apply-failed" : "rollback-failed" };
      await deps.store.saveRecord(record);
      return {
        status: "failed-reverted",
        message: `Command ${command.id} did not succeed (${run.spawnError ?? (run.timedOut ? "timed out" : run.cancelled ? "cancelled" : `exit ${String(run.exitCode)}`)}). Changes were rolled back.`,
        rollback
      };
    }
  }
  await deps.store.finishStep(record, deps.root, stepIndex);
  record.plan = { ...plan, status: "applied" };
  await deps.store.saveRecord(record);
  deps.log(`Plan ${plan.id} applied at ${startedAt}: ${String(plan.edits.length)} file(s), ${String(commands.length)} command(s).`);
  return { status: "applied", message: `Applied ${String(plan.edits.length)} file edit(s) and ${String(commands.length)} command(s). Validation has not run yet.` };
}

export type ValidationStatus = "validated" | "partially-validated" | "validation-failed" | "unresolved";

export interface ValidationOutcome {
  readonly status: ValidationStatus;
  readonly message: string;
  readonly runs: readonly CommandRecord[];
}

/** Latest run per command id, in plan order. */
export function latestValidationRuns(record: PlanRecord): Map<string, CommandRecord> {
  const latest = new Map<string, CommandRecord>();
  for (const run of record.commandRuns) {
    if (run.phase === "validate") {
      latest.set(run.commandId, run);
    }
  }
  return latest;
}

export function summarizeValidation(plan: UpgradePlan, latest: ReadonlyMap<string, CommandRecord>): { status: ValidationStatus; message: string } {
  const planned = plan.commands.filter((command) => command.phase === "validate");
  if (planned.length === 0) {
    return { status: "unresolved", message: "No validation command exists for this plan. Nothing was validated." };
  }
  const runs = planned.map((command) => latest.get(command.id));
  const failed = runs.filter((run): run is CommandRecord => run !== undefined && !run.passed);
  const passed = runs.filter((run) => run?.passed === true).length;
  if (failed.length > 0) {
    return { status: "validation-failed", message: `${String(failed.length)} validation command(s) failed: ${failed.map((run) => run.commandId).join(", ")}.` };
  }
  if (passed === planned.length) {
    return { status: "validated", message: `All ${String(planned.length)} validation command(s) passed.` };
  }
  if (passed > 0) {
    return { status: "partially-validated", message: `${String(passed)} of ${String(planned.length)} validation command(s) passed; the rest did not run.` };
  }
  return { status: "unresolved", message: "No validation command ran to completion. Nothing was validated." };
}

/** Runs the selected validation commands in plan order. Requires an applied plan. */
export async function validatePlan(record: PlanRecord, selectedCommandIds: readonly string[], deps: WorkflowDeps, signal: AbortSignal): Promise<ValidationOutcome> {
  if (record.plan.status !== "applied" && record.plan.status !== "validation-failed" && record.plan.status !== "validated") {
    return { status: "unresolved", message: `This plan is ${record.plan.status}; validation runs only after apply.`, runs: [] };
  }
  const commands = selectCommands(record.plan, selectedCommandIds, "validate");
  const runs: CommandRecord[] = [];
  for (const command of commands) {
    if (signal.aborted) {
      break;
    }
    const started = deps.now().toISOString();
    const result = await deps.exec(command, signal);
    const run = SnapshotStore.commandRecord(command.id, command.displayLine, "validate", started, result);
    record.commandRuns.push(run);
    runs.push(run);
  }
  const summary = summarizeValidation(record.plan, latestValidationRuns(record));
  const notRun = commands.length - runs.length;
  if (summary.status === "validation-failed") {
    record.plan = { ...record.plan, status: "validation-failed" };
  } else if (summary.status === "validated") {
    record.plan = { ...record.plan, status: "validated" };
  }
  await deps.store.saveRecord(record);
  const message = notRun > 0 ? `${summary.message} ${String(notRun)} command(s) were not run because validation was cancelled.` : summary.message;
  return { status: summary.status, message, runs };
}

export async function rollbackPlan(record: PlanRecord, deps: WorkflowDeps): Promise<RollbackReport> {
  const report = await deps.store.rollback(record, deps.root);
  record.plan = { ...record.plan, status: report.verified ? "rolled-back" : "rollback-failed" };
  await deps.store.saveRecord(record);
  return report;
}

export interface RepairUi {
  confirmModelSend(message: ConsentMessage): Promise<boolean>;
  approveEdits(changes: readonly { readonly path: string; readonly before: string; readonly after: string }[]): Promise<boolean>;
}

export interface RepairOptions {
  readonly provider: ChatProvider;
  readonly model: string;
  readonly maxIterations: number;
  readonly exclusions: readonly string[];
  readonly selectedCommandIds: readonly string[];
  readonly ui: RepairUi;
  readonly signal: AbortSignal;
}

export type RepairStop = "validated" | "max-iterations" | "repeated-failure" | "declined" | "no-candidates" | "model-error" | "nothing-to-repair" | "cancelled" | "unresolved";

export interface RepairOutcome {
  readonly stop: RepairStop;
  readonly message: string;
  readonly iterations: number;
  readonly status: ValidationStatus;
}

/** Separate function so the check is not narrowed away after an await. */
function isCancelled(signal: AbortSignal): boolean {
  return signal.aborted;
}

const MAX_CANDIDATE_FILES = 8;
const MAX_CANDIDATE_BYTES = 60_000;
const MAX_TOTAL_BYTES = 120_000;

/**
 * Finds editable source files under the failing command's directory that the output names by
 * path, or that mention a changed dependency. Never returns manifests, lockfiles, or excluded files.
 */
export async function findRepairCandidates(
  root: string,
  cwd: string,
  output: string,
  dependencyNames: readonly string[],
  exclusions: readonly string[]
): Promise<Map<string, string>> {
  const files: string[] = [];
  const start = path.resolve(root, cwd);
  if (start !== path.resolve(root) && !start.startsWith(path.resolve(root) + path.sep)) {
    return new Map();
  }
  const walk = async (dir: string, depth: number): Promise<void> => {
    if (depth > 6 || files.length > 2_000) {
      return;
    }
    let entries: Dirent[];
    try {
      entries = await fs.readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (!EXCLUDED_DIRECTORIES.has(entry.name)) {
          await walk(full, depth + 1);
        }
      } else if (entry.isFile()) {
        files.push(path.relative(root, full).split(path.sep).join("/"));
      }
    }
  };
  await walk(start, 0);

  const named = files.filter((rel) => isModelEditable(rel, exclusions) && output.includes(rel.split("/").pop() ?? rel));
  let selected: string[] = named;
  if (named.length === 0 && dependencyNames.length > 0) {
    const mentioning: string[] = [];
    for (const rel of files) {
      if (!isModelEditable(rel, exclusions)) {
        continue;
      }
      const text = await readWorkspaceFile(root, rel);
      if (text !== undefined && dependencyNames.some((name) => text.includes(name))) {
        mentioning.push(rel);
      }
    }
    selected = mentioning;
  }
  const result = new Map<string, string>();
  let total = 0;
  for (const rel of selected.slice(0, MAX_CANDIDATE_FILES)) {
    const text = await readWorkspaceFile(root, rel);
    if (text === undefined || text.length > MAX_CANDIDATE_BYTES || total + text.length > MAX_TOTAL_BYTES) {
      continue;
    }
    total += text.length;
    result.set(rel, text);
  }
  return result;
}

/**
 * Model repair loop. Each iteration: consent, one model call, strict parse, exact-once edits,
 * user approval of the diff, snapshot, write, then re-run the selected validation commands.
 * Stops on success, the iteration limit, a repeated failure, a refusal, or cancellation.
 */
export async function repairLoop(record: PlanRecord, options: RepairOptions, deps: WorkflowDeps): Promise<RepairOutcome> {
  const plan = record.plan;
  if (plan.status !== "applied" && plan.status !== "validation-failed") {
    return { stop: "unresolved", message: `This plan is ${plan.status}; repair runs only on an applied plan.`, iterations: 0, status: "unresolved" };
  }
  const commands = selectCommands(plan, options.selectedCommandIds, "validate");
  const seen = new Set<string>();
  let iterations = 0;
  const finish = (stop: RepairStop, message: string): RepairOutcome => {
    const latest = latestValidationRuns(record);
    return { stop, message, iterations, status: summarizeValidation(plan, latest).status };
  };

  let failing = commands.map((command) => latestValidationRuns(record).get(command.id)).find((run) => run !== undefined && !run.passed);
  if (failing === undefined) {
    return finish("nothing-to-repair", "No failing validation command to repair.");
  }

  while (iterations < options.maxIterations) {
    if (isCancelled(options.signal)) {
      return finish("cancelled", "Repair was cancelled.");
    }
    const signature = failureSignature(failing.commandId, failing.output);
    if (seen.has(signature)) {
      return finish("repeated-failure", "The same failure came back after a repair attempt. Stopped; review the output and fix it by hand.");
    }
    seen.add(signature);
    iterations += 1;

    const command = commands.find((candidate) => candidate.id === failing?.commandId);
    if (command === undefined) {
      return finish("unresolved", "The failing command is no longer in the plan.");
    }
    const names = plan.items.filter((item) => item.status === "ready").map((item) => item.name.split(":").pop() ?? item.name);
    const files = await findRepairCandidates(deps.root, command.cwd, failing.output, names, options.exclusions);
    if (files.size === 0) {
      return finish("no-candidates", "No editable source file was identified for this failure. Nothing was sent to the model.");
    }

    const prompt = buildRepairPrompt({
      commandDisplay: command.displayLine,
      failureOutput: failing.output,
      files,
      iteration: iterations,
      maxIterations: options.maxIterations
    });
    const consent = buildConsentMessage({
      purpose: `PatchPilot asks the model to fix source code after validation command ${command.id} failed (repair attempt ${String(iterations)} of ${String(options.maxIterations)}).`,
      endpointLabel: options.provider.endpointLabel,
      model: options.model,
      dataDescription: `the failing command line, its redacted output (last part), and the full text of ${String(files.size)} source file(s): ${[...files.keys()].join(", ")}. No manifests, lockfiles, or excluded files are included.`,
      exclusionCount: options.exclusions.length
    });
    if (!(await options.ui.confirmModelSend(consent))) {
      return finish("declined", "Model repair was not approved. No data was sent.");
    }

    let replyText: string;
    try {
      const reply = await options.provider.complete(
        { model: options.model, messages: [{ role: "system", content: prompt.system }, { role: "user", content: prompt.user }] },
        { signal: options.signal }
      );
      replyText = reply.text;
    } catch (error) {
      if (isCancelled(options.signal)) {
        return finish("cancelled", "Repair was cancelled.");
      }
      deps.log(`Model repair request failed: ${describeUnknownError(error)}`);
      return finish("model-error", "The model request failed. See the PatchPilot output for details.");
    }

    const parsed = parseRepairReply(replyText, new Set(files.keys()));
    if (!parsed.ok) {
      deps.log(`Model repair reply rejected: ${parsed.reason}`);
      continue;
    }
    const applied = applyRepairEdits(files, parsed.edits);
    if (!applied.ok) {
      deps.log(`Model repair edits rejected: ${applied.reason}`);
      continue;
    }
    const changes: { path: string; before: string; after: string }[] = [];
    for (const [rel, after] of applied.files) {
      const before = files.get(rel);
      if (before !== undefined && before !== after) {
        changes.push({ path: rel, before, after });
      }
    }
    if (changes.length === 0) {
      deps.log("Model repair produced no change; counted as an iteration.");
      continue;
    }
    if (!(await options.ui.approveEdits(changes))) {
      return finish("declined", "The proposed repair was not approved. Nothing was written.");
    }

    const stepIndex = await deps.store.beginStep(record, deps.root, `repair attempt ${String(iterations)}`, changes.map((change) => change.path), deps.now().toISOString());
    for (const change of changes) {
      await fs.writeFile(safeWorkspacePath(deps.root, change.path), change.after, "utf8");
    }
    await deps.store.finishStep(record, deps.root, stepIndex);

    let allPassed = true;
    for (const validate of commands) {
      const started = deps.now().toISOString();
      const result = await deps.exec(validate, options.signal);
      record.commandRuns.push(SnapshotStore.commandRecord(validate.id, validate.displayLine, "validate", started, result));
      const last = record.commandRuns.at(-1);
      if (last?.passed !== true) {
        allPassed = false;
        failing = last;
        break;
      }
    }
    await deps.store.saveRecord(record);
    if (allPassed) {
      record.plan = { ...record.plan, status: "validated" };
      await deps.store.saveRecord(record);
      return finish("validated", `Validation passed after ${String(iterations)} repair attempt(s).`);
    }
    if (failing === undefined) {
      return finish("unresolved", "Validation state is unclear after repair.");
    }
  }
  return finish("max-iterations", `Stopped after ${String(options.maxIterations)} repair attempt(s) without passing validation. Changes from repairs can be rolled back.`);
}
