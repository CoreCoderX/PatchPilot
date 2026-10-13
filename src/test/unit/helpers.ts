import * as assert from "node:assert/strict";
import { AiError } from "../../ai/errors";

/** Narrows a discriminated `ok: true` result, failing the test otherwise. */
export function assertOk<T extends { readonly ok: boolean }>(value: T): asserts value is Extract<T, { readonly ok: true }> {
  assert.equal(value.ok, true, "expected ok result");
}

/** Narrows a discriminated `ok: false` result, failing the test otherwise. */
export function assertNotOk<T extends { readonly ok: boolean }>(value: T): asserts value is Extract<T, { readonly ok: false }> {
  assert.equal(value.ok, false, "expected failed result");
}

/** Narrows a discriminated `allowed: false` gate result, failing the test otherwise. */
export function assertDenied<T extends { readonly allowed: boolean }>(value: T): asserts value is Extract<T, { readonly allowed: false }> {
  assert.equal(value.allowed, false, "expected denied result");
}

export function bodyText(init: RequestInit | undefined): string {
  return typeof init?.body === "string" ? init.body : "";
}

const encoder = new TextEncoder();

/** A Response whose body is delivered in the given chunks (simulates network splits). */
export function chunkedResponse(chunks: readonly string[], init: ResponseInit): Response {
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) {
        controller.enqueue(encoder.encode(chunk));
      }
      controller.close();
    }
  });
  return new Response(body, init);
}

export function sseResponse(events: readonly string[]): Response {
  const chunks = events.map((data) => `data: ${data}\n\n`);
  return chunkedResponse([...chunks, "data: [DONE]\n\n"], {
    status: 200,
    headers: { "content-type": "text/event-stream" }
  });
}

export function jsonResponse(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", ...headers }
  });
}

export function deltaEvent(content: string): string {
  return JSON.stringify({ choices: [{ delta: { content } }] });
}

/** Resolves with the rejection's AiError kind, or fails the test if no AiError was thrown. */
export async function expectAiError(promise: Promise<unknown>): Promise<AiError> {
  try {
    await promise;
  } catch (error) {
    if (error instanceof AiError) {
      return error;
    }
    throw new Error(`Expected AiError, got ${String(error)}`);
  }
  throw new Error("Expected the promise to reject with AiError, but it resolved.");
}
