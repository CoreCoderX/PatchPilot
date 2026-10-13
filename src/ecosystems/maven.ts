import { XMLParser, XMLValidator } from "fast-xml-parser";
import type { DependencyScope, ManifestDependency, ParseIssue, ParsedProject } from "../analysis/types";

export interface MavenSources {
  readonly manifest: { readonly path: string; readonly text: string };
}

const PROPERTY_PATTERN = /\$\{([^}]+)\}/g;

export function parseMavenProject(sources: MavenSources): ParsedProject {
  const path = sources.manifest.path;
  const issues: ParseIssue[] = [];
  const empty = (): ParsedProject => ({ ecosystem: "maven", manifest: path, format: "pom.xml", dependencies: [], issues });

  // eslint-disable-next-line @typescript-eslint/no-deprecated -- bundled validator of fast-xml-parser 5; its replacement is a separate package not added in this phase.
  if (XMLValidator.validate(sources.manifest.text) !== true) {
    issues.push({ file: path, kind: "malformed", message: "pom.xml is not well-formed XML." });
    return empty();
  }
  const parser = new XMLParser({
    ignoreAttributes: true,
    parseTagValue: false,
    trimValues: true,
    isArray: (name) => name === "dependency"
  });
  const doc: unknown = parser.parse(sources.manifest.text);
  const project = childRecord(doc, "project");
  if (project === undefined) {
    issues.push({ file: path, kind: "malformed", message: "Root element is not <project>." });
    return empty();
  }

  const parent = childRecord(project, "parent");
  const hasParent = parent !== undefined;
  const properties = collectProperties(childRecord(project, "properties"));
  const projectVersion = textOf(project.version) ?? (parent === undefined ? undefined : textOf(parent.version));
  if (projectVersion !== undefined) {
    properties["project.version"] = projectVersion;
  }
  const projectGroup = textOf(project.groupId) ?? (parent === undefined ? undefined : textOf(parent.groupId));
  if (projectGroup !== undefined) {
    properties["project.groupId"] = projectGroup;
  }

  const managed = new Map<string, string>();
  const dependencyManagement = childRecord(project, "dependencyManagement");
  for (const entry of listOf(childRecord(dependencyManagement, "dependencies"), "dependency")) {
    const coordinate = coordinateOf(entry, properties);
    const version = textOf(entry.version);
    if (coordinate !== undefined && version !== undefined) {
      managed.set(coordinate, resolveProperties(version, properties).value);
    }
  }

  const dependencies: ManifestDependency[] = [];
  for (const entry of listOf(childRecord(project, "dependencies"), "dependency")) {
    const coordinate = coordinateOf(entry, properties);
    if (coordinate === undefined) {
      issues.push({ file: path, kind: "skipped-entry", message: "A <dependency> lacks groupId or artifactId; skipped." });
      continue;
    }
    const scope = scopeOf(entry);
    const rawVersion = textOf(entry.version);
    let spec: string;
    let kind: ManifestDependency["declaredKind"];
    let note: string | undefined;
    let exactVersion: string | undefined;

    if (rawVersion !== undefined) {
      const resolved = resolveProperties(rawVersion, properties);
      spec = rawVersion;
      if (!resolved.complete) {
        kind = "unresolved";
        note = `Version uses an unresolved property (${resolved.value}).`;
      } else {
        const classified = classifyMavenVersion(resolved.value);
        kind = classified.kind;
        exactVersion = classified.exactVersion;
        note = classified.note;
      }
    } else if (managed.has(coordinate)) {
      const value = managed.get(coordinate) ?? "";
      spec = value;
      const classified = classifyMavenVersion(value);
      kind = classified.kind;
      exactVersion = classified.exactVersion;
      note = "Version taken from <dependencyManagement> in this POM.";
    } else if (hasParent) {
      spec = "";
      kind = "managed";
      note = "Version inherited from a parent POM or BOM; not resolved in this analysis.";
    } else {
      spec = "";
      kind = "unresolved";
      note = "No version declared and no parent POM or dependencyManagement entry found.";
    }

    dependencies.push({
      ecosystem: "maven",
      name: coordinate,
      declaredSpec: spec,
      declaredKind: kind,
      exactVersion,
      scope,
      manifest: path,
      lockedVersion: undefined,
      lockfile: undefined,
      note
    });
  }

  return {
    ecosystem: "maven",
    manifest: path,
    format: hasParent ? "pom.xml (parent POM not resolved)" : "pom.xml",
    dependencies,
    issues
  };
}

function classifyMavenVersion(value: string): { kind: "exact" | "range"; exactVersion: string | undefined; note: string | undefined } {
  if (/^[[(]/.test(value.trim())) {
    return { kind: "range", exactVersion: undefined, note: "Maven version range; ranges are not evaluated in this phase." };
  }
  return { kind: "exact", exactVersion: value.trim(), note: undefined };
}

function scopeOf(entry: Record<string, unknown>): DependencyScope {
  if (textOf(entry.optional) === "true") {
    return "optional";
  }
  return textOf(entry.scope) === "test" ? "development" : "runtime";
}

function coordinateOf(entry: Record<string, unknown>, properties: Record<string, string>): string | undefined {
  const group = textOf(entry.groupId);
  const artifact = textOf(entry.artifactId);
  if (group === undefined || artifact === undefined) {
    return undefined;
  }
  return `${resolveProperties(group, properties).value}:${resolveProperties(artifact, properties).value}`;
}

export function resolveProperties(
  value: string,
  properties: Readonly<Record<string, string>>
): { readonly value: string; readonly complete: boolean } {
  let complete = true;
  const lookup: Partial<Record<string, string>> = properties;
  const resolved = value.replace(PROPERTY_PATTERN, (_match, name: string) => {
    const replacement = lookup[name];
    if (replacement === undefined) {
      complete = false;
      return `\${${name}}`;
    }
    return replacement;
  });
  return { value: resolved, complete };
}

function collectProperties(node: Record<string, unknown> | undefined): Record<string, string> {
  const result: Record<string, string> = {};
  if (node === undefined) {
    return result;
  }
  for (const [key, value] of Object.entries(node)) {
    const text = textOf(value);
    if (text !== undefined) {
      result[key] = text;
    }
  }
  return result;
}

function listOf(parent: Record<string, unknown> | undefined, name: string): Record<string, unknown>[] {
  const value: unknown = parent?.[name];
  if (!Array.isArray(value)) {
    return [];
  }
  return value.filter((item): item is Record<string, unknown> => typeof item === "object" && item !== null);
}

function childRecord(parent: unknown, name: string): Record<string, unknown> | undefined {
  if (typeof parent !== "object" || parent === null || !(name in parent)) {
    return undefined;
  }
  const value: unknown = (parent as Record<string, unknown>)[name];
  return typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined;
}

function textOf(value: unknown): string | undefined {
  if (typeof value === "string") {
    const trimmed = value.trim();
    return trimmed.length > 0 ? trimmed : undefined;
  }
  if (typeof value === "number") {
    return String(value);
  }
  return undefined;
}
