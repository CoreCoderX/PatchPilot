import { XMLParser, XMLValidator } from "fast-xml-parser";
import type { Lookup, RegistryPackage } from "../analysis/types";
import { compareMaven, isMavenStable } from "../analysis/versions";
import { httpText, type FetchLike } from "./http";

export const MAVEN_CENTRAL_ORIGIN = "https://repo1.maven.org/maven2";
const PART_PATTERN = /^[A-Za-z0-9_.-]+$/;

export interface MavenLookupOptions {
  readonly fetchImpl: FetchLike;
  readonly signal: AbortSignal;
  readonly timeoutMs: number;
  readonly maxBytes: number;
  readonly now: () => Date;
}

/** Maven Central metadata URL for "groupId:artifactId". Undefined when the coordinate is malformed. */
export function mavenMetadataUrl(coordinate: string): string | undefined {
  const parts = coordinate.split(":");
  if (parts.length !== 2) {
    return undefined;
  }
  const [group, artifact] = parts as [string | undefined, string | undefined];
  if (group === undefined || artifact === undefined || !PART_PATTERN.test(group) || !PART_PATTERN.test(artifact)) {
    return undefined;
  }
  return `${MAVEN_CENTRAL_ORIGIN}/${group.split(".").join("/")}/${artifact}/maven-metadata.xml`;
}

export async function lookupMavenArtifact(coordinate: string, options: MavenLookupOptions): Promise<Lookup<RegistryPackage>> {
  const url = mavenMetadataUrl(coordinate);
  if (url === undefined) {
    return { kind: "unavailable", reason: "invalid Maven coordinate" };
  }
  const response = await httpText(url, {
    fetchImpl: options.fetchImpl,
    timeoutMs: options.timeoutMs,
    maxBytes: options.maxBytes,
    signal: options.signal,
    accept: "application/xml, text/xml;q=0.9"
  });
  if (response.kind !== "found") {
    return response;
  }
  return parseMavenMetadata(coordinate, response.value, url, options.now().toISOString());
}

/** Parses maven-metadata.xml. Returns "unavailable" on malformed or unexpected content. */
export function parseMavenMetadata(
  coordinate: string,
  text: string,
  sourceUrl: string,
  retrievedAt: string
): Lookup<RegistryPackage> {
  // eslint-disable-next-line @typescript-eslint/no-deprecated -- bundled validator of fast-xml-parser 5; its replacement is a separate package not added in this phase.
  if (XMLValidator.validate(text) !== true) {
    return { kind: "unavailable", reason: "unexpected response format (malformed XML)" };
  }
  const parser = new XMLParser({
    ignoreAttributes: true,
    parseTagValue: false,
    trimValues: true,
    isArray: (name) => name === "version"
  });
  const doc: unknown = parser.parse(text);
  const metadata = childRecord(doc, "metadata");
  const versioning = metadata === undefined ? undefined : childRecord(metadata, "versioning");
  if (versioning === undefined) {
    return { kind: "unavailable", reason: "unexpected response format (no versioning element)" };
  }
  const versionsNode = childRecord(versioning, "versions");
  const rawVersions: unknown[] = versionsNode !== undefined && Array.isArray(versionsNode.version) ? versionsNode.version : [];
  const versions = rawVersions.filter((v): v is string => typeof v === "string" && v.length > 0);
  const release = textOf(versioning.release);
  const latest = textOf(versioning.latest);

  return {
    kind: "found",
    value: {
      ecosystem: "maven",
      name: coordinate,
      sourceUrl,
      retrievedAt,
      latestStable: chooseMavenStable(release, latest, versions),
      versions,
      deprecated: {},
      yanked: []
    }
  };
}

function chooseMavenStable(release: string | undefined, latest: string | undefined, versions: readonly string[]): string | undefined {
  if (release !== undefined && isMavenStable(release)) {
    return release;
  }
  const stable = versions.filter(isMavenStable);
  stable.sort(compareMaven);
  const top = stable.at(-1);
  if (top !== undefined) {
    return top;
  }
  return latest !== undefined && isMavenStable(latest) ? latest : undefined;
}

function childRecord(parent: unknown, name: string): Record<string, unknown> | undefined {
  if (typeof parent !== "object" || parent === null || !(name in parent)) {
    return undefined;
  }
  const value: unknown = (parent as Record<string, unknown>)[name];
  return typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined;
}

function textOf(value: unknown): string | undefined {
  if (typeof value === "string" && value.length > 0) {
    return value;
  }
  if (typeof value === "number") {
    return String(value);
  }
  return undefined;
}
