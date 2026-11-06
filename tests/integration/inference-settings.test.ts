import { afterEach, describe, expect, it } from 'vitest'
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { openDbService, type DbService } from '../../src/main/db'
import type { KeyringBackend } from '../../src/main/secrets/keyring-backend'
import { SecretStore } from '../../src/main/secrets/store'
import { ProviderService } from '../../src/main/providers/service'
import { createProviderClient, type ProviderClient } from '../../src/main/provider/client'
import { ChatOrchestrator } from '../../src/main/chat/orchestrator'
import { SettingsService } from '../../src/main/settings/service'

const root = process.cwd()
const evidenceDir = join(root, '.omo', 'evidence', 'm2', 'settings')
const mockServer = join(root, 'tools', 'mock-sse-server.mjs')
mkdirSync(evidenceDir, { recursive: true })

const children: ChildProcessWithoutNullStreams[] = []
const cleanup: Array<() => void> = []
const evidence: Record<string, unknown> = {}
const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

class MemoryKeyring implements KeyringBackend {
  private readonly values = new Map<string, string>()

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

interface Harness {
  db: DbService
  providers: ProviderService
  client: ProviderClient
  settings: SettingsService
  chat: ChatOrchestrator
  profileId: string
  bodyLogPath: string
}

async function startMock(name: string): Promise<{ baseUrl: string; bodyLogPath: string }> {
  const bodyLogPath = join(evidenceDir, `task-32a-${name}-bodies.log`)
  rmSync(bodyLogPath, { force: true })
  const child = spawn(
    process.execPath,
    [
      mockServer,
      '--port',
      '0',
      '--mode',
      'normal',
      '--chunks',
      '2',
      '--delay',
      '5',
      '--body-log',
      bodyLogPath
    ],
    { cwd: root, stdio: ['ignore', 'pipe', 'pipe'] }
  ) as unknown as ChildProcessWithoutNullStreams
  children.push(child)

  let stdout = ''
  let stderr = ''
  const port = await new Promise<number>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`mock did not start: ${stdout} ${stderr}`)), 10_000)
    child.stdout.on('data', (chunk: Buffer) => {
      stdout += chunk.toString('utf8')
      const match = /listening on http:\/\/[^:\s]+:(\d+)/.exec(stdout)
      if (match) {
        clearTimeout(timer)
        resolve(Number(match[1]))
      }
    })
    child.stderr.on('data', (chunk: Buffer) => {
      stderr += chunk.toString('utf8')
    })
    child.once('error', (error) => {
      clearTimeout(timer)
      reject(error)
    })
    child.once('exit', (code) => {
      if (!stdout.includes('listening')) {
        clearTimeout(timer)
        reject(new Error(`mock exited early (${code}): ${stderr}`))
      }
    })
  })

  return { baseUrl: `http://127.0.0.1:${port}`, bodyLogPath }
}

async function createHarness(
  baseUrl: string,
  profile: { temperature?: number | null; maxTokens?: number | null } = {}
): Promise<Harness> {
  const dir = mkdtempSync(join(tmpdir(), 'quickask-inference-'))
  const db = openDbService({ dataDir: dir, recover: false })
  const secrets = new SecretStore({ keyring: new MemoryKeyring(), safeStorage: null, dataDir: dir })
  const providers = new ProviderService(db, secrets, { version: 'task32a-test' })
  const client = createProviderClient({
    env: {},
    version: 'task32a-test',
    timeouts: { connectMs: 2000, headersMs: 5000, idleMs: 10_000, totalMs: 60_000 }
  })
  const settings = new SettingsService(db)
  const chat = new ChatOrchestrator({
    db,
    providers,
    client,
    settings,
    emit: () => undefined
  })

  const created = await providers.createProfile({
    name: 'mock',
    baseUrl,
    model: 'mock-model',
    isDefault: true,
    ...(profile.temperature !== undefined ? { temperature: profile.temperature } : {}),
    ...(profile.maxTokens !== undefined ? { maxTokens: profile.maxTokens } : {})
  })

  cleanup.push(() => {
    client.abortAll()
    db.close()
    secrets.close()
    rmSync(dir, { recursive: true, force: true })
  })

  return {
    db,
    providers,
    client,
    settings,
    chat,
    profileId: created.id,
    bodyLogPath: ''
  }
}

function readBodies(path: string): Array<Record<string, unknown>> {
  let text = ''
  try {
    text = readFileSync(path, 'utf8')
  } catch {
    return []
  }
  return text
    .split('\n')
    .filter((line) => line.trim().length > 0)
    .map((line) => JSON.parse(line) as Record<string, unknown>)
}

async function stopChild(child: ChildProcessWithoutNullStreams): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return
  const closed = new Promise<void>((resolve) => child.once('close', () => resolve()))
  child.kill('SIGTERM')
  await Promise.race([closed, sleep(1500)])
  if (child.exitCode === null && child.signalCode === null) {
    child.kill('SIGKILL')
    await Promise.race([closed, sleep(1000)])
  }
}

afterEach(async () => {
  for (const fn of cleanup.splice(0)) fn()
  for (const child of children.splice(0)) await stopChild(child)
})

describe('inference settings reach the provider request', () => {
  it('sends systemPrompt/contextRounds/temperature/max_tokens when configured', async () => {
    const mock = await startMock('configured')
    const harness = await createHarness(mock.baseUrl)

    harness.settings.updateInference({
      systemPrompt: '你是 QuickAsk，回答简洁。',
      temperature: 0.7,
      maxTokens: 1234
    })
    harness.settings.updateBehavior({ contextRounds: 2 })

    let sessionId: string | null = null
    for (let index = 1; index <= 4; index += 1) {
      const started = await harness.chat.send({ sessionId, text: `问题 ${index}` })
      sessionId = started.sessionId
      await harness.chat.waitForIdle()
    }

    const bodies = readBodies(mock.bodyLogPath)
    const last = bodies.at(-1) ?? {}
    const messages = (last.messages as Array<{ role: string; content: string }>) ?? []

    expect(last.temperature).toBe(0.7)
    expect(last.max_tokens).toBe(1234)
    expect(messages[0]).toEqual({ role: 'system', content: '你是 QuickAsk，回答简洁。' })
    expect(messages).toHaveLength(6)
    expect(messages[1]).toEqual({ role: 'user', content: '问题 2' })
    expect(messages.at(-1)).toEqual({ role: 'user', content: '问题 4' })
    for (const message of messages) {
      expect(message.content).not.toMatch(/已停止|重试|复制/)
    }

    evidence.configured = {
      body: { temperature: last.temperature, max_tokens: last.max_tokens, messages },
      bodyCount: bodies.length
    }
  })

  it('omits null/default sampling fields and adds no system message', async () => {
    const mock = await startMock('defaults')
    const harness = await createHarness(mock.baseUrl)

    const started = await harness.chat.send({ sessionId: null, text: '默认问题' })
    await harness.chat.waitForIdle()

    const body = readBodies(mock.bodyLogPath)[0] ?? {}
    const messages = (body.messages as Array<{ role: string }>) ?? []
    expect(messages).toEqual([{ role: 'user', content: '默认问题' }])
    expect('temperature' in body).toBe(false)
    expect('max_tokens' in body).toBe(false)
    expect(started.sessionId.length).toBeGreaterThan(0)

    evidence.defaults = { body, requestId: started.requestId }
  })

  it('uses the provider profile sampling values when settings are null', async () => {
    const mock = await startMock('profile')
    const harness = await createHarness(mock.baseUrl, { temperature: 0.3, maxTokens: 500 })

    await harness.chat.send({ sessionId: null, text: 'profile 采样' })
    await harness.chat.waitForIdle()

    const body = readBodies(mock.bodyLogPath)[0] ?? {}
    expect(body.temperature).toBe(0.3)
    expect(body.max_tokens).toBe(500)

    evidence.profile = { temperature: body.temperature, max_tokens: body.max_tokens }
  })

  it('writes the task 32a inference evidence', () => {
    writeFileSync(
      join(evidenceDir, 'task-32a-inference.json'),
      `${JSON.stringify({ task: '32a', generatedAt: new Date().toISOString(), ...evidence }, null, 2)}\n`
    )
    expect(Object.keys(evidence).length).toBeGreaterThanOrEqual(3)
  })
})
