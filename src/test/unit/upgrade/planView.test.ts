import * as assert from "node:assert/strict";
import { describe, it } from "mocha";
import { buildPlanNodes, type PlanNode } from "../../../ui/planModel";
import type { PlanRecord } from "../../../upgrade/store";
import { describePlanForReview } from "../../../upgrade/planSummary";
import type { UpgradePlan } from "../../../upgrade/types";

function flatten(nodes: readonly PlanNode[]): PlanNode[] {
  return nodes.flatMap((node) => [node, ...flatten(node.children)]);
}

const plan: UpgradePlan = {
  id: "plan-1",
  createdAt: "2026-10-12T10:00:00.000Z",
  status: "proposed",
  items: [
    {
      id: "item-001",
      ecosystem: "npm",
      name: "lodash",
      manifest: "package.json",
      currentVersion: "4.17.15",
      currentVersionSource: "exact-pin",
      targetVersion: "4.17.21",
      status: "ready",
      blockReason: undefined,
      message: "Pin 4.17.15 → 4.17.21 in package.json.",
      advisoriesFixed: ["GHSA-x"],
      registrySource: { url: "https://registry.npmjs.org/lodash", retrievedAt: "2026-10-12T10:00:00.000Z" },
      compatibility: "Compatibility not verified."
    },
    {
      id: "item-002",
      ecosystem: "npm",
      name: "express",
      manifest: "package.json",
      currentVersion: undefined,
      currentVersionSource: undefined,
      targetVersion: undefined,
      status: "blocked",
      blockReason: "not-exact-pin",
      message: "Declared as \"^4.18.0\".",
      advisoriesFixed: [],
      registrySource: undefined,
      compatibility: "Compatibility not verified."
    }
  ],
  edits: [{ path: "package.json", originalHash: "a", proposedText: "{}", itemIds: ["item-001"] }],
  commands: [
    { id: "npm-test@.", template: "npm-test", cwd: ".", phase: "validate", purpose: "Run tests", displayLine: ". $ npm test", fileArg: undefined }
  ],
  notes: ["Only exact pins are edited."]
};

describe("buildPlanNodes", () => {
  it("shows a clickable placeholder when there is no plan", () => {
    const nodes = buildPlanNodes(undefined);
    assert.equal(nodes[0]?.label, "No plan yet");
    assert.equal(nodes[0]?.command, "patchpilot.planUpgrade");
  });

  it("labels ready and blocked items and lists the exact command line", () => {
    const record: PlanRecord = { plan, steps: [], commandRuns: [], updatedAt: plan.createdAt, validationApprovedAt: undefined };
    const all = flatten(buildPlanNodes(record));
    assert.ok(all.some((node) => node.label === "lodash: 4.17.15 → 4.17.21"));
    assert.ok(all.some((node) => node.label === "express: blocked" && node.description === "not-exact-pin"));
    assert.ok(all.some((node) => node.kind === "command" && node.label === ". $ npm test"));
    assert.ok(all.some((node) => node.label.includes("Compatibility not verified")));
  });
});

describe("buildPlanNodes next action", () => {
  function recordWith(status: UpgradePlan["status"]): PlanRecord {
    return { plan: { ...plan, status }, steps: [], commandRuns: [], updatedAt: plan.createdAt, validationApprovedAt: undefined };
  }

  it("offers apply for a proposed plan and validate once it is applied", () => {
    const proposed = flatten(buildPlanNodes(recordWith("proposed")));
    assert.ok(proposed.some((node) => node.command === "patchpilot.reviewAndApply"));

    const applied = flatten(buildPlanNodes(recordWith("applied")));
    assert.ok(applied.some((node) => node.command === "patchpilot.validateChanges"));
  });

  it("offers repair after a failed validation and rollback once validated", () => {
    const failed = flatten(buildPlanNodes(recordWith("validation-failed")));
    assert.ok(failed.some((node) => node.command === "patchpilot.repairWithModel"));

    const validated = flatten(buildPlanNodes(recordWith("validated")));
    assert.ok(validated.some((node) => node.command === "patchpilot.rollbackChanges"));
  });

  it("offers no next action once the plan is rolled back", () => {
    const nodes = buildPlanNodes(recordWith("rolled-back"));
    assert.equal(flatten(nodes).some((node) => node.command !== undefined), false);
  });
});

describe("describePlanForReview", () => {
  it("lists every file and command, and states that compatibility is not verified", () => {
    const review = describePlanForReview(plan);
    assert.match(review.detail, /lodash 4\.17\.15 → 4\.17\.21/);
    assert.match(review.detail, /package\.json/);
    assert.match(review.detail, /Compatibility of target versions is NOT verified/);
    assert.deepEqual(review.applyCommands, []);
  });
});
