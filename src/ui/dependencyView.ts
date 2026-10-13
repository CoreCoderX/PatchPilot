import * as vscode from "vscode";
import type { ResultNode } from "./dependencyModel";

const EMPTY_NODE: ResultNode = {
  id: "empty",
  label: "No analysis yet",
  description: "Run \"PatchPilot: Analyze Dependencies\"",
  severity: "info",
  children: []
};

/** Tree of the latest dependency analysis. Holds display nodes only; no network access. */
export class DependencyTreeProvider implements vscode.TreeDataProvider<ResultNode> {
  private readonly changed = new vscode.EventEmitter<ResultNode | undefined>();
  readonly onDidChangeTreeData = this.changed.event;
  private roots: readonly ResultNode[] = [EMPTY_NODE];

  setRoots(roots: readonly ResultNode[]): void {
    this.roots = roots.length === 0 ? [EMPTY_NODE] : roots;
    this.changed.fire(undefined);
  }

  getTreeItem(node: ResultNode): vscode.TreeItem {
    const item = new vscode.TreeItem(
      node.label,
      node.children.length > 0 ? vscode.TreeItemCollapsibleState.Collapsed : vscode.TreeItemCollapsibleState.None
    );
    item.id = node.id;
    if (node.description !== undefined) {
      item.description = node.description;
    }
    item.tooltip = node.tooltip === undefined ? undefined : new vscode.MarkdownString().appendText(node.tooltip);
    item.iconPath = new vscode.ThemeIcon(ICON[node.severity]);
    item.contextValue = `patchpilot.result.${node.severity}`;
    return item;
  }

  getChildren(node?: ResultNode): ResultNode[] {
    return node === undefined ? [...this.roots] : [...node.children];
  }

  dispose(): void {
    this.changed.dispose();
  }
}

const ICON: Readonly<Record<ResultNode["severity"], string>> = {
  problem: "error",
  warning: "warning",
  info: "info",
  ok: "pass"
};
