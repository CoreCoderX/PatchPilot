import * as assert from "node:assert/strict";
import { describe, it } from "mocha";
import { MAX_SSE_LINE_LENGTH, sseDataEvents } from "../../ai/sse";

async function collect(chunks: readonly string[]): Promise<string[]> {
  async function* source(): AsyncGenerator<string> {
    for (const chunk of chunks) {
      await Promise.resolve();
      yield chunk;
    }
  }
  const events: string[] = [];
  for await (const event of sseDataEvents(source())) {
    events.push(event);
  }
  return events;
}

describe("sseDataEvents", () => {
  it("yields one payload per blank-line-terminated event", async () => {
    const events = await collect(["data: one\n\ndata: two\n\n"]);
    assert.deepEqual(events, ["one", "two"]);
  });

  it("joins multiple data lines of one event with newlines", async () => {
    const events = await collect(["data: first\ndata: second\n\n"]);
    assert.deepEqual(events, ["first\nsecond"]);
  });

  it("handles events split across arbitrary chunk boundaries", async () => {
    const events = await collect(["da", "ta: hel", "lo\n", "\ndata: wor", "ld\n\n"]);
    assert.deepEqual(events, ["hello", "world"]);
  });

  it("handles CRLF split across chunks without emitting a spurious event", async () => {
    const events = await collect(["data: a\r", "\n\r", "\ndata: b\r\n\r\n"]);
    assert.deepEqual(events, ["a", "b"]);
  });

  it("ignores comments and non-data fields", async () => {
    const events = await collect([": keep-alive\nevent: message\nid: 7\ndata: payload\n\n"]);
    assert.deepEqual(events, ["payload"]);
  });

  it("flushes a final event that lacks a trailing blank line", async () => {
    const events = await collect(["data: tail"]);
    assert.deepEqual(events, ["tail"]);
  });

  it("produces nothing for an empty stream", async () => {
    assert.deepEqual(await collect([]), []);
  });

  it("rejects a line longer than the maximum", async () => {
    const huge = "data: " + "x".repeat(MAX_SSE_LINE_LENGTH + 10);
    await assert.rejects(collect([huge]), /maximum length/);
  });
});
