import type { AnalysisResult, DependencyAssessment, Ecosystem, Lookup, ManifestDependency, RegistryPackage } from "../analysis/types";
import { registryKey } from "../analysis/runner";
import { normalizePypiName } from "../registry/pypi";
import type { OsvQuery } from "../advisories/osv";
import { applyExactPinEdit, sha256 } from "./edits";
import { chooseCleanTarget, newerStableCandidates } from "./targets";
import { buildCommand } from "./commands";
import type { BlockReason, FileEdit, PlanItem, PlannedCommand, UpgradePlan } from "./types";

const COMPATIBILITY_NOTE =
  "Compatibility not verified: PatchPilot does not check API changes, runtime requirements, or build behaviour for the target version. Review its release notes.";

/** A dependency that needs work, with its candidates prepared but not yet checked against OSV. */
export interface PreparedItem {
  readonly id: string;
  readonly dependency: ManifestDependency;
  readonly currentVersion: string;
  readonly currentSource: "lockfile" | "exact-pin";
  readonly advisoriesFixed: readonly string[];
  readonly registrySource: { readonly url: string; readonly retrievedAt: string };
  /** Candidates newest first. Empty means the item is blocked before any OSV check. */
  readonly candidates: readonly string[];
  readonly blocked: { readonly reason: BlockReason; readonly message: string } | undefined;
  /** Index range of this item's queries in the shared query list. */
  readonly queryStart: number;
}

export interface CandidatePreparation {
  readonly items: readonly PreparedItem[];
  /** Every OSV query needed, in order. Shown in the consent prompt before anything is sent. */
  readonly queries: readonly OsvQuery[];
}

function needsWork(assessment: DependencyAssessment): boolean {
  return assessment.vulnerability.status === "vulnerable" || assessment.deprecation.status === "deprecated";
}

function osvNameFor(dependency: ManifestDependency): string {
  return dependency.ecosystem === "pypi" ? normalizePypiName(dependency.name) : dependency.name;
}

/**
 * Decides which dependencies need a plan item, picks candidates, and lists the OSV queries
 * those candidates require. Pure: performs no network or file access.
 */
export function prepareCandidates(result: AnalysisResult): CandidatePreparation {
  const items: PreparedItem[] = [];
  const queries: OsvQuery[] = [];
  let counter = 0;

  for (const project of result.projects) {
    for (const assessment of project.assessments) {
      if (!needsWork(assessment)) {
        continue;
      }
      counter += 1;
      const dependency = assessment.dependency;
      const id = `item-${String(counter).padStart(3, "0")}`;
      const advisoriesFixed = assessment.vulnerability.advisories.map((advisory) => advisory.id);
      const currentVersion = assessment.queriedVersion;
      const currentSource = assessment.queriedVersionSource;
      const registry = result.registry.find(
        (entry) => registryKey(entry.ecosystem, entry.name) === registryKey(dependency.ecosystem, dependency.name)
      );
      const base = { id, dependency, advisoriesFixed, queryStart: queries.length };

      const blockedItem = (reason: BlockReason, message: string, extra?: { version?: string; source?: "lockfile" | "exact-pin"; registrySource?: { url: string; retrievedAt: string } }): PreparedItem => ({
        ...base,
        currentVersion: extra?.version ?? currentVersion ?? "",
        currentSource: extra?.source ?? currentSource ?? "exact-pin",
        registrySource: extra?.registrySource ?? { url: "", retrievedAt: "" },
        candidates: [],
        blocked: { reason, message }
      });

      if (dependency.declaredKind !== "exact" || dependency.exactVersion === undefined || currentVersion === undefined) {
        items.push(
          blockedItem(
            "not-exact-pin",
            `Declared as "${dependency.declaredSpec}". Only exact pins are edited, so this is reported only.`
          )
        );
        continue;
      }
      if (currentVersion !== dependency.exactVersion) {
        items.push(
          blockedItem(
            "lock-manifest-mismatch",
            `The lockfile records ${currentVersion} but the manifest pins ${dependency.exactVersion}. Resolve the mismatch before upgrading.`
          )
        );
        continue;
      }
      if (registry === undefined || registry.lookup.kind !== "found") {
        const reason = registry?.lookup.kind === "unavailable" ? registry.lookup.reason : "no registry record";
        items.push(blockedItem("no-registry-data", `Registry metadata is unavailable (${reason}), so no target can be chosen.`));
        continue;
      }
      const metadata: RegistryPackage = registry.lookup.value;
      const registrySource = { url: metadata.sourceUrl, retrievedAt: metadata.retrievedAt };
      const candidates = newerStableCandidates(dependency.ecosystem, currentVersion, metadata);
      if (candidates.length === 0) {
        items.push(
          blockedItem("no-newer-stable", "No newer stable version exists in the registry (pre-releases, deprecated, and yanked versions are excluded).", { registrySource })
        );
        continue;
      }
      const osvName = osvNameFor(dependency);
      for (const version of candidates) {
        queries.push({ ecosystem: dependency.ecosystem, name: osvName, version });
      }
      items.push({
        ...base,
        currentVersion,
        currentSource: currentSource ?? "exact-pin",
        registrySource,
        candidates,
        blocked: undefined
      });
    }
  }
  return { items, queries };
}

export interface FinalizeInput {
  readonly planId: string;
  readonly now: string;
  readonly result: AnalysisResult;
  readonly preparation: CandidatePreparation;
  /** Lookup of advisory-ID lists per query, in the same order as preparation.queries. */
  readonly osv: Lookup<readonly (readonly string[])[]>;
  readonly readFile: (relativePath: string) => Promise<string>;
  readonly fileExists: (relativePath: string) => Promise<boolean>;
}

/** Turns prepared candidates into a complete plan: targets, edited manifests, and commands. */
export async function finalizePlan(input: FinalizeInput): Promise<UpgradePlan> {
  const notes: string[] = [];
  const items = input.preparation.items;
  const osvCounts = input.osv.kind === "found" ? input.osv.value : undefined;
  if (input.osv.kind !== "found") {
    notes.push(`OSV check for candidate versions was unavailable (${input.osv.kind === "unavailable" ? input.osv.reason : "not found"}). Items that needed it are blocked.`);
  }

  // Choose a target for each item that reached the candidate stage.
  const choices = new Map<string, { target?: string; block?: { reason: BlockReason; message: string } }>();
  for (const item of items) {
    if (item.blocked !== undefined) {
      continue;
    }
    if (osvCounts === undefined) {
      choices.set(item.id, { block: { reason: "candidate-check-unavailable", message: "Candidate advisories could not be checked, so no target was chosen." } });
      continue;
    }
    const counts = new Map<string, number>();
    item.candidates.forEach((version, offset) => {
      const advisories = osvCounts.at(item.queryStart + offset);
      if (advisories !== undefined) {
        counts.set(version, advisories.length);
      }
    });
    const target = chooseCleanTarget(item.candidates, counts);
    choices.set(
      item.id,
      target === undefined
        ? { block: { reason: "no-clean-candidate", message: `None of the newest ${String(item.candidates.length)} stable candidates is free of known OSV advisories.` } }
        : { target }
    );
  }

  // Edit manifests. Each item is applied only if its edit matches exactly once.
  const itemsByManifest = new Map<string, PreparedItem[]>();
  for (const item of items) {
    const choice = choices.get(item.id);
    if (choice?.target === undefined) {
      continue;
    }
    const list = itemsByManifest.get(item.dependency.manifest) ?? [];
    list.push(item);
    itemsByManifest.set(item.dependency.manifest, list);
  }

  const itemStatus = new Map<string, { status: "ready" | "blocked"; message: string; reason?: BlockReason }>();
  const edits: FileEdit[] = [];
  const editedText = new Map<string, string>();
  for (const [manifest, manifestItems] of itemsByManifest) {
    const originalText = await input.readFile(manifest);
    let text = originalText;
    const applied: string[] = [];
    for (const item of manifestItems) {
      const target = choices.get(item.id)?.target ?? "";
      const kind = fileKindFor(manifest, item.dependency.ecosystem);
      const outcome = applyExactPinEdit(text, item.dependency, item.currentVersion, target, kind);
      if (!outcome.ok) {
        const message =
          outcome.reason === "edit-not-unique"
            ? `The pin appears more than once in ${manifest}. Edit it by hand.`
            : `The pin could not be located in ${manifest} as a literal version. It may be a range, a property, or managed elsewhere.`;
        itemStatus.set(item.id, { status: "blocked", reason: outcome.reason, message });
        continue;
      }
      text = outcome.text;
      applied.push(item.id);
      itemStatus.set(item.id, { status: "ready", message: `Pin ${item.currentVersion} → ${target} in ${manifest}.` });
    }
    if (applied.length === 0) {
      continue;
    }
    if (manifest.endsWith("package.json")) {
      try {
        JSON.parse(text);
      } catch {
        for (const id of applied) {
          itemStatus.set(id, { status: "blocked", reason: "edit-not-found", message: `The edited ${manifest} would not be valid JSON, so nothing was changed.` });
        }
        continue;
      }
    }
    editedText.set(manifest, text);
    edits.push({ path: manifest, originalHash: sha256(originalText), proposedText: text, itemIds: applied });
  }

  const planItems: PlanItem[] = items.map((item) => {
    const choice = choices.get(item.id);
    const status = itemStatus.get(item.id);
    const blocked = item.blocked ?? (choice?.block !== undefined ? { reason: choice.block.reason, message: choice.block.message } : undefined);
    const isReady = blocked === undefined && status?.status === "ready";
    const message = isReady
      ? `${status.message} Advisories fixed on ${item.currentVersion}: ${item.advisoriesFixed.join(", ") || "none listed"}.`
      : (blocked?.message ?? status?.message ?? "Not planned.");
    const reason: BlockReason | undefined = isReady ? undefined : (blocked?.reason ?? status?.reason);
    return {
      id: item.id,
      ecosystem: item.dependency.ecosystem,
      name: item.dependency.name,
      manifest: item.dependency.manifest,
      currentVersion: item.currentVersion === "" ? undefined : item.currentVersion,
      currentVersionSource: item.currentVersion === "" ? undefined : item.currentSource,
      targetVersion: isReady ? choice?.target : undefined,
      status: isReady ? "ready" : "blocked",
      blockReason: reason,
      message,
      advisoriesFixed: item.advisoriesFixed,
      registrySource: item.registrySource.url === "" ? undefined : item.registrySource,
      compatibility: COMPATIBILITY_NOTE
    };
  });

  // Commands are planned only for projects that have at least one ready item.
  const readyManifests = [...new Set(planItems.filter((item) => item.status === "ready").map((item) => item.manifest))].sort();
  const commands: PlannedCommand[] = [];
  for (const manifest of readyManifests) {
    const dir = dirOf(manifest);
    const text = editedText.get(manifest) ?? "";
    const ecosystem = planItems.find((item) => item.manifest === manifest)?.ecosystem;
    if (ecosystem === "npm") {
      if (await input.fileExists(joinPath(dir, "package-lock.json"))) {
        commands.push(buildCommand(`npm-lock-refresh@${dir}`, "npm-lock-refresh", dir, undefined));
      } else {
        notes.push(`${dir === "." ? "The project" : dir} has no package-lock.json; no lockfile refresh will run.`);
      }
      const scripts = scriptsOf(text);
      if (scripts.test !== undefined && !isPlaceholderTest(scripts.test)) {
        commands.push(buildCommand(`npm-test@${dir}`, "npm-test", dir, undefined));
      }
      if (scripts.build !== undefined) {
        commands.push(buildCommand(`npm-build@${dir}`, "npm-build", dir, undefined));
      }
      if (scripts.test === undefined || isPlaceholderTest(scripts.test)) {
        notes.push(`${dir === "." ? "The project" : dir} has no test script; validation will report that as unresolved.`);
      }
    } else if (ecosystem === "maven") {
      commands.push(buildCommand(`maven-dependency-resolve@${dir}`, "maven-dependency-resolve", dir, undefined));
      commands.push(buildCommand(`maven-test@${dir}`, "maven-test", dir, undefined));
    } else if (ecosystem === "pypi") {
      const base = manifest.split("/").pop() ?? manifest;
      if (base.endsWith(".txt")) {
        commands.push(buildCommand(`pypi-pip-dry-run@${manifest}`, "pypi-pip-dry-run", dir, base));
      }
      if ((await input.fileExists(joinPath(dir, "tests"))) || (await input.fileExists(joinPath(dir, "test")))) {
        commands.push(buildCommand(`pypi-pytest@${dir}`, "pypi-pytest", dir, undefined));
      } else {
        notes.push(`${dir === "." ? "The project" : dir} has no tests/ or test/ directory; pytest is not planned.`);
      }
    }
  }

  const uniqueCommands = [...new Map(commands.map((command) => [command.id, command])).values()];
  commands.length = 0;
  commands.push(...uniqueCommands);

  const blockedCount = planItems.filter((item) => item.status === "blocked").length;
  notes.push(`Only exact pins are edited. ${String(blockedCount)} item(s) reported as blocked.`);
  if (commands.some((command) => command.template === "npm-lock-refresh")) {
    notes.push("The npm lockfile refresh changes package-lock.json in ways that cannot be previewed. Review the lockfile diff after it runs.");
  }
  notes.push(`Analysis used for this plan finished at ${input.result.finishedAt}.`);

  return {
    id: input.planId,
    createdAt: input.now,
    status: "proposed",
    items: planItems,
    edits,
    commands,
    notes
  };
}

function fileKindFor(manifest: string, ecosystem: Ecosystem): "npm" | "maven" | "pypi-requirements" | "pypi-pyproject" {
  if (ecosystem === "npm") {
    return "npm";
  }
  if (ecosystem === "maven") {
    return "maven";
  }
  return manifest.endsWith("pyproject.toml") ? "pypi-pyproject" : "pypi-requirements";
}

function dirOf(manifest: string): string {
  const index = manifest.lastIndexOf("/");
  return index === -1 ? "." : manifest.slice(0, index);
}

function joinPath(dir: string, name: string): string {
  return dir === "." ? name : `${dir}/${name}`;
}

function scriptsOf(text: string): Record<string, string | undefined> {
  try {
    const parsed: unknown = JSON.parse(text);
    if (typeof parsed === "object" && parsed !== null && "scripts" in parsed && typeof parsed.scripts === "object" && parsed.scripts !== null) {
      const scripts: Record<string, string | undefined> = {};
      for (const [key, value] of Object.entries(parsed.scripts)) {
        scripts[key] = typeof value === "string" ? value : undefined;
      }
      return scripts;
    }
  } catch {
    // Invalid JSON was already rejected above; treat as no scripts.
  }
  return {};
}

function isPlaceholderTest(script: string): boolean {
  return /no test specified/i.test(script);
}
