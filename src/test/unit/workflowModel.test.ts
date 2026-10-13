import * as assert from "node:assert/strict";
import { describe, it } from "mocha";
import {
  buildWorkflowNodes,
  type WorkflowGroup,
  type WorkflowState,
  type WorkflowStep
} from "../../ui/workflowModel";
import type { PlanStatus } from "../../upgrade/types";

const NO_FACTORS: WorkflowState = {
  isTrusted: true,
  folderCount: 1,
  hasAnalysis: false,
  plan: undefined,
  keyStored: false,
  modelConfigured: false
};

function groups(state: WorkflowState): readonly WorkflowGroup[] {
  const nodes = buildWorkflowNodes(state);
  return nodes.filter((node): node is WorkflowGroup => node.kind === "group");
}

function workflowSteps(state: WorkflowState): readonly WorkflowStep[] {
  return groups(state)[0]?.children ?? [];
}

function step(state: WorkflowState, id: string): WorkflowStep {
  const found = groups(state)
    .flatMap((group) => group.children)
    .find((candidate) => candidate.id === id);
  assert.ok(found, `step ${id} should exist`);
  return found;
}

function withPlan(status: PlanStatus, hasUnrolledSteps = true): WorkflowState {
  return { ...NO_FACTORS, hasAnalysis: true, plan: { id: "plan-1", status, hasUnrolledSteps } };
}

describe("buildWorkflowNodes", () => {
  it("groups the steps into a workflow and a model section", () => {
    const names = groups(NO_FACTORS).map((group) => group.label);
    assert.deepEqual(names, ["Upgrade Workflow", "Model and Diagnostics"]);
  });

  it("gives every step a command, so nothing needs the Command Palette", () => {
    for (const node of buildWorkflowNodes(NO_FACTORS)) {
      if (node.kind === "group") {
        for (const child of node.children) {
          assert.ok(child.command.startsWith("patchpilot."), `${child.id} should run a PatchPilot command`);
        }
      }
    }
  });

  it("suggests analyze first in a trusted folder with no analysis", () => {
    assert.equal(step(NO_FACTORS, "analyze").state, "ready");
    assert.equal(step(NO_FACTORS, "analyze").isNext, true);
    // Each group marks its own next step, so the two groups together mark exactly two.
    for (const group of groups(NO_FACTORS)) {
      assert.equal(group.children.filter((child) => child.isNext).length, 1, `${group.label} should mark one step`);
    }
  });

  it("marks exactly one step as next at each stage of the workflow", () => {
    const cases: readonly (readonly [string, WorkflowState, string])[] = [
      ["analyzed, no plan", { ...NO_FACTORS, hasAnalysis: true }, "plan"],
      ["proposed plan", withPlan("proposed"), "apply"],
      ["applied plan", withPlan("applied"), "validate"]
    ];
    for (const [label, state, expected] of cases) {
      const next = workflowSteps(state).filter((s) => s.isNext);
      assert.equal(next.length, 1, `${label} should mark exactly one step`);
      assert.equal(next[0]?.id, expected, `${label} should point at ${expected}`);
    }
  });

  it("waits on the whole workflow when no folder is open", () => {
    const state: WorkflowState = { ...NO_FACTORS, folderCount: 0 };
    for (const candidate of workflowSteps(state)) {
      assert.equal(candidate.state, "waiting", `${candidate.id} should wait`);
    }
    assert.match(step(state, "analyze").description, /Open a folder first/);
    assert.equal(step(state, "analyze").isNext, false);
  });

  it("blocks every project step in a restricted workspace", () => {
    const state: WorkflowState = { ...NO_FACTORS, isTrusted: false };
    assert.equal(step(state, "analyze").state, "waiting");
    assert.match(step(state, "plan").description, /Trust this folder first/);
    // The model steps stay reachable in restricted mode, matching the documented rule.
    assert.equal(step(state, "settings").state, "ready");
  });

  it("refuses multi-root the same way the upgrade commands do", () => {
    const state: WorkflowState = { ...NO_FACTORS, folderCount: 2 };
    assert.match(step(state, "analyze").description, /Open a single folder/);
  });

  it("names the plan status when apply is not possible yet", () => {
    assert.equal(step(withPlan("proposed"), "apply").state, "ready");
    const applied = step(withPlan("applied"), "apply");
    assert.equal(applied.state, "waiting");
    assert.equal(applied.description, "Plan is applied");
  });

  it("gates repair the way repairWithModel does, then on the model and key", () => {
    // repairWithModel accepts status "applied" or "validation-failed" only.
    assert.match(step(withPlan("validated"), "repair").description, /Runs after validation fails/);
    assert.match(step(withPlan("rolled-back"), "repair").description, /Runs after validation fails/);

    const failed = withPlan("validation-failed");
    assert.match(step(failed, "repair").description, /patchpilot\.ai\.model/);

    const noKey: WorkflowState = { ...failed, modelConfigured: true };
    assert.match(step(noKey, "repair").description, /API key/);

    const ready: WorkflowState = { ...noKey, keyStored: true };
    assert.equal(step(ready, "repair").state, "ready");
  });

  it("offers rollback only while an applied step is unrolled back", () => {
    assert.equal(step(withPlan("applied"), "rollback").state, "ready");
    assert.match(step(withPlan("applied"), "rollback").description, /waiting to be restored/);
    assert.equal(step(withPlan("applied", false), "rollback").state, "waiting");
  });

  it("switches the key step between set and clear", () => {
    assert.equal(step(NO_FACTORS, "key").command, "patchpilot.setApiKey");
    const stored: WorkflowState = { ...NO_FACTORS, keyStored: true };
    assert.equal(step(stored, "key").command, "patchpilot.clearApiKey");
    assert.equal(step(stored, "key").state, "done");
  });

  it("marks analysis and a finished plan as done", () => {
    const validated = withPlan("validated");
    assert.equal(step(validated, "analyze").state, "done");
    assert.equal(step(validated, "validate").state, "done");
    assert.equal(step(validated, "validate").description, "Passed");
  });
});
