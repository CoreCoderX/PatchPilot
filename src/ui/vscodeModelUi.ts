import * as vscode from "vscode";
import type { ModelUi } from "../commands/modelCommands";
import { validateApiKey } from "../secrets/apiKeyStore";

/** VS Code implementation of the model command UI. */
export class VsCodeModelUi implements ModelUi {
  async inputApiKey(): Promise<string | undefined> {
    return vscode.window.showInputBox({
      title: "PatchPilot: Model API key",
      prompt: "Paste the API key. It is stored in VS Code secret storage and is not shown again.",
      password: true,
      ignoreFocusOut: true,
      validateInput: (value) => {
        try {
          validateApiKey(value);
          return undefined;
        } catch (error) {
          return error instanceof Error ? error.message : "The API key is invalid.";
        }
      }
    });
  }

  async confirm(title: string, detail: string, confirmLabel: string): Promise<boolean> {
    const choice = await vscode.window.showWarningMessage(title, { modal: true, detail }, confirmLabel);
    return choice === confirmLabel;
  }

  runWithProgress<T>(title: string, task: (signal: AbortSignal) => Promise<T>): Promise<T> {
    return Promise.resolve(
      vscode.window.withProgress(
        { location: vscode.ProgressLocation.Notification, title, cancellable: true },
        async (_progress, token) => {
          const controller = new AbortController();
          const subscription = token.onCancellationRequested(() => {
            controller.abort();
          });
          try {
            return await task(controller.signal);
          } finally {
            subscription.dispose();
          }
        }
      )
    );
  }

  showInfo(message: string): void {
    void vscode.window.showInformationMessage(message);
  }

  showWarning(message: string): void {
    void vscode.window.showWarningMessage(message);
  }

  showError(message: string): void {
    void vscode.window.showErrorMessage(message);
  }
}
