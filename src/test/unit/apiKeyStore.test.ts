import * as assert from "node:assert/strict";
import { describe, it } from "mocha";
import { ApiKeyStore, SECRET_KEY_PREFIX, validateApiKey, type SecretStorageLike } from "../../secrets/apiKeyStore";

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

describe("validateApiKey", () => {
  it("trims surrounding whitespace", () => {
    assert.equal(validateApiKey("  sk-abc123  "), "sk-abc123");
  });

  it("rejects empty input", () => {
    assert.throws(() => validateApiKey("   "), /empty/);
  });

  it("rejects keys containing spaces or line breaks", () => {
    assert.throws(() => validateApiKey("sk-abc 123"), /spaces or line breaks/);
    assert.throws(() => validateApiKey("sk-abc\n123"), /spaces or line breaks/);
  });

  it("rejects implausibly long input", () => {
    assert.throws(() => validateApiKey("x".repeat(5000)), /unexpectedly long/);
  });
});

describe("ApiKeyStore", () => {
  it("stores the key only in secret storage under a provider-specific name", async () => {
    const secrets = new MemorySecrets();
    const store = new ApiKeyStore(secrets, "openai-compatible");
    await store.set("sk-first-value-1");

    assert.deepEqual([...secrets.values.keys()], [`${SECRET_KEY_PREFIX}openai-compatible`]);
    assert.equal(secrets.values.get(`${SECRET_KEY_PREFIX}openai-compatible`), "sk-first-value-1");
  });

  it("round-trips get, has, and clear", async () => {
    const store = new ApiKeyStore(new MemorySecrets(), "openai-compatible");
    assert.equal(await store.has(), false);
    await store.set("sk-round-trip-2");
    assert.equal(await store.get(), "sk-round-trip-2");
    assert.equal(await store.has(), true);
    await store.clear();
    assert.equal(await store.get(), undefined);
    assert.equal(await store.has(), false);
  });

  it("does not store invalid input", async () => {
    const secrets = new MemorySecrets();
    const store = new ApiKeyStore(secrets, "openai-compatible");
    await assert.rejects(store.set("bad key"), /spaces/);
    assert.equal(secrets.values.size, 0);
  });

  it("remembers handled values for redaction, and forgets them after clear", async () => {
    const store = new ApiKeyStore(new MemorySecrets(), "openai-compatible");
    await store.set("sk-remembered-3");
    assert.deepEqual(store.knownSecretValues(), ["sk-remembered-3"]);
    await store.clear();
    assert.deepEqual(store.knownSecretValues(), []);
  });
});
