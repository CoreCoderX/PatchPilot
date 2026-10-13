/**
 * Pure model for the PatchPilot overview view. It contains only facts that were actually
 * checked: trust state, validated settings, presence of a stored key (never its value),
 * and the outcome of the last connection test run in this session.
 */
export interface LastConnectionTest {
  readonly succeeded: boolean;
  readonly summary: string;
  readonly at: Date;
}

export interface OverviewState {
  readonly isTrusted: boolean;
  readonly settingsError: string | undefined;
  readonly endpointLabel: string | undefined;
  readonly model: string | undefined;
  readonly keyStored: boolean;
  readonly lastTest: LastConnectionTest | undefined;
}

export type OverviewCommandId =
  | "patchpilot.testConnection"
  | "patchpilot.setApiKey"
  | "patchpilot.clearApiKey"
  | "patchpilot.openModelSettings"
  | "patchpilot.showStatus"
  | "patchpilot.analyzeDependencies";

export interface OverviewRow {
  readonly id: string;
  readonly label: string;
  readonly description: string;
  readonly tooltip: string;
  readonly icon: string;
  readonly command: OverviewCommandId | undefined;
}

export function buildOverviewRows(state: OverviewState): OverviewRow[] {
  const rows: OverviewRow[] = [];

  rows.push({
    id: "trust",
    label: "Workspace trust",
    description: state.isTrusted ? "Trusted" : "Restricted",
    tooltip: state.isTrusted
      ? "This workspace is trusted. Actions that send workspace content are allowed."
      : "Restricted mode. Actions that send workspace content are blocked until you trust this folder.",
    icon: state.isTrusted ? "shield" : "warning",
    command: "patchpilot.showStatus"
  });

  if (state.settingsError !== undefined) {
    rows.push({
      id: "settings",
      label: "Model settings",
      description: "Invalid",
      tooltip: state.settingsError,
      icon: "error",
      command: "patchpilot.openModelSettings"
    });
  } else if (state.endpointLabel !== undefined && state.model !== undefined) {
    rows.push({
      id: "settings",
      label: "Model endpoint",
      description: `${state.model} at ${state.endpointLabel}`,
      tooltip: `Requests go to ${state.endpointLabel} using model ${state.model}. Change in settings (patchpilot.ai).`,
      icon: "server",
      command: "patchpilot.openModelSettings"
    });
  } else {
    rows.push({
      id: "settings",
      label: "Model endpoint",
      description: "Not configured",
      tooltip: "Set patchpilot.ai.model and, if needed, patchpilot.ai.baseUrl.",
      icon: "gear",
      command: "patchpilot.openModelSettings"
    });
  }

  rows.push({
    id: "key",
    label: "API key",
    description: state.keyStored ? "Stored in VS Code secret storage" : "Not set",
    tooltip: state.keyStored
      ? "A key is stored securely. Its value is never displayed."
      : "No key is stored. Use Set Model API Key to add one.",
    icon: state.keyStored ? "key" : "circle-slash",
    command: state.keyStored ? "patchpilot.clearApiKey" : "patchpilot.setApiKey"
  });

  const lastTest = state.lastTest;
  rows.push({
    id: "test",
    label: "Last connection test",
    description: lastTest === undefined ? "Not run this session" : lastTest.succeeded ? "Passed" : "Failed",
    tooltip:
      lastTest === undefined
        ? "Run Test Model Connection to check the endpoint with a fixed prompt."
        : `${lastTest.summary} (${lastTest.at.toLocaleTimeString()})`,
    icon: lastTest?.succeeded === false ? "error" : "pulse",
    command: "patchpilot.testConnection"
  });

  rows.push({
    id: "analysis",
    label: "Dependency analysis",
    description: state.isTrusted ? "Ready" : "Needs trusted workspace",
    tooltip: state.isTrusted
      ? "Reads manifests and lockfiles locally, then asks before any registry or OSV lookup. Read-only."
      : "Dependency analysis reads project files, so it is available only in a trusted workspace.",
    icon: state.isTrusted ? "search" : "lock",
    command: "patchpilot.analyzeDependencies"
  });

  return rows;
}
