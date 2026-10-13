/**
 * Pure, dependency-free workspace status model. It has no `vscode` import so it
 * can be unit-tested with plain Node. It only describes the environment; it
 * performs no scanning, no file reads, and no command execution.
 */

export interface WorkspaceSnapshot {
  readonly isTrusted: boolean;
  readonly folderPaths: readonly string[];
  readonly extensionVersion: string;
}

export interface StatusReport {
  readonly title: string;
  readonly lines: readonly string[];
  /** Whether analysis operations that execute project code are allowed right now. */
  readonly executionAllowed: boolean;
}

export function buildStatusReport(snapshot: WorkspaceSnapshot): StatusReport {
  const folderCount = snapshot.folderPaths.length;
  const lines: string[] = [
    `PatchPilot ${snapshot.extensionVersion}`,
    `Workspace trust: ${snapshot.isTrusted ? "trusted" : "restricted (untrusted)"}`,
    folderCount === 0
      ? "Workspace folders: none open"
      : `Workspace folders (${String(folderCount)}): ${snapshot.folderPaths.join(", ")}`,
    snapshot.isTrusted
      ? "Project-executing operations: none implemented yet; they will require your approval"
      : "Project-executing operations: blocked until the workspace is trusted",
    "Model-backed actions: available after you configure an endpoint and key; each send asks first",
    snapshot.isTrusted
      ? "Dependency analysis: read-only; network lookups are shown and need your approval each run"
      : "Dependency analysis: blocked until the workspace is trusted (it reads project files)"
  ];

  return {
    title: "PatchPilot workspace status",
    lines,
    executionAllowed: snapshot.isTrusted
  };
}
