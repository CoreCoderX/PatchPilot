import * as vscode from "vscode";
import {
  buildWorkflowNodes,
  type WorkflowNode,
  type WorkflowState,
  type WorkflowStepState
} from "./workflowModel";

/**
 * Tree of the actionable workflow. Every row runs its command on click, so the whole
 * extension can be driven from this view without opening the Command Palette.
 */
export class WorkflowTreeProvider implements vscode.TreeDataProvider<WorkflowNode> {
  private readonly changed = new vscode.EventEmitter<WorkflowNode | undefined>();
  readonly onDidChangeTreeData = this.changed.event;
  private roots: readonly WorkflowNode[];

  constructor(loadState: () => Promise<WorkflowState>) {
    this.loadState = loadState;
    this.roots = buildWorkflowNodes(EMPTY_STATE);
    void this.reload();
  }

  private readonly loadState: () => Promise<WorkflowState>;

  async refresh(): Promise<void> {
    await this.reload();
  }

  private async reload(): Promise<void> {
    let state: WorkflowState;
    try {
      state = await this.loadState();
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.roots = [
        {
          kind: "step",
          id: "error",
          label: "Workflow unavailable",
          description: "Error",
          tooltip: `PatchPilot could not read its state: ${message}`,
          icon: "error",
          command: "patchpilot.showStatus",
          state: "waiting",
          isNext: false
        }
      ];
      this.changed.fire(undefined);
      return;
    }
    this.roots = buildWorkflowNodes(state);
    this.changed.fire(undefined);
  }

  getTreeItem(node: WorkflowNode): vscode.TreeItem {
    if (node.kind === "group") {
      const group = new vscode.TreeItem(node.label, vscode.TreeItemCollapsibleState.Expanded);
      group.id = node.id;
      group.description = node.description;
      group.tooltip = node.tooltip;
      group.iconPath = new vscode.ThemeIcon(node.icon);
      group.contextValue = `patchpilot.group.${node.id}`;
      group.accessibilityInformation = { label: `${node.label}: ${node.description}. ${node.tooltip}` };
      return group;
    }
    const item = new vscode.TreeItem(node.label, vscode.TreeItemCollapsibleState.None);
    item.id = `patchpilot.step.${node.id}`;
    item.description = node.description;
    item.tooltip = node.tooltip;
    item.iconPath = new vscode.ThemeIcon(node.icon, new vscode.ThemeColor(ICON_COLOR[node.state]));
    item.contextValue = `patchpilot.step.${node.state}`;
    item.command = { command: node.command, title: node.label };
    item.accessibilityInformation = {
      label: `${node.label}: ${node.description}. ${node.state === "ready" ? "Runs this step." : "Needs an earlier step."} ${node.tooltip}`
    };
    if (node.isNext) {
      item.description = `${node.description}  (next)`;
    }
    return item;
  }

  getChildren(node?: WorkflowNode): WorkflowNode[] {
    if (node === undefined) {
      return [...this.roots];
    }
    return node.kind === "group" ? [...node.children] : [];
  }

  dispose(): void {
    this.changed.dispose();
  }
}

const EMPTY_STATE: WorkflowState = {
  isTrusted: false,
  folderCount: 0,
  hasAnalysis: false,
  plan: undefined,
  keyStored: false,
  modelConfigured: false
};

const ICON_COLOR: Readonly<Record<WorkflowStepState, string>> = {
  ready: "charts.green",
  waiting: "charts.grey",
  done: "charts.blue"
};
