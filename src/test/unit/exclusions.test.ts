import * as assert from "node:assert/strict";
import { describe, it } from "mocha";
import { DEFAULT_EXCLUDE_PATTERNS, effectiveExcludePatterns, isExcludedPath } from "../../security/exclusions";

describe("isExcludedPath with default patterns", () => {
  const patterns = [...DEFAULT_EXCLUDE_PATTERNS];

  it("excludes environment files at the root and in subfolders", () => {
    assert.equal(isExcludedPath(".env", patterns), true);
    assert.equal(isExcludedPath(".env.local", patterns), true);
    assert.equal(isExcludedPath("services/api/.env.production", patterns), true);
  });

  it("excludes key, certificate, and keystore files at any depth", () => {
    assert.equal(isExcludedPath("certs/server.pem", patterns), true);
    assert.equal(isExcludedPath("deploy/tls/private.key", patterns), true);
    assert.equal(isExcludedPath("android/release.keystore", patterns), true);
    assert.equal(isExcludedPath("home/id_rsa", patterns), true);
    assert.equal(isExcludedPath("id_ed25519.pub", patterns), true);
  });

  it("excludes credential files and secrets folders", () => {
    assert.equal(isExcludedPath(".npmrc", patterns), true);
    assert.equal(isExcludedPath("config/credentials.json", patterns), true);
    assert.equal(isExcludedPath("app/secrets/db.json", patterns), true);
  });

  it("normalizes Windows separators and leading ./", () => {
    assert.equal(isExcludedPath("services\\api\\.env", patterns), true);
    assert.equal(isExcludedPath("./.env", patterns), true);
  });

  it("does not exclude ordinary source and manifest files", () => {
    assert.equal(isExcludedPath("src/index.ts", patterns), false);
    assert.equal(isExcludedPath("package.json", patterns), false);
    assert.equal(isExcludedPath("pom.xml", patterns), false);
    assert.equal(isExcludedPath("requirements.txt", patterns), false);
    assert.equal(isExcludedPath("docs/environment-notes.md", patterns), false);
  });
});

describe("effectiveExcludePatterns", () => {
  it("always includes the defaults, even when configuration is empty", () => {
    const merged = effectiveExcludePatterns([]);
    for (const pattern of DEFAULT_EXCLUDE_PATTERNS) {
      assert.ok(merged.includes(pattern), pattern);
    }
  });

  it("adds user patterns without removing defaults and drops blanks and duplicates", () => {
    const merged = effectiveExcludePatterns(["internal/**", "  ", ".env", "internal/**"]);
    assert.ok(merged.includes("internal/**"));
    assert.ok(merged.includes(".env"));
    assert.equal(merged.filter((p) => p === "internal/**").length, 1);
    assert.equal(merged.filter((p) => p === ".env").length, 1);
    assert.equal(isExcludedPath("internal/data.csv", merged), true);
  });
});
