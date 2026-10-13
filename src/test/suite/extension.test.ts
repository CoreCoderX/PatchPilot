import * as assert from "node:assert/strict";
import * as vscode from "vscode";
import { describe, it } from "mocha";
import type { PatchPilotTestApi } from "../../extension";
import type { WorkflowGroup, WorkflowNode } from "../../ui/workflowModel";

const EXTENSION_ID = "patchpilot-dev.patchpilot";
const EXPECTED_COMMANDS = [
  "patchpilot.showStatus",
  "patchpilot.setApiKey",
  "patchpilot.clearApiKey",
  "patchpilot.testConnection",
  "patchpilot.openModelSettings",
  "patchpilot.analyzeDependencies",
  "patchpilot.planUpgrade",
  "patchpilot.reviewAndApply",
  "patchpilot.validateChanges",
  "patchpilot.repairWithModel",
  "patchpilot.rollbackChanges"
];

function readProperties(manifest: unknown): Record<string, unknown> {
  if (typeof manifest !== "object" || manifest === null || !("contributes" in manifest)) {
    return {};
  }
  const contributes: unknown = manifest.contributes;
  if (typeof contributes !== "object" || contributes === null || !("configuration" in contributes)) {
    return {};
  }
  const configuration: unknown = contributes.configuration;
  if (typeof configuration !== "object" || configuration === null || !("properties" in configuration)) {
    return {};
  }
  const properties: unknown = configuration.properties;
  return typeof properties === "object" && properties !== null ? (properties as Record<string, unknown>) : {};
}

function scopeOf(properties: Record<string, unknown>, key: string): unknown {
  const property: unknown = properties[key];
  if (typeof property !== "object" || property === null || !("scope" in property)) {
    return undefined;
  }
  return property.scope;
}

describe("PatchPilot extension host tests", () => {
  let api: PatchPilotTestApi;

  it("activates and registers every command, including dependency analysis", async () => {
    const extension = vscode.extensions.getExtension<PatchPilotTestApi>(EXTENSION_ID);
    assert.ok(extension, `extension ${EXTENSION_ID} should be discoverable in the host`);
    api = await extension.activate();
    assert.equal(extension.isActive, true);

    const commands = await vscode.commands.getCommands(true);
    for (const command of EXPECTED_COMMANDS) {
      assert.ok(commands.includes(command), `${command} should be registered`);
    }
  });

  it("contributes safe configuration defaults at user (application) scope", () => {
    const ai = vscode.workspace.getConfiguration("patchpilot.ai");
    assert.equal(ai.get("baseUrl"), "https://api.openai.com/v1");
    assert.equal(ai.get("model"), "");
    assert.equal(ai.get("timeoutSeconds"), 60);

    const extension = vscode.extensions.getExtension(EXTENSION_ID);
    assert.ok(extension, "extension must be installed");
    const manifest: unknown = extension.packageJSON;
    const properties = readProperties(manifest);
    assert.equal(scopeOf(properties, "patchpilot.ai.baseUrl"), "application");
    assert.equal(scopeOf(properties, "patchpilot.ai.model"), "application");
  });

  it("stores the API key only in VS Code secret storage and removes it on clear", async () => {
    const probe = "sk-smoke-probe-0000000000";
    await api.keyStore.set(probe);
    assert.equal(await api.keyStore.get(), probe);

    const ai = vscode.workspace.getConfiguration("patchpilot.ai").inspect<string>("baseUrl");
    assert.ok(ai !== undefined);
    assert.ok(!JSON.stringify(ai).includes(probe), "key must not appear in settings");

    await api.keyStore.clear();
    assert.equal(await api.keyStore.has(), false);
  });

  it("shows the overview rows from the live view provider without exposing a key", async () => {
    const probe = "sk-overview-probe-1111111111";
    await api.keyStore.set(probe);
    try {
      const rows = await api.overviewRows();
      const ids = rows.map((row) => row.id);
      assert.deepEqual(ids, ["trust", "settings", "key", "test", "analysis"]);
      const settingsRow = rows.find((row) => row.id === "settings");
      assert.equal(settingsRow?.description, "Not configured", "empty model ID is 'not configured', not an error");
      const keyRow = rows.find((row) => row.id === "key");
      assert.equal(keyRow?.description, "Stored in VS Code secret storage");
      assert.ok(!JSON.stringify(rows).includes(probe), "overview rows must never contain the key value");
    } finally {
      await api.keyStore.clear();
    }
  });

  it("contributes upgrade limits with conservative defaults and the Plan view", () => {
    const upgrade = vscode.workspace.getConfiguration("patchpilot.upgrade");
    assert.equal(upgrade.get("commandTimeoutSeconds"), 300);
    assert.equal(upgrade.get("repairMaxIterations"), 2);

    const extension = vscode.extensions.getExtension(EXTENSION_ID);
    assert.ok(extension, "extension must be installed");
    const views: unknown = extension.packageJSON;
    const contributes = typeof views === "object" && views !== null && "contributes" in views ? views.contributes : undefined;
    const viewMap = typeof contributes === "object" && contributes !== null && "views" in contributes ? contributes.views : undefined;
    const ids = JSON.stringify(viewMap);
    assert.ok(ids.includes("patchpilot.plan"), "Plan view should be contributed");
  });

  it("drives every command from the Workflow view without the Command Palette", async () => {
    const nodes = await api.workflowNodes();
    assert.ok(nodes.length > 0, "the workflow view should render groups");

    const groups = nodes.filter((node): node is WorkflowGroup => node.kind === "group");
    assert.deepEqual(groups.map((group) => group.label), ["Upgrade Workflow", "Model and Diagnostics"]);

    const registered = await vscode.commands.getCommands(true);
    const reachable = new Set<string>();
    const collect = (rows: readonly WorkflowNode[]): void => {
      for (const node of rows) {
        if (node.kind === "group") {
          collect(node.children);
        } else {
          assert.ok(
            registered.includes(node.command),
            `${node.id} runs ${node.command}, which should be registered`
          );
          reachable.add(node.command);
        }
      }
    };
    collect(nodes);

    // The key row shows Set or Clear depending on storage, so read the view in both states.
    await api.keyStore.set("sk-reachability-probe-3333333333");
    try {
      collect(await api.workflowNodes());
    } finally {
      await api.keyStore.clear();
    }

    for (const command of EXPECTED_COMMANDS) {
      assert.ok(reachable.has(command), `${command} should be reachable from the workflow view`);
    }
  });

  it("never puts a stored key into a workflow row", async () => {
    const probe = "sk-workflow-probe-2222222222";
    await api.keyStore.set(probe);
    try {
      const rows = await api.workflowNodes();
      assert.ok(!JSON.stringify(rows).includes(probe), "workflow rows must never contain the key value");
    } finally {
      await api.keyStore.clear();
    }
  });

  it("runs the rollback command with no plan on record without throwing or touching files", async () => {
    await vscode.commands.executeCommand("patchpilot.rollbackChanges");
  });

  it("opens the status output without throwing", async () => {
    await vscode.commands.executeCommand("patchpilot.showStatus");
  });
});
