/** Stable error categories for model-endpoint failures. Messages never contain secrets. */
export type AiErrorKind =
  | "missing_key"
  | "invalid_config"
  | "auth"
  | "rate_limited"
  | "bad_request"
  | "server"
  | "network"
  | "timeout"
  | "cancelled"
  | "invalid_response";

export interface AiErrorDetails {
  readonly status?: number;
  readonly retryAfterSeconds?: number;
}

export class AiError extends Error {
  readonly kind: AiErrorKind;
  readonly status: number | undefined;
  readonly retryAfterSeconds: number | undefined;

  constructor(kind: AiErrorKind, message: string, details: AiErrorDetails = {}) {
    super(message);
    this.name = "AiError";
    this.kind = kind;
    this.status = details.status;
    this.retryAfterSeconds = details.retryAfterSeconds;
  }
}

export function isAiError(value: unknown): value is AiError {
  return value instanceof AiError;
}
