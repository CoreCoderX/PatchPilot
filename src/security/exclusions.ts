/**
 * Path patterns that must never be sent to a model. The defaults always apply;
 * user configuration can add patterns but cannot remove these.
 */
export const DEFAULT_EXCLUDE_PATTERNS: readonly string[] = [
  ".env",
  ".env.*",
  "**/.env",
  "**/.env.*",
  "**/*.pem",
  "**/*.key",
  "**/*.p12",
  "**/*.pfx",
  "**/*.jks",
  "**/*.keystore",
  "**/id_rsa*",
  "**/id_ed25519*",
  "**/.npmrc",
  "**/.pypirc",
  "**/.netrc",
  "**/.git-credentials",
  "**/credentials*",
  "**/secrets/**"
];

export function effectiveExcludePatterns(configured: readonly string[]): string[] {
  const merged = new Set<string>(DEFAULT_EXCLUDE_PATTERNS);
  for (const pattern of configured) {
    const trimmed = pattern.trim();
    if (trimmed.length > 0) {
      merged.add(trimmed);
    }
  }
  return [...merged];
}

/**
 * Glob-style match for workspace-relative paths. Supports *, ?, and **.
 * A pattern without "/" matches the file name at any depth.
 */
export function isExcludedPath(relativePath: string, patterns: readonly string[]): boolean {
  const normalized = relativePath.replace(/\\/g, "/").replace(/^\.\//, "");
  const baseName = normalized.slice(normalized.lastIndexOf("/") + 1);
  return patterns.some((pattern) => {
    const regex = globToRegExp(pattern);
    return regex.test(pattern.includes("/") ? normalized : baseName);
  });
}

function globToRegExp(pattern: string): RegExp {
  let source = "";
  let i = 0;
  while (i < pattern.length) {
    const char = pattern.charAt(i);
    if (char === "*") {
      if (pattern.charAt(i + 1) === "*") {
        if (pattern.charAt(i + 2) === "/") {
          source += "(?:.*/)?";
          i += 3;
        } else {
          source += ".*";
          i += 2;
        }
        continue;
      }
      source += "[^/]*";
    } else if (char === "?") {
      source += "[^/]";
    } else {
      source += char.replace(/[.+^${}()|[\]\\]/g, "\\$&");
    }
    i += 1;
  }
  return new RegExp(`^${source}$`);
}
