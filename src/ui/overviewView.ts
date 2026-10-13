import * as vscode from "vscode";
import { buildOverviewRows, type OverviewRow, type OverviewState } from "./overviewModel";

/** Tree data provider for the PatchPilot overview. Every row reflects a checked state. */
export class OverviewTreeProvider implements vscode.TreeDataProvider<OverviewRow> {
  private readonly changeEmitter = new vscode.EventEmitter<OverviewRow | undefined>();
  readonly onDidChangeTreeData = this.changeEmitter.event;

  constructor(private readonly loadState: () => Promise<OverviewState>) {}

  refresh(): void {
    this.changeEmitter.fire(undefined);
  }

  async getChildren(element?: OverviewRow): Promise<OverviewRow[]> {
    if (element !== undefined) {
      return [];
    }
    try {
      return buildOverviewRows(await this.loadState());
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return [
        {
          id: "error",
          label: "Overview unavailable",
          description: "Error",
          tooltip: `PatchPilot could not read its state: ${message}`,
          icon: "error",
          command: undefined
        }
      ];
    }
  }

  getTreeItem(row: OverviewRow): vscode.TreeItem {
    const item = new vscode.TreeItem(row.label, vscode.TreeItemCollapsibleState.None);
    item.id = row.id;
    item.description = row.description;
    item.tooltip = row.tooltip;
    item.iconPath = new vscode.ThemeIcon(row.icon);
    item.contextValue = row.id;
    item.accessibilityInformation = { label: `${row.label}: ${row.description}. ${row.tooltip}` };
    if (row.command !== undefined) {
      item.command = { command: row.command, title: row.label };
    }
    return item;
  }
}
