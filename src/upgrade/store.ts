import * as fs from "node:fs/promises";
import * as path from "node:path";
import { sha256 } from "./edits";
import type { UpgradePlan } from "./types";
import type { ExecResult } from "./exec";

export interface StepFileRecord {
  readonly path: string;
  readonly existed: boolean;
  readonly beforeHash: string | undefined;
  afterHash: string | undefined;
  restored: boolean;
}

export interface StepRecord {
  readonly index: number;
  readonly label: string;
  readonly createdAt: string;
  finished: boolean;
  rolledBack: boolean;
  readonly files: StepFileRecord[];
}

export interface CommandRecord {
  readonly commandId: string;
  readonly displayLine: string;
  readonly phase: "apply" | "validate";
  readonly startedAt: string;
  readonly exitCode: number | null;
  readonly timedOut: boolean;
  readonly cancelled: boolean;
  readonly spawnError: string | undefined;
  readonly durationMs: number;
  readonly output: string;
  readonly outputTruncated: boolean;
  readonly passed: boolean;
}

export interface PlanRecord {
  plan: UpgradePlan;
  steps: StepRecord[];
  commandRuns: CommandRecord[];
  updatedAt: string;
  /** Set when the user approved the first validation run for this plan. */
  validationApprovedAt: string | undefined;
}

export interface RollbackFileResult {
  readonly path: string;
  readonly outcome: "restored" | "removed" | "already-original" | "conflict" | "failed";
  readonly detail: string;
}

export interface RollbackReport {
  /** True only when every file was restored and its hash verified. */
  readonly verified: boolean;
  readonly files: readonly RollbackFileResult[];
}

/** Resolves a workspace-relative path and refuses anything that leaves the workspace. */
export function safeWorkspacePath(root: string, relative: string): string {
  if (path.isAbsolute(relative) || relative.split(/[\\/]/).includes("..") || relative.length === 0) {
    throw new Error(`Refusing path outside the workspace: ${relative}`);
  }
  const resolved = path.resolve(root, relative);
  const base = path.resolve(root);
  if (!resolved.startsWith(base + path.sep)) {
    throw new Error(`Refusing path outside the workspace: ${relative}`);
  }
  return resolved;
}

async function hashFile(absolute: string): Promise<string | undefined> {
  try {
    return sha256(await fs.readFile(absolute, "utf8"));
  } catch (error) {
    if (isNotFound(error)) {
      return undefined;
    }
    throw error;
  }
}

function isNotFound(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT";
}

/**
 * Snapshot storage under extension storage. Layout:
 *   state.json                       latest plan id
 *   plans/<id>/plan.json             the plan as reviewed
 *   plans/<id>/record.json           steps, command runs, status
 *   plans/<id>/steps/NNN/step.json   per-step hashes
 *   plans/<id>/steps/NNN/before/<rel> before-copies of files that existed
 */
export class SnapshotStore {
  constructor(private readonly baseDir: string) {}

  private planDir(planId: string): string {
    if (!/^[A-Za-z0-9-]+$/.test(planId)) {
      throw new Error("Invalid plan id.");
    }
    return path.join(this.baseDir, "plans", planId);
  }

  private async writeJson(file: string, value: unknown): Promise<void> {
    await fs.mkdir(path.dirname(file), { recursive: true });
    const temp = `${file}.tmp`;
    await fs.writeFile(temp, JSON.stringify(value, null, 2), "utf8");
    await fs.rename(temp, file);
  }

  async latestPlanId(): Promise<string | undefined> {
    try {
      const parsed: unknown = JSON.parse(await fs.readFile(path.join(this.baseDir, "state.json"), "utf8"));
      return typeof parsed === "object" && parsed !== null && "latestPlanId" in parsed && typeof parsed.latestPlanId === "string"
        ? parsed.latestPlanId
        : undefined;
    } catch {
      return undefined;
    }
  }

  async createPlanRecord(plan: UpgradePlan): Promise<PlanRecord> {
    const record: PlanRecord = { plan, steps: [], commandRuns: [], updatedAt: plan.createdAt, validationApprovedAt: undefined };
    await this.saveRecord(record);
    await this.writeJson(path.join(this.baseDir, "state.json"), { latestPlanId: plan.id });
    return record;
  }

  async loadRecord(planId: string): Promise<PlanRecord | undefined> {
    try {
      return JSON.parse(await fs.readFile(path.join(this.planDir(planId), "record.json"), "utf8")) as PlanRecord;
    } catch (error) {
      if (isNotFound(error)) {
        return undefined;
      }
      throw error;
    }
  }

  async saveRecord(record: PlanRecord): Promise<void> {
    const dir = this.planDir(record.plan.id);
    await this.writeJson(path.join(dir, "plan.json"), record.plan);
    await this.writeJson(path.join(dir, "record.json"), record);
  }

  /** Copies the current state of each path, so rollback can restore it. Returns the step index. */
  async beginStep(record: PlanRecord, root: string, label: string, relativePaths: readonly string[], now: string): Promise<number> {
    const index = record.steps.length + 1;
    const stepDir = path.join(this.planDir(record.plan.id), "steps", String(index).padStart(3, "0"));
    const files: StepFileRecord[] = [];
    for (const rel of [...new Set(relativePaths)].sort()) {
      const absolute = safeWorkspacePath(root, rel);
      const beforeHash = await hashFile(absolute);
      const existed = beforeHash !== undefined;
      if (existed) {
        const backup = path.join(stepDir, "before", rel);
        await fs.mkdir(path.dirname(backup), { recursive: true });
        await fs.copyFile(absolute, backup);
      }
      files.push({ path: rel, existed, beforeHash, afterHash: undefined, restored: false });
    }
    const step: StepRecord = { index, label, createdAt: now, finished: false, rolledBack: false, files };
    record.steps.push(step);
    await this.writeJson(path.join(stepDir, "step.json"), step);
    await this.saveRecord(record);
    return index;
  }

  /** Records the post-step hash of every file in the step. */
  async finishStep(record: PlanRecord, root: string, index: number): Promise<void> {
    const step = record.steps.at(index - 1);
    if (step === undefined) {
      throw new Error("Unknown step.");
    }
    for (const file of step.files) {
      file.afterHash = await hashFile(safeWorkspacePath(root, file.path));
    }
    step.finished = true;
    await this.writeJson(path.join(this.planDir(record.plan.id), "steps", String(index).padStart(3, "0"), "step.json"), step);
    await this.saveRecord(record);
  }

  /**
   * Restores every unrolled step in reverse order. A file is restored only when its current
   * hash matches the hash PatchPilot recorded after the step (or the original hash). Any other
   * content is reported as a conflict and left alone.
   */
  async rollback(record: PlanRecord, root: string): Promise<RollbackReport> {
    const results: RollbackFileResult[] = [];
    let verified = true;
    for (const step of [...record.steps].reverse()) {
      if (step.rolledBack) {
        continue;
      }
      const stepDir = path.join(this.planDir(record.plan.id), "steps", String(step.index).padStart(3, "0"));
      let stepComplete = true;
      for (const file of step.files) {
        if (file.restored) {
          continue;
        }
        const result = await this.restoreFile(root, stepDir, file);
        results.push(result);
        if (result.outcome === "restored" || result.outcome === "removed" || result.outcome === "already-original") {
          file.restored = true;
        } else {
          stepComplete = false;
          verified = false;
        }
      }
      if (stepComplete) {
        step.rolledBack = true;
      }
      await this.writeJson(path.join(stepDir, "step.json"), step);
    }
    await this.saveRecord(record);
    return { verified, files: results };
  }

  private async restoreFile(root: string, stepDir: string, file: StepFileRecord): Promise<RollbackFileResult> {
    const absolute = safeWorkspacePath(root, file.path);
    try {
      const current = await hashFile(absolute);
      if (current === file.beforeHash) {
        return { path: file.path, outcome: "already-original", detail: "already matches the original content" };
      }
      if (file.afterHash !== undefined && current !== file.afterHash) {
        return { path: file.path, outcome: "conflict", detail: "changed since PatchPilot wrote it; left untouched" };
      }
      if (!file.existed) {
        await fs.rm(absolute, { force: true });
        const after = await hashFile(absolute);
        return after === undefined
          ? { path: file.path, outcome: "removed", detail: "removed (did not exist before the step)" }
          : { path: file.path, outcome: "failed", detail: "file still present after removal" };
      }
      const backup = await fs.readFile(path.join(stepDir, "before", file.path));
      if (sha256(backup.toString("utf8")) !== file.beforeHash) {
        return { path: file.path, outcome: "failed", detail: "snapshot copy does not match its recorded hash" };
      }
      await fs.writeFile(absolute, backup);
      const restored = await hashFile(absolute);
      return restored === file.beforeHash
        ? { path: file.path, outcome: "restored", detail: "restored and hash verified" }
        : { path: file.path, outcome: "failed", detail: "hash after restore does not match the original" };
    } catch (error) {
      return { path: file.path, outcome: "failed", detail: error instanceof Error ? error.message : "unknown error" };
    }
  }

  static commandRecord(commandId: string, displayLine: string, phase: "apply" | "validate", startedAt: string, result: ExecResult): CommandRecord {
    const passed = result.exitCode === 0 && !result.timedOut && !result.cancelled && result.spawnError === undefined;
    return {
      commandId,
      displayLine,
      phase,
      startedAt,
      exitCode: result.exitCode,
      timedOut: result.timedOut,
      cancelled: result.cancelled,
      spawnError: result.spawnError,
      durationMs: result.durationMs,
      output: result.output,
      outputTruncated: result.outputTruncated,
      passed
    };
  }
}
