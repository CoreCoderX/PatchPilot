export const DEFAULT_COMMAND_TIMEOUT_SECONDS = 300;
export const MIN_COMMAND_TIMEOUT_SECONDS = 10;
export const MAX_COMMAND_TIMEOUT_SECONDS = 3600;
export const DEFAULT_REPAIR_ITERATIONS = 2;
export const MIN_REPAIR_ITERATIONS = 1;
export const MAX_REPAIR_ITERATIONS = 5;
/** Output kept from each validation command, after redaction. */
export const MAX_COMMAND_OUTPUT_BYTES = 16_000;

export interface UpgradeSettings {
  readonly commandTimeoutMs: number;
  readonly repairMaxIterations: number;
}

export type UpgradeSettingsResult = { readonly ok: true; readonly settings: UpgradeSettings } | { readonly ok: false; readonly message: string };

function integerIn(value: unknown, min: number, max: number, fallback: number): number | undefined {
  if (value === undefined) {
    return fallback;
  }
  if (typeof value !== "number" || !Number.isInteger(value) || value < min || value > max) {
    return undefined;
  }
  return value;
}

/** Validates the raw configuration. Out-of-range values are rejected, not clamped. */
export function validateUpgradeSettings(raw: { commandTimeoutSeconds?: unknown; repairMaxIterations?: unknown }): UpgradeSettingsResult {
  const timeout = integerIn(raw.commandTimeoutSeconds, MIN_COMMAND_TIMEOUT_SECONDS, MAX_COMMAND_TIMEOUT_SECONDS, DEFAULT_COMMAND_TIMEOUT_SECONDS);
  if (timeout === undefined) {
    return { ok: false, message: `commandTimeoutSeconds must be an integer from ${String(MIN_COMMAND_TIMEOUT_SECONDS)} to ${String(MAX_COMMAND_TIMEOUT_SECONDS)}.` };
  }
  const iterations = integerIn(raw.repairMaxIterations, MIN_REPAIR_ITERATIONS, MAX_REPAIR_ITERATIONS, DEFAULT_REPAIR_ITERATIONS);
  if (iterations === undefined) {
    return { ok: false, message: `repairMaxIterations must be an integer from ${String(MIN_REPAIR_ITERATIONS)} to ${String(MAX_REPAIR_ITERATIONS)}.` };
  }
  return { ok: true, settings: { commandTimeoutMs: timeout * 1000, repairMaxIterations: iterations } };
}
