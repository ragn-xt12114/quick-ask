/**
 * Task 24 — focus, Esc layering, auto-hide and settings-window transitions.
 *
 * Real X11 focus/blur only: every blur path activates an xmessage window with
 * xdotool (windowactivate, click fallback) and moves the pointer inside it so
 * the AutoHideController's cursor-inside guard cannot mask the blur.
 *
 * Evidence: .omo/evidence/task-24-{esc,ime-esc,blurhide,settings,focus-return,summary}.*
 */
import { _electron as electron, expect, test } from '@playwright/test'
import type { ElectronApplication, Page } from '@playwright/test'
import { execFileSync, spawn, type ChildProcess } from 'node:child_process'
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
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

interface HotkeyStatusLike {
  registered: boolean
  accelerator: string | null
  primary: string
  conflict: boolean
  tried: Array<{ accelerator: string; ok: boolean; error?: string }>
  alternatives: string[]
}

interface WindowStateLike {
  mode: string
  visible: boolean
  bounds: { x: number; y: number; width: number; height: number }
  layout: {
    barRect: { x: number; y: number; width: number; height: number }
    panelRect: { x: number; y: number; width: number; height: number } | null
    sidebarRect: { x: number; y: number; width: number; height: number } | null
  } | null
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

interface ChatDeltaLike {
  requestId: string
  sessionId: string
  messageId: string
  delta: string
}

interface ChatEndLike {
  requestId: string
  sessionId: string
  messageId: string
  status: string
  errorCode: string | null
  errorDetail: string | null
}

interface WindowApi {
  show(): Promise<IpcResponse<WindowStateLike>>
  hide(): Promise<IpcResponse<WindowStateLike>>
  getState(): Promise<IpcResponse<WindowStateLike>>
  setMode(mode: string): Promise<IpcResponse<{ mode: string }>>
  openSettings(options?: { onboarding?: boolean }): Promise<IpcResponse<{ open: boolean }>>
  closeSettings(): Promise<IpcResponse<{ open: boolean }>>
}

interface TestApi {
  app: {
    bootstrap(): Promise<
      IpcResponse<{ hotkey: HotkeyStatusLike; onboarding: { required: boolean } }>
    >
  }
  window: WindowApi
  chat: {
    send(request: { sessionId: string | null; text: string }): Promise<
      IpcResponse<{ requestId: string; sessionId: string }>
    >
    getActive(): Promise<
      IpcResponse<{ active: { requestId: string; sessionId: string } | null }>
    >
    onDelta(listener: (event: ChatDeltaLike) => void): () => void
    onEnd(listener: (event: ChatEndLike) => void): () => void
  }
  sessions: {
    state(): Promise<IpcResponse<SessionStateLike>>
    getMessages(
      request: { sessionId: string }
    ): Promise<IpcResponse<{ messages: ChatMessageLike[] }>>
  }
  provider: {
    list(): Promise<IpcResponse<{ profiles: Array<{ id: string }> }>>
    create(request: Record<string, unknown>): Promise<IpcResponse>
    delete(request: { id: string }): Promise<IpcResponse>
  }
}

interface DeltaStore {
  deltas: Array<{ at: number; delta: string }>
  ends: Array<{ at: number; status: string }>
  observedHideAt: number | null
}

type TestWindow = typeof globalThis & {
  quickask?: TestApi
  __task24?: DeltaStore
}

interface MockHandle {
  proc: ChildProcess
  port: number
  stdout: string
  stderr: string
  logPath: string
}

interface FocusResult {
  ok: boolean
  method: string
  focus: number
  attempts: number
}

const EVIDENCE_DIR = resolve('.omo/evidence')
const DISPLAY = process.env['DISPLAY'] ?? ':0'
const MOCK_SCRIPT = resolve('tools/mock-sse-server.mjs')
const XMESSAGE_TITLE = `quickask-task24-focus-${process.pid}-${Date.now()}`

let app: ElectronApplication | undefined
let mainPage: Page
let tempRoot = ''
let dataDir = ''
let dbPath = ''
let slowMock: MockHandle | undefined
let xmessageProc: ChildProcess | undefined
let xmessageWid = 0
let mainWid = 0
let appPid = 0
let mockPid = 0
let xmessagePid = 0
let previousFocusWid = 0

const evidence: Record<string, unknown> = {}
const pageErrors: string[] = []
const checks = {
  escLayering: false,
  imeGuard: false,
  settingsTransitions: false,
  nonStreamingBlur: false,
  streamingBlur: false,
  focusReturn: false
}

function delay(ms: number): Promise<void> {
  return new Promise((resolveDelay) => setTimeout(resolveDelay, ms))
}

function writeJson(name: string, value: unknown): void {
  mkdirSync(EVIDENCE_DIR, { recursive: true })
  writeFileSync(resolve(EVIDENCE_DIR, name), `${JSON.stringify(value, null, 2)}\n`)
}

function mergeEvidence(key: string, value: unknown): void {
  evidence[key] = value
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
    QUICKASK_DATA_DIR: join(root, 'data', 'quickask-db'),
    QUICKASK_DISABLE_ONBOARDING: '1'
  }
}

// ---------------------------------------------------------------------------
// X11 helpers (xdotool/xmessage; no pkill/killall anywhere)
// ---------------------------------------------------------------------------

function hexWid(wid: number): string {
  return `0x${wid.toString(16)}`
}

function runXdotool(args: string[]): string {
  return execFileSync('xdotool', args, {
    env: { ...process.env, DISPLAY },
    encoding: 'utf8',
    timeout: 5000
  }).trim()
}

function focusedWid(): number {
  try {
    const value = Number.parseInt(runXdotool(['getwindowfocus']), 10)
    return Number.isFinite(value) ? value : 0
  } catch {
    return 0
  }
}

function windowGeometry(wid: number): { x: number; y: number; width: number; height: number } | null {
  try {
    const output = runXdotool(['getwindowgeometry', '--shell', String(wid)])
    const x = /(?:^|\n)X=(-?\d+)/.exec(output)
    const y = /(?:^|\n)Y=(-?\d+)/.exec(output)
    const width = /(?:^|\n)WIDTH=(\d+)/.exec(output)
    const height = /(?:^|\n)HEIGHT=(\d+)/.exec(output)
    if (!x || !y || !width || !height) return null
    return {
      x: Number(x[1]),
      y: Number(y[1]),
      width: Number(width[1]),
      height: Number(height[1])
    }
  } catch {
    return null
  }
}

function windowAlive(wid: number): boolean {
  if (wid <= 0) return false
  try {
    execFileSync('xwininfo', ['-id', hexWid(wid)], {
      env: { ...process.env, DISPLAY },
      stdio: 'ignore',
      timeout: 3000
    })
    return true
  } catch {
    return false
  }
}

async function forceFocus(wid: number, allowClick: boolean): Promise<FocusResult> {
  if (wid <= 0) return { ok: false, method: 'none', focus: focusedWid(), attempts: 0 }
  for (let attempt = 1; attempt <= 5; attempt += 1) {
    try {
      runXdotool(['windowactivate', '--sync', hexWid(wid)])
    } catch {
      // Retry below; KWin occasionally ignores the first activation.
    }
    await delay(60)
    if (focusedWid() === wid) {
      return { ok: true, method: 'windowactivate', focus: wid, attempts: attempt }
    }
  }

  if (!allowClick) {
    return { ok: false, method: 'none', focus: focusedWid(), attempts: 5 }
  }

  const geometry = windowGeometry(wid)
  if (geometry) {
    const cx = geometry.x + Math.floor(geometry.width / 2)
    const cy = geometry.y + Math.floor(geometry.height / 2)
    try {
      runXdotool(['mousemove', '--sync', String(cx), String(cy)])
    } catch {
      // best effort
    }
    try {
      runXdotool(['click', '1'])
    } catch {
      // best effort
    }
    await delay(150)
  }
  const focus = focusedWid()
  return { ok: focus === wid, method: 'click', focus, attempts: 6 }
}

async function focusXmessageViaPointer(): Promise<FocusResult> {
  expect(xmessageWid).toBeGreaterThan(0)
  try {
    runXdotool(['mousemove', '--window', String(xmessageWid), '30', '30'])
  } catch {
    const geometry = windowGeometry(xmessageWid)
    if (geometry) {
      try {
        runXdotool([
          'mousemove',
          '--sync',
          String(geometry.x + 30),
          String(geometry.y + 30)
        ])
      } catch {
        // best effort
      }
    }
  }
  try {
    runXdotool(['click', '1'])
  } catch {
    // best effort
  }
  for (let attempt = 1; attempt <= 20; attempt += 1) {
    if (focusedWid() === xmessageWid) {
      return { ok: true, method: 'pointer-click', focus: xmessageWid, attempts: attempt }
    }
    await delay(50)
  }
  return forceFocus(xmessageWid, true)
}

function rootScreenshot(name: string): void {
  try {
    execFileSync('scrot', ['-o', resolve(EVIDENCE_DIR, name)], {
      env: { ...process.env, DISPLAY },
      timeout: 15_000
    })
  } catch {
    // The JSON evidence remains authoritative if a screenshot tool fails.
  }
}

async function startXmessage(): Promise<void> {
  xmessageProc = spawn(
    'xmessage',
    [
      '-title',
      XMESSAGE_TITLE,
      '-geometry',
      '420x180+40+760',
      '-buttons',
      'OK:0',
      'Task 24 focus target (previous window)'
    ],
    { env: { ...process.env, DISPLAY }, stdio: ['ignore', 'ignore', 'ignore'] }
  )
  xmessagePid = xmessageProc.pid ?? 0

  for (let attempt = 0; attempt < 100; attempt += 1) {
    try {
      const ids = runXdotool(['search', '--name', XMESSAGE_TITLE])
        .split('\n')
        .map((line) => Number.parseInt(line, 10))
        .filter((value) => Number.isFinite(value) && value > 0)
      if (ids.length > 0) {
        xmessageWid = ids[ids.length - 1]!
        return
      }
    } catch {
      // Window not mapped yet.
    }
    await delay(50)
  }
  throw new Error('xmessage window did not appear')
}

async function stopXmessage(): Promise<void> {
  if (!xmessageProc || xmessageProc.exitCode !== null) return
  const exited = new Promise<void>((resolveExit) => {
    xmessageProc!.once('exit', () => resolveExit())
  })
  xmessageProc.kill('SIGTERM')
  await Promise.race([exited, delay(2000)])
  if (xmessageProc.exitCode === null) xmessageProc.kill('SIGKILL')
  await Promise.race([exited, delay(1000)])
  xmessageProc = undefined
}

// ---------------------------------------------------------------------------
// App / mock helpers
// ---------------------------------------------------------------------------

async function startSlowMock(): Promise<void> {
  const logPath = join(tempRoot, 'slow-mock.log')
  slowMock = {
    proc: spawn(
      process.execPath,
      [
        MOCK_SCRIPT,
        '--port',
        '0',
        '--mode',
        'slow',
        '--chunks',
        '100',
        '--delay',
        '100',
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
  mockPid = slowMock.proc.pid ?? 0

  await new Promise<void>((resolveStarted, reject) => {
    const timer = setTimeout(() => reject(new Error('slow mock did not start')), 10_000)
    slowMock!.proc.stdout?.setEncoding('utf8')
    slowMock!.proc.stderr?.setEncoding('utf8')
    slowMock!.proc.stdout?.on('data', (chunk: string) => {
      slowMock!.stdout += chunk
      const found = slowMock!.stdout.match(/listening on http:\/\/([^:\s]+):(\d+)/)
      if (found) {
        slowMock!.port = Number(found[2])
        clearTimeout(timer)
        resolveStarted()
      }
    })
    slowMock!.proc.stderr?.on('data', (chunk: string) => {
      slowMock!.stderr += chunk
    })
    slowMock!.proc.once('exit', (code) => {
      if (slowMock!.port === 0) {
        clearTimeout(timer)
        reject(new Error(`slow mock exited early: ${code ?? 'signal'}`))
      }
    })
  })
}

async function stopSlowMock(): Promise<void> {
  if (!slowMock || slowMock.proc.exitCode !== null) return
  const exited = new Promise<void>((resolveExit) => {
    slowMock!.proc.once('exit', () => resolveExit())
  })
  slowMock.proc.kill('SIGTERM')
  await Promise.race([exited, delay(2000)])
  if (slowMock.proc.exitCode === null) slowMock.proc.kill('SIGKILL')
  await Promise.race([exited, delay(1000)])
  slowMock = undefined
}

async function launchApp(): Promise<void> {
  app = await electron.launch({ args: ['.'], env: baseEnv(tempRoot) })
  appPid = app.process().pid ?? 0
  mainPage = await app.firstWindow()
  mainPage.on('pageerror', (error) => pageErrors.push(error.message))
  await mainPage.waitForLoadState('domcontentloaded')
  await mainPage.waitForFunction(() => Boolean((window as unknown as TestWindow).quickask))
  mainWid = await app.evaluate(({ BrowserWindow }) => {
    const windows = BrowserWindow.getAllWindows()
    const main =
      windows.find((window) => !window.webContents.getURL().includes('settings=1')) ?? windows[0]
    if (!main) return 0
    const handle = main.getNativeWindowHandle()
    if (handle.length >= 8) return Number(handle.readBigUInt64LE(0) & 0xffffffffn)
    return handle.readUInt32LE(0)
  })
  expect(mainWid).toBeGreaterThan(0)
}

async function windowState(): Promise<WindowStateLike> {
  const result = await mainPage.evaluate(() =>
    (window as unknown as TestWindow).quickask!.window.getState()
  )
  expect(result.ok).toBe(true)
  return result.data as WindowStateLike
}

async function waitVisible(visible: boolean, timeout = 8000): Promise<void> {
  await expect.poll(async () => (await windowState()).visible, { timeout }).toBe(visible)
}

async function waitMode(mode: string, timeout = 8000): Promise<void> {
  await mainPage.waitForFunction(
    (expected) =>
      document.querySelector('[data-testid="app-root"]')?.getAttribute('data-ui-mode') ===
      expected,
    mode,
    { timeout }
  )
}

async function setMode(mode: string): Promise<void> {
  const result = await mainPage.evaluate(
    (next) => (window as unknown as TestWindow).quickask!.window.setMode(next),
    mode
  )
  expect(result.ok).toBe(true)
  await waitMode(mode)
}

async function showS1(): Promise<WindowStateLike> {
  let state = await windowState()
  if (!state.visible) {
    const shown = await mainPage.evaluate(() =>
      (window as unknown as TestWindow).quickask!.window.show()
    )
    expect(shown.ok).toBe(true)
    await waitVisible(true)
  }
  await mainPage.waitForFunction(
    () =>
      document.querySelector('[data-testid="app-root"]')?.getAttribute('data-ui-mode') !==
      'S0'
  )
  state = await windowState()
  if (state.mode !== 'S1') {
    await setMode('S1')
    state = await windowState()
  }
  return state
}

async function hideMainDirectly(): Promise<WindowStateLike> {
  const result = await mainPage.evaluate(() =>
    (window as unknown as TestWindow).quickask!.window.hide()
  )
  expect(result.ok).toBe(true)
  await waitVisible(false)
  return windowState()
}

async function messagesOf(sessionId: string): Promise<ChatMessageLike[]> {
  const result = await mainPage.evaluate(
    async (id) =>
      (window as unknown as TestWindow).quickask!.sessions.getMessages({ sessionId: id }),
    sessionId
  )
  expect(result.ok).toBe(true)
  return result.data?.messages ?? []
}

async function lastAssistant(sessionId: string): Promise<ChatMessageLike | null> {
  const rows = await messagesOf(sessionId)
  return [...rows].reverse().find((row) => row.role === 'assistant') ?? null
}

function readDb<T>(fn: (db: DatabaseSync) => T): T {
  const db = new DatabaseSync(dbPath, { readOnly: true })
  try {
    return fn(db)
  } finally {
    db.close()
  }
}

function dbAssistant(sessionId: string): { content: string; status: string } | null {
  return readDb((db) => {
    const row = db
      .prepare(
        "SELECT content, status FROM messages WHERE session_id = ? AND role = 'assistant' ORDER BY seq DESC LIMIT 1"
      )
      .get(sessionId) as { content: string; status: string } | undefined
    return row ? { content: row.content, status: row.status } : null
  })
}

async function bootstrapHotkey(): Promise<HotkeyStatusLike> {
  const result = await mainPage.evaluate(() =>
    (window as unknown as TestWindow).quickask!.app.bootstrap()
  )
  expect(result.ok).toBe(true)
  return result.data!.hotkey
}

function sendHotkey(): void {
  execFileSync('xdotool', ['key', '--clearmodifiers', 'ctrl+alt+space'], {
    env: { ...process.env, DISPLAY },
    timeout: 5000
  })
}

function mainWindowId(): Promise<number> {
  return app!.evaluate(({ BrowserWindow }) => {
    const windows = BrowserWindow.getAllWindows()
    const main =
      windows.find((window) => !window.webContents.getURL().includes('settings=1')) ?? windows[0]
    if (!main) return 0
    const handle = main.getNativeWindowHandle()
    if (handle.length >= 8) return Number(handle.readBigUInt64LE(0) & 0xffffffffn)
    return handle.readUInt32LE(0)
  })
}

function settingsWindowId(): Promise<number> {
  return app!.evaluate(({ BrowserWindow }) => {
    const settings = BrowserWindow.getAllWindows().find((window) =>
      window.webContents.getURL().includes('settings=1')
    )
    if (!settings) return 0
    const handle = settings.getNativeWindowHandle()
    if (handle.length >= 8) return Number(handle.readBigUInt64LE(0) & 0xffffffffn)
    return handle.readUInt32LE(0)
  })
}

function settingsWindowVisible(): Promise<boolean> {
  return app!.evaluate(({ BrowserWindow }) => {
    const settings = BrowserWindow.getAllWindows().find((window) =>
      window.webContents.getURL().includes('settings=1')
    )
    return Boolean(settings && settings.isVisible() && !settings.isDestroyed())
  })
}

function settingsPages(): Page[] {
  if (!app) return []
  return app.windows().filter((page) => page.url().includes('settings=1'))
}

async function openSettingsWindow(): Promise<Page> {
  const result = await mainPage.evaluate(() =>
    (window as unknown as TestWindow).quickask!.window.openSettings()
  )
  expect(result.ok).toBe(true)
  await expect.poll(() => settingsPages().length, { timeout: 10_000 }).toBe(1)
  const page = settingsPages()[0]!
  await page.waitForLoadState('domcontentloaded')
  await page.waitForFunction(() => Boolean((window as unknown as TestWindow).quickask))
  return page
}

async function waitSettingsClosed(timeout = 10_000): Promise<void> {
  await expect.poll(() => settingsPages().length, { timeout }).toBe(0)
}

async function closeSettingsByEsc(page: Page): Promise<void> {
  await forceFocus(await settingsWindowId(), false)
  try {
    await page.keyboard.down('Escape')
  } catch {
    // The keydown tears down the target before Playwright sends keyup.
  }
  await waitSettingsClosed()
}

async function focusMainX11(): Promise<FocusResult> {
  return forceFocus(await mainWindowId(), false)
}

function mainWindowFocused(): Promise<boolean> {
  return app!.evaluate(({ BrowserWindow }) => {
    const main = BrowserWindow.getAllWindows().find(
      (window) => !window.webContents.getURL().includes('settings=1')
    )
    return Boolean(main && main.isFocused())
  })
}

function hasFocusInMain(): Promise<boolean> {
  return mainPage.evaluate(() => document.hasFocus())
}

// ---------------------------------------------------------------------------
// Suite setup / teardown
// ---------------------------------------------------------------------------

test.describe.configure({ mode: 'serial' })

test.describe('focus: Esc layering, IME guard, blur auto-hide, settings transitions', () => {
  test.beforeAll(async () => {
    previousFocusWid = focusedWid()
    tempRoot = mkdtempSync(join(tmpdir(), 'quickask-task24-e2e-'))
    for (const dir of ['config', 'data', 'state']) {
      mkdirSync(join(tempRoot, dir), { recursive: true })
    }
    dataDir = join(tempRoot, 'data', 'quickask-db')
    dbPath = join(dataDir, 'quickask.db')
    mkdirSync(EVIDENCE_DIR, { recursive: true })
    for (const name of readdirSync(EVIDENCE_DIR)) {
      if (name.startsWith('task-24-')) rmSync(join(EVIDENCE_DIR, name), { force: true })
    }

    await startSlowMock()
    await launchApp()
    await startXmessage()

    const hotkey = await bootstrapHotkey()
    expect(hotkey.primary).toBe('Control+Alt+Space')
    expect(hotkey.registered, JSON.stringify(hotkey)).toBe(true)
    expect(hotkey.accelerator).toBe('Control+Alt+Space')
    expect(hotkey.conflict).toBe(false)
    mergeEvidence('hotkey', hotkey)
  })

  test.afterAll(async () => {
    if (settingsPages().length > 0) {
      try {
        await mainPage.evaluate(() =>
          (window as unknown as TestWindow).quickask!.window.closeSettings()
        )
      } catch {
        // app may already be closing
      }
      await delay(200)
    }

    if (app) {
      const proc = app.process()
      try {
        await Promise.race([app.close(), delay(5000)])
      } catch {
        // best effort
      }
      if (proc.exitCode === null) {
        proc.kill('SIGTERM')
        await delay(1500)
        if (proc.exitCode === null) proc.kill('SIGKILL')
      }
      app = undefined
    }

    await stopSlowMock()
    await stopXmessage()

    let focusRestored = false
    let focusAfterRestore = 0
    if (windowAlive(previousFocusWid)) {
      try {
        runXdotool(['windowactivate', hexWid(previousFocusWid)])
        await delay(250)
        focusAfterRestore = focusedWid()
        focusRestored = focusAfterRestore === previousFocusWid
      } catch {
        focusRestored = false
      }
    }

    const appExited = appPid > 0 ? !existsSync(`/proc/${appPid}`) : true
    const mockExited = mockPid > 0 ? !existsSync(`/proc/${mockPid}`) : true
    const xmessageExited = xmessagePid > 0 ? !existsSync(`/proc/${xmessagePid}`) : true
    const cleanup = {
      appPid,
      appExited,
      mockPid,
      mockExited,
      xmessagePid,
      xmessageExited,
      previousFocusWid: previousFocusWid > 0 ? hexWid(previousFocusWid) : null,
      previousFocusAlive: windowAlive(previousFocusWid),
      focusRestored,
      focusAfterRestore: focusAfterRestore > 0 ? hexWid(focusAfterRestore) : null
    }

    const allPassed = Object.values(checks).every(Boolean)
    const summary = {
      task: 24,
      generatedAt: new Date().toISOString(),
      verdict: allPassed ? 'PASS' : 'FAIL',
      checks,
      display: DISPLAY,
      hotkey: evidence['hotkey'] ?? null,
      evidence: {
        esc: 'task-24-esc.json',
        imeEsc: 'task-24-ime-esc.json',
        blurHide: 'task-24-blurhide.json',
        settings: 'task-24-settings.json',
        focusReturn: 'task-24-focus-return.json',
        screenshots: [
          'task-24-esc.png',
          'task-24-ime-esc.png',
          'task-24-blurhide-1s.png',
          'task-24-blurhide-hidden.png',
          'task-24-settings.png',
          'task-24-focus-return.png'
        ]
      },
      ...evidence,
      cleanup,
      pageErrors
    }
    writeJson('task-24-summary.json', summary)
    writeJson('task-24-cleanup.json', cleanup)

    try {
      const logDir = join(tempRoot, 'state', 'quickask', 'logs')
      if (existsSync(logDir)) {
        const lines: string[] = []
        for (const name of readdirSync(logDir)) {
          const path = join(logDir, name)
          try {
            lines.push(`===== ${name} =====`, readFileSync(path, 'utf8'))
          } catch {
            // best effort
          }
        }
        writeFileSync(resolve(EVIDENCE_DIR, 'task-24-app.log'), lines.join('\n'))
      }
    } catch {
      // best effort
    }

    try {
      rmSync(tempRoot, { recursive: true, force: true })
    } catch {
      // best effort
    }
  })

  // -------------------------------------------------------------------------
  // 1. Esc layering
  // -------------------------------------------------------------------------
  test('focus case 1: Esc layers S3 -> S2 -> S1 -> S0 and keeps the process alive', async () => {
    const initial = await showS1()
    expect(initial.visible).toBe(true)
    expect(initial.mode).toBe('S1')

    await setMode('S2')
    const atS2 = await windowState()
    expect(atS2.mode).toBe('S2')
    expect(atS2.visible).toBe(true)

    await setMode('S3')
    const atS3 = await windowState()
    expect(atS3.mode).toBe('S3')
    expect(atS3.layout?.sidebarRect).not.toBeNull()
    await mainPage.screenshot({ path: resolve(EVIDENCE_DIR, 'task-24-esc.png') })

    // Make sure the real X keyboard focus is on QuickAsk for the xdotool step.
    const focus = await focusMainX11()
    expect(focus.ok, JSON.stringify(focus)).toBe(true)

    const sequence: Array<Record<string, unknown>> = [
      { step: 'setMode', mode: 'S3', state: atS3 }
    ]

    await mainPage.keyboard.press('Escape')
    await waitMode('S2')
    const afterEsc1 = await windowState()
    sequence.push({ step: 'Esc #1 (Playwright keydown)', mode: afterEsc1.mode })

    // Second layer uses a real X11 keystroke, not a renderer-only event.
    execFileSync('xdotool', ['key', '--clearmodifiers', 'Escape'], {
      env: { ...process.env, DISPLAY },
      timeout: 5000
    })
    await waitMode('S1')
    const afterEsc2 = await windowState()
    sequence.push({ step: 'Esc #2 (xdotool XTEST)', mode: afterEsc2.mode })

    await mainPage.keyboard.press('Escape')
    await waitVisible(false)
    const afterEsc3 = await windowState()
    sequence.push({ step: 'Esc #3 (Playwright keydown)', mode: afterEsc3.mode })

    expect(afterEsc1.mode).toBe('S2')
    expect(afterEsc2.mode).toBe('S1')
    expect(afterEsc3.mode).toBe('S0')
    expect(afterEsc3.visible).toBe(false)

    const stillAlive = await mainPage.evaluate(() =>
      (window as unknown as TestWindow).quickask!.window.getState()
    )
    expect(stillAlive.ok).toBe(true)
    expect(app!.process().exitCode).toBeNull()
    expect(app!.windows().length).toBeGreaterThan(0)

    // Tray-resident app: hotkey recalls S1 from S0.
    sendHotkey()
    await waitVisible(true)
    const reshown = await windowState()
    expect(reshown.mode).toBe('S1')
    sequence.push({ step: 'hotkey after hide', mode: reshown.mode, visible: reshown.visible })

    const payload = {
      generatedAt: new Date().toISOString(),
      sequence,
      x11Focus: focus,
      final: {
        mode: afterEsc3.mode,
        visible: afterEsc3.visible,
        processAlive: app!.process().exitCode === null,
        windows: app!.windows().length
      },
      reshown: { mode: reshown.mode, visible: reshown.visible },
      screenshot: 'task-24-esc.png'
    }
    writeJson('task-24-esc.json', payload)
    mergeEvidence('esc', payload)
    checks.escLayering = true
  })

  // -------------------------------------------------------------------------
  // 2. IME guard
  // -------------------------------------------------------------------------
  test('focus case 2: composing Escape (keyCode 229 / isComposing) is ignored', async () => {
    await showS1()
    await focusMainX11()

    const dispatched = await mainPage.evaluate(() => {
      const api = (window as unknown as TestWindow).quickask!
      const composer = document.querySelector(
        '[data-testid="composer"]'
      ) as HTMLTextAreaElement | null
      composer?.focus()
      composer?.dispatchEvent(
        new CompositionEvent('compositionstart', { bubbles: true, data: '' })
      )

      const event = new KeyboardEvent('keydown', {
        key: 'Escape',
        code: 'Escape',
        keyCode: 229,
        which: 229,
        bubbles: true,
        cancelable: true,
        isComposing: true
      })
      window.dispatchEvent(event)

      return {
        isComposing: event.isComposing,
        keyCode: event.keyCode,
        modeAfterDispatch:
          document.querySelector('[data-testid="app-root"]')?.getAttribute('data-ui-mode') ??
          null,
        windowQuickask: Boolean(api)
      }
    })
    expect(dispatched.keyCode).toBe(229)
    expect(dispatched.isComposing).toBe(true)
    expect(dispatched.modeAfterDispatch).toBe('S1')

    await delay(500)
    const after = await windowState()
    expect(after.mode).toBe('S1')
    expect(after.visible).toBe(true)
    await mainPage.screenshot({ path: resolve(EVIDENCE_DIR, 'task-24-ime-esc.png') })

    // A real Escape afterwards must still hide (guard is composition-only).
    await mainPage.keyboard.press('Escape')
    await waitVisible(false)
    const realEsc = await windowState()
    expect(realEsc.mode).toBe('S0')

    const payload = {
      generatedAt: new Date().toISOString(),
      synthetic: {
        type: 'compositionstart + keydown',
        key: 'Escape',
        keyCode: 229,
        isComposing: true,
        ...dispatched
      },
      afterWaitMs: 500,
      stateAfterSyntheticEsc: { mode: after.mode, visible: after.visible },
      realEscapeAfterGuard: { mode: realEsc.mode, visible: realEsc.visible },
      screenshot: 'task-24-ime-esc.png'
    }
    writeJson('task-24-ime-esc.json', payload)
    mergeEvidence('imeEsc', payload)
    checks.imeGuard = true
  })

  // -------------------------------------------------------------------------
  // 3. Settings transitions
  // -------------------------------------------------------------------------
  test('focus case 3: settings Esc/Alt+F4/hotkey, hidden main, auto-hide suppression', async () => {
    const results: Record<string, unknown> = {}

    // --- 3a: Esc closes settings, main stays S1 ---
    await showS1()
    let settings = await openSettingsWindow()
    const mainBeforeEsc = await windowState()
    expect(mainBeforeEsc.mode).toBe('S1')
    expect(mainBeforeEsc.visible).toBe(true)
    await settings.screenshot({ path: resolve(EVIDENCE_DIR, 'task-24-settings.png') })

    await closeSettingsByEsc(settings)
    await delay(250)
    const afterSettingsEsc = await windowState()
    expect(afterSettingsEsc.mode).toBe('S1')
    expect(afterSettingsEsc.visible).toBe(true)
    results['escClose'] = {
      mainBefore: { mode: mainBeforeEsc.mode, visible: mainBeforeEsc.visible },
      mainAfter: { mode: afterSettingsEsc.mode, visible: afterSettingsEsc.visible },
      settingsClosed: settingsPages().length === 0
    }

    // --- 3b: Alt+F4 closes only settings; main process/window alive ---
    await openSettingsWindow()
    const settingsWid = await settingsWindowId()
    expect(settingsWid).toBeGreaterThan(0)
    const settingsFocus = await forceFocus(settingsWid, false)
    expect(settingsFocus.ok, JSON.stringify(settingsFocus)).toBe(true)
    execFileSync('xdotool', ['key', '--clearmodifiers', 'alt+F4'], {
      env: { ...process.env, DISPLAY },
      timeout: 5000
    })
    await waitSettingsClosed()
    const afterAltF4 = await windowState()
    const appAlive = await app!.evaluate(({ app: electronApp }) => electronApp.isReady())
    expect(appAlive).toBe(true)
    expect(app!.process().exitCode).toBeNull()
    expect(app!.windows().length).toBeGreaterThan(0)
    expect(afterAltF4.visible).toBe(true)
    expect(afterAltF4.mode).toBe('S1')
    results['altF4'] = {
      settingsWid: hexWid(settingsWid),
      settingsClosed: settingsPages().length === 0,
      main: { mode: afterAltF4.mode, visible: afterAltF4.visible },
      appAlive,
      exitCode: app!.process().exitCode
    }

    // --- 3c: hotkey closes settings + hides main; hotkey again shows S1 ---
    await openSettingsWindow()
    const hotkeySettingsWid = await settingsWindowId()
    expect(hotkeySettingsWid).toBeGreaterThan(0)
    await forceFocus(hotkeySettingsWid, false)
    sendHotkey()
    await waitSettingsClosed()
    await waitVisible(false)
    const afterHotkeyHide = await windowState()
    expect(afterHotkeyHide.mode).toBe('S0')
    expect(afterHotkeyHide.visible).toBe(false)

    sendHotkey()
    await waitVisible(true)
    const afterHotkeyShow = await windowState()
    expect(afterHotkeyShow.mode).toBe('S1')
    expect(afterHotkeyShow.visible).toBe(true)
    results['hotkey'] = {
      afterFirstHotkey: { mode: afterHotkeyHide.mode, visible: afterHotkeyHide.visible },
      afterSecondHotkey: { mode: afterHotkeyShow.mode, visible: afterHotkeyShow.visible }
    }

    // --- 3d: settings opens independently while main is hidden ---
    const hidden = await hideMainDirectly()
    expect(hidden.mode).toBe('S0')
    settings = await openSettingsWindow()
    const hiddenMainWhileSettings = await windowState()
    const settingsVisible = await settingsWindowVisible()
    expect(hiddenMainWhileSettings.mode).toBe('S0')
    expect(hiddenMainWhileSettings.visible).toBe(false)
    expect(settingsVisible).toBe(true)
    await closeSettingsByEsc(settings)
    await delay(300)
    const afterIndependentClose = await windowState()
    expect(afterIndependentClose.mode).toBe('S0')
    expect(afterIndependentClose.visible).toBe(false)
    results['hiddenMain'] = {
      whileOpen: {
        main: {
          mode: hiddenMainWhileSettings.mode,
          visible: hiddenMainWhileSettings.visible
        },
        settingsVisible
      },
      afterClose: {
        mode: afterIndependentClose.mode,
        visible: afterIndependentClose.visible
      }
    }

    // --- 3e: auto-hide is suppressed while settings is open ---
    await showS1()
    await openSettingsWindow()
    const focusBlur = await focusXmessageViaPointer()
    expect(focusBlur.ok, JSON.stringify(focusBlur)).toBe(true)

    const focusSamples: Array<Record<string, unknown>> = []
    const sampleStart = Date.now()
    while (Date.now() - sampleStart < 1200) {
      focusSamples.push({
        atMs: Date.now() - sampleStart,
        xFocusWid: hexWid(focusedWid()),
        mainWindowFocused: await mainWindowFocused(),
        mainDocumentFocused: await hasFocusInMain()
      })
      await delay(100)
    }
    const mainAfterDelay = await windowState()
    const settingsStillVisible = await settingsWindowVisible()
    const blurredSamples = focusSamples.filter(
      (entry) => entry['mainWindowFocused'] === false
    ).length
    expect(blurredSamples).toBeGreaterThan(0)
    expect(mainAfterDelay.visible).toBe(true)
    expect(mainAfterDelay.mode).toBe('S1')
    expect(settingsStillVisible).toBe(true)
    results['autoHideSuppressed'] = {
      xmessageWid: hexWid(xmessageWid),
      xmessageFocus: focusBlur,
      focusSamples,
      blurredSamples,
      waitMs: 1200,
      main: { mode: mainAfterDelay.mode, visible: mainAfterDelay.visible },
      settingsVisible: settingsStillVisible
    }

    await mainPage.evaluate(() =>
      (window as unknown as TestWindow).quickask!.window.closeSettings()
    )
    await waitSettingsClosed()

    writeJson('task-24-settings.json', {
      generatedAt: new Date().toISOString(),
      results
    })
    mergeEvidence('settings', results)
    checks.settingsTransitions = true
  })

  // -------------------------------------------------------------------------
  // 4. Non-streaming blur
  // -------------------------------------------------------------------------
  test('focus case 4: non-streaming blur hides main within 500ms', async () => {
    await showS1()
    const focus = await focusMainX11()
    expect(focus.ok, JSON.stringify(focus)).toBe(true)
    await expect.poll(() => mainWindowFocused(), { timeout: 3000 }).toBe(true)
    const mainDocumentFocusedBeforeBlur = await hasFocusInMain()

    const blur = await focusXmessageViaPointer()
    expect(blur.ok, JSON.stringify(blur)).toBe(true)
    const t0 = Date.now()

    let hiddenAtMs: number | null = null
    let samples = 0
    while (Date.now() - t0 <= 800) {
      const state = await windowState()
      samples += 1
      if (!state.visible) {
        hiddenAtMs = Date.now() - t0
        break
      }
      await delay(20)
    }

    expect(hiddenAtMs, `samples=${samples}`).not.toBeNull()
    expect(hiddenAtMs!).toBeLessThanOrEqual(500)
    const hidden = await windowState()
    expect(hidden.visible).toBe(false)
    expect(hidden.mode).toBe('S0')
    const focusAfterHide = focusedWid()
    expect(focusAfterHide).toBe(xmessageWid)
    const mainWindowFocusedAfterHide = await mainWindowFocused()
    rootScreenshot('task-24-blurhide.png')

    const payload = {
      generatedAt: new Date().toISOString(),
      nonStreaming: {
        hiddenAtMs,
        limitMs: 500,
        samples,
        xmessageWid: hexWid(xmessageWid),
        xmessageFocus: blur,
        mainDocumentFocusedBeforeBlur,
        mainWindowFocusedAfterHide,
        focusAfterHide: hexWid(focusAfterHide),
        state: { mode: hidden.mode, visible: hidden.visible }
      },
      screenshot: 'task-24-blurhide.png'
    }
    writeJson('task-24-blurhide.json', payload)
    mergeEvidence('blurNonStreaming', payload.nonStreaming)
    checks.nonStreamingBlur = true
  })

  // -------------------------------------------------------------------------
  // 5. Streaming blur
  // -------------------------------------------------------------------------
  test('focus case 5: streaming blur stays visible at 1s, hides by 4s, content preserved', async () => {
    test.setTimeout(90_000)
    const profile = await mainPage.evaluate(async ({ url }) => {
      const api = (window as unknown as TestWindow).quickask!
      const existing = await api.provider.list()
      for (const entry of existing.data?.profiles ?? []) {
        await api.provider.delete({ id: entry.id })
      }
      return api.provider.create({
        name: 'task24-slow',
        baseUrl: url,
        model: 'mock',
        isDefault: true
      })
    }, { url: `http://127.0.0.1:${slowMock!.port}/v1` })
    expect(profile.ok).toBe(true)

    await showS1()
    const focus = await focusMainX11()
    expect(focus.ok, JSON.stringify(focus)).toBe(true)

    // Subscribe before sending so every delta and the end event is recorded.
    await mainPage.evaluate(() => {
      const api = (window as unknown as TestWindow).quickask!
      const store: DeltaStore = { deltas: [], ends: [], observedHideAt: null }
      ;(window as unknown as TestWindow).__task24 = store
      api.chat.onDelta((event) => {
        store.deltas.push({ at: Date.now(), delta: event.delta })
      })
      api.chat.onEnd((event) => {
        store.ends.push({ at: Date.now(), status: event.status })
      })
    })

    const sent = await mainPage.evaluate(() =>
      (window as unknown as TestWindow).quickask!.chat.send({
        sessionId: null,
        text: 'task24-streaming-blur-question'
      })
    )
    expect(sent.ok).toBe(true)
    const sessionId = sent.data!.sessionId

    await expect
      .poll(
        async () => {
          const active = await mainPage.evaluate(() =>
            (window as unknown as TestWindow).quickask!.chat.getActive()
          )
          return Boolean(active.data?.active)
        },
        { timeout: 10_000 }
      )
      .toBe(true)

    await mainPage.waitForFunction(
      async (id) => {
        const api = (window as unknown as TestWindow).quickask!
        const result = await api.sessions.getMessages({ sessionId: id })
        const assistant = [...(result.data?.messages ?? [])]
          .reverse()
          .find((row) => row.role === 'assistant')
        return Boolean(assistant && assistant.content.length > 0)
      },
      sessionId,
      { timeout: 10_000 }
    )

    const stateStreaming = await windowState()
    expect(stateStreaming.mode).toBe('S2')
    expect(stateStreaming.visible).toBe(true)

    const blur = await focusXmessageViaPointer()
    expect(blur.ok, JSON.stringify(blur)).toBe(true)
    const t0 = Date.now()
    await expect.poll(() => mainWindowFocused(), { timeout: 3000 }).toBe(false)
    const mainWindowFocusedAfterBlur = await mainWindowFocused()
    const mainDocumentFocusAfterBlur = await hasFocusInMain()
    const xFocusAfterBlur = focusedWid()

    await delay(1000)
    const at1s = await windowState()
    const at1sMs = Date.now() - t0
    expect(at1s.visible).toBe(true)
    expect(at1s.mode).toBe('S2')
    rootScreenshot('task-24-blurhide-1s.png')

    let hiddenAtMs: number | null = null
    const timeline: Array<Record<string, unknown>> = []
    while (Date.now() - t0 <= 6000) {
      const state = await windowState()
      const atMs = Date.now() - t0
      timeline.push({
        atMs,
        visible: state.visible,
        mode: state.mode,
        xFocusWid: hexWid(focusedWid()),
        mainWindowFocused: await mainWindowFocused()
      })
      if (!state.visible) {
        hiddenAtMs = atMs
        break
      }
      await delay(80)
    }
    writeJson('task-24-blurhide-timeline.json', {
      generatedAt: new Date().toISOString(),
      sessionId,
      timeline,
      hiddenAtMs
    })
    expect(hiddenAtMs).not.toBeNull()
    expect(hiddenAtMs!).toBeGreaterThanOrEqual(2800)
    expect(hiddenAtMs!).toBeLessThanOrEqual(4000)
    const hidden = await windowState()
    expect(hidden.visible).toBe(false)
    expect(hidden.mode).toBe('S0')
    rootScreenshot('task-24-blurhide-hidden.png')

    await mainPage.evaluate(() => {
      const store = (window as unknown as TestWindow).__task24
      if (store) store.observedHideAt = Date.now()
    })

    const assistantAtHide = await lastAssistant(sessionId)
    const dbAtHide = dbAssistant(sessionId)
    expect(assistantAtHide).not.toBeNull()
    expect(assistantAtHide!.content.length).toBeGreaterThan(0)

    await expect
      .poll(
        async () => {
          const snapshot = await mainPage.evaluate(async (id) => {
            const api = (window as unknown as TestWindow).quickask!
            const active = await api.chat.getActive()
            const result = await api.sessions.getMessages({ sessionId: id })
            const assistant = [...(result.data?.messages ?? [])]
              .reverse()
              .find((row) => row.role === 'assistant')
            return {
              active: Boolean(active.data?.active),
              status: assistant?.status ?? null
            }
          }, sessionId)
          return snapshot.active === false && snapshot.status === 'complete'
        },
        { timeout: 30_000, intervals: [150] }
      )
      .toBe(true)
    await delay(350)

    const assistantFinal = await lastAssistant(sessionId)
    const dbFinal = dbAssistant(sessionId)
    expect(assistantFinal).not.toBeNull()
    expect(assistantFinal!.status).toBe('complete')
    expect(dbFinal?.status).toBe('complete')

    const store = await mainPage.evaluate(() => {
      const value = (window as unknown as TestWindow).__task24
      return value
        ? {
            deltas: value.deltas,
            ends: value.ends,
            observedHideAt: value.observedHideAt
          }
        : null
    })
    expect(store).not.toBeNull()
    const observedHideAt = store!.observedHideAt
    expect(observedHideAt).not.toBeNull()
    const endAt = store!.ends.length > 0 ? store!.ends[0]!.at : Number.MAX_SAFE_INTEGER
    const deltasAfterHide = store!.deltas.filter(
      (entry) => entry.at > (observedHideAt as number)
    ).length
    const deltasAfterEnd = store!.deltas.filter((entry) => entry.at > endAt).length
    const joinedDeltas = store!.deltas.map((entry) => entry.delta).join('')

    expect(store!.ends).toHaveLength(1)
    expect(store!.ends[0]!.status).toBe('complete')
    expect(deltasAfterEnd).toBe(0)
    // Streaming continues after the window hides: every hidden-time delta is
    // persisted, so nothing is lost. (Deliberately no stream abort on hide.)
    expect(deltasAfterHide).toBeGreaterThan(0)
    expect(joinedDeltas).toBe(assistantFinal!.content)
    expect(assistantFinal!.content.startsWith(assistantAtHide!.content)).toBe(true)
    expect(dbFinal?.content).toBe(assistantFinal!.content)
    expect(assistantFinal!.content.length).toBeGreaterThan(assistantAtHide!.content.length)

    const payload = {
      generatedAt: new Date().toISOString(),
      provider: { name: 'task24-slow', baseUrl: `http://127.0.0.1:${slowMock!.port}/v1` },
      sessionId,
      streamingMode: stateStreaming.mode,
      xmessageWid: hexWid(xmessageWid),
      xmessageFocus: blur,
      mainWindowFocusedAfterBlur,
      mainDocumentFocusAfterBlur,
      xFocusAfterBlur: hexWid(xFocusAfterBlur),
      at1s: { elapsedMs: at1sMs, mode: at1s.mode, visible: at1s.visible },
      hiddenAtMs,
      afterHide: {
        mode: hidden.mode,
        visible: hidden.visible,
        assistantContentLength: assistantAtHide!.content.length,
        assistantStatus: assistantAtHide!.status,
        dbContentLength: dbAtHide?.content.length ?? null
      },
      final: {
        assistantContentLength: assistantFinal!.content.length,
        assistantStatus: assistantFinal!.status,
        dbContentLength: dbFinal?.content.length ?? null,
        deltaEvents: store!.deltas.length,
        deltasAfterHide,
        deltasAfterEnd,
        joinedDeltasLength: joinedDeltas.length,
        joinedMatchesDb: joinedDeltas === assistantFinal!.content,
        hiddenDeltasPersisted: joinedDeltas === assistantFinal!.content,
        noDeltasAfterEnd: deltasAfterEnd === 0,
        contentPreserved: assistantFinal!.content.startsWith(assistantAtHide!.content),
        endStatus: store!.ends[0]!.status
      },
      mockLogTail: existsSync(slowMock!.logPath)
        ? readFileSync(slowMock!.logPath, 'utf8').trim().split('\n').slice(-4)
        : [],
      screenshots: ['task-24-blurhide-1s.png', 'task-24-blurhide-hidden.png']
    }
    writeJson('task-24-blurhide.json', payload)
    mergeEvidence('blurStreaming', payload)
    checks.streamingBlur = true
  })

  // -------------------------------------------------------------------------
  // 6. Focus return
  // -------------------------------------------------------------------------
  test('focus case 6: Esc hide returns X focus to the previous xmessage window', async () => {
    expect(xmessageWid).toBeGreaterThan(0)
    const attempts: Array<Record<string, unknown>> = []
    const cycles: Array<Record<string, unknown>> = []
    const appWid = await mainWindowId()
    expect(appWid).toBeGreaterThan(0)

    for (let cycle = 1; cycle <= 5; cycle += 1) {
      const preFocus = await focusXmessageViaPointer()
      expect(preFocus.ok, JSON.stringify(preFocus)).toBe(true)
      expect(focusedWid()).toBe(xmessageWid)

      const hotkeyAt = Date.now()
      sendHotkey()
      await waitVisible(true)
      const shown = await windowState()
      expect(shown.mode).toBe('S1')
      const shownMs = Date.now() - hotkeyAt
      await expect
        .poll(() => focusedWid(), { timeout: 5000 })
        .toBe(appWid)
      const mainFocused = await hasFocusInMain()
      expect(mainFocused).toBe(true)

      await mainPage.keyboard.press('Escape')
      await waitVisible(false)
      const hidden = await windowState()
      expect(hidden.mode).toBe('S0')
      const hideAt = Date.now()

      let success = false
      let focusNow = focusedWid()
      for (let attempt = 1; attempt <= 20; attempt += 1) {
        focusNow = focusedWid()
        const ok = focusNow === xmessageWid
        attempts.push({
          cycle,
          attempt,
          afterHideMs: Date.now() - hideAt,
          focusWid: hexWid(focusNow),
          expectedWid: hexWid(xmessageWid),
          success: ok
        })
        if (ok) {
          success = true
          break
        }
        await delay(50)
      }

      cycles.push({
        cycle,
        hotkeyToVisibleMs: shownMs,
        shown: { mode: shown.mode, visible: shown.visible },
        mainFocused,
        hidden: { mode: hidden.mode, visible: hidden.visible },
        focusReturned: success,
        focusWid: hexWid(focusNow)
      })
      if (!success) break
    }

    const successes = cycles.filter((entry) => entry['focusReturned'] === true).length
    expect(cycles).toHaveLength(5)
    expect(successes).toBe(5)
    rootScreenshot('task-24-focus-return.png')

    const payload = {
      generatedAt: new Date().toISOString(),
      appWid: hexWid(appWid),
      xmessageWid: hexWid(xmessageWid),
      xmessageTitle: XMESSAGE_TITLE,
      cycles,
      attempts,
      attemptsPerCycle: attempts.length,
      successes,
      verdict: successes === 5 ? 'PASS' : 'FAIL',
      screenshot: 'task-24-focus-return.png'
    }
    writeJson('task-24-focus-return.json', payload)
    mergeEvidence('focusReturn', payload)
    checks.focusReturn = successes === 5
  })
})
