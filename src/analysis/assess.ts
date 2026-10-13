import * as semver from "semver";
import type {
  Advisory,
  DependencyAssessment,
  Evidence,
  Lookup,
  ManifestDependency,
  RegistryPackage
} from "./types";
import { comparePep440, compareMaven, isMavenStable, parsePep440, satisfiesPep440 } from "./versions";

/** Outcome of the OSV check for one dependency. */
export type AdvisoryOutcome =
  | { readonly kind: "checked"; readonly advisories: readonly Advisory[] }
  | { readonly kind: "unavailable"; readonly reason: string }
  | { readonly kind: "not-queried"; readonly reason: string };

export interface QueriedVersion {
  readonly version: string;
  readonly source: "lockfile" | "exact-pin";
}

export interface AssessmentInput {
  readonly id: string;
  readonly dependency: ManifestDependency;
  /** Registry lookup outcome. Undefined when no lookup was attempted (for example, unresolved specifiers). */
  readonly registry: Lookup<RegistryPackage> | undefined;
  readonly advisories: AdvisoryOutcome;
  readonly osvRetrievedAt: string | undefined;
  readonly osvSourceUrl: string;
}

/**
 * The single version used for vulnerability and deprecation checks: the lockfile version when present,
 * otherwise the exact pin written in the manifest. Range-only declarations return undefined.
 */
export function queriedVersionFor(dependency: ManifestDependency): QueriedVersion | undefined {
  if (dependency.lockedVersion !== undefined) {
    return { version: dependency.lockedVersion, source: "lockfile" };
  }
  if (dependency.declaredKind === "exact" && dependency.exactVersion !== undefined) {
    return { version: dependency.exactVersion, source: "exact-pin" };
  }
  return undefined;
}

export function assessDependency(input: AssessmentInput): DependencyAssessment {
  const { dependency } = input;
  const queried = queriedVersionFor(dependency);
  const registry = input.registry;
  const registryUrl = registry?.kind === "found" ? registry.value.sourceUrl : undefined;
  const retrievedAt = registry?.kind === "found" ? registry.value.retrievedAt : undefined;
  const evidence: Evidence[] = [
    {
      source: "manifest",
      url: undefined,
      detail: `Declared "${dependency.declaredSpec === "" ? "(no version)" : dependency.declaredSpec}" in ${dependency.manifest}`,
      retrievedAt: undefined
    }
  ];
  if (dependency.lockedVersion !== undefined) {
    evidence.push({
      source: "lockfile",
      url: undefined,
      detail: `Locked at ${dependency.lockedVersion} in ${dependency.lockfile ?? "lockfile"}`,
      retrievedAt: undefined
    });
  }

  const vulnerability = assessVulnerability(queried, input.advisories);
  if (input.advisories.kind === "checked" && queried !== undefined) {
    evidence.push({
      source: "osv",
      url: input.osvSourceUrl,
      detail: `Checked ${queried.version} against OSV: ${String(input.advisories.advisories.length)} advisor${input.advisories.advisories.length === 1 ? "y" : "ies"}`,
      retrievedAt: input.osvRetrievedAt
    });
  }

  const freshness = assessFreshness(dependency, queried, registry);
  const deprecation = assessDeprecation(dependency, queried, registry);
  if (registry?.kind === "found" && queried !== undefined && registry.value.yanked.includes(queried.version)) {
    evidence.push({
      source: "pypi",
      url: registry.value.sourceUrl,
      detail: `${queried.version} is marked yanked on PyPI (a yank is a publisher warning, not a deprecation).`,
      retrievedAt
    });
  }
  if (registry?.kind === "found" && registryUrl !== undefined) {
    evidence.push({
      source: sourceFor(dependency),
      url: registryUrl,
      detail: `Registry metadata: latest stable ${registry.value.latestStable ?? "not determined"}`,
      retrievedAt
    });
  }

  return {
    id: input.id,
    dependency,
    queriedVersion: queried?.version,
    queriedVersionSource: queried?.source,
    vulnerability,
    freshness,
    deprecation,
    compatibility: { status: "unknown", reason: "Compatibility checks are not part of this phase." },
    evidence
  };
}

function assessVulnerability(
  queried: QueriedVersion | undefined,
  outcome: AdvisoryOutcome
): DependencyAssessment["vulnerability"] {
  if (queried === undefined) {
    return {
      status: "unknown",
      advisories: [],
      reason: "No lockfile version or exact pin; a range alone is not checked against OSV."
    };
  }
  if (outcome.kind === "not-queried") {
    return { status: "unknown", advisories: [], reason: outcome.reason };
  }
  if (outcome.kind === "unavailable") {
    return { status: "unknown", advisories: [], reason: `OSV unavailable: ${outcome.reason}` };
  }
  if (outcome.advisories.length > 0) {
    return {
      status: "vulnerable",
      advisories: outcome.advisories,
      reason: `${String(outcome.advisories.length)} OSV advisor${outcome.advisories.length === 1 ? "y" : "ies"} for ${queried.version}.`
    };
  }
  return {
    status: "no-known-advisories",
    advisories: [],
    reason: `No OSV advisories for ${queried.version}. This is not a guarantee of safety.`
  };
}

function assessFreshness(
  dependency: ManifestDependency,
  queried: QueriedVersion | undefined,
  registry: Lookup<RegistryPackage> | undefined
): DependencyAssessment["freshness"] {
  const unknown = (reason: string): DependencyAssessment["freshness"] => ({ status: "unknown", latestStable: undefined, reason });
  if (dependency.declaredKind === "unresolved") {
    return unknown("Specifier is not a registry version; freshness not checked.");
  }
  if (registry === undefined) {
    return unknown("Registry not queried.");
  }
  if (registry.kind === "unavailable") {
    return unknown(`Registry unavailable: ${registry.reason}`);
  }
  if (registry.kind === "not-found") {
    return unknown("Package not found in the registry.");
  }
  const latest = registry.value.latestStable;
  if (latest === undefined) {
    return unknown("Registry reports no stable version.");
  }

  if (queried !== undefined) {
    const order = compareVersions(dependency.ecosystem, queried.version, latest);
    if (order === undefined) {
      return unknown(`Version ${queried.version} could not be compared with ${latest}.`);
    }
    if (order === 0) {
      return { status: "current", latestStable: latest, reason: `${queried.version} is the latest stable version.` };
    }
    if (order < 0) {
      return { status: "outdated", latestStable: latest, reason: `${queried.version} is older than latest stable ${latest}.` };
    }
    return { status: "current", latestStable: latest, reason: `${queried.version} is newer than the latest stable ${latest} (pre-release or unpublished).` };
  }

  if (dependency.declaredKind === "unpinned") {
    return { status: "range-satisfied", latestStable: latest, reason: `No version constraint; ${latest} would be selected.` };
  }
  if (dependency.ecosystem === "maven") {
    return unknown("Maven version ranges are not evaluated in this phase.");
  }
  const admitted = admitsLatest(dependency, latest);
  if (admitted === undefined) {
    return unknown("Version constraint could not be evaluated.");
  }
  return admitted
    ? { status: "range-satisfied", latestStable: latest, reason: `The range admits latest stable ${latest}.` }
    : { status: "range-excludes-latest", latestStable: latest, reason: `The range does not admit latest stable ${latest}.` };
}

function assessDeprecation(
  dependency: ManifestDependency,
  queried: QueriedVersion | undefined,
  registry: Lookup<RegistryPackage> | undefined
): DependencyAssessment["deprecation"] {
  if (dependency.ecosystem !== "npm") {
    return {
      status: "unknown",
      message: undefined,
      reason: "This registry does not expose deprecation metadata to this phase."
    };
  }
  if (queried === undefined) {
    return { status: "unknown", message: undefined, reason: "No lockfile version or exact pin to check." };
  }
  if (registry?.kind !== "found") {
    return {
      status: "unknown",
      message: undefined,
      reason: registry?.kind === "unavailable" ? `Registry unavailable: ${registry.reason}` : "Registry not queried or package not found."
    };
  }
  const deprecatedMap: Partial<Record<string, string>> = registry.value.deprecated;
  const message = Object.hasOwn(deprecatedMap, queried.version) ? deprecatedMap[queried.version] : undefined;
  if (message !== undefined) {
    return { status: "deprecated", message, reason: `${queried.version} is marked deprecated on the npm registry.` };
  }
  return { status: "not-deprecated", message: undefined, reason: `${queried.version} is not marked deprecated.` };
}

function sourceFor(dependency: ManifestDependency): Evidence["source"] {
  if (dependency.ecosystem === "npm") {
    return "npm-registry";
  }
  return dependency.ecosystem === "maven" ? "maven-central" : "pypi";
}

/** Returns a negative, zero, or positive comparison, or undefined when a version cannot be parsed. */
export function compareVersions(ecosystem: ManifestDependency["ecosystem"], a: string, b: string): number | undefined {
  switch (ecosystem) {
    case "npm":
      return semver.valid(a) === null || semver.valid(b) === null ? undefined : semver.compare(a, b);
    case "maven":
      return compareMaven(a, b);
    case "pypi": {
      const pa = parsePep440(a);
      const pb = parsePep440(b);
      return pa === undefined || pb === undefined ? undefined : comparePep440(pa, pb);
    }
  }
}

function admitsLatest(dependency: ManifestDependency, latest: string): boolean | undefined {
  if (dependency.ecosystem === "npm") {
    return semver.satisfies(latest, dependency.declaredSpec, { includePrerelease: false });
  }
  if (dependency.ecosystem === "pypi") {
    return satisfiesPep440(latest, dependency.declaredSpec);
  }
  return undefined;
}

/** Stable-only helper used by tests and registry code to keep Maven selection consistent. */
export function isStableFor(ecosystem: ManifestDependency["ecosystem"], version: string): boolean {
  if (ecosystem === "maven") {
    return isMavenStable(version);
  }
  if (ecosystem === "npm") {
    return semver.valid(version) !== null && semver.prerelease(version) === null;
  }
  const parsed = parsePep440(version);
  return parsed !== undefined && !parsed.pre && !parsed.dev;
}
