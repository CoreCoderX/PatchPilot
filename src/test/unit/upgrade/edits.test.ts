import * as assert from "node:assert/strict";
import { describe, it } from "mocha";
import { assertOk } from "../helpers";
import { applyExactPinEdit, sha256 } from "../../../upgrade/edits";
import { dep } from "./helpers";

describe("applyExactPinEdit (npm)", () => {
  const pkg = dep({ ecosystem: "npm", name: "lodash", manifest: "package.json", declaredSpec: "4.17.15", exactVersion: "4.17.15" });

  it("rewrites a single exact pin and keeps the rest of the file", () => {
    const text = '{\n  "dependencies": {\n    "lodash": "4.17.15",\n    "left": "^1.0.0"\n  }\n}\n';
    const result = applyExactPinEdit(text, pkg, "4.17.15", "4.17.21", "npm");
    assertOk(result);
    assert.equal(result.text, text.replace('"lodash": "4.17.15"', '"lodash": "4.17.21"'));
  });

  it("refuses when the same pin appears twice", () => {
    const text = '{"dependencies":{"lodash":"4.17.15"},"devDependencies":{"lodash":"4.17.15"}}';
    assert.deepEqual(applyExactPinEdit(text, pkg, "4.17.15", "4.17.21", "npm"), { ok: false, reason: "edit-not-unique" });
  });

  it("refuses a range that is not the exact declared spec", () => {
    const text = '{"dependencies":{"lodash":"^4.17.15"}}';
    assert.deepEqual(applyExactPinEdit(text, pkg, "4.17.15", "4.17.21", "npm"), { ok: false, reason: "edit-not-found" });
  });

  it("does not match a package whose name only contains the target name", () => {
    const text = '{"dependencies":{"lodash-es":"4.17.15"}}';
    assert.deepEqual(applyExactPinEdit(text, pkg, "4.17.15", "4.17.21", "npm"), { ok: false, reason: "edit-not-found" });
  });
});

describe("applyExactPinEdit (Maven)", () => {
  const dependency = dep({ ecosystem: "maven", name: "org.apache.commons:commons-lang3", manifest: "pom.xml", declaredSpec: "3.5", exactVersion: "3.5" });

  it("rewrites a literal version after groupId and artifactId", () => {
    const pom = "<dependency>\n  <groupId>org.apache.commons</groupId>\n  <artifactId>commons-lang3</artifactId>\n  <version>3.5</version>\n</dependency>";
    const result = applyExactPinEdit(pom, dependency, "3.5", "3.12.0", "maven");
    assertOk(result);
    assert.match(result.text, /<version>3\.12\.0<\/version>/);
    assert.equal(sha256(result.text) === sha256(pom), false);
  });

  it("accepts artifactId before groupId", () => {
    const pom = "<dependency><artifactId>commons-lang3</artifactId><groupId>org.apache.commons</groupId><version>3.5</version></dependency>";
    const result = applyExactPinEdit(pom, dependency, "3.5", "3.12.0", "maven");
    assert.equal(result.ok, true);
  });

  it("refuses a property-derived version", () => {
    const pom = "<dependency><groupId>org.apache.commons</groupId><artifactId>commons-lang3</artifactId><version>${lang.version}</version></dependency>";
    assert.deepEqual(applyExactPinEdit(pom, dependency, "3.5", "3.12.0", "maven"), { ok: false, reason: "edit-not-found" });
  });

  it("refuses when the coordinate appears twice (for example in dependencyManagement)", () => {
    const block = "<groupId>org.apache.commons</groupId><artifactId>commons-lang3</artifactId><version>3.5</version>";
    assert.deepEqual(applyExactPinEdit(`${block}${block}`, dependency, "3.5", "3.12.0", "maven"), { ok: false, reason: "edit-not-unique" });
  });
});

describe("applyExactPinEdit (PyPI)", () => {
  const dependency = dep({ ecosystem: "pypi", name: "Requests", manifest: "requirements.txt", declaredSpec: "2.19.0", exactVersion: "2.19.0" });

  it("rewrites a requirements line, matching case and separators (PEP 503)", () => {
    const text = "# pinned\nrequests==2.19.0  # http client\nflask==2.0.0\n";
    const result = applyExactPinEdit(text, dependency, "2.19.0", "2.32.3", "pypi-requirements");
    assertOk(result);
    assert.equal(result.text, "# pinned\nrequests==2.32.3  # http client\nflask==2.0.0\n");
  });

  it("keeps extras and environment markers intact", () => {
    const text = 'requests[socks]==2.19.0; python_version >= "3.8"\n';
    const result = applyExactPinEdit(text, dependency, "2.19.0", "2.32.3", "pypi-requirements");
    assertOk(result);
    assert.equal(result.text, 'requests[socks]==2.32.3; python_version >= "3.8"\n');
  });

  it("refuses range specifiers", () => {
    assert.deepEqual(applyExactPinEdit("requests>=2.19.0\n", dependency, "2.19.0", "2.32.3", "pypi-requirements"), { ok: false, reason: "edit-not-found" });
  });

  it("rewrites a PEP 621 string in pyproject dependencies", () => {
    const toml = '[project]\ndependencies = [\n  "requests==2.19.0",\n  "click>=8",\n]\n';
    const result = applyExactPinEdit(toml, dependency, "2.19.0", "2.32.3", "pypi-pyproject");
    assertOk(result);
    assert.match(result.text, /"requests==2\.32\.3",/);
  });

  it("does not match a longer package name that starts with the same text", () => {
    const text = "requests-toolbelt==2.19.0\n";
    assert.deepEqual(applyExactPinEdit(text, dependency, "2.19.0", "2.32.3", "pypi-requirements"), { ok: false, reason: "edit-not-found" });
  });
});
