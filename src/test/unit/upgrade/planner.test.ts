import * as assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, it } from "mocha";
import type { AnalysisResult, Lookup, ManifestDependency, ParsedProject } from "../../../analysis/types";
import { finalizePlan, prepareCandidates } from "../../../upgrade/planner";
import { COMMAND_TEMPLATES, executableFor } from "../../../upgrade/commands";
import { assessment, dep, RETRIEVED, registryPackage } from "./helpers";

let root: string;

beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), "pp-plan-"));
});

afterEach(async () => {
  await fs.rm(root, { recursive: true, force: true });
});

function project(manifest: string, ecosystem: ManifestDependency["ecosystem"], dependencies: ManifestDependency[]): ParsedProject {
  return { ecosystem, manifest, format: manifest, dependencies, issues: [] };
}

function result(projects: { project: ParsedProject; assessments: ReturnType<typeof assessment>[] }[], registry: AnalysisResult["registry"] = []): AnalysisResult {
  return {
    startedAt: RETRIEVED,
    finishedAt: RETRIEVED,
    registry,
    projects,
    unsupportedFiles: [],
    sourceStatus: [],
    limitsReached: [],
    cancelled: false
  };
}

const lodash = dep({ ecosystem: "npm", name: "lodash", manifest: "package.json", declaredSpec: "4.17.15", exactVersion: "4.17.15" });
const lodashRegistry = (versions: string[]): AnalysisResult["registry"] => [
  { ecosystem: "npm", name: "lodash", lookup: { kind: "found", value: registryPackage({ ecosystem: "npm", name: "lodash", versions, latestStable: versions.at(-1) }) } }
];

function osvCounts(entries: [string, number][]): Lookup<(readonly string[])[]> {
  return { kind: "found", value: entries.map(([, count]) => Array.from({ length: count }, (_, i) => `GHSA-${String(i)}`)) };
}

async function writeFile(rel: string, text: string): Promise<void> {
  await fs.mkdir(path.dirname(path.join(root, rel)), { recursive: true });
  await fs.writeFile(path.join(root, rel), text, "utf8");
}

async function plan(analysis: AnalysisResult, osv: Lookup<(readonly string[])[]>, extraFiles: Record<string, string> = {}) {
  for (const [rel, text] of Object.entries(extraFiles)) {
    await writeFile(rel, text);
  }
  const preparation = prepareCandidates(analysis);
  return finalizePlan({
    planId: "plan-test",
    now: RETRIEVED,
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
}

describe("prepareCandidates", () => {
  it("lists OSV queries for each candidate of a vulnerable exact pin", () => {
    const analysis = result([{ project: project("package.json", "npm", [lodash]), assessments: [assessment(lodash, { vulnerable: ["GHSA-x"], queried: "4.17.15" })] }], lodashRegistry(["4.17.15", "4.17.20", "4.17.21"]));
    const prepared = prepareCandidates(analysis);
    assert.equal(prepared.items.length, 1);
    assert.deepEqual(prepared.queries.map((q) => q.version), ["4.17.21", "4.17.20"]);
  });

  it("ignores dependencies that are neither vulnerable nor deprecated", () => {
    const analysis = result([{ project: project("package.json", "npm", [lodash]), assessments: [assessment(lodash, {})] }], lodashRegistry(["4.17.15", "4.17.21"]));
    assert.equal(prepareCandidates(analysis).items.length, 0);
  });

  it("plans deprecated (not vulnerable) exact pins too", () => {
    const analysis = result([{ project: project("package.json", "npm", [lodash]), assessments: [assessment(lodash, { deprecated: true })] }], lodashRegistry(["4.17.15", "4.17.21"]));
    assert.equal(prepareCandidates(analysis).items.length, 1);
  });

  it("blocks range-only declarations without querying candidates", () => {
    const range = dep({ ecosystem: "npm", name: "express", manifest: "package.json", declaredSpec: "^4.18.0", declaredKind: "range", exactVersion: undefined });
    const analysis = result([{ project: project("package.json", "npm", [range]), assessments: [assessment(range, { vulnerable: ["GHSA-r"], queried: "4.18.0", source: "lockfile" })] }], []);
    const prepared = prepareCandidates(analysis);
    assert.equal(prepared.items.at(0)?.blocked?.reason, "not-exact-pin");
    assert.equal(prepared.queries.length, 0);
  });
});

describe("finalizePlan", () => {
  it("chooses the newest candidate with no advisories and edits the manifest", async () => {
    const analysis = result([{ project: project("package.json", "npm", [lodash]), assessments: [assessment(lodash, { vulnerable: ["GHSA-x"], queried: "4.17.15" })] }], lodashRegistry(["4.17.15", "4.17.20", "4.17.21"]));
    const planned = await plan(analysis, osvCounts([["21", 1], ["20", 0]]), {
      "package.json": '{\n  "dependencies": {\n    "lodash": "4.17.15"\n  },\n  "scripts": { "test": "node test.js" }\n}\n'
    });
    const item = planned.items.at(0);
    assert.ok(item);
    assert.equal(item.status, "ready");
    assert.equal(item.targetVersion, "4.17.20");
    assert.deepEqual(item.advisoriesFixed, ["GHSA-x"]);
    assert.match(item.compatibility, /not verified/);
    assert.equal(planned.edits.length, 1);
    assert.match(planned.edits.at(0)?.proposedText ?? "", /"lodash": "4\.17\.20"/);
    assert.deepEqual(planned.commands.map((c) => c.template), ["npm-test"]);
  });

  it("blocks when no candidate is free of advisories", async () => {
    const analysis = result([{ project: project("package.json", "npm", [lodash]), assessments: [assessment(lodash, { vulnerable: ["GHSA-x"], queried: "4.17.15" })] }], lodashRegistry(["4.17.15", "4.17.20"]));
    const planned = await plan(analysis, osvCounts([["20", 1]]), { "package.json": '{"dependencies":{"lodash":"4.17.15"}}' });
    assert.equal(planned.items.at(0)?.status, "blocked");
    assert.equal(planned.items.at(0)?.blockReason, "no-clean-candidate");
    assert.equal(planned.edits.length, 0);
  });

  it("blocks with a clear reason when the OSV candidate check is unavailable", async () => {
    const analysis = result([{ project: project("package.json", "npm", [lodash]), assessments: [assessment(lodash, { vulnerable: ["GHSA-x"], queried: "4.17.15" })] }], lodashRegistry(["4.17.15", "4.17.20"]));
    const planned = await plan(analysis, { kind: "unavailable", reason: "timeout" }, { "package.json": '{"dependencies":{"lodash":"4.17.15"}}' });
    assert.equal(planned.items.at(0)?.blockReason, "candidate-check-unavailable");
    assert.equal(planned.edits.length, 0);
  });

  it("blocks when registry metadata is missing", async () => {
    const analysis = result([{ project: project("package.json", "npm", [lodash]), assessments: [assessment(lodash, { vulnerable: ["GHSA-x"], queried: "4.17.15" })] }], []);
    const planned = await plan(analysis, osvCounts([]), { "package.json": '{"dependencies":{"lodash":"4.17.15"}}' });
    assert.equal(planned.items.at(0)?.blockReason, "no-registry-data");
  });

  it("blocks when the lockfile and manifest disagree", async () => {
    const analysis = result([{ project: project("package.json", "npm", [lodash]), assessments: [assessment(lodash, { vulnerable: ["GHSA-x"], queried: "4.17.10", source: "lockfile" })] }], lodashRegistry(["4.17.15", "4.17.21"]));
    const planned = await plan(analysis, osvCounts([["21", 0]]), { "package.json": '{"dependencies":{"lodash":"4.17.15"}}' });
    assert.equal(planned.items.at(0)?.blockReason, "lock-manifest-mismatch");
  });

  it("blocks a Maven property-derived version instead of editing it", async () => {
    const commons = dep({ ecosystem: "maven", name: "org.apache.commons:commons-lang3", manifest: "pom.xml", declaredSpec: "3.5", exactVersion: "3.5" });
    const analysis = result(
      [{ project: project("pom.xml", "maven", [commons]), assessments: [assessment(commons, { vulnerable: ["GHSA-m"], queried: "3.5" })] }],
      [{ ecosystem: "maven", name: "org.apache.commons:commons-lang3", lookup: { kind: "found", value: registryPackage({ ecosystem: "maven", name: "org.apache.commons:commons-lang3", versions: ["3.5", "3.12.0"], latestStable: "3.12.0" }) } }]
    );
    const pom = "<project><dependencies><dependency><groupId>org.apache.commons</groupId><artifactId>commons-lang3</artifactId><version>${lang.version}</version></dependency></dependencies></project>";
    const planned = await plan(analysis, osvCounts([["12", 0]]), { "pom.xml": pom });
    assert.equal(planned.items.at(0)?.status, "blocked");
    assert.equal(planned.items.at(0)?.blockReason, "edit-not-found");
    assert.equal(planned.edits.length, 0);
    assert.deepEqual(planned.commands, []);
  });

  it("plans the Maven pin and both Maven validation commands when the literal pin is editable", async () => {
    const commons = dep({ ecosystem: "maven", name: "org.apache.commons:commons-lang3", manifest: "pom.xml", declaredSpec: "3.5", exactVersion: "3.5" });
    const analysis = result(
      [{ project: project("pom.xml", "maven", [commons]), assessments: [assessment(commons, { vulnerable: ["GHSA-m"], queried: "3.5" })] }],
      [{ ecosystem: "maven", name: "org.apache.commons:commons-lang3", lookup: { kind: "found", value: registryPackage({ ecosystem: "maven", name: "org.apache.commons:commons-lang3", versions: ["3.5", "3.12.0"], latestStable: "3.12.0" }) } }]
    );
    const pom = "<project><dependencies><dependency><groupId>org.apache.commons</groupId><artifactId>commons-lang3</artifactId><version>3.5</version></dependency></dependencies></project>";
    const planned = await plan(analysis, osvCounts([["12", 0]]), { "pom.xml": pom });
    assert.equal(planned.items.at(0)?.targetVersion, "3.12.0");
    assert.deepEqual(planned.commands.map((c) => c.template), ["maven-dependency-resolve", "maven-test"]);
  });

  it("refuses a requirements edit that would touch two lines", async () => {
    const requests = dep({ ecosystem: "pypi", name: "requests", manifest: "requirements.txt", declaredSpec: "2.19.0", exactVersion: "2.19.0" });
    const analysis = result(
      [{ project: project("requirements.txt", "pypi", [requests]), assessments: [assessment(requests, { vulnerable: ["GHSA-p"], queried: "2.19.0" })] }],
      [{ ecosystem: "pypi", name: "requests", lookup: { kind: "found", value: registryPackage({ ecosystem: "pypi", name: "requests", versions: ["2.19.0", "2.32.3"], latestStable: "2.32.3" }) } }]
    );
    const planned = await plan(analysis, osvCounts([["2.32.3", 0]]), { "requirements.txt": "requests==2.19.0\nrequests==2.19.0\n" });
    assert.equal(planned.items.at(0)?.blockReason, "edit-not-unique");
  });

  it("plans a pip dry-run for a requirements file and shows the exact executable", async () => {
    const requests = dep({ ecosystem: "pypi", name: "requests", manifest: "requirements.txt", declaredSpec: "2.19.0", exactVersion: "2.19.0" });
    const analysis = result(
      [{ project: project("requirements.txt", "pypi", [requests]), assessments: [assessment(requests, { vulnerable: ["GHSA-p"], queried: "2.19.0" })] }],
      [{ ecosystem: "pypi", name: "requests", lookup: { kind: "found", value: registryPackage({ ecosystem: "pypi", name: "requests", versions: ["2.19.0", "2.32.3"], latestStable: "2.32.3" }) } }]
    );
    const planned = await plan(analysis, osvCounts([["2.32.3", 0]]), { "requirements.txt": "requests==2.19.0\n" });
    assert.equal(planned.items.at(0)?.targetVersion, "2.32.3");
    assert.equal(planned.edits.at(0)?.proposedText, "requests==2.32.3\n");
    assert.deepEqual(planned.commands.map((c) => c.template), ["pypi-pip-dry-run"]);
    assert.equal(planned.commands.at(0)?.displayLine, `. $ ${executableFor(COMMAND_TEMPLATES["pypi-pip-dry-run"])} -m pip install --dry-run --quiet -r requirements.txt`);
  });
});
