import type { Ecosystem, UnsupportedFile } from "./types";

/** Directory names never analyzed. Dependency caches and build outputs, not project manifests. */
export const EXCLUDED_DIRECTORIES: ReadonlySet<string> = new Set([
  "node_modules",
  ".git",
  ".venv",
  "venv",
  "__pycache__",
  ".tox",
  ".nox",
  "target",
  "build",
  "dist",
  "out",
  "bin",
  "obj",
  ".gradle",
  ".next",
  ".nuxt",
  "coverage",
  "vendor"
]);

export const DEFAULT_MANIFEST_LIMIT = 50;

export type ManifestKind = "npm" | "maven" | "pypi-requirements" | "pypi-pyproject";

export interface ManifestCandidate {
  readonly kind: ManifestKind;
  readonly ecosystem: Ecosystem;
  readonly path: string;
  /** npm only: the sibling package-lock.json, when present in the file list. */
  readonly lockfile: string | undefined;
}

export interface DetectionResult {
  readonly manifests: readonly ManifestCandidate[];
  readonly unsupportedFiles: readonly UnsupportedFile[];
  readonly excludedCount: number;
  readonly limitsReached: readonly string[];
}

const REQUIREMENTS_PATTERN = /^requirements(?:[-_.][\w.-]+)?\.txt$/i;

const UNSUPPORTED_NAMES: ReadonlyMap<string, string> = new Map([
  ["yarn.lock", "Yarn lockfile is not read; versions shown are from package.json only."],
  ["pnpm-lock.yaml", "pnpm lockfile is not read; versions shown are from package.json only."],
  ["bun.lockb", "Bun lockfile is not read; versions shown are from package.json only."],
  ["poetry.lock", "Poetry lockfile is not read; versions shown are from pyproject.toml or requirements only."],
  ["Pipfile", "Pipfile is not analyzed."],
  ["Pipfile.lock", "Pipfile.lock is not analyzed."],
  ["setup.py", "setup.py is not analyzed (it can run code); use pyproject.toml or requirements.txt."],
  ["setup.cfg", "setup.cfg is not analyzed."],
  ["build.gradle", "Gradle build files are not analyzed in this phase."],
  ["build.gradle.kts", "Gradle build files are not analyzed in this phase."],
  ["settings.gradle", "Gradle build files are not analyzed in this phase."],
  ["settings.gradle.kts", "Gradle build files are not analyzed in this phase."],
  ["gradle.lockfile", "Gradle lockfile is not analyzed in this phase."]
]);

/**
 * Finds supported manifests and reports unsupported lock or build files.
 * Paths are workspace-relative and may use either separator. Output is sorted for determinism.
 */
export function detectManifests(paths: readonly string[], limit: number = DEFAULT_MANIFEST_LIMIT): DetectionResult {
  const normalized = [...new Set(paths.map((path) => path.replace(/\\/g, "/")))].sort();
  const present = new Set(normalized);
  const manifests: ManifestCandidate[] = [];
  const unsupportedFiles: UnsupportedFile[] = [];
  let excludedCount = 0;

  for (const path of normalized) {
    const segments = path.split("/");
    const name = segments[segments.length - 1] ?? "";
    const directories = segments.slice(0, -1);
    if (directories.some((segment) => EXCLUDED_DIRECTORIES.has(segment))) {
      excludedCount += 1;
      continue;
    }
    const dir = directories.join("/");
    const join = (file: string): string => (dir === "" ? file : `${dir}/${file}`);

    if (name === "package.json") {
      const lock = join("package-lock.json");
      manifests.push({ kind: "npm", ecosystem: "npm", path, lockfile: present.has(lock) ? lock : undefined });
    } else if (name === "pom.xml") {
      manifests.push({ kind: "maven", ecosystem: "maven", path, lockfile: undefined });
    } else if (name === "pyproject.toml") {
      manifests.push({ kind: "pypi-pyproject", ecosystem: "pypi", path, lockfile: undefined });
    } else if (REQUIREMENTS_PATTERN.test(name)) {
      manifests.push({ kind: "pypi-requirements", ecosystem: "pypi", path, lockfile: undefined });
    } else if (UNSUPPORTED_NAMES.has(name)) {
      unsupportedFiles.push({ file: path, reason: UNSUPPORTED_NAMES.get(name) ?? "Not analyzed." });
    }
  }

  const limitsReached: string[] = [];
  let kept = manifests;
  if (manifests.length > limit) {
    kept = manifests.slice(0, limit);
    limitsReached.push(`Only the first ${String(limit)} of ${String(manifests.length)} manifests were analyzed.`);
  }
  return { manifests: kept, unsupportedFiles, excludedCount, limitsReached };
}
