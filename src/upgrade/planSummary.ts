import type { PlanItem, UpgradePlan } from "./types";
import type { PlanRecord } from "./store";

/** Plain-language summary for the review dialog. Pure. */
export function describePlanForReview(plan: UpgradePlan): { readonly detail: string; readonly applyCommands: readonly string[] } {
  const ready = plan.items.filter((item) => item.status === "ready");
  const blocked = plan.items.filter((item) => item.status === "blocked");
  const applyCommands = plan.commands.filter((command) => command.phase === "apply").map((command) => command.displayLine);
  const lines: string[] = [
    `Plan ${plan.id}`,
    `${String(ready.length)} dependency upgrade(s) ready, ${String(blocked.length)} blocked.`,
    "",
    "Dependency changes:",
    ...ready.map((item) => `  - ${item.name} ${item.currentVersion ?? "?"} → ${item.targetVersion ?? "?"} (${item.manifest})`),
    "",
    "Files that will be written:",
    ...plan.edits.map((edit) => `  - ${edit.path}`),
    "",
    applyCommands.length > 0 ? "Commands that will run (no shell):" : "No commands run during apply.",
    ...applyCommands.map((line) => `  - ${line}`),
    "",
    "Compatibility of target versions is NOT verified by PatchPilot.",
    "Snapshots are kept so the change can be rolled back."
  ];
  return { detail: lines.join("\n"), applyCommands };
}

/** Labels for the Plan view. Pure, so it can be tested without VS Code. */
export function itemLabel(item: PlanItem): string {
  if (item.status === "ready") {
    return `${item.name}: ${item.currentVersion ?? "?"} → ${item.targetVersion ?? "?"}`;
  }
  return `${item.name}: blocked`;
}

export function recordSummary(record: PlanRecord | undefined): string {
  if (record === undefined) {
    return "No plan yet";
  }
  const applied = record.plan.status;
  return `${record.plan.id} · ${applied}`;
}
