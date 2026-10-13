import { compareVersions, isStableFor } from "../analysis/assess";
import type { Ecosystem, RegistryPackage } from "../analysis/types";

/** How many of the newest candidates are checked against OSV before giving up. */
export const MAX_TARGET_CANDIDATES = 5;

/**
 * Stable versions newer than `current`, newest first, excluding npm-deprecated versions and
 * PyPI-yanked versions. Pre-releases are never candidates.
 */
export function newerStableCandidates(
  ecosystem: Ecosystem,
  current: string,
  registry: RegistryPackage
): string[] {
  const excluded = new Set<string>([...Object.keys(registry.deprecated), ...registry.yanked]);
  const newer = registry.versions.filter((version) => {
    if (excluded.has(version) || !isStableFor(ecosystem, version)) {
      return false;
    }
    const order = compareVersions(ecosystem, version, current);
    return order !== undefined && order > 0;
  });
  const unique = [...new Set(newer)];
  unique.sort((a, b) => (compareVersions(ecosystem, b, a) ?? 0));
  return unique.slice(0, MAX_TARGET_CANDIDATES);
}

/**
 * Returns the first candidate (newest first) with no OSV advisories. Candidates missing from
 * `advisoryCounts` are treated as unknown and never selected.
 */
export function chooseCleanTarget(
  candidatesNewestFirst: readonly string[],
  advisoryCounts: ReadonlyMap<string, number>
): string | undefined {
  return candidatesNewestFirst.find((version) => advisoryCounts.get(version) === 0);
}
