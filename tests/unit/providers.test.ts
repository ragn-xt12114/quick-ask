import { afterEach, describe, expect, it } from 'vitest'
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import net, { type AddressInfo } from 'node:net'
import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { openDbService, type DbService } from '../../src/main/db/service'
import type { KeyringBackend } from '../../src/main/secrets/keyring-backend'
import { SecretStore, type SafeStorageLike } from '../../src/main/secrets/store'
import { ProviderService } from '../../src/main/providers/service'
import { SettingsService } from '../../src/main/settings/service'
import { chatCompletionsUrl, modelsUrl, normalizeProviderBase } from '../../src/main/provider/url'

const tempDirs: string[] = []
const openDbs: DbService[] = []
const servers: Array<{ close(): Promise<void> }> = []

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'quickask-provider-'))
  tempDirs.push(dir)
  return dir
}

afterEach(async () => {
  for (const server of servers.splice(0)) await server.close()
  for (const db of openDbs.splice(0)) {
    try {
      db.close()
    } catch {
      // ignore
    }
  }
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

class FakeKeyring implements KeyringBackend {
  readonly values = new Map<string, string>()

  private key(service: string, account: string): string {
    return `${service}\u0000${account}`
  }

  async set(service: string, account: string, value: string): Promise<void> {
    this.values.set(this.key(service, account), value)
  }

  async get(service: string, account: string): Promise<string | null> {
    return this.values.get(this.key(service, account)) ?? null
  }

  async delete(service: string, account: string): Promise<boolean> {
    return this.values.delete(this.key(service, account))
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

function setup(): {
  db: DbService
  keyring: FakeKeyring
  store: SecretStore
  service: ProviderService
  dir: string
} {
  const dir = tempDir()
  const db = openDbService({ dataDir: dir })
  openDbs.push(db)
  const keyring = new FakeKeyring()
  const store = new SecretStore({ keyring, safeStorage: new FakeSafeStorage(), dataDir: dir })
  const service = new ProviderService(db, store, {
    now: () => 1_700_000_000_000,
    env: {}
  })
  return { db, keyring, store, service, dir }
}

interface StartedServer {
  url: string
  requests: Array<{ method: string; url: string; headers: IncomingMessage['headers']; body: string }>
  close(): Promise<void>
}

async function startServer(
  handler: (req: IncomingMessage, res: ServerResponse, body: string) => void
): Promise<StartedServer> {
  const requests: StartedServer['requests'] = []
  const server = createServer((req, res) => {
    const chunks: Buffer[] = []
    req.on('data', (chunk: Buffer) => chunks.push(chunk))
    req.on('end', () => {
      const body = Buffer.concat(chunks).toString('utf8')
      requests.push({ method: req.method ?? '', url: req.url ?? '', headers: req.headers, body })
      res.on('error', () => undefined)
      handler(req, res, body)
    })
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const port = (server.address() as AddressInfo).port
  const wrapper = {
    url: `http://127.0.0.1:${port}`,
    requests,
    async close() {
      server.closeAllConnections()
      await new Promise<void>((resolve) => server.close(() => resolve()))
    }
  }
  servers.push(wrapper)
  return wrapper
}

interface AuthProxy {
  url: string
  authorizations: Array<string | null>
  close(): Promise<void>
}

async function startAuthProxy(
  expectedAuthorization: string
): Promise<AuthProxy> {
  const authorizations: Array<string | null> = []
  const server = createServer((_req, res) => {
    res.writeHead(405)
    res.end()
  })
  server.on('connect', (req, clientSocket: net.Socket, head: Buffer) => {
    const header = req.headers['proxy-authorization'] ?? null
    authorizations.push(header)
    if (header !== expectedAuthorization) {
      clientSocket.end('HTTP/1.1 407 Proxy Authentication Required\r\n\r\n')
      return
    }
    const target = req.url ?? ''
    const sep = target.lastIndexOf(':')
    const host = target.slice(0, sep)
    const port = Number(target.slice(sep + 1))
    const upstream = net.connect(port, host, () => {
      clientSocket.write('HTTP/1.1 200 Connection Established\r\n\r\n')
      if (head.length > 0) upstream.write(head)
      clientSocket.pipe(upstream)
      upstream.pipe(clientSocket)
    })
    upstream.on('error', () => clientSocket.destroy())
    clientSocket.on('error', () => upstream.destroy())
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const port = (server.address() as AddressInfo).port
  const wrapper: AuthProxy = {
    url: `http://127.0.0.1:${port}`,
    authorizations,
    async close() {
      server.closeAllConnections()
      await new Promise<void>((resolve) => server.close(() => resolve()))
    }
  }
  servers.push(wrapper)
  return wrapper
}

describe('provider URL normalization', () => {
  it('normalizes base URLs per D.2', () => {
    expect(normalizeProviderBase('https://api.deepseek.com/')).toBe('https://api.deepseek.com')
    expect(chatCompletionsUrl('https://api.deepseek.com')).toBe(
      'https://api.deepseek.com/v1/chat/completions'
    )
    expect(chatCompletionsUrl('https://api.openai.com/v1/')).toBe(
      'https://api.openai.com/v1/chat/completions'
    )
    expect(chatCompletionsUrl('https://x.test/v1/chat/completions')).toBe(
      'https://x.test/v1/chat/completions'
    )
    expect(modelsUrl('https://x.test/v1')).toBe('https://x.test/v1/models')
    expect(modelsUrl('https://x.test')).toBe('https://x.test/v1/models')
    expect(modelsUrl('http://localhost:11434')).toBe('http://localhost:11434/v1/models')
  })

  it('rejects non-http protocols', () => {
    expect(() => normalizeProviderBase('file:///etc/passwd')).toThrow()
    expect(() => normalizeProviderBase('javascript:alert(1)')).toThrow()
    expect(() => normalizeProviderBase('data:text/plain,hi')).toThrow()
  })
})

describe('provider profile CRUD', () => {
  it('stores only refs/names in SQLite and keeps values in the secret store', async () => {
    const { db, keyring, service, dir } = setup()

    const view = await service.createProfile({
      name: 'DeepSeek',
      baseUrl: 'https://api.deepseek.com/',
      model: 'deepseek-chat',
      apiKey: 'sk-db-must-not-contain-this',
      headers: [
        { name: 'X-Custom', value: 'custom-secret-value' },
        { name: 'authorization', value: 'Bearer custom-token-value' },
        { name: 'X-Custom', value: 'custom-secret-value-2' }
      ],
      isDefault: true
    })

    expect(view.hasApiKey).toBe(true)
    expect(view).not.toHaveProperty('keyRef')
    expect(JSON.stringify(view)).not.toContain('sk-db-must-not-contain-this')
    expect(JSON.stringify(view)).not.toContain('custom-secret-value')
    expect(view.headers.find((header) => header.name === 'X-Custom')?.hasValue).toBe(true)
    expect(view.headers.find((header) => header.name === 'X-Custom')?.secret).toBe(false)
    expect(view.headers.find((header) => header.name === 'authorization')?.secret).toBe(true)

    const stored = db.providers.get(view.id)
    expect(stored?.keyRef).toBe(`provider:${view.id}:api_key`)
    expect(stored?.headerNames).toEqual([
      { name: 'authorization', secret: true },
      { name: 'X-Custom', secret: false }
    ])
    expect(JSON.stringify(stored)).not.toContain('sk-db-must-not-contain-this')
    expect(JSON.stringify(stored)).not.toContain('custom-secret-value')

    const resolved = await service.resolveProfile(view.id)
    expect(resolved.apiKey).toBe('sk-db-must-not-contain-this')
    expect(resolved.headers['X-Custom']).toBe('custom-secret-value-2')
    expect(resolved.headers.authorization).toBe('Bearer custom-token-value')

    const headerJson = keyring.values.get('quickask\u0000provider:' + view.id + ':headers')
    expect(headerJson).toContain('custom-secret-value-2')

    db.close()
    for (const file of readdirSync(dir)) {
      expect(readFileSync(join(dir, file)).includes(Buffer.from('sk-db-must-not-contain-this'))).toBe(
        false
      )
    }
  })

  it('updates while preserving omitted key/header values and clears an explicit null key', async () => {
    const { service } = setup()
    const created = await service.createProfile({
      name: 'P1',
      baseUrl: 'http://127.0.0.1:9999',
      model: 'm1',
      apiKey: 'sk-keep-me-please',
      headers: [{ name: 'X-Custom', value: 'v1' }]
    })

    const renamed = await service.updateProfile(created.id, { id: created.id, name: 'Renamed' })
    expect(renamed.name).toBe('Renamed')
    expect((await service.resolveProfile(created.id)).apiKey).toBe('sk-keep-me-please')

    const keptHeader = await service.updateProfile(created.id, {
      id: created.id,
      headers: [{ name: 'x-custom' }]
    })
    expect(keptHeader.headers[0]).toMatchObject({ name: 'x-custom', hasValue: true })
    expect((await service.resolveProfile(created.id)).headers['x-custom']).toBe('v1')

    const cleared = await service.updateProfile(created.id, { id: created.id, apiKey: null })
    expect(cleared.hasApiKey).toBe(false)
    expect((await service.resolveProfile(created.id)).apiKey).toBeNull()
  })

  it('deletes secret entries and the DB row', async () => {
    const { db, keyring, service } = setup()
    const created = await service.createProfile({
      name: 'P1',
      baseUrl: 'https://example.test',
      model: 'm1',
      apiKey: 'sk-delete-me',
      headers: [{ name: 'X-Custom', value: 'v' }]
    })

    const result = await service.deleteProfile(created.id)
    expect(result).toEqual({ deleted: true, keyringCleanup: true })
    expect(db.providers.get(created.id)).toBeNull()
    expect(keyring.values.size).toBe(0)
  })

  it('enforces a single default profile', async () => {
    const { service } = setup()
    const first = await service.createProfile({
      name: 'One',
      baseUrl: 'https://one.test',
      model: 'm',
      isDefault: true
    })
    const second = await service.createProfile({
      name: 'Two',
      baseUrl: 'https://two.test',
      model: 'm',
      isDefault: true
    })

    const profiles = await service.listProfiles()
    expect(profiles.filter((profile) => profile.isDefault).map((profile) => profile.id)).toEqual([
      second.id
    ])
    expect(profiles.find((profile) => profile.id === first.id)?.isDefault).toBe(false)
  })

  it('validates base URLs and dangerous header names', async () => {
    const { service } = setup()
    await expect(
      service.createProfile({ name: 'F', baseUrl: 'file:///etc/passwd', model: 'm' })
    ).rejects.toMatchObject({ code: 'INVALID_ARGUMENT' })
    await expect(
      service.createProfile({ name: 'J', baseUrl: 'javascript:alert(1)', model: 'm' })
    ).rejects.toMatchObject({ code: 'INVALID_ARGUMENT' })

    for (const name of ['Host', 'Content-Length', 'Transfer-Encoding', 'Connection', 'Upgrade', 'Proxy-Authorization']) {
      await expect(
        service.createProfile({
          name: 'H',
          baseUrl: 'https://example.test',
          model: 'm',
          headers: [{ name, value: 'x' }]
        })
      ).rejects.toMatchObject({ code: 'INVALID_ARGUMENT' })
    }

    await expect(
      service.createProfile({
        name: 'H',
        baseUrl: 'https://example.test',
        model: 'm',
        headers: [{ name: 'Bad\r\nName', value: 'x' }]
      })
    ).rejects.toMatchObject({ code: 'INVALID_ARGUMENT' })
    await expect(
      service.createProfile({
        name: 'H',
        baseUrl: 'https://example.test',
        model: 'm',
        headers: [{ name: '', value: 'x' }]
      })
    ).rejects.toMatchObject({ code: 'INVALID_ARGUMENT' })
  })

  it('marks secret-looking header names as secret by default', async () => {
    const { service } = setup()
    const view = await service.createProfile({
      name: 'P',
      baseUrl: 'https://example.test',
      model: 'm',
      headers: [
        { name: 'X-Api-Key', value: 'v1' },
        { name: 'Cookie', value: 'v2' },
        { name: 'X-Trace', value: 'v3' }
      ]
    })
    expect(view.headers).toEqual([
      { name: 'X-Api-Key', secret: true, hasValue: true },
      { name: 'Cookie', secret: true, hasValue: true },
      { name: 'X-Trace', secret: false, hasValue: true }
    ])
  })
})

describe('provider proxy profile (Task 33a)', () => {
  it('normalizes legacy modes and stores proxy auth only in the keyring', async () => {
    const { db, keyring, service } = setup()
    const created = await service.createProfile({
      name: 'Proxy',
      baseUrl: 'https://example.test',
      model: 'm',
      proxyMode: 'env',
      proxyUrl: 'http://127.0.0.1:7890',
      proxyAuth: { username: 'proxy-user', password: 'proxy-secret-value' }
    })

    expect(created.proxyMode).toBe('system')
    expect(created.hasProxyAuth).toBe(true)
    expect(created.proxyUsernameMasked).toBe('p***r')
    expect(JSON.stringify(created)).not.toContain('proxy-secret-value')
    expect(JSON.stringify(created)).not.toContain('proxy-user')

    const stored = db.providers.get(created.id)
    expect(stored?.proxyMode).toBe('system')
    expect(stored?.proxyUrl).toBe('http://127.0.0.1:7890/')

    const proxyRaw = keyring.values.get('quickask\u0000provider:' + created.id + ':proxy')
    expect(proxyRaw).toBeTruthy()
    expect(JSON.parse(proxyRaw ?? '{}')).toEqual({
      username: 'proxy-user',
      password: 'proxy-secret-value'
    })

    const streamProfile = await service.resolveStreamProfile(created.id)
    expect(streamProfile.proxyMode).toBe('system')
    expect(streamProfile.proxyUrl).toContain('proxy-user')
    expect(streamProfile.proxyUrl).toContain(
      encodeURIComponent('proxy-secret-value')
    )

    const off = await service.updateProfile(created.id, {
      id: created.id,
      proxyMode: 'off'
    })
    expect(off.proxyMode).toBe('direct')

    const kept = await service.updateProfile(created.id, {
      id: created.id,
      proxyAuth: { username: 'proxy-user' }
    })
    expect(kept.hasProxyAuth).toBe(true)
    expect(
      JSON.parse(
        keyring.values.get('quickask\u0000provider:' + created.id + ':proxy') ?? '{}'
      )
    ).toMatchObject({ password: 'proxy-secret-value' })

    const cleared = await service.updateProfile(created.id, {
      id: created.id,
      proxyAuth: null
    })
    expect(cleared.hasProxyAuth).toBe(false)
    expect(keyring.values.has('quickask\u0000provider:' + created.id + ':proxy')).toBe(false)

    const again = await service.updateProfile(created.id, {
      id: created.id,
      proxyAuth: { username: 'second-user', password: 'second-secret' }
    })
    expect(again.hasProxyAuth).toBe(true)
    expect((await service.deleteProfile(created.id)).deleted).toBe(true)
    expect(keyring.values.size).toBe(0)
  })

  it('rejects credentials and unsupported schemes in the stored proxy URL', async () => {
    const { service } = setup()
    for (const proxyUrl of [
      'http://user:pass@127.0.0.1:7890',
      'ftp://127.0.0.1:7890',
      'http://127.0.0.1:7890/?token=x'
    ]) {
      await expect(
        service.createProfile({
          name: 'BadProxy',
          baseUrl: 'https://example.test',
          model: 'm',
          proxyMode: 'custom',
          proxyUrl
        })
      ).rejects.toMatchObject({ code: 'INVALID_ARGUMENT' })
    }
  })

  it('testConnection uses the same custom proxy and keyring credentials', async () => {
    const { service, dir, db } = setup()
    const target = await startServer((_req, res) => {
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end('{"data":[{"id":"via-proxy"}]}')
    })
    const authorization = `Basic ${Buffer.from('proxy-user:proxy-secret-value').toString(
      'base64'
    )}`
    const proxy = await startAuthProxy(authorization)
    try {
      const created = await service.createProfile({
        name: 'Proxied',
        baseUrl: target.url,
        model: 'm',
        proxyMode: 'custom',
        proxyUrl: proxy.url,
        proxyAuth: { username: 'proxy-user', password: 'proxy-secret-value' }
      })

      const result = await service.testConnection(created.id)
      expect(result.ok).toBe(true)
      expect(result.models).toEqual(['via-proxy'])
      expect(proxy.authorizations).toEqual([authorization])

      const view = await service.getProfile(created.id)
      expect(JSON.stringify(view)).not.toContain('proxy-secret-value')
      expect(view.hasProxyAuth).toBe(true)

      const row = db.providers.get(created.id)
      expect(JSON.stringify(row)).not.toContain('proxy-secret-value')
      expect(row?.proxyUrl).toBe(`${proxy.url}/`)
      for (const file of readdirSync(dir)) {
        const content = readFileSync(join(dir, file))
        expect(content.includes(Buffer.from('proxy-secret-value'))).toBe(false)
      }
    } finally {
      await proxy.close()
    }
  })

  it('reports invalid and unreachable custom proxies as typed errors', async () => {
    const { service } = setup()
    const target = await startServer((_req, res) => {
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end('{"data":[]}')
    })

    const empty = await service.createProfile({
      name: 'EmptyProxy',
      baseUrl: target.url,
      model: 'm',
      proxyMode: 'custom',
      proxyUrl: null
    })
    const emptyResult = await service.testConnection(empty.id)
    expect(emptyResult.ok).toBe(false)
    expect(emptyResult.error?.code).toBe('INVALID_ARGUMENT')

    const dead = await service.createProfile({
      name: 'DeadProxy',
      baseUrl: target.url,
      model: 'm',
      proxyMode: 'custom',
      proxyUrl: 'http://127.0.0.1:1'
    })
    const deadResult = await service.testConnection(dead.id, { timeoutMs: 500 })
    expect(deadResult.ok).toBe(false)
    expect(deadResult.error?.code).toBe('PROXY')
  })
})

describe('provider test / listModels against a local mock server', () => {
  it('returns models on GET /models 200', async () => {
    const { service } = setup()
    const server = await startServer((req, res) => {
      if (req.url === '/v1/models') {
        res.writeHead(200, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ data: [{ id: 'model-a' }, { id: 'model-b' }] }))
        return
      }
      res.writeHead(404)
      res.end()
    })
    const created = await service.createProfile({
      name: 'Mock',
      baseUrl: server.url,
      model: 'model-a',
      apiKey: 'sk-test-key'
    })

    const result = await service.testConnection(created.id)
    expect(result.ok).toBe(true)
    expect(result.status).toBe(200)
    expect(result.models).toEqual(['model-a', 'model-b'])
    expect(server.requests).toHaveLength(1)
    expect(server.requests[0].headers.authorization).toBe('Bearer sk-test-key')

    const models = await service.listModels(created.id)
    expect(models.models).toEqual(['model-a', 'model-b'])
  })

  it('maps 401 to auth with no retry', async () => {
    const { service } = setup()
    const server = await startServer((_req, res) => {
      res.writeHead(401, { 'Content-Type': 'application/json' })
      res.end('{"error":{"message":"bad key"}}')
    })
    const created = await service.createProfile({
      name: 'Mock',
      baseUrl: server.url,
      model: 'm',
      apiKey: 'sk-wrong'
    })

    const result = await service.testConnection(created.id)
    expect(result.ok).toBe(false)
    expect(result.error?.code).toBe('AUTH')
    expect(server.requests).toHaveLength(1)
  })

  it('maps a slow server to timeout with no retry', async () => {
    const { service } = setup()
    const server = await startServer((_req, res) => {
      setTimeout(() => {
        try {
          res.writeHead(200, { 'Content-Type': 'application/json' })
          res.end('{"data":[]}')
        } catch {
          // client already aborted
        }
      }, 400).unref()
    })
    const created = await service.createProfile({
      name: 'Mock',
      baseUrl: server.url,
      model: 'm'
    })

    const result = await service.testConnection(created.id, { timeoutMs: 60 })
    expect(result.ok).toBe(false)
    expect(result.error?.code).toBe('TIMEOUT')
    expect(server.requests).toHaveLength(1)
  })

  it('falls back to POST /chat/completions on 404 and sends custom headers', async () => {
    const { service } = setup()
    const server = await startServer((req, res) => {
      if (req.url === '/v1/models') {
        res.writeHead(404)
        res.end('not found')
        return
      }
      if (req.url === '/v1/chat/completions') {
        res.writeHead(200, { 'Content-Type': 'application/json' })
        res.end('{"id":"chatcmpl-1"}')
        return
      }
      res.writeHead(500)
      res.end()
    })
    const created = await service.createProfile({
      name: 'Mock',
      baseUrl: server.url,
      model: 'fallback-model',
      apiKey: 'sk-fallback',
      headers: [{ name: 'X-Tenant', value: 'tenant-1' }]
    })

    const result = await service.testConnection(created.id)
    expect(result.ok).toBe(true)
    expect(result.status).toBe(200)
    expect(server.requests).toHaveLength(2)

    const post = server.requests[1]
    expect(post.method).toBe('POST')
    expect(post.headers.authorization).toBe('Bearer sk-fallback')
    expect(post.headers['x-tenant']).toBe('tenant-1')
    const body = JSON.parse(post.body) as { model: string; max_tokens: number; stream: boolean }
    expect(body).toMatchObject({ model: 'fallback-model', max_tokens: 1, stream: false })
  })

  it('maps 5xx to server and 429 to rate_limit', async () => {
    const { service } = setup()
    let status = 500
    const server = await startServer((_req, res) => {
      res.writeHead(status, { 'Content-Type': 'application/json' })
      res.end('{"error":"x"}')
    })
    const created = await service.createProfile({
      name: 'Mock',
      baseUrl: server.url,
      model: 'm'
    })

    expect((await service.testConnection(created.id)).error?.code).toBe('SERVER')
    status = 429
    expect((await service.testConnection(created.id)).error?.code).toBe('RATE_LIMIT')
    expect(server.requests).toHaveLength(2)
  })
})

describe('settings service', () => {
  it('stores non-secret JSON values and rejects secret-looking keys', () => {
    const dir = tempDir()
    const db = openDbService({ dataDir: dir })
    openDbs.push(db)
    const settings = new SettingsService(db)

    expect(settings.set('window.geometry', { x: 1, y: 2 })).toBe(true)
    expect(settings.get('window.geometry')).toEqual({ x: 1, y: 2 })
    expect(settings.getAll()['window.geometry']).toEqual({ x: 1, y: 2 })

    for (const key of ['apiKey', 'openai_token', 'client-secret', 'password']) {
      expect(() => settings.set(key, 'x')).toThrow()
    }
  })
})
