import * as vscode from "vscode";
import { createLiveClients } from "./analysis/clients";
import type { WorkspaceFile } from "./analysis/runner";
import { analyzeDependencies, type AnalyzeDeps } from "./commands/analyzeCommand";
import {
  planUpgrade,
  repairWithModel,
  reviewAndApply,
  rollbackChanges,
  validateChanges,
  type RepairConfig,
  type UpgradeDeps
} from "./commands/upgradeCommands";
import { OpenAICompatibleProvider } from "./ai/openaiCompatible";
import { createExecutor } from "./upgrade/workflow";
import { SnapshotStore, type PlanRecord } from "./upgrade/store";
import { MAX_COMMAND_OUTPUT_BYTES, validateUpgradeSettings } from "./config/upgradeSettings";
import { PlanTreeProvider } from "./ui/planView";
import { ProposedContentProvider, PROPOSED_SCHEME } from "./ui/diffPreview";
import { VsCodeUpgradeUi } from "./ui/vscodeUpgradeUi";
import type { AnalysisResult } from "./analysis/types";
import * as path from "node:path";
import {
  clearApiKey,
  setApiKey,
  testConnection,
  type ModelCommandDeps
} from "./commands/modelCommands";
import { validateAiSettings } from "./config/aiSettings";
import { describeUnknownError, RedactingLogger } from "./log";
import { ApiKeyStore } from "./secrets/apiKeyStore";
import { effectiveExcludePatterns } from "./security/exclusions";
import type { LastConnectionTest, OverviewRow, OverviewState } from "./ui/overviewModel";
import { buildResultNodes } from "./ui/dependencyModel";
import { DependencyTreeProvider } from "./ui/dependencyView";
import { OverviewTreeProvider } from "./ui/overviewView";
import { VsCodeModelUi } from "./ui/vscodeModelUi";
import { buildStatusReport } from "./workspaceStatus";
import { WorkflowTreeProvider } from "./ui/workflowView";
import type { PlanProgress, WorkflowNode, WorkflowState } from "./ui/workflowModel";

export const SHOW_STATUS_COMMAND = "patchpilot.showStatus";
const PROVIDER_ID = "openai-compatible";

/** Handles exposed to the Extension Host smoke test. Not part of the user-facing API. */
export interface PatchPilotTestApi {
  readonly keyStore: ApiKeyStore;
  readonly overviewRows: () => Promise<OverviewRow[]>;
  readonly workflowNodes: () => Promise<readonly WorkflowNode[]>;
}

export function activate(context: vscode.ExtensionContext): PatchPilotTestApi {
  const output = vscode.window.createOutputChannel("PatchPilot");
  context.subscriptions.push(output);

  const extensionVersion = readVersion(context);
  const keyStore = new ApiKeyStore(context.secrets, PROVIDER_ID);
  const log = new RedactingLogger(output, () => keyStore.knownSecretValues());
  const ui = new VsCodeModelUi();
  let lastTest: LastConnectionTest | undefined;

  const readSettings = (): ReturnType<typeof validateAiSettings> => {
    const config = vscode.workspace.getConfiguration("patchpilot.ai");
    return validateAiSettings({
      baseUrl: config.get<unknown>("baseUrl"),
      model: config.get<unknown>("model"),
      timeoutSeconds: config.get<unknown>("timeoutSeconds")
    });
  };
  const exclusionPatterns = (): string[] =>
    effectiveExcludePatterns(
      vscode.workspace
        .getConfiguration("patchpilot.context")
        .get<string[]>("excludePatterns", [])
    );

  const overview = new OverviewTreeProvider(async (): Promise<OverviewState> => {
    const settings = readSettings();
    // An empty model ID means "not configured yet", which is not an error.
    const unconfigured = vscode.workspace.getConfiguration("patchpilot.ai").get<string>("model", "").trim() === "";
    return {
      isTrusted: vscode.workspace.isTrusted,
      settingsError: settings.ok || unconfigured ? undefined : settings.message,
      endpointLabel: settings.ok ? settings.endpointLabel : undefined,
      model: settings.ok ? settings.settings.model : undefined,
      keyStored: await keyStore.has(),
      lastTest
    };
  });
  const treeView = vscode.window.createTreeView("patchpilot.overview", {
    treeDataProvider: overview,
    showCollapseAll: false
  });
  context.subscriptions.push(treeView);

  let lastResult: AnalysisResult | undefined;
  let latestRecord: PlanRecord | undefined;
  const dependencyTree = new DependencyTreeProvider();
  const dependencyView = vscode.window.createTreeView("patchpilot.dependencies", {
    treeDataProvider: dependencyTree,
    showCollapseAll: true
  });
  context.subscriptions.push(dependencyView, dependencyTree);

  const planTree = new PlanTreeProvider();
  const planView = vscode.window.createTreeView("patchpilot.plan", { treeDataProvider: planTree, showCollapseAll: true });
  const proposedContent = new ProposedContentProvider();
  context.subscriptions.push(planView, planTree, proposedContent, vscode.workspace.registerTextDocumentContentProvider(PROPOSED_SCHEME, proposedContent));
  const upgradeUi = new VsCodeUpgradeUi(() => singleRoot()?.fsPath, proposedContent);

  // The workflow view is the single place every command can be started from.
  const workflowTree = new WorkflowTreeProvider((): Promise<WorkflowState> =>
    loadWorkflowState({ latestRecord, lastResult, keyStore, readSettings })
  );
  const workflowView = vscode.window.createTreeView("patchpilot.workflow", {
    treeDataProvider: workflowTree,
    showCollapseAll: false
  });
  context.subscriptions.push(workflowView, workflowTree);
  const refreshWorkflow = (): void => {
    void workflowTree.refresh();
  };

  const deps: ModelCommandDeps = {
    keyStore,
    readSettings,
    exclusionPatterns,
    isTrusted: () => vscode.workspace.isTrusted,
    createProvider: (config) =>
      new OpenAICompatibleProvider({
        baseUrl: config.baseUrl,
        apiKey: config.apiKey,
        timeoutMs: config.timeoutMs
      }),
    ui,
    log,
    onTestRecorded: (test) => {
      lastTest = test;
      overview.refresh();
      refreshWorkflow();
    },
    onKeyChanged: () => {
      overview.refresh();
      refreshWorkflow();
    },
    now: () => new Date()
  };

  const runAnalysis = (): ReturnType<typeof analyzeDependencies> =>
    analyzeDependencies(analyzeDeps());

  const analyzeDeps = (): AnalyzeDeps => ({
    isTrusted: () => vscode.workspace.isTrusted,
    findFiles: findManifestFiles,
    createClients: () =>
      createLiveClients({
        fetchImpl: (url, init) => fetch(url, init),
        timeoutMs: ANALYSIS_TIMEOUT_MS,
        now: () => new Date()
      }),
    ui,
    log,
    now: () => new Date(),
    onResult: (result) => {
      lastResult = result;
      dependencyTree.setRoots(buildResultNodes(result));
      dependencyView.description = new Date(result.finishedAt).toLocaleTimeString();
      refreshWorkflow();
    }
  });

  const storage = context.storageUri ?? context.globalStorageUri;
  const store = new SnapshotStore(path.join(storage.fsPath, "upgrade"));
  const readSettingsRaw = (): ReturnType<typeof validateUpgradeSettings> => {
    const config = vscode.workspace.getConfiguration("patchpilot.upgrade");
    return validateUpgradeSettings({
      commandTimeoutSeconds: config.get<unknown>("commandTimeoutSeconds"),
      repairMaxIterations: config.get<unknown>("repairMaxIterations")
    });
  };
  const upgradeDeps = (): UpgradeDeps => {
    const root = singleRoot()?.fsPath;
    return {
      root,
      folderCount: vscode.workspace.workspaceFolders?.length ?? 0,
      isTrusted: () => vscode.workspace.isTrusted,
      ui: upgradeUi,
      log,
      store,
      now: () => new Date(),
      lastResult: () => lastResult,
      runAnalysis: async () => runAnalysis(),
      queryOsv: (queries, signal) =>
        createLiveClients({
          fetchImpl: (url, init) => fetch(url, init),
          timeoutMs: ANALYSIS_TIMEOUT_MS,
          now: () => new Date()
        }).queryOsv(queries, signal),
      settings: readSettingsRaw,
      workflow: (workflowRoot, settings) => ({
        root: workflowRoot,
        store,
        exec: createExecutor({
          root: workflowRoot,
          timeoutMs: settings.commandTimeoutMs,
          maxOutputBytes: MAX_COMMAND_OUTPUT_BYTES,
          knownSecrets: () => keyStore.knownSecretValues()
        }),
        now: () => new Date(),
        log: (message) => {
          log.info(message);
        }
      }),
      repairConfig: async (): Promise<{ ok: true; config: RepairConfig } | { ok: false; message: string }> => {
        const settings = readSettings();
        if (!settings.ok) {
          return { ok: false, message: settings.message };
        }
        const apiKey = await keyStore.get();
        if (apiKey === undefined) {
          return { ok: false, message: "Set a model API key first (PatchPilot: Set Model API Key)." };
        }
        const provider = new OpenAICompatibleProvider({
          baseUrl: settings.settings.baseUrl,
          apiKey,
          timeoutMs: settings.settings.timeoutSeconds * 1000
        });
        return { ok: true, config: { provider, model: settings.settings.model, exclusions: exclusionPatterns() } };
      },
      onRecordChanged: (record: PlanRecord | undefined) => {
        latestRecord = record;
        planTree.setRecord(record);
        refreshWorkflow();
      }
    };
  };
  void (async (): Promise<void> => {
    const latestId = await store.latestPlanId();
    const latest = latestId === undefined ? undefined : await store.loadRecord(latestId);
    latestRecord = latest;
    planTree.setRecord(latest);
    refreshWorkflow();
  })();

  const runGuarded = async (name: string, action: () => Promise<unknown>): Promise<void> => {
    try {
      await action();
    } catch (error) {
      const message = describeUnknownError(error);
      log.error(`${name} failed: ${message}`);
      ui.showError(`PatchPilot ${name} failed unexpectedly. See the PatchPilot output channel.`);
    }
  };

  context.subscriptions.push(
    vscode.commands.registerCommand(SHOW_STATUS_COMMAND, () => {
      const report = buildStatusReport({
        isTrusted: vscode.workspace.isTrusted,
        folderPaths: (vscode.workspace.workspaceFolders ?? []).map((folder) => folder.uri.fsPath),
        extensionVersion
      });
      output.clear();
      output.appendLine(report.title);
      for (const line of report.lines) {
        output.appendLine(`  ${line}`);
      }
      output.show(true);
    }),
    vscode.commands.registerCommand("patchpilot.setApiKey", () =>
      runGuarded("set API key", () => setApiKey(deps))
    ),
    vscode.commands.registerCommand("patchpilot.clearApiKey", () =>
      runGuarded("clear API key", () => clearApiKey(deps))
    ),
    vscode.commands.registerCommand("patchpilot.testConnection", () =>
      runGuarded("connection test", () => testConnection(deps))
    ),
    vscode.commands.registerCommand("patchpilot.analyzeDependencies", () =>
      runGuarded("dependency analysis", () => runAnalysis())
    ),
    vscode.commands.registerCommand("patchpilot.planUpgrade", () =>
      runGuarded("plan upgrade", () => planUpgrade(upgradeDeps()))
    ),
    vscode.commands.registerCommand("patchpilot.reviewAndApply", () =>
      runGuarded("apply plan", () => reviewAndApply(upgradeDeps()))
    ),
    vscode.commands.registerCommand("patchpilot.validateChanges", () =>
      runGuarded("validation", () => validateChanges(upgradeDeps()))
    ),
    vscode.commands.registerCommand("patchpilot.repairWithModel", () =>
      runGuarded("model repair", () => repairWithModel(upgradeDeps()))
    ),
    vscode.commands.registerCommand("patchpilot.rollbackChanges", () =>
      runGuarded("rollback", () => rollbackChanges(upgradeDeps()))
    ),
    vscode.commands.registerCommand("patchpilot.openModelSettings", () => {
      void vscode.commands.executeCommand("workbench.action.openSettings", "patchpilot");
    }),
    vscode.workspace.onDidChangeConfiguration((event) => {
      if (event.affectsConfiguration("patchpilot")) {
        overview.refresh();
        refreshWorkflow();
      }
    }),
    vscode.workspace.onDidGrantWorkspaceTrust(() => {
      overview.refresh();
      refreshWorkflow();
    }),
    vscode.workspace.onDidChangeWorkspaceFolders(() => {
      refreshWorkflow();
    })
  );

  return {
    keyStore,
    overviewRows: () => overview.getChildren(),
    workflowNodes: async () => {
      await workflowTree.refresh();
      return workflowTree.getChildren();
    }
  };
}

const ANALYSIS_TIMEOUT_MS = 20_000;

/** Inputs the workflow view needs. Kept as one object so the reader sees every dependency. */
interface WorkflowStateSource {
  readonly latestRecord: PlanRecord | undefined;
  readonly lastResult: AnalysisResult | undefined;
  readonly keyStore: ApiKeyStore;
  readonly readSettings: () => ReturnType<typeof validateAiSettings>;
}

/** Snapshots the facts the workflow view describes. Reads secret storage and config only. */
async function loadWorkflowState(source: WorkflowStateSource): Promise<WorkflowState> {
  const { latestRecord, lastResult, keyStore, readSettings } = source;
  const settings = readSettings();
  const plan: PlanProgress | undefined =
    latestRecord === undefined
      ? undefined
      : {
          id: latestRecord.plan.id,
          status: latestRecord.plan.status,
          hasUnrolledSteps: latestRecord.steps.some((step) => !step.rolledBack)
        };
  return {
    isTrusted: vscode.workspace.isTrusted,
    folderCount: vscode.workspace.workspaceFolders?.length ?? 0,
    hasAnalysis: lastResult !== undefined,
    plan,
    keyStored: await keyStore.has(),
    modelConfigured: settings.ok
  };
}

const MANIFEST_GLOB =
  "{**/package.json,**/package-lock.json,**/pom.xml,**/pyproject.toml,**/requirements*.txt,**/Pipfile,**/Pipfile.lock,**/setup.py,**/setup.cfg,**/yarn.lock,**/pnpm-lock.yaml,**/bun.lockb,**/poetry.lock,**/build.gradle,**/build.gradle.kts,**/settings.gradle,**/settings.gradle.kts,**/gradle.lockfile}";
const EXCLUDE_GLOB =
  "**/{node_modules,.git,.venv,venv,__pycache__,.tox,.nox,target,build,dist,out,bin,obj,.gradle,.next,.nuxt,coverage,vendor}/**";
const MAX_CANDIDATE_FILES = 5000;

/** Finds candidate manifest and lock files in the workspace. Reads nothing; sizes come from stat. */
async function findManifestFiles(): Promise<WorkspaceFile[]> {
  const uris = await vscode.workspace.findFiles(MANIFEST_GLOB, EXCLUDE_GLOB, MAX_CANDIDATE_FILES);
  // In multi-root workspaces, include the folder name so identical relative paths stay distinct.
  const multiRoot = (vscode.workspace.workspaceFolders?.length ?? 0) > 1;
  const files: WorkspaceFile[] = [];
  for (const uri of uris) {
    const stat = await vscode.workspace.fs.stat(uri);
    files.push({
      path: vscode.workspace.asRelativePath(uri, multiRoot),
      size: stat.size,
      read: async () => new TextDecoder("utf-8").decode(await vscode.workspace.fs.readFile(uri))
    });
  }
  return files;
}

export function deactivate(): void {
  // Disposables registered on the context are released by VS Code.
}

/** The one workspace folder, or undefined. Multi-root workspaces are refused by the upgrade commands. */
function singleRoot(): vscode.Uri | undefined {
  const folders = vscode.workspace.workspaceFolders;
  return folders?.length === 1 ? folders[0]?.uri : undefined;
}

function readVersion(context: vscode.ExtensionContext): string {
  const manifest: unknown = context.extension.packageJSON;
  if (typeof manifest === "object" && manifest !== null && "version" in manifest) {
    const version: unknown = manifest.version;
    if (typeof version === "string") {
      return version;
    }
  }
  return "unknown";
}
