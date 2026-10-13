import { parseBaseUrl, describeEndpoint } from "../ai/endpoint";
import { isAiError } from "../ai/errors";

export const DEFAULT_BASE_URL = "https://api.openai.com/v1";
export const DEFAULT_TIMEOUT_SECONDS = 60;
export const MIN_TIMEOUT_SECONDS = 5;
export const MAX_TIMEOUT_SECONDS = 300;

export interface AiSettings {
  readonly baseUrl: string;
  readonly model: string;
  readonly timeoutSeconds: number;
}

export interface RawAiSettings {
  readonly baseUrl: unknown;
  readonly model: unknown;
  readonly timeoutSeconds: unknown;
}

export type AiSettingsResult =
  | { readonly ok: true; readonly settings: AiSettings; readonly endpointLabel: string }
  | { readonly ok: false; readonly message: string };

const MODEL_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:/@-]{0,199}$/;

/** Validates raw configuration values. Never reads secrets. */
export function validateAiSettings(raw: RawAiSettings): AiSettingsResult {
  if (typeof raw.baseUrl !== "string") {
    return { ok: false, message: "patchpilot.ai.baseUrl must be a string." };
  }
  let endpointLabel: string;
  try {
    endpointLabel = describeEndpoint(parseBaseUrl(raw.baseUrl));
  } catch (error) {
    return { ok: false, message: isAiError(error) ? error.message : "Invalid patchpilot.ai.baseUrl." };
  }

  if (typeof raw.model !== "string" || !MODEL_ID_PATTERN.test(raw.model.trim())) {
    return {
      ok: false,
      message: "Set patchpilot.ai.model to the model ID your endpoint expects (letters, digits, and . _ : / @ -)."
    };
  }

  if (
    typeof raw.timeoutSeconds !== "number" ||
    !Number.isInteger(raw.timeoutSeconds) ||
    raw.timeoutSeconds < MIN_TIMEOUT_SECONDS ||
    raw.timeoutSeconds > MAX_TIMEOUT_SECONDS
  ) {
    return {
      ok: false,
      message: `patchpilot.ai.timeoutSeconds must be a whole number from ${String(MIN_TIMEOUT_SECONDS)} to ${String(MAX_TIMEOUT_SECONDS)}.`
    };
  }

  return {
    ok: true,
    endpointLabel,
    settings: { baseUrl: raw.baseUrl.trim(), model: raw.model.trim(), timeoutSeconds: raw.timeoutSeconds }
  };
}
