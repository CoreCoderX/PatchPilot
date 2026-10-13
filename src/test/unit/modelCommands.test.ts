import * as assert from "node:assert/strict";
import { describe, it } from "mocha";
import { AiError } from "../../ai/errors";
import type { ChatCompletionOptions, ChatProvider, ChatRequest, ChatResult } from "../../ai/types";
import {
  clearApiKey,
  setApiKey,
  testConnection,
  type ModelCommandDeps,
  type ModelUi
} from "../../commands/modelCommands";
import type { AiSettingsResult } from "../../config/aiSettings";
import { RedactingLogger } from "../../log";
import { ApiKeyStore, type SecretStorageLike } from "../../secrets/apiKeyStore";
import type { LastConnectionTest } from "../../ui/overviewModel";

const KEY = "sk-cmd-SECRET-KEY-555666";

class MemorySecrets implements SecretStorageLike {
  readonly values = new Map<string, string>();
  get(key: string): Promise<string | undefined> {
    return Promise.resolve(this.values.get(key));
  }
  store(key: string, value: string): Promise<void> {
    this.values.set(key, value);
    return Promise.resolve();
  }
  delete(key: string): Promise<void> {
    this.values.delete(key);
    return Promise.resolve();
  }
}

class FakeUi implements ModelUi {
  apiKeyInput: string | undefined = KEY;
  confirmAnswer = true;
  readonly confirmations: { title: string; detail: string }[] = [];
  readonly infos: string[] = [];
  readonly warnings: string[] = [];
  readonly errors: string[] = [];
  activeController: AbortController | undefined;

  inputApiKey(): Promise<string | undefined> {
    return Promise.resolve(this.apiKeyInput);
  }
  confirm(title: string, detail: string): Promise<boolean> {
    this.confirmations.push({ title, detail });
    return Promise.resolve(this.confirmAnswer);
  }
  runWithProgress<T>(_title: string, task: (signal: AbortSignal) => Promise<T>): Promise<T> {
    const controller = new AbortController();
    this.activeController = controller;
    return task(controller.signal);
  }
  showInfo(message: string): void {
    this.infos.push(message);
  }
  showWarning(message: string): void {
    this.warnings.push(message);
  }
  showError(message: string): void {
    this.errors.push(message);
  }
  allUserVisibleText(): string {
    return [...this.infos, ...this.warnings, ...this.errors, ...this.confirmations.flatMap((c) => [c.title, c.detail])].join("\n");
  }
}

class FakeProvider implements ChatProvider {
  readonly id = "openai-compatible";
  readonly endpointLabel = "https://api.example.test/v1";
  readonly requests: ChatRequest[] = [];
  behavior: (options: ChatCompletionOptions) => Promise<ChatResult> = () => Promise.resolve({ text: "PatchPilot OK" });
  complete(request: ChatRequest, options: ChatCompletionOptions): Promise<ChatResult> {
    this.requests.push(request);
    return this.behavior(options);
  }
}

interface Harness {
  deps: ModelCommandDeps;
  ui: FakeUi;
  secrets: MemorySecrets;
  keyStore: ApiKeyStore;
  provider: FakeProvider;
  providerConfigs: { baseUrl: string; apiKey: string; timeoutMs: number }[];
  logLines: string[];
  tests: LastConnectionTest[];
  keyChanges: number;
  settings: AiSettingsResult;
}

function harness(overrides: Partial<{ trusted: boolean; settings: AiSettingsResult; exclusions: string[] }> = {}): Harness {
  const secrets = new MemorySecrets();
  const keyStore = new ApiKeyStore(secrets, "openai-compatible");
  const ui = new FakeUi();
  const provider = new FakeProvider();
  const providerConfigs: { baseUrl: string; apiKey: string; timeoutMs: number }[] = [];
  const logLines: string[] = [];
  const tests: LastConnectionTest[] = [];
  const settings: AiSettingsResult = overrides.settings ?? {
    ok: true,
    endpointLabel: "https://api.example.test/v1",
    settings: { baseUrl: "https://api.example.test/v1", model: "demo-model", timeoutSeconds: 30 }
  };
  const state = { keyChanges: 0 };
  const deps: ModelCommandDeps = {
    keyStore,
    readSettings: () => settings,
    exclusionPatterns: () => overrides.exclusions ?? [".env"],
    isTrusted: () => overrides.trusted ?? true,
    createProvider: (config) => {
      providerConfigs.push(config);
      return provider;
    },
    ui,
    log: new RedactingLogger({ appendLine: (line) => logLines.push(line) }, () => keyStore.knownSecretValues()),
    onTestRecorded: (test) => tests.push(test),
    onKeyChanged: () => {
      state.keyChanges += 1;
    },
    now: () => new Date(0)
  };
  return {
    deps,
    ui,
    secrets,
    keyStore,
    provider,
    providerConfigs,
    logLines,
    tests,
    get keyChanges() {
      return state.keyChanges;
    },
    settings
  };
}

describe("setApiKey", () => {
  it("stores a valid key in secret storage and refreshes the view", async () => {
    const h = harness();
    assert.equal(await setApiKey(h.deps), "saved");
    assert.equal(await h.keyStore.get(), KEY);
    assert.equal(h.keyChanges, 1);
  });

  it("rejects an invalid key without storing anything", async () => {
    const h = harness();
    h.ui.apiKeyInput = "bad key with spaces";
    assert.equal(await setApiKey(h.deps), "invalid_key");
    assert.equal(h.secrets.values.size, 0);
    assert.equal(h.ui.errors.length, 1);
  });

  it("returns cancelled when the user dismisses the input box", async () => {
    const h = harness();
    h.ui.apiKeyInput = undefined;
    assert.equal(await setApiKey(h.deps), "cancelled");
    assert.equal(h.secrets.values.size, 0);
  });

  it("never writes the key to the log or to any user-visible message", async () => {
    const h = harness();
    await setApiKey(h.deps);
    assert.ok(!h.logLines.join("\n").includes(KEY));
    assert.ok(!h.ui.allUserVisibleText().includes(KEY));
  });
});

describe("clearApiKey", () => {
  it("removes the stored key after confirmation", async () => {
    const h = harness();
    await setApiKey(h.deps);
    assert.equal(await clearApiKey(h.deps), "cleared");
    assert.equal(await h.keyStore.has(), false);
  });

  it("keeps the key when the user declines", async () => {
    const h = harness();
    await setApiKey(h.deps);
    h.ui.confirmAnswer = false;
    assert.equal(await clearApiKey(h.deps), "cancelled");
    assert.equal(await h.keyStore.has(), true);
  });
});

describe("testConnection", () => {
  it("reports invalid settings without creating a provider or contacting anything", async () => {
    const h = harness({ settings: { ok: false, message: "patchpilot.ai.model is required." } });
    await setApiKey(h.deps);
    assert.equal(await testConnection(h.deps), "invalid_config");
    assert.equal(h.providerConfigs.length, 0);
    assert.ok(h.ui.errors.some((message) => message.includes("model is required")));
  });

  it("asks the user to set a key first when none is stored", async () => {
    const h = harness();
    assert.equal(await testConnection(h.deps), "missing_key");
    assert.equal(h.providerConfigs.length, 0);
    assert.equal(h.ui.confirmations.length, 0);
  });

  it("shows the endpoint, host, model, and data before sending, and sends nothing if declined", async () => {
    const h = harness();
    await setApiKey(h.deps);
    h.ui.confirmAnswer = false;
    assert.equal(await testConnection(h.deps), "declined");
    assert.equal(h.provider.requests.length, 0);
    const consent = h.ui.confirmations[0];
    assert.ok(consent);
    assert.ok(consent.detail.includes("Host that will receive the request: api.example.test"));
    assert.ok(consent.detail.includes("Model: demo-model"));
    assert.ok(consent.detail.includes("one fixed test sentence"));
  });

  it("sends only the fixed test prompt, never the key, and records success", async () => {
    const h = harness();
    await setApiKey(h.deps);
    assert.equal(await testConnection(h.deps), "passed");

    assert.equal(h.provider.requests.length, 1);
    const request = h.provider.requests[0];
    assert.ok(request);
    assert.equal(request.model, "demo-model");
    assert.equal(request.maxTokens, 16);
    const promptText = JSON.stringify(request.messages);
    assert.ok(!promptText.includes(KEY), "prompt must not contain the key");
    assert.ok(promptText.includes("PatchPilot OK"));

    assert.equal(h.providerConfigs[0]?.timeoutMs, 30000);
    assert.equal(h.tests.length, 1);
    assert.equal(h.tests[0]?.succeeded, true);
    assert.ok(h.ui.infos.some((message) => message.includes("Connection test passed")));
  });

  it("maps an auth failure, recording and showing it without the key", async () => {
    const h = harness();
    await setApiKey(h.deps);
    h.provider.behavior = () =>
      Promise.reject(new AiError("auth", `Rejected key ${KEY}`, { status: 401 }));
    assert.equal(await testConnection(h.deps), "auth");
    assert.equal(h.tests[0]?.succeeded, false);
    assert.ok(!h.tests[0]?.summary.includes(KEY));
    assert.ok(!h.ui.allUserVisibleText().includes(KEY));
    assert.ok(!h.logLines.join("\n").includes(KEY));
  });

  it("maps rate limiting and network failures to their own outcomes", async () => {
    const h = harness();
    await setApiKey(h.deps);
    h.provider.behavior = () => Promise.reject(new AiError("rate_limited", "slow down", { status: 429 }));
    assert.equal(await testConnection(h.deps), "rate_limited");
    h.provider.behavior = () => Promise.reject(new AiError("network", "offline"));
    assert.equal(await testConnection(h.deps), "network");
  });

  it("treats an unexpected non-AiError as a generic failure", async () => {
    const h = harness();
    await setApiKey(h.deps);
    h.provider.behavior = () => Promise.reject(new Error("boom"));
    assert.equal(await testConnection(h.deps), "failed");
    assert.ok(h.ui.errors.some((message) => message.includes("boom")));
  });

  it("cancels cleanly when the user cancels progress, without recording a failed test", async () => {
    const h = harness();
    await setApiKey(h.deps);
    h.provider.behavior = (options) =>
      new Promise<ChatResult>((_resolve, reject) => {
        options.signal.addEventListener("abort", () => {
          reject(new AiError("cancelled", "cancelled"));
        });
      });
    const pending = testConnection(h.deps);
    await new Promise((resolve) => setTimeout(resolve, 5));
    h.ui.activeController?.abort();
    assert.equal(await pending, "cancelled");
    assert.equal(h.tests.length, 0);
    assert.ok(h.ui.warnings.some((message) => message.includes("cancelled")));
  });
});
