import { redactSecrets } from "./security/redact";

export interface LogSink {
  appendLine(value: string): void;
}

export interface Logger {
  info(message: string): void;
  warn(message: string): void;
  error(message: string): void;
}

/**
 * Writes log lines to a sink after masking known secret values.
 * `secretValues` is read at write time so newly handled keys are masked immediately.
 */
export class RedactingLogger implements Logger {
  constructor(
    private readonly sink: LogSink,
    private readonly secretValues: () => readonly string[] = () => []
  ) {}

  info(message: string): void {
    this.write("INFO", message);
  }

  warn(message: string): void {
    this.write("WARN", message);
  }

  error(message: string): void {
    this.write("ERROR", message);
  }

  private write(level: string, message: string): void {
    const safe = redactSecrets(message, this.secretValues(), 4000);
    this.sink.appendLine(`${new Date().toISOString()} ${level} ${safe}`);
  }
}

export function describeUnknownError(error: unknown): string {
  return error instanceof Error ? `${error.name}: ${error.message}` : String(error);
}
