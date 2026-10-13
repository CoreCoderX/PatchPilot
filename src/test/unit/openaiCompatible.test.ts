import * as assert from "node:assert/strict";
import { describe, it } from "mocha";
import { OpenAICompatibleProvider, type FetchLike } from "../../ai/openaiCompatible";
import type { ChatRequest } from "../../ai/types";
import { bodyText, deltaEvent, expectAiError, chunkedResponse, jsonResponse, sseResponse } from "./helpers";

const KEY = "sk-test-SECRET-KEY-98765";
const REQUEST: ChatRequest = {
  model: "test-model",
  messages: [
    { role: "system", content: "Reply with exactly: PatchPilot OK" },
    { role: "user", content: "ping" }
  ],
  maxTokens: 16
};

interface Capture {
  url: string;
  init: RequestInit;
}

function providerWith(fetchImpl: FetchLike, timeoutMs = 5000): OpenAICompatibleProvider {
  return new OpenAICompatibleProvider({
    baseUrl: "https://api.example.test/v1",
    apiKey: KEY,
    timeoutMs,
    fetchImpl
  });
}

function fakeFetch(respond: () => Response | Promise<Response>, captures: Capture[] = []): FetchLike {
  return async (url, init) => {
    captures.push({ url, init });
    return respond();
  };
}

describe("OpenAICompatibleProvider construction", () => {
  it("refuses to build without a key", () => {
    assert.throws(
      () => new OpenAICompatibleProvider({ baseUrl: "https://api.example.test/v1", apiKey: "", timeoutMs: 1000 }),
      (error: unknown) => error instanceof Error && error.message.includes("No API key")
    );
  });

  it("refuses an insecure remote endpoint before any request is made", () => {
    assert.throws(
      () => new OpenAICompatibleProvider({ baseUrl: "http://evil.example.test/v1", apiKey: KEY, timeoutMs: 1000 }),
      /https/
    );
  });

  it("exposes an endpoint label without credentials or query", () => {
    const provider = providerWith(fakeFetch(() => sseResponse([deltaEvent("ok")])));
    assert.equal(provider.endpointLabel, "https://api.example.test/v1");
    assert.ok(!provider.endpointLabel.includes(KEY));
  });
});

describe("OpenAICompatibleProvider request construction", () => {
  it("posts to the chat completions URL with bearer auth and a streaming body", async () => {
    const captures: Capture[] = [];
    const provider = providerWith(fakeFetch(() => sseResponse([deltaEvent("PatchPilot OK")]), captures));

    await provider.complete(REQUEST, { signal: new AbortController().signal });

    assert.equal(captures.length, 1);
    const capture = captures[0];
    assert.ok(capture);
    assert.equal(capture.url, "https://api.example.test/v1/chat/completions");
    assert.equal(capture.init.method, "POST");
    const headers = capture.init.headers as Record<string, string>;
    assert.equal(headers.Authorization, `Bearer ${KEY}`);
    const body = bodyText(capture.init);
    const parsed = JSON.parse(body) as Record<string, unknown>;
    assert.equal(parsed.model, "test-model");
    assert.equal(parsed.stream, true);
    assert.equal(parsed.max_tokens, 16);
  });

  it("never places the API key in the prompt content", async () => {
    const captures: Capture[] = [];
    const provider = providerWith(fakeFetch(() => sseResponse([deltaEvent("ok")]), captures));
    await provider.complete(REQUEST, { signal: new AbortController().signal });
    const body = bodyText(captures[0]?.init);
    assert.ok(!body.includes(KEY), "request body must not contain the API key");
  });
});

describe("OpenAICompatibleProvider response handling", () => {
  it("accumulates streamed deltas and reports each fragment as it arrives", async () => {
    const provider = providerWith(
      fakeFetch(() => sseResponse([deltaEvent("Patch"), deltaEvent("Pilot"), deltaEvent(" OK")]))
    );
    const fragments: string[] = [];
    const result = await provider.complete(REQUEST, {
      signal: new AbortController().signal,
      onDelta: (text) => fragments.push(text)
    });
    assert.equal(result.text, "PatchPilot OK");
    assert.deepEqual(fragments, ["Patch", "Pilot", " OK"]);
  });

  it("handles SSE events split across network chunks", async () => {
    const chunks = [
      'data: {"choices":[{"delta":{"content":"Hel',
      'lo"}}]}\n\ndata: {"choices":[{"delta":{"content":" there"}}]}\r',
      "\n\r\ndata: [DONE]\n\n"
    ];
    const provider = providerWith(
      fakeFetch(() => chunkedResponse(chunks, { status: 200, headers: { "content-type": "text/event-stream" } }))
    );
    const result = await provider.complete(REQUEST, { signal: new AbortController().signal });
    assert.equal(result.text, "Hello there");
  });

  it("falls back to a plain JSON completion when the server does not stream", async () => {
    const provider = providerWith(
      fakeFetch(() => jsonResponse({ choices: [{ message: { role: "assistant", content: "PatchPilot OK" } }] }))
    );
    const result = await provider.complete(REQUEST, { signal: new AbortController().signal });
    assert.equal(result.text, "PatchPilot OK");
  });

  it("reports malformed JSON in a stream as an invalid response", async () => {
    const provider = providerWith(fakeFetch(() => sseResponse(["{not json"])));
    const error = await expectAiError(provider.complete(REQUEST, { signal: new AbortController().signal }));
    assert.equal(error.kind, "invalid_response");
  });

  it("reports an empty completion as an invalid response", async () => {
    const provider = providerWith(fakeFetch(() => sseResponse([deltaEvent("")])));
    const error = await expectAiError(provider.complete(REQUEST, { signal: new AbortController().signal }));
    assert.equal(error.kind, "invalid_response");
  });

  it("reports an error object returned inside a stream as a server error", async () => {
    const provider = providerWith(
      fakeFetch(() => sseResponse([JSON.stringify({ error: { message: `quota exceeded for ${KEY}` } })]))
    );
    const error = await expectAiError(provider.complete(REQUEST, { signal: new AbortController().signal }));
    assert.equal(error.kind, "server");
    assert.ok(!error.message.includes(KEY), "error text must be redacted");
  });

  it("reports a JSON body with an unexpected shape as an invalid response", async () => {
    const provider = providerWith(fakeFetch(() => jsonResponse(["not", "an", "object"])));
    const error = await expectAiError(provider.complete(REQUEST, { signal: new AbortController().signal }));
    assert.equal(error.kind, "invalid_response");
  });
});

describe("OpenAICompatibleProvider HTTP error mapping", () => {
  it("maps 401 to auth and never echoes the key even if the server reflects it", async () => {
    const provider = providerWith(
      fakeFetch(() => jsonResponse({ error: { message: `Incorrect API key provided: ${KEY}` } }, 401))
    );
    const error = await expectAiError(provider.complete(REQUEST, { signal: new AbortController().signal }));
    assert.equal(error.kind, "auth");
    assert.equal(error.status, 401);
    assert.ok(!error.message.includes(KEY), "auth error must not contain the key");
    assert.ok(error.message.includes("[REDACTED]"));
  });

  it("maps 403 to auth", async () => {
    const provider = providerWith(fakeFetch(() => jsonResponse({ error: "forbidden" }, 403)));
    const error = await expectAiError(provider.complete(REQUEST, { signal: new AbortController().signal }));
    assert.equal(error.kind, "auth");
  });

  it("maps 429 to rate_limited and keeps Retry-After seconds", async () => {
    const provider = providerWith(
      fakeFetch(() => jsonResponse({ error: "slow down" }, 429, { "retry-after": "7" }))
    );
    const error = await expectAiError(provider.complete(REQUEST, { signal: new AbortController().signal }));
    assert.equal(error.kind, "rate_limited");
    assert.equal(error.retryAfterSeconds, 7);
  });

  it("ignores a Retry-After value that is not a number", async () => {
    const provider = providerWith(
      fakeFetch(() => new Response("{}", { status: 429, headers: { "retry-after": "Wed, 21 Oct 2026 07:28:00 GMT" } }))
    );
    const error = await expectAiError(provider.complete(REQUEST, { signal: new AbortController().signal }));
    assert.equal(error.kind, "rate_limited");
    assert.equal(error.retryAfterSeconds, undefined);
  });

  it("maps 5xx to server", async () => {
    const provider = providerWith(fakeFetch(() => new Response("upstream down", { status: 503 })));
    const error = await expectAiError(provider.complete(REQUEST, { signal: new AbortController().signal }));
    assert.equal(error.kind, "server");
    assert.equal(error.status, 503);
  });

  it("maps 4xx such as an unknown model to bad_request with the server's detail", async () => {
    const provider = providerWith(
      fakeFetch(() => jsonResponse({ error: { message: "The model does not exist" } }, 404))
    );
    const error = await expectAiError(provider.complete(REQUEST, { signal: new AbortController().signal }));
    assert.equal(error.kind, "bad_request");
    assert.ok(error.message.includes("The model does not exist"));
  });
});

describe("OpenAICompatibleProvider transport failures", () => {
  it("maps a rejected fetch to a network error without leaking the low-level message", async () => {
    const provider = providerWith(() => Promise.reject(new TypeError(`fetch failed for ${KEY}`)));
    const error = await expectAiError(provider.complete(REQUEST, { signal: new AbortController().signal }));
    assert.equal(error.kind, "network");
    assert.ok(!error.message.includes(KEY));
  });

  it("maps a request that exceeds the time budget to timeout", async () => {
    const provider = providerWith((_url, init) => {
      return new Promise<Response>((_resolve, reject) => {
        init.signal?.addEventListener("abort", () => {
          reject(new DOMException("aborted", "AbortError"));
        });
      });
    }, 25);
    const error = await expectAiError(provider.complete(REQUEST, { signal: new AbortController().signal }));
    assert.equal(error.kind, "timeout");
  });

  it("maps user cancellation to cancelled", async () => {
    const userController = new AbortController();
    const provider = providerWith((_url, init) => {
      return new Promise<Response>((_resolve, reject) => {
        init.signal?.addEventListener("abort", () => {
          reject(new DOMException("aborted", "AbortError"));
        });
      });
    });
    const pending = provider.complete(REQUEST, { signal: userController.signal });
    setTimeout(() => {
      userController.abort();
    }, 10);
    const error = await expectAiError(pending);
    assert.equal(error.kind, "cancelled");
  });

  it("does not call fetch when the signal is already aborted", async () => {
    let called = false;
    const provider = providerWith(() => {
      called = true;
      return Promise.resolve(sseResponse([deltaEvent("ok")]));
    });
    const controller = new AbortController();
    controller.abort();
    const error = await expectAiError(provider.complete(REQUEST, { signal: controller.signal }));
    assert.equal(error.kind, "cancelled");
    assert.equal(called, false);
  });
});
