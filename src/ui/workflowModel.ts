/**
 * Pure model for the PatchPilot workflow view.
 *
 * The view answers one question: what do I click next, and why can I not click the step
 * after that. Every step stays clickable, so a blocked step still runs its own command and
 * shows that command's existing message. This model never runs anything and never reads a
 * file; it only describes the state it is given.
 */
import type { PlanStatus } from "../upgrade/types";

export type WorkflowCommandId =
  | "patchpilot.analyzeDependencies"
  | "patchpilot.planUpgrade"
  | "patchpilot.reviewAndApply"
  | "patchpilot.validateChanges"
  | "patchpilot.repairWithModel"
  | "patchpilot.rollbackChanges"
  | "patchpilot.setApiKey"
  | "patchpilot.clearApiKey"
  | "patchpilot.testConnection"
  | "patchpilot.openModelSettings"
  | "patchpilot.showStatus";

/** "ready" can be run now, "waiting" needs an earlier step first, "done" already ran. */
export type WorkflowStepState = "ready" | "waiting" | "done";

/** What the extension already knows about the newest plan. */
export interface PlanProgress {
  readonly id: string;
  readonly status: PlanStatus;
  /** True while at least one written step has not been rolled back. */
  readonly hasUnrolledSteps: boolean;
}

export interface WorkflowState {
  readonly isTrusted: boolean;
  readonly folderCount: number;
  readonly hasAnalysis: boolean;
  readonly plan: PlanProgress | undefined;
  readonly keyStored: boolean;
  /** True when a model ID and a valid endpoint are both configured. */
  readonly modelConfigured: boolean;
}

export interface WorkflowStep {
  readonly kind: "step";
  readonly id: string;
  readonly label: string;
  readonly description: string;
  readonly tooltip: string;
  readonly icon: string;
  readonly command: WorkflowCommandId;
  readonly state: WorkflowStepState;
  /** True for the single step the workflow suggests running next. */
  readonly isNext: boolean;
}

export interface WorkflowGroup {
  readonly kind: "group";
  readonly id: string;
  readonly label: string;
  readonly description: string;
  readonly tooltip: string;
  readonly icon: string;
  readonly children: readonly WorkflowStep[];
}

export type WorkflowNode = WorkflowStep | WorkflowGroup;

/** Statuses repairWithModel accepts: an applied plan, or one whose validation failed. */
const REPAIRABLE: ReadonlySet<PlanStatus> = new Set<PlanStatus>(["applied", "validation-failed"]);

/** Why no project file may be touched right now, or undefined when the way is clear. */
function workspaceBlock(state: WorkflowState): string | undefined {
  if (state.folderCount === 0) {
    return "Open a folder first";
  }
  if (state.folderCount > 1) {
    return "Open a single folder";
  }
  if (!state.isTrusted) {
    return "Trust this folder first";
  }
  return undefined;
}

/** Prefers the block reason, then the summary of a step that is available or finished. */
function describe(block: string | undefined, summary: string): string {
  return block ?? summary;
}

function suffix(block: string | undefined): string {
  return block === undefined ? "" : ` Blocked: ${block.toLowerCase()}.`;
}

/** Marks the first runnable step, so the user is told exactly one thing to do next. */
function markNext(steps: readonly WorkflowStep[]): WorkflowStep[] {
  let marked = false;
  return steps.map((step) => {
    const isNext = !marked && step.state === "ready";
    if (isNext) {
      marked = true;
    }
    return { ...step, isNext };
  });
}

/** "Next: Plan Upgrade", or a fallback when nothing in the group is runnable. */
function nextLabel(steps: readonly WorkflowStep[], fallback: string): string {
  const next = steps.find((step) => step.isNext);
  return next === undefined ? fallback : `Next: ${next.label}`;
}

export function buildWorkflowNodes(state: WorkflowState): readonly WorkflowNode[] {
  const block = workspaceBlock(state);
  const plan = state.plan;
  const planStatus = plan?.status;

  // Each optional block is the reason this step cannot run yet, or undefined when it can.
  const needsPlan = plan === undefined ? "Create a plan first" : undefined;
  const needsApply = plan === undefined ? needsPlan : plan.status === "proposed" ? undefined : `Plan is ${plan.status}`;
  const repairBlock =
    plan === undefined || !REPAIRABLE.has(plan.status)
      ? "Runs after validation fails"
      : !state.modelConfigured
        ? "Set patchpilot.ai.model first"
        : !state.keyStored
          ? "Store an API key first"
          : undefined;

  const upgrade = markNext([
    {
      kind: "step",
      id: "analyze",
      label: "Analyze Dependencies",
      description: describe(block, state.hasAnalysis ? "Results in the Dependencies view" : "Not run yet"),
      tooltip: `Reads package.json, package-lock.json, pom.xml, requirements*.txt, and pyproject.toml, then asks before any registry or OSV request. Read-only.${suffix(block)}`,
      icon: "search",
      command: "patchpilot.analyzeDependencies",
      state: block !== undefined ? "waiting" : state.hasAnalysis ? "done" : "ready",
      isNext: false
    },
    {
      kind: "step",
      id: "plan",
      label: "Plan Upgrade",
      description: describe(block, plan === undefined ? "Not built yet" : plan.id),
      tooltip: `Picks a newer stable version for each vulnerable or deprecated exact pin, after asking before checking candidates against OSV. Changes nothing.${suffix(block)}`,
      icon: "list-tree",
      command: "patchpilot.planUpgrade",
      state: block !== undefined ? "waiting" : plan === undefined ? "ready" : "done",
      isNext: false
    },
    {
      kind: "step",
      id: "apply",
      label: "Review and Apply Plan",
      description: describe(needsApply ?? block, "Diffs open, then one approval"),
      tooltip: `Opens a diff for every changed file, then asks once for the whole edit set. Snapshots are kept before each write, and the apply refuses if a file changed since the plan was made.${suffix(block)}`,
      icon: "check-all",
      command: "patchpilot.reviewAndApply",
      state: needsApply !== undefined || block !== undefined ? "waiting" : "ready",
      isNext: false
    },
    {
      kind: "step",
      id: "validate",
      label: "Validate Changes",
      description: describe(
        needsPlan ?? block,
        planStatus === "validated" ? "Passed" : planStatus === "validation-failed" ? "Failed" : "Not run yet"
      ),
      tooltip: `Runs only fixed commands from the plan (npm test, npm run build, mvn dependency:resolve, mvn test, pip install --dry-run, pytest) with no shell. Asks once per plan. Output is capped, redacted, and time-limited.${suffix(block)}`,
      icon: "beaker",
      command: "patchpilot.validateChanges",
      state: needsPlan !== undefined || block !== undefined ? "waiting" : planStatus === "validated" ? "done" : "ready",
      isNext: false
    },
    {
      kind: "step",
      id: "repair",
      label: "Repair with Model",
      description: describe(repairBlock ?? block, "Asks before each send"),
      tooltip:
        "Asks the model for exact-once source edits, never manifests or lockfiles. You approve each send and each diff before anything is written. Manifests, lockfiles, and secret-file patterns are never sent.",
      icon: "wrench",
      command: "patchpilot.repairWithModel",
      state: repairBlock !== undefined ? "waiting" : "ready",
      isNext: false
    },
    {
      kind: "step",
      id: "rollback",
      label: "Roll Back Changes",
      description:
        plan?.hasUnrolledSteps === true ? "Files are waiting to be restored" : describe(block, "Nothing to roll back"),
      tooltip: `Restores every file from its snapshot and verifies the hash. A file you changed after PatchPilot wrote it is left alone and reported.${suffix(block)}`,
      icon: "history",
      command: "patchpilot.rollbackChanges",
      state: plan?.hasUnrolledSteps === true ? "ready" : "waiting",
      isNext: false
    }
  ]);

  const model = markNext([
    {
      kind: "step",
      id: "key",
      label: state.keyStored ? "Clear Model API Key" : "Set Model API Key",
      description: state.keyStored ? "Stored in secret storage" : "Not set",
      tooltip: "Stored in VS Code secret storage. The value is never written to settings, files, logs, or reports.",
      icon: state.keyStored ? "key" : "add",
      command: state.keyStored ? "patchpilot.clearApiKey" : "patchpilot.setApiKey",
      state: state.keyStored ? "done" : "ready",
      isNext: false
    },
    {
      kind: "step",
      id: "connection",
      label: "Test Model Connection",
      description: state.modelConfigured && state.keyStored ? "Endpoint, model, and key are set" : "Needs the endpoint, model, and key",
      tooltip: "Sends one fixed test sentence to your endpoint after you confirm. No workspace content is sent.",
      icon: "plug",
      command: "patchpilot.testConnection",
      state: state.modelConfigured && state.keyStored ? "ready" : "waiting",
      isNext: false
    },
    {
      kind: "step",
      id: "settings",
      label: "Open Model Settings",
      description: state.modelConfigured ? "patchpilot.ai" : "patchpilot.ai.model is empty",
      tooltip: "Opens the patchpilot settings. baseUrl and model are user-level only, so a project cannot redirect your key.",
      icon: "gear",
      command: "patchpilot.openModelSettings",
      state: "ready",
      isNext: false
    },
    {
      kind: "step",
      id: "status",
      label: "Show Workspace Status",
      description: "Trust state and open folders",
      tooltip: "Writes the trust state and open folders to the PatchPilot output channel. Reads no project file.",
      icon: "output",
      command: "patchpilot.showStatus",
      state: "ready",
      isNext: false
    }
  ]);

  return [
    {
      kind: "group",
      id: "workflow",
      label: "Upgrade Workflow",
      description: nextLabel(upgrade, "Nothing to run"),
      tooltip: "Run these in order. Each step asks before it sends anything or writes anything.",
      icon: "rocket",
      children: upgrade
    },
    {
      kind: "group",
      id: "model",
      label: "Model and Diagnostics",
      description: nextLabel(model, "Ready"),
      tooltip: "Optional. These steps are only needed for the model features.",
      icon: "settings-gear",
      children: model
    }
  ];
}
