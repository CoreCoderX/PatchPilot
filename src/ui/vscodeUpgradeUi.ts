import * as path from "node:path";
import type { ConsentMessage } from "./consentText";
import type { UpgradeUi } from "../commands/upgradeCommands";
import { VsCodeModelUi } from "./vscodeModelUi";
import type { ProposedContentProvider } from "./diffPreview";

/** VS Code implementation of the upgrade UI: modal confirms, diff editors, and progress. */
export class VsCodeUpgradeUi extends VsCodeModelUi implements UpgradeUi {
  constructor(
    private readonly root: () => string | undefined,
    private readonly diffs: ProposedContentProvider
  ) {
    super();
  }

  confirmModelSend(message: ConsentMessage): Promise<boolean> {
    return this.confirm(message.title, message.detail, message.confirmLabel);
  }

  async previewEdits(edits: readonly { readonly path: string; readonly proposedText: string }[]): Promise<void> {
    const root = this.root();
    if (root === undefined) {
      return;
    }
    for (const edit of edits) {
      await this.diffs.open(edit.path, path.join(root, edit.path), edit.proposedText);
    }
  }

  async approveEdits(changes: readonly { readonly path: string; readonly before: string; readonly after: string }[]): Promise<boolean> {
    await this.previewEdits(changes.map((change) => ({ path: change.path, proposedText: change.after })));
    const names = changes.map((change) => change.path).join(", ");
    return this.confirm(
      "PatchPilot: apply model-proposed repair?",
      `The model proposed edits to: ${names}. The diffs are open. Only source files were proposed; manifests and lockfiles are never edited by repair.`,
      "Apply repair"
    );
  }
}
