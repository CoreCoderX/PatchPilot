import { chatCompletionsUrl, describeEndpoint, parseBaseUrl } from "./endpoint";
import { AiError } from "./errors";
import { sseDataEvents } from "./sse";
import type { ChatCompletionOptions, ChatProvider, ChatRequest, ChatResult } from "./types";
import { redactSecrets } from "../security/redact";

export type FetchLike = (url: string, init: RequestInit) => Promise<Response>;

export interface OpenAICompatibleConfig {
  /** Base URL such as https://api.openai.com/v1. Validated by parseBaseUrl. */
  readonly baseUrl: string;
  readonly apiKey: string;
  /** Total time budget for one request, including streaming. */
  readonly timeoutMs: number;
  /** Injection seam for tests. Defaults to the global fetch. */
  readonly fetchImpl?: FetchLike;
}

const MAX_ERROR_BODY_CHARS = 2000;
const MAX_RETRY_AFTER_SECONDS = 3600;

/**
 * Fetch-based client for OpenAI-compatible Chat Completions endpoints.
 * It streams when the server streams and falls back to a plain JSON response otherwise.
 * It does not retry automatically; rate limits and failures are reported to the caller.
 */
export class OpenAICompatibleProvider implements ChatProvider {
  readonly id = "openai-compatible";
  readonly endpointLabel: string;

  private readonly url: string;
  private readonly apiKey: string;
  private readonly timeoutMs: number;
  private readonly fetchImpl: FetchLike;

  constructor(config: OpenAICompatibleConfig) {
    if (config.apiKey.length === 0) {
      throw new AiError("missing_key", "No API key is configured.");
    }
    if (!Number.isFinite(config.timeoutMs) || config.timeoutMs <= 0) {
      throw new AiError("invalid_config", "The request timeout must be a positive number of milliseconds.");
    }
    const base = parseBaseUrl(config.baseUrl);
    this.url = chatCompletionsUrl(base);
    this.endpointLabel = describeEndpoint(base);
    this.apiKey = config.apiKey;
    this.timeoutMs = config.timeoutMs;
    this.fetchImpl = config.fetchImpl ?? ((url, init) => fetch(url, init));
  }

  async complete(request: ChatRequest, options: ChatCompletionOptions): Promise<ChatResult> {
    if (options.signal.aborted) {
      throw new AiError("cancelled", "The model request was cancelled.");
    }

    const controller = new AbortController();
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, this.timeoutMs);
    const onExternalAbort = (): void => {
      controller.abort();
    };
    options.signal.addEventListener("abort", onExternalAbort, { once: true });

    const failure = (error: unknown): AiError => {
      if (error instanceof AiError) {
        return error;
      }
      if (options.signal.aborted) {
        return new AiError("cancelled", "The model request was cancelled.");
      }
      if (timedOut) {
        return new AiError("timeout", `The model did not finish within ${String(Math.round(this.timeoutMs / 1000))} seconds.`);
      }
      return new AiError("network", "Could not complete the request to the model endpoint (network error).");
    };

    try {
      const response = await this.send(request, controller.signal);
      if (!response.ok) {
        throw await this.httpError(response);
      }
      const contentType = response.headers.get("content-type") ?? "";
      if (contentType.includes("text/event-stream")) {
        return await this.readStream(response, options);
      }
      return await this.readJson(response);
    } catch (error) {
      throw failure(error);
    } finally {
      clearTimeout(timer);
      options.signal.removeEventListener("abort", onExternalAbort);
    }
  }

  private send(request: ChatRequest, signal: AbortSignal): Promise<Response> {
    const body: Record<string, unknown> = {
      model: request.model,
      messages: request.messages.map((message) => ({ role: message.role, content: message.content })),
      stream: true
    };
    if (request.maxTokens !== undefined) {
      body.max_tokens = request.maxTokens;
    }
    return this.fetchImpl(this.url, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${this.apiKey}`,
        "Content-Type": "application/json",
        Accept: "text/event-stream, application/json"
      },
      body: JSON.stringify(body),
      signal
    });
  }

  private async readStream(response: Response, options: ChatCompletionOptions): Promise<ChatResult> {
    if (response.body === null) {
      throw new AiError("invalid_response", "The model endpoint returned an empty stream.");
    }
    let text = "";
    for await (const data of sseDataEvents(decodeChunks(response.body))) {
      if (data === "[DONE]") {
        break;
      }
      const event = this.parseJsonObject(data);
      const errorMessage = extractErrorMessage(event);
      if (errorMessage !== undefined) {
        throw new AiError("server", `The model endpoint reported an error: ${this.redact(errorMessage)}`);
      }
      const delta = extractStreamDelta(event);
      if (delta !== undefined && delta.length > 0) {
        text += delta;
        options.onDelta?.(delta);
      }
    }
    if (text.length === 0) {
      throw new AiError("invalid_response", "The model returned no text.");
    }
    return { text };
  }

  private async readJson(response: Response): Promise<ChatResult> {
    const event = this.parseJsonObject(await response.text());
    const errorMessage = extractErrorMessage(event);
    if (errorMessage !== undefined) {
      throw new AiError("server", `The model endpoint reported an error: ${this.redact(errorMessage)}`);
    }
    const content = extractMessageContent(event);
    if (content === undefined || content.length === 0) {
      throw new AiError("invalid_response", "The model returned no text.");
    }
    return { text: content };
  }

  private parseJsonObject(raw: string): Record<string, unknown> {
    let value: unknown;
    try {
      value = JSON.parse(raw) as unknown;
    } catch {
      throw new AiError("invalid_response", "The model endpoint returned malformed JSON.");
    }
    if (!isRecord(value)) {
      throw new AiError("invalid_response", "The model endpoint returned an unexpected JSON shape.");
    }
    return value;
  }

  private async httpError(response: Response): Promise<AiError> {
    const status = response.status;
    const detail = this.redact(await readBodySnippet(response));
    const suffix = detail.length > 0 ? ` Details: ${detail}` : "";

    if (status === 401 || status === 403) {
      return new AiError(
        "auth",
        `The model endpoint rejected the API key (HTTP ${String(status)}). Update the key with "PatchPilot: Set Model API Key".${suffix}`,
        { status }
      );
    }
    if (status === 429) {
      const retryAfterSeconds = parseRetryAfter(response.headers.get("retry-after"));
      const wait =
        retryAfterSeconds === undefined ? "" : ` Retry after about ${String(retryAfterSeconds)} seconds.`;
      return new AiError("rate_limited", `The model endpoint is rate limiting requests (HTTP 429).${wait}${suffix}`, {
        status,
        ...(retryAfterSeconds === undefined ? {} : { retryAfterSeconds })
      });
    }
    if (status >= 500) {
      return new AiError("server", `The model endpoint failed (HTTP ${String(status)}).${suffix}`, { status });
    }
    return new AiError("bad_request", `The model endpoint rejected the request (HTTP ${String(status)}).${suffix}`, {
      status
    });
  }

  private redact(text: string): string {
    return redactSecrets(text, [this.apiKey], MAX_ERROR_BODY_CHARS);
  }
}

async function* decodeChunks(body: ReadableStream<Uint8Array>): AsyncGenerator<string> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let finished = false;
  try {
    for (;;) {
      const next = await reader.read();
      if (next.done) {
        finished = true;
        break;
      }
      yield decoder.decode(next.value, { stream: true });
    }
    const tail = decoder.decode();
    if (tail.length > 0) {
      yield tail;
    }
  } finally {
    if (!finished) {
      await reader.cancel().catch(() => undefined);
    }
  }
}

async function readBodySnippet(response: Response): Promise<string> {
  try {
    return (await response.text()).slice(0, MAX_ERROR_BODY_CHARS);
  } catch {
    return "";
  }
}

function parseRetryAfter(value: string | null): number | undefined {
  if (value === null) {
    return undefined;
  }
  const seconds = Number(value.trim());
  if (!Number.isFinite(seconds) || seconds < 0) {
    return undefined;
  }
  return Math.min(Math.ceil(seconds), MAX_RETRY_AFTER_SECONDS);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function firstChoice(event: Record<string, unknown>): Record<string, unknown> | undefined {
  const choices = event.choices;
  if (!Array.isArray(choices)) {
    return undefined;
  }
  const first: unknown = choices[0];
  return isRecord(first) ? first : undefined;
}

function extractStreamDelta(event: Record<string, unknown>): string | undefined {
  const choice = firstChoice(event);
  const delta = choice?.delta;
  if (!isRecord(delta)) {
    return undefined;
  }
  return typeof delta.content === "string" ? delta.content : undefined;
}

function extractMessageContent(event: Record<string, unknown>): string | undefined {
  const choice = firstChoice(event);
  const message = choice?.message;
  if (!isRecord(message)) {
    return undefined;
  }
  return typeof message.content === "string" ? message.content : undefined;
}

function extractErrorMessage(event: Record<string, unknown>): string | undefined {
  const error = event.error;
  if (typeof error === "string") {
    return error;
  }
  if (isRecord(error) && typeof error.message === "string") {
    return error.message;
  }
  return undefined;
}
