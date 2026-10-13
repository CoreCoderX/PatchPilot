import * as assert from "node:assert/strict";
import { describe, it } from "mocha";
import { chatCompletionsUrl, describeEndpoint, parseBaseUrl } from "../../ai/endpoint";
import { AiError } from "../../ai/errors";

describe("parseBaseUrl", () => {
  it("accepts https endpoints and builds the Chat Completions URL", () => {
    const base = parseBaseUrl("https://api.openai.com/v1");
    assert.equal(chatCompletionsUrl(base), "https://api.openai.com/v1/chat/completions");
    assert.equal(describeEndpoint(base), "https://api.openai.com/v1");
  });

  it("strips trailing slashes so the path is not doubled", () => {
    const base = parseBaseUrl("  https://example.test/api/v1///  ");
    assert.equal(chatCompletionsUrl(base), "https://example.test/api/v1/chat/completions");
  });

  it("allows plain http only for loopback hosts", () => {
    assert.equal(parseBaseUrl("http://localhost:11434/v1").hostname, "localhost");
    assert.equal(parseBaseUrl("http://127.0.0.1:8080/v1").hostname, "127.0.0.1");
    assert.equal(parseBaseUrl("http://[::1]:8080/v1").hostname, "[::1]");
  });

  it("rejects plain http to a remote host", () => {
    assert.throws(() => parseBaseUrl("http://api.example.test/v1"), (error: unknown) => {
      return error instanceof AiError && error.kind === "invalid_config" && error.message.includes("https");
    });
  });

  it("rejects embedded credentials", () => {
    assert.throws(() => parseBaseUrl("https://user:pw@api.example.test/v1"), AiError);
  });

  it("rejects query strings and fragments", () => {
    assert.throws(() => parseBaseUrl("https://api.example.test/v1?key=abc"), AiError);
    assert.throws(() => parseBaseUrl("https://api.example.test/v1#frag"), AiError);
  });

  it("rejects non-URL and unsupported schemes", () => {
    assert.throws(() => parseBaseUrl("not a url"), AiError);
    assert.throws(() => parseBaseUrl("ftp://api.example.test/v1"), AiError);
    assert.throws(() => parseBaseUrl(""), AiError);
  });
});
