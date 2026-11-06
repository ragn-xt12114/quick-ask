/**
 * Secret-store status shared by the settings UI (later tasks) and logs.
 *
 * `backend` reflects the store actually used for the most recent successful
 * operation unless a session-only fallback is active.
 */

export type SecretBackend = 'keyring' | 'safeStorage' | 'session'

export interface SecretStatus {
  backend: SecretBackend
  keyringAvailable: boolean
  /** Electron safeStorage backend name (`kwallet6`, `basic_text`, ...). */
  safeStorageBackend: string | null
  encryptionAvailable: boolean
  /** Visible warning when secrets are session-only or the keyring failed. */
  warning?: string
}

export const SESSION_ONLY_WARNING =
  '系统凭据服务不可用，密钥仅保存在本次会话中，退出后需重新输入。'

export const SAFE_STORAGE_FALLBACK_WARNING =
  '系统钥匙串不可用，密钥将以 safeStorage 加密文件保存。'
