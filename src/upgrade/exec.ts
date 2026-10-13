import { spawn } from "node:child_process";
import { redactSecrets } from "../security/redact";

export interface ExecRequest {
  readonly executable: string;
  readonly args: readonly string[];
  readonly cwd: string;
  readonly timeoutMs: number;
  readonly maxOutputBytes: number;
  readonly knownSecrets: readonly string[];
  readonly signal: AbortSignal;
  readonly env?: NodeJS.ProcessEnv;
}

export interface ExecResult {
  readonly exitCode: number | null;
  readonly timedOut: boolean;
  readonly cancelled: boolean;
  readonly spawnError: string | undefined;
  readonly durationMs: number;
  /** Last part of combined stdout and stderr, redacted. */
  readonly output: string;
  readonly outputTruncated: boolean;
}

const KILL_GRACE_MS = 3_000;

/**
 * Runs one fixed argv. Shell is off everywhere except Windows .cmd shims, which Node can only
 * launch through a shell. Their arguments come from fixed templates and validated file names,
 * never from model output.
 */
export function runExec(request: ExecRequest, platform: NodeJS.Platform = process.platform): Promise<ExecResult> {
  const started = Date.now();
  const useShell = platform === "win32" && request.executable.toLowerCase().endsWith(".cmd");
  return new Promise<ExecResult>((resolve) => {
    let settled = false;
    let timedOut = false;
    let cancelled = false;
    const chunks: Buffer[] = [];
    let total = 0;
    let truncated = false;

    const child = spawn(request.executable, [...request.args], {
      cwd: request.cwd,
      shell: useShell,
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
      // Python tools would otherwise leave __pycache__ trees in the project after validation.
      env: { ...(request.env ?? process.env), PYTHONDONTWRITEBYTECODE: "1" }
    });

    const collect = (data: Buffer): void => {
      chunks.push(data);
      total += data.length;
      // Keep only the newest bytes; older output is dropped and reported as truncated.
      while (total > request.maxOutputBytes * 2 && chunks.length > 1) {
        const first = chunks.shift();
        total -= first?.length ?? 0;
        truncated = true;
      }
    };
    child.stdout.on("data", collect);
    child.stderr.on("data", collect);

    const terminate = (): void => {
      child.kill("SIGTERM");
      const timer = setTimeout(() => {
        child.kill("SIGKILL");
      }, KILL_GRACE_MS);
      timer.unref();
    };
    const timer = setTimeout(() => {
      timedOut = true;
      terminate();
    }, request.timeoutMs);
    const onAbort = (): void => {
      cancelled = true;
      terminate();
    };
    request.signal.addEventListener("abort", onAbort, { once: true });

    const finish = (exitCode: number | null, spawnError: string | undefined): void => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timer);
      request.signal.removeEventListener("abort", onAbort);
      let text = Buffer.concat(chunks).toString("utf8");
      if (text.length > request.maxOutputBytes) {
        text = text.slice(text.length - request.maxOutputBytes);
        truncated = true;
      }
      const output = redactSecrets(text, request.knownSecrets, request.maxOutputBytes + 1_000);
      resolve({
        exitCode,
        timedOut,
        cancelled,
        spawnError,
        durationMs: Date.now() - started,
        output,
        outputTruncated: truncated
      });
    };

    child.on("error", (error: Error) => {
      finish(null, error.message);
    });
    child.on("close", (code) => {
      finish(code, undefined);
    });
  });
}
