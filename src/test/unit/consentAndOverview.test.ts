import * as assert from "node:assert/strict";
import { describe, it } from "mocha";
import { buildConsentMessage } from "../../ui/consentText";
import { buildOverviewRows, type OverviewState } from "../../ui/overviewModel";

describe("buildConsentMessage", () => {
  const message = buildConsentMessage({
    purpose: "Test model connection.",
    endpointLabel: "https://api.example.test/v1/chat/completions",
    model: "demo-model",
    dataDescription: "one fixed test sentence.",
    exclusionCount: 18
  });

  it("names the receiving host, full endpoint, model, and data sent", () => {
    assert.ok(message.detail.includes("Host that will receive the request: api.example.test"));
    assert.ok(message.detail.includes("Endpoint: https://api.example.test/v1/chat/completions"));
    assert.ok(message.detail.includes("Model: demo-model"));
    assert.ok(message.detail.includes("Data sent: one fixed test sentence."));
    assert.ok(message.detail.includes("18 patterns"));
  });

  it("states that the key is sent only in the authorization header", () => {
    assert.ok(message.detail.includes("authorization header"));
  });

  it("offers an explicit send action", () => {
    assert.equal(message.confirmLabel, "Send request");
  });
});

describe("buildOverviewRows", () => {
  const base: OverviewState = {
    isTrusted: true,
    settingsError: undefined,
    endpointLabel: "https://api.example.test/v1",
    model: "demo-model",
    keyStored: true,
    lastTest: undefined
  };

  function row(state: OverviewState, id: string) {
    const found = buildOverviewRows(state).find((candidate) => candidate.id === id);
    assert.ok(found, `missing row ${id}`);
    return found;
  }

  it("shows restricted trust state and blocks nothing it cannot verify", () => {
    const untrusted = row({ ...base, isTrusted: false }, "trust");
    assert.equal(untrusted.description, "Restricted");
    assert.equal(row(base, "trust").description, "Trusted");
  });

  it("shows the configured endpoint and model", () => {
    const settings = row(base, "settings");
    assert.equal(settings.description, "demo-model at https://api.example.test/v1");
  });

  it("reports a settings error instead of an endpoint", () => {
    const settings = row({ ...base, settingsError: "bad url", endpointLabel: undefined, model: undefined }, "settings");
    assert.equal(settings.description, "Invalid");
    assert.equal(settings.tooltip, "bad url");
  });

  it("offers Set when no key is stored and Clear when one is, never displaying a value", () => {
    const missing = row({ ...base, keyStored: false }, "key");
    assert.equal(missing.description, "Not set");
    assert.equal(missing.command, "patchpilot.setApiKey");

    const stored = row(base, "key");
    assert.equal(stored.description, "Stored in VS Code secret storage");
    assert.equal(stored.command, "patchpilot.clearApiKey");
  });

  it("reports the last connection test outcome with its summary", () => {
    assert.equal(row(base, "test").description, "Not run this session");
    const failed = row(
      { ...base, lastTest: { succeeded: false, summary: "auth failed", at: new Date(0) } },
      "test"
    );
    assert.equal(failed.description, "Failed");
    assert.ok(failed.tooltip.startsWith("auth failed"));
  });

  it("offers dependency analysis in a trusted workspace and blocks it in restricted mode", () => {
    const trusted = row(base, "analysis");
    assert.equal(trusted.description, "Ready");
    assert.equal(trusted.command, "patchpilot.analyzeDependencies");
    const restricted = row({ ...base, isTrusted: false }, "analysis");
    assert.equal(restricted.description, "Needs trusted workspace");
  });
});
