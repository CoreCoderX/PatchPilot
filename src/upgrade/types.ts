import type { Ecosystem } from "../analysis/types";

/** Why a plan item cannot be applied. Each reason is shown to the user verbatim. */
export type BlockReason =
  | "not-exact-pin"
  | "no-registry-data"
  | "no-newer-stable"
  | "candidate-check-unavailable"
  | "no-clean-candidate"
  | "edit-not-unique"
  | "edit-not-found"
  | "lock-manifest-mismatch";

export type PlanItemStatus = "ready" | "blocked" | "info";

export interface PlanItem {
  readonly id: string;
  readonly ecosystem: Ecosystem;
  readonly name: string;
  readonly manifest: string;
  readonly currentVersion: string | undefined;
  readonly currentVersionSource: "lockfile" | "exact-pin" | undefined;
  readonly targetVersion: string | undefined;
  readonly status: PlanItemStatus;
  readonly blockReason: BlockReason | undefined;
  /** Human-readable explanation, always shown with the item. */
  readonly message: string;
  /** Advisory IDs that affected the current version. */
  readonly advisoriesFixed: readonly string[];
  /** Where the target version came from, for the review. */
  readonly registrySource: { readonly url: string; readonly retrievedAt: string } | undefined;
  /** Always "not verified" in Phase 4. */
  readonly compatibility: string;
}

export interface FileEdit {
  /** Workspace-relative path. */
  readonly path: string;
  readonly originalHash: string;
  readonly proposedText: string;
  readonly itemIds: readonly string[];
}

export type CommandTemplateId =
  | "npm-lock-refresh"
  | "npm-test"
  | "npm-build"
  | "maven-dependency-resolve"
  | "maven-test"
  | "pypi-pip-dry-run"
  | "pypi-pytest";

export interface PlannedCommand {
  /** Unique within the plan, for example "npm-test@packages/web". */
  readonly id: string;
  readonly template: CommandTemplateId;
  /** Workspace-relative working directory. "." means the workspace root. */
  readonly cwd: string;
  readonly phase: "apply" | "validate";
  readonly purpose: string;
  /** Exact display line, shown before approval. */
  readonly displayLine: string;
  /** Extra arguments taken from a validated file name, if the template needs one. */
  readonly fileArg: string | undefined;
}

export type PlanStatus = "proposed" | "applied" | "apply-failed" | "validated" | "validation-failed" | "rolled-back" | "rollback-failed";

export interface UpgradePlan {
  readonly id: string;
  readonly createdAt: string;
  readonly status: PlanStatus;
  readonly items: readonly PlanItem[];
  readonly edits: readonly FileEdit[];
  readonly commands: readonly PlannedCommand[];
  readonly notes: readonly string[];
}
