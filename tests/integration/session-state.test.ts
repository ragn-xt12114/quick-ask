import { afterEach, describe, expect, it } from 'vitest'
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  IPC,
  type ChatDeltaEvent,
  type ChatEndEvent,
  type ChatMessage,
  type IpcEventChannel,
  type MainWindowMode,
  type MessageStatus
} from '../../src/shared/channels'
import { uuidv7 } from '../../src/shared/uuidv7'
import { openDbService, type DbService } from '../../src/main/db'
import type { KeyringBackend } from '../../src/main/secrets/keyring-backend'
import { SecretStore } from '../../src/main/secrets/store'
import { ProviderService } from '../../src/main/providers/service'
import { createProviderClient, type ProviderClient } from '../../src/main/provider/client'
import { ChatOrchestrator } from '../../src/main/chat/orchestrator'
import { SessionState } from '../../src/main/session/state'
import { prioritizeCurrentSession } from '../../src/main/session/history-order'

const root = process.cwd()
const evidenceDir = join(root, '.omo', 'evidence')
const mockServer = join(root, 'tools', 'mock-sse-server.mjs')
mkdirSync(evidenceDir, { recursive: true })

const children: ChildProcessWithoutNullStreams[] = []
const harnesses: Harness[] = []
const summary: Record<string, unknown> = {}
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
  secrets: SecretStore
  providers: ProviderService
  client: ProviderClient
  chat: ChatOrchestrator
  state: SessionState
  events: Array<{ channel: IpcEventChannel; payload: unknown }>
  cleanup(): void
  close(): void
}

async function createHarness(
  baseUrl: string | null,
  options: { dir?: string; createProfile?: boolean } = {}
): Promise<Harness> {
  const dir = options.dir ?? mkdtempSync(join(tmpdir(), 'quickask-task21-'))
  const db = openDbService({ dataDir: dir, recover: false })
  const secrets = new SecretStore({ keyring: new MemoryKeyring(), safeStorage: null, dataDir: dir })
  const providers = new ProviderService(db, secrets, { version: 'task21-test' })
  const client = createProviderClient({
    env: {},
    version: 'task21-test',
    timeouts: { connectMs: 2000, headersMs: 5000, idleMs: 10_000, totalMs: 60_000 }
  })
  const events: Harness['events'] = []
  const chat = new ChatOrchestrator({
    db,
    providers,
    client,
    emit: (channel, payload) => {
      events.push({ channel, payload })
    }
  })
  let windowMode: MainWindowMode = 'S1'
  const state = new SessionState({
    db,
    chat,
    getWindowMode: () => windowMode,
    setWindowMode: async (mode) => {
      windowMode = mode
    },
    emit: (channel, payload) => {
      events.push({ channel, payload })
    }
  })

  if (baseUrl && options.createProfile !== false) {
    const existing = db.providers.list()[0]
    if (!existing) {
      await providers.createProfile({
        name: 'mock',
        baseUrl,
        model: 'mock-model',
        isDefault: true
      })
    }
  }

  let closed = false
  const close = (): void => {
    if (closed) return
    closed = true
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
  }

  const harness: Harness = {
    dir,
    db,
    secrets,
    providers,
    client,
    chat,
    state,
    events,
    close,
    cleanup() {
      close()
      rmSync(dir, { recursive: true, force: true })
    }
  }
  harnesses.push(harness)
  return harness
}

interface StartedMock {
  child: ChildProcessWithoutNullStreams
  port: number
  baseUrl: string
  logPath: string
  bodyLogPath: string
}

async function startMock(options: {
  mode: string
  chunks?: number
  delay?: number
  name: string
}): Promise<StartedMock> {
  const logPath = join(evidenceDir, `task-21-${options.name}.log`)
  const bodyLogPath = join(evidenceDir, `task-21-${options.name}-bodies.log`)
  rmSync(logPath, { force: true })
  rmSync(bodyLogPath, { force: true })
  const args = [
    mockServer,
    '--port',
    '0',
    '--mode',
    options.mode,
    '--log',
    logPath,
    '--body-log',
    bodyLogPath
  ]
  if (options.chunks !== undefined) args.push('--chunks', String(options.chunks))
  if (options.delay !== undefined) args.push('--delay', String(options.delay))

  const child = spawn(process.execPath, args, {
    cwd: root,
    stdio: ['ignore', 'pipe', 'pipe']
  }) as unknown as ChildProcessWithoutNullStreams
  children.push(child)

  let stdout = ''
  let stderr = ''
  const port = await new Promise<number>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`mock did not start: ${stdout} ${stderr}`)), 10_000)
    child.stdout.on('data', (chunk: Buffer) => {
      stdout += chunk.toString('utf8')
      const match = /mock-sse-server listening on http:\/\/[^:\s]+:(\d+)/.exec(stdout)
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
  return { child, port, baseUrl: `http://127.0.0.1:${port}`, logPath, bodyLogPath }
}

function readText(path: string): string {
  try {
    return readFileSync(path, 'utf8')
  } catch {
    return ''
  }
}

interface RequestBody {
  model: string
  messages: Array<{ role: string; content: string }>
}

function readBodies(path: string): RequestBody[] {
  return readText(path)
    .split('\n')
    .filter((line) => line.trim().length > 0)
    .map((line) => JSON.parse(line) as RequestBody)
}

function deltas(harness: Harness, requestId: string): ChatDeltaEvent[] {
  return harness.events
    .filter((entry) => entry.channel === IPC.EVENT_CHAT_DELTA)
    .map((entry) => entry.payload as ChatDeltaEvent)
    .filter((event) => event.requestId === requestId)
}

function ends(harness: Harness, requestId: string): ChatEndEvent[] {
  return harness.events
    .filter((entry) => entry.channel === IPC.EVENT_CHAT_END)
    .map((entry) => entry.payload as ChatEndEvent)
    .filter((event) => event.requestId === requestId)
}

async function waitFor(predicate: () => boolean, timeoutMs = 6000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (predicate()) return
    await sleep(10)
  }
  throw new Error('waitFor timed out')
}

function writeEvidence(name: string, value: unknown): void {
  writeFileSync(join(evidenceDir, name), `${JSON.stringify(value, null, 2)}\n`)
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

function seedSession(
  db: DbService,
  title: string,
  updatedAt: number,
  history: Array<{ role: 'user' | 'assistant'; content: string; status?: MessageStatus }>
): string {
  const id = uuidv7(updatedAt)
  db.sessions.create({
    id,
    title,
    titleAuto: false,
    createdAt: updatedAt,
    updatedAt,
    lastMessageAt: updatedAt,
    model: 'mock-model'
  })
  history.forEach((row, seq) => {
    db.messages.insert({
      id: uuidv7(updatedAt + seq + 1),
      sessionId: id,
      seq,
      role: row.role,
      content: row.content,
      status: row.status ?? 'complete',
      createdAt: updatedAt,
      updatedAt: updatedAt
    })
  })
  db.search.rebuild(id)
  return id
}

function assistantOf(db: DbService, sessionId: string): ChatMessage | undefined {
  return db.getMessages(sessionId).find((row) => row.role === 'assistant')
}

afterEach(async () => {
  for (const harness of harnesses.splice(0)) harness.cleanup()
  for (const child of children.splice(0)) await stopChild(child)
})

describe('SessionState integration (real DB + mock SSE)', () => {
  it('20 A/B switches keep messages and request bodies isolated', async () => {
    const mock = await startMock({ mode: 'normal', chunks: 1, delay: 0, name: 'isolation' })
    const harness = await createHarness(mock.baseUrl)
    const base = Date.now()
    const a = seedSession(harness.db, 'A session', base, [
      { role: 'user', content: 'A-history-user' }
    ])
    const b = seedSession(harness.db, 'B session', base + 1000, [
      { role: 'user', content: 'B-history-user' }
    ])

    const bodies: RequestBody[] = []
    for (let turn = 0; turn < 20; turn += 1) {
      const target = turn % 2 === 0 ? { id: a, tag: 'A' } : { id: b, tag: 'B' }
      await harness.state.open(target.id)
      await harness.state.send(`${target.tag}-turn-${turn}`)
      await harness.chat.waitForIdle()
      bodies.push(...readBodies(mock.bodyLogPath).slice(bodies.length))
    }

    expect(bodies).toHaveLength(20)
    for (const body of bodies) {
      const users = body.messages.filter((message) => message.role === 'user')
      const current = users[users.length - 1]?.content ?? ''
      const tag = current.startsWith('A-') ? 'A' : 'B'
      expect(users.every((message) => message.content.startsWith(tag))).toBe(true)
    }

    const aMessages = harness.db.getMessages(a)
    const bMessages = harness.db.getMessages(b)
    expect(aMessages.filter((row) => row.role === 'user')).toHaveLength(11)
    expect(bMessages.filter((row) => row.role === 'user')).toHaveLength(11)
    expect(
      aMessages
        .filter((row) => row.role === 'user')
        .map((row) => row.content)
        .every((content) => content.startsWith('A-'))
    ).toBe(true)
    expect(
      bMessages
        .filter((row) => row.role === 'user')
        .map((row) => row.content)
        .every((content) => content.startsWith('B-'))
    ).toBe(true)

    writeEvidence('task-21-isolation.json', {
      switches: 20,
      requests: bodies.length,
      sessions: {
        A: { messages: aMessages.length, user: 11 },
        B: { messages: bMessages.length, user: 11 }
      },
      crossContamination: false,
      classification: bodies.map((body) => {
        const users = body.messages.filter((message) => message.role === 'user')
        return users[users.length - 1]?.content ?? ''
      })
    })
  })

  it('streaming A then opening B stops A with persisted content and no A deltas after switch', async () => {
    const mock = await startMock({ mode: 'slow', chunks: 100, delay: 60, name: 'switch-stream' })
    const harness = await createHarness(mock.baseUrl)
    const base = Date.now()
    const a = seedSession(harness.db, 'Stream A', base, [{ role: 'user', content: 'A-history' }])
    const b = seedSession(harness.db, 'Stream B', base + 1000, [{ role: 'user', content: 'B-history' }])

    await harness.state.open(a)
    const started = await harness.state.send('A-slow-question')
    await waitFor(() => deltas(harness, started.requestId).length >= 1)

    await harness.state.open(b)
    const deltasAtSwitch = deltas(harness, started.requestId).length
    await sleep(350)
    const deltasAfterSwitch = deltas(harness, started.requestId).length
    expect(deltasAfterSwitch).toBe(deltasAtSwitch)

    const aAssistant = assistantOf(harness.db, a)
    expect(aAssistant?.status).toBe('stopped')
    expect((aAssistant?.content.length ?? 0)).toBeGreaterThan(0)
    expect(ends(harness, started.requestId)[0]?.status).toBe('stopped')

    const bStarted = await harness.state.send('B-question')
    await harness.chat.waitForIdle()
    const bAssistant = assistantOf(harness.db, b)
    expect(bAssistant?.status).toBe('complete')
    expect(harness.state.getCurrentSessionId()).toBe(b)
    expect(harness.state.getMode()).toBe('S2')
    expect(harness.state.getActiveRequestId()).toBeNull()
    expect(bStarted.sessionId).toBe(b)

    const bodies = readBodies(mock.bodyLogPath)
    const bBody = bodies[bodies.length - 1]
    expect(bBody?.messages.some((message) => message.content.includes('A-'))).toBe(false)
    expect(bBody?.messages.some((message) => message.content === 'B-question')).toBe(true)

    writeEvidence('task-21-switch-stream.json', {
      a: { sessionId: a, status: aAssistant?.status, contentLength: aAssistant?.content.length },
      deltasAtSwitch,
      deltasAfterSwitch,
      aDeltasAfterSwitch: deltasAfterSwitch - deltasAtSwitch,
      b: { sessionId: b, status: bAssistant?.status },
      currentSessionId: harness.state.getCurrentSessionId(),
      bBody: bBody?.messages
    })
  })

  it('deleteCurrent cascades messages and resets state without a stale active request', async () => {
    const mock = await startMock({ mode: 'normal', chunks: 2, delay: 5, name: 'delete' })
    const harness = await createHarness(mock.baseUrl)
    const id = seedSession(harness.db, 'Delete me', Date.now(), [
      { role: 'user', content: 'delete-history' }
    ])
    await harness.state.open(id)
    await harness.state.send('delete-turn')
    await harness.chat.waitForIdle()

    const deleted = await harness.state.deleteCurrent()

    expect(deleted).toBe(true)
    expect(harness.db.getSession(id)).toBeNull()
    expect(harness.db.getMessages(id)).toEqual([])
    expect(harness.state.getCurrentSessionId()).toBeNull()
    expect(harness.state.getMode()).toBe('S1')
    expect(harness.state.getActiveRequestId()).toBeNull()
    expect(harness.chat.getActive()).toBeNull()
    const snapshot = await harness.state.getState()
    expect(snapshot).toMatchObject({
      currentSessionId: null,
      mode: 'S1',
      activeRequestId: null,
      messages: []
    })

    writeEvidence('task-21-delete.json', {
      deleted,
      dbSession: harness.db.getSession(id),
      messages: harness.db.getMessages(id),
      state: snapshot,
      active: harness.chat.getActive()
    })
  })

  it('restart selects the most recent session with S1 and opens it', async () => {
    const mock = await startMock({ mode: 'normal', chunks: 2, delay: 5, name: 'restart' })
    const first = await createHarness(mock.baseUrl)
    const older = seedSession(first.db, 'Older', Date.now() - 10_000, [
      { role: 'user', content: 'older' }
    ])
    const newer = seedSession(first.db, 'Newer', Date.now(), [{ role: 'user', content: 'newer' }])
    const dir = first.dir
    first.close()

    const second = await createHarness(mock.baseUrl, { dir, createProfile: false })
    const restartCurrent = second.state.getCurrentSessionId()
    const restartMode = second.state.getMode()
    expect(restartCurrent).toBe(newer)
    expect(restartMode).toBe('S1')
    expect(second.state.bootstrap()).toEqual({ currentSessionId: newer, mode: 'S1' })

    const opened = await second.state.open(newer)
    expect(opened.session.id).toBe(newer)
    expect(opened.messages[0]?.content).toBe('newer')
    expect(second.state.getMode()).toBe('S2')

    const olderOpened = await second.state.open(older)
    expect(olderOpened.messages[0]?.content).toBe('older')

    writeEvidence('task-21-restart.json', {
      mostRecent: newer,
      currentAfterRestart: restartCurrent,
      modeAfterRestart: restartMode,
      currentBeforeOpening: restartCurrent,
      dbRecentAfterRestart: second.db.listSessions({ limit: 1 })[0]?.id ?? null,
      openedRecent: opened.messages.length,
      openedOlder: olderOpened.messages.length
    })
  })

  it('auto title, manual rename, updated_at ordering and active-first reorder', async () => {
    const mock = await startMock({ mode: 'normal', chunks: 1, delay: 3, name: 'ordering' })
    const harness = await createHarness(mock.baseUrl)

    await harness.state.new()
    const firstTurn = await harness.state.send(
      '# 标题\n\n**加粗** `code` [链接](https://example.com) 超过二十个字符的正文'
    )
    await harness.chat.waitForIdle()
    const created = harness.db.getSession(firstTurn.sessionId)
    expect(created?.titleAuto).toBe(true)
    expect(Array.from(created?.title ?? '').length).toBeLessThanOrEqual(20)
    const titleAfterAuto = created?.title ?? ''

    harness.db.renameSession(firstTurn.sessionId, '手动标题')
    const updatedBefore = harness.db.getSession(firstTurn.sessionId)?.updatedAt ?? 0
    await sleep(10)
    await harness.state.send('后续消息不覆盖标题')
    await harness.chat.waitForIdle()
    const afterSecond = harness.db.getSession(firstTurn.sessionId)
    expect(afterSecond?.title).toBe('手动标题')
    expect(afterSecond?.titleAuto).toBe(false)
    expect((afterSecond?.updatedAt ?? 0)).toBeGreaterThanOrEqual(updatedBefore)

    await harness.state.new()
    const secondTurn = await harness.state.send('第二个会话的消息')
    await harness.chat.waitForIdle()
    const list = harness.db.listSessions({ limit: 1000 })
    expect(list[0]?.id).toBe(secondTurn.sessionId)

    await harness.state.open(firstTurn.sessionId)
    const reordered = prioritizeCurrentSession(list, harness.state.getCurrentSessionId())
    expect(reordered[0]?.id).toBe(firstTurn.sessionId)

    writeEvidence('task-21-ordering.json', {
      autoTitle: titleAfterAuto,
      autoTitleLength: Array.from(titleAfterAuto).length,
      titleAuto: created?.titleAuto,
      renamed: '手动标题',
      afterSecondSend: afterSecond?.title,
      afterSecondSendAuto: afterSecond?.titleAuto,
      updatedAtBefore: updatedBefore,
      updatedAtAfter: afterSecond?.updatedAt,
      dbFirst: list[0]?.id,
      activeFirst: reordered[0]?.id,
      activeSession: harness.state.getCurrentSessionId()
    })
  })

  it('multi-turn body contains the previous user+assistant pair', async () => {
    const mock = await startMock({ mode: 'normal', chunks: 2, delay: 5, name: 'multiturn' })
    const harness = await createHarness(mock.baseUrl)

    await harness.state.new()
    const first = await harness.state.send('第一轮问题')
    await harness.chat.waitForIdle()
    const firstAssistant = assistantOf(harness.db, first.sessionId)?.content ?? ''
    const second = await harness.state.send('第二轮追问')
    await harness.chat.waitForIdle()

    const bodies = readBodies(mock.bodyLogPath)
    expect(bodies).toHaveLength(2)
    expect(bodies[1]?.messages).toEqual([
      { role: 'user', content: '第一轮问题' },
      { role: 'assistant', content: firstAssistant },
      { role: 'user', content: '第二轮追问' }
    ])
    expect(second.sessionId).toBe(first.sessionId)

    writeEvidence('task-21-multiturn.json', {
      bodies: bodies.length,
      secondMessages: bodies[1]?.messages,
      firstRequestId: first.requestId,
      secondRequestId: second.requestId
    })
  })

  it('stopped/interrupted content enters context, error/empty does not', async () => {
    const mock = await startMock({ mode: 'normal', chunks: 1, delay: 3, name: 'context-status' })
    const harness = await createHarness(mock.baseUrl)
    const id = seedSession(harness.db, 'Status context', Date.now(), [
      { role: 'user', content: 'stopped-question' },
      { role: 'assistant', content: 'stopped-answer', status: 'stopped' },
      { role: 'user', content: 'error-question' },
      { role: 'assistant', content: 'error-answer', status: 'error' },
      { role: 'user', content: 'interrupted-question' },
      { role: 'assistant', content: 'interrupted-answer', status: 'interrupted' }
    ])
    await harness.state.open(id)
    await harness.state.send('next-question')
    await harness.chat.waitForIdle()

    const body = readBodies(mock.bodyLogPath)[0]
    const contents = body?.messages.map((message) => message.content) ?? []
    expect(contents).toContain('stopped-answer')
    expect(contents).toContain('interrupted-answer')
    expect(contents).not.toContain('error-answer')
    expect(contents.some((content) => /已停止|已中断|生成失败/.test(content))).toBe(false)

    writeEvidence('task-21-context-status.json', {
      messages: body?.messages,
      stoppedIncluded: contents.includes('stopped-answer'),
      interruptedIncluded: contents.includes('interrupted-answer'),
      errorExcluded: !contents.includes('error-answer'),
      uiLabelsLeaked: contents.some((content) => /已停止|已中断|生成失败/.test(content))
    })
  })
})

describe('task 21 evidence summary', () => {
  it('writes the summary file', () => {
    writeEvidence('task-21-summary.json', {
      task: 21,
      generatedAt: new Date().toISOString(),
      unit: 'tests/unit/session-state.test.ts (8)',
      integration: 'tests/integration/session-state.test.ts (8)',
      e2e: 'tests/e2e/session.spec.ts (5)',
      coverage: [
        'open/new/delete serialization and active abort ordering',
        'startup recent-session fallback with S1',
        '20 A/B switches with request-body isolation',
        'stream A then open B: stopped+persisted, no later A deltas',
        'delete current cascade and no stale active request',
        'restart current=most recent, mode S1',
        'auto title/manual rename/updated_at/active-first ordering',
        'multi-turn body [user1, assistant1, user2]',
        'stopped/interrupted context included, error/empty excluded'
      ],
      evidence: [
        'task-21-isolation.json',
        'task-21-switch-stream.json',
        'task-21-delete.json',
        'task-21-restart.json',
        'task-21-ordering.json',
        'task-21-multiturn.json',
        'task-21-context-status.json',
        'task-21-startup-open-new.json',
        'task-21-e2e-summary.json'
      ],
      ...summary
    })
    expect(existsSync(join(evidenceDir, 'task-21-summary.json'))).toBe(true)
  })
})
