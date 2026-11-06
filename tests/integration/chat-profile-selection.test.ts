/**
 * Task 33b — the orchestrator chooses the profile selected in
 * `settings.model.profileId` for the *next* request, falls back to the
 * default/first profile when the selection is stale, and never mutates an
 * already-active stream when the selection changes mid-stream.
 */
import { afterEach, describe, expect, it } from 'vitest'
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { IPC, type ChatDeltaEvent, type ChatEndEvent, type IpcEventChannel } from '../../src/shared/channels'
import { openDbService, type DbService } from '../../src/main/db'
import type { KeyringBackend } from '../../src/main/secrets/keyring-backend'
import { SecretStore } from '../../src/main/secrets/store'
import { ProviderService } from '../../src/main/providers/service'
import { SettingsService } from '../../src/main/settings/service'
import { createProviderClient, type ProviderClient } from '../../src/main/provider/client'
import { ChatOrchestrator } from '../../src/main/chat/orchestrator'

const root = process.cwd()
const mockServer = join(root, 'tools', 'mock-sse-server.mjs')
const children: ChildProcessWithoutNullStreams[] = []
const harnesses: Harness[] = []
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
  dir: string
  db: DbService
  providers: ProviderService
  settings: SettingsService
  client: ProviderClient
  chat: ChatOrchestrator
  events: Array<{ channel: IpcEventChannel; payload: unknown }>
  cleanup(): void
}

async function createHarness(): Promise<Harness> {
  const dir = mkdtempSync(join(tmpdir(), 'quickask-chat-profiles-'))
  const db = openDbService({ dataDir: dir, recover: false })
  const secrets = new SecretStore({ keyring: new MemoryKeyring(), safeStorage: null, dataDir: dir })
  const providers = new ProviderService(db, secrets, { version: 'task33b-test' })
  const settings = new SettingsService(db)
  const client = createProviderClient({
    env: {},
    version: 'task33b-test',
    timeouts: { connectMs: 2000, headersMs: 5000, idleMs: 10_000, totalMs: 60_000 }
  })
  const events: Harness['events'] = []
  const chat = new ChatOrchestrator({
    db,
    providers,
    client,
    settings,
    emit: (channel, payload) => {
      events.push({ channel, payload })
    }
  })

  const harness: Harness = {
    dir,
    db,
    providers,
    settings,
    client,
    chat,
    events,
    cleanup() {
      try {
        client.abortAll()
      } catch {
        // no active request
      }
      try {
        db.close()
      } catch {
        // already closed
      }
      secrets.close()
      rmSync(dir, { recursive: true, force: true })
    }
  }
  harnesses.push(harness)
  return harness
}

interface StartedMock {
  baseUrl: string
  bodyLogPath: string
}

async function startMock(name: string, args: string[] = []): Promise<StartedMock> {
  const bodyLogPath = join(
    mkdtempSync(join(tmpdir(), `quickask-33b-${name}-`)),
    'bodies.log'
  )
  const child = spawn(
    process.execPath,
    [mockServer, '--port', '0', '--body-log', bodyLogPath, ...args],
    { cwd: root, stdio: ['ignore', 'pipe', 'pipe'] }
  ) as unknown as ChildProcessWithoutNullStreams
  children.push(child)
  const baseUrl = await new Promise<string>((resolve, reject) => {
    let stdout = ''
    let stderr = ''
    const timer = setTimeout(() => reject(new Error(`mock did not start: ${stderr}`)), 10_000)
    child.stdout.setEncoding('utf8')
    child.stderr.setEncoding('utf8')
    child.stdout.on('data', (chunk: string) => {
      stdout += chunk
      const match = /listening on (http:\/\/[^:\s]+:\d+)/.exec(stdout)
      if (match) {
        clearTimeout(timer)
        resolve(match[1]!)
      }
    })
    child.stderr.on('data', (chunk: string) => {
      stderr += chunk
    })
    child.once('error', (error) => {
      clearTimeout(timer)
      reject(error)
    })
  })
  return { baseUrl, bodyLogPath }
}

function requestBodies(path: string): Array<{ model: string }> {
  try {
    return readFileSync(path, 'utf8')
      .split('\n')
      .filter((line) => line.trim().length > 0)
      .map((line) => JSON.parse(line) as { model: string })
  } catch {
    return []
  }
}

async function waitFor(predicate: () => boolean, timeoutMs = 8000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (predicate()) return
    await sleep(10)
  }
  throw new Error('waitFor timed out')
}

afterEach(async () => {
  for (const harness of harnesses.splice(0)) harness.cleanup()
  for (const child of children.splice(0)) {
    if (child.exitCode !== null || child.signalCode !== null) continue
    const closed = new Promise<void>((resolve) => child.once('close', () => resolve()))
    child.kill('SIGTERM')
    await Promise.race([closed, sleep(1500)])
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL')
  }
})

describe('ChatOrchestrator model profile selection', () => {
  it('uses settings.model.profileId for the next request', async () => {
    const mock = await startMock('selected')
    const harness = await createHarness()
    const a = await harness.providers.createProfile({
      name: 'A',
      baseUrl: mock.baseUrl,
      model: 'model-a',
      apiKey: 'sk-a',
      isDefault: true
    })
    const b = await harness.providers.createProfile({
      name: 'B',
      baseUrl: mock.baseUrl,
      model: 'model-b',
      apiKey: 'sk-b'
    })
    harness.settings.set('model', { profileId: b.id })

    const started = await harness.chat.send({ sessionId: null, text: 'use selected' })
    await harness.chat.waitForIdle()

    const bodies = requestBodies(mock.bodyLogPath)
    expect(bodies.at(-1)?.model).toBe('model-b')
    const assistant = harness.db
      .getMessages(started.sessionId)
      .find((message) => message.role === 'assistant')
    expect(assistant?.model).toBe('model-b')
    expect(a.id).not.toBe(b.id)
  })

  it('falls back to default/first when the selection is stale', async () => {
    const mock = await startMock('fallback')
    const harness = await createHarness()
    const a = await harness.providers.createProfile({
      name: 'A',
      baseUrl: mock.baseUrl,
      model: 'model-a',
      apiKey: 'sk-a',
      isDefault: true
    })
    const b = await harness.providers.createProfile({
      name: 'B',
      baseUrl: mock.baseUrl,
      model: 'model-b',
      apiKey: 'sk-b'
    })

    harness.settings.set('model', { profileId: 'missing-profile' })
    const first = await harness.chat.send({ sessionId: null, text: 'stale id' })
    await harness.chat.waitForIdle()
    expect(requestBodies(mock.bodyLogPath).at(-1)?.model).toBe('model-a')

    harness.settings.set('model', { profileId: b.id })
    await harness.providers.deleteProfile(b.id)
    const second = await harness.chat.send({ sessionId: first.sessionId, text: 'deleted selected' })
    await harness.chat.waitForIdle()
    expect(requestBodies(mock.bodyLogPath).at(-1)?.model).toBe('model-a')
    const assistant = harness.db
      .getMessages(second.sessionId)
      .filter((message) => message.role === 'assistant')
      .at(-1)
    expect(assistant?.model).toBe('model-a')
    expect(a.isDefault).toBe(true)
  })

  it('keeps an active stream on its original profile when selection changes', async () => {
    const mock = await startMock('switch', ['--mode', 'slow', '--chunks', '24', '--delay', '30'])
    const harness = await createHarness()
    await harness.providers.createProfile({
      name: 'A',
      baseUrl: mock.baseUrl,
      model: 'model-a',
      apiKey: 'sk-a',
      isDefault: true
    })
    const b = await harness.providers.createProfile({
      name: 'B',
      baseUrl: mock.baseUrl,
      model: 'model-b',
      apiKey: 'sk-b'
    })

    const started = await harness.chat.send({ sessionId: null, text: 'slow A' })
    await waitFor(() =>
      harness.events.some(
        (entry) =>
          entry.channel === IPC.EVENT_CHAT_DELTA &&
          (entry.payload as ChatDeltaEvent).requestId === started.requestId
      )
    )
    harness.settings.set('model', { profileId: b.id })
    expect(harness.chat.getActive()?.requestId).toBe(started.requestId)
    await harness.chat.waitForIdle()

    const bodyLog = requestBodies(mock.bodyLogPath)
    expect(bodyLog.map((body) => body.model)).toEqual(['model-a'])
    const end = harness.events
      .filter((entry) => entry.channel === IPC.EVENT_CHAT_END)
      .map((entry) => entry.payload as ChatEndEvent)
      .find((event) => event.requestId === started.requestId)
    expect(end?.status).toBe('complete')
    const assistant = harness.db
      .getMessages(started.sessionId)
      .find((message) => message.role === 'assistant')
    expect(assistant?.model).toBe('model-a')

    const next = await harness.chat.send({ sessionId: started.sessionId, text: 'next B' })
    await harness.chat.waitForIdle()
    expect(requestBodies(mock.bodyLogPath).at(-1)?.model).toBe('model-b')
    const nextAssistant = harness.db
      .getMessages(next.sessionId)
      .filter((message) => message.role === 'assistant')
      .at(-1)
    expect(nextAssistant?.model).toBe('model-b')
  })
})
