import * as assert from "node:assert/strict";
import { describe, it } from "mocha";
import { redactSecrets } from "../../security/redact";

describe("redactSecrets", () => {
  it("removes every occurrence of a known secret", () => {
    const out = redactSecrets("key=SECRET-VALUE-123 again SECRET-VALUE-123", ["SECRET-VALUE-123"]);
    assert.equal(out, "key=[REDACTED] again [REDACTED]");
  });

  it("masks bearer tokens and sk- style keys even when unknown", () => {
    const out = redactSecrets("Authorization: Bearer abc.def-ghi and sk-proj-AbCdEf123456");
    assert.ok(!out.includes("abc.def-ghi"));
    assert.ok(!out.includes("sk-proj-AbCdEf123456"));
    assert.ok(out.includes("[REDACTED]"));
  });

  it("masks api_key style assignments in JSON-like text", () => {
    const out = redactSecrets('{"api_key": "hunter2hunter2"}');
    assert.ok(!out.includes("hunter2hunter2"));
  });

  it("ignores very short known values to avoid mangling unrelated text", () => {
    assert.equal(redactSecrets("ab cd", ["ab"]), "ab cd");
  });

  it("truncates long output", () => {
    const out = redactSecrets("x".repeat(50), [], 10);
    assert.equal(out, "xxxxxxxxxx...[truncated]");
  });
});
