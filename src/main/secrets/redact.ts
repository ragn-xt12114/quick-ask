/**
 * Log/error redaction.
 *
 * Two layers:
 *  - fixed patterns for headers, bearer tokens, `sk-...` keys and URL query
 *    credentials;
 *  - an explicit registry of secret values (`registerSecretValue`) so custom
 *    provider header values are scrubbed even when they do not look secretish.
 *
 * `redact()` keeps normal prose intact. Callers that show an error to the UI
 * should cap the result (see `redactSummary`).
 */

const REDACTED = '[REDACTED]'

const registeredSecrets = new Set<string>()

/** Register a custom secret (api key, header value) for literal redaction. */
export function registerSecretValue(value: string | null | undefined): void {
  if (typeof value !== 'string') return
  const trimmed = value.trim()
  // Very short values would scrub ordinary text; secrets are always longer.
  if (trimmed.length < 4) return
  registeredSecrets.add(trimmed)
}

/** Test/diagnostics helper — does not expose the values. */
export function registeredSecretCount(): number {
  return registeredSecrets.size
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

const URL_CREDENTIAL_PATTERN =
  /([?&](?:key|api[_-]?key|access[_-]?token|token|secret|auth|authorization)=)([^&#\s"'<>]+)/gi

const AUTHORIZATION_PATTERN = /(\bAuthorization\s*[:=]\s*)([^\r\n,;]+)/gi

const BEARER_PATTERN = /\bBearer\s+[A-Za-z0-9._~+/=-]+/gi

const ASSIGNMENT_PATTERN =
  /\b(api[_-]?key|access[_-]?token|refresh[_-]?token|token|secret|password)\b(\s*[:=]\s*)([^\s&,;"'<>]+)/gi

const SK_KEY_PATTERN = /\bsk-[A-Za-z0-9_-]{8,}\b/g

export function redact(text: string): string {
  if (typeof text !== 'string' || text.length === 0) return text

  let result = text

  result = result.replace(AUTHORIZATION_PATTERN, `$1${REDACTED}`)
  result = result.replace(BEARER_PATTERN, `Bearer ${REDACTED}`)
  result = result.replace(URL_CREDENTIAL_PATTERN, `$1${REDACTED}`)
  result = result.replace(ASSIGNMENT_PATTERN, `$1$2${REDACTED}`)
  result = result.replace(SK_KEY_PATTERN, REDACTED)

  // Custom secrets last: longest first so a substring cannot survive.
  const values = Array.from(registeredSecrets).sort((a, b) => b.length - a.length)
  for (const value of values) {
    result = result.replace(new RegExp(escapeRegExp(value), 'g'), REDACTED)
  }

  return result
}

/** Redact then cap to `maxChars` (default 300) for UI error details. */
export function redactSummary(text: string, maxChars = 300): string {
  const redacted = redact(text)
  if (redacted.length <= maxChars) return redacted
  return `${redacted.slice(0, Math.max(0, maxChars - 3))}...`
}
