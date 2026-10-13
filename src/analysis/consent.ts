import type { NetworkPlan } from "./runner";
import { OSV_BATCH_URL } from "../advisories/osv";

export interface AnalysisConsentMessage {
  readonly title: string;
  readonly detail: string;
  readonly confirmLabel: string;
}

/** Plain-language consent for the Phase 3 network step. Lists endpoints and exact counts. */
export function buildAnalysisConsent(plan: NetworkPlan): AnalysisConsentMessage {
  const { npm, maven, pypi } = plan.registryPackages;
  const lines = [
    "PatchPilot will check your dependencies against public metadata services. This is read-only: no files are changed and no package-manager or project commands run.",
    "",
    `Manifests read locally: ${plan.manifests.length === 0 ? "none" : plan.manifests.join(", ")}`,
    plan.unsupportedFiles > 0 ? `Unsupported files (reported, not read): ${String(plan.unsupportedFiles)}` : "",
    "",
    "Requests that will be sent:",
    `  - npm registry (https://registry.npmjs.org): ${String(npm)} package name(s), to read version metadata.`,
    `  - Maven Central (https://repo1.maven.org): ${String(maven)} artifact coordinate(s) (groupId:artifactId), to read version metadata.`,
    `  - PyPI (https://pypi.org): ${String(pypi)} project name(s), to read version metadata.`,
    `  - OSV (${OSV_BATCH_URL}): ${String(plan.osvQueries)} package-and-version quer${plan.osvQueries === 1 ? "y" : "ies"}, to look up known advisories.`,
    "",
    "Data sent: package names, Maven coordinates, and version strings only. No file contents, source code, file paths, or credentials are sent.",
    "Requests are sent without your API key and do not use the model endpoint."
  ].filter((line, index, all) => line !== "" || (index > 0 && all[index - 1] !== ""));
  return {
    title: "PatchPilot: check dependencies online?",
    detail: lines.join("\n"),
    confirmLabel: "Send lookups"
  };
}
