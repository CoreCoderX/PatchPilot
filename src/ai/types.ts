/** Provider-neutral chat types. Concrete providers live beside this file. */

export type ChatRole = "system" | "user" | "assistant";

export interface ChatMessage {
  readonly role: ChatRole;
  readonly content: string;
}

export interface ChatRequest {
  readonly model: string;
  readonly messages: readonly ChatMessage[];
  readonly maxTokens?: number;
}

export interface ChatCompletionOptions {
  /** Cancels the in-flight request. Aborting maps to an AiError of kind "cancelled". */
  readonly signal: AbortSignal;
  /** Receives each streamed text fragment as it arrives. */
  readonly onDelta?: (text: string) => void;
}

export interface ChatResult {
  readonly text: string;
}

export interface ChatProvider {
  /** Stable identifier, for example "openai-compatible". */
  readonly id: string;
  /** Human-readable endpoint without credentials or query, shown in consent prompts. */
  readonly endpointLabel: string;
  complete(request: ChatRequest, options: ChatCompletionOptions): Promise<ChatResult>;
}
