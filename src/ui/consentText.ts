export interface ConsentInput {
  readonly purpose: string;
  /** Endpoint origin and path, without credentials or query. */
  readonly endpointLabel: string;
  readonly model: string;
  /** Plain-language summary of exactly what leaves the machine. */
  readonly dataDescription: string;
  readonly exclusionCount: number;
}

export interface ConsentMessage {
  readonly title: string;
  readonly detail: string;
  readonly confirmLabel: string;
}

export function buildConsentMessage(input: ConsentInput): ConsentMessage {
  const host = new URL(input.endpointLabel).host;
  const lines = [
    input.purpose,
    "",
    `Endpoint: ${input.endpointLabel}`,
    `Host that will receive the request: ${host}`,
    `Model: ${input.model}`,
    "",
    `Data sent: ${input.dataDescription}`,
    "Your API key is sent only in the authorization header to this endpoint. It is never included in the message content.",
    `Context exclusions active: ${String(input.exclusionCount)} patterns (for example .env files and key files).`,
    "Exclusions are best-effort. Check the data above before continuing."
  ];
  return {
    title: "PatchPilot: send data to a model endpoint?",
    detail: lines.join("\n"),
    confirmLabel: "Send request"
  };
}
