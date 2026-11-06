/**
 * Typed secret-storage errors.
 *
 * The IPC/renderer surface only ever sees these codes plus a fixed, generic
 * message. Raw DBus/Secret-Service text stays in the main-process log (and
 * even there it is truncated + redacted).
 */

export const SECRET_ERROR_CODES = [
  'KEYRING_UNAVAILABLE',
  'KEYRING_LOCKED',
  'KEYRING_TIMEOUT',
  'KEYRING_DENIED',
  'KEYRING_NOT_FOUND'
] as const

export type SecretErrorCode = (typeof SECRET_ERROR_CODES)[number]

/** User-facing messages; deliberately free of backend/DBus details. */
export const SECRET_ERROR_MESSAGES: Record<SecretErrorCode, string> = {
  KEYRING_UNAVAILABLE: '系统凭据服务不可用',
  KEYRING_LOCKED: '系统凭据服务已锁定',
  KEYRING_TIMEOUT: '系统凭据服务响应超时',
  KEYRING_DENIED: '系统凭据服务拒绝了访问',
  KEYRING_NOT_FOUND: '未找到凭据'
}

export class SecretError extends Error {
  readonly code: SecretErrorCode
  /** Concise internal reason for main-process logs only. Never sent to renderer. */
  readonly reason?: string

  constructor(code: SecretErrorCode, reason?: string) {
    super(SECRET_ERROR_MESSAGES[code])
    this.name = 'SecretError'
    this.code = code
    this.reason = reason
  }
}

export function isSecretError(value: unknown): value is SecretError {
  return value instanceof SecretError
}

/**
 * Map a raw keyring/worker error to a typed code.
 *
 * Only the lowercased message is inspected; nothing is returned to callers
 * except the code + a short reason that the caller may log (after redact).
 */
export function classifyKeyringError(error: unknown): SecretError {
  if (isSecretError(error)) return error

  const message = error instanceof Error ? error.message : String(error ?? '')
  const lower = message.toLowerCase()

  let code: SecretErrorCode = 'KEYRING_UNAVAILABLE'
  if (lower.includes('lock') || lower.includes('locked')) {
    code = 'KEYRING_LOCKED'
  } else if (
    lower.includes('denied') ||
    lower.includes('not authorized') ||
    lower.includes('permission') ||
    lower.includes('access denied')
  ) {
    code = 'KEYRING_DENIED'
  } else if (lower.includes('timed out') || lower.includes('timeout')) {
    code = 'KEYRING_TIMEOUT'
  } else if (lower.includes('no matching entry') || lower.includes('not found')) {
    code = 'KEYRING_NOT_FOUND'
  }

  const reason = message.replace(/\s+/g, ' ').trim().slice(0, 200)
  return new SecretError(code, reason || undefined)
}
