import * as assert from "node:assert/strict";
import * as http from "node:http";
import type { AddressInfo } from "node:net";
import { after, before, describe, it } from "mocha";
import { OpenAICompatibleProvider } from "../../ai/openaiCompatible";
import { expectAiError } from "./helpers";

/**
 * Exercises the real fetch path against a loopback HTTP server. No external network is used.
 * The server checks the authorization header and request shape, then streams SSE with delays.
 */
const KEY = "local-test-key-ABCDEF123456";

let server: http.Server;
let baseUrl = "";
let lastAuthorization: string | undefined;
let lastBody = "";
let mode: "stream" | "hang" | "unauthorized" = "stream";

const request = {
  model: "local-model",
  messages: [{ role: "user" as const, content: "ping" }]
};

describe("OpenAICompatibleProvider against a local HTTP server", () => {
  before(async () => {
    server = http.createServer((req, res) => {
      lastAuthorization = req.headers.authorization;
      let raw = "";
      req.on("data", (chunk: Buffer) => {
        raw += chunk.toString("utf8");
      });
      req.on("end", () => {
        lastBody = raw;
        if (mode === "unauthorized") {
          res.writeHead(401, { "content-type": "application/json" });
          res.end(JSON.stringify({ error: { message: "bad key" } }));
          return;
        }
        if (mode === "hang") {
          res.writeHead(200, { "content-type": "text/event-stream" });
          res.write('data: {"choices":[{"delta":{"content":"partial"}}]}\n\n');
          // Never finish: the client must cancel or time out.
          return;
        }
        res.writeHead(200, { "content-type": "text/event-stream" });
        const parts = ['data: {"choices":[{"delta":{"content":"Patch"}}]}\n\n', 'data: {"choices":[{"delta":{"content":"Pilot OK"}}]}\n\n', "data: [DONE]\n\n"];
        let index = 0;
        const timer = setInterval(() => {
          const part = parts[index] ?? "";
          if (index >= parts.length) {
            clearInterval(timer);
            res.end();
            return;
          }
          res.write(part);
          index += 1;
        }, 5);
      });
    });
    await new Promise<void>((resolve) => {
      server.listen(0, "127.0.0.1", () => {
        resolve();
      });
    });
    const address = server.address() as AddressInfo;
    baseUrl = `http://127.0.0.1:${String(address.port)}/v1`;
  });

  after(async () => {
    // Stalled streams keep sockets open; drop them so close() can finish.
    server.closeAllConnections();
    await new Promise<void>((resolve) => {
      server.close(() => {
        resolve();
      });
    });
  });

  it("sends the bearer key in the header only and streams the reply", async () => {
    mode = "stream";
    const provider = new OpenAICompatibleProvider({ baseUrl, apiKey: KEY, timeoutMs: 5000 });
    const fragments: string[] = [];
    const result = await provider.complete(request, {
      signal: new AbortController().signal,
      onDelta: (text) => fragments.push(text)
    });

    assert.equal(result.text, "PatchPilot OK");
    assert.deepEqual(fragments, ["Patch", "Pilot OK"]);
    assert.equal(lastAuthorization, `Bearer ${KEY}`);
    assert.ok(!lastBody.includes(KEY), "the key must not appear in the request body");
    assert.equal((JSON.parse(lastBody) as { stream: unknown }).stream, true);
  });

  it("maps a real 401 response to auth without exposing the key", async () => {
    mode = "unauthorized";
    const provider = new OpenAICompatibleProvider({ baseUrl, apiKey: KEY, timeoutMs: 5000 });
    const error = await expectAiError(provider.complete(request, { signal: new AbortController().signal }));
    assert.equal(error.kind, "auth");
    assert.ok(!error.message.includes(KEY));
  });

  it("cancels a stalled stream when the user cancels", async () => {
    mode = "hang";
    const provider = new OpenAICompatibleProvider({ baseUrl, apiKey: KEY, timeoutMs: 10000 });
    const controller = new AbortController();
    const pending = provider.complete(request, { signal: controller.signal });
    setTimeout(() => {
      controller.abort();
    }, 150);
    const error = await expectAiError(pending);
    assert.equal(error.kind, "cancelled");
  });

  it("times out a stalled stream that exceeds the time budget", async () => {
    mode = "hang";
    const provider = new OpenAICompatibleProvider({ baseUrl, apiKey: KEY, timeoutMs: 200 });
    const error = await expectAiError(provider.complete(request, { signal: new AbortController().signal }));
    assert.equal(error.kind, "timeout");
  });
});
