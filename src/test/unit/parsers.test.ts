import * as assert from "node:assert/strict";
import { describe, it } from "mocha";
import { detectManifests } from "../../analysis/detect";
import type { ManifestDependency, ParsedProject } from "../../analysis/types";
import { compareMaven, comparePep440, parsePep440, satisfiesPep440 } from "../../analysis/versions";
import { parseMavenProject } from "../../ecosystems/maven";
import { classifyNpmSpec, parseNpmProject } from "../../ecosystems/npm";
import { parsePypiProject, parseRequirementSpec } from "../../ecosystems/pypi";

function find(project: ParsedProject, name: string): ManifestDependency {
  const dep = project.dependencies.find((d) => d.name === name);
  assert.ok(dep, `missing dependency ${name}`);
  return dep;
}

describe("npm parser", () => {
  const manifest = JSON.stringify({
    dependencies: { left: "1.2.3", pad: "^2.0.0", blank: "", any: "*", tagged: "latest", gitdep: "git+https://example.test/x.git", alias: "npm:other@1.0.0" },
    devDependencies: { jest: "~29.7.0" }
  });

  it("classifies exact, range, unpinned, and unresolved specifiers", () => {
    const project = parseNpmProject({ manifest: { path: "package.json", text: manifest } });
    assert.equal(find(project, "left").declaredKind, "exact");
    assert.equal(find(project, "left").exactVersion, "1.2.3");
    assert.equal(find(project, "pad").declaredKind, "range");
    assert.equal(find(project, "blank").declaredKind, "unpinned");
    assert.equal(find(project, "any").declaredKind, "unpinned");
    assert.equal(find(project, "tagged").declaredKind, "unresolved");
    assert.equal(find(project, "gitdep").declaredKind, "unresolved");
    assert.equal(find(project, "alias").declaredKind, "unresolved");
    assert.equal(find(project, "jest").scope, "development");
  });

  it("takes locked versions from a v3 lockfile (top-level entries only)", () => {
    const lock = JSON.stringify({
      lockfileVersion: 3,
      packages: {
        "": {},
        "node_modules/pad": { version: "2.0.4" },
        "node_modules/pad/node_modules/inner": { version: "9.9.9" }
      }
    });
    const project = parseNpmProject({
      manifest: { path: "package.json", text: manifest },
      lockfile: { path: "package-lock.json", text: lock }
    });
    assert.equal(find(project, "pad").lockedVersion, "2.0.4");
    assert.equal(find(project, "pad").lockfile, "package-lock.json");
    assert.equal(project.format, "package.json + package-lock.json (lockfileVersion 3)");
    assert.equal(project.dependencies.some((d) => d.name === "inner"), false);
  });

  it("reads v1 lockfiles and reports unsupported lockfile versions without guessing", () => {
    const v1 = JSON.stringify({ lockfileVersion: 1, dependencies: { pad: { version: "2.0.1" } } });
    const ok = parseNpmProject({ manifest: { path: "package.json", text: manifest }, lockfile: { path: "package-lock.json", text: v1 } });
    assert.equal(find(ok, "pad").lockedVersion, "2.0.1");

    const v4 = JSON.stringify({ lockfileVersion: 4, packages: {} });
    const bad = parseNpmProject({ manifest: { path: "package.json", text: manifest }, lockfile: { path: "package-lock.json", text: v4 } });
    assert.equal(find(bad, "pad").lockedVersion, undefined);
    assert.ok(bad.issues.some((i) => i.kind === "unsupported" && i.message.includes("lockfileVersion 4")));
  });

  it("reports malformed JSON as a malformed issue with no dependencies", () => {
    const project = parseNpmProject({ manifest: { path: "package.json", text: "{ nope" } });
    assert.equal(project.dependencies.length, 0);
    assert.equal(project.issues[0]?.kind, "malformed");
  });

  it("skips invalid names and non-string versions with an issue each", () => {
    const text = JSON.stringify({ dependencies: { "Bad Name!": "1.0.0", ok: 3 } });
    const project = parseNpmProject({ manifest: { path: "package.json", text } });
    assert.equal(project.dependencies.length, 0);
    assert.equal(project.issues.filter((i) => i.kind === "skipped-entry").length, 2);
  });

  it("classifies single specifiers consistently", () => {
    assert.equal(classifyNpmSpec("v1.2.3").exactVersion, "1.2.3");
    assert.equal(classifyNpmSpec(">=1 <2").kind, "range");
    assert.equal(classifyNpmSpec("file:../local").kind, "unresolved");
  });
});

describe("Maven parser", () => {
  const pom = `<?xml version="1.0"?>
<project>
  <groupId>com.example</groupId>
  <artifactId>app</artifactId>
  <version>1.0.0</version>
  <properties><lib.version>2.5.1</lib.version></properties>
  <dependencyManagement><dependencies>
    <dependency><groupId>org.managed</groupId><artifactId>lib</artifactId><version>3.1.0</version></dependency>
  </dependencies></dependencyManagement>
  <dependencies>
    <dependency><groupId>org.apache</groupId><artifactId>core</artifactId><version>\${lib.version}</version></dependency>
    <dependency><groupId>org.managed</groupId><artifactId>lib</artifactId></dependency>
    <dependency><groupId>junit</groupId><artifactId>junit</artifactId><version>4.13.2</version><scope>test</scope></dependency>
    <dependency><groupId>org.opt</groupId><artifactId>opt</artifactId><version>1.0</version><optional>true</optional></dependency>
    <dependency><groupId>org.range</groupId><artifactId>r</artifactId><version>[1.0,2.0)</version></dependency>
    <dependency><groupId>org.prop</groupId><artifactId>p</artifactId><version>\${missing.prop}</version></dependency>
    <dependency><artifactId>nogroup</artifactId><version>1.0</version></dependency>
  </dependencies>
</project>`;

  it("resolves properties, dependencyManagement, scopes, and ranges", () => {
    const project = parseMavenProject({ manifest: { path: "pom.xml", text: pom } });
    assert.equal(find(project, "org.apache:core").exactVersion, "2.5.1");
    assert.equal(find(project, "org.managed:lib").declaredKind, "exact");
    assert.equal(find(project, "org.managed:lib").exactVersion, "3.1.0");
    assert.equal(find(project, "junit:junit").scope, "development");
    assert.equal(find(project, "org.opt:opt").scope, "optional");
    assert.equal(find(project, "org.range:r").declaredKind, "range");
    assert.equal(find(project, "org.prop:p").declaredKind, "unresolved");
    assert.equal(project.dependencies.length, 6);
    assert.ok(project.issues.some((i) => i.kind === "skipped-entry"));
  });

  it("marks parent-inherited versions as managed rather than guessing", () => {
    const text = `<project><parent><groupId>g</groupId><artifactId>p</artifactId><version>1</version></parent>
      <artifactId>c</artifactId><dependencies><dependency><groupId>a</groupId><artifactId>b</artifactId></dependency></dependencies></project>`;
    const project = parseMavenProject({ manifest: { path: "pom.xml", text } });
    assert.equal(find(project, "a:b").declaredKind, "managed");
    assert.equal(project.format, "pom.xml (parent POM not resolved)");
  });

  it("reports malformed XML", () => {
    const project = parseMavenProject({ manifest: { path: "pom.xml", text: "<project><dependencies>" } });
    assert.equal(project.issues[0]?.kind, "malformed");
  });
});

describe("Python parsers", () => {
  it("parses requirements with comments, continuations, hashes, and markers", () => {
    const text = [
      "# comment",
      "requests==2.31.0  # pinned",
      "flask>=2.0,<3.0",
      "numpy",
      "pywin32 ; sys_platform == 'win32'",
      "long-name[extra] == 1.2 \\",
      "   --hash=sha256:abc",
      "-r other.txt",
      "-e git+https://example.test/pkg.git#egg=pkg",
      "--index-url https://index.example.test/simple",
      "https://example.test/pkg.whl"
    ].join("\n");
    const project = parsePypiProject({ manifest: { path: "requirements.txt", text }, kind: "requirements" });
    assert.equal(find(project, "requests").declaredKind, "exact");
    assert.equal(find(project, "requests").exactVersion, "2.31.0");
    assert.equal(find(project, "flask").declaredKind, "range");
    assert.equal(find(project, "numpy").declaredKind, "unpinned");
    assert.ok(find(project, "pywin32").note?.includes("not evaluated"));
    assert.equal(find(project, "long-name").exactVersion, "1.2");
    assert.ok(project.issues.some((i) => i.message.includes("-r other.txt") && i.message.includes("not followed")));
    assert.ok(project.issues.some((i) => i.message.includes("Editable")));
    assert.ok(project.issues.some((i) => i.message.includes("--index-url")));
    assert.ok(project.issues.some((i) => i.message.includes("URL requirement")));
    assert.equal(project.dependencies.some((d) => d.name === "https"), false, "URL lines must not become packages");
    assert.equal(project.dependencies.length, 5);
  });

  it("treats a direct URL requirement as unresolved", () => {
    const dep = parseRequirementSpec("pkg @ https://example.test/pkg.whl", "requirements.txt", "runtime");
    assert.equal(dep?.declaredKind, "unresolved");
  });

  it("parses PEP 621 dependencies and optional groups; reports Poetry and dependency-groups", () => {
    const text = `[project]
name = "demo"
dependencies = ["httpx>=0.27", "pydantic==2.7.1"]
[project.optional-dependencies]
dev = ["pytest==8.2.0"]
[tool.poetry.dependencies]
requests = "^2.0"
[dependency-groups]
lint = ["ruff"]`;
    const project = parsePypiProject({ manifest: { path: "pyproject.toml", text }, kind: "pyproject" });
    assert.equal(find(project, "pydantic").exactVersion, "2.7.1");
    assert.equal(find(project, "httpx").scope, "runtime");
    assert.equal(find(project, "pytest").scope, "optional");
    assert.ok(project.issues.some((i) => i.message.includes("Poetry")));
    assert.ok(project.issues.some((i) => i.message.includes("PEP 735")));
  });

  it("reports invalid TOML and a missing [project] table", () => {
    assert.equal(parsePypiProject({ manifest: { path: "pyproject.toml", text: "[oops" }, kind: "pyproject" }).issues[0]?.kind, "malformed");
    assert.equal(parsePypiProject({ manifest: { path: "pyproject.toml", text: "[tool.x]\na = 1" }, kind: "pyproject" }).issues[0]?.kind, "unsupported");
  });
});

describe("file detection", () => {
  it("finds supported manifests, pairs npm lockfiles, and skips dependency directories", () => {
    const result = detectManifests([
      "package.json",
      "package-lock.json",
      "node_modules/x/package.json",
      "web/package.json",
      "pom.xml",
      "svc/requirements-dev.txt",
      "pyproject.toml",
      "yarn.lock",
      "build.gradle.kts",
      "setup.py",
      "target/classes/pom.xml"
    ]);
    assert.deepEqual(result.manifests.map((m) => m.path), ["package.json", "pom.xml", "pyproject.toml", "svc/requirements-dev.txt", "web/package.json"]);
    assert.equal(result.manifests[0]?.lockfile, "package-lock.json");
    assert.equal(result.excludedCount, 2);
    const reasons = result.unsupportedFiles.map((f) => f.file);
    assert.ok(reasons.includes("yarn.lock"));
    assert.ok(reasons.includes("build.gradle.kts"));
    assert.ok(reasons.includes("setup.py"));
    assert.equal(new Set(reasons).size, reasons.length, "no duplicate unsupported entries");
  });

  it("applies the manifest limit and reports it", () => {
    const paths = Array.from({ length: 5 }, (_, i) => `p${String(i)}/package.json`);
    const result = detectManifests(paths, 3);
    assert.equal(result.manifests.length, 3);
    assert.ok(result.limitsReached[0]?.includes("first 3 of 5"));
  });

  it("does not treat inherited object keys as unsupported files", () => {
    const result = detectManifests(["constructor", "toString"]);
    assert.equal(result.unsupportedFiles.length, 0);
    assert.equal(result.manifests.length, 0);
  });
});

describe("version ordering", () => {
  it("orders Maven qualifiers and stability", () => {
    assert.ok(compareMaven("1.0", "1.0.1") < 0);
    assert.ok(compareMaven("1.0-alpha", "1.0") < 0);
    assert.ok(compareMaven("2.0.0", "2.0.0-RC1") > 0);
  });

  it("orders PEP 440 releases, pre-releases, and post-releases", () => {
    const inputs = ["1.0.post1", "1.0", "1.0rc1", "1.0.dev1", "0.9"];
    const sorted = inputs
      .map((raw) => ({ raw, parsed: parsePep440(raw) }))
      .filter((entry): entry is { raw: string; parsed: NonNullable<typeof entry.parsed> } => entry.parsed !== undefined)
      .sort((a, b) => comparePep440(a.parsed, b.parsed));
    assert.deepEqual(sorted.map((entry) => entry.raw), ["0.9", "1.0.dev1", "1.0rc1", "1.0", "1.0.post1"]);
  });

  it("matches PEP 440 specifiers and reports invalid input as undefined", () => {
    assert.equal(satisfiesPep440("2.1.0", ">=2.0,<3"), true);
    assert.equal(satisfiesPep440("3.0.0", ">=2.0,<3"), false);
    assert.equal(satisfiesPep440("1.0.0", "~=1.0.2"), false);
    assert.equal(satisfiesPep440("not-a-version", ">=1"), undefined);
  });
});
