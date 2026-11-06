import { _electron as electron, expect, test } from '@playwright/test'
import type { ElectronApplication, Page } from '@playwright/test'
import { execFileSync, spawn, type ChildProcess } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { DatabaseSync } from 'node:sqlite'

interface IpcResponse<T = unknown> {
  ok: boolean
  data?: T
  error?: { code: string; message: string }
}

interface SessionSummaryLike {
  id: string
  title: string
  updatedAt: number
  lastMessageAt: number | null
  model: string | null
}

interface ChatMessageLike {
  id: string
  sessionId: string
  seq: number
  role: string
  content: string
  status: string
}

interface SessionStateLike {
  currentSessionId: string | null
  mode: string
  activeRequestId: string | null
  messages: ChatMessageLike[]
}

interface SessionOpenLike {
  session: SessionSummaryLike
  messages: ChatMessageLike[]
}

interface TestApi {
  window: {
    show(): Promise<IpcResponse<{ mode: string; visible: boolean }>>
    setMode(mode: string): Promise<IpcResponse<{ mode: string }>>
  }
  chat: {
    send(request: { sessionId: string | null; text: string }): Promise<
      IpcResponse<{ requestId: string; sessionId: string }>
    >
    getActive(): Promise<
      IpcResponse<{ active: { requestId: string; sessionId: string } | null }>
    >
  }
  sessions: {
    list(request?: {
      query?: string
      limit?: number
      offset?: number
    }): Promise<IpcResponse<{ sessions: SessionSummaryLike[] }>>
    open(request: { id: string }): Promise<IpcResponse<SessionOpenLike>>
    new(): Promise<IpcResponse<{ currentSessionId: string | null; mode: 'S1' }>>
    state(): Promise<IpcResponse<SessionStateLike>>
    get(request: { id: string }): Promise<IpcResponse<SessionSummaryLike>>
    getMessages(
      request: { sessionId: string }
    ): Promise<IpcResponse<{ messages: ChatMessageLike[] }>>
    delete(request: { id: string }): Promise<IpcResponse<{ deleted: boolean }>>
  }
  provider: {
    list(): Promise<IpcResponse<{ profiles: Array<{ id: string; model: string }> }>>
    create(request: Record<string, unknown>): Promise<IpcResponse>
    delete(request: { id: string }): Promise<IpcResponse>
  }
}

type TestWindow = typeof globalThis & { quickask?: TestApi }

interface MockHandle {
  proc: ChildProcess
  port: number
  stdout: string
  stderr: string
  logPath: string
}

const EVIDENCE_DIR = resolve('.omo/evidence')
const DISPLAY = process.env['DISPLAY'] ?? ':0'
const SEED_SCRIPT = resolve('tools/seed-history.mjs')
const MOCK_SCRIPT = resolve('tools/mock-sse-server.mjs')

let app: ElectronApplication | undefined
let page: Page
let tempRoot = ''
let dbPath = ''
let normalMock: MockHandle | undefined
let slowMock: MockHandle | undefined

const evidence: Record<string, unknown> = {}
const pageErrors: string[] = []

function delay(ms: number): Promise<void> {
  return new Promise((resolveDelay) => setTimeout(resolveDelay, ms))
}

function writeJson(name: string, value: unknown): void {
  mkdirSync(EVIDENCE_DIR, { recursive: true })
  writeFileSync(resolve(EVIDENCE_DIR, name), `${JSON.stringify(value, null, 2)}\n`)
}

function baseEnv(root: string): Record<string, string> {
  const env: Record<string, string> = {}
  for (const [key, value] of Object.entries(process.env)) {
    if (value !== undefined) env[key] = value
  }
  return {
    ...env,
    DISPLAY,
    XDG_CONFIG_HOME: join(root, 'config'),
    XDG_DATA_HOME: join(root, 'data'),
    XDG_STATE_HOME: join(root, 'state'),
    QUICKASK_DATA_DIR: root,
    QUICKASK_DISABLE_ONBOARDING: '1'
  }
}

async function startMock(name: string, mode: string, chunks: number, delayMs: number): Promise<MockHandle> {
  const logPath = join(tempRoot, `${name}.log`)
  const handle: MockHandle = {
    proc: spawn(
      process.execPath,
      [
        MOCK_SCRIPT,
        '--port',
        '0',
        '--mode',
        mode,
        '--chunks',
        String(chunks),
        '--delay',
        String(delayMs),
        '--log',
        logPath
      ],
      { stdio: ['ignore', 'pipe', 'pipe'] }
    ),
    port: 0,
    stdout: '',
    stderr: '',
    logPath
  }

  await new Promise<void>((resolveStarted, reject) => {
    const timer = setTimeout(() => reject(new Error(`${name} mock did not start`)), 10_000)
    handle.proc.stdout?.setEncoding('utf8')
    handle.proc.stderr?.setEncoding('utf8')
    handle.proc.stdout?.on('data', (chunk: string) => {
      handle.stdout += chunk
      const found = handle.stdout.match(/listening on http:\/\/([^:\s]+):(\d+)/)
      if (found) {
        handle.port = Number(found[2])
        clearTimeout(timer)
        resolveStarted()
      }
    })
    handle.proc.stderr?.on('data', (chunk: string) => {
      handle.stderr += chunk
    })
    handle.proc.once('exit', (code) => {
      if (handle.port === 0) {
        clearTimeout(timer)
        reject(new Error(`${name} mock exited early: ${code ?? 'signal'}`))
      }
    })
  })
  return handle
}

async function stopMock(handle: MockHandle | undefined): Promise<void> {
  if (!handle || handle.proc.exitCode !== null) return
  const exited = new Promise<void>((resolveExit) => {
    handle.proc.once('exit', () => resolveExit())
  })
  handle.proc.kill('SIGTERM')
  await Promise.race([exited, delay(2000)])
  if (handle.proc.exitCode === null) handle.proc.kill('SIGKILL')
}

async function launchApp(): Promise<void> {
  app = await electron.launch({ args: ['.'], env: baseEnv(tempRoot) })
  page = await app.firstWindow()
  page.on('pageerror', (error) => pageErrors.push(error.message))
  await page.waitForLoadState('domcontentloaded')
  await page.waitForFunction(() => Boolean((window as unknown as TestWindow).quickask))
  const shown = await page.evaluate(() =>
    (window as unknown as TestWindow).quickask!.window.show()
  )
  expect(shown.ok).toBe(true)
  await page.waitForFunction(
    () =>
      document.querySelector('[data-testid="app-root"]')?.getAttribute('data-ui-mode') !==
      'S0'
  )
  await app.evaluate(({ BrowserWindow }) => {
    const window = BrowserWindow.getAllWindows()[0]
    window?.focus()
    window?.webContents.setBackgroundThrottling(false)
  })
}

async function waitMode(mode: string): Promise<void> {
  await page.waitForFunction(
    (expected) =>
      document.querySelector('[data-testid="app-root"]')?.getAttribute('data-ui-mode') ===
      expected,
    mode
  )
}

async function setMode(mode: string): Promise<void> {
  await page.bringToFront()
  const result = await page.evaluate(
    (next) => (window as unknown as TestWindow).quickask!.window.setMode(next),
    mode
  )
  expect(result.ok).toBe(true)
  await waitMode(mode)
}

async function setProvider(baseUrl: string): Promise<void> {
  const created = await page.evaluate(async ({ url }) => {
    const api = (window as unknown as TestWindow).quickask!
    const existing = await api.provider.list()
    for (const profile of existing.data?.profiles ?? []) {
      await api.provider.delete({ id: profile.id })
    }
    return api.provider.create({
      name: 'session-mock',
      baseUrl: url,
      model: 'mock',
      isDefault: true
    })
  }, { url: baseUrl })
  expect(created.ok).toBe(true)
}

async function sessionState(): Promise<SessionStateLike> {
  const result = await page.evaluate(() =>
    (window as unknown as TestWindow).quickask!.sessions.state()
  )
  expect(result.ok).toBe(true)
  return result.data as SessionStateLike
}

async function listSessions(): Promise<SessionSummaryLike[]> {
  const result = await page.evaluate(() =>
    (window as unknown as TestWindow).quickask!.sessions.list({ limit: 1000 })
  )
  expect(result.ok).toBe(true)
  return result.data?.sessions ?? []
}

async function openSession(id: string): Promise<SessionOpenLike> {
  const result = await page.evaluate(
    async (sessionId) =>
      (window as unknown as TestWindow).quickask!.sessions.open({ id: sessionId }),
    id
  )
  expect(result.ok).toBe(true)
  return result.data as SessionOpenLike
}

async function sendAndWait(text: string): Promise<{ requestId: string; sessionId: string }> {
  const result = await page.evaluate(
    async (value) =>
      (window as unknown as TestWindow).quickask!.chat.send({ sessionId: null, text: value }),
    text
  )
  expect(result.ok).toBe(true)
  const started = result.data!
  await page.waitForFunction(async (sessionId) => {
    const api = (window as unknown as TestWindow).quickask!
    const active = await api.chat.getActive()
    if (active.data?.active) return false
    const messages = await api.sessions.getMessages({ sessionId })
    const last = messages.data?.messages[messages.data.messages.length - 1]
    return Boolean(last) && last?.status !== 'streaming'
  }, started.sessionId)
  return started
}

async function clickHistoryRow(id: string): Promise<void> {
  const row = page.locator(`[data-session-id="${id}"] .qa-session-main`)
  await expect(row).toBeVisible()
  await row.click()
  await waitMode('S2')
}

function readDb<T>(fn: (db: DatabaseSync) => T): T {
  const db = new DatabaseSync(dbPath, { readOnly: true })
  try {
    return fn(db)
  } finally {
    db.close()
  }
}

function mostRecentSessionId(): string {
  return readDb((db) => {
    const row = db
      .prepare('SELECT id FROM sessions ORDER BY updated_at DESC, created_at DESC LIMIT 1')
      .get() as { id: string }
    return row.id
  })
}

function sessionCount(): number {
  return readDb((db) => {
    const row = db.prepare('SELECT COUNT(*) AS count FROM sessions').get() as { count: number }
    return Number(row.count)
  })
}

function messageStatuses(id: string): string[] {
  return readDb((db) => {
    const rows = db
      .prepare('SELECT status FROM messages WHERE session_id = ? ORDER BY seq ASC')
      .all(id) as Array<{ status: string }>
    return rows.map((row) => row.status)
  })
}

test.describe.configure({ mode: 'serial' })

test.beforeAll(async () => {
  tempRoot = mkdtempSync(join(tmpdir(), 'quickask-task21-e2e-'))
  for (const dir of ['config', 'data', 'state']) {
    mkdirSync(join(tempRoot, dir), { recursive: true })
  }
  dbPath = join(tempRoot, 'quickask.db')
  mkdirSync(EVIDENCE_DIR, { recursive: true })

  const seedOut = execFileSync(
    process.execPath,
    [SEED_SCRIPT, '--sessions', '8', '--messages', '2', '--fts', '--db', dbPath],
    { encoding: 'utf8' }
  )
  writeFileSync(resolve(EVIDENCE_DIR, 'task-21-seed.log'), seedOut)
  expect(seedOut).toContain('seeded 8 sessions / 16 messages')

  normalMock = await startMock('normal', 'normal', 1, 0)
  slowMock = await startMock('slow', 'slow', 100, 100)

  await launchApp()
  await setProvider(`http://127.0.0.1:${normalMock.port}/v1`)
})

test.afterAll(async () => {
  writeJson('task-21-e2e-summary.json', {
    ...evidence,
    pageErrors,
    normalMock: normalMock?.stderr ?? '',
    slowMock: slowMock?.stderr ?? ''
  })
  await app?.close()
  await stopMock(normalMock)
  await stopMock(slowMock)
})

test('startup, history open -> S2, new -> S1 without creating empty rows', async () => {
  const startup = await sessionState()
  const recent = mostRecentSessionId()
  expect(startup.currentSessionId).toBe(recent)
  expect(startup.mode).toBe('S1')
  expect(startup.messages.length).toBeGreaterThan(0)

  const sessions = await listSessions()
  expect(sessions[0]?.id).toBe(recent)
  const target = sessions.find((session) => session.id !== recent)
  expect(target).toBeDefined()

  await setMode('S3')
  await expect(page.locator('[data-testid="history-item"]').first()).toBeVisible()
  await clickHistoryRow(target!.id)
  const opened = await sessionState()
  expect(opened.currentSessionId).toBe(target!.id)
  expect(opened.mode).toBe('S2')
  expect(opened.messages.length).toBeGreaterThan(0)
  await expect(page.locator('.qa-msg').first()).toBeVisible()
  await page.screenshot({ path: resolve(EVIDENCE_DIR, 'task-21-open.png') })

  const before = sessionCount()
  await setMode('S3')
  await page.locator('[data-testid="sidebar-btn-new"]').click()
  await waitMode('S1')
  await expect(page.locator('[data-testid="composer"]')).toBeFocused()
  const cleared = await sessionState()
  expect(cleared.currentSessionId).toBeNull()
  expect(cleared.mode).toBe('S1')
  expect(cleared.messages).toEqual([])
  expect(sessionCount()).toBe(before)

  writeJson('task-21-startup-open-new.json', {
    startup: {
      currentSessionId: startup.currentSessionId,
      mode: startup.mode,
      messages: startup.messages.length
    },
    mostRecentDb: recent,
    opened: {
      id: target!.id,
      mode: opened.mode,
      messages: opened.messages.length,
      rendered: await page.locator('.qa-msg').count()
    },
    new: {
      before,
      after: sessionCount(),
      state: cleared
    }
  })
})

test('a later user S3 is not reverted by the send flow (window mode single owner)', async () => {
  await page.locator('[data-testid="composer"]').fill('mode-race-question')
  await page.evaluate(async () => {
    const send = document.querySelector('[data-testid="btn-send"]') as HTMLButtonElement
    send.click()
    await (window as unknown as TestWindow).quickask!.window.setMode('S3')
  })
  await waitMode('S3')

  const samples = await page.evaluate(async () => {
    const seen: string[] = []
    const started = performance.now()
    while (performance.now() - started < 1200) {
      seen.push(
        document.querySelector('[data-testid="app-root"]')?.getAttribute('data-ui-mode') ?? ''
      )
      await new Promise((resolveTick) => setTimeout(resolveTick, 50))
    }
    return seen
  })
  expect(samples.every((mode) => mode === 'S3')).toBe(true)

  await page.waitForFunction(async () => {
    const api = (window as unknown as TestWindow).quickask!
    const state = await api.sessions.state()
    if (state.data?.activeRequestId) return false
    const rows = state.data?.messages ?? []
    const sent = rows.some(
      (row) => row.role === 'user' && row.content === 'mode-race-question'
    )
    const last = rows[rows.length - 1]
    return sent && last?.role === 'assistant' && last.status !== 'streaming'
  })
  const finalMode = await page.evaluate(
    () =>
      document.querySelector('[data-testid="app-root"]')?.getAttribute('data-ui-mode') ?? ''
  )
  expect(finalMode).toBe('S3')

  writeJson('task-21-mode-race.json', {
    observedModes: [...new Set(samples)],
    sampleCount: samples.length,
    durationMs: 1200,
    finalMode,
    note: 'send must not issue a post-IPC window:set-mode override'
  })
})

test('switching while A streams stops A with content, B send works, no A content changes', async () => {
  await setProvider(`http://127.0.0.1:${slowMock!.port}/v1`)
  const sessions = await listSessions()
  const b = sessions[0]!
  const a = sessions[1]!
  await openSession(a.id)
  await setMode('S2')

  await page.locator('[data-testid="composer"]').fill('A-slow-question')
  await page.locator('[data-testid="btn-send"]').click()
  await waitMode('S2')
  await page.waitForFunction(async () => {
    const state = await (window as unknown as TestWindow).quickask!.sessions.state()
    return Boolean(state.data?.activeRequestId)
  })
  const active = await sessionState()
  expect(active.activeRequestId).not.toBeNull()
  expect(active.currentSessionId).toBe(a.id)

  await setMode('S3')
  await expect(
    page.locator(`[data-session-id="${a.id}"]`)
  ).toHaveAttribute('data-current', 'true')
  await clickHistoryRow(b.id)

  const afterSwitch = await sessionState()
  expect(afterSwitch.currentSessionId).toBe(b.id)
  expect(afterSwitch.mode).toBe('S2')
  expect(afterSwitch.activeRequestId).toBeNull()

  const aAssistantAtSwitch = await page.evaluate(
    async (sessionId) => {
      const result = await (window as unknown as TestWindow).quickask!.sessions.getMessages({
        sessionId
      })
      const rows = result.data?.messages ?? []
      const assistant = [...rows].reverse().find((row) => row.role === 'assistant')
      return { content: assistant?.content ?? '', status: assistant?.status ?? '' }
    },
    a.id
  )
  expect(aAssistantAtSwitch.status).toBe('stopped')
  expect(aAssistantAtSwitch.content.length).toBeGreaterThan(0)
  await delay(400)
  const aAssistantAfter = await page.evaluate(
    async (sessionId) => {
      const result = await (window as unknown as TestWindow).quickask!.sessions.getMessages({
        sessionId
      })
      const rows = result.data?.messages ?? []
      const assistant = [...rows].reverse().find((row) => row.role === 'assistant')
      return { content: assistant?.content ?? '', status: assistant?.status ?? '' }
    },
    a.id
  )
  expect(aAssistantAfter.content).toBe(aAssistantAtSwitch.content)
  expect(messageStatuses(a.id)).toContain('stopped')

  await setProvider(`http://127.0.0.1:${normalMock!.port}/v1`)
  await page.locator('[data-testid="composer"]').fill('B-question')
  await page.locator('[data-testid="btn-send"]').click()
  await page.waitForFunction(async (sessionId) => {
    const api = (window as unknown as TestWindow).quickask!
    const active = await api.chat.getActive()
    if (active.data?.active) return false
    const messages = await api.sessions.getMessages({ sessionId })
    const rows = messages.data?.messages ?? []
    const sent = rows.some((row) => row.role === 'user' && row.content === 'B-question')
    const last = rows[rows.length - 1]
    return sent && last?.role === 'assistant' && last.status === 'complete'
  }, b.id)
  const stateAfterB = await sessionState()
  expect(stateAfterB.currentSessionId).toBe(b.id)
  const bMessages = await page.evaluate(
    async (sessionId) =>
      (window as unknown as TestWindow).quickask!.sessions.getMessages({ sessionId }),
    b.id
  )
  expect(bMessages.ok).toBe(true)
  expect(
    bMessages.data?.messages.some((row) => row.content === 'B-question'),
    JSON.stringify(bMessages)
  ).toBe(true)
  expect(
    bMessages.data?.messages.some((row) => row.content === 'A-slow-question')
  ).toBe(false)

  writeJson('task-21-e2e-switch-stream.json', {
    a: { id: a.id, ...aAssistantAtSwitch, afterWait: aAssistantAfter },
    b: { id: b.id, user: 'B-question', statuses: messageStatuses(b.id) },
    switchedState: afterSwitch,
    slowLogTail: readFileSync(slowMock!.logPath, 'utf8').trim().split('\n').slice(-4)
  })
  await page.screenshot({ path: resolve(EVIDENCE_DIR, 'task-21-switch-stream.png') })
})

test('deleting the current session via the sidebar confirm returns to S1', async () => {
  const sessions = await listSessions()
  const target = sessions[0]!
  const before = sessionCount()
  await openSession(target.id)
  await setMode('S3')
  const current = page.locator('.qa-session-item--current')
  await expect(current).toHaveCount(1)
  await current.scrollIntoViewIfNeeded()
  await current.hover()
  await current.locator('.qa-session-more').click({ force: true })
  await page.locator('[data-testid="history-menu"]').getByText('删除', { exact: true }).click()
  await page.locator('[data-testid="delete-confirm-button"]').click()
  await waitMode('S1')
  await expect(page.locator('[data-testid="composer"]')).toBeFocused()

  const state = await sessionState()
  expect(state.currentSessionId).toBeNull()
  expect(state.mode).toBe('S1')
  expect(state.messages).toEqual([])
  const active = await page.evaluate(() =>
    (window as unknown as TestWindow).quickask!.chat.getActive()
  )
  expect(active.data?.active ?? null).toBeNull()
  const gone = await page.evaluate(
    async (sessionId) =>
      (window as unknown as TestWindow).quickask!.sessions.getMessages({ sessionId }),
    target.id
  )
  expect(gone.ok).toBe(false)
  expect(gone.error?.code).toBe('NOT_FOUND')
  expect(sessionCount()).toBe(before - 1)

  writeJson('task-21-e2e-delete.json', {
    id: target.id,
    sessionsBefore: before,
    sessionsAfter: sessionCount(),
    state,
    active: null,
    getMessagesError: gone.error?.code,
    mode: 'S1',
    composerFocused: true
  })
  await page.screenshot({ path: resolve(EVIDENCE_DIR, 'task-21-delete.png') })
})

test('20 A/B switches over real IPC keep message rows isolated', async () => {
  const sessions = await listSessions()
  const a = sessions[0]!
  const b = sessions[1]!
  const beforeA = await page.evaluate(
    async (sessionId) =>
      (await (window as unknown as TestWindow).quickask!.sessions.getMessages({ sessionId }))
        .data?.messages.length ?? 0,
    a.id
  )
  const beforeB = await page.evaluate(
    async (sessionId) =>
      (await (window as unknown as TestWindow).quickask!.sessions.getMessages({ sessionId }))
        .data?.messages.length ?? 0,
    b.id
  )

  for (let turn = 0; turn < 20; turn += 1) {
    const target = turn % 2 === 0 ? { id: a.id, tag: 'A' } : { id: b.id, tag: 'B' }
    await openSession(target.id)
    const started = await sendAndWait(`${target.tag}-e2e-turn-${turn}`)
    expect(started.sessionId).toBe(target.id)
    const state = await sessionState()
    expect(state.currentSessionId).toBe(target.id)
  }

  const rowsOf = async (id: string): Promise<ChatMessageLike[]> => {
    const result = await page.evaluate(
      async (sessionId) =>
        (window as unknown as TestWindow).quickask!.sessions.getMessages({ sessionId }),
      id
    )
    return result.data?.messages ?? []
  }
  const aRows = await rowsOf(a.id)
  const bRows = await rowsOf(b.id)
  const aUsers = aRows.filter((row) => row.role === 'user')
  const bUsers = bRows.filter((row) => row.role === 'user')
  const aTurns = aUsers.filter((row) => row.content.includes('-e2e-turn-'))
  const bTurns = bUsers.filter((row) => row.content.includes('-e2e-turn-'))
  expect(aRows.length).toBe(beforeA + 20)
  expect(bRows.length).toBe(beforeB + 20)
  expect(aTurns).toHaveLength(10)
  expect(bTurns).toHaveLength(10)
  expect(aTurns.every((row) => row.content.startsWith('A-'))).toBe(true)
  expect(bTurns.every((row) => row.content.startsWith('B-'))).toBe(true)
  expect(aUsers.some((row) => row.content.startsWith('B-'))).toBe(false)
  expect(bUsers.some((row) => row.content.startsWith('A-'))).toBe(false)

  writeJson('task-21-e2e-isolation.json', {
    switches: 20,
    sessions: {
      A: { id: a.id, before: beforeA, after: aRows.length, users: aUsers.length },
      B: { id: b.id, before: beforeB, after: bRows.length, users: bUsers.length }
    },
    crossContamination: false,
    lastState: await sessionState()
  })
})

test('restart picks the most recent session in S1 and opens it', async () => {
  const recent = mostRecentSessionId()
  await app?.close()
  app = undefined

  await launchApp()
  const state = await sessionState()
  expect(state.currentSessionId).toBe(recent)
  expect(state.mode).toBe('S1')
  const opened = await openSession(recent)
  expect(opened.session.id).toBe(recent)
  expect(opened.messages.length).toBeGreaterThan(0)

  const sessions = await listSessions()
  expect(sessions[0]?.id).toBe(recent)

  writeJson('task-21-e2e-restart.json', {
    mostRecentDb: recent,
    currentAfterRestart: state.currentSessionId,
    modeAfterRestart: state.mode,
    messagesHydrated: state.messages.length,
    openedMessages: opened.messages.length,
    activeFirst: sessions[0]?.id
  })
})
