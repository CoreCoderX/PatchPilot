import * as assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, it } from "mocha";
import { sha256 } from "../../../upgrade/edits";
import { safeWorkspacePath, SnapshotStore, type PlanRecord } from "../../../upgrade/store";
import type { UpgradePlan } from "../../../upgrade/types";

let root: string;
let storage: string;

function emptyPlan(id: string): UpgradePlan {
  return { id, createdAt: "2026-10-12T10:00:00.000Z", status: "proposed", items: [], edits: [], commands: [], notes: [] };
}

async function newRecord(store: SnapshotStore, id: string): Promise<PlanRecord> {
  return store.createPlanRecord(emptyPlan(id));
}

beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), "pp-root-"));
  storage = await fs.mkdtemp(path.join(os.tmpdir(), "pp-store-"));
});

afterEach(async () => {
  await fs.rm(root, { recursive: true, force: true });
  await fs.rm(storage, { recursive: true, force: true });
});

describe("safeWorkspacePath", () => {
  it("accepts paths inside the workspace", () => {
    assert.equal(safeWorkspacePath(root, "src/a.ts"), path.join(root, "src", "a.ts"));
  });

  it("refuses traversal, absolute paths, and empty paths", () => {
    assert.throws(() => safeWorkspacePath(root, "../x"));
    assert.throws(() => safeWorkspacePath(root, "a/../../x"));
    assert.throws(() => safeWorkspacePath(root, path.resolve("/etc/hosts")));
    assert.throws(() => safeWorkspacePath(root, ""));
  });
});

describe("SnapshotStore rollback", () => {
  it("restores an edited file to its exact original content and verifies the hash", async () => {
    const store = new SnapshotStore(storage);
    const record = await newRecord(store, "plan-a");
    await fs.writeFile(path.join(root, "app.ts"), "original\n");
    const index = await store.beginStep(record, root, "edit", ["app.ts"], "t");
    await fs.writeFile(path.join(root, "app.ts"), "changed\n");
    await store.finishStep(record, root, index);

    const report = await store.rollback(record, root);
    assert.equal(report.verified, true);
    assert.equal(await fs.readFile(path.join(root, "app.ts"), "utf8"), "original\n");
    assert.equal(record.steps[0]?.rolledBack, true);
  });

  it("removes a file that did not exist before the step", async () => {
    const store = new SnapshotStore(storage);
    const record = await newRecord(store, "plan-b");
    const index = await store.beginStep(record, root, "create", ["new.ts"], "t");
    await fs.writeFile(path.join(root, "new.ts"), "created\n");
    await store.finishStep(record, root, index);

    const report = await store.rollback(record, root);
    assert.equal(report.verified, true);
    await assert.rejects(fs.stat(path.join(root, "new.ts")));
  });

  it("leaves a file alone when the user changed it after PatchPilot wrote it", async () => {
    const store = new SnapshotStore(storage);
    const record = await newRecord(store, "plan-c");
    await fs.writeFile(path.join(root, "app.ts"), "original\n");
    const index = await store.beginStep(record, root, "edit", ["app.ts"], "t");
    await fs.writeFile(path.join(root, "app.ts"), "patchpilot\n");
    await store.finishStep(record, root, index);
    await fs.writeFile(path.join(root, "app.ts"), "user edit after plan\n");

    const report = await store.rollback(record, root);
    assert.equal(report.verified, false);
    assert.equal(report.files[0]?.outcome, "conflict");
    assert.equal(await fs.readFile(path.join(root, "app.ts"), "utf8"), "user edit after plan\n");
  });

  it("does not claim success when a before-copy has been tampered with", async () => {
    const store = new SnapshotStore(storage);
    const record = await newRecord(store, "plan-d");
    await fs.writeFile(path.join(root, "app.ts"), "original\n");
    const index = await store.beginStep(record, root, "edit", ["app.ts"], "t");
    await fs.writeFile(path.join(root, "app.ts"), "changed\n");
    await store.finishStep(record, root, index);
    const backup = path.join(storage, "plans", "plan-d", "steps", "001", "before", "app.ts");
    await fs.writeFile(backup, "corrupted backup\n");

    const report = await store.rollback(record, root);
    assert.equal(report.verified, false);
    assert.equal(report.files[0]?.outcome, "failed");
    assert.equal(record.steps[0]?.rolledBack, false);
  });

  it("writes step.json hashes and persists the record across store instances", async () => {
    const store = new SnapshotStore(storage);
    const record = await newRecord(store, "plan-e");
    await fs.writeFile(path.join(root, "a.txt"), "x");
    const index = await store.beginStep(record, root, "s", ["a.txt"], "t");
    await store.finishStep(record, root, index);
    const stepJson = JSON.parse(await fs.readFile(path.join(storage, "plans", "plan-e", "steps", "001", "step.json"), "utf8")) as { files: { beforeHash: string; afterHash: string }[] };
    assert.equal(stepJson.files[0]?.beforeHash, sha256("x"));
    assert.equal(stepJson.files[0]?.afterHash, sha256("x"));

    const reloaded = await new SnapshotStore(storage).loadRecord("plan-e");
    assert.equal(reloaded?.steps.length, 1);
    assert.equal(await new SnapshotStore(storage).latestPlanId(), "plan-e");
  });

  it("rejects plan ids that could escape the storage folder", async () => {
    const store = new SnapshotStore(storage);
    await assert.rejects(store.loadRecord("../../etc"));
  });
});
