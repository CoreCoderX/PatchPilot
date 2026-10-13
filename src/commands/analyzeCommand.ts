import { buildAnalysisConsent } from "../analysis/consent";
import { runAnalysis, type WorkspaceFile } from "../analysis/runner";
import type { AnalysisClients } from "../analysis/runner";
import type { AnalysisResult } from "../analysis/types";
import type { Logger } from "../log";
import type { ModelUi } from "./modelCommands";

export type AnalyzeOutcome = "completed" | "declined" | "blocked" | "no_manifests" | "cancelled";

export interface AnalyzeDeps {
  readonly isTrusted: () => boolean;
  readonly findFiles: () => Promise<readonly WorkspaceFile[]>;
  readonly createClients: () => AnalysisClients;
  readonly ui: Pick<ModelUi, "confirm" | "runWithProgress" | "showInfo" | "showWarning" | "showError">;
  readonly log: Logger;
  readonly now: () => Date;
  readonly onResult: (result: AnalysisResult) => void;
}

/**
 * Phase 3 analysis command. Read-only: parses manifests locally, then (after consent) queries
 * registries and OSV. Refuses to run in restricted mode, because it reads workspace files.
 */
export async function analyzeDependencies(deps: AnalyzeDeps): Promise<AnalyzeOutcome> {
  if (!deps.isTrusted()) {
    deps.ui.showWarning("Dependency analysis reads project files. Trust this folder to run it.");
    return "blocked";
  }
  const files = await deps.findFiles();
  if (files.length === 0) {
    deps.ui.showInfo("PatchPilot found no supported manifests (package.json, pom.xml, pyproject.toml, requirements*.txt).");
    return "no_manifests";
  }

  const decision = { declined: false };
  const result = await deps.ui.runWithProgress("PatchPilot: analyzing dependencies", async (signal) => {
    const outcome = await runAnalysis({
      files,
      clients: deps.createClients(),
      signal,
      now: deps.now,
      confirmNetwork: async (plan) => {
        const consent = buildAnalysisConsent(plan);
        const approved = await deps.ui.confirm(consent.title, consent.detail, consent.confirmLabel);
        if (!approved) {
          decision.declined = true;
        }
        return approved;
      }
    });
    return outcome;
  });

  if (result === "declined" || decision.declined) {
    deps.log.info("Dependency analysis stopped: network lookups were not approved. No requests were sent.");
    return "declined";
  }
  deps.onResult(result);
  const dependencyCount = result.projects.reduce((sum, p) => sum + p.assessments.length, 0);
  deps.log.info(
    `Dependency analysis ${result.cancelled ? "cancelled" : "finished"}: ${String(result.projects.length)} manifest(s), ${String(dependencyCount)} dependencies. ` +
      result.sourceStatus.map((s) => `${s.source}=${s.status}`).join(", ")
  );
  if (result.cancelled) {
    deps.ui.showWarning("Dependency analysis was cancelled. Partial results are shown.");
    return "cancelled";
  }
  deps.ui.showInfo(`Dependency analysis finished. ${String(dependencyCount)} dependencies checked; see the PatchPilot Dependencies view.`);
  return "completed";
}
