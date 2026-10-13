import * as vscode from "vscode";
import type { PlanRecord } from "../upgrade/store";
import { buildPlanNodes, type PlanNode } from "./planModel";

export class PlanTreeProvider implements vscode.TreeDataProvider<PlanNode> {
  private readonly changed = new vscode.EventEmitter<PlanNode | undefined>();
  readonly onDidChangeTreeData = this.changed.event;
  private roots: PlanNode[] = buildPlanNodes(undefined);

  setRecord(record: PlanRecord | undefined): void {
    this.roots = buildPlanNodes(record);
    this.changed.fire(undefined);
  }

  getTreeItem(node: PlanNode): vscode.TreeItem {
    const collapsible = node.children.length > 0
      ? node.kind === "section" || node.kind === "header"
        ? vscode.TreeItemCollapsibleState.Expanded
        : vscode.TreeItemCollapsibleState.Collapsed
      : vscode.TreeItemCollapsibleState.None;
    const item = new vscode.TreeItem(node.label, collapsible);
    if (node.description !== undefined) {
      item.description = node.description;
    }
    if (node.tooltip !== undefined) {
      item.tooltip = node.tooltip;
    }
    if (node.command !== undefined) {
      item.command = { command: node.command, title: node.label };
    }
    item.contextValue = `patchpilot.plan.${node.kind}`;
    return item;
  }

  getChildren(node?: PlanNode): PlanNode[] {
    return node === undefined ? this.roots : [...node.children];
  }

  dispose(): void {
    this.changed.dispose();
  }
}
