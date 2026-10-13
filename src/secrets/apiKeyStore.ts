/** The subset of vscode.SecretStorage used here. Kept structural so tests need no VS Code. */
export interface SecretStorageLike {
  get(key: string): PromiseLike<string | undefined>;
  store(key: string, value: string): PromiseLike<void>;
  delete(key: string): PromiseLike<void>;
}

export const SECRET_KEY_PREFIX = "patchpilot.ai.apiKey.";
const MAX_API_KEY_LENGTH = 4096;

/** Checks a key typed by the user. Throws an Error whose message is safe to show. */
export function validateApiKey(raw: string): string {
  const trimmed = raw.trim();
  if (trimmed.length === 0) {
    throw new Error("The API key is empty.");
  }
  if (trimmed.length > MAX_API_KEY_LENGTH) {
    throw new Error("The API key is unexpectedly long.");
  }
  if (/\s/.test(trimmed)) {
    throw new Error("The API key must not contain spaces or line breaks.");
  }
  return trimmed;
}

/**
 * Stores one API key per provider in VS Code secret storage. Keys are never written to
 * settings, files, or logs. The store remembers values it has returned so log redaction
 * can mask them even when they appear in unexpected output.
 */
export class ApiKeyStore {
  private readonly seen = new Set<string>();
  private readonly secretName: string;

  constructor(
    private readonly secrets: SecretStorageLike,
    providerId: string
  ) {
    this.secretName = `${SECRET_KEY_PREFIX}${providerId}`;
  }

  async get(): Promise<string | undefined> {
    const value = await this.secrets.get(this.secretName);
    if (value !== undefined && value.length > 0) {
      this.seen.add(value);
      return value;
    }
    return undefined;
  }

  async has(): Promise<boolean> {
    return (await this.get()) !== undefined;
  }

  async set(rawKey: string): Promise<void> {
    const key = validateApiKey(rawKey);
    await this.secrets.store(this.secretName, key);
    this.seen.add(key);
  }

  async clear(): Promise<void> {
    await this.secrets.delete(this.secretName);
    this.seen.clear();
  }

  /** Values this store has handled in this session, for redaction only. Never display these. */
  knownSecretValues(): string[] {
    return [...this.seen];
  }
}
