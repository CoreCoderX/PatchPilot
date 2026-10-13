import { createHash } from "node:crypto";
import type { ManifestDependency } from "../analysis/types";

export function sha256(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

export type EditResult = { readonly ok: true; readonly text: string } | { readonly ok: false; readonly reason: "edit-not-found" | "edit-not-unique" };

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\/-]/g, "\\$&");
}

/** PEP 503 names: runs of "-", "_", "." are equivalent, and case is ignored. */
function pypiNamePattern(name: string): string {
  const parts = name
    .toLowerCase()
    .split(/[-_.]+/)
    .filter((part) => part.length > 0)
    .map(escapeRegExp);
  return parts.join("[-_.]+");
}

/**
 * Replaces the version inside each match. The regex must end with the old version and
 * must match exactly once, otherwise the edit is refused.
 */
function replaceSingle(text: string, pattern: RegExp, oldVersion: string, newVersion: string): EditResult {
  const matches = [...text.matchAll(pattern)];
  if (matches.length === 0) {
    return { ok: false, reason: "edit-not-found" };
  }
  if (matches.length > 1) {
    return { ok: false, reason: "edit-not-unique" };
  }
  const match = matches.at(0);
  if (match?.index === undefined) {
    return { ok: false, reason: "edit-not-found" };
  }
  const offset = match.index + match[0].lastIndexOf(oldVersion);
  return { ok: true, text: text.slice(0, offset) + newVersion + text.slice(offset + oldVersion.length) };
}

/**
 * Rewrites one exact pin in a manifest. Only literal pins are edited:
 *  - npm: "name": "<declared spec>" inside a JSON object
 *  - Maven: <version>x</version> directly after the groupId/artifactId pair
 *  - PyPI requirements: name==x on one line
 *  - PyPI pyproject: "name==x" string in a PEP 621 list
 * Anything else is refused by returning edit-not-found or edit-not-unique.
 */
export function applyExactPinEdit(
  text: string,
  dependency: ManifestDependency,
  oldVersion: string,
  newVersion: string,
  fileKind: "npm" | "maven" | "pypi-requirements" | "pypi-pyproject"
): EditResult {
  if (dependency.ecosystem === "npm" && fileKind === "npm") {
    const spec = dependency.declaredSpec;
    const pattern = new RegExp(`"${escapeRegExp(dependency.name)}"(\\s*:\\s*)"${escapeRegExp(spec)}"`, "g");
    const matches = [...text.matchAll(pattern)];
    if (matches.length === 0) {
      return { ok: false, reason: "edit-not-found" };
    }
    if (matches.length > 1) {
      return { ok: false, reason: "edit-not-unique" };
    }
    const match = matches.at(0);
    if (match?.index === undefined) {
      return { ok: false, reason: "edit-not-found" };
    }
    const replacement = `"${dependency.name}"${match[1]}"${newVersion}"`;
    return { ok: true, text: text.slice(0, match.index) + replacement + text.slice(match.index + match[0].length) };
  }

  if (dependency.ecosystem === "maven" && fileKind === "maven") {
    const parts = dependency.name.split(":");
    if (parts.length !== 2) {
      return { ok: false, reason: "edit-not-found" };
    }
    const [groupId, artifactId] = parts;
    const g = escapeRegExp(groupId);
    const a = escapeRegExp(artifactId);
    const v = escapeRegExp(oldVersion);
    const forward = new RegExp(`<groupId>\\s*${g}\\s*</groupId>\\s*<artifactId>\\s*${a}\\s*</artifactId>\\s*<version>\\s*${v}\\s*</version>`, "g");
    const reverse = new RegExp(`<artifactId>\\s*${a}\\s*</artifactId>\\s*<groupId>\\s*${g}\\s*</groupId>\\s*<version>\\s*${v}\\s*</version>`, "g");
    const count = text.match(forward)?.length ?? 0;
    const countReverse = text.match(reverse)?.length ?? 0;
    if (count + countReverse === 0) {
      return { ok: false, reason: "edit-not-found" };
    }
    if (count + countReverse > 1) {
      return { ok: false, reason: "edit-not-unique" };
    }
    const pattern = count === 1 ? forward : reverse;
    return replaceSingle(text, pattern, oldVersion, newVersion);
  }

  if (dependency.ecosystem === "pypi" && fileKind === "pypi-requirements") {
    const pattern = new RegExp(
      `^(?:[ \\t]*)${pypiNamePattern(dependency.name)}(?:\\[[^\\]\\n]*\\])?[ \\t]*==[ \\t]*${escapeRegExp(oldVersion)}(?=[ \\t]*(?:[#;]|\\r?$))`,
      "gmi"
    );
    return replaceSingle(text, pattern, oldVersion, newVersion);
  }

  if (dependency.ecosystem === "pypi" && fileKind === "pypi-pyproject") {
    const pattern = new RegExp(
      `(["'])${pypiNamePattern(dependency.name)}(?:\\[[^\\]"'\\n]*\\])?==${escapeRegExp(oldVersion)}(?=\\1)`,
      "gi"
    );
    return replaceSingle(text, pattern, oldVersion, newVersion);
  }

  return { ok: false, reason: "edit-not-found" };
}
