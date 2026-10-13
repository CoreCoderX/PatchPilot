import type { Ecosystem, Lookup } from "../analysis/types";
import { httpText, type FetchLike } from "../registry/http";

export const OSV_API_ORIGIN = "https://api.osv.dev";
export const OSV_WEB_ORIGIN = "https://osv.dev";
export const OSV_BATCH_URL = `${OSV_API_ORIGIN}/v1/querybatch`;
export const OSV_MAX_QUERIES_PER_REQUEST = 100;
export const OSV_MAX_PAGES = 5;

/** OSV uses these ecosystem identifiers. */
export const OSV_ECOSYSTEM: Readonly<Record<Ecosystem, string>> = {
  npm: "npm",
  maven: "Maven",
  pypi: "PyPI"
};

const VULN_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$/;

export interface OsvQuery {
  readonly ecosystem: Ecosystem;
  /** npm name, Maven "group:artifact", or normalized PyPI name. */
  readonly name: string;
  readonly version: string;
}

export interface OsvClientOptions {
  readonly fetchImpl: FetchLike;
  readonly signal: AbortSignal;
  readonly timeoutMs: number;
  readonly maxBytes: number;
}

export interface OsvAdvisoryDetail {
  readonly summary: string | undefined;
}

/**
 * Queries OSV in batches. Returns one advisory-ID list per input query, in order.
 * Whole-batch failures return "unavailable" so the caller can mark those queries unknown.
 * Pagination follows next_page_token for each query, up to OSV_MAX_PAGES.
 */
export async function queryOsvBatch(
  queries: readonly OsvQuery[],
  options: OsvClientOptions
): Promise<Lookup<(readonly string[])[]>> {
  const results: string[][] = queries.map(() => []);
  let pending = queries.map((query, index) => ({ index, query, pageToken: undefined as string | undefined }));

  for (let page = 0; page < OSV_MAX_PAGES && pending.length > 0; page += 1) {
    const body = {
      queries: pending.map((entry) => {
        const item: Record<string, unknown> = {
          package: { name: entry.query.name, ecosystem: OSV_ECOSYSTEM[entry.query.ecosystem] },
          version: entry.query.version
        };
        if (entry.pageToken !== undefined) {
          item.page_token = entry.pageToken;
        }
        return item;
      })
    };
    const response = await httpText(OSV_BATCH_URL, {
      fetchImpl: options.fetchImpl,
      timeoutMs: options.timeoutMs,
      maxBytes: options.maxBytes,
      signal: options.signal,
      accept: "application/json",
      method: "POST",
      body: JSON.stringify(body)
    });
    if (response.kind !== "found") {
      return response.kind === "not-found" ? { kind: "unavailable", reason: "OSV endpoint not found" } : response;
    }
    const parsed = parseOsvBatchResponse(response.value, pending.length);
    if (parsed === undefined) {
      return { kind: "unavailable", reason: "unexpected OSV response format" };
    }
    const nextPending: typeof pending = [];
    parsed.forEach((result, position) => {
      const entry = pending.at(position);
      if (entry === undefined) {
        return;
      }
      results[entry.index]?.push(...result.ids);
      if (result.nextPageToken !== undefined) {
        nextPending.push({ index: entry.index, query: entry.query, pageToken: result.nextPageToken });
      }
    });
    pending = nextPending;
  }
  return { kind: "found", value: results.map((ids) => [...new Set(ids)]) };
}

export interface ParsedOsvResult {
  readonly ids: readonly string[];
  readonly nextPageToken: string | undefined;
}

/** Validates the querybatch response shape. Returns undefined when it does not match. */
export function parseOsvBatchResponse(text: string, expectedCount: number): ParsedOsvResult[] | undefined {
  let json: unknown;
  try {
    json = JSON.parse(text) as unknown;
  } catch {
    return undefined;
  }
  if (typeof json !== "object" || json === null || !("results" in json) || !Array.isArray(json.results)) {
    return undefined;
  }
  const results: unknown[] = json.results;
  if (results.length !== expectedCount) {
    return undefined;
  }
  const parsed: ParsedOsvResult[] = [];
  for (const entry of results) {
    if (typeof entry !== "object" || entry === null) {
      return undefined;
    }
    const vulns: unknown = "vulns" in entry ? entry.vulns : undefined;
    if (vulns !== undefined && !Array.isArray(vulns)) {
      return undefined;
    }
    const ids: string[] = [];
    const vulnList: unknown[] = Array.isArray(vulns) ? (vulns as unknown[]) : [];
    for (const vuln of vulnList) {
      if (typeof vuln === "object" && vuln !== null && "id" in vuln && typeof vuln.id === "string" && VULN_ID_PATTERN.test(vuln.id)) {
        ids.push(vuln.id);
      }
    }
    const token: unknown = "next_page_token" in entry ? entry.next_page_token : undefined;
    parsed.push({ ids, nextPageToken: typeof token === "string" && token.length > 0 ? token : undefined });
  }
  return parsed;
}

/** Fetches one advisory's summary. Failure is non-fatal: the caller keeps the ID without a summary. */
export async function fetchOsvAdvisory(id: string, options: OsvClientOptions): Promise<Lookup<OsvAdvisoryDetail>> {
  if (!VULN_ID_PATTERN.test(id)) {
    return { kind: "unavailable", reason: "invalid advisory ID" };
  }
  const response = await httpText(`${OSV_API_ORIGIN}/v1/vulns/${encodeURIComponent(id)}`, {
    fetchImpl: options.fetchImpl,
    timeoutMs: options.timeoutMs,
    maxBytes: options.maxBytes,
    signal: options.signal,
    accept: "application/json"
  });
  if (response.kind !== "found") {
    return response;
  }
  try {
    const json = JSON.parse(response.value) as unknown;
    const summary =
      typeof json === "object" && json !== null && "summary" in json && typeof json.summary === "string"
        ? json.summary
        : undefined;
    return { kind: "found", value: { summary } };
  } catch {
    return { kind: "unavailable", reason: "unexpected OSV advisory format" };
  }
}

export function advisoryUrl(id: string): string {
  return `${OSV_WEB_ORIGIN}/vulnerability/${encodeURIComponent(id)}`;
}
