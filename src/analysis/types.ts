/** Domain types for dependency analysis. Pure: no VS Code, no network. */

export type Ecosystem = "npm" | "maven" | "pypi";

export type DependencyScope = "runtime" | "development" | "optional" | "peer";

/**
 * How the manifest declares the version:
 * - exact: a single concrete version (for example "1.2.3", "==1.2.3", a literal Maven version).
 * - range: a constraint that admits several versions.
 * - unpinned: no constraint at all.
 * - managed: the version is inherited from a parent POM or BOM and not resolved here.
 * - unresolved: a non-registry source, unresolved property, or unparseable declaration.
 */
export type DeclaredKind = "exact" | "range" | "unpinned" | "managed" | "unresolved";

export interface ManifestDependency {
  readonly ecosystem: Ecosystem;
  /** npm: package name. Maven: "groupId:artifactId". PyPI: display name as declared. */
  readonly name: string;
  readonly declaredSpec: string;
  readonly declaredKind: DeclaredKind;
  /** Concrete version written in the manifest, when declaredKind is "exact". */
  readonly exactVersion: string | undefined;
  readonly scope: DependencyScope;
  /** Workspace-relative manifest path. */
  readonly manifest: string;
  /** Version recorded in a lockfile for this manifest, when one was parsed. */
  readonly lockedVersion: string | undefined;
  /** Workspace-relative lockfile path, when one was parsed. */
  readonly lockfile: string | undefined;
  /** Human-readable note: unresolved reason, environment marker, and similar. */
  readonly note: string | undefined;
}

export interface ParseIssue {
  readonly file: string;
  readonly kind: "unsupported" | "malformed" | "skipped-entry";
  readonly message: string;
}

export interface ParsedProject {
  readonly ecosystem: Ecosystem;
  readonly manifest: string;
  /** Format description for display, for example "package.json + package-lock.json (v3)". */
  readonly format: string;
  readonly dependencies: readonly ManifestDependency[];
  readonly issues: readonly ParseIssue[];
}

export interface UnsupportedFile {
  readonly file: string;
  readonly reason: string;
}

export interface RegistryPackage {
  readonly ecosystem: Ecosystem;
  readonly name: string;
  readonly sourceUrl: string;
  readonly retrievedAt: string;
  readonly latestStable: string | undefined;
  readonly versions: readonly string[];
  /** npm only: deprecation message keyed by version. */
  readonly deprecated: Readonly<Record<string, string>>;
  /** PyPI only: versions marked yanked. */
  readonly yanked: readonly string[];
}

/** Outcome of a single lookup. "not-found" and "unavailable" are kept distinct on purpose. */
export type Lookup<T> =
  | { readonly kind: "found"; readonly value: T }
  | { readonly kind: "not-found" }
  | { readonly kind: "unavailable"; readonly reason: string };

export interface Advisory {
  readonly id: string;
  readonly url: string;
  readonly summary: string | undefined;
}

export type VulnerabilityStatus = "vulnerable" | "no-known-advisories" | "unknown";
export type FreshnessStatus = "current" | "outdated" | "range-satisfied" | "range-excludes-latest" | "unknown";
export type DeprecationStatus = "deprecated" | "not-deprecated" | "unknown";

export interface Evidence {
  readonly source: "manifest" | "lockfile" | "npm-registry" | "maven-central" | "pypi" | "osv";
  readonly url: string | undefined;
  readonly detail: string;
  readonly retrievedAt: string | undefined;
}

export interface DependencyAssessment {
  readonly id: string;
  readonly dependency: ManifestDependency;
  /** Version used for the vulnerability and deprecation checks. Undefined when none is known. */
  readonly queriedVersion: string | undefined;
  readonly queriedVersionSource: "lockfile" | "exact-pin" | undefined;
  readonly vulnerability: {
    readonly status: VulnerabilityStatus;
    readonly advisories: readonly Advisory[];
    readonly reason: string;
  };
  readonly freshness: {
    readonly status: FreshnessStatus;
    readonly latestStable: string | undefined;
    readonly reason: string;
  };
  readonly deprecation: {
    readonly status: DeprecationStatus;
    readonly message: string | undefined;
    readonly reason: string;
  };
  /** Compatibility is checked separately and is "unknown" in this phase. */
  readonly compatibility: { readonly status: "unknown"; readonly reason: string };
  readonly evidence: readonly Evidence[];
}

export type IssueKind = "vulnerable" | "outdated" | "deprecated" | "unresolved";

export interface SourceStatus {
  readonly source: "osv" | "npm-registry" | "maven-central" | "pypi";
  readonly status: "ok" | "partial" | "unavailable" | "not-used";
  readonly detail: string;
  readonly successes: number;
  readonly failures: number;
}

export interface ProjectAnalysis {
  readonly project: ParsedProject;
  readonly assessments: readonly DependencyAssessment[];
}

/** Registry lookup outcome kept with the result, so planning can reuse verified metadata. */
export interface RegistryEvidence {
  readonly ecosystem: Ecosystem;
  readonly name: string;
  readonly lookup: Lookup<RegistryPackage>;
}

export interface AnalysisResult {
  readonly startedAt: string;
  readonly registry: readonly RegistryEvidence[];
  readonly finishedAt: string;
  readonly projects: readonly ProjectAnalysis[];
  readonly unsupportedFiles: readonly UnsupportedFile[];
  readonly sourceStatus: readonly SourceStatus[];
  readonly limitsReached: readonly string[];
  readonly cancelled: boolean;
}
