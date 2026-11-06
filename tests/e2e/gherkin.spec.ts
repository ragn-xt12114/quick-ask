/**
 * Task 31 — REQUIREMENTS §6 Gherkin matrix (G01–G10).
 *
 * Every scenario runs against the real built Electron app (`electron .`) on
 * DISPLAY=:0, not a mock renderer. OS-only parts (xfcf/Alt+Tab, real fcitx5,
 * compositor-off fallback, a physical second display) are cross-checked
 * against the raw evidence already captured in `.omo/evidence/m1/` and are
 * reported as PASS/PARTIAL in `.omo/evidence/m1/gherkin/summary.json`.
 *
 * Evidence written by this spec: `.omo/evidence/m1/gherkin/G01..G10.json`.
 */
import { _electron as electron, expect, test } from '@playwright/test'
import type { ElectronApplication, Page } from '@playwright/test'
import { execFileSync, spawn, type ChildProcess } from 'node:child_process'
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  writeFileSync
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { defaultAnchor } from '../../src/shared/geometry'

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
}

interface BlurStatusLike {
  available: boolean
  reason: string | null
  compositor: boolean | null
  effectEnabled: boolean | null
}

interface BootstrapLike {
  hotkey: HotkeyStatusLike
  onboarding: { required: boolean; reason: string | null }
  blurStatus: BlurStatusLike
  opaqueMode: boolean
  dataDir: string
  logsDir: string
}

interface WindowStateLike {
  mode: string
  visible: boolean
  bounds: { x: number; y: number; width: number; height: number }
  display: { workArea: { x: number; y: number; width: number; height: number }; scaleFactor: number }
}

interface MessageLike {
  id: string
  sessionId: string
  seq: number
  role: string
  content: string
  status: string
}

interface SessionSummaryLike {
  id: string
  title: string
}

interface TestApi {
  app: {
    bootstrap(): Promise<IpcResponse<BootstrapLike>>
  }
  window: {
    show(): Promise<IpcResponse<WindowStateLike>>
    hide(): Promise<IpcResponse<WindowStateLike>>
    getState(): Promise<IpcResponse<WindowStateLike>>
    setMode(mode: string): Promise<IpcResponse<{ mode: string }>>
  }
  chat: {
    send(request: { sessionId: string | null; text: string }): Promise<IpcResponse>
  }
  sessions: {
    state(): Promise<
      IpcResponse<{
        currentSessionId: string | null
        mode: string
        messages: MessageLike[]
      }>
    >
    list(request?: {
      query?: string
      limit?: number
    }): Promise<IpcResponse<{ sessions: SessionSummaryLike[] }>>
    open(request: { id: string }): Promise<IpcResponse<{ messages: MessageLike[] }>>
  }
  provider: {
    list(): Promise<IpcResponse<{ profiles: Array<{ id: string }> }>>
    create(request: Record<string, unknown>): Promise<IpcResponse>
    delete(request: { id: string }): Promise<IpcResponse>
  }
}

type TestWindow = typeof globalThis & { quickask?: TestApi }

interface MockHandle {
  proc: ChildProcess
  port: number
  logPath: string
  bodyLogPath: string
  stdout: string
  stderr: string
}

interface AppHandle {
  app: ElectronApplication
  page: Page
  env: Record<string, string>
  root: string
  logs: () => string
}

const EVIDENCE_DIR = resolve('.omo/evidence/m1/gherkin')
const M1_EVIDENCE_DIR = resolve('.omo/evidence/m1')
const DISPLAY = process.env['DISPLAY'] ?? ':0'
const MOCK_SCRIPT = resolve('tools/mock-sse-server.mjs')
const ELECTRON_BIN = resolve('node_modules/electron/dist/electron')

function delay(ms: number): Promise<void> {
  return new Promise((resolveDelay) => setTimeout(resolveDelay, ms))
}

function prepareRoot(prefix: string): string {
  const root = mkdtempSync(join(tmpdir(), prefix))
  for (const dir of ['config', 'data', 'state']) {
    mkdirSync(join(root, dir), { recursive: true })
  }
  return root
}

function baseEnv(root: string, disableOnboarding: boolean): Record<string, string> {
  const inherited: Record<string, string> = {}
  for (const [key, value] of Object.entries(process.env)) {
    if (value !== undefined) inherited[key] = value
  }
  delete inherited['QUICKASK_DISABLE_ONBOARDING']
  return {
    ...inherited,
    DISPLAY,
    XDG_CONFIG_HOME: join(root, 'config'),
    XDG_DATA_HOME: join(root, 'data'),
    XDG_STATE_HOME: join(root, 'state'),
    QUICKASK_DATA_DIR: join(root, 'data', 'quickask-db'),
    ...(disableOnboarding ? { QUICKASK_DISABLE_ONBOARDING: '1' } : {})
  }
}

function writeJson(name: string, value: unknown): void {
  mkdirSync(EVIDENCE_DIR, { recursive: true })
  writeFileSync(join(EVIDENCE_DIR, name), `${JSON.stringify(value, null, 2)}\n`)
}

function readJson(path: string): Record<string, unknown> {
  return JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>
}

async function launchApp(
  root: string,
  disableOnboarding = true
): Promise<AppHandle> {
  const env = baseEnv(root, disableOnboarding)
  const app = await electron.launch({ args: ['.'], env })
  let logs = ''
  const child = app.process()
  child.stdout?.setEncoding('utf8')
  child.stderr?.setEncoding('utf8')
  child.stdout?.on('data', (chunk: string) => {
    logs += chunk
  })
  child.stderr?.on('data', (chunk: string) => {
    logs += chunk
  })

  const first = await app.firstWindow()
  await first.waitForLoadState('domcontentloaded')
  const main = app.windows().find((entry) => !entry.url().includes('settings=1')) ?? first
  await main.waitForFunction(() => Boolean((window as unknown as TestWindow).quickask))
  return { app, page: main, env, root, logs: () => logs }
}

async function quitApp(handle: AppHandle): Promise<{ code: number | null; signal: string | null }> {
  const child = handle.app.process()
  if (child.exitCode !== null) return { code: child.exitCode, signal: null }
  const exited = new Promise<{ code: number | null; signal: string | null }>((resolveExit) => {
    child.once('exit', (code, signal) => resolveExit({ code, signal }))
  })
  try {
    await handle.app.evaluate(({ app }) => app.quit())
  } catch {
    // The CDP response can be lost when the app exits immediately.
  }
  const result = await Promise.race([exited, delay(4000).then(() => null)])
  if (result === null) {
    child.kill('SIGKILL')
    return (await Promise.race([exited, delay(2000).then(() => ({ code: null, signal: 'SIGKILL' }))]))!
  }
  return result
}

async function closeApp(handle: AppHandle | undefined): Promise<void> {
  if (!handle) return
  try {
    await quitApp(handle)
  } catch {
    // best effort cleanup
  }
}

async function startMock(
  root: string,
  name: string,
  args: string[]
): Promise<MockHandle> {
  const logPath = join(root, `${name}.log`)
  const bodyLogPath = join(root, `${name}-body.log`)
  const handle: MockHandle = {
    proc: spawn(
      process.execPath,
      [MOCK_SCRIPT, '--port', '0', '--log', logPath, '--body-log', bodyLogPath, ...args],
      { stdio: ['ignore', 'pipe', 'pipe'] }
    ),
    port: 0,
    logPath,
    bodyLogPath,
    stdout: '',
    stderr: ''
  }
  await new Promise<void>((resolveStarted, reject) => {
    const timer = setTimeout(() => reject(new Error('mock server did not start')), 10_000)
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
        reject(new Error(`mock server exited early: ${code ?? 'signal'}`))
      }
    })
  })
  return handle
}

async function stopMock(mock: MockHandle | undefined): Promise<void> {
  if (!mock || mock.proc.exitCode !== null) return
  const exited = new Promise<void>((resolveExit) => mock.proc.once('exit', () => resolveExit()))
  mock.proc.kill('SIGTERM')
  await Promise.race([exited, delay(2000)])
  if (mock.proc.exitCode === null) mock.proc.kill('SIGKILL')
  await Promise.race([exited, delay(1000)])
}

function postCount(mock: MockHandle): number {
  if (!existsSync(mock.logPath)) return 0
  return readFileSync(mock.logPath, 'utf8')
    .split('\n')
    .filter((line) => line.startsWith('POST /v1/chat/completions')).length
}

function bodyCount(mock: MockHandle): number {
  if (!existsSync(mock.bodyLogPath)) return 0
  return readFileSync(mock.bodyLogPath, 'utf8')
    .split('\n')
    .filter((line) => line.trim().length > 0).length
}

async function state(page: Page): Promise<WindowStateLike> {
  const result = await page.evaluate(() =>
    (window as unknown as TestWindow).quickask!.window.getState()
  )
  expect(result.ok).toBe(true)
  return result.data as WindowStateLike
}

async function waitVisible(page: Page, visible: boolean): Promise<WindowStateLike> {
  await expect.poll(async () => (await state(page)).visible, { timeout: 6000 }).toBe(visible)
  return state(page)
}

async function showS1(page: Page): Promise<void> {
  const result = await page.evaluate(() =>
    (window as unknown as TestWindow).quickask!.window.show()
  )
  expect(result.ok).toBe(true)
  await waitVisible(page, true)
  await page.waitForFunction(
    () =>
      document.querySelector('[data-testid="app-root"]')?.getAttribute('data-ui-mode') === 'S1'
  )
}

async function setMode(page: Page, mode: string): Promise<void> {
  const result = await page.evaluate(
    (next) => (window as unknown as TestWindow).quickask!.window.setMode(next),
    mode
  )
  expect(result.ok).toBe(true)
  await page.waitForFunction(
    (expected) =>
      document.querySelector('[data-testid="app-root"]')?.getAttribute('data-ui-mode') ===
      expected,
    mode,
    { timeout: 6000 }
  )
}

async function bootstrap(page: Page): Promise<BootstrapLike> {
  const result = await page.evaluate(() =>
    (window as unknown as TestWindow).quickask!.app.bootstrap()
  )
  expect(result.ok).toBe(true)
  return result.data as BootstrapLike
}

async function setProvider(page: Page, baseUrl: string): Promise<void> {
  const created = await page.evaluate(async ({ url }) => {
    const api = (window as unknown as TestWindow).quickask!
    const existing = await api.provider.list()
    for (const profile of existing.data?.profiles ?? []) {
      await api.provider.delete({ id: profile.id })
    }
    return api.provider.create({
      name: 'gherkin-mock',
      baseUrl: url,
      model: 'mock',
      isDefault: true
    })
  }, { url: baseUrl })
  expect(created.ok).toBe(true)
}

function sendHotkey(): void {
  execFileSync('xdotool', ['key', '--clearmodifiers', 'ctrl+alt+space'], {
    env: { ...process.env, DISPLAY },
    timeout: 5000
  })
}

function xdotoolKey(key: string): void {
  execFileSync('xdotool', ['key', '--clearmodifiers', key], {
    env: { ...process.env, DISPLAY },
    timeout: 5000
  })
}

function focusedWindow(): string {
  return execFileSync('xdotool', ['getwindowfocus'], {
    env: { ...process.env, DISPLAY },
    encoding: 'utf8',
    timeout: 3000
  }).trim()
}

async function mainWindowId(app: ElectronApplication): Promise<number> {
  return app.evaluate(({ BrowserWindow }) => {
    const windows = BrowserWindow.getAllWindows()
    const main =
      windows.find((window) => !window.webContents.getURL().includes('settings=1')) ?? windows[0]
    if (!main) return 0
    const handle = main.getNativeWindowHandle()
    if (!handle || handle.length < 4) return 0
    if (handle.length >= 8) return Number(handle.readBigUInt64LE(0) & 0xffffffffn)
    return handle.readUInt32LE(0)
  })
}

function xprop(wid: number, property: string): string {
  return execFileSync('xprop', ['-id', String(wid), property], {
    env: { ...process.env, DISPLAY },
    encoding: 'utf8',
    timeout: 3000
  })
}

async function lastAssistant(page: Page) {
  return page.locator('[data-testid="assistant-message"]').last()
}

async function waitAssistantStatus(page: Page, status: string, timeout = 20_000): Promise<void> {
  await expect
    .poll(async () => (await lastAssistant(page)).getAttribute('data-status'), { timeout })
    .toBe(status)
}

test.describe.configure({ mode: 'serial' })

test.describe('gherkin: REQUIREMENTS §6 G01–G10 (real app, DISPLAY=:0)', () => {
  let appHandle: AppHandle | undefined
  let mock: MockHandle | undefined
  let secondary: AppHandle | undefined

  test.afterEach(async () => {
    await closeApp(secondary)
    secondary = undefined
    await closeApp(appHandle)
    appHandle = undefined
    await stopMock(mock)
    mock = undefined
  })

  test('G01 热键唤起且不污染任务栏', async () => {
    const root = prepareRoot('quickask-gherkin-g01-')
    appHandle = await launchApp(root)
    const { app, page } = appHandle

    const hidden = await state(page)
    expect(hidden.visible).toBe(false)
    expect(hidden.mode).toBe('S0')

    sendHotkey()
    const shown = await waitVisible(page, true)
    expect(shown.mode).toBe('S1')

    await page.waitForFunction(
      () => {
        const el = document.activeElement as HTMLElement | null
        return el?.getAttribute('data-testid') === 'composer'
      },
      { timeout: 6000 }
    )
    const wid = await mainWindowId(app)
    expect(wid).toBeGreaterThan(0)
    await expect.poll(() => focusedWindow(), { timeout: 6000 }).toBe(String(wid))

    const atoms = xprop(wid, '_NET_WM_STATE')
    const wmClass = xprop(wid, 'WM_CLASS')
    expect(atoms).toContain('_NET_WM_STATE_SKIP_TASKBAR')
    expect(atoms).toContain('_NET_WM_STATE_SKIP_PAGER')
    expect(atoms).toContain('_KDE_NET_WM_STATE_SKIP_SWITCHER')
    expect(atoms).toContain('_NET_WM_STATE_ABOVE')
    expect(wmClass).toContain('"quickask"')

    const nfr04 = readJson(join(M1_EVIDENCE_DIR, 'nfr04-summary.json')) as {
      checks?: Record<string, boolean>
      verdict?: string
    }
    expect(nfr04.verdict).toBe('PASS')
    expect(nfr04.checks?.['five_switcher_screenshots']).toBe(true)
    expect(nfr04.checks?.['quickask_not_active_during_switcher']).toBe(true)
    const altTabFiles = [1, 2, 3, 4, 5].map((index) =>
      join(M1_EVIDENCE_DIR, `alt-tab-${index}.png`)
    )
    for (const file of altTabFiles) expect(existsSync(file)).toBe(true)

    sendHotkey()
    const rehidden = await waitVisible(page, false)
    expect(rehidden.mode).toBe('S0')

    writeJson('G01.json', {
      gherkin: 'G01',
      scenario: '热键唤起且不污染任务栏',
      verdict: 'PASS',
      observed: {
        startsHidden: hidden.mode,
        shownMode: shown.mode,
        visible: shown.visible,
        x11FocusWid: wid,
        focusedWindow: focusedWindow(),
        activeTestId: 'composer',
        xpropAtoms: atoms.trim(),
        xpropWmClass: wmClass.trim(),
        hiddenAgain: rehidden.mode
      },
      osEvidence: {
        nfr04: '.omo/evidence/m1/nfr04-summary.json',
        altTabScreenshots: '.omo/evidence/m1/alt-tab-1..5.png',
        xprop: '.omo/evidence/m1/xprop.txt'
      }
    })
  })

  test('G02 中文输入不误发 (IME guard + real fcitx5 evidence)', async () => {
    const root = prepareRoot('quickask-gherkin-g02-')
    mock = await startMock(root, 'normal', ['--chunks', '2', '--delay', '10', '--mode', 'normal'])
    appHandle = await launchApp(root)
    const { page } = appHandle
    await showS1(page)
    await setProvider(page, `http://127.0.0.1:${mock.port}/v1`)

    const composer = page.locator('[data-testid="composer"]')
    await composer.fill('composition-text')
    await page.evaluate(() => {
      const el = document.querySelector('[data-testid="composer"]') as HTMLTextAreaElement
      el.focus()
      el.dispatchEvent(new CompositionEvent('compositionstart', { bubbles: true, data: '' }))
    })
    await page.evaluate(() => {
      const el = document.querySelector('[data-testid="composer"]') as HTMLTextAreaElement
      el.focus()
      el.dispatchEvent(
        new KeyboardEvent('keydown', {
          key: 'Enter',
          code: 'Enter',
          keyCode: 229,
          which: 229,
          bubbles: true,
          cancelable: true,
          isComposing: true
        })
      )
    })
    await delay(250)
    const before = { posts: postCount(mock), value: await composer.inputValue() }
    expect(before.posts).toBe(0)
    expect(before.value).toBe('composition-text')
    expect((await state(page)).visible).toBe(true)

    await page.evaluate(() => {
      const el = document.querySelector('[data-testid="composer"]') as HTMLTextAreaElement
      el.dispatchEvent(new CompositionEvent('compositionend', { bubbles: true, data: 'text' }))
    })
    await composer.press('Enter')
    await expect.poll(() => postCount(mock!), { timeout: 8000 }).toBe(1)

    const nfr08 = readJson(join(M1_EVIDENCE_DIR, 'nfr08.json')) as {
      enter_composing?: { posts_delta?: number; raw_pinyin_commit?: boolean }
      enter_committed?: { posts_delta?: number; chinese_commit?: boolean; value_after_space?: string }
      limitation?: string
    }
    expect(nfr08.enter_composing?.posts_delta).toBe(0)
    expect(nfr08.enter_composing?.raw_pinyin_commit).toBe(true)
    expect(nfr08.enter_committed?.posts_delta).toBe(1)
    expect(nfr08.enter_committed?.chinese_commit).toBe(true)
    expect(nfr08.enter_committed?.value_after_space).toBe('你好')
    expect(typeof nfr08.limitation).toBe('string')

    writeJson('G02.json', {
      gherkin: 'G02',
      scenario: '中文输入不误发',
      verdict: 'PARTIAL',
      verdictReason:
        'App-side composing Enter guard is PASS (0 POST). This host fcitx5/Rime maps Return to CommitRawInput, so strict "Enter commits Chinese" is not achieved; Space commits 你好 then Enter sends 1 POST. User acceptance needed.',
      observed: {
        composingEnterPostsDelta: 0,
        composedValueAfterEnter: before.value,
        windowVisibleAfterComposingEnter: true,
        postsAfterCompositionEndAndEnter: 1
      },
      realFcitxEvidence: {
        file: '.omo/evidence/m1/nfr08.json',
        candidate: '.omo/evidence/m1/nfr08-candidate.png',
        candidateJson: '.omo/evidence/m1/nfr08-candidate.json',
        serverBodyLog: '.omo/evidence/m1/nfr08-server-body.log',
        enterComposing: nfr08.enter_composing ?? null,
        enterCommitted: nfr08.enter_committed ?? null,
        limitation: nfr08.limitation ?? null
      }
    })
  })

  test('G03 流式生成与停止', async () => {
    const root = prepareRoot('quickask-gherkin-g03-')
    mock = await startMock(root, 'slow', ['--mode', 'slow', '--chunks', '40', '--delay', '80'])
    appHandle = await launchApp(root)
    const { page } = appHandle
    await showS1(page)
    await setProvider(page, `http://127.0.0.1:${mock.port}/v1`)

    const composer = page.locator('[data-testid="composer"]')
    await composer.fill('stop this stream')
    await page.keyboard.press('Enter')
    await expect.poll(async () => (await state(page)).mode, { timeout: 8000 }).toBe('S2')
    await expect.poll(() => postCount(mock!), { timeout: 8000 }).toBe(1)

    const assistant = page.locator('[data-testid="assistant-message"]').last()
    await expect
      .poll(async () => (await assistant.locator('[data-testid="markdown"]').textContent())?.length ?? 0, {
        timeout: 10_000
      })
      .toBeGreaterThan(0)
    await expect(page.locator('[data-testid="btn-stop"]')).toBeVisible()
    const beforeStop = (await assistant.locator('[data-testid="markdown"]').textContent()) ?? ''

    await page.locator('[data-testid="btn-stop"]').click()
    await waitAssistantStatus(page, 'stopped', 15_000)
    await expect(assistant.locator('[data-testid="msg-status"]')).toHaveText('已停止')
    const afterStop = (await assistant.locator('[data-testid="markdown"]').textContent()) ?? ''
    expect(afterStop.trimEnd().startsWith(beforeStop.trim())).toBe(true)
    await expect(page.locator('[data-testid="btn-stop"]')).toHaveCount(0)

    await delay(700)
    const later = (await assistant.locator('[data-testid="markdown"]').textContent()) ?? ''
    expect(later).toBe(afterStop)
    await expect.poll(() => readFileSync(mock!.logPath, 'utf8'), { timeout: 5000 }).toContain(
      'client closed after'
    )
    expect(postCount(mock)).toBe(1)

    writeJson('G03.json', {
      gherkin: 'G03',
      scenario: '流式生成与停止',
      verdict: 'PASS',
      observed: {
        status: 'stopped',
        label: '已停止',
        beforeStopChars: beforeStop.length,
        afterStopChars: afterStop.length,
        afterWaitChars: later.length,
        stopButtonCountAfter: 0,
        posts: postCount(mock),
        serverSawClientClose: true
      },
      evidence: {
        e2e: 'tests/e2e/gherkin.spec.ts G03',
        existing: 'tests/e2e/panel.spec.ts:729 stop preserves the generated text and retry replaces the same row'
      }
    })
  })

  test('G04 多轮上下文', async () => {
    const root = prepareRoot('quickask-gherkin-g04-')
    mock = await startMock(root, 'normal', ['--mode', 'normal', '--chunks', '2', '--delay', '10'])
    appHandle = await launchApp(root)
    const { page } = appHandle
    await showS1(page)
    await setProvider(page, `http://127.0.0.1:${mock.port}/v1`)

    const composer = page.locator('[data-testid="composer"]')
    await composer.fill('第一轮问题')
    await page.keyboard.press('Enter')
    await expect.poll(async () => (await state(page)).mode, { timeout: 8000 }).toBe('S2')
    await expect.poll(() => postCount(mock!), { timeout: 8000 }).toBe(1)
    await waitAssistantStatus(page, 'complete')

    await composer.fill('第二轮追问')
    await page.keyboard.press('Enter')
    await expect.poll(() => postCount(mock!), { timeout: 8000 }).toBe(2)
    await waitAssistantStatus(page, 'complete')

    await expect.poll(() => bodyCount(mock!), { timeout: 8000 }).toBe(2)
    const bodies = readFileSync(mock!.bodyLogPath, 'utf8')
      .split('\n')
      .filter((line) => line.trim().length > 0)
      .map((line) => JSON.parse(line) as { messages?: Array<{ role: string; content: string }> })
    const second = bodies[1]!
    const messages = second.messages ?? []
    const userContents = messages.filter((message) => message.role === 'user').map((message) => message.content)
    expect(userContents).toEqual(['第一轮问题', '第二轮追问'])
    const assistantContents = messages.filter((message) => message.role === 'assistant').map((message) => message.content)
    expect(assistantContents.length).toBe(1)
    expect(assistantContents[0]).toContain('chunk 1')

    const sessionState = await page.evaluate(() =>
      (window as unknown as TestWindow).quickask!.sessions.state()
    )
    expect(sessionState.ok).toBe(true)
    expect(sessionState.data!.messages.map((message) => message.role)).toEqual([
      'user',
      'assistant',
      'user',
      'assistant'
    ])

    writeJson('G04.json', {
      gherkin: 'G04',
      scenario: '多轮上下文',
      verdict: 'PASS',
      observed: {
        posts: 2,
        secondRequestMessages: messages,
        persistedRoles: sessionState.data!.messages.map((message) => message.role)
      },
      evidence: {
        e2e: 'tests/e2e/gherkin.spec.ts G04',
        integration: 'tests/integration/chat-orchestrator.test.ts multiTurn',
        existing: '.omo/evidence/task-16-summary.json multiTurn'
      }
    })
  })

  test('G05 历史持久化', async () => {
    const root = prepareRoot('quickask-gherkin-g05-')
    mock = await startMock(root, 'normal', ['--mode', 'normal', '--chunks', '2', '--delay', '10'])

    appHandle = await launchApp(root)
    const first = appHandle
    await showS1(first.page)
    await setProvider(first.page, `http://127.0.0.1:${mock.port}/v1`)
    const composer = first.page.locator('[data-testid="composer"]')
    await composer.fill('持久化测试 G05 唯一内容')
    await first.page.keyboard.press('Enter')
    await expect.poll(async () => (await state(first.page)).mode, { timeout: 8000 }).toBe('S2')
    await expect.poll(() => postCount(mock!), { timeout: 8000 }).toBe(1)
    await waitAssistantStatus(first.page, 'complete')

    const before = await first.page.evaluate(() =>
      (window as unknown as TestWindow).quickask!.sessions.state()
    )
    expect(before.ok).toBe(true)
    const sessionId = before.data!.currentSessionId!
    expect(sessionId).toBeTruthy()
    const beforeMessages = before.data!.messages
    expect(beforeMessages.map((message) => message.role)).toEqual(['user', 'assistant'])
    expect(beforeMessages[0]!.content).toBe('持久化测试 G05 唯一内容')

    const exit = await quitApp(first)
    expect(exit.code).toBe(0)
    appHandle = undefined

    await delay(300)
    appHandle = await launchApp(root)
    const second = appHandle
    await showS1(second.page)
    const listed = await second.page.evaluate(() =>
      (window as unknown as TestWindow).quickask!.sessions.list({ limit: 20 })
    )
    expect(listed.ok).toBe(true)
    expect(listed.data!.sessions.map((session) => session.id)).toContain(sessionId)
    const opened = await second.page.evaluate(
      async (id) => (window as unknown as TestWindow).quickask!.sessions.open({ id }),
      sessionId
    )
    expect(opened.ok).toBe(true)
    expect(opened.data!.messages.map((message) => message.role)).toEqual(['user', 'assistant'])
    expect(opened.data!.messages[0]!.content).toBe('持久化测试 G05 唯一内容')
    expect(opened.data!.messages[1]!.content).toBe(beforeMessages[1]!.content)

    await second.page.locator('[data-testid="btn-history"]').click()
    await expect
      .poll(
        () =>
          second.page
            .locator('[data-testid="app-root"]')
            .getAttribute('data-ui-mode'),
        { timeout: 6000 }
      )
      .toBe('S3')
    const firstItem = second.page.locator('[data-testid="history-item"]').first()
    await expect(firstItem).toBeVisible()
    await expect(firstItem).toContainText('持久化测试')

    writeJson('G05.json', {
      gherkin: 'G05',
      scenario: '历史持久化',
      verdict: 'PASS',
      observed: {
        sessionId,
        beforeRoles: beforeMessages.map((message) => message.role),
        afterRestartSessionFound: true,
        afterRoles: opened.data!.messages.map((message) => message.role),
        assistantContentSame: opened.data!.messages[1]!.content === beforeMessages[1]!.content,
        historySidebarMode: await second.page
          .locator('[data-testid="app-root"]')
          .getAttribute('data-ui-mode'),
        historyItemVisible: await firstItem.isVisible(),
        quitExitCode: exit.code
      },
      dataDir: join(root, 'data', 'quickask-db'),
      evidence: {
        e2e: 'tests/e2e/gherkin.spec.ts G05',
        existing: [
          'tests/e2e/crash-recovery.spec.ts:458 kill -9 restart restores interrupted content',
          'tests/e2e/session.spec.ts:676 restart picks the most recent session'
        ]
      }
    })
  })

  test('G06 未配置 key 的首次启动', async () => {
    const root = prepareRoot('quickask-gherkin-g06-')
    appHandle = await launchApp(root, false)
    const { app, page } = appHandle
    const requests: Array<{ page: string; url: string; method: string }> = []
    const track = (target: Page, role: string): void => {
      target.on('request', (request) => {
        if (/^https?:/i.test(request.url())) {
          requests.push({ page: role, url: request.url(), method: request.method() })
        }
      })
    }
    track(page, 'main')

    const settings = await (async (): Promise<Page> => {
      await expect
        .poll(() => app.windows().filter((entry) => entry.url().includes('settings=1')).length, {
          timeout: 10_000
        })
        .toBe(1)
      const found = app.windows().find((entry) => entry.url().includes('settings=1'))!
      await found.waitForLoadState('domcontentloaded')
      await found.waitForFunction(() => Boolean((window as unknown as TestWindow).quickask))
      track(found, 'settings')
      return found
    })()

    await expect.poll(() => settings.url().includes('onboarding=1')).toBe(true)
    await expect(settings.locator('[data-testid="onboarding-wizard"]')).toBeVisible()
    const mainState = await state(page)
    expect(mainState.mode).toBe('S0')
    expect(mainState.visible).toBe(false)

    await showS1(page)
    await expect(page.locator('[data-testid="composer"]')).toBeDisabled()
    await expect(page.locator('[data-testid="composer"]')).toHaveAttribute('placeholder', '请先配置模型')
    await expect(page.locator('[data-testid="btn-send"]')).toBeDisabled()
    const boot = await bootstrap(page)
    expect(boot.onboarding.required).toBe(true)
    expect(boot.onboarding.reason).toBe('no_profile')

    await delay(700)
    expect(requests).toEqual([])

    writeJson('G06.json', {
      gherkin: 'G06',
      scenario: '未配置 key 的首次启动',
      verdict: 'PASS',
      observed: {
        settingsUrl: settings.url(),
        onboardingWizardVisible: true,
        mainMode: mainState.mode,
        composerDisabled: true,
        placeholder: '请先配置模型',
        sendDisabled: true,
        onboarding: boot.onboarding,
        httpRequests: requests
      },
      evidence: {
        e2e: 'tests/e2e/gherkin.spec.ts G06',
        existing: 'tests/e2e/settings.spec.ts:406 empty data dir auto-opens S4 onboarding, main hidden, zero requests',
        screenshot: '.omo/evidence/m1/onboarding.png'
      }
    })
  })

  test('G07 毛玻璃降级', async () => {
    const root = prepareRoot('quickask-gherkin-g07-')
    appHandle = await launchApp(root)
    const { app, page } = appHandle
    await showS1(page)
    const boot = await bootstrap(page)
    expect(boot.blurStatus.available).toBe(false)
    expect(boot.blurStatus.compositor).toBe(true)
    expect(boot.blurStatus.effectEnabled).toBe(false)
    expect(typeof boot.blurStatus.reason).toBe('string')
    expect(boot.blurStatus.reason!.length).toBeGreaterThan(0)
    expect(boot.opaqueMode).toBe(false)

    const wid = await mainWindowId(app)
    const blurProp = xprop(wid, '_KDE_NET_WM_BLUR_BEHIND_REGION')
    expect(blurProp).toContain('not found')

    const nfr07 = readJson(join(M1_EVIDENCE_DIR, 'nfr07-summary.json')) as {
      verdict?: string
      blur_available?: boolean
      honest_degrade?: boolean
      compositor_off?: {
        compositorActive?: boolean
        opaqueMode?: boolean
        blurStatus?: { available?: boolean; reason?: string; compositor?: boolean }
        boundingShape?: { count?: number; rects?: Array<{ width?: number; height?: number }> }
      }
      compositor_on?: { compositorActive?: boolean; opaqueMode?: boolean; blurProperty?: string }
    }
    expect(nfr07.verdict).toBe('PASS (degraded)')
    expect(nfr07.blur_available).toBe(false)
    expect(nfr07.honest_degrade).toBe(true)
    expect(nfr07.compositor_off?.compositorActive).toBe(false)
    expect(nfr07.compositor_off?.opaqueMode).toBe(true)
    expect(nfr07.compositor_off?.blurStatus?.available).toBe(false)
    expect(nfr07.compositor_off?.boundingShape?.count).toBe(2)
    expect(nfr07.compositor_on?.compositorActive).toBe(true)
    expect(nfr07.compositor_on?.opaqueMode).toBe(false)

    writeJson('G07.json', {
      gherkin: 'G07',
      scenario: '毛玻璃降级',
      verdict: 'PASS (degraded; blur itself not available on this host)',
      verdictReason:
        'KWin Blur effect is OFF. The window falls back to an opaque, card-shaped window when compositing is off and restores the transparent gutter when compositing is on. Blur is not claimed.',
      observed: {
        liveBlurStatus: boot.blurStatus,
        liveOpaqueMode: boot.opaqueMode,
        liveBlurProperty: blurProp.trim(),
        compositorOffFallback: nfr07.compositor_off ?? null,
        compositorOn: nfr07.compositor_on ?? null
      },
      evidence: {
        nfr07: '.omo/evidence/m1/nfr07-summary.json',
        compositorOff: [
          '.omo/evidence/m1/nfr07-compositor-off.json',
          '.omo/evidence/m1/nfr07-compositor-off.png'
        ],
        compositorOn: [
          '.omo/evidence/m1/nfr07-compositor-on.json',
          '.omo/evidence/m1/nfr07-compositor-on.png'
        ],
        e2e: [
          'tests/e2e/gherkin.spec.ts G07',
          'tests/e2e/appearance.spec.ts:699 blur is honest: disabled toggle, reason, no property and no backdrop-filter',
          'tests/e2e/appearance.spec.ts:752 compositor off switches to opaque ShapeBounding; on restores transparency'
        ]
      }
    })
  })

  test('G08 多屏唤起 (single-display host limitation)', async () => {
    const primary = { x: 0, y: 0, width: 1920, height: 1080 }
    const secondary = { x: 1920, y: 0, width: 2560, height: 1440 }
    const expectedPrimary = defaultAnchor(primary, 680)
    const expectedSecondary = defaultAnchor(secondary, 680)
    expect(expectedPrimary).toEqual({ x: 620, y: 130 })
    expect(expectedSecondary).toEqual({ x: 2860, y: 173 })

    const nfr06 = readJson(join(M1_EVIDENCE_DIR, 'nfr06-summary.json')) as {
      verdict?: string
      displays?: Array<{ id: number; workArea: { width: number } }>
      cursor_display_anchor?: { x: number; y: number }
      expected_default_anchor?: { x: number; y: number }
      second_monitor?: string
      mixed_dpi?: string
      unit_coverage?: { file?: string; cases?: string[] }
    }
    expect(nfr06.verdict).toBe('PASS (single-display limitation)')
    expect(nfr06.displays?.length).toBe(1)
    expect(nfr06.displays?.[0]?.workArea.width).toBe(1920)
    expect(nfr06.cursor_display_anchor).toEqual({ x: 620, y: 130 })
    expect(nfr06.expected_default_anchor).toEqual({ x: 620, y: 130 })
    expect(nfr06.second_monitor).toContain('not physically available')
    expect(nfr06.mixed_dpi).toContain('not physically tested')
    expect(nfr06.unit_coverage?.cases?.length).toBe(6)

    writeJson('G08.json', {
      gherkin: 'G08',
      scenario: '多屏唤起',
      verdict: 'PARTIAL',
      verdictReason:
        'Only one 1920x1080@100% output exists on this host, so the physical mouse-on-secondary-display path cannot be executed. Pure geometry proves cursor-display default anchors for a simulated 2560x1440 secondary display; NFR-06 records the limitation.',
      simulated: {
        primaryDefaultAnchor: expectedPrimary,
        secondaryDefaultAnchor: expectedSecondary,
        simulatedSecondaryWorkArea: secondary
      },
      live: {
        displays: nfr06.displays,
        cursorDisplayAnchor: nfr06.cursor_display_anchor,
        mixedDpi: nfr06.mixed_dpi,
        secondMonitor: nfr06.second_monitor,
        unitCoverage: nfr06.unit_coverage
      },
      evidence: {
        nfr06: '.omo/evidence/m1/nfr06-summary.json',
        display: '.omo/evidence/m1/nfr06-display.json',
        e2e: [
          'tests/e2e/gherkin.spec.ts G08',
          'tests/e2e/multiscreen-drag.spec.ts:302 S1 show places the bar at the cursor display default anchor',
          'tests/e2e/multiscreen-drag.spec.ts:419 dragging the bar background persists the anchor'
        ],
        unit: 'tests/unit/geometry.test.ts'
      }
    })
  })

  test('G09 单实例', async () => {
    const root = prepareRoot('quickask-gherkin-g09-')
    appHandle = await launchApp(root)
    const { page, env } = appHandle
    const hidden = await state(page)
    expect(hidden.visible).toBe(false)

    const before = await bootstrap(page)
    const started = Date.now()
    const child = spawn(ELECTRON_BIN, ['.'], {
      cwd: resolve('.'),
      env,
      stdio: ['ignore', 'pipe', 'pipe']
    })
    let stdout = ''
    let stderr = ''
    child.stdout?.on('data', (chunk: Buffer) => {
      stdout += chunk.toString()
    })
    child.stderr?.on('data', (chunk: Buffer) => {
      stderr += chunk.toString()
    })
    const exit = await new Promise<{ code: number | null; signal: string | null }>(
      (resolveExit, reject) => {
        const timer = setTimeout(() => reject(new Error('second instance did not exit')), 10_000)
        child.once('exit', (code, signal) => {
          clearTimeout(timer)
          resolveExit({ code, signal })
        })
      }
    )
    const elapsedMs = Date.now() - started
    expect(exit.code).toBe(0)

    const shown = await waitVisible(page, true)
    expect(shown.mode).toBe('S1')
    const after = await bootstrap(page)
    expect(after.hotkey).toEqual(before.hotkey)

    writeJson('G09.json', {
      gherkin: 'G09',
      scenario: '单实例',
      verdict: 'PASS',
      observed: {
        secondInstanceExitCode: exit.code,
        secondInstanceSignal: exit.signal,
        elapsedMs,
        firstWindowVisible: shown.visible,
        firstWindowMode: shown.mode,
        hotkeyStatusStable: after.hotkey === before.hotkey,
        secondInstanceStdout: stdout.slice(0, 400),
        secondInstanceStderr: stderr.slice(0, 400)
      },
      evidence: {
        e2e: 'tests/e2e/gherkin.spec.ts G09',
        existing: [
          'tests/e2e/lifecycle.spec.ts:462 a second instance exits quickly, shows the first window and does not re-register hotkeys',
          '.omo/evidence/task-13-single-instance.log'
        ]
      }
    })
  })

  test('G10 Esc 逐层退出', async () => {
    const root = prepareRoot('quickask-gherkin-g10-')
    appHandle = await launchApp(root)
    const { app, page } = appHandle
    await showS1(page)
    await setMode(page, 'S2')
    await setMode(page, 'S3')
    const atS3 = await state(page)
    expect(atS3.mode).toBe('S3')

    await page.keyboard.press('Escape')
    await expect
      .poll(
        () => page.locator('[data-testid="app-root"]').getAttribute('data-ui-mode'),
        { timeout: 6000 }
      )
      .toBe('S2')
    xdotoolKey('Escape')
    await expect
      .poll(
        () => page.locator('[data-testid="app-root"]').getAttribute('data-ui-mode'),
        { timeout: 6000 }
      )
      .toBe('S1')
    await page.keyboard.press('Escape')
    const hidden = await waitVisible(page, false)
    expect(hidden.mode).toBe('S0')

    expect(app.process().exitCode).toBeNull()
    sendHotkey()
    const reshown = await waitVisible(page, true)
    expect(reshown.mode).toBe('S1')

    writeJson('G10.json', {
      gherkin: 'G10',
      scenario: 'Esc 逐层退出',
      verdict: 'PASS',
      observed: {
        startMode: atS3.mode,
        esc1: 'S2',
        esc2: 'S1',
        esc3: { mode: hidden.mode, visible: hidden.visible },
        processAlive: true,
        hotkeyReshow: { mode: reshown.mode, visible: reshown.visible }
      },
      evidence: {
        e2e: 'tests/e2e/gherkin.spec.ts G10',
        existing: [
          'tests/e2e/focus-esc.spec.ts:823 focus case 1: Esc layers S3 -> S2 -> S1 -> S0 and keeps the process alive',
          '.omo/evidence/task-24-esc.json'
        ]
      }
    })
  })
})
