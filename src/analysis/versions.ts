/**
 * Version ordering for Maven and PyPI. npm versions use the `semver` package directly.
 * These are intentionally limited:
 * - Maven: follows the common ComparableVersion rules for numbers and well-known qualifiers.
 *   Maven version ranges (for example "[1.0,2.0)") are NOT evaluated.
 * - PyPI: PEP 440 release, pre-release, post, and dev segments. Local versions (+tag) are ignored.
 *   Specifier sets support ==, !=, <, <=, >, >=, ~=, ===, and wildcard == matches.
 */

// ---------- Maven ----------

const MAVEN_QUALIFIER_RANK: Readonly<Record<string, number>> = {
  alpha: 1,
  beta: 2,
  milestone: 3,
  rc: 4,
  cr: 4,
  snapshot: 5,
  "": 6,
  ga: 6,
  final: 6,
  release: 6,
  sp: 7
};

const MAVEN_UNSTABLE_TOKENS = new Set(["alpha", "beta", "milestone", "rc", "cr", "snapshot", "dev", "preview", "pre"]);

type MavenToken = { readonly kind: "num"; readonly value: number } | { readonly kind: "str"; readonly value: string };

function tokenizeMaven(version: string): MavenToken[] {
  const tokens: MavenToken[] = [];
  const parts = version.toLowerCase().split(/[.-]/);
  for (const part of parts) {
    // Split letter/digit transitions such as "1a2" -> "1", "a", "2".
    const pieces = part.match(/\d+|[a-z]+/g) ?? [];
    for (const piece of pieces) {
      tokens.push(/^\d+$/.test(piece) ? { kind: "num", value: Number(piece) } : { kind: "str", value: piece });
    }
  }
  return tokens;
}

function mavenStringRank(value: string): number {
  return MAVEN_QUALIFIER_RANK[value] ?? 8;
}

/** Negative when a < b, zero when equal, positive when a > b. */
export function compareMaven(a: string, b: string): number {
  const left = tokenizeMaven(a);
  const right = tokenizeMaven(b);
  const length = Math.max(left.length, right.length);
  for (let i = 0; i < length; i += 1) {
    const x = left[i] ?? { kind: "num", value: 0 };
    const y = right[i] ?? { kind: "num", value: 0 };
    const cmp = compareMavenTokens(x, y);
    if (cmp !== 0) {
      return cmp;
    }
  }
  return 0;
}

function compareMavenTokens(x: MavenToken, y: MavenToken): number {
  if (x.kind === "num" && y.kind === "num") {
    return x.value - y.value;
  }
  if (x.kind === "str" && y.kind === "str") {
    const rx = mavenStringRank(x.value);
    const ry = mavenStringRank(y.value);
    if (rx !== ry) {
      return rx - ry;
    }
    return x.value < y.value ? -1 : x.value > y.value ? 1 : 0;
  }
  // A number is considered greater than a qualifier, as in Maven's ComparableVersion.
  return x.kind === "num" ? 1 : -1;
}

export function isMavenStable(version: string): boolean {
  return !tokenizeMaven(version).some((token) => token.kind === "str" && MAVEN_UNSTABLE_TOKENS.has(token.value));
}

// ---------- PEP 440 ----------

export interface Pep440 {
  readonly epoch: number;
  readonly release: readonly number[];
  readonly pre: "a" | "b" | "rc" | undefined;
  readonly preNumber: number;
  readonly post: number | undefined;
  readonly dev: number | undefined;
}

const PEP440_PATTERN =
  /^v?(?:(\d+)!)?(\d+(?:\.\d+)*)(?:[-_.]?(alpha|a|beta|b|preview|pre|c|rc)[-_.]?(\d+)?)?(?:-(\d+)|[-_.]?(post|rev|r)[-_.]?(\d+)?)?(?:[-_.]?dev[-_.]?(\d+)?)?(?:\+[a-z0-9]+(?:[-_.][a-z0-9]+)*)?$/i;

/** Regex groups can be absent at runtime (optional groups), so type them as possibly undefined. */
function groupsOf(match: RegExpExecArray): readonly (string | undefined)[] {
  return match;
}

export function parsePep440(raw: string): Pep440 | undefined {
  const match = PEP440_PATTERN.exec(raw.trim());
  if (match === null) {
    return undefined;
  }
  const g = groupsOf(match);
  const preTag = g[3]?.toLowerCase();
  let pre: "a" | "b" | "rc" | undefined;
  if (preTag === "a" || preTag === "alpha") {
    pre = "a";
  } else if (preTag === "b" || preTag === "beta") {
    pre = "b";
  } else if (preTag !== undefined) {
    pre = "rc";
  }
  const postDigits = g[5] ?? g[7];
  const hasPost = g[5] !== undefined || g[6] !== undefined;
  const devMatch = /dev[-_.]?(\d+)?$/i.test(raw.trim().split("+")[0] ?? "");
  const devDigits = g[8];
  return {
    epoch: g[1] === undefined ? 0 : Number(g[1]),
    release: (g[2] ?? "0").split(".").map((part) => Number(part)),
    pre,
    preNumber: g[4] === undefined ? 0 : Number(g[4]),
    post: hasPost ? (postDigits === undefined ? 0 : Number(postDigits)) : undefined,
    dev: devMatch ? (devDigits === undefined ? 0 : Number(devDigits)) : undefined
  };
}

const PRE_RANK = { a: 0, b: 1, rc: 2 } as const;

function sortKey(v: Pep440, length: number): number[] {
  const release = [...v.release];
  while (release.length < length) {
    release.push(0);
  }
  let phase: number;
  let phaseNumber = 0;
  if (v.pre !== undefined) {
    phase = PRE_RANK[v.pre];
    phaseNumber = v.preNumber;
  } else if (v.post === undefined && v.dev !== undefined) {
    phase = -1; // a dev-only release sorts before any pre-release of the same number
  } else {
    phase = 3;
  }
  const post = v.post === undefined ? -1 : v.post;
  const dev = v.dev === undefined ? Number.POSITIVE_INFINITY : v.dev;
  return [v.epoch, ...release, phase, phaseNumber, post, dev];
}

/** Negative when a < b, zero when equal, positive when a > b. Both must parse. */
export function comparePep440(a: Pep440, b: Pep440): number {
  const length = Math.max(a.release.length, b.release.length);
  const left = sortKey(a, length + 1);
  const right = sortKey(b, length + 1);
  const size = Math.max(left.length, right.length);
  for (let i = 0; i < size; i += 1) {
    const x = left[i] ?? 0;
    const y = right[i] ?? 0;
    if (x !== y) {
      return x - y;
    }
  }
  return 0;
}

export function isPep440Stable(v: Pep440): boolean {
  return v.pre === undefined && v.dev === undefined;
}

type Operator = "==" | "!=" | "<=" | ">=" | "<" | ">" | "~=" | "===";

interface Clause {
  readonly op: Operator;
  readonly raw: string;
}

const CLAUSE_PATTERN = /^\s*(===|==|!=|<=|>=|~=|<|>)\s*(\S+?)\s*$/;

/**
 * True when `version` satisfies every clause. Returns undefined when the version or any
 * clause cannot be parsed, so the caller can report "unknown" instead of guessing.
 */
export function satisfiesPep440(version: string, specifier: string): boolean | undefined {
  const target = parsePep440(version);
  if (target === undefined) {
    return undefined;
  }
  const clauses: Clause[] = [];
  for (const part of specifier.split(",")) {
    const match = CLAUSE_PATTERN.exec(part);
    if (match === null) {
      return undefined;
    }
    const g = groupsOf(match);
    clauses.push({ op: (g[1] ?? "") as Operator, raw: g[2] ?? "" });
  }
  for (const clause of clauses) {
    const result = matchClause(target, version, clause);
    if (result === undefined) {
      return undefined;
    }
    if (!result) {
      return false;
    }
  }
  return true;
}

function matchClause(target: Pep440, targetRaw: string, clause: Clause): boolean | undefined {
  const wildcard = clause.raw.endsWith(".*");
  if (wildcard && (clause.op === "==" || clause.op === "!=")) {
    const prefix = clause.raw.slice(0, -2).split(".").map((part) => Number(part));
    const matches = prefix.every((part, index) => target.release[index] === part);
    return clause.op === "==" ? matches : !matches;
  }
  const bound = parsePep440(clause.raw);
  if (bound === undefined) {
    return undefined;
  }
  if (clause.op === "===") {
    return targetRaw.trim().toLowerCase() === clause.raw.toLowerCase();
  }
  if (clause.op === "~=") {
    if (bound.release.length < 2) {
      return undefined;
    }
    const prefix = bound.release.slice(0, -1);
    const upper = [...prefix];
    upper[upper.length - 1] = (upper[upper.length - 1] ?? 0) + 1;
    const lowerOk = comparePep440(target, bound) >= 0;
    const upperOk = comparePep440(target, parsePep440(upper.join(".")) ?? bound) < 0;
    return lowerOk && upperOk;
  }
  const cmp = comparePep440(target, bound);
  switch (clause.op) {
    case "==":
      return cmp === 0;
    case "!=":
      return cmp !== 0;
    case "<=":
      return cmp <= 0;
    case ">=":
      return cmp >= 0;
    case "<":
      return cmp < 0;
    case ">":
      return cmp > 0;
    default:
      return undefined;
  }
}
