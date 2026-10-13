import type { AnalysisResult, DependencyAssessment, Lookup, ManifestDependency, ParsedProject, ProjectAnalysis, RegistryPackage, SourceStatus } from "./types";
import { assessDependency, queriedVersionFor, type AdvisoryOutcome } from "./assess";
import { detectManifests, type ManifestCandidate } from "./detect";
import { parseNpmProject } from "../ecosystems/npm";
import { parseMavenProject } from "../ecosystems/maven";
import { parsePypiProject } from "../ecosystems/pypi";
import { normalizePypiName } from "../registry/pypi";
import { advisoryUrl, OSV_BATCH_URL, OSV_MAX_QUERIES_PER_REQUEST, type OsvAdvisoryDetail, type OsvQuery } from "../advisories/osv";

/** A file visible to analysis. Reading happens only for files selected as manifests or lockfiles. */
export interface WorkspaceFile {
  readonly path: string;
  readonly size: number;
  read(): Promise<string>;
}

/** Network boundary. Each function returns a Lookup and never throws. */
export interface AnalysisClients {
  lookupRegistry(ecosystem: ManifestDependency["ecosystem"], name: string, signal: AbortSignal): Promise<Lookup<RegistryPackage>>;
  queryOsv(queries: readonly OsvQuery[], signal: AbortSignal): Promise<Lookup<(readonly string[])[]>>;
  fetchAdvisory(id: string, signal: AbortSignal): Promise<Lookup<OsvAdvisoryDetail>>;
}

export interface AnalysisLimits {
  readonly maxFileBytes: number;
  readonly maxManifests: number;
  readonly maxRegistryLookups: number;
  readonly maxAdvisoryDetails: number;
  readonly concurrency: number;
}

export const DEFAULT_LIMITS: AnalysisLimits = {
  maxFileBytes: 1_000_000,
  maxManifests: 50,
  maxRegistryLookups: 300,
  maxAdvisoryDetails: 200,
  concurrency: 4
};

/** What will leave the machine, computed from local parsing before any network call. */
export interface NetworkPlan {
  readonly registryPackages: Readonly<Record<ManifestDependency["ecosystem"], number>>;
  readonly osvQueries: number;
  readonly manifests: readonly string[];
  readonly unsupportedFiles: number;
}

export interface AnalysisOptions {
  readonly files: readonly WorkspaceFile[];
  readonly clients: AnalysisClients;
  readonly signal: AbortSignal;
  readonly now: () => Date;
  readonly limits?: Partial<AnalysisLimits>;
  /** Called once, after local parsing and before any network request. Returning false stops the run. */
  readonly confirmNetwork?: (plan: NetworkPlan) => Promise<boolean>;
}

/** Runs the read-only analysis: discover, parse, look up registries, query OSV, then assess. */
export async function runAnalysis(options: AnalysisOptions): Promise<AnalysisResult | "declined"> {
  const limits: AnalysisLimits = { ...DEFAULT_LIMITS, ...options.limits };
  const startedAt = options.now().toISOString();
  const limitsReached: string[] = [];
  const byPath = new Map(options.files.map((file) => [file.path, file] as const));

  const detection = detectManifests(
    options.files.map((file) => file.path),
    limits.maxManifests
  );
  limitsReached.push(...detection.limitsReached);
  if (detection.excludedCount > 0) {
    limitsReached.push(`${String(detection.excludedCount)} file(s) in dependency or build directories were excluded.`);
  }

  // Phase A: parse manifests (local only).
  const projects: { candidate: ManifestCandidate; project: ParsedProject }[] = [];
  for (const candidate of detection.manifests) {
    projects.push({ candidate, project: await parseCandidate(candidate, byPath, limits.maxFileBytes) });
  }

  const targets = collectTargets(projects.map((p) => p.project));
  const registryKeys = targets.registryKeys;
  const osvQueries = targets.osvQueries;
  if (options.confirmNetwork !== undefined) {
    const plan: NetworkPlan = {
      registryPackages: {
        npm: countEcosystem(registryKeys, "npm"),
        maven: countEcosystem(registryKeys, "maven"),
        pypi: countEcosystem(registryKeys, "pypi")
      },
      osvQueries: osvQueries.size,
      manifests: projects.map((p) => p.project.manifest),
      unsupportedFiles: detection.unsupportedFiles.length
    };
    const approved = await options.confirmNetwork(plan);
    if (!approved || options.signal.aborted) {
      return "declined";
    }
  }

  // Phase B: registry lookups for unique packages (bounded and cancellable).
  const keyList = [...registryKeys.keys()];
  if (keyList.length > limits.maxRegistryLookups) {
    limitsReached.push(`Registry lookups limited to ${String(limits.maxRegistryLookups)} of ${String(keyList.length)} packages.`);
  }
  const registryTargets = keyList.slice(0, limits.maxRegistryLookups);
  const registryResults = new Map<string, Lookup<RegistryPackage>>();
  await mapWithConcurrency(registryTargets, limits.concurrency, options.signal, async (key) => {
    const target = registryKeys.get(key);
    if (target === undefined) {
      return;
    }
    const lookup = await options.clients.lookupRegistry(target.ecosystem, target.name, options.signal);
    registryResults.set(key, lookup);
  });

  // Phase C: OSV batch queries for every dependency with a lockfile or exact version.
  const osvList = [...osvQueries.entries()];
  const osvOutcomes = new Map<string, AdvisoryOutcome>();
  const osvRetrievedAt = options.now().toISOString();
  let osvSuccesses = 0;
  let osvFailures = 0;
  let osvFailureReason: string | undefined;

  for (let offset = 0; offset < osvList.length; offset += OSV_MAX_QUERIES_PER_REQUEST) {
    if (options.signal.aborted) {
      break;
    }
    const chunk = osvList.slice(offset, offset + OSV_MAX_QUERIES_PER_REQUEST);
    const response = await options.clients.queryOsv(
      chunk.map(([, query]) => query),
      options.signal
    );
    chunk.forEach(([key], position) => {
      if (response.kind === "found") {
        const ids = response.value[position] ?? [];
        osvOutcomes.set(key, { kind: "checked", advisories: ids.map((id) => ({ id, url: advisoryUrl(id), summary: undefined })) });
        osvSuccesses += 1;
      } else {
        osvOutcomes.set(key, { kind: "unavailable", reason: response.kind === "unavailable" ? response.reason : "not found" });
        osvFailures += 1;
        osvFailureReason = response.kind === "unavailable" ? response.reason : "not found";
      }
    });
  }
  for (const [key] of osvList) {
    if (!osvOutcomes.has(key)) {
      osvOutcomes.set(key, { kind: "not-queried", reason: "Analysis was cancelled before OSV was queried." });
    }
  }

  // Phase D: fetch advisory summaries for unique IDs (bounded).
  const uniqueIds = [...new Set([...osvOutcomes.values()].flatMap((outcome) => (outcome.kind === "checked" ? outcome.advisories.map((a) => a.id) : [])))];
  if (uniqueIds.length > limits.maxAdvisoryDetails) {
    limitsReached.push(`Advisory summaries limited to ${String(limits.maxAdvisoryDetails)} of ${String(uniqueIds.length)} IDs.`);
  }
  const detailTargets = uniqueIds.slice(0, limits.maxAdvisoryDetails);
  const summaries = new Map<string, string | undefined>();
  let detailFailures = 0;
  await mapWithConcurrency(detailTargets, limits.concurrency, options.signal, async (id) => {
    const detail = await options.clients.fetchAdvisory(id, options.signal);
    if (detail.kind === "found") {
      summaries.set(id, detail.value.summary);
    } else {
      detailFailures += 1;
    }
  });
  for (const [key, outcome] of osvOutcomes) {
    if (outcome.kind === "checked") {
      osvOutcomes.set(key, {
        kind: "checked",
        advisories: outcome.advisories.map((advisory) => ({ ...advisory, summary: summaries.get(advisory.id) }))
      });
    }
  }

  // Phase E: assess each dependency.
  const projectAnalyses: ProjectAnalysis[] = [];
  let counter = 0;
  for (const { candidate, project } of projects) {
    const assessments: DependencyAssessment[] = project.dependencies.map((dep) => {
      counter += 1;
      const registry = dep.declaredKind === "unresolved" ? undefined : registryResults.get(registryKey(dep.ecosystem, dep.name));
      const queried = queriedVersionFor(dep);
      const osvName = dep.ecosystem === "pypi" ? normalizePypiName(dep.name) : dep.name;
      const advisories: AdvisoryOutcome =
        queried === undefined
          ? { kind: "not-queried", reason: "No lockfile version or exact pin; a range alone is not checked against OSV." }
          : (osvOutcomes.get(`${dep.ecosystem}\u0000${osvName}\u0000${queried.version}`) ?? {
              kind: "not-queried",
              reason: "Not queried: analysis was cancelled or limited."
            });
      return assessDependency({
        id: `${candidate.path}#${String(counter)}`,
        dependency: dep,
        registry,
        advisories,
        osvRetrievedAt: osvList.length > 0 ? osvRetrievedAt : undefined,
        osvSourceUrl: OSV_BATCH_URL
      });
    });
    projectAnalyses.push({ project, assessments });
  }

  const sourceStatus = buildSourceStatus(registryResults, {
    osvSuccesses,
    osvFailures,
    osvFailureReason,
    detailFailures,
    detailCount: detailTargets.length
  });

  const registryEvidence = [...registryKeys.entries()].flatMap(([key, target]) => {
    const lookup = registryResults.get(key);
    return lookup === undefined ? [] : [{ ecosystem: target.ecosystem, name: target.name, lookup }];
  });
  return {
    startedAt,
    registry: registryEvidence,
    finishedAt: options.now().toISOString(),
    projects: projectAnalyses,
    unsupportedFiles: [...detection.unsupportedFiles],
    sourceStatus,
    limitsReached,
    cancelled: options.signal.aborted
  };
}

/** Unique registry lookups and OSV queries implied by the parsed projects. Pure. */
export function collectTargets(projects: readonly ParsedProject[]): {
  readonly registryKeys: Map<string, { ecosystem: ManifestDependency["ecosystem"]; name: string }>;
  readonly osvQueries: Map<string, OsvQuery>;
} {
  const registryKeys = new Map<string, { ecosystem: ManifestDependency["ecosystem"]; name: string }>();
  const osvQueries = new Map<string, OsvQuery>();
  for (const project of projects) {
    for (const dep of project.dependencies) {
      if (dep.declaredKind !== "unresolved") {
        registryKeys.set(registryKey(dep.ecosystem, dep.name), { ecosystem: dep.ecosystem, name: dep.name });
      }
      const queried = queriedVersionFor(dep);
      if (queried !== undefined) {
        const name = dep.ecosystem === "pypi" ? normalizePypiName(dep.name) : dep.name;
        osvQueries.set(`${dep.ecosystem}\u0000${name}\u0000${queried.version}`, { ecosystem: dep.ecosystem, name, version: queried.version });
      }
    }
  }
  return { registryKeys, osvQueries };
}

function countEcosystem(keys: ReadonlyMap<string, unknown>, ecosystem: ManifestDependency["ecosystem"]): number {
  return [...keys.keys()].filter((key) => key.startsWith(`${ecosystem}\u0000`)).length;
}

export function registryKey(ecosystem: ManifestDependency["ecosystem"], name: string): string {
  return `${ecosystem}\u0000${ecosystem === "pypi" ? normalizePypiName(name) : name}`;
}

async function parseCandidate(
  candidate: ManifestCandidate,
  files: ReadonlyMap<string, WorkspaceFile>,
  maxBytes: number
): Promise<ParsedProject> {
  const empty = (message: string): ParsedProject => ({
    ecosystem: candidate.ecosystem,
    manifest: candidate.path,
    format: candidate.kind,
    dependencies: [],
    issues: [{ file: candidate.path, kind: "malformed", message }]
  });
  const file = files.get(candidate.path);
  if (file === undefined) {
    return empty("File is no longer available.");
  }
  if (file.size > maxBytes) {
    return empty(`File exceeds ${String(Math.round(maxBytes / 1000))} KB; skipped.`);
  }
  const text = await file.read();
  if (candidate.kind === "npm") {
    let lockfile: { path: string; text: string } | undefined;
    if (candidate.lockfile !== undefined) {
      const lockFile = files.get(candidate.lockfile);
      if (lockFile !== undefined && lockFile.size <= maxBytes) {
        lockfile = { path: candidate.lockfile, text: await lockFile.read() };
      }
    }
    return parseNpmProject({ manifest: { path: candidate.path, text }, lockfile });
  }
  if (candidate.kind === "maven") {
    return parseMavenProject({ manifest: { path: candidate.path, text } });
  }
  return parsePypiProject({
    manifest: { path: candidate.path, text },
    kind: candidate.kind === "pypi-requirements" ? "requirements" : "pyproject"
  });
}

function buildSourceStatus(
  registry: ReadonlyMap<string, Lookup<RegistryPackage>>,
  osv: { osvSuccesses: number; osvFailures: number; osvFailureReason: string | undefined; detailFailures: number; detailCount: number }
): SourceStatus[] {
  const statuses: SourceStatus[] = [];
  const registrySources: { source: SourceStatus["source"]; ecosystem: ManifestDependency["ecosystem"] }[] = [
    { source: "npm-registry", ecosystem: "npm" },
    { source: "maven-central", ecosystem: "maven" },
    { source: "pypi", ecosystem: "pypi" }
  ];
  for (const { source, ecosystem } of registrySources) {
    const results = [...registry.entries()].filter(([key]) => key.startsWith(`${ecosystem}\u0000`)).map(([, value]) => value);
    const successes = results.filter((r) => r.kind !== "unavailable").length;
    const failures = results.length - successes;
    const reasons = results.flatMap((r) => (r.kind === "unavailable" ? [r.reason] : []));
    statuses.push(
      summarize(source, results.length, successes, failures, reasons[0], "lookups")
    );
  }
  const osvAttempts = osv.osvSuccesses + osv.osvFailures;
  const osvStatus = summarize("osv", osvAttempts, osv.osvSuccesses, osv.osvFailures, osv.osvFailureReason, "dependency queries");
  if (osv.detailCount > 0 && osv.detailFailures > 0) {
    statuses.push({
      ...osvStatus,
      status: osvStatus.status === "ok" ? "partial" : osvStatus.status,
      detail: `${osvStatus.detail} ${String(osv.detailFailures)} of ${String(osv.detailCount)} advisory summaries failed (IDs shown without summaries).`
    });
  } else {
    statuses.push(osvStatus);
  }
  return statuses;
}

function summarize(
  source: SourceStatus["source"],
  attempts: number,
  successes: number,
  failures: number,
  firstReason: string | undefined,
  noun: string
): SourceStatus {
  if (attempts === 0) {
    return { source, status: "not-used", detail: `No ${noun} needed.`, successes: 0, failures: 0 };
  }
  if (failures === 0) {
    return { source, status: "ok", detail: `${String(successes)} of ${String(attempts)} ${noun} answered.`, successes, failures };
  }
  if (successes === 0) {
    return {
      source,
      status: "unavailable",
      detail: `All ${String(attempts)} ${noun} failed${firstReason === undefined ? "" : `: ${firstReason}`}.`,
      successes,
      failures
    };
  }
  return {
    source,
    status: "partial",
    detail: `${String(failures)} of ${String(attempts)} ${noun} failed${firstReason === undefined ? "" : `, for example: ${firstReason}`}.`,
    successes,
    failures
  };
}

async function mapWithConcurrency<T>(
  items: readonly T[],
  concurrency: number,
  signal: AbortSignal,
  worker: (item: T) => Promise<void>
): Promise<void> {
  let next = 0;
  const runners = Array.from({ length: Math.min(concurrency, items.length) }, async () => {
    while (next < items.length && !signal.aborted) {
      const item = items[next];
      next += 1;
      if (item !== undefined) {
        await worker(item);
      }
    }
  });
  await Promise.all(runners);
}
