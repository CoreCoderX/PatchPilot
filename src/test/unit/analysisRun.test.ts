import * as assert from "node:assert/strict";
import { describe, it } from "mocha";
import { assessDependency, queriedVersionFor, type AdvisoryOutcome } from "../../analysis/assess";
import { bodyText } from "./helpers";
import { buildAnalysisConsent } from "../../analysis/consent";
import { runAnalysis, type AnalysisClients, type WorkspaceFile } from "../../analysis/runner";
import type { AnalysisResult, Lookup, ManifestDependency, RegistryPackage } from "../../analysis/types";
import { analyzeDependencies } from "../../commands/analyzeCommand";
import { OSV_BATCH_URL, parseOsvBatchResponse, queryOsvBatch } from "../../advisories/osv";
import { httpText } from "../../registry/http";
import { mavenMetadataUrl, parseMavenMetadata } from "../../registry/maven";
import { parseNpmPackument } from "../../registry/npm";
import { normalizePypiName, parsePypiJson } from "../../registry/pypi";
import { buildResultNodes, issueKindsFor } from "../../ui/dependencyModel";

const NOW = new Date("2026-10-12T00:00:00.000Z");
const RETRIEVED = NOW.toISOString();
const signal = new AbortController().signal;

function jsonResponse(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(typeof body === "string" ? body : JSON.stringify(body), { status, headers });
}

function file(path: string, text: string): WorkspaceFile {
  return { path, size: Buffer.byteLength(text), read: () => Promise.resolve(text) };
}

function dep(overrides: Partial<ManifestDependency>): ManifestDependency {
  return {
    ecosystem: "npm",
    name: "left",
    declaredSpec: "1.0.0",
    declaredKind: "exact",
    exactVersion: "1.0.0",
    scope: "runtime",
    manifest: "package.json",
    lockedVersion: undefined,
    lockfile: undefined,
    note: undefined,
    ...overrides
  };
}

function pkg(latest: string | undefined, extra: Partial<RegistryPackage> = {}): Lookup<RegistryPackage> {
  return {
    kind: "found",
    value: {
      ecosystem: "npm",
      name: "left",
      sourceUrl: "https://registry.npmjs.org/left",
      retrievedAt: RETRIEVED,
      latestStable: latest,
      versions: latest === undefined ? [] : [latest],
      deprecated: {},
      yanked: [],
      ...extra
    }
  };
}

/** Narrows a Lookup to its found value, failing the test otherwise. */
function found<T>(lookup: Lookup<T>): T {
  if (lookup.kind !== "found") {
    throw new Error("expected a found lookup");
  }
  return lookup.value;
}

/** Narrows the runner outcome to a completed result, failing the test if consent was declined. */
function completed(result: AnalysisResult | "declined"): AnalysisResult {
  assert.notEqual(result, "declined");
  if (result === "declined") {
    throw new Error("expected a completed run");
  }
  return result;
}

const noAdvisories: AdvisoryOutcome = { kind: "checked", advisories: [] };

describe("registry response parsers", () => {
  it("reads npm packuments, dist-tag latest, and per-version deprecation", () => {
    const text = JSON.stringify({
      name: "left",
      "dist-tags": { latest: "2.0.0" },
      versions: {
        "1.0.0": { deprecated: "use right" },
        "2.0.0": {},
        "3.0.0-beta.1": {},
        "not-semver": {}
      }
    });
    const value = found(parseNpmPackument(text, "https://registry.npmjs.org/left", RETRIEVED));
    assert.equal(value.latestStable, "2.0.0");
    assert.deepEqual(value.versions, ["1.0.0", "2.0.0", "3.0.0-beta.1"]);
    assert.equal(value.deprecated["1.0.0"], "use right");
  });

  it("falls back to the highest stable npm version when the latest tag is a pre-release", () => {
    const text = JSON.stringify({ "dist-tags": { latest: "2.0.0-rc.1" }, versions: { "1.9.0": {}, "2.0.0-rc.1": {} } });
    const value = found(parseNpmPackument(text, "u", RETRIEVED));
    assert.equal(value.latestStable, "1.9.0");
  });

  it("treats an unexpected npm shape as unavailable", () => {
    assert.equal(parseNpmPackument("[]", "u", RETRIEVED).kind, "unavailable");
    assert.equal(parseNpmPackument("{not json", "u", RETRIEVED).kind, "unavailable");
  });

  it("builds Maven Central metadata URLs and rejects malformed coordinates", () => {
    assert.equal(mavenMetadataUrl("org.apache.commons:commons-lang3"), "https://repo1.maven.org/maven2/org/apache/commons/commons-lang3/maven-metadata.xml");
    assert.equal(mavenMetadataUrl("no-colon"), undefined);
    assert.equal(mavenMetadataUrl("bad group:x"), undefined);
  });

  it("reads Maven metadata and prefers the release element when it is stable", () => {
    const xml = `<metadata><versioning><release>2.0.0</release><latest>2.1.0-SNAPSHOT</latest>
      <versions><version>1.0.0</version><version>2.0.0</version><version>2.1.0-SNAPSHOT</version></versions></versioning></metadata>`;
    const value = found(parseMavenMetadata("g:a", xml, "u", RETRIEVED));
    assert.equal(value.latestStable, "2.0.0");
    assert.equal(value.versions.length, 3);
  });

  it("reads PyPI JSON, normalizes names, and marks fully yanked releases", () => {
    assert.equal(normalizePypiName("Flask_Login.Ext"), "flask-login-ext");
    const json = JSON.stringify({
      info: { name: "demo", version: "2.0.0" },
      releases: {
        "1.0.0": [{ yanked: false }],
        "1.5.0": [{ yanked: true }, { yanked: true }],
        "2.0.0": [{ yanked: false }],
        "3.0.0rc1": [{ yanked: false }]
      }
    });
    const value = found(parsePypiJson(json, "u", RETRIEVED));
    assert.equal(value.latestStable, "2.0.0");
    assert.deepEqual(value.yanked, ["1.5.0"]);
  });
});

describe("HTTP helper and OSV client", () => {
  const opts = { accept: "application/json", signal, timeoutMs: 1000, maxBytes: 100 };

  it("maps 404 to not-found, 429 to unavailable with retry-after, and 500 to unavailable", async () => {
    assert.equal((await httpText("u", { ...opts, fetchImpl: () => Promise.resolve(new Response("", { status: 404 })) })).kind, "not-found");
    const limited = await httpText("u", { ...opts, fetchImpl: () => Promise.resolve(new Response("", { status: 429, headers: { "retry-after": "30" } })) });
    assert.equal(limited.kind, "unavailable");
    assert.ok(limited.reason.includes("retry after 30"));
    const broken = await httpText("u", { ...opts, fetchImpl: () => Promise.resolve(new Response("", { status: 500 })) });
    assert.deepEqual(broken, { kind: "unavailable", reason: "HTTP 500" });
  });

  it("refuses bodies over the byte cap and reports network errors without throwing", async () => {
    const big = await httpText("u", { ...opts, maxBytes: 5, fetchImpl: () => Promise.resolve(new Response("0123456789")) });
    assert.equal(big.kind, "unavailable");
    const network = await httpText("u", { ...opts, fetchImpl: () => Promise.reject(new TypeError("fetch failed")) });
    assert.deepEqual(network, { kind: "unavailable", reason: "network error" });
  });

  it("validates the OSV batch response shape", () => {
    assert.equal(parseOsvBatchResponse("{}", 1), undefined);
    assert.equal(parseOsvBatchResponse(JSON.stringify({ results: [{}, {}] }), 1), undefined);
    const ok = parseOsvBatchResponse(JSON.stringify({ results: [{ vulns: [{ id: "GHSA-1" }, { id: "bad id" }], next_page_token: "t" }] }), 1);
    assert.deepEqual(ok, [{ ids: ["GHSA-1"], nextPageToken: "t" }]);
  });

  it("follows OSV pagination tokens and de-duplicates advisory IDs", async () => {
    const bodies: unknown[] = [];
    let call = 0;
    const fetchImpl = (_url: string, init: RequestInit): Promise<Response> => {
      bodies.push(JSON.parse(bodyText(init)));
      call += 1;
      if (call === 1) {
        return Promise.resolve(jsonResponse({ results: [{ vulns: [{ id: "OSV-1" }], next_page_token: "p2" }, { vulns: [] }] }));
      }
      return Promise.resolve(jsonResponse({ results: [{ vulns: [{ id: "OSV-1" }, { id: "OSV-2" }] }] }));
    };
    const result = await queryOsvBatch(
      [
        { ecosystem: "npm", name: "a", version: "1.0.0" },
        { ecosystem: "maven", name: "g:b", version: "2.0" }
      ],
      { fetchImpl, signal, timeoutMs: 1000, maxBytes: 100000 }
    );
    assert.deepEqual(found(result), [["OSV-1", "OSV-2"], []]);
    assert.equal(call, 2);
    const first = bodies[0] as { queries: { package: { ecosystem: string } }[] };
    assert.equal(first.queries[1]?.package.ecosystem, "Maven");
  });

  it("returns unavailable for a failed batch so callers can mark queries unknown", async () => {
    const result = await queryOsvBatch([{ ecosystem: "pypi", name: "x", version: "1" }], {
      fetchImpl: () => Promise.resolve(new Response("", { status: 503 })),
      signal,
      timeoutMs: 1000,
      maxBytes: 1000
    });
    assert.equal(result.kind, "unavailable");
  });
});

describe("assessment rules", () => {
  it("uses the lockfile version in preference to the exact pin", () => {
    const locked = dep({ declaredKind: "range", exactVersion: undefined, declaredSpec: "^1.0.0", lockedVersion: "1.4.0", lockfile: "package-lock.json" });
    assert.deepEqual(queriedVersionFor(locked), { version: "1.4.0", source: "lockfile" });
    assert.equal(queriedVersionFor(dep({ declaredKind: "range", exactVersion: undefined, declaredSpec: "^1.0.0" })), undefined);
  });

  it("reports vulnerable, outdated, and deprecated exact pins with separate reasons", () => {
    const registry = pkg("2.0.0", { deprecated: { "1.0.0": "replaced" } });
    const result = assessDependency({
      id: "x",
      dependency: dep({}),
      registry,
      advisories: { kind: "checked", advisories: [{ id: "GHSA-x", url: "u", summary: "bad" }] },
      osvRetrievedAt: RETRIEVED,
      osvSourceUrl: OSV_BATCH_URL
    });
    assert.equal(result.vulnerability.status, "vulnerable");
    assert.equal(result.freshness.status, "outdated");
    assert.equal(result.deprecation.status, "deprecated");
    assert.equal(result.deprecation.message, "replaced");
    assert.equal(result.compatibility.status, "unknown");
    assert.deepEqual(issueKindsFor(result), ["vulnerable", "outdated", "deprecated"]);
  });

  it("keeps unknown separate from clean when OSV is unavailable", () => {
    const result = assessDependency({
      id: "x",
      dependency: dep({}),
      registry: pkg("1.0.0"),
      advisories: { kind: "unavailable", reason: "HTTP 503" },
      osvRetrievedAt: undefined,
      osvSourceUrl: OSV_BATCH_URL
    });
    assert.equal(result.vulnerability.status, "unknown");
    assert.ok(result.vulnerability.reason.includes("HTTP 503"));
    assert.equal(result.freshness.status, "current");
  });

  it("does not run an OSV check for range-only declarations and evaluates the range against latest", () => {
    const range = dep({ declaredKind: "range", declaredSpec: "^1.0.0", exactVersion: undefined });
    const result = assessDependency({ id: "r", dependency: range, registry: pkg("2.0.0"), advisories: noAdvisories, osvRetrievedAt: undefined, osvSourceUrl: OSV_BATCH_URL });
    assert.equal(result.vulnerability.status, "unknown");
    assert.equal(result.freshness.status, "range-excludes-latest");
    assert.equal(result.queriedVersion, undefined);
  });

  it("marks Maven ranges as unknown freshness and never evaluates them", () => {
    const maven = dep({ ecosystem: "maven", name: "g:a", declaredKind: "range", declaredSpec: "[1.0,2.0)", exactVersion: undefined });
    const result = assessDependency({ id: "m", dependency: maven, registry: pkg("3.0.0"), advisories: noAdvisories, osvRetrievedAt: undefined, osvSourceUrl: OSV_BATCH_URL });
    assert.equal(result.freshness.status, "unknown");
    assert.equal(result.deprecation.status, "unknown");
  });

  it("records a PyPI yank as evidence without treating it as a deprecation", () => {
    const pypi = dep({ ecosystem: "pypi", name: "demo", declaredSpec: "==1.5.0", exactVersion: "1.5.0" });
    const registry = pkg("2.0.0", { ecosystem: "pypi", yanked: ["1.5.0"], sourceUrl: "https://pypi.org/pypi/demo/json" });
    const result = assessDependency({ id: "y", dependency: pypi, registry, advisories: noAdvisories, osvRetrievedAt: undefined, osvSourceUrl: OSV_BATCH_URL });
    assert.ok(result.evidence.some((e) => e.source === "pypi" && e.detail.includes("yanked")));
    assert.equal(result.deprecation.status, "unknown");
  });

  it("treats a version newer than the registry's latest stable as current, not outdated", () => {
    const result = assessDependency({ id: "n", dependency: dep({ exactVersion: "3.0.0-beta", declaredSpec: "3.0.0-beta" }), registry: pkg("2.0.0"), advisories: noAdvisories, osvRetrievedAt: undefined, osvSourceUrl: OSV_BATCH_URL });
    assert.equal(result.freshness.status, "current");
  });
});

describe("analysis runner", () => {
  const manifest = JSON.stringify({ dependencies: { left: "1.0.0", pad: "^2.0.0" } });
  const lock = JSON.stringify({ lockfileVersion: 3, packages: { "node_modules/left": { version: "1.0.0" } } });

  function fakeClients(log: string[]): AnalysisClients {
    return {
      lookupRegistry: (ecosystem, name) => {
        log.push(`registry:${ecosystem}:${name}`);
        return Promise.resolve(name === "left" ? pkg("2.0.0") : { kind: "not-found" });
      },
      queryOsv: (queries) => {
        log.push(`osv:${String(queries.length)}`);
        return Promise.resolve({ kind: "found", value: queries.map((q) => (q.name === "left" ? ["GHSA-left"] : [])) });
      },
      fetchAdvisory: (id) => {
        log.push(`advisory:${id}`);
        return Promise.resolve({ kind: "found", value: { summary: "Prototype pollution" } });
      }
    };
  }

  it("makes no network call when consent is declined", async () => {
    const log: string[] = [];
    const result = await runAnalysis({
      files: [file("package.json", manifest), file("package-lock.json", lock)],
      clients: fakeClients(log),
      signal,
      now: () => NOW,
      confirmNetwork: () => Promise.resolve(false)
    });
    assert.equal(result, "declined");
    assert.deepEqual(log, []);
  });

  it("consent receives exact counts before any request, then the run completes", async () => {
    const log: string[] = [];
    let plan: unknown;
    const result = await runAnalysis({
      files: [file("package.json", manifest), file("package-lock.json", lock), file("pom.xml", "<project></project>")],
      clients: fakeClients(log),
      signal,
      now: () => NOW,
      confirmNetwork: (p) => {
        plan = p;
        assert.deepEqual(log, [], "no network before consent");
        return Promise.resolve(true);
      }
    });
    const done = completed(result);
    assert.deepEqual(plan, {
      registryPackages: { npm: 2, maven: 0, pypi: 0 },
      osvQueries: 1,
      manifests: ["package.json", "pom.xml"],
      unsupportedFiles: 0
    });
    const project = done.projects[0];
    assert.ok(project);
    const left = project.assessments.find((a) => a.dependency.name === "left");
    assert.ok(left);
    assert.equal(left.vulnerability.status, "vulnerable");
    assert.equal(left.queriedVersionSource, "lockfile");
    assert.equal(left.freshness.status, "outdated");
    const pad = project.assessments.find((a) => a.dependency.name === "pad");
    assert.equal(pad?.vulnerability.status, "unknown");
    assert.equal(done.sourceStatus.find((s) => s.source === "osv")?.status, "ok");
    assert.ok(done.sourceStatus.find((s) => s.source === "pypi")?.status === "not-used");
    assert.ok(log.includes("advisory:GHSA-left"));
    assert.equal(done.projects[0]?.assessments[0]?.vulnerability.advisories[0]?.summary, "Prototype pollution");
  });

  it("reports an OSV outage as unavailable and keeps other results", async () => {
    const clients = fakeClients([]);
    const result = await runAnalysis({
      files: [file("package.json", manifest)],
      clients: { ...clients, queryOsv: () => Promise.resolve({ kind: "unavailable", reason: "HTTP 503" }) },
      signal,
      now: () => NOW
    });
    const done = completed(result);
    assert.equal(done.sourceStatus.find((s) => s.source === "osv")?.status, "unavailable");
    assert.equal(done.projects[0]?.assessments[0]?.vulnerability.status, "unknown");
    assert.equal(done.projects[0]?.assessments[0]?.freshness.status, "outdated");
  });

  it("reports a project with no dependencies without any lookups", async () => {
    const log: string[] = [];
    const done = completed(
      await runAnalysis({
        files: [file("package.json", JSON.stringify({ name: "empty" }))],
        clients: fakeClients(log),
        signal,
        now: () => NOW
      })
    );
    assert.equal(done.projects.length, 1);
    assert.equal(done.projects[0]?.assessments.length, 0);
    assert.deepEqual(log, []);
    assert.equal(done.sourceStatus.every((s) => s.status === "not-used"), true);
  });

  it("marks freshness unknown and the source unavailable when a registry is down", async () => {
    const clients = fakeClients([]);
    const done = completed(
      await runAnalysis({
        files: [file("package.json", manifest)],
        clients: {
          ...clients,
          lookupRegistry: () => Promise.resolve({ kind: "unavailable", reason: "HTTP 503" })
        },
        signal,
        now: () => NOW
      })
    );
    const left = done.projects[0]?.assessments.find((a) => a.dependency.name === "left");
    assert.ok(left);
    assert.equal(left.freshness.status, "unknown");
    assert.ok(left.freshness.reason.includes("HTTP 503"));
    assert.equal(left.deprecation.status, "unknown");
    // The OSV check still runs and still reports its own result.
    assert.equal(left.vulnerability.status, "vulnerable");
    assert.equal(done.sourceStatus.find((s) => s.source === "npm-registry")?.status, "unavailable");
  });

  it("stops when cancelled before requests, and marks the run cancelled", async () => {
    const controller = new AbortController();
    controller.abort();
    const log: string[] = [];
    const result = await runAnalysis({
      files: [file("package.json", manifest)],
      clients: fakeClients(log),
      signal: controller.signal,
      now: () => NOW
    });
    const done = completed(result);
    assert.equal(done.cancelled, true);
    assert.deepEqual(log, []);
  });
});

describe("consent text and results view model", () => {
  it("lists every endpoint with exact counts and states what is not sent", () => {
    const message = buildAnalysisConsent({
      registryPackages: { npm: 3, maven: 1, pypi: 0 },
      osvQueries: 4,
      manifests: ["package.json", "pom.xml"],
      unsupportedFiles: 2
    });
    assert.ok(message.detail.includes("https://registry.npmjs.org"));
    assert.ok(message.detail.includes("repo1.maven.org"));
    assert.ok(message.detail.includes("pypi.org"));
    assert.ok(message.detail.includes("api.osv.dev"));
    assert.ok(message.detail.includes("npm registry (https://registry.npmjs.org): 3 package name(s)"));
    assert.ok(message.detail.includes("4 package-and-version queries"));
    assert.ok(message.detail.includes("No file contents"));
  });

  it("orders problem dependencies first and shows unknown states as unknown", () => {
    const vulnerable = assessDependency({
      id: "v",
      dependency: dep({ name: "zeta" }),
      registry: pkg("2.0.0"),
      advisories: { kind: "checked", advisories: [{ id: "GHSA-z", url: "u", summary: undefined }] },
      osvRetrievedAt: undefined,
      osvSourceUrl: OSV_BATCH_URL
    });
    const clean = assessDependency({
      id: "c",
      dependency: dep({ name: "alpha", declaredSpec: "2.0.0", exactVersion: "2.0.0" }),
      registry: pkg("2.0.0"),
      advisories: noAdvisories,
      osvRetrievedAt: undefined,
      osvSourceUrl: OSV_BATCH_URL
    });
    const nodes = buildResultNodes({
      startedAt: RETRIEVED,
      registry: [],
      finishedAt: RETRIEVED,
      projects: [{ project: { ecosystem: "npm", manifest: "package.json", format: "package.json", dependencies: [], issues: [] }, assessments: [clean, vulnerable] }],
      unsupportedFiles: [],
      sourceStatus: [],
      limitsReached: [],
      cancelled: false
    });
    const projectNode = nodes.find((n) => n.id === "project-0");
    assert.ok(projectNode);
    assert.equal(projectNode.children[0]?.label, "zeta");
    assert.equal(projectNode.children[0]?.severity, "problem");
    assert.ok(projectNode.children[1]?.children.some((c) => c.label.startsWith("Vulnerability: no-known-advisories")));
    assert.ok(projectNode.children[0]?.children.some((c) => c.label === "Vulnerability: vulnerable"));
  });
});

describe("analyze command gating", () => {
  it("is blocked in restricted mode and never walks files", async () => {
    let walked = false;
    const outcome = await analyzeDependencies({
      isTrusted: () => false,
      findFiles: () => {
        walked = true;
        return Promise.resolve([]);
      },
      createClients: () => {
        throw new Error("must not create clients");
      },
      ui: {
        confirm: () => Promise.resolve(true),
        runWithProgress: () => Promise.reject(new Error("must not run")),
        showInfo: () => undefined,
        showWarning: () => undefined,
        showError: () => undefined
      },
      log: { info: () => undefined, warn: () => undefined, error: () => undefined },
      now: () => NOW,
      onResult: () => undefined
    });
    assert.equal(outcome, "blocked");
    assert.equal(walked, false);
  });
});
