const MIN_SECRET_LENGTH = 4;

/**
 * Removes secret material from text before it is logged, shown to the user, or stored.
 * Known secret values are removed exactly. Common credential shapes are masked as a backstop.
 * This is best-effort; it does not replace keeping secrets out of the data in the first place.
 */
export function redactSecrets(text: string, knownSecrets: readonly string[] = [], maxLength = 2000): string {
  let out = text;
  for (const secret of knownSecrets) {
    if (secret.length >= MIN_SECRET_LENGTH) {
      out = out.split(secret).join("[REDACTED]");
    }
  }
  out = out.replace(/Bearer\s+[A-Za-z0-9._~+/=-]+/gi, "Bearer [REDACTED]");
  out = out.replace(/\bsk-[A-Za-z0-9_-]{6,}/g, "[REDACTED]");
  out = out.replace(/\b(api[-_]?key|authorization)(["'\s:=]+)[^\s"',}]+/gi, "$1$2[REDACTED]");
  if (out.length > maxLength) {
    out = `${out.slice(0, maxLength)}...[truncated]`;
  }
  return out;
}
