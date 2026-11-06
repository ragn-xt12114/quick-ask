import { afterAll, describe, expect, it } from 'vitest'
import { createHash, randomBytes } from 'node:crypto'
import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync
} from 'node:fs'
import { join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'
import { openDbService } from '../../src/main/db/service'
import type { KeyringBackend } from '../../src/main/secrets/keyring-backend'
import { SecretStore, type SafeStorageLike } from '../../src/main/secrets/store'
import { ProviderService } from '../../src/main/providers/service'

const projectRoot = fileURLToPath(new URL('../..', import.meta.url))
const evidenceDir = join(projectRoot, '.omo', 'evidence')
const runtimeRoot = join(projectRoot, '.runtime', 'task11-noplaintext')
const tempDirs: string[] = []

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

function collectTextFiles(root: string, output: string[]): void {
  if (!existsSync(root)) return
  for (const entry of readdirSync(root)) {
    const full = join(root, entry)
    const stat = statSync(full)
    if (stat.isDirectory()) {
      collectTextFiles(full, output)
      continue
    }
    if (stat.size <= 10 * 1024 * 1024) output.push(full)
  }
}

function scan(files: string[], needles: string[]): { hits: string[]; files: number } {
  const hits: string[] = []
  for (const file of files) {
    const content = readFileSync(file)
    for (const needle of needles) {
      if (content.includes(Buffer.from(needle, 'utf8'))) {
        hits.push(`${relative(projectRoot, file)} :: ${needle.slice(0, 4)}...`)
      }
    }
  }
  return { hits, files: files.length }
}

const servers: Array<{ close(): Promise<void> }> = []

afterAll(async () => {
  for (const server of servers.splice(0)) await server.close()
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

describe('Task 11 no-plaintext evidence', () => {
  it('never writes the API key or header value to DB/config/logs', async () => {
    rmSync(runtimeRoot, { recursive: true, force: true })
    mkdirSync(runtimeRoot, { recursive: true, mode: 0o700 })

    const dataDir = mkdtempSync(join(runtimeRoot, 'db-'))
    tempDirs.push(dataDir)
    const db = openDbService({ dataDir })
    const keyring = new MemoryKeyring()
    const store = new SecretStore({
      keyring,
      safeStorage: new FakeSafeStorage(),
      dataDir
    })
    const service = new ProviderService(db, store, { now: () => 1_700_000_000_000 })

    const apiKey = `sk-task11-${randomBytes(24).toString('hex')}`
    const headerValue = `header-${randomBytes(24).toString('hex')}`
    const fingerprint = createHash('sha256').update(apiKey).digest('hex')

    const view = await service.createProfile({
      name: 'NoPlaintext',
      baseUrl: 'https://example.test',
      model: 'test-model',
      apiKey,
      headers: [{ name: 'X-Custom', value: headerValue }],
      isDefault: true
    })

    const resolved = await service.resolveProfile(view.id)
    expect(resolved.apiKey).toBe(apiKey)
    expect(resolved.headers['X-Custom']).toBe(headerValue)

    db.close()

    const files: string[] = []
    collectTextFiles(dataDir, files)
    for (const config of [
      'package.json',
      '.npmrc',
      'electron.vite.config.ts',
      'playwright.config.ts',
      'vitest.config.mts',
      'tsconfig.json',
      'tsconfig.node.json',
      'tsconfig.web.json'
    ]) {
      const full = join(projectRoot, config)
      if (existsSync(full)) files.push(full)
    }
    const task11Evidence = readdirSync(evidenceDir)
      .filter((name) => name.startsWith('task-11-') && !name.startsWith('task-11-grep'))
      .map((name) => join(evidenceDir, name))
    files.push(...task11Evidence)

    const result = scan(files, [apiKey, headerValue, fingerprint])
    const dbAndConfigFiles = files.filter(
      (file) =>
        file.startsWith(dataDir) ||
        ['package.json', '.npmrc'].some((name) => file.endsWith(`/${name}`))
    )
    const skPrefix = scan(dbAndConfigFiles, ['sk-'])
    const clean = result.hits.length === 0 && skPrefix.hits.length === 0
    const lines = [
      '# Task 11 — no-plaintext evidence',
      `generated_at: ${new Date().toISOString()}`,
      `api_key_fingerprint: sha256:${fingerprint}`,
      `data_dir: ${relative(projectRoot, dataDir)}`,
      `files_scanned: ${result.files}`,
      'needles: api_key, header_value, sha256_fingerprint (DB + config + task-11 logs)',
      `sk_prefix_files_scanned: ${skPrefix.files} (DB + config)`,
      `hits: ${JSON.stringify(result.hits)}`,
      `sk_prefix_hits: ${JSON.stringify(skPrefix.hits)}`,
      '',
      clean ? 'NO_PLAINTEXT_FOUND' : 'PLAINTEXT_FOUND',
      ''
    ]
    mkdirSync(evidenceDir, { recursive: true })
    writeFileSync(join(evidenceDir, 'task-11-grep.txt'), lines.join('\n'))

    expect(result.hits).toEqual([])
    expect(skPrefix.hits).toEqual([])
  })

  it('records provider:test success/401/timeout against a local mock server', async () => {
    const dataDir = mkdtempSync(join(runtimeRoot, 'mock-'))
    tempDirs.push(dataDir)
    const db = openDbService({ dataDir })
    const store = new SecretStore({
      keyring: new MemoryKeyring(),
      safeStorage: new FakeSafeStorage(),
      dataDir
    })
    const service = new ProviderService(db, store, { now: () => 1_700_000_000_000 })

    let mode: 'success' | '401' | 'timeout' = 'success'
    const requestLog: Array<{ mode: string; authorization: string | null }> = []
    const server = createServer((req, res) => {
      requestLog.push({
        mode,
        authorization: req.headers.authorization ?? null
      })
      if (mode === '401') {
        res.writeHead(401, { 'Content-Type': 'application/json' })
        res.end('{"error":"bad key"}')
        return
      }
      if (mode === 'timeout') {
        setTimeout(() => {
          try {
            res.writeHead(200, { 'Content-Type': 'application/json' })
            res.end('{"data":[]}')
          } catch {
            // client aborted
          }
        }, 400).unref()
        return
      }
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ data: [{ id: 'mock-model' }] }))
    })
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    const port = (server.address() as AddressInfo).port
    const wrapper = {
      async close() {
        server.closeAllConnections()
        await new Promise<void>((resolve) => server.close(() => resolve()))
      }
    }
    servers.push(wrapper)

    const profile = await service.createProfile({
      name: 'MockEvidence',
      baseUrl: `http://127.0.0.1:${port}`,
      model: 'mock-model',
      apiKey: 'sk-mock-evidence-key'
    })

    const success = await service.testConnection(profile.id)
    mode = '401'
    const unauthorized = await service.testConnection(profile.id)
    mode = 'timeout'
    const timeout = await service.testConnection(profile.id, { timeoutMs: 60 })

    expect(success.ok).toBe(true)
    expect(success.status).toBe(200)
    expect(success.models).toEqual(['mock-model'])
    expect(unauthorized.error?.code).toBe('AUTH')
    expect(timeout.error?.code).toBe('TIMEOUT')
    expect(requestLog).toHaveLength(3)

    const report = {
      schema_version: 1,
      generated_at: new Date().toISOString(),
      task: 'task-11',
      server: `http://127.0.0.1:${port}`,
      results: {
        success: { ok: success.ok, status: success.status, models: success.models },
        unauthorized: { ok: unauthorized.ok, error_code: unauthorized.error?.code },
        timeout: { ok: timeout.ok, error_code: timeout.error?.code }
      },
      requests: requestLog.map((entry) => ({
        mode: entry.mode,
        authorization_present: entry.authorization !== null
      })),
      no_retries: requestLog.length === 3
    }
    writeFileSync(
      join(evidenceDir, 'task-11-provider-test.json'),
      `${JSON.stringify(report, null, 2)}\n`
    )

    db.close()
  })
})
