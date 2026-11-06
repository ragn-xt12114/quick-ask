import { afterAll, describe, expect, it } from 'vitest'
import { createHash, randomBytes } from 'node:crypto'
import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import {
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync
} from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { openDbService } from '../../src/main/db/service'
import { createLogger } from '../../src/main/logging/logger'
import { OutboundGuard } from '../../src/main/net/guard'
import { createProviderClient } from '../../src/main/provider/client'
import { ProviderService } from '../../src/main/providers/service'
import type { KeyringBackend } from '../../src/main/secrets/keyring-backend'
import { SecretStore, type SafeStorageLike } from '../../src/main/secrets/store'

const projectRoot = fileURLToPath(new URL('../..', import.meta.url))
const runtimeRoot = join(projectRoot, '.runtime', 'task17-grep-key')
const dataDir = join(runtimeRoot, 'data')
const logDir = join(runtimeRoot, 'logs')
const evidenceDir = join(projectRoot, '.omo', 'evidence')

class MemoryKeyring implements KeyringBackend {
  readonly values = new Map<string, string>()

  async set(service: string, account: string, value: string): Promise<void> {
    this.values.set(`${service}\u0000${account}`, value)
  }

  async get(service: string, account: string): Promise<string | null> {
    return this.values.get(`${service}\u0000${account}`) ?? null
  }

  async delete(service: string, account: string): Promise<boolean> {
    return this.values.delete(`${service}\u0000${account}`)
  }

  async ping(): Promise<boolean> {
    return true
  }
}

class FakeSafeStorage implements SafeStorageLike {
  isEncryptionAvailable(): boolean {
    return true
  }

  getSelectedStorageBackend(): string {
    return 'kwallet6'
  }

  encryptString(plainText: string): Buffer {
    return Buffer.from(Buffer.from(plainText).toString('base64'))
  }

  decryptString(encrypted: Buffer): string {
    return Buffer.from(encrypted.toString('utf8'), 'base64').toString('utf8')
  }
}

const server = createServer((request, response) => {
  seenAuthorization = request.headers.authorization ?? null
  seenCustomHeader = (request.headers['x-custom'] as string | undefined) ?? null
  request.resume()
  response.writeHead(200, {
    'content-type': 'text/event-stream',
    'cache-control': 'no-cache',
    connection: 'keep-alive'
  })
  response.write(
    `data: ${JSON.stringify({ choices: [{ delta: { content: 'RESPONSE_SHOULD_NOT_BE_LOGGED' } }] })}\n\n`
  )
  response.write(
    `data: ${JSON.stringify({ choices: [{ delta: { content: '-PART2' }, finish_reason: 'stop' }] })}\n\n`
  )
  response.write('data: [DONE]\n\n')
  response.end()
})

let seenAuthorization: string | null = null
let seenCustomHeader: string | null = null
let db: ReturnType<typeof openDbService> | null = null
let store: SecretStore | null = null

afterAll(async () => {
  db?.close()
  store?.close()
  await new Promise<void>((resolve) => server.close(() => resolve()))
})

describe('logging + privacy integration', () => {
  it('redacts secrets and never writes prompt/response content', async () => {
    rmSync(runtimeRoot, { recursive: true, force: true })
    mkdirSync(dataDir, { recursive: true, mode: 0o700 })
    mkdirSync(logDir, { recursive: true, mode: 0o700 })
    mkdirSync(evidenceDir, { recursive: true })

    await new Promise<void>((resolve) => {
      server.listen(0, '127.0.0.1', () => resolve())
    })
    const port = (server.address() as AddressInfo).port

    db = openDbService({ dataDir })
    store = new SecretStore({
      keyring: new MemoryKeyring(),
      safeStorage: new FakeSafeStorage(),
      dataDir
    })

    const apiKey = `sk-task17-${randomBytes(24).toString('hex')}`
    const headerValue = `custom-header-${randomBytes(24).toString('hex')}`
    const fingerprint = createHash('sha256').update(apiKey).digest('hex')
    const headerFingerprint = createHash('sha256').update(headerValue).digest('hex')

    const guard = new OutboundGuard()
    const providers = new ProviderService(db, store, {
      guard,
      onProfilesChanged: (urls) => guard.setProviderBaseUrls(urls)
    })
    const view = await providers.createProfile({
      name: 'Task17Redaction',
      baseUrl: `http://127.0.0.1:${port}`,
      model: 'test-model',
      apiKey,
      headers: [{ name: 'X-Custom', value: headerValue }],
      isDefault: true
    })
    expect(view.hasApiKey).toBe(true)

    const log = createLogger({ logDir, level: 'debug' })
    const client = createProviderClient({
      guard,
      logger: {
        info: (event, fields) => log.info(event, fields),
        warn: (event, fields) => log.warn(event, fields)
      }
    })

    const profile = await providers.resolveStreamProfile(view.id)
    const result = await client.streamChat({
      profile,
      requestId: 'req-task17-log-redaction',
      messages: [
        { role: 'system', content: 'SYSTEM_PROMPT_SHOULD_NOT_BE_LOGGED' },
        { role: 'user', content: 'PROMPT_SHOULD_NOT_BE_LOGGED' }
      ]
    })

    expect(result.status).toBe('complete')
    expect(result.content).toBe('RESPONSE_SHOULD_NOT_BE_LOGGED-PART2')
    expect(result.deltaCount).toBe(2)
    expect(seenAuthorization).toBe(`Bearer ${apiKey}`)
    expect(seenCustomHeader).toBe(headerValue)

    const logText = readFileSync(join(logDir, 'quickask.log'), 'utf8')
    expect(logText).toContain('provider_request_start')
    expect(logText).toContain('provider_request_end')
    expect(logText).toContain('"status":"complete"')
    expect(logText).toContain('"deltaCount":2')
    expect(logText).not.toContain(apiKey)
    expect(logText).not.toContain(headerValue)
    expect(logText).not.toContain('Bearer')
    expect(logText).not.toContain('PROMPT_SHOULD_NOT_BE_LOGGED')
    expect(logText).not.toContain('SYSTEM_PROMPT_SHOULD_NOT_BE_LOGGED')
    expect(logText).not.toContain('RESPONSE_SHOULD_NOT_BE_LOGGED')
    expect(logText).not.toContain('Authorization')

    // Keep a reproducible redacted sample and a fingerprint registry for
    // tools/grep-key.sh. Only hashes are stored outside the fixture dirs.
    writeFileSync(
      join(evidenceDir, 'task-17-redacted.log'),
      [
        '# Task 17 redacted logger sample (from a real local SSE request)',
        `generated_at: ${new Date().toISOString()}`,
        `api_key_fingerprint: sha256:${fingerprint}`,
        `header_fingerprint: sha256:${headerFingerprint}`,
        `provider_profile_id: ${view.id}`,
        `result_status: ${result.status}`,
        `delta_count: ${result.deltaCount}`,
        '',
        '--- quickask.log (redacted JSONL) ---',
        logText,
        ''
      ].join('\n')
    )
    writeFileSync(
      join(evidenceDir, 'task-17-secret-fingerprints.txt'),
      [`sha256:${fingerprint}`, `sha256:${headerFingerprint}`, ''].join('\n')
    )

    // The DB/config/log fixture is left in .runtime for tools/grep-key.sh.
    expect(existsSync(join(dataDir, 'quickask.db'))).toBe(true)
    expect(existsSync(join(logDir, 'quickask.log'))).toBe(true)
  })
})
