import type { AnalysisResult, DependencyAssessment, IssueKind, SourceStatus } from "../analysis/types";

export type ResultSeverity = "problem" | "warning" | "info" | "ok";

export interface ResultNode {
  readonly id: string;
  readonly label: string;
  readonly description?: string;
  readonly tooltip?: string | undefined;
  readonly severity: ResultSeverity;
  readonly children: readonly ResultNode[];
}

/** Issue kinds for one assessment. Unknown statuses are not issues: they are shown as "unknown". */
export function issueKindsFor(assessment: DependencyAssessment): IssueKind[] {
  const kinds: IssueKind[] = [];
  if (assessment.vulnerability.status === "vulnerable") {
    kinds.push("vulnerable");
  }
  if (assessment.freshness.status === "outdated") {
    kinds.push("outdated");
  }
  if (assessment.deprecation.status === "deprecated") {
    kinds.push("deprecated");
  }
  if (assessment.dependency.declaredKind === "unresolved") {
    kinds.push("unresolved");
  }
  return kinds;
}

const KIND_RANK: Readonly<Record<IssueKind, number>> = { vulnerable: 0, deprecated: 1, outdated: 2, unresolved: 3 };

/** Builds the results tree. Pure: takes the analysis result, returns display nodes. */
export function buildResultNodes(result: AnalysisResult): ResultNode[] {
  const dependencyCount = result.projects.reduce((sum, p) => sum + p.assessments.length, 0);
  const nodes: ResultNode[] = [];

  nodes.push({
    id: "summary",
    label: result.cancelled ? "Analysis cancelled" : "Analysis complete",
    description: `${String(result.projects.length)} manifest(s), ${String(dependencyCount)} dependencies`,
    tooltip: `Started ${result.startedAt}; finished ${result.finishedAt}`,
    severity: result.cancelled ? "warning" : "info",
    children: [
      ...result.sourceStatus.map(sourceNode),
      ...result.limitsReached.map((text, index) => leaf(`limit-${String(index)}`, text, "warning"))
    ]
  });

  for (const [index, project] of result.projects.entries()) {
    const sorted = [...project.assessments].sort((a, b) => rank(a) - rank(b) || a.dependency.name.localeCompare(b.dependency.name));
    const kindCounts = countKinds(project.assessments);
    const children: ResultNode[] = [
      ...sorted.map(dependencyNode),
      ...project.project.issues.map((issue, position) =>
        leaf(`issue-${String(index)}-${String(position)}`, `${issue.kind}: ${issue.message}`, issue.kind === "malformed" ? "problem" : "warning")
      )
    ];
    nodes.push({
      id: `project-${String(index)}`,
      label: project.project.manifest,
      description: `${project.project.format} · ${kindSummary(kindCounts)}`,
      tooltip: `${String(project.assessments.length)} dependencies`,
      severity: project.assessments.some((a) => issueKindsFor(a).some((k) => k === "vulnerable" || k === "deprecated"))
        ? "problem"
        : project.project.issues.length > 0
          ? "warning"
          : "ok",
      children
    });
  }

  if (result.unsupportedFiles.length > 0) {
    nodes.push({
      id: "unsupported",
      label: `Unsupported files (${String(result.unsupportedFiles.length)})`,
      description: "reported, not analyzed",
      severity: "warning",
      children: result.unsupportedFiles.map((file, index) => leaf(`unsupported-${String(index)}`, file.file, "warning", file.reason))
    });
  }
  return nodes;
}

function dependencyNode(assessment: DependencyAssessment): ResultNode {
  const dep = assessment.dependency;
  const kinds = issueKindsFor(assessment);
  const version = assessment.queriedVersion ?? (dep.declaredSpec === "" ? "no version" : dep.declaredSpec);
  const severity: ResultSeverity = kinds.some((k) => k === "vulnerable" || k === "deprecated")
    ? "problem"
    : kinds.length > 0
      ? "warning"
      : "ok";
  return {
    id: assessment.id,
    label: dep.name,
    description: `${version} · ${kinds.length === 0 ? "no issues found" : kinds.join(", ")}`,
    tooltip: [`Scope: ${dep.scope}`, `Declared: ${dep.declaredSpec === "" ? "(none)" : dep.declaredSpec}`, dep.note ?? ""]
      .filter((line) => line !== "")
      .join("\n"),
    severity,
    children: [
      leaf(`${assessment.id}-vuln`, `Vulnerability: ${assessment.vulnerability.status}`, assessment.vulnerability.status === "vulnerable" ? "problem" : "info", assessment.vulnerability.reason, [
        ...assessment.vulnerability.advisories.map((advisory) =>
          leaf(`${assessment.id}-adv-${advisory.id}`, advisory.id, "problem", advisory.summary ?? advisory.url)
        )
      ]),
      leaf(`${assessment.id}-fresh`, `Freshness: ${assessment.freshness.status}`, assessment.freshness.status === "outdated" ? "warning" : "info", assessment.freshness.reason),
      leaf(`${assessment.id}-dep`, `Deprecation: ${assessment.deprecation.status}`, assessment.deprecation.status === "deprecated" ? "problem" : "info", assessment.deprecation.message ?? assessment.deprecation.reason),
      leaf(`${assessment.id}-compat`, "Compatibility: unknown", "info", assessment.compatibility.reason),
      ...assessment.evidence.map((item, index) =>
        leaf(`${assessment.id}-ev-${String(index)}`, `Evidence (${item.source})`, "info", [item.detail, item.url ?? "", item.retrievedAt ?? ""].filter((x) => x !== "").join("\n"))
      )
    ]
  };
}

function sourceNode(status: SourceStatus): ResultNode {
  const severity: ResultSeverity = status.status === "ok" ? "ok" : status.status === "not-used" ? "info" : status.status === "partial" ? "warning" : "problem";
  return leaf(`source-${status.source}`, `${status.source}: ${status.status}`, severity, status.detail);
}

function leaf(id: string, label: string, severity: ResultSeverity, tooltip?: string, children: readonly ResultNode[] = []): ResultNode {
  return { id, label, severity, tooltip, children };
}

function rank(assessment: DependencyAssessment): number {
  const kinds = issueKindsFor(assessment);
  if (kinds.length === 0) {
    return 10;
  }
  return Math.min(...kinds.map((k) => KIND_RANK[k]));
}

function countKinds(assessments: readonly DependencyAssessment[]): Record<IssueKind, number> {
  const counts: Record<IssueKind, number> = { vulnerable: 0, deprecated: 0, outdated: 0, unresolved: 0 };
  for (const assessment of assessments) {
    for (const kind of issueKindsFor(assessment)) {
      counts[kind] += 1;
    }
  }
  return counts;
}

function kindSummary(counts: Record<IssueKind, number>): string {
  const parts = (Object.keys(counts) as IssueKind[]).filter((k) => counts[k] > 0).map((k) => `${String(counts[k])} ${k}`);
  return parts.length === 0 ? "no issues found" : parts.join(", ");
}
