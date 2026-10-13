#!/usr/bin/env node
/**
 * End-to-end check of PatchPilot's Phase 4 workflow on the sample projects in samples/.
 *
 * Runs against the compiled extension code in out/ (run `npm run compile` first, or use `npm run e2e`).
 * Each sample is copied to a temporary folder; the repository copies are never modified.
 *
 * Uses the live npm registry, Maven Central, PyPI, and OSV (network required), the real
 * command templates (npm, mvn, python3), and real file snapshots.
 *
 * The repair case calls a LOCAL MOCK OpenAI-compatible endpoint. It returns a fixed reply.
 * It checks the request/response path and the repair loop. It is NOT a model evaluation.
 *
 * Consent prompts are answered by this script. Each answer is logged so it is visible.
 */
const fs = require("node:fs/promises");
const path = require("node:path");
const os = require("node:os");
const http = require("node:http");
const { execFileSync } = require("node:child_process");

const OUT = path.join(__dirname, "..", "out");
const { runAnalysis } = require(`${OUT}/analysis/runner`);
const { createLiveClients } = require(`${OUT}/analysis/clients`);
const { prepareCandidates, finalizePlan } = require(`${OUT}/upgrade/planner`);
const { SnapshotStore } = require(`${OUT}/upgrade/store`);
const { applyPlan, validatePlan, rollbackPlan, repairLoop, createExecutor } = require(`${OUT}/upgrade/workflow`);
const { OpenAICompatibleProvider } = require(`${OUT}/ai/openaiCompatible`);

const SAMPLES = path.join(__dirname, "..", "samples");
const MOCK_KEY = "sk-mock-e2e-key-000000";
const MOCK_REPAIR_REPLY = JSON.stringify({
  edits: [{ path: "src/greet.js", search: '"Helo, "', replace: '"Hello, "' }]
});
const COMMAND_TIMEOUT_MS = 600_000;

const CASES = [
  { name: "npm-vuln", install: true, repair: false },
  { name: "npm-repair", install: true, repair: true },
  { name: "maven-vuln", install: false, repair: false },
  { name: "python-vuln", install: false, repair: false }
];

const log = (message) => process.stdout.write(`${message}\n`);

async function listFiles(root, dir = "") {
  const entries = await fs.readdir(path.join(root, dir), { withFileTypes: true });
  const out = [];
  for (const entry of entries) {
    const rel = dir === "" ? entry.name : `${dir}/${entry.name}`;
    if (entry.isDirectory()) {
      if (!["node_modules", "target", ".git"].includes(entry.name)) {
        out.push(...(await listFiles(root, rel)));
      }
    } else {
      out.push(rel);
    }
  }
  return out;
}

async function snapshotTree(root) {
  const map = new Map();
  for (const rel of await listFiles(root)) {
    map.set(rel, await fs.readFile(path.join(root, rel)));
  }
  return map;
}

function manifestFilesFor(files) {
  return files.filter((rel) => /(^|\/)(package(-lock)?\.json|pom\.xml|requirements[^/]*\.txt|pyproject\.toml)$/.test(rel));
}

function workspaceFilesFor(root, relPaths) {
  return relPaths.map((rel) => ({
    path: rel,
    size: 0,
    read: () => fs.readFile(path.join(root, rel), "utf8")
  }));
}

function startMock() {
  const seen = [];
  const server = http.createServer((req, res) => {
    let body = "";
    req.on("data", (chunk) => {
      body += chunk;
    });
    req.on("end", () => {
      seen.push({ url: req.url, authorization: req.headers.authorization, body });
      res.writeHead(200, { "content-type": "text/event-stream" });
      const delta = { choices: [{ delta: { content: MOCK_REPAIR_REPLY } }] };
      res.write(`data: ${JSON.stringify(delta)}\n\n`);
      res.write("data: [DONE]\n\n");
      res.end();
    });
  });
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      resolve({ server, seen, baseUrl: `http://127.0.0.1:${String(address.port)}/v1` });
    });
  });
}

function summarizeRun(run) {
  return `${run.commandId} ${run.passed ? "PASS" : "FAIL"} (${run.exitCode === null ? "not run" : `exit ${String(run.exitCode)}`}, ${String(Math.round(run.durationMs / 1000))}s)`;
}

async function runCase(testCase, mock) {
  const result = { name: testCase.name, steps: [], consents: { osv: 0, modelSend: 0, editApproval: 0 } };
  const note = (step, detail) => {
    result.steps.push({ step, detail });
    log(`  [${testCase.name}] ${step}: ${detail}`);
  };
  const root = await fs.mkdtemp(path.join(os.tmpdir(), `pp-e2e-${testCase.name}-`));
  const storage = await fs.mkdtemp(path.join(os.tmpdir(), "pp-e2e-store-"));
  try {
    await fs.cp(path.join(SAMPLES, testCase.name), root, { recursive: true });
    if (testCase.install) {
      execFileSync("npm", ["install", "--ignore-scripts", "--no-audit", "--no-fund"], { cwd: root, stdio: "ignore", timeout: COMMAND_TIMEOUT_MS });
      note("setup", "npm install --ignore-scripts (creates package-lock.json)");
    }
    const original = await snapshotTree(root);
    const signal = new AbortController().signal;
    const exec = createExecutor({ root, timeoutMs: COMMAND_TIMEOUT_MS, maxOutputBytes: 16_000, knownSecrets: () => [MOCK_KEY] });
    const store = new SnapshotStore(storage);
    const clients = createLiveClients({ fetchImpl: (u, i) => fetch(u, i), timeoutMs: 30_000, now: () => new Date() });

    // Analysis (live registries and OSV).
    const files = manifestFilesFor(await listFiles(root));
    const analysis = await runAnalysis({
      files: workspaceFilesFor(root, files),
      clients,
      signal,
      now: () => new Date(),
      confirmNetwork: async () => {
        result.consents.osv += 1;
        return true;
      }
    });
    if (analysis === "declined") {
      throw new Error("analysis declined");
    }
    for (const project of analysis.projects) {
      for (const a of project.assessments) {
        note("analysis", `${a.dependency.name} ${a.queriedVersion ?? "?"} vulnerability=${a.vulnerability.status} advisories=${String(a.vulnerability.advisories.length)} deprecation=${a.deprecation.status}`);
      }
    }

    // Plan.
    const preparation = prepareCandidates(analysis);
    result.consents.osv += preparation.queries.length > 0 ? 1 : 0;
    const osv = preparation.queries.length > 0 ? await clients.queryOsv(preparation.queries, signal) : { kind: "found", value: [] };
    const plan = await finalizePlan({
      planId: `plan-e2e-${testCase.name}`,
      now: new Date().toISOString(),
      result: analysis,
      preparation,
      osv,
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
    for (const item of plan.items) {
      note("plan item", `${item.name} ${item.status} ${item.currentVersion ?? ""} -> ${item.targetVersion ?? "-"} ${item.blockReason ?? ""}`);
    }
    note("plan commands", plan.commands.map((c) => c.displayLine).join(" | ") || "none");
    const record = await store.createPlanRecord(plan);

    // Baseline: validation on the untouched project, to separate pre-existing failures from upgrade failures.
    const validateIds = plan.commands.filter((c) => c.phase === "validate").map((c) => c.id);
    for (const command of plan.commands.filter((c) => c.phase === "validate")) {
      const baseline = SnapshotStore.commandRecord(command.id, command.displayLine, "validate", new Date().toISOString(), await exec(command, signal));
      note("baseline (before change)", summarizeRun(baseline));
    }

    // Apply (approved apply commands are all selected here; consent is logged as one approval).
    const applyIds = plan.commands.filter((c) => c.phase === "apply").map((c) => c.id);
    const applied = await applyPlan(record, applyIds, { root, store, exec, now: () => new Date(), log: () => undefined }, signal);
    note("apply", `${applied.status}: ${applied.message}`);
    if (applied.status !== "applied") {
      return result;
    }

    // Validate.
    const workflow = { root, store, exec, now: () => new Date(), log: () => undefined };
    let validation = await validatePlan(record, validateIds, workflow, signal);
    note("validate", `${validation.status}: ${validation.message}`);
    for (const run of validation.runs) {
      note("  run", summarizeRun(run));
    }

    // Repair (only the repair case, and only when validation failed).
    if (testCase.repair && validation.status === "validation-failed") {
      const provider = new OpenAICompatibleProvider({ baseUrl: mock.baseUrl, apiKey: MOCK_KEY, timeoutMs: 20_000 });
      const repair = await repairLoop(
        record,
        {
          provider,
          model: "mock-model",
          maxIterations: 2,
          exclusions: [],
          selectedCommandIds: validateIds,
          ui: {
            confirmModelSend: async (message) => {
              result.consents.modelSend += 1;
              note("consent (model send)", message.title);
              return true;
            },
            approveEdits: async (changes) => {
              result.consents.editApproval += 1;
              note("diff approval", changes.map((c) => c.path).join(", "));
              return true;
            }
          },
          signal
        },
        workflow
      );
      note("repair", `${repair.stop} after ${String(repair.iterations)} attempt(s): ${repair.message}`);
      const request = mock.seen.at(-1);
      if (request !== undefined) {
        note("mock request", `url=${request.url} auth-header-present=${String(request.authorization !== undefined)} key-in-body=${String(request.body.includes(MOCK_KEY))} manifest-in-body=${String(request.body.includes("\"dependencies\""))}`);
      }
      validation = { status: repair.status };
    }

    // Rollback, then verify every file matches the original byte-for-byte.
    const rollback = await rollbackPlan(record, workflow);
    const restored = await snapshotTree(root);
    // Modified or missing originals fail the check. New files are listed separately:
    // rollback only restores files PatchPilot changed, so validation output is reported, not hidden.
    let identical = true;
    const modified = [];
    for (const [rel, bytes] of original) {
      if (!restored.get(rel)?.equals(bytes)) {
        identical = false;
        modified.push(rel);
      }
    }
    const extra = [...restored.keys()].filter((rel) => !original.has(rel));
    if (extra.length > 0) {
      note("extra files after rollback", extra.join(", "));
    }
    if (modified.length > 0) {
      note("modified after rollback", modified.join(", "));
    }
    note("rollback", `verified=${String(rollback.verified)} files=${rollback.files.map((f) => `${f.path}:${f.outcome}`).join(", ")}`);
    note("restore check", `byte-identical to original=${String(identical)} (${String(original.size)} files)`);
    result.final = { validation: validation.status, rollbackVerified: rollback.verified, identical };
    return result;
  } finally {
    await fs.rm(root, { recursive: true, force: true });
    await fs.rm(storage, { recursive: true, force: true });
  }
}

async function main() {
  const mock = await startMock();
  const results = [];
  try {
    for (const testCase of CASES) {
      log(`\n== ${testCase.name}`);
      try {
        results.push(await runCase(testCase, mock));
      } catch (error) {
        log(`  [${testCase.name}] HARNESS ERROR: ${error instanceof Error ? error.message : String(error)}`);
        results.push({ name: testCase.name, error: error instanceof Error ? error.message : String(error) });
      }
    }
  } finally {
    mock.server.close();
  }
  log("\n== summary");
  console.log(JSON.stringify(results, null, 2));
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
