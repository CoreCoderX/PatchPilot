import * as fs from "node:fs/promises";
import type { AnalysisResult, Lookup } from "../analysis/types";
import type { OsvQuery } from "../advisories/osv";
import type { ChatProvider } from "../ai/types";
import type { Logger } from "../log";
import { gateModelAction } from "../workspace/trustGate";
import { prepareCandidates, finalizePlan } from "../upgrade/planner";
import { applyPlan, repairLoop, rollbackPlan, validatePlan, type RepairOutcome, type RepairUi, type ValidationOutcome, type WorkflowDeps, type ApplyOutcome } from "../upgrade/workflow";
import { describePlanForReview } from "../upgrade/planSummary";
import { safeWorkspacePath, type PlanRecord, type RollbackReport, type SnapshotStore } from "../upgrade/store";
import type { UpgradeSettings } from "../config/upgradeSettings";
import type { ConsentMessage } from "../ui/consentText";
import type { AnalyzeOutcome } from "./analyzeCommand";

export interface UpgradeUi extends RepairUi {
  confirm(title: string, detail: string, confirmLabel: string): Promise<boolean>;
  runWithProgress<T>(title: string, task: (signal: AbortSignal) => Promise<T>): Promise<T>;
  showInfo(message: string): void;
  showWarning(message: string): void;
  showError(message: string): void;
  /** Opens a diff for each edit. Resolves once the editors are open. */
  previewEdits(edits: readonly { readonly path: string; readonly proposedText: string }[]): Promise<void>;
}

export interface RepairConfig {
  readonly provider: ChatProvider;
  readonly model: string;
  readonly exclusions: readonly string[];
}

export interface UpgradeDeps {
  readonly root: string | undefined;
  readonly folderCount: number;
  readonly isTrusted: () => boolean;
  readonly ui: UpgradeUi;
  readonly log: Logger;
  readonly store: SnapshotStore;
  readonly now: () => Date;
  readonly lastResult: () => AnalysisResult | undefined;
  readonly runAnalysis: () => Promise<AnalyzeOutcome>;
  readonly queryOsv: (queries: readonly OsvQuery[], signal: AbortSignal) => Promise<Lookup<(readonly string[])[]>>;
  readonly settings: () => { readonly ok: true; readonly settings: UpgradeSettings } | { readonly ok: false; readonly message: string };
  readonly workflow: (root: string, settings: UpgradeSettings) => WorkflowDeps;
  readonly repairConfig: () => Promise<{ readonly ok: true; readonly config: RepairConfig } | { readonly ok: false; readonly message: string }>;
  readonly onRecordChanged: (record: PlanRecord | undefined) => void;
}

export type UpgradeCommandOutcome = "done" | "blocked" | "declined" | "nothing" | "failed" | "cancelled";

/** Single-folder gate shared by all upgrade commands. Multi-root workspaces are refused. */
function guard(deps: UpgradeDeps, needsTrust: boolean): { root: string } | "blocked" {
  if (deps.folderCount !== 1 || deps.root === undefined) {
    deps.ui.showWarning("PatchPilot upgrades need exactly one workspace folder. Open a single folder to continue.");
    return "blocked";
  }
  if (needsTrust && !deps.isTrusted()) {
    deps.ui.showWarning("Upgrade actions read and write project files. Trust this folder to continue.");
    return "blocked";
  }
  return { root: deps.root };
}

async function readRelative(root: string, relative: string): Promise<string> {
  return fs.readFile(safeWorkspacePath(root, relative), "utf8");
}

async function existsRelative(root: string, relative: string): Promise<boolean> {
  try {
    await fs.stat(safeWorkspacePath(root, relative));
    return true;
  } catch {
    return false;
  }
}

/** Plan Upgrade: reuse the last analysis (or run it), check candidates with consent, then plan. */
export async function planUpgrade(deps: UpgradeDeps): Promise<UpgradeCommandOutcome> {
  const guarded = guard(deps, true);
  if (guarded === "blocked") {
    return "blocked";
  }
  let result = deps.lastResult();
  if (result === undefined) {
    const outcome = await deps.runAnalysis();
    if (outcome !== "completed") {
      deps.ui.showInfo("Plan Upgrade needs a dependency analysis first. Run PatchPilot: Analyze Dependencies and try again.");
      return outcome === "declined" ? "declined" : "nothing";
    }
    result = deps.lastResult();
    if (result === undefined) {
      return "nothing";
    }
  }
  const preparation = prepareCandidates(result);
  if (preparation.items.length === 0) {
    deps.ui.showInfo("PatchPilot found no vulnerable or deprecated dependencies to plan for.");
    return "nothing";
  }

  let osv: Lookup<readonly (readonly string[])[]> = { kind: "found", value: [] };
  if (preparation.queries.length > 0) {
    const consent: ConsentMessage = {
      title: "PatchPilot: check candidate versions online?",
      detail: [
        "PatchPilot will check candidate target versions against known advisories (OSV).",
        `Requests: ${String(preparation.queries.length)} package-and-version quer${preparation.queries.length === 1 ? "y" : "ies"} to https://api.osv.dev.`,
        "Data sent: package names and version strings only. No file contents, paths, or credentials are sent.",
        "No files are changed by this step."
      ].join("\n"),
      confirmLabel: "Check versions"
    };
    if (!(await deps.ui.confirm(consent.title, consent.detail, consent.confirmLabel))) {
      deps.log.info("Plan Upgrade stopped: candidate advisory checks were not approved. No requests were sent.");
      return "declined";
    }
    osv = await deps.ui.runWithProgress("PatchPilot: checking candidate versions", (taskSignal) => deps.queryOsv(preparation.queries, taskSignal));
  }

  const plan = await finalizePlan({
    planId: newPlanId(deps.now()),
    now: deps.now().toISOString(),
    result,
    preparation,
    osv,
    readFile: (rel) => readRelative(guarded.root, rel),
    fileExists: (rel) => existsRelative(guarded.root, rel)
  });
  const record = await deps.store.createPlanRecord(plan);
  deps.onRecordChanged(record);
  const ready = plan.items.filter((item) => item.status === "ready").length;
  deps.log.info(`Plan ${plan.id} created: ${String(ready)} ready, ${String(plan.items.length - ready)} blocked.`);
  deps.ui.showInfo(`PatchPilot plan ${plan.id}: ${String(ready)} upgrade(s) ready, ${String(plan.items.length - ready)} blocked. Review it in the PatchPilot Plan view.`);
  return "done";
}

export function newPlanId(date: Date): string {
  const random = Math.floor(Math.random() * 0xffffff).toString(16).padStart(6, "0");
  return `plan-${date.toISOString().replace(/[-:.TZ]/g, "").slice(0, 14)}-${random}`;
}

async function loadCurrent(deps: UpgradeDeps): Promise<PlanRecord | undefined> {
  const id = await deps.store.latestPlanId();
  return id === undefined ? undefined : deps.store.loadRecord(id);
}

/** Review the latest plan, show diffs, then apply after one explicit approval. */
export async function reviewAndApply(deps: UpgradeDeps): Promise<UpgradeCommandOutcome> {
  const guarded = guard(deps, true);
  if (guarded === "blocked") {
    return "blocked";
  }
  const record = await loadCurrent(deps);
  if (record === undefined) {
    deps.ui.showInfo("No plan yet. Run PatchPilot: Plan Upgrade first.");
    return "nothing";
  }
  if (record.plan.status !== "proposed") {
    deps.ui.showInfo(`The latest plan is ${record.plan.status}. Create a new plan to make further changes.`);
    return "nothing";
  }
  const settings = deps.settings();
  if (!settings.ok) {
    deps.ui.showError(settings.message);
    return "blocked";
  }
  const review = describePlanForReview(record.plan);
  if (record.plan.edits.length === 0 && review.applyCommands.length === 0) {
    deps.ui.showInfo("The plan has no edits to apply.");
    return "nothing";
  }
  await deps.ui.previewEdits(record.plan.edits);
  const approved = await deps.ui.confirm(
    "PatchPilot: apply this plan?",
    `${review.detail}\n\nThe diffs are open in VS Code. Only the changes listed above will be made.`,
    "Apply plan"
  );
  if (!approved) {
    deps.log.info(`Plan ${record.plan.id} was not applied.`);
    return "declined";
  }
  const workflow = deps.workflow(guarded.root, settings.settings);
  const outcome: ApplyOutcome = await deps.ui.runWithProgress("PatchPilot: applying plan", (signal) =>
    applyPlan(record, record.plan.commands.filter((c) => c.phase === "apply").map((c) => c.id), workflow, signal)
  );
  deps.onRecordChanged(record);
  if (outcome.status === "applied") {
    deps.ui.showInfo(`${outcome.message} Run Validate Changes next.`);
    return "done";
  }
  if (outcome.status === "failed-reverted") {
    deps.ui.showError(`${outcome.message} ${outcome.rollback.verified ? "Rollback verified." : "Rollback could not be fully verified; see the Plan view."}`);
    return "failed";
  }
  deps.ui.showWarning(outcome.message);
  return "blocked";
}

/** Asks once per plan before the first validation run, showing every command exactly. */
async function ensureValidationApproved(deps: UpgradeDeps, record: PlanRecord): Promise<boolean> {
  if (record.validationApprovedAt !== undefined) {
    return true;
  }
  const commands = record.plan.commands.filter((c) => c.phase === "validate");
  if (commands.length === 0) {
    return true;
  }
  const detail = [
    "PatchPilot will run these fixed commands (no shell, output capped and redacted):",
    "",
    ...commands.map((c) => `  - ${c.purpose}\n      ${c.displayLine}`),
    "",
    "Build, test, and install-related scripts in your project will run. They can execute code from your project.",
    "Timeouts apply. Cancel stops the running command."
  ].join("\n");
  if (!(await deps.ui.confirm("PatchPilot: run validation commands?", detail, "Run commands"))) {
    return false;
  }
  record.validationApprovedAt = deps.now().toISOString();
  await deps.store.saveRecord(record);
  return true;
}

export async function validateChanges(deps: UpgradeDeps): Promise<UpgradeCommandOutcome> {
  const guarded = guard(deps, true);
  if (guarded === "blocked") {
    return "blocked";
  }
  const record = await loadCurrent(deps);
  if (record === undefined) {
    deps.ui.showInfo("No plan yet. Run PatchPilot: Plan Upgrade first.");
    return "nothing";
  }
  const settings = deps.settings();
  if (!settings.ok) {
    deps.ui.showError(settings.message);
    return "blocked";
  }
  if (!(await ensureValidationApproved(deps, record))) {
    return "declined";
  }
  const ids = record.plan.commands.filter((c) => c.phase === "validate").map((c) => c.id);
  const outcome: ValidationOutcome = await deps.ui.runWithProgress("PatchPilot: validating changes", (signal) =>
    validatePlan(record, ids, deps.workflow(guarded.root, settings.settings), signal)
  );
  deps.onRecordChanged(record);
  if (outcome.status === "validated") {
    deps.ui.showInfo(`Validation: validated. ${outcome.message}`);
    return "done";
  }
  if (outcome.status === "validation-failed") {
    deps.ui.showWarning(`Validation: validation failed. ${outcome.message} Use Repair with Model, or Roll Back.`);
    return "failed";
  }
  deps.ui.showWarning(`Validation: ${outcome.status === "partially-validated" ? "partially validated" : "unresolved"}. ${outcome.message}`);
  return "done";
}

/** Repair sends workspace content to a model and runs validation commands, so it needs a trusted folder. */
export async function repairWithModel(deps: UpgradeDeps): Promise<UpgradeCommandOutcome> {
  const guarded = guard(deps, true);
  if (guarded === "blocked") {
    return "blocked";
  }
  const record = await loadCurrent(deps);
  if (record === undefined || (record.plan.status !== "validation-failed" && record.plan.status !== "applied")) {
    deps.ui.showInfo("Repair runs only after validation has failed for an applied plan.");
    return "nothing";
  }
  const gate = gateModelAction({ isTrusted: deps.isTrusted(), sendsWorkspaceContent: true });
  if (!gate.allowed) {
    deps.ui.showWarning(gate.reason);
    return "blocked";
  }
  const settings = deps.settings();
  if (!settings.ok) {
    deps.ui.showError(settings.message);
    return "blocked";
  }
  const repair = await deps.repairConfig();
  if (!repair.ok) {
    deps.ui.showWarning(repair.message);
    return "blocked";
  }
  if (!(await ensureValidationApproved(deps, record))) {
    return "declined";
  }
  const ids = record.plan.commands.filter((c) => c.phase === "validate").map((c) => c.id);
  const outcome: RepairOutcome = await deps.ui.runWithProgress("PatchPilot: repairing with model", (signal) =>
    repairLoop(
      record,
      {
        provider: repair.config.provider,
        model: repair.config.model,
        maxIterations: settings.settings.repairMaxIterations,
        exclusions: repair.config.exclusions,
        selectedCommandIds: ids,
        ui: deps.ui,
        signal
      },
      deps.workflow(guarded.root, settings.settings)
    )
  );
  deps.onRecordChanged(record);
  const text = `Repair stopped (${outcome.stop}) after ${String(outcome.iterations)} attempt(s). ${outcome.message}`;
  if (outcome.status === "validated") {
    deps.ui.showInfo(text);
    return "done";
  }
  deps.ui.showWarning(text);
  return outcome.stop === "declined" ? "declined" : "done";
}

export async function rollbackChanges(deps: UpgradeDeps): Promise<UpgradeCommandOutcome> {
  const guarded = guard(deps, true);
  if (guarded === "blocked") {
    return "blocked";
  }
  const record = await loadCurrent(deps);
  if (record === undefined || record.steps.every((step) => step.rolledBack)) {
    deps.ui.showInfo("Nothing to roll back.");
    return "nothing";
  }
  const pending = record.steps.filter((step) => !step.rolledBack).flatMap((step) => step.files.filter((file) => !file.restored).map((file) => file.path));
  const unique = [...new Set(pending)];
  if (!(await deps.ui.confirm(
    "PatchPilot: roll back?",
    `Restore these files to their content before PatchPilot changed them:\n${unique.map((p) => `  - ${p}`).join("\n")}\n\nFiles changed since PatchPilot wrote them are left alone and reported.`,
    "Roll back"
  ))) {
    return "declined";
  }
  const settings = deps.settings();
  const timeoutSettings = settings.ok ? settings.settings : { commandTimeoutMs: 0, repairMaxIterations: 1 };
  const report: RollbackReport = await rollbackPlan(record, deps.workflow(guarded.root, timeoutSettings));
  deps.onRecordChanged(record);
  const conflicts = report.files.filter((file) => file.outcome === "conflict" || file.outcome === "failed");
  if (report.verified) {
    deps.ui.showInfo(`Rollback verified: ${String(report.files.length)} file operation(s) checked by hash.`);
    return "done";
  }
  deps.ui.showError(`Rollback not fully verified. ${String(conflicts.length)} file(s) need attention: ${conflicts.map((c) => `${c.path} (${c.detail})`).join("; ")}`);
  return "failed";
}

