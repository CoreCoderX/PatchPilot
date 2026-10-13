export interface ModelActionRequest {
  readonly isTrusted: boolean;
  /** True when the request would include file or project content from the workspace. */
  readonly sendsWorkspaceContent: boolean;
}

export type GateResult = { readonly allowed: true } | { readonly allowed: false; readonly reason: string };

/**
 * Decides whether a model-backed action may proceed in the current trust state.
 * Requests carrying no workspace content (for example, a connection test) are allowed in
 * restricted mode. Anything that sends workspace content requires a trusted workspace.
 */
export function gateModelAction(request: ModelActionRequest): GateResult {
  if (request.sendsWorkspaceContent && !request.isTrusted) {
    return {
      allowed: false,
      reason: "Sending workspace content to a model requires a trusted workspace. Trust this folder to continue."
    };
  }
  return { allowed: true };
}
