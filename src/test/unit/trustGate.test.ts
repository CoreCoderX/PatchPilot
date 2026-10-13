import * as assert from "node:assert/strict";
import { describe, it } from "mocha";
import { gateModelAction } from "../../workspace/trustGate";
import { assertDenied } from "./helpers";

describe("gateModelAction", () => {
  it("allows requests without workspace content in restricted mode", () => {
    assert.deepEqual(gateModelAction({ isTrusted: false, sendsWorkspaceContent: false }), { allowed: true });
  });

  it("allows workspace-content requests in a trusted workspace", () => {
    assert.deepEqual(gateModelAction({ isTrusted: true, sendsWorkspaceContent: true }), { allowed: true });
  });

  it("blocks workspace-content requests in restricted mode with an explanation", () => {
    const result = gateModelAction({ isTrusted: false, sendsWorkspaceContent: true });
    assertDenied(result);
    assert.ok(result.reason.includes("trusted workspace"));
  });
});
