import type { DependencyAssessment, ManifestDependency, RegistryPackage } from "../../../analysis/types";

export const RETRIEVED = "2026-10-12T10:00:00.000Z";

export function dep(overrides: Partial<ManifestDependency> & Pick<ManifestDependency, "ecosystem" | "name" | "manifest">): ManifestDependency {
  return {
    declaredSpec: "1.0.0",
    declaredKind: "exact",
    exactVersion: "1.0.0",
    scope: "runtime",
    lockedVersion: undefined,
    lockfile: undefined,
    note: undefined,
    ...overrides
  };
}

export function registryPackage(overrides: Partial<RegistryPackage> & Pick<RegistryPackage, "ecosystem" | "name" | "versions">): RegistryPackage {
  return {
    sourceUrl: "https://registry.example.test/pkg",
    retrievedAt: RETRIEVED,
    latestStable: undefined,
    deprecated: {},
    yanked: [],
    ...overrides
  };
}

export function assessment(
  dependency: ManifestDependency,
  options: { vulnerable?: string[]; deprecated?: boolean; queried?: string; source?: "lockfile" | "exact-pin" }
): DependencyAssessment {
  const advisories = (options.vulnerable ?? []).map((id) => ({ id, url: `https://osv.example.test/${id}`, summary: undefined }));
  return {
    id: `${dependency.manifest}#${dependency.name}`,
    dependency,
    queriedVersion: options.queried ?? dependency.exactVersion,
    queriedVersionSource: options.source ?? "exact-pin",
    vulnerability: {
      status: advisories.length > 0 ? "vulnerable" : "no-known-advisories",
      advisories,
      reason: advisories.length > 0 ? "advisories" : "none"
    },
    freshness: { status: "current", latestStable: undefined, reason: "" },
    deprecation: {
      status: options.deprecated === true ? "deprecated" : "not-deprecated",
      message: options.deprecated === true ? "old" : undefined,
      reason: ""
    },
    compatibility: { status: "unknown", reason: "not checked" },
    evidence: []
  };
}
