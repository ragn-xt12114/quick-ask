import { _electron as electron, expect, test } from '@playwright/test'
import type { ElectronApplication, Page } from '@playwright/test'
import { execFileSync, spawn, type ChildProcess } from 'node:child_process'
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  statSync,
  writeFileSync
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { DatabaseSync } from 'node:sqlite'

interface IpcResponse<T = unknown> {
  ok: boolean
  data?: T
  error?: { code: string; message: string }
}

interface ChatMessageLike {
  id: string
  sessionId: string
  seq: number
  role: string
  content: string
  status: string
  errorCode: string | null
}

interface SessionStateLike {
  currentSessionId: string | null
  mode: string
  activeRequestId: string | null
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
      IpcResponse<{
        active: {
          requestId: string
          sessionId: string
          messageId: string
          content: string
        } | null
      }>
    >
  }
  sessions: {
    state(): Promise<IpcResponse<SessionStateLike>>
    new(): Promise<IpcResponse<{ currentSessionId: string | null; mode: 'S1' }>>
    open(request: { id: string }): Promise<IpcResponse<{ session: { id: string }; messages: ChatMessageLike[] }>>
    list(request?: {
      query?: string
      limit?: number
    }): Promise<IpcResponse<{ sessions: Array<{ id: string; title: string }> }>>
    getMessages(request: { sessionId: string }): Promise<IpcResponse<{ messages: ChatMessageLike[] }>>
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
  logPath: string
  stdout: string
  stderr: string
}

interface ExitResult {
  code: number | null
  signal: string | null
}

const EVIDENCE_DIR = resolve('.omo/evidence')
const DISPLAY = process.env['DISPLAY'] ?? ':0'
const MOCK_SCRIPT = resolve('tools/mock-sse-server.mjs')
const SEED_SCRIPT = resolve('tools/seed-history.mjs')

let app: ElectronApplication | undefined
let page: Page | undefined
let tempRoot = ''
let dbPath = ''
let mock: MockHandle | undefined
let logs = ''
let kill9Evidence: Record<string, unknown> = {}
let rendererEvidence: Record<string, unknown> = {}
let quitEvidence: Record<string, unknown> = {}
let readonlyEvidence: Record<string, unknown> = {}
let readonlyPermissionsRestored = false
let pageErrors: string[] = []

function delay(ms: number): Promise<void> {
  return new Promise((done) => setTimeout(done, ms))
}

function writeJson(name: string, value: unknown): void {
  mkdirSync(EVIDENCE_DIR, { recursive: true })
  writeFileSync(resolve(EVIDENCE_DIR, name), `${JSON.stringify(value, null, 2)}\n`)
}

function writeText(name: string, value: string): void {
  mkdirSync(EVIDENCE_DIR, { recursive: true })
  writeFileSync(resolve(EVIDENCE_DIR, name), value)
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

function prepareRoot(prefix: string): string {
  const root = mkdtempSync(join(tmpdir(), prefix))
  for (const dir of ['config', 'data', 'state']) {
    mkdirSync(join(root, dir), { recursive: true })
  }
  return root
}

async function startMock(chunks: number, delayMs: number): Promise<MockHandle> {
  const logPath = join(tempRoot, 'mock-slow.log')
  const handle: MockHandle = {
    proc: spawn(
      process.execPath,
      [
        MOCK_SCRIPT,
        '--port',
        '0',
        '--mode',
        'slow',
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
    logPath,
    stdout: '',
    stderr: ''
  }
  await new Promise<void>((resolveStarted, reject) => {
    const timer = setTimeout(() => reject(new Error('mock did not start')), 10_000)
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
        reject(new Error(`mock exited early: ${code ?? 'signal'}`))
      }
    })
  })
  return handle
}

async function stopMock(handle: MockHandle | undefined): Promise<void> {
  if (!handle || handle.proc.exitCode !== null) return
  const exited = new Promise<void>((resolveExit) => handle.proc.once('exit', () => resolveExit()))
  handle.proc.kill('SIGTERM')
  await Promise.race([exited, delay(2000)])
  if (handle.proc.exitCode === null) handle.proc.kill('SIGKILL')
}

async function launchApp(root: string): Promise<void> {
  logs = ''
  app = await electron.launch({ args: ['.'], env: baseEnv(root) })
  const child = app.process()
  child.stdout?.setEncoding('utf8')
  child.stderr?.setEncoding('utf8')
  child.stdout?.on('data', (chunk: string) => {
    logs += chunk
  })
  child.stderr?.on('data', (chunk: string) => {
    logs += chunk
  })

  page = await app.firstWindow()
  pageErrors = []
  page.on('pageerror', (error) => pageErrors.push(error.message))
  await page.waitForLoadState('domcontentloaded')
  await page.waitForFunction(() => Boolean((window as unknown as TestWindow).quickask))
}

async function showAndReady(target: Page = currentPage()): Promise<void> {
  await target.waitForFunction(() => Boolean((window as unknown as TestWindow).quickask))
  const mode = await target.evaluate(
    () =>
      document.querySelector('[data-testid="app-root"]')?.getAttribute('data-ui-mode') ?? ''
  )
  if (mode === 'S0' || mode === '') {
    const shown = await target.evaluate(() =>
      (window as unknown as TestWindow).quickask!.window.show()
    )
    expect(shown.ok).toBe(true)
  }
  await target.waitForFunction(
    () =>
      document.querySelector('[data-testid="app-root"]')?.getAttribute('data-ui-mode') !==
      'S0'
  )
}

function currentPage(): Page {
  if (!page) throw new Error('page is not available')
  return page
}

async function waitMode(mode: string): Promise<void> {
  await currentPage().waitForFunction(
    (expected) =>
      document.querySelector('[data-testid="app-root"]')?.getAttribute('data-ui-mode') ===
      expected,
    mode
  )
}

async function setProvider(baseUrl: string): Promise<void> {
  const target = currentPage()
  const created = await target.evaluate(async ({ url }) => {
    const api = (window as unknown as TestWindow).quickask!
    const existing = await api.provider.list()
    for (const profile of existing.data?.profiles ?? []) {
      await api.provider.delete({ id: profile.id })
    }
    return api.provider.create({
      name: 'crash-mock',
      baseUrl: url,
      model: 'mock',
      isDefault: true
    })
  }, { url: baseUrl })
  expect(created.ok).toBe(true)
}

function readDbAt<T>(path: string, fn: (db: DatabaseSync) => T): T {
  const db = new DatabaseSync(path, { readOnly: true })
  try {
    return fn(db)
  } finally {
    db.close()
  }
}

function readDb<T>(fn: (db: DatabaseSync) => T): T {
  return readDbAt(dbPath, fn)
}

function rowsOf(sessionId: string): ChatMessageLike[] {
  try {
    return readDb((db) => {
      const rows = db
        .prepare(
          'SELECT id, session_id, seq, role, content, status, error_code FROM messages WHERE session_id = ? ORDER BY seq ASC'
        )
        .all(sessionId) as Array<Record<string, unknown>>
      return rows.map((row) => ({
        id: String(row.id),
        sessionId: String(row.session_id),
        seq: Number(row.seq),
        role: String(row.role),
        content: String(row.content),
        status: String(row.status),
        errorCode: row.error_code === null ? null : String(row.error_code)
      }))
    })
  } catch {
    return []
  }
}

function assistantChars(sessionId: string): number {
  const assistant = [...rowsOf(sessionId)].reverse().find((row) => row.role === 'assistant')
  return assistant?.content.length ?? 0
}

function globalStreamingCount(): number {
  try {
    return readDb((db) => {
      const row = db.prepare("SELECT COUNT(*) AS count FROM messages WHERE status = 'streaming'").get() as {
        count: number
      }
      return Number(row.count)
    })
  } catch {
    return -1
  }
}

function countPosts(): number {
  try {
    return (readFileSync(mock!.logPath, 'utf8').match(/^POST \/v1\/chat\/completions/gm) ?? [])
      .length
  } catch {
    return 0
  }
}

function waitForExit(child: ChildProcess, timeoutMs: number): Promise<ExitResult> {
  if (child.exitCode !== null) {
    return Promise.resolve({ code: child.exitCode, signal: child.signalCode })
  }
  return new Promise<ExitResult>((resolveExit, reject) => {
    const timer = setTimeout(
      () => reject(new Error(`process did not exit within ${timeoutMs}ms`)),
      timeoutMs
    )
    child.once('exit', (code, signal) => {
      clearTimeout(timer)
      resolveExit({ code, signal })
    })
  })
}


async function newSession(): Promise<void> {
  const result = await rendererEval<IpcResponse<{ currentSessionId: string | null; mode: string }>>(
    '(async () => window.quickask.sessions.new())()'
  )
  expect(result.ok).toBe(true)
}

async function sendSlow(text: string): Promise<{ sessionId: string; requestId: string }> {
  const payload = JSON.stringify({ sessionId: null, text })
  const result = await rendererEval<IpcResponse<{ requestId: string; sessionId: string }>>(
    `(async () => window.quickask.chat.send(${payload}))()`
  )
  expect(result.ok).toBe(true)
  return result.data as { sessionId: string; requestId: string }
}

async function rendererEval<T = unknown>(expression: string): Promise<T> {
  if (!app) throw new Error('app is not available')
  const result = await app.evaluate(async ({ BrowserWindow }, source) => {
    const windows = BrowserWindow.getAllWindows()
    const main =
      windows.find((window) => !window.webContents.getURL().includes('settings=1')) ??
      windows[0]
    if (!main) throw new Error('main window is not available')
    return main.webContents.executeJavaScript(source, true)
  }, expression)
  return result as T
}

async function waitForReloadedRenderer(timeoutMs = 15_000): Promise<void> {
  if (!app) throw new Error('app is not available')
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    try {
      const state = await app.evaluate(async ({ BrowserWindow }) => {
        const windows = BrowserWindow.getAllWindows()
        const main =
          windows.find((window) => !window.webContents.getURL().includes('settings=1')) ??
          windows[0]
        if (!main || main.isDestroyed()) return { ready: false, crashed: true }
        if (main.webContents.isCrashed()) return { ready: false, crashed: true }
        try {
          const hasApi = Boolean(
            await main.webContents.executeJavaScript('Boolean(window.quickask)')
          )
          return { ready: hasApi, crashed: false }
        } catch {
          return { ready: false, crashed: false }
        }
      })
      if (state.ready) return
    } catch {
      // renderer target still restarting
    }
    await delay(150)
  }
  throw new Error('renderer did not reload in time')
}

async function captureRendererPng(name: string): Promise<void> {
  if (!app) throw new Error('app is not available')
  const base64 = await app.evaluate(async ({ BrowserWindow }) => {
    const windows = BrowserWindow.getAllWindows()
    const main =
      windows.find((window) => !window.webContents.getURL().includes('settings=1')) ??
      windows[0]
    if (!main) throw new Error('main window is not available')
    const image = await main.webContents.capturePage()
    return image.toPNG().toString('base64')
  })
  writeFileSync(resolve(EVIDENCE_DIR, name), Buffer.from(base64, 'base64'))
}

function lifecycleLines(value: string): string[] {
  return value.split('\n').filter((line) => line.includes('[lifecycle]'))
}

test.describe.configure({ mode: 'serial' })

test.describe('crash recovery: kill -9, renderer crash, quit flush', () => {
  test.beforeAll(async () => {
    tempRoot = prepareRoot('quickask-task26-')
    dbPath = join(tempRoot, 'quickask.db')
    mock = await startMock(90, 100)
    await launchApp(tempRoot)
    await showAndReady()
    await setProvider(`http://127.0.0.1:${mock.port}/v1`)
  })

  test.afterAll(async () => {
    if (app) {
      try {
        await Promise.race([app.close(), delay(3000)])
      } catch {
        // already gone
      }
    }
    await stopMock(mock)
  })

  test('kill -9 main during a slow stream: restart restores interrupted content + retry, no duplicate', async () => {
    await showAndReady()
    await newSession()
    const userText =
      '这是一段用于验证崩溃恢复重建全文索引的用户消息 UNIQUEKILL9BODY'
    const started = await sendSlow(userText)

    await expect
      .poll(() => assistantChars(started.sessionId), { timeout: 15_000, intervals: [100] })
      .toBeGreaterThan(0)
    const contentBeforeKill = rowsOf(started.sessionId).find(
      (row) => row.role === 'assistant'
    )?.content
    expect(contentBeforeKill?.length).toBeGreaterThan(0)

    const pid = app!.process().pid
    expect(pid).toBeGreaterThan(0)
    const killAt = Date.now()
    process.kill(pid!, 'SIGKILL')
    const exit = await waitForExit(app!.process(), 5000)
    const elapsedKillMs = Date.now() - killAt
    const logsBeforeRestart = logs
    app = undefined
    page = undefined
    expect(exit.signal).toBe('SIGKILL')
    const streamingBeforeRestart = globalStreamingCount()

    await delay(300)
    const restartAt = Date.now()
    await launchApp(tempRoot)
    await showAndReady()
    const restartMs = Date.now() - restartAt

    const opened = await currentPage().evaluate(
      async (sessionId) =>
        (window as unknown as TestWindow).quickask!.sessions.open({ id: sessionId }),
      started.sessionId
    )
    expect(opened.ok).toBe(true)
    await waitMode('S2')

    const rowsAfter = rowsOf(started.sessionId)
    const assistantRow = rowsAfter.find((row) => row.role === 'assistant')
    expect(assistantRow?.status).toBe('interrupted')
    expect(assistantRow?.content.length).toBeGreaterThan(0)
    expect(assistantRow?.content.startsWith(contentBeforeKill ?? '')).toBe(true)
    expect(rowsAfter.filter((row) => row.role === 'assistant')).toHaveLength(1)
    expect(rowsAfter.filter((row) => row.role === 'user')).toHaveLength(1)
    expect(globalStreamingCount()).toBe(0)

    const fts = await currentPage().evaluate(async () =>
      (window as unknown as TestWindow).quickask!.sessions.list({
        query: 'UNIQUEKILL9BODY',
        limit: 20
      })
    )
    expect(fts.ok).toBe(true)
    expect(fts.data!.sessions.map((session) => session.id)).toContain(started.sessionId)

    const assistantLocator = currentPage().locator('[data-testid="assistant-message"]')
    await expect(assistantLocator).toHaveCount(1)
    await expect(assistantLocator).toHaveAttribute('data-status', 'interrupted')
    await expect(currentPage().locator('[data-testid="msg-status"]')).toContainText('已中断')
    await expect(currentPage().locator('[data-testid="btn-retry"]')).toBeVisible()
    await expect(currentPage().locator('[data-testid="panel-error"]')).toContainText(
      '生成已中断'
    )
    const rendered = (await assistantLocator.textContent()) ?? ''
    expect(rendered.length).toBeGreaterThan(0)
    await currentPage().screenshot({ path: resolve(EVIDENCE_DIR, 'task-26-kill9.png') })

    kill9Evidence = {
      pid,
      signal: 'SIGKILL',
      killElapsedMs: elapsedKillMs,
      exit: { code: exit.code, signal: exit.signal },
      restartMs,
      sessionId: started.sessionId,
      userText,
      assistantStatus: assistantRow?.status,
      assistantContentChars: assistantRow?.content.length ?? 0,
      contentPreservedPrefix: assistantRow?.content.startsWith(contentBeforeKill ?? '') ?? false,
      assistantRows: rowsAfter.filter((row) => row.role === 'assistant').length,
      userRows: rowsAfter.filter((row) => row.role === 'user').length,
      duplicateAssistant: false,
      streamingRowsBeforeRestart: streamingBeforeRestart,
      streamingRowsAfterRestart: globalStreamingCount(),
      ftsQuery: 'UNIQUEKILL9BODY',
      ftsMatchedAfterRecovery: true,
      ui: {
        status: await assistantLocator.getAttribute('data-status'),
        statusLabel: await currentPage().locator('[data-testid="msg-status"]').textContent(),
        retryVisible: await currentPage().locator('[data-testid="btn-retry"]').isVisible(),
        panelError: await currentPage().locator('[data-testid="panel-error"]').textContent(),
        renderedChars: rendered.length
      },
      lifecycleLog: lifecycleLines(logsBeforeRestart).slice(-20),
      recoveryLog: logs.split('\n').filter((line) => line.includes('recovered')).slice(-10),
      screenshot: 'task-26-kill9.png'
    }
    writeJson('task-26-kill9.json', kill9Evidence)
    writeText(
      'task-26-kill9.log',
      [
        `DISPLAY=${DISPLAY}`,
        `pid=${pid}`,
        `signal=SIGKILL`,
        `exit=${JSON.stringify(exit)}`,
        `restart_ms=${restartMs}`,
        '',
        '--- before restart ---',
        ...lifecycleLines(logsBeforeRestart).slice(-30),
        '',
        '--- after restart ---',
        ...logs.split('\n').slice(-80),
        ''
      ].join('\n')
    )
  })

  test('renderer crash: main keeps streaming/persisting, reload rehydrates active content, no duplicate request', async () => {
    await showAndReady()
    await newSession()
    const postsBefore = countPosts()
    const started = await sendSlow('渲染进程崩溃恢复流式请求')
    await expect
      .poll(() => assistantChars(started.sessionId), { timeout: 15_000, intervals: [100] })
      .toBeGreaterThan(0)

    const charsAtCrash = assistantChars(started.sessionId)
    const crashAt = Date.now()
    await app!.evaluate(({ BrowserWindow }) => {
      const windows = BrowserWindow.getAllWindows()
      const main =
        windows.find((window) => !window.webContents.getURL().includes('settings=1')) ??
        windows[0]
      main?.webContents.forcefullyCrashRenderer()
    })

    // Main must keep streaming and persisting while the renderer is gone.
    await delay(1200)
    const charsAfterCrash = assistantChars(started.sessionId)
    expect(charsAfterCrash).toBeGreaterThan(charsAtCrash)

    await waitForReloadedRenderer()
    const reloadMs = Date.now() - crashAt

    const active = await rendererEval<IpcResponse<{
      active: { requestId: string; sessionId: string; messageId: string; content: string } | null
    }>>('(async () => window.quickask.chat.getActive())()')
    expect(active.ok).toBe(true)
    expect(active.data?.active?.sessionId).toBe(started.sessionId)
    expect(active.data?.active?.content.length ?? 0).toBeGreaterThan(0)

    const restoredUi = await rendererEval<{
      assistantCount: number
      status: string | null
      textChars: number
    }>(`(() => {
      const items = document.querySelectorAll('[data-testid="assistant-message"]')
      const item = items[0] ?? null
      return {
        assistantCount: items.length,
        status: item ? item.getAttribute('data-status') : null,
        textChars: item ? (item.textContent ?? '').length : 0
      }
    })()`)
    expect(restoredUi.assistantCount).toBe(1)
    expect(restoredUi.status).toBe('streaming')
    expect(restoredUi.textChars).toBeGreaterThan(0)

    await expect
      .poll(async () => {
        const state = await rendererEval<IpcResponse<SessionStateLike>>(
          '(async () => window.quickask.sessions.state())()'
        )
        const rows = state.data?.messages ?? []
        const assistant = [...rows].reverse().find((row) => row.role === 'assistant')
        return assistant?.status ?? ''
      }, { timeout: 20_000, intervals: [100] })
      .toBe('complete')

    const state = await rendererEval<IpcResponse<SessionStateLike>>(
      '(async () => window.quickask.sessions.state())()'
    )
    expect(state.data?.activeRequestId ?? null).toBeNull()
    const rows = state.data?.messages ?? []
    const assistants = rows.filter((row) => row.role === 'assistant')
    expect(assistants).toHaveLength(1)
    expect(assistants[0]?.status).toBe('complete')
    expect(rows.filter((row) => row.role === 'user')).toHaveLength(1)
    expect(globalStreamingCount()).toBe(0)

    const finalUi = await rendererEval<{
      assistantCount: number
      status: string | null
    }>(`(() => {
      const items = document.querySelectorAll('[data-testid="assistant-message"]')
      const item = items[0] ?? null
      return {
        assistantCount: items.length,
        status: item ? item.getAttribute('data-status') : null
      }
    })()`)
    expect(finalUi.assistantCount).toBe(1)
    expect(finalUi.status).toBe('complete')
    await captureRendererPng('task-26-renderer-crash.png')

    const postsAfter = countPosts()
    expect(postsAfter - postsBefore).toBe(1)
    rendererEvidence = {
      sessionId: started.sessionId,
      crashAt: new Date(crashAt).toISOString(),
      reloadMs,
      charsAtCrash,
      charsAfterCrashWhileRendererDown: charsAfterCrash,
      mainKeptStreaming: charsAfterCrash > charsAtCrash,
      activeAfterReload: {
        present: Boolean(active.data?.active),
        contentChars: active.data?.active?.content.length ?? 0
      },
      restoredUi,
      finalUi,
      finalStatus: assistants[0]?.status,
      assistantRows: assistants.length,
      userRows: rows.filter((row) => row.role === 'user').length,
      streamingRows: globalStreamingCount(),
      mockPostsBefore: postsBefore,
      mockPostsAfter: postsAfter,
      duplicateRequest: postsAfter - postsBefore !== 1,
      requestPostsForThisSend: postsAfter - postsBefore,
      lifecycleLog: lifecycleLines(logs).slice(-20),
      pageErrors,
      screenshot: 'task-26-renderer-crash.png'
    }
    writeJson('task-26-renderer-crash.json', rendererEvidence)
    writeText(
      'task-26-renderer-crash.log',
      [
        `DISPLAY=${DISPLAY}`,
        `reload_ms=${reloadMs}`,
        `chars_at_crash=${charsAtCrash}`,
        `chars_after_crash=${charsAfterCrash}`,
        `mock_posts_before=${postsBefore}`,
        `mock_posts_after=${postsAfter}`,
        '',
        ...lifecycleLines(logs).slice(-40),
        '',
        '--- page errors ---',
        ...pageErrors,
        ''
      ].join('\n')
    )
  })

  test('quit during an active stream exits within 3s, status stopped, content preserved, no streaming rows', async () => {
    await newSession()
    const started = await sendSlow('退出时仍在流式生成的问题')
    await expect
      .poll(() => assistantChars(started.sessionId), { timeout: 15_000, intervals: [100] })
      .toBeGreaterThan(0)
    const contentBeforeQuit = rowsOf(started.sessionId).find(
      (row) => row.role === 'assistant'
    )?.content
    expect(contentBeforeQuit?.length).toBeGreaterThan(0)

    const logsBeforeQuit = logs
    const exitPromise = waitForExit(app!.process(), 5000)
    const quitAt = Date.now()
    try {
      await app!.evaluate(({ app: electronApp }) => electronApp.quit())
    } catch {
      // CDP may drop before the response arrives.
    }
    const exit = await exitPromise
    const quitMs = Date.now() - quitAt
    app = undefined
    page = undefined

    expect(exit.code).toBe(0)
    expect(quitMs).toBeLessThan(3000)

    const rows = rowsOf(started.sessionId)
    const assistant = rows.find((row) => row.role === 'assistant')
    expect(assistant?.status).toBe('stopped')
    expect(assistant?.content.length).toBeGreaterThan(0)
    expect(assistant?.content.startsWith(contentBeforeQuit ?? '')).toBe(true)
    expect(globalStreamingCount()).toBe(0)

    const allLogs = logsBeforeQuit + logs
    expect(allLogs).toContain('[lifecycle] quit requested')
    expect(allLogs).toContain('[lifecycle] db checkpoint')
    expect(allLogs).toContain('[lifecycle] cleanup complete')

    quitEvidence = {
      sessionId: started.sessionId,
      exit: { code: exit.code, signal: exit.signal },
      quitElapsedMs: quitMs,
      budgetMs: 3000,
      assistantStatus: assistant?.status,
      assistantContentChars: assistant?.content.length ?? 0,
      contentPreservedPrefix: assistant?.content.startsWith(contentBeforeQuit ?? '') ?? false,
      streamingRowsAfterExit: globalStreamingCount(),
      lifecycleLog: lifecycleLines(allLogs).slice(-20),
      reopenedDb: true
    }
    writeJson('task-26-quit.json', quitEvidence)
    writeText(
      'task-26-quit.log',
      [
        `DISPLAY=${DISPLAY}`,
        `exit=${JSON.stringify(exit)}`,
        `quit_elapsed_ms=${quitMs}`,
        '',
        ...lifecycleLines(allLogs).slice(-40),
        ''
      ].join('\n')
    )
  })
})

test.describe('read-only database UX', () => {
  let roApp: ElectronApplication | undefined
  let roPage: Page | undefined
  let roRoot = ''
  let roDbPath = ''
  let roLogs = ''
  let originalMode = 0

  test.beforeAll(async () => {
    roRoot = prepareRoot('quickask-task26-readonly-')
    roDbPath = join(roRoot, 'quickask.db')
    execFileSync(
      process.execPath,
      [SEED_SCRIPT, '--sessions', '1', '--messages', '2', '--fts', '--db', roDbPath],
      { encoding: 'utf8' }
    )
    originalMode = statSync(roDbPath).mode & 0o777
    chmodSync(roDbPath, 0o444)

    roApp = await electron.launch({ args: ['.'], env: baseEnv(roRoot) })
    const child = roApp.process()
    child.stdout?.setEncoding('utf8')
    child.stderr?.setEncoding('utf8')
    child.stdout?.on('data', (chunk: string) => {
      roLogs += chunk
    })
    child.stderr?.on('data', (chunk: string) => {
      roLogs += chunk
    })
    roPage = await roApp.firstWindow()
    await roPage.waitForLoadState('domcontentloaded')
    await roPage.waitForFunction(() => Boolean((window as unknown as TestWindow).quickask))
    await roPage.evaluate(() => (window as unknown as TestWindow).quickask!.window.show())
    await roPage.waitForFunction(
      () =>
        document.querySelector('[data-testid="app-root"]')?.getAttribute('data-ui-mode') !==
        'S0'
    )
  })

  test.afterAll(async () => {
    if (roApp) {
      try {
        await Promise.race([roApp.close(), delay(3000)])
      } catch {
        // already gone
      }
    }
    try {
      if (existsSync(roDbPath)) {
        chmodSync(roDbPath, originalMode || 0o600)
        for (const suffix of ['-wal', '-shm']) {
          const related = `${roDbPath}${suffix}`
          if (existsSync(related)) chmodSync(related, 0o600)
        }
        readonlyPermissionsRestored =
          (statSync(roDbPath).mode & 0o777) !== 0o444 &&
          (!existsSync(`${roDbPath}-wal`) ||
            (statSync(`${roDbPath}-wal`).mode & 0o777) !== 0o444) &&
          (!existsSync(`${roDbPath}-shm`) ||
            (statSync(`${roDbPath}-shm`).mode & 0o777) !== 0o444)
      }
    } catch {
      readonlyPermissionsRestored = false
    }
    writeText(
      'task-26-readonly-app.log',
      [roLogs.split('\n').slice(-120).join('\n'), ''].join('\n')
    )
    writeSummary()
  })

  test('chmod 444 DB: app starts, send shows visible typed error, no fake success or crash', async () => {
    expect(roPage).toBeDefined()
    const target = roPage!
    const sessionsBefore = readDbAt(roDbPath, (db) => {
      const row = db.prepare('SELECT COUNT(*) AS count FROM sessions').get() as {
        count: number
      }
      return Number(row.count)
    })

    await target.locator('[data-testid="composer"]').fill('readonly-db-probe')
    await target.locator('[data-testid="btn-send"]').click()
    const notice = target.locator('[data-testid="composer-notice"]')
    await expect(notice).toBeVisible()
    const noticeText = (await notice.textContent()) ?? ''
    expect(noticeText).toContain('本地保存失败')
    await expect(target.locator('[data-testid="composer"]')).toHaveValue(
      'readonly-db-probe'
    )

    const typed = await target.evaluate(() =>
      (window as unknown as TestWindow).quickask!.chat.send({
        sessionId: null,
        text: 'readonly-typed-probe'
      })
    )
    expect(typed.ok).toBe(false)
    expect(['DB_WRITE', 'INTERNAL']).toContain(typed.error?.code ?? '')

    await delay(300)
    const sessionsAfter = readDbAt(roDbPath, (db) => {
      const row = db.prepare('SELECT COUNT(*) AS count FROM sessions').get() as {
        count: number
      }
      return Number(row.count)
    })
    const messagesAfter = readDbAt(roDbPath, (db) => {
      const row = db.prepare('SELECT COUNT(*) AS count FROM messages').get() as {
        count: number
      }
      return Number(row.count)
    })
    expect(sessionsAfter).toBe(sessionsBefore)
    expect(messagesAfter).toBe(2)
    expect(roApp!.process().exitCode).toBeNull()
    await expect(target.locator('[data-testid="assistant-message"]')).toHaveCount(0)

    const modeWhileRunning = statSync(roDbPath).mode & 0o777
    expect(modeWhileRunning).toBe(0o444)
    await target.screenshot({ path: resolve(EVIDENCE_DIR, 'task-26-readonly.png') })

    readonlyEvidence = {
      dbModeWhileRunning: modeWhileRunning.toString(8),
      appStarted: roApp!.process().exitCode === null,
      noticeVisible: true,
      noticeText,
      composerValueRetained: await target.locator('[data-testid="composer"]').inputValue(),
      typedErrorCode: typed.error?.code ?? null,
      typedErrorMessage: typed.error?.message ?? null,
      sessionsBefore,
      sessionsAfter,
      messagesAfter,
      fakeSuccess: false,
      silentLoss: false,
      crash: false,
      assistantRendered: await target.locator('[data-testid="assistant-message"]').count(),
      screenshot: 'task-26-readonly.png'
    }
    writeJson('task-26-readonly.json', readonlyEvidence)
  })
})

function readEvidenceFile(name: string): Record<string, unknown> | null {
  try {
    return JSON.parse(readFileSync(resolve(EVIDENCE_DIR, name), 'utf8')) as Record<
      string,
      unknown
    >
  } catch {
    return null
  }
}

function writeSummary(): void {
  const kill9 = readEvidenceFile('task-26-kill9.json') ?? kill9Evidence
  const renderer = readEvidenceFile('task-26-renderer-crash.json') ?? rendererEvidence
  const quit = readEvidenceFile('task-26-quit.json') ?? quitEvidence
  const readonly = readEvidenceFile('task-26-readonly.json') ?? readonlyEvidence
  const recovery = readEvidenceFile('task-26-recovery.json')
  const integrationQuit = readEvidenceFile('task-26-quit-integration.json')
  const full = readEvidenceFile('task-26-full.json')

  const kill9Checks = {
    interrupted: kill9['assistantStatus'] === 'interrupted',
    contentPreserved: Number(kill9['assistantContentChars'] ?? 0) > 0,
    noDuplicate: kill9['assistantRows'] === 1 && kill9['userRows'] === 1,
    noStreamingRows: kill9['streamingRowsAfterRestart'] === 0,
    ftsRebuilt: kill9['ftsMatchedAfterRecovery'] === true
  }
  const rendererChecks = {
    mainKeptStreaming: renderer['mainKeptStreaming'] === true,
    activeRestored: (renderer['activeAfterReload'] as { present?: boolean } | undefined)?.present === true,
    finalComplete: renderer['finalStatus'] === 'complete',
    noDuplicate: renderer['duplicateRequest'] === false,
    noStreamingRows: renderer['streamingRows'] === 0
  }
  const quitChecks = {
    under3s: Number(quit['quitElapsedMs'] ?? Number.NaN) < 3000,
    exitZero: (quit['exit'] as { code?: number | null } | undefined)?.code === 0,
    stopped: quit['assistantStatus'] === 'stopped',
    contentPreserved: Number(quit['assistantContentChars'] ?? 0) > 0,
    noStreamingRows: quit['streamingRowsAfterExit'] === 0
  }
  const readonlyChecks = {
    appStarted: readonly['appStarted'] === true,
    typedError: ['DB_WRITE', 'INTERNAL'].includes(String(readonly['typedErrorCode'] ?? '')),
    visibleNotice: readonly['noticeVisible'] === true,
    noFakeSuccess: readonly['fakeSuccess'] === false,
    noSilentLoss: readonly['sessionsBefore'] === readonly['sessionsAfter'],
    noCrash: readonly['crash'] === false,
    permissionsRestored: readonlyPermissionsRestored
  }

  const checks = {
    kill9: kill9Checks,
    rendererCrash: rendererChecks,
    quit: quitChecks,
    readonly: readonlyChecks,
    recovery: {
      interrupted: recovery?.['interrupted'] === 1,
      contentPreserved: recovery?.['contentPreserved'] === true,
      noDuplicate: recovery?.['duplicateAssistantMessages'] === 0,
      ftsRebuilt: recovery?.['ftsRebuilt'] === true
    },
    quitIntegration: {
      stopped: integrationQuit?.['status'] === 'stopped',
      under3s: Number(integrationQuit?.['abortMs'] ?? Number.NaN) < 3000,
      noStreamingRows: integrationQuit?.['streamingRows'] === 0
    },
    diskFull: {
      typedSqliteFull: full?.['code'] === 'SQLITE_FULL',
      documentedLimitation: typeof full?.['limitation'] === 'string'
    }
  }

  const flat = Object.values(checks).flatMap((group) =>
    Object.values(group as Record<string, boolean>)
  )
  writeJson('task-26-summary.json', {
    task: 26,
    verdict: flat.every(Boolean) ? 'PASS' : 'FAIL',
    checks,
    evidence: {
      kill9: 'task-26-kill9.json',
      rendererCrash: 'task-26-renderer-crash.json',
      quit: 'task-26-quit.json',
      readonly: 'task-26-readonly.json',
      recovery: 'task-26-recovery.json',
      quitIntegration: 'task-26-quit-integration.json',
      diskFull: 'task-26-full.json',
      logs: [
        'task-26-kill9.log',
        'task-26-renderer-crash.log',
        'task-26-quit.log',
        'task-26-readonly-app.log'
      ],
      screenshots: [
        'task-26-kill9.png',
        'task-26-renderer-crash.png',
        'task-26-readonly.png'
      ]
    },
    generatedAt: new Date().toISOString()
  })
}
