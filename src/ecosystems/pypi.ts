import { parse as parseToml } from "smol-toml";
import type { DeclaredKind, DependencyScope, ManifestDependency, ParseIssue, ParsedProject } from "../analysis/types";
import { satisfiesPep440, parsePep440 } from "../analysis/versions";

/**
 * Supported Python manifest subset:
 * - requirements*.txt: one requirement per line. Supports comments, backslash continuations,
 *   --hash options, environment markers (recorded, not evaluated), and ==, ranges, and unpinned names.
 *   Not supported: -r/-c includes (reported, not followed), -e and VCS/URL requirements (reported
 *   as unresolved), and index-option lines (reported, ignored).
 * - pyproject.toml: PEP 621 [project].dependencies and [project.optional-dependencies].
 *   Not supported: Poetry tables, PEP 735 dependency-groups (reported).
 */

export interface PypiSources {
  readonly manifest: { readonly path: string; readonly text: string };
  readonly kind: "requirements" | "pyproject";
}

const NAME_PATTERN = /^[A-Za-z0-9](?:[A-Za-z0-9._-]*[A-Za-z0-9])?/;

export function parsePypiProject(sources: PypiSources): ParsedProject {
  return sources.kind === "requirements" ? parseRequirementsFile(sources.manifest.path, sources.manifest.text) : parsePyprojectFile(sources.manifest.path, sources.manifest.text);
}

export function parseRequirementsFile(path: string, text: string): ParsedProject {
  const issues: ParseIssue[] = [];
  const dependencies: ManifestDependency[] = [];
  for (const logical of joinContinuations(text)) {
    const line = stripComment(logical).replace(/\s--hash[=\s]\S+/g, "").trim();
    if (line === "") {
      continue;
    }
    if (line.startsWith("-")) {
      issues.push({ file: path, kind: "unsupported", message: describeOption(line) });
      continue;
    }
    if (line.includes("://")) {
      issues.push({ file: path, kind: "unsupported", message: `URL requirement "${line}" is not analyzed.` });
      continue;
    }
    const dependency = parseRequirementSpec(line, path, "runtime");
    if (dependency === undefined) {
      issues.push({ file: path, kind: "skipped-entry", message: `Could not parse requirement "${line}"; skipped.` });
      continue;
    }
    dependencies.push(dependency);
  }
  return { ecosystem: "pypi", manifest: path, format: "requirements.txt (pinned and range subset)", dependencies, issues };
}

export function parsePyprojectFile(path: string, text: string): ParsedProject {
  const issues: ParseIssue[] = [];
  const dependencies: ManifestDependency[] = [];
  let toml: Record<string, unknown>;
  try {
    toml = parseToml(text);
  } catch {
    issues.push({ file: path, kind: "malformed", message: "pyproject.toml is not valid TOML." });
    return { ecosystem: "pypi", manifest: path, format: "pyproject.toml", dependencies, issues };
  }

  const project = toml.project;
  if (!isRecord(project)) {
    issues.push({
      file: path,
      kind: "unsupported",
      message: "No [project] table (PEP 621). Only PEP 621 dependency tables are analyzed."
    });
  } else {
    readRequirementArray(path, project.dependencies, "runtime", dependencies, issues, "[project].dependencies");
    if (isRecord(project["optional-dependencies"])) {
      for (const [group, values] of Object.entries(project["optional-dependencies"])) {
        readRequirementArray(path, values, "optional", dependencies, issues, `[project.optional-dependencies].${group}`);
      }
    }
  }
  if (isRecord(toml.tool) && isRecord(toml.tool.poetry)) {
    issues.push({ file: path, kind: "unsupported", message: "Poetry [tool.poetry] dependency tables are not analyzed." });
  }
  if (toml["dependency-groups"] !== undefined) {
    issues.push({ file: path, kind: "unsupported", message: "[dependency-groups] (PEP 735) is not analyzed." });
  }

  return { ecosystem: "pypi", manifest: path, format: "pyproject.toml [project] (PEP 621)", dependencies, issues };
}

function readRequirementArray(
  path: string,
  value: unknown,
  scope: DependencyScope,
  out: ManifestDependency[],
  issues: ParseIssue[],
  label: string
): void {
  if (value === undefined) {
    return;
  }
  if (!Array.isArray(value)) {
    issues.push({ file: path, kind: "malformed", message: `${label} is not an array; skipped.` });
    return;
  }
  for (const entry of value) {
    if (typeof entry !== "string") {
      issues.push({ file: path, kind: "skipped-entry", message: `Non-string entry in ${label}; skipped.` });
      continue;
    }
    const dependency = parseRequirementSpec(entry, path, scope);
    if (dependency === undefined) {
      issues.push({ file: path, kind: "skipped-entry", message: `Could not parse "${entry}" in ${label}; skipped.` });
      continue;
    }
    out.push(dependency);
  }
}

/** Parses one PEP 508-style requirement. Returns undefined when no project name is present. */
export function parseRequirementSpec(raw: string, manifest: string, scope: DependencyScope): ManifestDependency | undefined {
  let body = raw.trim();
  let marker: string | undefined;
  const semi = body.indexOf(";");
  if (semi >= 0) {
    marker = body.slice(semi + 1).trim();
    body = body.slice(0, semi).trim();
  }
  const nameMatch = NAME_PATTERN.exec(body);
  if (nameMatch === null) {
    return undefined;
  }
  const name = nameMatch[0];
  let rest = body.slice(name.length).trim();
  if (rest.startsWith("[")) {
    const close = rest.indexOf("]");
    rest = close >= 0 ? rest.slice(close + 1).trim() : "";
  }
  const markerNote = marker === undefined || marker === "" ? undefined : `Environment marker not evaluated: ${marker}`;

  if (rest.startsWith("@")) {
    return build(name, rest, "unresolved", undefined, manifest, scope, "Direct URL reference; not checked against the index.");
  }
  if (rest === "") {
    return build(name, "", "unpinned", undefined, manifest, scope, markerNote);
  }
  const specifier = rest.replace(/\s+/g, "");
  const single = /^==([^*,]+)$/.exec(specifier);
  if (single?.[1] !== undefined && !single[1].endsWith(".*") && parsePep440(single[1]) !== undefined) {
    return build(name, specifier, "exact", single[1], manifest, scope, markerNote);
  }
  if (specifier.split(",").every((clause) => satisfiesPep440("0", clause) !== undefined)) {
    return build(name, specifier, "range", undefined, manifest, scope, markerNote);
  }
  return build(name, specifier, "unresolved", undefined, manifest, scope, "Unrecognized version specifier; not checked against the index.");
}

function build(
  name: string,
  spec: string,
  kind: DeclaredKind,
  exactVersion: string | undefined,
  manifest: string,
  scope: DependencyScope,
  note: string | undefined
): ManifestDependency {
  return {
    ecosystem: "pypi",
    name,
    declaredSpec: spec,
    declaredKind: kind,
    exactVersion,
    scope,
    manifest,
    lockedVersion: undefined,
    lockfile: undefined,
    note
  };
}

function joinContinuations(text: string): string[] {
  const lines = text.split(/\r?\n/);
  const logical: string[] = [];
  let buffer = "";
  for (const line of lines) {
    if (line.endsWith("\\")) {
      buffer += line.slice(0, -1) + " ";
      continue;
    }
    logical.push(buffer + line);
    buffer = "";
  }
  if (buffer !== "") {
    logical.push(buffer);
  }
  return logical;
}

function stripComment(line: string): string {
  if (line.trimStart().startsWith("#")) {
    return "";
  }
  const index = line.search(/\s#/);
  return index >= 0 ? line.slice(0, index) : line;
}

function describeOption(line: string): string {
  if (/^(-r|--requirement|-c|--constraint)\b/.test(line)) {
    return `Included file "${line}" is not followed; its dependencies are not analyzed.`;
  }
  if (/^(-e|--editable)\b/.test(line)) {
    return `Editable or VCS requirement "${line}" is not analyzed.`;
  }
  return `Option "${line}" is not analyzed and was ignored.`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
