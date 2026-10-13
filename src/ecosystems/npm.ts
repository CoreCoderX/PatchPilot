import * as semver from "semver";
import type { DeclaredKind, ManifestDependency, ParseIssue, ParsedProject } from "../analysis/types";
import { NPM_NAME_PATTERN } from "../registry/npm";

/** Lockfile versions this parser reads. Anything else is reported as unsupported. */
export const SUPPORTED_NPM_LOCK_VERSIONS = [1, 2, 3] as const;

export interface NpmSources {
  readonly manifest: { readonly path: string; readonly text: string };
  readonly lockfile?: { readonly path: string; readonly text: string } | undefined;
}

const SECTIONS = [
  { key: "dependencies", scope: "runtime" },
  { key: "devDependencies", scope: "development" },
  { key: "optionalDependencies", scope: "optional" },
  { key: "peerDependencies", scope: "peer" }
] as const;

export function parseNpmProject(sources: NpmSources): ParsedProject {
  const issues: ParseIssue[] = [];
  const manifestPath = sources.manifest.path;
  const manifest = parseJsonObject(sources.manifest.text);
  if (manifest === undefined) {
    issues.push({ file: manifestPath, kind: "malformed", message: "package.json is not a valid JSON object." });
    return { ecosystem: "npm", manifest: manifestPath, format: "package.json", dependencies: [], issues };
  }

  const lock = readLock(sources.lockfile, issues);
  const lockedVersions = lock?.versions ?? new Map<string, string>();
  const lockfilePath = sources.lockfile?.path;
  const dependencies: ManifestDependency[] = [];

  for (const section of SECTIONS) {
    const block: unknown = manifest[section.key];
    if (block === undefined) {
      continue;
    }
    if (typeof block !== "object" || block === null || Array.isArray(block)) {
      issues.push({ file: manifestPath, kind: "malformed", message: `"${section.key}" is not an object; skipped.` });
      continue;
    }
    for (const [name, rawSpec] of Object.entries(block)) {
      if (!NPM_NAME_PATTERN.test(name)) {
        issues.push({ file: manifestPath, kind: "skipped-entry", message: `Invalid package name "${name}" in ${section.key}; skipped.` });
        continue;
      }
      if (typeof rawSpec !== "string") {
        issues.push({ file: manifestPath, kind: "skipped-entry", message: `Non-string version for "${name}" in ${section.key}; skipped.` });
        continue;
      }
      const classified = classifyNpmSpec(rawSpec);
      dependencies.push({
        ecosystem: "npm",
        name,
        declaredSpec: rawSpec,
        declaredKind: classified.kind,
        exactVersion: classified.exactVersion,
        scope: section.scope,
        manifest: manifestPath,
        lockedVersion: lockedVersions.get(name),
        lockfile: lockedVersions.has(name) ? lockfilePath : undefined,
        note: classified.note
      });
    }
  }

  const formatParts = ["package.json"];
  if (lock !== undefined) {
    formatParts.push(`package-lock.json (lockfileVersion ${String(lock.version)})`);
  }
  return {
    ecosystem: "npm",
    manifest: manifestPath,
    format: formatParts.join(" + "),
    dependencies,
    issues
  };
}

interface ReadLock {
  readonly version: number;
  readonly versions: Map<string, string>;
}

function readLock(lockfile: NpmSources["lockfile"], issues: ParseIssue[]): ReadLock | undefined {
  if (lockfile === undefined) {
    return undefined;
  }
  const json = parseJsonObject(lockfile.text);
  if (json === undefined) {
    issues.push({ file: lockfile.path, kind: "malformed", message: "package-lock.json is not valid JSON; lockfile versions ignored." });
    return undefined;
  }
  const version = typeof json.lockfileVersion === "number" ? json.lockfileVersion : undefined;
  if (version === undefined || !(SUPPORTED_NPM_LOCK_VERSIONS as readonly number[]).includes(version)) {
    issues.push({
      file: lockfile.path,
      kind: "unsupported",
      message: `package-lock.json lockfileVersion ${String(version ?? "unknown")} is not supported; lockfile versions ignored.`
    });
    return undefined;
  }
  const versions = new Map<string, string>();
  if (version === 1) {
    const deps = json.dependencies;
    if (isRecord(deps)) {
      for (const [name, entry] of Object.entries(deps)) {
        if (isRecord(entry) && typeof entry.version === "string") {
          versions.set(name, entry.version);
        }
      }
    }
  } else {
    const packages = json.packages;
    if (isRecord(packages)) {
      for (const [key, entry] of Object.entries(packages)) {
        // Only top-level installs ("node_modules/<name>") are direct-dependency versions.
        const match = /^node_modules\/((?:@[^/]+\/)?[^/]+)$/.exec(key);
        if (match?.[1] !== undefined && isRecord(entry) && typeof entry.version === "string") {
          versions.set(match[1], entry.version);
        }
      }
    }
  }
  return { version, versions };
}

interface ClassifiedSpec {
  readonly kind: DeclaredKind;
  readonly exactVersion: string | undefined;
  readonly note: string | undefined;
}

export function classifyNpmSpec(raw: string): ClassifiedSpec {
  const spec = raw.trim();
  if (spec === "" || spec === "*") {
    return { kind: "unpinned", exactVersion: undefined, note: undefined };
  }
  const exact = semver.valid(spec);
  if (exact !== null) {
    return { kind: "exact", exactVersion: exact, note: undefined };
  }
  if (semver.validRange(spec) !== null) {
    return { kind: "range", exactVersion: undefined, note: undefined };
  }
  return {
    kind: "unresolved",
    exactVersion: undefined,
    note: "Non-registry or tag specifier (URL, git, file, workspace, alias, or dist-tag); not checked against the registry."
  };
}

function parseJsonObject(text: string): Record<string, unknown> | undefined {
  try {
    const value = JSON.parse(text) as unknown;
    return isRecord(value) ? value : undefined;
  } catch {
    return undefined;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
