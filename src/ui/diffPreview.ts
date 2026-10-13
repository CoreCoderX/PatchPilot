import * as vscode from "vscode";

export const PROPOSED_SCHEME = "patchpilot-proposed";

/** Serves proposed file contents for VS Code diff editors. Content lives in memory only. */
export class ProposedContentProvider implements vscode.TextDocumentContentProvider {
  private readonly contents = new Map<string, string>();
  private readonly changed = new vscode.EventEmitter<vscode.Uri>();
  readonly onDidChange = this.changed.event;

  provideTextDocumentContent(uri: vscode.Uri): string {
    return this.contents.get(uri.path) ?? "";
  }

  /** Opens a diff between the current file and the proposed text. */
  async open(workspaceRelativePath: string, absolutePath: string, proposedText: string): Promise<void> {
    const key = `/${workspaceRelativePath}`;
    this.contents.set(key, proposedText);
    const proposedUri = vscode.Uri.from({ scheme: PROPOSED_SCHEME, path: key });
    this.changed.fire(proposedUri);
    await vscode.commands.executeCommand(
      "vscode.diff",
      vscode.Uri.file(absolutePath),
      proposedUri,
      `PatchPilot: ${workspaceRelativePath} (current ↔ proposed)`,
      { preview: true }
    );
  }

  dispose(): void {
    this.changed.dispose();
  }
}
