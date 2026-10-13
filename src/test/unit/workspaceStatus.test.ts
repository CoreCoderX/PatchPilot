import * as assert from "node:assert/strict";
import { describe, it } from "mocha";
import { buildStatusReport } from "../../workspaceStatus";

describe("buildStatusReport", () => {
  it("reports a trusted workspace with folders and permits approved execution", () => {
    const report = buildStatusReport({
      isTrusted: true,
      folderPaths: ["/work/a", "/work/b"],
      extensionVersion: "0.1.0"
    });

    assert.equal(report.executionAllowed, true);
    assert.ok(report.lines.includes("Workspace trust: trusted"));
    assert.ok(report.lines.some((line) => line.startsWith("Workspace folders (2): /work/a, /work/b")));
    assert.ok(report.lines[0]?.includes("0.1.0"));
  });

  it("blocks project-executing operations in an untrusted workspace", () => {
    const report = buildStatusReport({
      isTrusted: false,
      folderPaths: ["/work/a"],
      extensionVersion: "0.1.0"
    });

    assert.equal(report.executionAllowed, false);
    assert.ok(report.lines.includes("Workspace trust: restricted (untrusted)"));
    assert.ok(
      report.lines.some((line) => line.includes("blocked until the workspace is trusted"))
    );
  });

  it("states clearly when no folder is open", () => {
    const report = buildStatusReport({
      isTrusted: true,
      folderPaths: [],
      extensionVersion: "0.1.0"
    });

    assert.ok(report.lines.includes("Workspace folders: none open"));
  });

  it("describes dependency analysis as read-only and gated by trust", () => {
    const report = buildStatusReport({
      isTrusted: true,
      folderPaths: [],
      extensionVersion: "0.1.0"
    });

    assert.ok(report.lines.some((line) => line.includes("Dependency analysis: read-only")));
    const restricted = buildStatusReport({ isTrusted: false, folderPaths: [], extensionVersion: "0.3.0" });
    assert.ok(restricted.lines.some((line) => line.startsWith("Dependency analysis: blocked until")));
  });
});
