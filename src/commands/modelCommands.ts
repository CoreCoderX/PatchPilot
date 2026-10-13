import { AiError, isAiError } from "../ai/errors";
import type { ChatProvider } from "../ai/types";
import type { AiSettingsResult } from "../config/aiSettings";
import { describeUnknownError, type Logger } from "../log";
import type { ApiKeyStore } from "../secrets/apiKeyStore";
import { buildConsentMessage } from "../ui/consentText";
import type { LastConnectionTest } from "../ui/overviewModel";
import { redactSecrets } from "../security/redact";
import { gateModelAction } from "../workspace/trustGate";

/** UI operations the model commands need. The VS Code adapter implements this; tests use fakes. */
export interface ModelUi {
  inputApiKey(): Promise<string | undefined>;
  confirm(title: string, detail: string, confirmLabel: string): Promise<boolean>;
  /** Runs `task` with a cancellable progress indicator. Cancelling aborts the signal. */
  runWithProgress<T>(title: string, task: (signal: AbortSignal) => Promise<T>): Promise<T>;
  showInfo(message: string): void;
  showWarning(message: string): void;
  showError(message: string): void;
}

export type ProviderFactory = (config: { baseUrl: string; apiKey: string; timeoutMs: number }) => ChatProvider;

export interface ModelCommandDeps {
  readonly keyStore: ApiKeyStore;
  readonly readSettings: () => AiSettingsResult;
  readonly exclusionPatterns: () => readonly string[];
  readonly isTrusted: () => boolean;
  readonly createProvider: ProviderFactory;
  readonly ui: ModelUi;
  readonly log: Logger;
  readonly onTestRecorded: (test: LastConnectionTest) => void;
  readonly onKeyChanged: () => void;
  readonly now: () => Date;
}

export type CommandOutcome =
  | "saved"
  | "cleared"
  | "invalid_key"
  | "cancelled"
  | "declined"
  | "invalid_config"
  | "blocked"
  | "missing_key"
  | "passed"
  | AiErrorOutcome;

export type AiErrorOutcome =
  | "auth"
  | "rate_limited"
  | "bad_request"
  | "server"
  | "network"
  | "timeout"
  | "invalid_response"
  | "failed";

/** Fixed connectivity prompt. It contains no workspace data and no credentials. */
export const CONNECTION_TEST_MESSAGES = [
  { role: "system", content: "You are a connectivity check. Reply with exactly: PatchPilot OK" },
  { role: "user", content: "ping" }
] as const;

export async function setApiKey(deps: ModelCommandDeps): Promise<CommandOutcome> {
  const raw = await deps.ui.inputApiKey();
  if (raw === undefined) {
    return "cancelled";
  }
  try {
    await deps.keyStore.set(raw);
  } catch (error) {
    deps.ui.showError(describeUnknownError(error).replace(/^Error: /, ""));
    return "invalid_key";
  }
  deps.log.info("API key stored in VS Code secret storage (value not logged).");
  deps.onKeyChanged();
  deps.ui.showInfo("PatchPilot API key saved in VS Code secret storage.");
  return "saved";
}

export async function clearApiKey(deps: ModelCommandDeps): Promise<CommandOutcome> {
  const confirmed = await deps.ui.confirm(
    "PatchPilot: remove stored API key?",
    "The key will be deleted from VS Code secret storage. You can add it again later.",
    "Remove key"
  );
  if (!confirmed) {
    return "cancelled";
  }
  await deps.keyStore.clear();
  deps.log.info("API key removed from VS Code secret storage.");
  deps.onKeyChanged();
  deps.ui.showInfo("PatchPilot API key removed.");
  return "cleared";
}

export async function testConnection(deps: ModelCommandDeps): Promise<CommandOutcome> {
  const settingsResult = deps.readSettings();
  if (!settingsResult.ok) {
    deps.ui.showError(settingsResult.message);
    return "invalid_config";
  }
  const { settings, endpointLabel } = settingsResult;

  const gate = gateModelAction({ isTrusted: deps.isTrusted(), sendsWorkspaceContent: false });
  if (!gate.allowed) {
    deps.ui.showWarning(gate.reason);
    return "blocked";
  }

  const apiKey = await deps.keyStore.get();
  if (apiKey === undefined) {
    deps.ui.showWarning('No API key is stored. Run "PatchPilot: Set Model API Key" first.');
    return "missing_key";
  }

  const consent = buildConsentMessage({
    purpose: "Test model connection. PatchPilot sends one fixed test sentence to check that the endpoint responds.",
    endpointLabel,
    model: settings.model,
    dataDescription: "one fixed test sentence. No workspace files, source code, or dependency data.",
    exclusionCount: deps.exclusionPatterns().length
  });
  const confirmed = await deps.ui.confirm(consent.title, consent.detail, consent.confirmLabel);
  if (!confirmed) {
    return "declined";
  }

  const started = Date.now();
  try {
    const provider = deps.createProvider({
      baseUrl: settings.baseUrl,
      apiKey,
      timeoutMs: settings.timeoutSeconds * 1000
    });
    const result = await deps.ui.runWithProgress("PatchPilot: testing model connection", (signal) =>
      provider.complete(
        { model: settings.model, maxTokens: 16, messages: CONNECTION_TEST_MESSAGES.map((m) => ({ ...m })) },
        { signal }
      )
    );
    const seconds = ((Date.now() - started) / 1000).toFixed(1);
    const summary = `Endpoint replied with ${String(result.text.length)} characters in ${seconds} s.`;
    deps.onTestRecorded({ succeeded: true, summary, at: deps.now() });
    deps.log.info(`Connection test passed: endpoint=${endpointLabel} model=${settings.model} ${summary}`);
    deps.ui.showInfo(`Connection test passed. ${summary}`);
    return "passed";
  } catch (error) {
    return reportFailure(deps, error, endpointLabel, settings.model, apiKey);
  }
}

function reportFailure(
  deps: ModelCommandDeps,
  error: unknown,
  endpointLabel: string,
  model: string,
  apiKey: string
): CommandOutcome {
  const knownSecrets = [apiKey, ...deps.keyStore.knownSecretValues()];
  if (isAiError(error) && error.kind === "cancelled") {
    deps.ui.showWarning("Connection test cancelled.");
    deps.log.info(`Connection test cancelled: endpoint=${endpointLabel} model=${model}`);
    return "cancelled";
  }
  const message = isAiError(error)
    ? error.message
    : `Unexpected error: ${describeUnknownError(error)}`;
  const safe = redactSecrets(message, knownSecrets, 1000);
  deps.onTestRecorded({ succeeded: false, summary: safe, at: deps.now() });
  deps.log.error(`Connection test failed: endpoint=${endpointLabel} model=${model} ${safe}`);
  deps.ui.showError(`Connection test failed. ${safe}`);
  return outcomeFor(error);
}

function outcomeFor(error: unknown): AiErrorOutcome {
  if (!(error instanceof AiError)) {
    return "failed";
  }
  switch (error.kind) {
    case "auth":
      return "auth";
    case "rate_limited":
      return "rate_limited";
    case "bad_request":
      return "bad_request";
    case "server":
      return "server";
    case "network":
      return "network";
    case "timeout":
      return "timeout";
    case "invalid_response":
      return "invalid_response";
    default:
      return "failed";
  }
}
