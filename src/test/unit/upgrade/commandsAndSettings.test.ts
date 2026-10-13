import * as assert from "node:assert/strict";
import * as path from "node:path";
import { describe, it } from "mocha";
import { assertOk } from "../helpers";
import { buildCommand, checkCommand, executableFor, COMMAND_TEMPLATES } from "../../../upgrade/commands";
import { validateUpgradeSettings, DEFAULT_COMMAND_TIMEOUT_SECONDS } from "../../../config/upgradeSettings";

const ROOT = path.resolve("/tmp/pp-root");

describe("command templates", () => {
  it("contains only fixed argv templates and no shell-like executables", () => {
    for (const template of Object.values(COMMAND_TEMPLATES)) {
      assert.ok(["npm", "mvn", "python"].includes(template.executable));
      for (const arg of template.args) {
        assert.doesNotMatch(arg, /[;&|`$<>]/, arg);
      }
    }
  });

  it("marks only the lockfile refresh as apply-phase", () => {
    const applyPhase = Object.values(COMMAND_TEMPLATES).filter((t) => t.phase === "apply").map((t) => t.id);
    assert.deepEqual(applyPhase, ["npm-lock-refresh"]);
    assert.deepEqual(COMMAND_TEMPLATES["npm-lock-refresh"].args, ["install", "--package-lock-only", "--ignore-scripts", "--no-audit", "--no-fund"]);
  });

  it("uses the Windows shim name only on Windows", () => {
    assert.equal(executableFor(COMMAND_TEMPLATES["npm-test"], "linux"), "npm");
    assert.equal(executableFor(COMMAND_TEMPLATES["npm-test"], "win32"), "npm.cmd");
    assert.equal(executableFor(COMMAND_TEMPLATES["pypi-pytest"], "linux"), "python3");
  });

  it("requires a plain file name for pip dry-run", () => {
    const command = buildCommand("pypi-pip-dry-run@.", "pypi-pip-dry-run", ".", "requirements.txt");
    assert.equal(command.displayLine, `. $ ${executableFor(COMMAND_TEMPLATES["pypi-pip-dry-run"])} -m pip install --dry-run --quiet -r requirements.txt`);
    assert.throws(() => buildCommand("x", "pypi-pip-dry-run", ".", "../evil.txt"));
    assert.throws(() => buildCommand("x", "pypi-pip-dry-run", ".", undefined));
  });
});

describe("checkCommand", () => {
  it("accepts a relative directory inside the workspace", () => {
    assert.deepEqual(checkCommand(buildCommand("t", "npm-test", "packages/web", undefined), ROOT), { ok: true });
    assert.deepEqual(checkCommand(buildCommand("t", "npm-test", ".", undefined), ROOT), { ok: true });
  });

  it("refuses absolute paths and parent traversal", () => {
    const absolute = { ...buildCommand("t", "npm-test", ".", undefined), cwd: "/etc" };
    assert.equal(checkCommand(absolute, ROOT).ok, false);
    const traversal = { ...buildCommand("t", "npm-test", ".", undefined), cwd: "../elsewhere" };
    assert.equal(checkCommand(traversal, ROOT).ok, false);
  });

  it("refuses a file argument that is not a plain name", () => {
    const bad = { ...buildCommand("t", "pypi-pip-dry-run", ".", "requirements.txt"), fileArg: "a b;rm" };
    assert.equal(checkCommand(bad, ROOT).ok, false);
  });
});

describe("validateUpgradeSettings", () => {
  it("uses conservative defaults when values are missing", () => {
    const result = validateUpgradeSettings({});
    assertOk(result);
    assert.equal(result.settings.commandTimeoutMs, DEFAULT_COMMAND_TIMEOUT_SECONDS * 1000);
    assert.equal(result.settings.repairMaxIterations, 2);
  });

  it("rejects out-of-range values rather than clamping them", () => {
    assert.equal(validateUpgradeSettings({ commandTimeoutSeconds: 5 }).ok, false);
    assert.equal(validateUpgradeSettings({ commandTimeoutSeconds: 4000 }).ok, false);
    assert.equal(validateUpgradeSettings({ repairMaxIterations: 0 }).ok, false);
    assert.equal(validateUpgradeSettings({ repairMaxIterations: 1.5 }).ok, false);
  });
});
