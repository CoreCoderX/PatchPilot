import * as semver from "semver";
import type { Lookup, RegistryPackage } from "../analysis/types";
import { httpText, type FetchLike } from "./http";

export const NPM_REGISTRY_ORIGIN = "https://registry.npmjs.org";
/** Abbreviated metadata. It includes dist-tags, versions, and per-version deprecation. */
const ABBREVIATED_ACCEPT = "application/vnd.npm.install-v1+json, application/json;q=0.8";

export const NPM_NAME_PATTERN = /^(?:@[a-z0-9][a-z0-9._~-]*\/)?[a-z0-9][a-z0-9._~-]*$/i;

export interface NpmLookupOptions {
  readonly fetchImpl: FetchLike;
  readonly signal: AbortSignal;
  readonly timeoutMs: number;
  readonly maxBytes: number;
  readonly now: () => Date;
}

export function npmPackageUrl(name: string): string {
  // Scoped names keep their scope marker encoded, as the registry expects.
  return `${NPM_REGISTRY_ORIGIN}/${name.replace("/", "%2F")}`;
}

export async function lookupNpmPackage(name: string, options: NpmLookupOptions): Promise<Lookup<RegistryPackage>> {
  if (!NPM_NAME_PATTERN.test(name)) {
    return { kind: "unavailable", reason: "invalid npm package name" };
  }
  const url = npmPackageUrl(name);
  const response = await httpText(url, {
    fetchImpl: options.fetchImpl,
    timeoutMs: options.timeoutMs,
    maxBytes: options.maxBytes,
    signal: options.signal,
    accept: ABBREVIATED_ACCEPT
  });
  if (response.kind !== "found") {
    return response;
  }
  return parseNpmPackument(response.value, url, options.now().toISOString());
}

/** Parses an npm packument (abbreviated or full). Returns "unavailable" on schema mismatch. */
export function parseNpmPackument(text: string, sourceUrl: string, retrievedAt: string): Lookup<RegistryPackage> {
  let json: unknown;
  try {
    json = JSON.parse(text) as unknown;
  } catch {
    return { kind: "unavailable", reason: "unexpected response format (invalid JSON)" };
  }
  if (!isRecord(json) || !isRecord(json.versions)) {
    return { kind: "unavailable", reason: "unexpected response format (no versions map)" };
  }
  const versionEntries = json.versions;
  const versions = Object.keys(versionEntries).filter((version) => semver.valid(version) !== null);
  const deprecated: Record<string, string> = {};
  for (const version of versions) {
    const entry: unknown = versionEntries[version];
    if (isRecord(entry) && typeof entry.deprecated === "string" && entry.deprecated.length > 0) {
      deprecated[version] = entry.deprecated;
    }
  }

  const rawTags: unknown = json["dist-tags"];
  const distTags: Record<string, unknown> = isRecord(rawTags) ? rawTags : {};
  return {
    kind: "found",
    value: {
      ecosystem: "npm",
      name: typeof json.name === "string" ? json.name : sourceUrl.split("/").pop() ?? "",
      sourceUrl,
      retrievedAt,
      latestStable: chooseLatestStable(distTags.latest, versions),
      versions,
      deprecated,
      yanked: []
    }
  };
}

function chooseLatestStable(tagged: unknown, versions: readonly string[]): string | undefined {
  if (typeof tagged === "string" && semver.valid(tagged) !== null && semver.prerelease(tagged) === null) {
    return semver.valid(tagged) ?? undefined;
  }
  const stable = versions.filter((version) => semver.prerelease(version) === null);
  stable.sort((a, b) => semver.rcompare(a, b));
  return stable[0];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
