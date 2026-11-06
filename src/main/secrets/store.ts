/**
 * SecretStore — the single main-process entry point for credentials.
 *
 * Order of preference:
 *   1. OS keyring (`@napi-rs/keyring` through a worker thread);
 *   2. Electron safeStorage, only when encryption is available AND the
 *      selected backend is not `basic_text` (an encrypted JSON blob at
 *      `${dataDir}/secrets.enc`, mode 0600, atomic tmp+rename);
 *   3. in-memory for this session only, with a visible SESSION_ONLY warning.
 *
 * Plaintext files are never written.
 */

import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { isSecretError, SecretError } from './errors'
import type { KeyringBackend } from './keyring-backend'
import { redact, registerSecretValue } from './redact'
import {
  SAFE_STORAGE_FALLBACK_WARNING,
  SESSION_ONLY_WARNING,
  type SecretBackend,
  type SecretStatus
} from './status'

export interface SafeStorageLike {
  isEncryptionAvailable(): boolean
  getSelectedStorageBackend(): string
  encryptString(plainText: string): Buffer
  decryptString(encrypted: Buffer): string
}

export interface SecretStoreOptions {
  keyring: KeyringBackend
  safeStorage?: SafeStorageLike | null
  dataDir: string
  /** Override for tests; defaults to `<dataDir>/secrets.enc`. */
  filePath?: string
  logger?: (message: string) => void
}

type FallbackMode = 'none' | 'safeStorage' | 'session'

function storageKey(service: string, account: string): string {
  return `${service}\u0000${account}`
}

export class SecretStore {
  private readonly keyring: KeyringBackend
  private readonly safeStorage: SafeStorageLike | null
  private readonly filePath: string
  private readonly logger: (message: string) => void
  private readonly memory = new Map<string, string>()
  private fallbackMode: FallbackMode = 'none'
  private keyringAvailable = false
  private fileLoaded = false

  constructor(options: SecretStoreOptions) {
    this.keyring = options.keyring
    this.safeStorage = options.safeStorage ?? null
    this.filePath = options.filePath ?? join(options.dataDir, 'secrets.enc')
    this.logger = options.logger ?? (() => undefined)
  }

  private canUseSafeStorage(): boolean {
    const safe = this.safeStorage
    if (!safe) return false
    try {
      if (!safe.isEncryptionAvailable()) return false
      return safe.getSelectedStorageBackend() !== 'basic_text'
    } catch {
      return false
    }
  }

  private safeStorageBackend(): string | null {
    if (!this.safeStorage) return null
    try {
      return this.safeStorage.getSelectedStorageBackend()
    } catch {
      return null
    }
  }

  private encryptionAvailable(): boolean {
    if (!this.safeStorage) return false
    try {
      return this.safeStorage.isEncryptionAvailable()
    } catch {
      return false
    }
  }

  /** Current status for the settings UI / diagnostics. */
  status(): SecretStatus {
    let backend: SecretBackend = 'keyring'
    if (this.keyringAvailable) {
      backend = 'keyring'
    } else if (this.fallbackMode === 'safeStorage') {
      backend = 'safeStorage'
    } else if (this.fallbackMode === 'session') {
      backend = 'session'
    }

    let warning: string | undefined
    if (backend === 'session') warning = SESSION_ONLY_WARNING
    else if (backend === 'safeStorage') warning = SAFE_STORAGE_FALLBACK_WARNING

    return {
      backend,
      keyringAvailable: this.keyringAvailable,
      safeStorageBackend: this.safeStorageBackend(),
      encryptionAvailable: this.encryptionAvailable(),
      ...(warning ? { warning } : {})
    }
  }

  private noteKeyringError(error: unknown): void {
    const typed = isSecretError(error)
      ? error
      : new SecretError('KEYRING_UNAVAILABLE', String((error as Error)?.message ?? error))
    this.keyringAvailable = false
    this.logger(
      `[secrets] keyring ${typed.code}: ${redact(typed.reason ?? typed.message).slice(0, 200)}`
    )
  }

  // -------------------------------------------------------------------------
  // Encrypted safeStorage fallback
  // -------------------------------------------------------------------------

  private loadSecureFile(): void {
    if (this.fileLoaded) return
    this.fileLoaded = true

    if (!this.canUseSafeStorage() || !existsSync(this.filePath)) return
    try {
      const encrypted = readFileSync(this.filePath)
      const json = this.safeStorage!.decryptString(encrypted)
      const parsed: unknown = JSON.parse(json)
      if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return
      for (const [key, value] of Object.entries(parsed)) {
        if (typeof value === 'string') this.memory.set(key, value)
      }
      this.fallbackMode = 'safeStorage'
    } catch (error) {
      this.logger(
        `[secrets] could not read encrypted fallback: ${redact(
          error instanceof Error ? error.message : 'unknown error'
        ).slice(0, 120)}`
      )
    }
  }

  private persistSecureFile(): void {
    if (!this.canUseSafeStorage()) {
      this.fallbackMode = 'session'
      return
    }

    try {
      mkdirSync(dirname(this.filePath), { recursive: true, mode: 0o700 })
    } catch {
      // Directory normally exists; ignore and let writeFileSync decide.
    }

    const json = JSON.stringify(Object.fromEntries(this.memory))
    const encrypted = this.safeStorage!.encryptString(json)
    const tmp = `${this.filePath}.${process.pid}.${Date.now()}.tmp`

    if (this.memory.size === 0) {
      try {
        if (existsSync(this.filePath)) unlinkSync(this.filePath)
      } catch {
        // best effort
      }
      this.fallbackMode = 'safeStorage'
      return
    }

    try {
      writeFileSync(tmp, encrypted, { mode: 0o600 })
      chmodSync(tmp, 0o600)
      renameSync(tmp, this.filePath)
      try {
        chmodSync(this.filePath, 0o600)
      } catch {
        // best effort
      }
      this.fallbackMode = 'safeStorage'
    } catch (error) {
      this.logger(
        `[secrets] encrypted fallback write failed: ${redact(
          error instanceof Error ? error.message : 'unknown error'
        ).slice(0, 120)}`
      )
      this.fallbackMode = 'session'
      try {
        if (existsSync(tmp)) unlinkSync(tmp)
      } catch {
        // ignore
      }
    }
  }

  private fallbackSet(service: string, account: string, value: string): void {
    this.loadSecureFile()
    const key = storageKey(service, account)
    this.memory.set(key, value)

    if (this.canUseSafeStorage()) {
      this.persistSecureFile()
      return
    }

    this.fallbackMode = 'session'
  }

  private fallbackGet(service: string, account: string): string | null {
    this.loadSecureFile()
    const value = this.memory.get(storageKey(service, account))
    if (value !== undefined) {
      if (this.fallbackMode === 'none') this.fallbackMode = 'session'
      return value
    }
    return null
  }

  private fallbackDelete(service: string, account: string): boolean {
    this.loadSecureFile()
    const key = storageKey(service, account)
    const existed = this.memory.delete(key)
    if (existed) {
      if (this.canUseSafeStorage()) this.persistSecureFile()
      else this.fallbackMode = 'session'
    }
    return existed
  }

  // -------------------------------------------------------------------------
  // Public API
  // -------------------------------------------------------------------------

  async set(service: string, account: string, value: string): Promise<void> {
    if (typeof service !== 'string' || service.length === 0) {
      throw new Error('service is required')
    }
    if (typeof account !== 'string' || account.length === 0) {
      throw new Error('account is required')
    }
    if (typeof value !== 'string') throw new Error('value must be a string')

    registerSecretValue(value)
    try {
      await this.keyring.set(service, account, value)
      this.keyringAvailable = true
      return
    } catch (error) {
      this.noteKeyringError(error)
    }

    this.fallbackSet(service, account, value)
  }

  async get(service: string, account: string): Promise<string | null> {
    try {
      const value = await this.keyring.get(service, account)
      this.keyringAvailable = true
      if (value !== null) {
        registerSecretValue(value)
        return value
      }
    } catch (error) {
      this.noteKeyringError(error)
    }

    return this.fallbackGet(service, account)
  }

  async delete(service: string, account: string): Promise<boolean> {
    let keyringDeleted = false
    try {
      keyringDeleted = await this.keyring.delete(service, account)
      this.keyringAvailable = true
    } catch (error) {
      this.noteKeyringError(error)
    }

    const fallbackDeleted = this.fallbackDelete(service, account)
    return keyringDeleted || fallbackDeleted
  }

  /** Probe the keyring; typed failure is swallowed into `false`. */
  async isAvailable(): Promise<boolean> {
    try {
      const ok = await this.keyring.ping()
      this.keyringAvailable = ok
      return ok
    } catch (error) {
      this.noteKeyringError(error)
      return false
    }
  }

  /** Probe that preserves the typed error for diagnostics/tests. */
  async probe(): Promise<SecretStatus> {
    await this.isAvailable()
    return this.status()
  }

  close(): void {
    this.keyring.close?.()
  }
}
