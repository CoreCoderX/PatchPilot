import * as path from "node:path";
import type { CommandTemplateId, PlannedCommand } from "./types";

export interface CommandTemplate {
  readonly id: CommandTemplateId;
  readonly executable: "npm" | "mvn" | "python";
  readonly args: readonly string[];
  /** Appends a validated file name as the final argument (pip -r <file>). */
  readonly takesFile: boolean;
  readonly phase: "apply" | "validate";
  readonly purpose: string;
  /** Matches a manifest kind; used to offer templates for the right project. */
  readonly ecosystem: "npm" | "maven" | "pypi";
}

/**
 * The only commands PatchPilot may run. Each is a fixed argv executed without a shell.
 * Adding a template requires code review; the model can never choose a command.
 */
export const COMMAND_TEMPLATES: Readonly<Record<CommandTemplateId, CommandTemplate>> = {
  "npm-lock-refresh": {
    id: "npm-lock-refresh",
    executable: "npm",
    args: ["install", "--package-lock-only", "--ignore-scripts", "--no-audit", "--no-fund"],
    takesFile: false,
    phase: "apply",
    purpose: "Update package-lock.json to match package.json. Its exact effect cannot be previewed; review the lockfile diff after it runs.",
    ecosystem: "npm"
  },
  "npm-test": {
    id: "npm-test",
    executable: "npm",
    args: ["test"],
    takesFile: false,
    phase: "validate",
    purpose: "Run the project's test script (npm test).",
    ecosystem: "npm"
  },
  "npm-build": {
    id: "npm-build",
    executable: "npm",
    args: ["run", "build"],
    takesFile: false,
    phase: "validate",
    purpose: "Run the project's build script (npm run build).",
    ecosystem: "npm"
  },
  "maven-dependency-resolve": {
    id: "maven-dependency-resolve",
    executable: "mvn",
    args: ["-B", "-q", "dependency:resolve"],
    takesFile: false,
    phase: "validate",
    purpose: "Resolve Maven dependencies with the updated versions (no tests, no packaging).",
    ecosystem: "maven"
  },
  "maven-test": {
    id: "maven-test",
    executable: "mvn",
    args: ["-B", "-q", "test"],
    takesFile: false,
    phase: "validate",
    purpose: "Run the Maven test phase.",
    ecosystem: "maven"
  },
  "pypi-pip-dry-run": {
    id: "pypi-pip-dry-run",
    executable: "python",
    args: ["-m", "pip", "install", "--dry-run", "--quiet", "-r"],
    takesFile: true,
    phase: "validate",
    purpose: "Ask pip to resolve the requirements file without installing anything (--dry-run).",
    ecosystem: "pypi"
  },
  "pypi-pytest": {
    id: "pypi-pytest",
    executable: "python",
    args: ["-m", "pytest", "-q", "-p", "no:cacheprovider"],
    takesFile: false,
    phase: "validate",
    purpose: "Run pytest in the project directory.",
    ecosystem: "pypi"
  }
};

const SAFE_FILE_NAME = /^[A-Za-z0-9._-]+$/;

/** Resolves the executable name for the current platform. */
export function executableFor(template: CommandTemplate, platform: NodeJS.Platform = process.platform): string {
  if (template.executable === "python") {
    return platform === "win32" ? "python" : "python3";
  }
  if (platform === "win32") {
    // npm and mvn are .cmd shims on Windows. Each is still spawned from a fixed name.
    return `${template.executable}.cmd`;
  }
  return template.executable;
}

export function buildCommand(
  id: string,
  template: CommandTemplateId,
  cwd: string,
  fileArg: string | undefined
): PlannedCommand {
  const spec = COMMAND_TEMPLATES[template];
  if (spec.takesFile && (fileArg === undefined || !SAFE_FILE_NAME.test(fileArg))) {
    throw new Error(`Command ${template} needs a plain file name.`);
  }
  const args = spec.takesFile && fileArg !== undefined ? [...spec.args, fileArg] : [...spec.args];
  // The display line shows the same executable that will be spawned, so approval matches execution.
  const displayLine = `${cwd} $ ${executableFor(spec)} ${args.join(" ")}`;
  return { id, template, cwd, phase: spec.phase, purpose: spec.purpose, displayLine, fileArg };
}

export type CommandCheck = { readonly ok: true } | { readonly ok: false; readonly reason: string };

/**
 * Checks a command before it runs: template exists, cwd is inside the workspace, and the
 * argv matches the template exactly. Run again immediately before every execution.
 */
export function checkCommand(command: PlannedCommand, workspaceRoot: string): CommandCheck {
  const template = COMMAND_TEMPLATES[command.template];
  if (!Object.hasOwn(COMMAND_TEMPLATES, command.template)) {
    return { ok: false, reason: "unknown command template" };
  }
  if (path.isAbsolute(command.cwd) || command.cwd.split(/[\\/]/).includes("..")) {
    return { ok: false, reason: "working directory must be a relative path inside the workspace" };
  }
  const resolved = path.resolve(workspaceRoot, command.cwd);
  const root = path.resolve(workspaceRoot);
  if (resolved !== root && !resolved.startsWith(root + path.sep)) {
    return { ok: false, reason: "working directory is outside the workspace" };
  }
  if (template.takesFile && (command.fileArg === undefined || !SAFE_FILE_NAME.test(command.fileArg))) {
    return { ok: false, reason: "file argument is not a plain file name" };
  }
  return { ok: true };
}
