import type { Lookup } from "../analysis/types";

export type FetchLike = (url: string, init: RequestInit) => Promise<Response>;

export interface HttpOptions {
  readonly fetchImpl: FetchLike;
  readonly timeoutMs: number;
  readonly maxBytes: number;
  readonly signal: AbortSignal;
  readonly accept: string;
  readonly method?: "GET" | "POST";
  readonly body?: string;
}

export const USER_AGENT = "PatchPilot/0.3 (VS Code extension; dependency metadata lookup)";

/**
 * Performs one bounded HTTP request and returns its text body as a Lookup.
 * - 404 maps to "not-found" (a definitive answer, not a failure).
 * - Rate limits, server errors, network errors, timeouts, and oversize bodies map to "unavailable".
 * It never throws, so one failing source cannot abort a whole analysis.
 */
export async function httpText(url: string, options: HttpOptions): Promise<Lookup<string>> {
  const controller = new AbortController();
  const timing = { timedOut: false };
  const timer = setTimeout(() => {
    timing.timedOut = true;
    controller.abort();
  }, options.timeoutMs);
  const onOuterAbort = (): void => {
    controller.abort();
  };
  options.signal.addEventListener("abort", onOuterAbort, { once: true });

  try {
    const init: RequestInit = {
      method: options.method ?? "GET",
      headers: {
        Accept: options.accept,
        "User-Agent": USER_AGENT,
        ...(options.body === undefined ? {} : { "Content-Type": "application/json" })
      },
      signal: controller.signal
    };
    if (options.body !== undefined) {
      init.body = options.body;
    }
    const response = await options.fetchImpl(url, init);
    if (response.status === 404) {
      await discardBody(response);
      return { kind: "not-found" };
    }
    if (response.status === 429) {
      const retry = response.headers.get("retry-after");
      await discardBody(response);
      return { kind: "unavailable", reason: `rate limited (HTTP 429)${retry === null ? "" : `, retry after ${retry}s`}` };
    }
    if (!response.ok) {
      await discardBody(response);
      return { kind: "unavailable", reason: `HTTP ${String(response.status)}` };
    }
    const text = await readCapped(response, options.maxBytes);
    if (text === undefined) {
      return { kind: "unavailable", reason: `response exceeds ${String(Math.round(options.maxBytes / 1_000_000))} MB limit` };
    }
    return { kind: "found", value: text };
  } catch {
    if (options.signal.aborted) {
      return { kind: "unavailable", reason: "cancelled" };
    }
    if (timing.timedOut) {
      return { kind: "unavailable", reason: `timed out after ${String(Math.round(options.timeoutMs / 1000))} s` };
    }
    return { kind: "unavailable", reason: "network error" };
  } finally {
    clearTimeout(timer);
    options.signal.removeEventListener("abort", onOuterAbort);
  }
}

async function discardBody(response: Response): Promise<void> {
  try {
    await response.body?.cancel();
  } catch {
    // Ignore: the body is already unusable.
  }
}

/** The subset of the WHATWG stream reader this module uses (the DOM lib is not enabled). */
interface ChunkReader {
  read(): Promise<{ done: boolean; value?: Uint8Array }>;
  cancel(): Promise<void>;
}

async function readCapped(response: Response, maxBytes: number): Promise<string | undefined> {
  if (response.body === null) {
    return "";
  }
  const reader = (response.body as unknown as { getReader(): ChunkReader }).getReader();
  const decoder = new TextDecoder();
  let total = 0;
  let text = "";
  for (;;) {
    const next = await reader.read();
    if (next.done) {
      break;
    }
    const chunk = next.value ?? new Uint8Array(0);
    total += chunk.byteLength;
    if (total > maxBytes) {
      await reader.cancel().catch(() => undefined);
      return undefined;
    }
    text += decoder.decode(chunk, { stream: true });
  }
  return text + decoder.decode();
}
