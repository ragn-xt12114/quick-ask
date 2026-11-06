import { afterEach, describe, expect, it } from 'vitest'
import { mkdtempSync, readFileSync, rmSync, statSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { classifyKeyringError, SecretError } from '../../src/main/secrets/errors'
import type { KeyringBackend } from '../../src/main/secrets/keyring-backend'
import { WorkerKeyringBackend } from '../../src/main/secrets/keyring-backend-worker'
import { SecretStore, type SafeStorageLike } from '../../src/main/secrets/store'
import { SESSION_ONLY_WARNING } from '../../src/main/secrets/status'

const tempDirs: string[] = []

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'quickask-secrets-'))
  tempDirs.push(dir)
  return dir
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

class FakeKeyring implements KeyringBackend {
  readonly values = new Map<string, string>()
  failure: Error | null = null
  calls: string[] = []

  private key(service: string, account: string): string {
    return `${service}\u0000${account}`
  }

  async set(service: string, account: string, value: string): Promise<void> {
    this.calls.push('set')
    if (this.failure) throw this.failure
    this.values.set(this.key(service, account), value)
  }

  async get(service: string, account: string): Promise<string | null> {
    this.calls.push('get')
    if (this.failure) throw this.failure
    return this.values.get(this.key(service, account)) ?? null
  }

  async delete(service: string, account: string): Promise<boolean> {
    this.calls.push('delete')
    if (this.failure) throw this.failure
    return this.values.delete(this.key(service, account))
  }

  async ping(): Promise<boolean> {
    this.calls.push('ping')
    if (this.failure) throw this.failure
    return true
  }
}

function xorBuffer(input: string): Buffer {
  return Buffer.from(Array.from(Buffer.from(input, 'utf8')).map((byte) => byte ^ 0x5a))
}

function xorString(input: Buffer): string {
  return Buffer.from(Array.from(input).map((byte) => byte ^ 0x5a)).toString('utf8')
}

class FakeSafeStorage implements SafeStorageLike {
  constructor(
    public backend = 'kwallet6',
    public available = true
  ) {}

  isEncryptionAvailable(): boolean {
    return this.available
  }

  getSelectedStorageBackend(): string {
    return this.backend
  }

  encryptString(plainText: string): Buffer {
    return xorBuffer(plainText)
  }

  decryptString(encrypted: Buffer): string {
    return xorString(encrypted)
  }
}

describe('SecretStore', () => {
  it('uses the keyring for set/get/delete when available', async () => {
    const keyring = new FakeKeyring()
    const store = new SecretStore({ keyring, safeStorage: new FakeSafeStorage(), dataDir: tempDir() })

    await store.set('quickask', 'provider:p1:api_key', 'sk-primary-secret-value')
    expect(await store.get('quickask', 'provider:p1:api_key')).toBe('sk-primary-secret-value')
    expect(store.status().backend).toBe('keyring')
    expect(store.status().keyringAvailable).toBe(true)

    expect(await store.delete('quickask', 'provider:p1:api_key')).toBe(true)
    expect(await store.get('quickask', 'provider:p1:api_key')).toBeNull()
    expect(keyring.values.size).toBe(0)
  })

  it('falls back to an encrypted safeStorage file when the keyring is unavailable', async () => {
    const dir = tempDir()
    const keyring = new FakeKeyring()
    keyring.failure = new Error('Platform failure: DBus unavailable')
    const safeStorage = new FakeSafeStorage()
    const store = new SecretStore({ keyring, safeStorage, dataDir: dir })

    const secret = 'sk-fallback-secret-123456'
    await store.set('quickask', 'provider:p1:api_key', secret)

    const filePath = join(dir, 'secrets.enc')
    expect(existsSync(filePath)).toBe(true)
    expect(statSync(filePath).mode & 0o777).toBe(0o600)
    expect(readFileSync(filePath).includes(Buffer.from(secret))).toBe(false)

    const status = store.status()
    expect(status.backend).toBe('safeStorage')
    expect(status.keyringAvailable).toBe(false)
    expect(status.safeStorageBackend).toBe('kwallet6')

    const nextStore = new SecretStore({
      keyring: Object.assign(new FakeKeyring(), {
        failure: new Error('Platform failure: DBus unavailable')
      }),
      safeStorage,
      dataDir: dir
    })
    expect(await nextStore.get('quickask', 'provider:p1:api_key')).toBe(secret)
  })

  it('keeps secrets in memory only when safeStorage backend is basic_text', async () => {
    const dir = tempDir()
    const keyring = new FakeKeyring()
    keyring.failure = new Error('Secret Service unavailable')
    const store = new SecretStore({
      keyring,
      safeStorage: new FakeSafeStorage('basic_text', true),
      dataDir: dir
    })

    await store.set('quickask', 'provider:p1:api_key', 'sk-session-only-value')
    expect(await store.get('quickask', 'provider:p1:api_key')).toBe('sk-session-only-value')
    expect(existsSync(join(dir, 'secrets.enc'))).toBe(false)

    const status = store.status()
    expect(status.backend).toBe('session')
    expect(status.warning).toBe(SESSION_ONLY_WARNING)
    expect(status.safeStorageBackend).toBe('basic_text')

    const nextStore = new SecretStore({
      keyring,
      safeStorage: new FakeSafeStorage('basic_text', true),
      dataDir: dir
    })
    expect(await nextStore.get('quickask', 'provider:p1:api_key')).toBeNull()
  })

  it('keeps secrets in memory only when encryption is unavailable', async () => {
    const dir = tempDir()
    const keyring = new FakeKeyring()
    keyring.failure = new Error('Secret Service unavailable')
    const store = new SecretStore({
      keyring,
      safeStorage: new FakeSafeStorage('kwallet6', false),
      dataDir: dir
    })

    await store.set('quickask', 'provider:p1:api_key', 'sk-no-encryption')
    expect(await store.get('quickask', 'provider:p1:api_key')).toBe('sk-no-encryption')
    expect(existsSync(join(dir, 'secrets.enc'))).toBe(false)
    expect(store.status().backend).toBe('session')
  })

  it('maps locked and timeout errors and surfaces them from probe', async () => {
    expect(classifyKeyringError(new Error('Secret Service is locked')).code).toBe('KEYRING_LOCKED')
    expect(classifyKeyringError(new Error('operation timed out')).code).toBe('KEYRING_TIMEOUT')
    expect(classifyKeyringError(new Error('access denied')).code).toBe('KEYRING_DENIED')

    const keyring = new FakeKeyring()
    keyring.failure = new Error('Secret Service is locked')
    const store = new SecretStore({
      keyring,
      safeStorage: new FakeSafeStorage(),
      dataDir: tempDir()
    })

    const status = await store.probe()
    expect(status.keyringAvailable).toBe(false)
    expect(status.backend).toBe('keyring')
    await expect(keyring.ping()).rejects.toThrow('locked')
  })

  it('rejects a hung worker with KEYRING_TIMEOUT and can recreate it afterwards', async () => {
    const workerPath = fileURLToPath(
      new URL('../fixtures/keyring-hang-worker.cjs', import.meta.url)
    )
    const backend = new WorkerKeyringBackend({ timeoutMs: 80, workerPath: () => workerPath })
    try {
      await expect(backend.ping()).rejects.toMatchObject({ code: 'KEYRING_TIMEOUT' })
      await expect(backend.ping()).rejects.toMatchObject({ code: 'KEYRING_TIMEOUT' })
    } finally {
      backend.close()
    }
  })

  it('cleans up a keyring entry on delete and reports not found as false', async () => {
    const keyring = new FakeKeyring()
    const store = new SecretStore({ keyring, safeStorage: new FakeSafeStorage(), dataDir: tempDir() })
    await store.set('quickask', 'provider:p1:headers', '{"X-Test":"v"}')
    expect(await store.delete('quickask', 'provider:p1:headers')).toBe(true)
    expect(await store.delete('quickask', 'provider:p1:headers')).toBe(false)
  })

  it('rejects an empty service/account/value shape', async () => {
    const store = new SecretStore({
      keyring: new FakeKeyring(),
      safeStorage: new FakeSafeStorage(),
      dataDir: tempDir()
    })
    await expect(store.set('', 'account', 'v')).rejects.toThrow('service is required')
    await expect(store.set('quickask', '', 'v')).rejects.toThrow('account is required')
  })

  it('exposes typed errors without DBus details in the renderer message', () => {
    const error = new SecretError('KEYRING_UNAVAILABLE', 'DBus error: Failed to connect to socket')
    expect(error.message).toBe('系统凭据服务不可用')
    expect(error.message).not.toContain('DBus')
  })
})
