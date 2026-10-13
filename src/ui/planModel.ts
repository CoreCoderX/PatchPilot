import type { PlanRecord } from "../upgrade/store";
import { itemLabel } from "../upgrade/planSummary";

export type PlanNodeKind = "header" | "section" | "item" | "detail" | "command" | "run" | "note";

export type PlanNodeCommand =
  | "patchpilot.reviewAndApply"
  | "patchpilot.validateChanges"
  | "patchpilot.repairWithModel"
  | "patchpilot.rollbackChanges"
  | "patchpilot.planUpgrade";

export interface PlanNode {
  readonly kind: PlanNodeKind;
  readonly label: string;
  readonly description?: string;
  readonly tooltip?: string;
  /** Set on rows that run a PatchPilot command when clicked. */
  readonly command?: PlanNodeCommand;
  readonly children: readonly PlanNode[];
}

const MAX_RUN_OUTPUT_LINES = 12;

/** Builds the Plan view tree from the stored record. Pure. */
export function buildPlanNodes(record: PlanRecord | undefined): PlanNode[] {
  if (record === undefined) {
    return [
      {
        kind: "note",
        label: "No plan yet",
        description: "Click to build one",
        tooltip: "Run PatchPilot: Plan Upgrade. It reads the last analysis and changes nothing.",
        command: "patchpilot.planUpgrade",
        children: []
      }
    ];
  }
  const plan = record.plan;
  const nodes: PlanNode[] = [];
  nodes.push({
    kind: "header",
    label: `Plan ${plan.id}`,
    description: plan.status,
    tooltip: `Created ${plan.createdAt}`,
    children: []
  });

  const next = nextAction(record);
  if (next !== undefined) {
    nodes.push(next);
  }

  nodes.push({
    kind: "section",
    label: "Dependencies",
    children: plan.items.map((item) => ({
      kind: "item",
      label: itemLabel(item),
      description: item.status === "blocked" ? (item.blockReason ?? "blocked") : "ready",
      tooltip: item.message,
      children: [
        { kind: "detail", label: `Manifest: ${item.manifest}`, children: [] },
        { kind: "detail", label: item.message, children: [] },
        ...(item.advisoriesFixed.length > 0 ? [{ kind: "detail" as const, label: `Advisories on current version: ${item.advisoriesFixed.join(", ")}`, children: [] }] : []),
        ...(item.registrySource === undefined ? [] : [{ kind: "detail" as const, label: `Registry: ${item.registrySource.url}`, description: item.registrySource.retrievedAt, children: [] }]),
        { kind: "detail", label: item.compatibility, children: [] }
      ]
    }))
  });

  nodes.push({
    kind: "section",
    label: "Files",
    children: plan.edits.map((edit) => ({ kind: "detail", label: edit.path, description: `${String(edit.itemIds.length)} change(s)`, children: [] }))
  });

  nodes.push({
    kind: "section",
    label: "Commands",
    children: plan.commands.map((command) => ({
      kind: "command",
      label: command.displayLine,
      description: command.phase,
      tooltip: command.purpose,
      children: []
    }))
  });

  const runs = record.commandRuns.slice(-20);
  if (runs.length > 0) {
    nodes.push({
      kind: "section",
      label: "Command results",
      children: runs.map((run) => ({
        kind: "run",
        label: `${run.passed ? "passed" : "failed"}: ${run.commandId}`,
        description: run.timedOut ? "timed out" : run.cancelled ? "cancelled" : run.spawnError !== undefined ? "not started" : `exit ${String(run.exitCode)}`,
        tooltip: run.output.split("\n").slice(-MAX_RUN_OUTPUT_LINES).join("\n"),
        children: []
      }))
    });
  }

  const steps = record.steps.map((step) => ({
    kind: "detail" as const,
    label: `Step ${String(step.index)}: ${step.label}`,
    description: step.rolledBack ? "rolled back" : step.finished ? "written" : "open",
    children: []
  }));
  nodes.push({ kind: "section", label: "Snapshots", children: steps.length > 0 ? steps : [{ kind: "note", label: "No steps recorded", children: [] }] });

  nodes.push({
    kind: "section",
    label: "Notes",
    children: plan.notes.map((note) => ({ kind: "note", label: note, children: [] }))
  });
  return nodes;
}

/**
 * The single row that runs the next step for this plan's status. It is the same command
 * the Workflow view would run, so the Plan view is usable on its own. Returns undefined
 * when no further step applies.
 */
function nextAction(record: PlanRecord): PlanNode | undefined {
  const status = record.plan.status;

  if (status === "proposed") {
    return action(
      "Review and Apply Plan",
      "patchpilot.reviewAndApply",
      "Opens a diff for every changed file, then asks once for the whole edit set."
    );
  }
  if (status === "validation-failed") {
    return action(
      "Repair with Model",
      "patchpilot.repairWithModel",
      "Asks the model for exact-once source edits. You approve each send and each diff."
    );
  }
  if (status === "applied") {
    return action(
      "Validate Changes",
      "patchpilot.validateChanges",
      "Runs the plan's fixed validation commands after one approval. No shell, capped and redacted output."
    );
  }
  if (status === "validated" || status === "apply-failed") {
    return action(
      "Roll Back Changes",
      "patchpilot.rollbackChanges",
      "Restores every file from its snapshot and verifies the hash."
    );
  }
  return undefined;
}

function action(label: string, command: PlanNodeCommand, tooltip: string): PlanNode {
  return { kind: "note", label, description: "next step", tooltip, command, children: [] };
}

