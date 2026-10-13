import type { Lookup, ManifestDependency, RegistryPackage } from "./types";
import { fetchOsvAdvisory, queryOsvBatch, type OsvAdvisoryDetail, type OsvQuery } from "../advisories/osv";
import { lookupMavenArtifact } from "../registry/maven";
import { lookupNpmPackage } from "../registry/npm";
import { lookupPypiPackage } from "../registry/pypi";
import type { FetchLike } from "../registry/http";
import type { AnalysisClients } from "./runner";

export interface LiveClientOptions {
  readonly fetchImpl: FetchLike;
  readonly timeoutMs: number;
  readonly now: () => Date;
}

const REGISTRY_MAX_BYTES = 25_000_000;
const OSV_MAX_BYTES = 5_000_000;

/** Network-backed clients. These are the only code paths that touch the network in Phase 3. */
export function createLiveClients(options: LiveClientOptions): AnalysisClients {
  const common = (signal: AbortSignal, maxBytes: number) => ({
    fetchImpl: options.fetchImpl,
    signal,
    timeoutMs: options.timeoutMs,
    maxBytes,
    now: options.now
  });
  return {
    lookupRegistry(ecosystem: ManifestDependency["ecosystem"], name: string, signal: AbortSignal): Promise<Lookup<RegistryPackage>> {
      switch (ecosystem) {
        case "npm":
          return lookupNpmPackage(name, common(signal, REGISTRY_MAX_BYTES));
        case "maven":
          return lookupMavenArtifact(name, common(signal, REGISTRY_MAX_BYTES));
        case "pypi":
          return lookupPypiPackage(name, common(signal, REGISTRY_MAX_BYTES));
      }
    },
    queryOsv(queries: readonly OsvQuery[], signal: AbortSignal): Promise<Lookup<(readonly string[])[]>> {
      return queryOsvBatch(queries, common(signal, OSV_MAX_BYTES));
    },
    fetchAdvisory(id: string, signal: AbortSignal): Promise<Lookup<OsvAdvisoryDetail>> {
      return fetchOsvAdvisory(id, common(signal, OSV_MAX_BYTES));
    }
  };
}
