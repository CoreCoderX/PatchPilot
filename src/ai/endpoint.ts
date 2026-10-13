import { AiError } from "./errors";

const LOCAL_HOSTNAMES = new Set(["localhost", "127.0.0.1", "[::1]"]);

/**
 * Validates a user-configured API base URL. Requires https, or http only for loopback
 * hosts (for local model servers). Rejects embedded credentials, queries, and fragments
 * so that an API key can never be sent to an ambiguous or unexpected destination.
 */
export function parseBaseUrl(raw: string): URL {
  const trimmed = raw.trim();
  let url: URL;
  try {
    url = new URL(trimmed);
  } catch {
    throw new AiError("invalid_config", "The API base URL is not a valid absolute URL.");
  }
  if (url.username !== "" || url.password !== "") {
    throw new AiError("invalid_config", "The API base URL must not contain credentials.");
  }
  if (url.search !== "" || url.hash !== "") {
    throw new AiError("invalid_config", "The API base URL must not include a query string or fragment.");
  }
  const isHttps = url.protocol === "https:";
  const isLoopbackHttp = url.protocol === "http:" && LOCAL_HOSTNAMES.has(url.hostname);
  if (!isHttps && !isLoopbackHttp) {
    throw new AiError(
      "invalid_config",
      "The API base URL must use https. Plain http is allowed only for localhost, 127.0.0.1, or [::1]."
    );
  }
  url.pathname = url.pathname.replace(/\/+$/, "");
  return url;
}

/** Chat Completions endpoint for a validated base URL. */
export function chatCompletionsUrl(base: URL): string {
  return `${base.origin}${base.pathname}/chat/completions`;
}

/** Endpoint text safe for display: origin and path only. */
export function describeEndpoint(base: URL): string {
  return `${base.origin}${base.pathname}`;
}
