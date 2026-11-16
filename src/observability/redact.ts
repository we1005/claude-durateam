/**
 * Secret and PII redaction for every artifact/log line this project writes.
 *
 * Rules:
 *  - Exact known secrets are replaced first (the loaded API token, derived
 *    header forms).
 *  - Then generic credential shapes (Bearer tokens, x-api-key headers,
 *    "token=..." assignments) are masked.
 *  - Absolute macOS user paths are collapsed to `~/...` so logs can be shared.
 */

const MASK = "[REDACTED]";

const GENERIC_PATTERNS: Array<{ regex: RegExp; replace: string }> = [
  // Authorization: Bearer <token>
  { regex: /(Bearer\s+)[A-Za-z0-9._~+/=\-]{8,}/gi, replace: `$1${MASK}` },
  // x-api-key / api-key headers and JSON/env assignments
  {
    regex: /((?:x-api-key|api[-_]?key|auth[-_]?token|access[-_]?token)\s*["']?\s*[:=]\s*["']?)[^\s"',;}]{8,}/gi,
    replace: `$1${MASK}`,
  },
  // Anthropic-style keys anywhere in a sentence
  { regex: /\bsk-[A-Za-z0-9._\-]{12,}/g, replace: MASK },
];

/** Replace exact secret values (longest first) plus generic credential shapes. */
export function redactSecrets(input: string, secrets: readonly string[] = []): string {
  let out = input;
  for (const secret of [...secrets].sort((a, b) => b.length - a.length)) {
    if (secret.length < 6) continue;
    out = out.split(secret).join(MASK);
  }
  for (const pattern of GENERIC_PATTERNS) {
    out = out.replace(pattern.regex, pattern.replace);
  }
  // Collapse the current user's home prefix; keeps artifacts shareable.
  const home = process.env["HOME"];
  if (home && home.length > 1) {
    out = out.split(home).join("~");
  }
  return out;
}

/** Redact a primitive/object tree for structured artifacts. */
export function redactDeep<T>(value: T, secrets: readonly string[] = []): T {
  if (typeof value === "string") return redactSecrets(value, secrets) as T;
  if (Array.isArray(value)) return value.map((v) => redactDeep(v, secrets)) as T;
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] = redactDeep(v, secrets);
    }
    return out as T;
  }
  return value;
}

/** Keep previews small enough for a main agent to read; never log whole files. */
export function preview(text: string, max = 240): string {
  const singleLine = text.replace(/\s+/g, " ").trim();
  return singleLine.length <= max ? singleLine : `${singleLine.slice(0, max)}…`;
}

/**
 * Guard used before an artifact is flushed: throws if the raw secret appears
 * anywhere in the serialized payload. This is a hard failure, not a warning.
 */
export function assertNoSecret(payload: string, secrets: readonly string[]): void {
  for (const secret of secrets) {
    if (secret.length >= 6 && payload.includes(secret)) {
      throw new Error("artifact leak guard: raw credential found in output payload");
    }
  }
}
