import type { Lookup, RegistryPackage } from "../analysis/types";
import { isPep440Stable, parsePep440, comparePep440 } from "../analysis/versions";
import { httpText, type FetchLike } from "./http";

export const PYPI_ORIGIN = "https://pypi.org";
const PYPI_NAME_PATTERN = /^[A-Za-z0-9](?:[A-Za-z0-9._-]*[A-Za-z0-9])?$/;

export interface PypiLookupOptions {
  readonly fetchImpl: FetchLike;
  readonly signal: AbortSignal;
  readonly timeoutMs: number;
  readonly maxBytes: number;
  readonly now: () => Date;
}

/** PEP 503 normalization: lowercase, with runs of "-", "_", "." collapsed to "-". */
export function normalizePypiName(name: string): string {
  return name.toLowerCase().replace(/[-_.]+/g, "-");
}

export async function lookupPypiPackage(name: string, options: PypiLookupOptions): Promise<Lookup<RegistryPackage>> {
  if (!PYPI_NAME_PATTERN.test(name)) {
    return { kind: "unavailable", reason: "invalid PyPI project name" };
  }
  const url = `${PYPI_ORIGIN}/pypi/${normalizePypiName(name)}/json`;
  const response = await httpText(url, {
    fetchImpl: options.fetchImpl,
    timeoutMs: options.timeoutMs,
    maxBytes: options.maxBytes,
    signal: options.signal,
    accept: "application/json"
  });
  if (response.kind !== "found") {
    return response;
  }
  return parsePypiJson(response.value, url, options.now().toISOString());
}

/** Parses the PyPI project JSON API response. */
export function parsePypiJson(text: string, sourceUrl: string, retrievedAt: string): Lookup<RegistryPackage> {
  let json: unknown;
  try {
    json = JSON.parse(text) as unknown;
  } catch {
    return { kind: "unavailable", reason: "unexpected response format (invalid JSON)" };
  }
  if (!isRecord(json) || !isRecord(json.info) || !isRecord(json.releases)) {
    return { kind: "unavailable", reason: "unexpected response format (no info or releases)" };
  }
  const releases = json.releases;
  const versions = Object.keys(releases).filter((version) => parsePep440(version) !== undefined);
  const yanked: string[] = [];
  for (const version of versions) {
    const files: unknown = releases[version];
    if (Array.isArray(files) && files.length > 0 && files.every((file) => isRecord(file) && file.yanked === true)) {
      yanked.push(version);
    }
  }

  const infoVersion = typeof json.info.version === "string" ? json.info.version : undefined;
  return {
    kind: "found",
    value: {
      ecosystem: "pypi",
      name: typeof json.info.name === "string" ? json.info.name : sourceUrl,
      sourceUrl,
      retrievedAt,
      latestStable: chooseStable(infoVersion, versions),
      versions,
      deprecated: {},
      yanked
    }
  };
}

function chooseStable(infoVersion: string | undefined, versions: readonly string[]): string | undefined {
  if (infoVersion !== undefined) {
    const parsed = parsePep440(infoVersion);
    if (parsed !== undefined && isPep440Stable(parsed)) {
      return infoVersion;
    }
  }
  const stable = versions
    .map((version) => ({ version, parsed: parsePep440(version) }))
    .filter((entry): entry is { version: string; parsed: NonNullable<ReturnType<typeof parsePep440>> } =>
      entry.parsed !== undefined && isPep440Stable(entry.parsed)
    );
  stable.sort((a, b) => comparePep440(a.parsed, b.parsed));
  return stable[stable.length - 1]?.version;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
