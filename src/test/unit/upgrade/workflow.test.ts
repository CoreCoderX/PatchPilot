import * as assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, it } from "mocha";
import type { AnalysisResult, ManifestDependency } from "../../../analysis/types";
import type { ExecResult } from "../../../upgrade/exec";
import { createExecutor, applyPlan, validatePlan, rollbackPlan, repairLoop, type RepairUi, type WorkflowDeps } from "../../../upgrade/workflow";
import { finalizePlan, prepareCandidates } from "../../../upgrade/planner";
import { SnapshotStore, type PlanRecord } from "../../../upgrade/store";
import { assessment, dep, RETRIEVED, registryPackage } from "./helpers";
import type { ChatProvider } from "../../../ai/types";

let root: string;
let storage: string;

/** Built with JSON.stringify so quotes inside the test script stay valid JSON. */
const PACKAGE_JSON = (test: string): string =>
  `${JSON.stringify({ name: "fixture", version: "1.0.0", dependencies: { lodash: "4.17.15" }, scripts: { test } }, null, 2)}\n`;
const APP_BEFORE = "const value = 'BROKEN';\nmodule.exports = value;\n";

beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), "pp-wf-"));
  storage = await fs.mkdtemp(path.join(os.tmpdir(), "pp-wfstore-"));
  await fs.writeFile(path.join(root, "package.json"), PACKAGE_JSON("node -e \"process.exit(0)\""));
  await fs.mkdir(path.join(root, "src"));
  await fs.writeFile(path.join(root, "src", "app.js"), APP_BEFORE);
});

afterEach(async () => {
  await fs.rm(root, { recursive: true, force: true });
  await fs.rm(storage, { recursive: true, force: true });
});

const lodash = dep({ ecosystem: "npm", name: "lodash", manifest: "package.json", declaredSpec: "4.17.15", exactVersion: "4.17.15" });

function analysis(): AnalysisResult {
  return {
    startedAt: RETRIEVED,
    finishedAt: RETRIEVED,
    registry: [
      {
        ecosystem: "npm",
        name: "lodash",
        lookup: { kind: "found", value: registryPackage({ ecosystem: "npm", name: "lodash", versions: ["4.17.15", "4.17.21"], latestStable: "4.17.21" }) }
      }
    ],
    projects: [
      {
        project: { ecosystem: "npm", manifest: "package.json", format: "package.json", dependencies: [lodash], issues: [] },
        assessments: [assessment(lodash, { vulnerable: ["GHSA-lodash"], queried: "4.17.15" })]
      }
    ],
    unsupportedFiles: [],
    sourceStatus: [],
    limitsReached: [],
    cancelled: false
  };
}

async function makeRecord(store: SnapshotStore, lockfile = false): Promise<PlanRecord> {
  if (lockfile) {
    await fs.writeFile(path.join(root, "package-lock.json"), "{}\n");
  }
  const result = analysis();
  const preparation = prepareCandidates(result);
  const plan = await finalizePlan({
    planId: `plan-${Math.random().toString(36).slice(2, 8)}`,
    now: RETRIEVED,
    result,
    preparation,
    osv: { kind: "found", value: [[]] },
    readFile: (rel) => fs.readFile(path.join(root, rel), "utf8"),
    fileExists: async (rel) => {
      try {
        await fs.stat(path.join(root, rel));
        return true;
      } catch {
        return false;
      }
    }
  });
  return store.createPlanRecord(plan);
}

function result(exitCode: number, output = ""): ExecResult {
  return { exitCode, timedOut: false, cancelled: false, spawnError: undefined, durationMs: 1, output, outputTruncated: false };
}

function deps(exec: WorkflowDeps["exec"], store: SnapshotStore): WorkflowDeps {
  return { root, store, exec, now: () => new Date(RETRIEVED), log: () => undefined };
}

describe("applyPlan", () => {
  it("writes the proposed manifest and records hashes when the review still matches", async () => {
    const store = new SnapshotStore(storage);
    const record = await makeRecord(store);
    const outcome = await applyPlan(record, [], deps(() => Promise.resolve(result(0)), store), new AbortController().signal);
    assert.equal(outcome.status, "applied");
    const written = await fs.readFile(path.join(root, "package.json"), "utf8");
    assert.match(written, /"lodash": "4\.17\.21"/);
    assert.equal(record.plan.status, "applied");
    assert.equal(record.steps[0]?.finished, true);
    assert.equal(record.steps[0]?.files[0]?.afterHash !== undefined, true);
  });

  it("refuses everything when a file changed after review, and writes nothing", async () => {
    const store = new SnapshotStore(storage);
    const record = await makeRecord(store);
    await fs.writeFile(path.join(root, "package.json"), PACKAGE_JSON("user changed this"));
    const outcome = await applyPlan(record, [], deps(() => Promise.resolve(result(0)), store), new AbortController().signal);
    assert.equal(outcome.status, "conflict");
    assert.match(await fs.readFile(path.join(root, "package.json"), "utf8"), /user changed this/);
    assert.equal(record.steps.length, 0);
    assert.equal(record.plan.status, "proposed");
  });

  it("rolls back and reports failure when an apply-phase command fails", async () => {
    const store = new SnapshotStore(storage);
    const record = await makeRecord(store, true);
    const original = await fs.readFile(path.join(root, "package.json"), "utf8");
    const lockCommand = record.plan.commands.find((c) => c.template === "npm-lock-refresh");
    assert.ok(lockCommand, "plan should include the lockfile refresh");
    const outcome = await applyPlan(record, [lockCommand.id], deps(() => Promise.resolve(result(1, "ERESOLVE")), store), new AbortController().signal);
    if (outcome.status !== "failed-reverted") {
      assert.fail("expected the apply to fail and roll back");
    }
    assert.equal(outcome.rollback.verified, true);
    assert.equal(await fs.readFile(path.join(root, "package.json"), "utf8"), original);
    assert.equal(record.plan.status, "apply-failed");
  });

  it("refuses to apply the same plan twice", async () => {
    const store = new SnapshotStore(storage);
    const record = await makeRecord(store);
    await applyPlan(record, [], deps(() => Promise.resolve(result(0)), store), new AbortController().signal);
    const second = await applyPlan(record, [], deps(() => Promise.resolve(result(0)), store), new AbortController().signal);
    assert.equal(second.status, "refused");
  });
});

describe("validatePlan", () => {
  it("reports validated when every planned validation command passes", async () => {
    const store = new SnapshotStore(storage);
    const record = await makeRecord(store);
    await applyPlan(record, [], deps(() => Promise.resolve(result(0)), store), new AbortController().signal);
    const ids = record.plan.commands.filter((c) => c.phase === "validate").map((c) => c.id);
    const outcome = await validatePlan(record, ids, deps(() => Promise.resolve(result(0)), store), new AbortController().signal);
    assert.equal(outcome.status, "validated");
    assert.equal(record.plan.status, "validated");
  });

  it("reports validation-failed with the failing command named", async () => {
    const store = new SnapshotStore(storage);
    const record = await makeRecord(store);
    await applyPlan(record, [], deps(() => Promise.resolve(result(0)), store), new AbortController().signal);
    const ids = record.plan.commands.filter((c) => c.phase === "validate").map((c) => c.id);
    const outcome = await validatePlan(record, ids, deps(() => Promise.resolve(result(1, "boom")), store), new AbortController().signal);
    assert.equal(outcome.status, "validation-failed");
    assert.match(outcome.message, /npm-test/);
  });

  it("reports unresolved when no validation command exists", async () => {
    await fs.writeFile(path.join(root, "package.json"), PACKAGE_JSON(""));
    const store = new SnapshotStore(storage);
    const record = await makeRecord(store);
    await applyPlan(record, [], deps(() => Promise.resolve(result(0)), store), new AbortController().signal);
    const outcome = await validatePlan(record, [], deps(() => Promise.resolve(result(0)), store), new AbortController().signal);
    assert.equal(outcome.status, "unresolved");
  });

  it("runs the real allowlisted npm test template and records its pass and fail", async () => {
    const store = new SnapshotStore(storage);
    const record = await makeRecord(store);
    const executor = createExecutor({ root, timeoutMs: 60_000, maxOutputBytes: 8_000, knownSecrets: () => [] });
    await applyPlan(record, [], deps(executor, store), new AbortController().signal);
    const ids = record.plan.commands.filter((c) => c.phase === "validate").map((c) => c.id);
    const passed = await validatePlan(record, ids, deps(executor, store), new AbortController().signal);
    assert.equal(passed.status, "validated");
    assert.equal(record.commandRuns.at(-1)?.passed, true);

    await fs.writeFile(path.join(root, "package.json"), PACKAGE_JSON("node -e \"console.error('suite failed'); process.exit(2)\""));
    const failing = await validatePlan(record, ids, deps(executor, store), new AbortController().signal);
    assert.equal(failing.status, "validation-failed");
    assert.match(record.commandRuns.at(-1)?.output ?? "", /suite failed/);
  });
});

describe("rollbackPlan", () => {
  it("restores the apply step and verifies it", async () => {
    const store = new SnapshotStore(storage);
    const record = await makeRecord(store);
    const original = await fs.readFile(path.join(root, "package.json"), "utf8");
    await applyPlan(record, [], deps(() => Promise.resolve(result(0)), store), new AbortController().signal);
    const report = await rollbackPlan(record, deps(() => Promise.resolve(result(0)), store));
    assert.equal(report.verified, true);
    assert.equal(await fs.readFile(path.join(root, "package.json"), "utf8"), original);
    assert.equal(record.plan.status, "rolled-back");
  });
});

/** Fake model: replies with the given text on each call and records the prompts it saw. */
function fakeProvider(replies: string[]): { provider: ChatProvider; calls: string[] } {
  const calls: string[] = [];
  let index = 0;
  const provider: ChatProvider = {
    id: "fake",
    endpointLabel: "https://model.example.test/v1",
    complete: (request) => {
      calls.push(request.messages.map((m) => m.content).join("\n"));
      const reply = replies[Math.min(index, replies.length - 1)] ?? "{}";
      index += 1;
      return Promise.resolve({ text: reply });
    }
  };
  return { provider, calls };
}

function repairUi(consent: boolean, approve: boolean): RepairUi & { consents: number } {
  const ui = {
    consents: 0,
    confirmModelSend: () => {
      ui.consents += 1;
      return Promise.resolve(consent);
    },
    approveEdits: () => Promise.resolve(approve)
  };
  return ui;
}

/** Validation passes only when src/app.js contains FIXED. */
function fixSensitiveExec(): WorkflowDeps["exec"] {
  return async () => {
    const source = await fs.readFile(path.join(root, "src", "app.js"), "utf8");
    return source.includes("FIXED") ? result(0) : result(1, "AssertionError: expected FIXED in src/app.js\n  at line 1");
  };
}

describe("repairLoop", () => {
  it("sends nothing to the model when the user declines consent", async () => {
    const store = new SnapshotStore(storage);
    const record = await makeRecord(store);
    const exec = fixSensitiveExec();
    await applyPlan(record, [], deps(exec, store), new AbortController().signal);
    await validatePlan(record, record.plan.commands.filter((c) => c.phase === "validate").map((c) => c.id), deps(exec, store), new AbortController().signal);
    const { provider, calls } = fakeProvider([]);
    const ui = repairUi(false, true);
    const outcome = await repairLoop(record, { provider, model: "m", maxIterations: 2, exclusions: [], selectedCommandIds: record.plan.commands.filter((c) => c.phase === "validate").map((c) => c.id), ui, signal: new AbortController().signal }, deps(exec, store));
    assert.equal(outcome.stop, "declined");
    assert.equal(calls.length, 0);
    assert.equal(await fs.readFile(path.join(root, "src", "app.js"), "utf8"), "const value = 'BROKEN';\nmodule.exports = value;\n");
  });

  it("applies a valid model fix, re-validates, and stops as validated", async () => {
    const store = new SnapshotStore(storage);
    const record = await makeRecord(store);
    const exec = fixSensitiveExec();
    await applyPlan(record, [], deps(exec, store), new AbortController().signal);
    const ids = record.plan.commands.filter((c) => c.phase === "validate").map((c) => c.id);
    await validatePlan(record, ids, deps(exec, store), new AbortController().signal);
    const reply = JSON.stringify({ edits: [{ path: "src/app.js", search: "'BROKEN'", replace: "'FIXED'" }] });
    const { provider, calls } = fakeProvider([reply]);
    const ui = repairUi(true, true);
    const outcome = await repairLoop(record, { provider, model: "m", maxIterations: 2, exclusions: [], selectedCommandIds: ids, ui, signal: new AbortController().signal }, deps(exec, store));
    assert.equal(outcome.stop, "validated");
    assert.equal(outcome.iterations, 1);
    assert.equal(calls.length, 1);
    assert.match(calls[0] ?? "", /src\/app\.js/);
    assert.doesNotMatch(calls[0] ?? "", /"lodash"/, "manifest content must not be sent");
    assert.match(await fs.readFile(path.join(root, "src", "app.js"), "utf8"), /FIXED/);
    assert.equal(record.plan.status, "validated");
  });

  it("never edits a manifest, even when the model asks to", async () => {
    const store = new SnapshotStore(storage);
    const record = await makeRecord(store);
    const exec = fixSensitiveExec();
    await applyPlan(record, [], deps(exec, store), new AbortController().signal);
    const ids = record.plan.commands.filter((c) => c.phase === "validate").map((c) => c.id);
    await validatePlan(record, ids, deps(exec, store), new AbortController().signal);
    const before = await fs.readFile(path.join(root, "package.json"), "utf8");
    const bad = JSON.stringify({ edits: [{ path: "package.json", search: "4.17.21", replace: "9.9.9" }] });
    const { provider } = fakeProvider([bad]);
    const outcome = await repairLoop(record, { provider, model: "m", maxIterations: 1, exclusions: [], selectedCommandIds: ids, ui: repairUi(true, true), signal: new AbortController().signal }, deps(exec, store));
    assert.equal(outcome.stop, "max-iterations");
    assert.equal(await fs.readFile(path.join(root, "package.json"), "utf8"), before);
  });

  it("stops on a repeated failure instead of spending the full budget", async () => {
    const store = new SnapshotStore(storage);
    const record = await makeRecord(store);
    const exec = fixSensitiveExec();
    await applyPlan(record, [], deps(exec, store), new AbortController().signal);
    const ids = record.plan.commands.filter((c) => c.phase === "validate").map((c) => c.id);
    await validatePlan(record, ids, deps(exec, store), new AbortController().signal);
    const noop = JSON.stringify({ edits: [{ path: "src/app.js", search: "module.exports", replace: "module.exports /* tweak */" }] });
    const { provider, calls } = fakeProvider([noop, noop, noop]);
    const outcome = await repairLoop(record, { provider, model: "m", maxIterations: 5, exclusions: [], selectedCommandIds: ids, ui: repairUi(true, true), signal: new AbortController().signal }, deps(exec, store));
    assert.equal(outcome.stop, "repeated-failure");
    // One model call is spent; the identical failure then stops the loop before a second call.
    assert.equal(calls.length, 1);
  });

  it("leaves a clean rollback path after repair edits", async () => {
    const store = new SnapshotStore(storage);
    const record = await makeRecord(store);
    const exec = fixSensitiveExec();
    await applyPlan(record, [], deps(exec, store), new AbortController().signal);
    const ids = record.plan.commands.filter((c) => c.phase === "validate").map((c) => c.id);
    await validatePlan(record, ids, deps(exec, store), new AbortController().signal);
    const reply = JSON.stringify({ edits: [{ path: "src/app.js", search: "'BROKEN'", replace: "'FIXED'" }] });
    await repairLoop(record, { provider: fakeProvider([reply]).provider, model: "m", maxIterations: 1, exclusions: [], selectedCommandIds: ids, ui: repairUi(true, true), signal: new AbortController().signal }, deps(exec, store));
    const report = await rollbackPlan(record, deps(exec, store));
    assert.equal(report.verified, true);
    assert.equal(await fs.readFile(path.join(root, "src", "app.js"), "utf8"), APP_BEFORE);
    assert.equal(await fs.readFile(path.join(root, "package.json"), "utf8"), PACKAGE_JSON("node -e \"process.exit(0)\""));
  });
});

export type { ManifestDependency };
