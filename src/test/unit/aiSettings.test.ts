import * as assert from "node:assert/strict";
import { describe, it } from "mocha";
import { validateAiSettings } from "../../config/aiSettings";
import { assertNotOk, assertOk } from "./helpers";

const valid = {
  baseUrl: "https://api.openai.com/v1",
  model: "gpt-test-mini",
  timeoutSeconds: 60
};

describe("validateAiSettings", () => {
  it("accepts a complete configuration and reports the display endpoint", () => {
    const result = validateAiSettings(valid);
    assertOk(result);
    assert.equal(result.endpointLabel, "https://api.openai.com/v1");
    assert.equal(result.settings.model, "gpt-test-mini");
    assert.equal(result.settings.timeoutSeconds, 60);
  });

  it("rejects a non-string base URL", () => {
    const result = validateAiSettings({ ...valid, baseUrl: 42 });
    assert.equal(result.ok, false);
  });

  it("rejects an insecure remote base URL with a helpful message", () => {
    const result = validateAiSettings({ ...valid, baseUrl: "http://remote.example.test/v1" });
    assertNotOk(result);
    assert.ok(result.message.includes("https"));
  });

  it("requires a model ID and rejects characters that could smuggle content", () => {
    assert.equal(validateAiSettings({ ...valid, model: "" }).ok, false);
    assert.equal(validateAiSettings({ ...valid, model: undefined }).ok, false);
    assert.equal(validateAiSettings({ ...valid, model: "model name with spaces" }).ok, false);
    assert.equal(validateAiSettings({ ...valid, model: "x\n{\"role\":\"system\"}" }).ok, false);
  });

  it("accepts common model ID shapes", () => {
    for (const model of ["gpt-4o-mini", "meta-llama/Llama-3.1-8B", "llama3:8b", "vendor@v2.1"]) {
      assert.equal(validateAiSettings({ ...valid, model }).ok, true, model);
    }
  });

  it("enforces whole-number timeout bounds", () => {
    assert.equal(validateAiSettings({ ...valid, timeoutSeconds: 4 }).ok, false);
    assert.equal(validateAiSettings({ ...valid, timeoutSeconds: 301 }).ok, false);
    assert.equal(validateAiSettings({ ...valid, timeoutSeconds: 12.5 }).ok, false);
    assert.equal(validateAiSettings({ ...valid, timeoutSeconds: "60" }).ok, false);
    assert.equal(validateAiSettings({ ...valid, timeoutSeconds: 5 }).ok, true);
    assert.equal(validateAiSettings({ ...valid, timeoutSeconds: 300 }).ok, true);
  });
});
