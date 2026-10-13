import * as assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, it } from "mocha";
import { planUpgrade, repairWithModel, reviewAndApply, rollbackChanges, validateChanges, type UpgradeDeps, type UpgradeUi } from "../../../commands/upgradeCommands";
import { SnapshotStore } from "../../../upgrade/store";
import { RETRIEVED } from "./helpers";
import type { AnalysisResult } from "../../../analysis/types";

let root: string;
let storage: string;

beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), "pp-cmd-root-"));
  storage = await fs.mkdtemp(path.join(os.tmpdir(), "pp-cmd-store-"));
  await fs.writeFile(path.join(root, "package.json"), '{"dependencies":{"lodash":"4.17.15"}}\n');
});

afterEach(async () => {
  await fs.rm(root, { recursive: true, force: true });
  await fs.rm(storage, { recursive: true, force: true });
});

interface Recorder {
  warnings: string[];
  infos: string[];
  errors: string[];
  confirms: string[];
}

function makeDeps(overrides: Partial<UpgradeDeps> & { confirmAnswer?: boolean; trusted?: boolean; folders?: number } = {}): { deps: UpgradeDeps; rec: Recorder; analysisCalls: { count: number }; osvCalls: { count: number } } {
  const rec: Recorder = { warnings: [], infos: [], errors: [], confirms: [] };
  const analysisCalls = { count: 0 };
  const osvCalls = { count: 0 };
  const ui: UpgradeUi = {
    confirm: (title) => {
      rec.confirms.push(title);
      return Promise.resolve(overrides.confirmAnswer ?? false);
    },
    runWithProgress: (_title, task) => task(new AbortController().signal),
    showInfo: (m) => rec.infos.push(m),
    showWarning: (m) => rec.warnings.push(m),
    showError: (m) => rec.errors.push(m),
    previewEdits: () => Promise.resolve(),
    confirmModelSend: () => Promise.resolve(false),
    approveEdits: () => Promise.resolve(false)
  };
  const store = new SnapshotStore(storage);
  const deps: UpgradeDeps = {
    root,
    folderCount: overrides.folders ?? 1,
    isTrusted: () => overrides.trusted ?? true,
    ui,
    log: { info: () => undefined, warn: () => undefined, error: () => undefined, debug: () => undefined } as unknown as UpgradeDeps["log"],
    store,
    now: () => new Date(RETRIEVED),
    lastResult: () => undefined,
    runAnalysis: () => {
      analysisCalls.count += 1;
      return Promise.resolve("declined");
    },
    queryOsv: () => {
      osvCalls.count += 1;
      return Promise.resolve({ kind: "found", value: [] });
    },
    settings: () => ({ ok: true, settings: { commandTimeoutMs: 10_000, repairMaxIterations: 1 } }),
    workflow: () => {
      throw new Error("workflow should not be built in this test");
    },
    repairConfig: () => Promise.resolve({ ok: false, message: "no model in test" }),
    onRecordChanged: () => undefined,
    ...overrides
  };
  return { deps, rec, analysisCalls, osvCalls };
}

describe("upgrade command guards", () => {
  it("refuses multi-root workspaces before doing anything", async () => {
    const { deps, rec, analysisCalls } = makeDeps({ folders: 2 });
    assert.equal(await planUpgrade(deps), "blocked");
    assert.equal(rec.warnings.length, 1);
    assert.match(rec.warnings[0] ?? "", /exactly one workspace folder/);
    assert.equal(analysisCalls.count, 0);
  });

  it("refuses to plan or apply in an untrusted folder", async () => {
    const { deps, rec } = makeDeps({ trusted: false });
    assert.equal(await planUpgrade(deps), "blocked");
    assert.equal(await reviewAndApply(deps), "blocked");
    assert.equal(await validateChanges(deps), "blocked");
    assert.equal(await repairWithModel(deps), "blocked");
    assert.equal(await rollbackChanges(deps), "blocked");
    assert.equal(rec.warnings.length, 5);
    assert.equal(await fs.readFile(path.join(root, "package.json"), "utf8"), '{"dependencies":{"lodash":"4.17.15"}}\n');
  });

  it("runs analysis first when there is no previous result, and stops if it is declined", async () => {
    const { deps, analysisCalls, osvCalls } = makeDeps();
    assert.equal(await planUpgrade(deps), "declined");
    assert.equal(analysisCalls.count, 1);
    assert.equal(osvCalls.count, 0);
  });

  it("does not query candidate advisories unless the user approves that request", async () => {
    const lodash = {
      ecosystem: "npm" as const,
      name: "lodash",
      declaredSpec: "4.17.15",
      declaredKind: "exact" as const,
      exactVersion: "4.17.15",
      scope: "runtime" as const,
      manifest: "package.json",
      lockedVersion: undefined,
      lockfile: undefined,
      note: undefined
    };
    const { assessment } = await import("./helpers");
    const { registryPackage } = await import("./helpers");
    const result: AnalysisResult = {
      startedAt: RETRIEVED,
      finishedAt: RETRIEVED,
      registry: [{ ecosystem: "npm", name: "lodash", lookup: { kind: "found", value: registryPackage({ ecosystem: "npm", name: "lodash", versions: ["4.17.15", "4.17.21"] }) } }],
      projects: [{ project: { ecosystem: "npm", manifest: "package.json", format: "package.json", dependencies: [lodash], issues: [] }, assessments: [assessment(lodash, { vulnerable: ["GHSA-x"], queried: "4.17.15" })] }],
      unsupportedFiles: [],
      sourceStatus: [],
      limitsReached: [],
      cancelled: false
    };
    const { deps, osvCalls, rec } = makeDeps({ lastResult: () => result, confirmAnswer: false });
    assert.equal(await planUpgrade(deps), "declined");
    assert.equal(osvCalls.count, 0, "no OSV request before consent");
    assert.equal(rec.confirms.length, 1);
    assert.equal(await fs.readFile(path.join(root, "package.json"), "utf8"), '{"dependencies":{"lodash":"4.17.15"}}\n');
  });

  it("says nothing to roll back when no plan exists", async () => {
    const { deps, rec } = makeDeps();
    assert.equal(await rollbackChanges(deps), "nothing");
    assert.match(rec.infos[0] ?? "", /Nothing to roll back/);
  });
});
