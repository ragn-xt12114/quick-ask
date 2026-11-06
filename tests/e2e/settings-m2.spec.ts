/**
 * Task 32b — six settings groups, hotkey recording/rollback, behavior, data,
 * about and font-size persistence.
 *
 * Runs against the real Electron app on DISPLAY :0. Hotkey conflicts use the
 * XGrabKey helper from tools/x11-grab-test.c; blur tests use xmessage so the
 * AutoHideController cursor-inside guard cannot mask the blur.
 */
import { _electron as electron, expect, test } from '@playwright/test'
import type { ElectronApplication, Page } from '@playwright/test'
import { execFileSync, spawn, type ChildProcess } from 'node:child_process'
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import type {
  AppPathsInfo,
  BehaviorSettings,
  BootstrapInfo,
  HotkeyStatus,
  Session,
  SessionsStateResult
} from '../../src/shared/channels'

interface IpcResponse<T = unknown> {
  ok: boolean
  data?: T
  error?: { code: string; message: string }
}

interface WindowStateLike {
  mode: string
  visible: boolean
}

interface TestApi {
  app: {
    bootstrap(): Promise<IpcResponse<BootstrapInfo>>
    paths(): Promise<IpcResponse<AppPathsInfo>>
    openPath(kind: 'data' | 'config' | 'logs'): Promise<IpcResponse<{ opened: boolean }>>
    setHotkey(request: { accelerator: string }): Promise<IpcResponse<HotkeyStatus>>
  }
  window: {
    show(): Promise<IpcResponse<WindowStateLike>>
    hide(): Promise<IpcResponse<WindowStateLike>>
    getState(): Promise<IpcResponse<WindowStateLike>>
    setMode(mode: string): Promise<IpcResponse<{ mode: string }>>
    openSettings(options?: { onboarding?: boolean }): Promise<IpcResponse<{ open: boolean }>>
    closeSettings(): Promise<IpcResponse<{ open: boolean }>>
  }
  settings: {
    getAll(): Promise<IpcResponse<{ settings: Record<string, unknown> }>>
    set(request: { key: string; value: unknown }): Promise<IpcResponse<{ saved: boolean }>>
  }
  sessions: {
    list(request?: { limit?: number }): Promise<IpcResponse<{ sessions: Session[] }>>
    create(request?: { title?: string }): Promise<IpcResponse<Session>>
    state(): Promise<IpcResponse<SessionsStateResult>>
    clearAll(): Promise<IpcResponse<{ cleared: number }>>
  }
}

type TestWindow = typeof globalThis & { quickask?: TestApi }

interface GrabHandle {
  child: ChildProcess
  stdout: string
}

const EVIDENCE_DIR = resolve('.omo/evidence/m2/settings')
const GRAB_TOOL = resolve('.omo/evidence/x11-grab-test')
const GRAB_SOURCE = resolve('tools/x11-grab-test.c')
const DISPLAY = process.env['DISPLAY'] ?? ':0'
const XMESSAGE_TITLE = `quickask-task32b-focus-${process.pid}-${Date.now()}`

let app: ElectronApplication | undefined
let mainPage: Page
let settingsPage: Page | undefined
let tempRoot = ''
let xmessageProc: ChildProcess | undefined
let xmessageWid = 0
let grab: GrabHandle | undefined

const evidence: Record<string, unknown> = {}
const pageErrors: string[] = []
const checks = {
  sixTabs: false,
  hotkeyRecordingRollback: false,
  behaviorSettings: false,
  dataPathsAndClear: false,
  about: false,
  fontSize: false
}

function delay(ms: number): Promise<void> {
  return new Promise((resolveDelay) => setTimeout(resolveDelay, ms))
}

function writeEvidence(name: string, value: unknown): void {
  mkdirSync(EVIDENCE_DIR, { recursive: true })
  writeFileSync(join(EVIDENCE_DIR, name), `${JSON.stringify(value, null, 2)}\n`)
}

function baseEnv(root: string): Record<string, string> {
  const inherited: Record<string, string> = {}
  for (const [key, value] of Object.entries(process.env)) {
    if (value !== undefined) inherited[key] = value
  }
  return {
    ...inherited,
    DISPLAY,
    XDG_CONFIG_HOME: join(root, 'config'),
    XDG_DATA_HOME: join(root, 'data'),
    XDG_STATE_HOME: join(root, 'state'),
    QUICKASK_DATA_DIR: join(root, 'data', 'quickask-db'),
    QUICKASK_DISABLE_ONBOARDING: '1'
  }
}

function ensureGrabTool(): void {
  mkdirSync(EVIDENCE_DIR, { recursive: true })
  if (existsSync(GRAB_TOOL)) return
  execFileSync('gcc', ['-O2', '-o', GRAB_TOOL, GRAB_SOURCE, '-lX11'], {
    cwd: process.cwd(),
    timeout: 30_000
  })
}

async function launch(): Promise<void> {
  app = await electron.launch({ args: ['.'], env: baseEnv(tempRoot) })
  const first = await app.firstWindow()
  first.on('pageerror', (error) => pageErrors.push(error.message))
  await first.waitForLoadState('domcontentloaded')
  await first.waitForFunction(() => Boolean((window as unknown as TestWindow).quickask))
  mainPage =
    app.windows().find((page) => !page.url().includes('settings=1')) ?? first
  mainPage.on('pageerror', (error) => pageErrors.push(error.message))
  settingsPage = undefined
}

async function closeApp(): Promise<void> {
  if (!app) return
  const current = app
  app = undefined
  settingsPage = undefined
  try {
    await Promise.race([current.close(), delay(5000)])
  } catch {
    const proc = current.process()
    if (proc.exitCode === null) proc.kill('SIGTERM')
  }
  await delay(400)
}

function settingsWindows(): Page[] {
  if (!app) return []
  return app.windows().filter((page) => page.url().includes('settings=1'))
}

async function openSettings(): Promise<Page> {
  const result = await mainPage.evaluate(() =>
    (window as unknown as TestWindow).quickask!.window.openSettings()
  )
  expect(result.ok).toBe(true)
  await expect.poll(() => settingsWindows().length, { timeout: 10_000 }).toBe(1)
  const page = settingsWindows()[0]!
  await page.waitForLoadState('domcontentloaded')
  await page.waitForFunction(() => Boolean((window as unknown as TestWindow).quickask))
  page.on('pageerror', (error) => pageErrors.push(error.message))
  settingsPage = page
  return page
}

async function closeSettings(): Promise<void> {
  if (settingsWindows().length === 0) return
  await mainPage.evaluate(() =>
    (window as unknown as TestWindow).quickask!.window.closeSettings()
  )
  await expect.poll(() => settingsWindows().length, { timeout: 10_000 }).toBe(0)
  settingsPage = undefined
}

function runXdotool(args: string[]): string {
  return execFileSync('xdotool', args, {
    env: { ...process.env, DISPLAY },
    encoding: 'utf8',
    timeout: 5000
  }).trim()
}

function windowId(page: Page): Promise<number> {
  return app!.evaluate(
    ({ BrowserWindow }, url) => {
      const window = BrowserWindow.getAllWindows().find(
        (entry) => entry.webContents.getURL() === url
      )
      if (!window) return 0
      const handle = window.getNativeWindowHandle()
      if (handle.length >= 8) return Number(handle.readBigUInt64LE(0) & 0xffffffffn)
      return handle.readUInt32LE(0)
    },
    page.url()
  )
}

function focusedWid(): number {
  try {
    const value = Number.parseInt(runXdotool(['getwindowfocus']), 10)
    return Number.isFinite(value) ? value : 0
  } catch {
    return 0
  }
}

function hexWid(wid: number): string {
  return `0x${wid.toString(16)}`
}

function forceFocus(wid: number): void {
  for (let attempt = 0; attempt < 5; attempt += 1) {
    try {
      runXdotool(['windowactivate', '--sync', hexWid(wid)])
    } catch {
      continue
    }
    if (focusedWid() === wid) return
  }
  try {
    const geometry = runXdotool(['getwindowgeometry', '--shell', String(wid)])
    const x = Number(/(?:^|\n)X=(-?\d+)/.exec(geometry)?.[1] ?? 0)
    const y = Number(/(?:^|\n)Y=(-?\d+)/.exec(geometry)?.[1] ?? 0)
    const width = Number(/(?:^|\n)WIDTH=(\d+)/.exec(geometry)?.[1] ?? 0)
    const height = Number(/(?:^|\n)HEIGHT=(\d+)/.exec(geometry)?.[1] ?? 0)
    runXdotool(['mousemove', '--sync', String(x + Math.floor(width / 2)), String(y + Math.floor(height / 2))])
    runXdotool(['click', '1'])
  } catch {
    return
  }
}

async function focusSettings(page: Page): Promise<void> {
  await app!.evaluate(
    ({ BrowserWindow }, url) => {
      const window = BrowserWindow.getAllWindows().find(
        (entry) => entry.webContents.getURL() === url
      )
      if (!window) return
      window.show()
      window.focus()
      window.webContents.focus()
    },
    page.url()
  )
  const wid = await windowId(page)
  if (wid > 0) forceFocus(wid)
  await expect.poll(() => page.evaluate(() => document.hasFocus()), { timeout: 5000 }).toBe(true)
}

async function focusMain(): Promise<void> {
  const wid = await windowId(mainPage)
  if (wid > 0) forceFocus(wid)
  await expect
    .poll(
      () =>
        app!.evaluate(({ BrowserWindow }) => {
          const windows = BrowserWindow.getAllWindows()
          const main =
            windows.find((window) => !window.webContents.getURL().includes('settings=1')) ??
            windows[0]
          return Boolean(main && main.isFocused())
        }),
      { timeout: 5000 }
    )
    .toBe(true)
}

async function windowState(): Promise<WindowStateLike> {
  const result = await mainPage.evaluate(() =>
    (window as unknown as TestWindow).quickask!.window.getState()
  )
  expect(result.ok).toBe(true)
  return result.data as WindowStateLike
}

async function showMain(): Promise<void> {
  const state = await windowState()
  if (!state.visible) {
    const shown = await mainPage.evaluate(() =>
      (window as unknown as TestWindow).quickask!.window.show()
    )
    expect(shown.ok).toBe(true)
  }
  await expect.poll(async () => (await windowState()).visible, { timeout: 8000 }).toBe(true)
  if ((await windowState()).mode !== 'S1') {
    const mode = await mainPage.evaluate(() =>
      (window as unknown as TestWindow).quickask!.window.setMode('S1')
    )
    expect(mode.ok).toBe(true)
  }
  await mainPage.waitForFunction(
    () =>
      document.querySelector('[data-testid="app-root"]')?.getAttribute('data-ui-mode') ===
      'S1'
  )
}

async function setMainMode(mode: 'S1' | 'S2' | 'S3'): Promise<void> {
  const result = await mainPage.evaluate(
    (next) => (window as unknown as TestWindow).quickask!.window.setMode(next),
    mode
  )
  expect(result.ok).toBe(true)
  await mainPage.waitForFunction(
    (expected) =>
      document.querySelector('[data-testid="app-root"]')?.getAttribute('data-ui-mode') ===
      expected,
    mode
  )
}

async function bootstrap(): Promise<BootstrapInfo> {
  const result = await mainPage.evaluate(() =>
    (window as unknown as TestWindow).quickask!.app.bootstrap()
  )
  expect(result.ok).toBe(true)
  return result.data as BootstrapInfo
}

async function setRange(page: Page, testId: string, value: number): Promise<void> {
  await page.locator(`[data-testid="${testId}"]`).evaluate((element, next) => {
    const input = element as HTMLInputElement
    const setter = Object.getOwnPropertyDescriptor(
      window.HTMLInputElement.prototype,
      'value'
    )?.set
    setter?.call(input, String(next))
    input.dispatchEvent(new Event('input', { bubbles: true }))
    input.dispatchEvent(new Event('change', { bubbles: true }))
  }, value)
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
      'Task 32b focus target'
    ],
    { env: { ...process.env, DISPLAY }, stdio: ['ignore', 'ignore', 'ignore'] }
  )
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
      // window not mapped yet
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

async function focusXmessage(): Promise<void> {
  expect(xmessageWid).toBeGreaterThan(0)
  try {
    runXdotool(['mousemove', '--window', String(xmessageWid), '30', '30'])
  } catch {
    // fall through to windowactivate
  }
  forceFocus(xmessageWid)
  try {
    runXdotool(['click', '1'])
  } catch {
    // windowactivate was the primary path
  }
  await expect.poll(() => focusedWid(), { timeout: 5000 }).toBe(xmessageWid)
}

function startGrab(combo: string): Promise<void> {
  ensureGrabTool()
  return new Promise<void>((resolveGrab, reject) => {
    const child = spawn(GRAB_TOOL, [combo, '30'], {
      env: { ...process.env, DISPLAY },
      stdio: ['ignore', 'pipe', 'pipe']
    })
    grab = { child, stdout: '' }
    const timer = setTimeout(() => reject(new Error('grab helper did not print GRABBED')), 5000)
    child.stdout?.setEncoding('utf8')
    child.stdout?.on('data', (chunk: string) => {
      grab!.stdout += chunk
      if (grab!.stdout.includes('GRABBED')) {
        clearTimeout(timer)
        resolveGrab()
      }
    })
    child.stderr?.setEncoding('utf8')
    child.once('exit', (code) => {
      clearTimeout(timer)
      if (!grab?.stdout.includes('GRABBED')) {
        reject(new Error(`grab helper exited early with code ${code}`))
      }
    })
  })
}

async function stopGrab(): Promise<void> {
  const current = grab?.child
  grab = undefined
  if (!current || current.exitCode !== null) return
  const exited = new Promise<void>((resolveExit) => {
    current.once('exit', () => resolveExit())
  })
  current.kill('SIGTERM')
  await Promise.race([exited, delay(2000)])
  if (current.exitCode === null) current.kill('SIGKILL')
  await Promise.race([exited, delay(1000)])
}

async function recordHotkey(page: Page, keys: string): Promise<void> {
  await focusSettings(page)
  await page.locator('[data-testid="hotkey-recorder"]').click()
  await page.keyboard.press(keys)
}

async function allSettings(): Promise<Record<string, unknown>> {
  const result = await mainPage.evaluate(() =>
    (window as unknown as TestWindow).quickask!.settings.getAll()
  )
  expect(result.ok).toBe(true)
  return result.data?.settings ?? {}
}

test.describe.configure({ mode: 'serial' })

test.beforeAll(async () => {
  tempRoot = mkdtempSync(join(tmpdir(), 'quickask-task32b-'))
  for (const dir of ['config', 'data', 'state']) {
    mkdirSync(join(tempRoot, dir), { recursive: true })
  }
  mkdirSync(EVIDENCE_DIR, { recursive: true })
  ensureGrabTool()
  await launch()
  await startXmessage()
})

test.afterAll(async () => {
  await closeSettings()
  await stopGrab()
  await closeApp()
  await stopXmessage()

  const summary = {
    task: '32b',
    title: 'settings UI/behavior (six groups, hotkey recording, behavior/data/about/font)',
    generatedAt: new Date().toISOString(),
    verdict: Object.values(checks).every(Boolean) ? 'PASS' : 'FAIL',
    checks,
    display: DISPLAY,
    evidence: {
      tabs: 'task-32b-tabs.json',
      hotkey: 'task-32b-hotkey.json',
      behavior: 'task-32b-behavior.json',
      data: 'task-32b-data.json',
      about: 'task-32b-about.json',
      fontSize: 'task-32b-fontsize.json',
      screenshots: [
        'task-32b-tabs.png',
        'task-32b-hotkey.png',
        'task-32b-behavior.png',
        'task-32b-data.png',
        'task-32b-fontsize.png'
      ]
    },
    pageErrors,
    evidenceMap: evidence
  }
  writeEvidence('task-32b-summary.json', summary)
  try {
    rmSync(tempRoot, { recursive: true, force: true })
  } catch {
    // best effort
  }
})

test('six settings tabs render their panels without coming-soon placeholders', async () => {
  const page = await openSettings()
  await expect(page.locator('[data-testid="settings"]')).toBeVisible()

  const navLabels = [
    '模型',
    '外观',
    '快捷键',
    '行为',
    '数据',
    '关于'
  ]
  const navText = await page.locator('[data-testid="settings-nav"]').innerText()
  for (const label of navLabels) expect(navText).toContain(label)
  expect(navText).not.toContain('即将支持')

  const panels = [
    ['settings-tab-model', 'model-panel'],
    ['settings-tab-appearance', 'appearance-panel'],
    ['settings-tab-shortcut', 'shortcut-panel'],
    ['settings-tab-behavior', 'behavior-panel'],
    ['settings-tab-data', 'data-panel'],
    ['settings-tab-about', 'about-panel']
  ] as const
  const rendered: Array<Record<string, unknown>> = []
  for (const [tab, panel] of panels) {
    await page.locator(`[data-testid="${tab}"]`).click()
    await expect(page.locator(`[data-testid="${panel}"]`)).toBeVisible()
    rendered.push({ tab, panel, active: true })
  }
  await page.screenshot({ path: join(EVIDENCE_DIR, 'task-32b-tabs.png') })

  const payload = { navText, rendered, comingPlaceholder: navText.includes('即将支持') }
  writeEvidence('task-32b-tabs.json', payload)
  evidence['tabs'] = payload
  checks.sixTabs = true
})

test('hotkey recorder persists, blocks a grabbed combo and rolls back to the previous hotkey', async () => {
  test.setTimeout(120_000)
  let page = settingsPage ?? (await openSettings())
  await page.locator('[data-testid="settings-tab-shortcut"]').click()
  await expect(page.locator('[data-testid="shortcut-panel"]')).toBeVisible()
  const initial = await bootstrap()
  expect(initial.settings.shortcut.accelerator).toBe('Control+Alt+Space')

  await recordHotkey(page, 'Control+Shift+F9')
  await expect(page.locator('[data-testid="hotkey-current"]')).toHaveText(
    'Control+Shift+F9',
    { timeout: 10_000 }
  )
  await expect(page.locator('[data-testid="hotkey-saved"]')).toBeVisible()
  const recordedBoot = await bootstrap()
  expect(recordedBoot.settings.shortcut.accelerator).toBe('Control+Shift+F9')
  expect(recordedBoot.hotkey.accelerator).toBe('Control+Shift+F9')
  await page.screenshot({ path: join(EVIDENCE_DIR, 'task-32b-hotkey.png') })

  await closeApp()
  await launch()
  page = await openSettings()
  await page.locator('[data-testid="settings-tab-shortcut"]').click()
  await expect(page.locator('[data-testid="hotkey-current"]')).toHaveText(
    'Control+Shift+F9',
    { timeout: 10_000 }
  )
  const restartBoot = await bootstrap()
  expect(restartBoot.settings.shortcut.accelerator).toBe('Control+Shift+F9')
  expect(restartBoot.hotkey.accelerator).toBe('Control+Shift+F9')

  await recordHotkey(page, 'Control+Shift+F8')
  await expect(page.locator('[data-testid="hotkey-current"]')).toHaveText(
    'Control+Shift+F8',
    { timeout: 10_000 }
  )

  await startGrab('ctrl+shift+F9')
  try {
    await recordHotkey(page, 'Control+Shift+F9')
    await expect(page.locator('[data-testid="hotkey-error"]')).toBeVisible({
      timeout: 10_000
    })
    await expect(page.locator('[data-testid="hotkey-conflict"]')).toBeVisible()
    await expect(page.locator('[data-testid="hotkey-current"]')).toHaveText(
      'Control+Shift+F8'
    )
    const failedBoot = await bootstrap()
    expect(failedBoot.settings.shortcut.accelerator).toBe('Control+Shift+F8')
    expect(failedBoot.hotkey.accelerator).toBe('Control+Shift+F8')
    const settings = await allSettings()
    expect((settings['shortcut'] as { accelerator: string }).accelerator).toBe(
      'Control+Shift+F8'
    )

    await closeSettings()
    await showMain()
    await focusMain()
    runXdotool(['key', '--clearmodifiers', 'ctrl+shift+F8'])
    await expect.poll(async () => (await windowState()).visible, { timeout: 8000 }).toBe(false)

    const payload = {
      initial: initial.settings.shortcut.accelerator,
      recorded: recordedBoot.settings.shortcut.accelerator,
      afterRestart: restartBoot.settings.shortcut.accelerator,
      grabbed: 'ctrl+shift+F9',
      rollbackHotkey: failedBoot.hotkey.accelerator,
      persistedShortcut: (settings['shortcut'] as { accelerator: string }).accelerator,
      conflict: failedBoot.hotkey.conflict,
      errorVisible: true,
      oldHotkeyToggledWindow: true
    }
    writeEvidence('task-32b-hotkey.json', payload)
    evidence['hotkey'] = payload
    checks.hotkeyRecordingRollback = true
  } finally {
    await stopGrab()
  }
})

test('behavior settings apply immediately and persist after restart', async () => {
  test.setTimeout(120_000)
  let page = settingsPage ?? (await openSettings())
  await page.locator('[data-testid="settings-tab-behavior"]').click()
  await page.locator('[data-testid="behavior-esc-direct"]').check()
  await page.locator('[data-testid="behavior-streaming-delay"]').fill('1000')
  await page.locator('[data-testid="behavior-context-rounds"]').fill('7')
  await expect
    .poll(async () => (await bootstrap()).settings.behavior)
    .toEqual({
      escDirectHide: true,
      hideOnBlur: true,
      streamingHideDelayMs: 1000,
      contextRounds: 7
    })
  await page.screenshot({ path: join(EVIDENCE_DIR, 'task-32b-behavior.png') })

  await closeSettings()
  await showMain()
  await setMainMode('S2')
  await focusMain()
  await mainPage.keyboard.press('Escape')
  await expect.poll(async () => (await windowState()).visible, { timeout: 8000 }).toBe(false)

  page = await openSettings()
  await page.locator('[data-testid="settings-tab-behavior"]').click()
  await page.locator('[data-testid="behavior-esc-direct"]').uncheck()
  await expect
    .poll(async () => (await bootstrap()).settings.behavior.escDirectHide)
    .toBe(false)
  await closeSettings()

  await showMain()
  await setMainMode('S2')
  await focusMain()
  await mainPage.keyboard.press('Escape')
  await mainPage.waitForFunction(
    () =>
      document.querySelector('[data-testid="app-root"]')?.getAttribute('data-ui-mode') ===
      'S1'
  )
  await mainPage.keyboard.press('Escape')
  await expect.poll(async () => (await windowState()).visible, { timeout: 8000 }).toBe(false)

  page = await openSettings()
  await page.locator('[data-testid="settings-tab-behavior"]').click()
  await page.locator('[data-testid="behavior-hide-on-blur"]').uncheck()
  await expect
    .poll(async () => (await bootstrap()).settings.behavior.hideOnBlur)
    .toBe(false)
  await closeSettings()

  await showMain()
  await focusMain()
  await focusXmessage()
  await delay(1200)
  const afterBlurDisabled = await windowState()
  expect(afterBlurDisabled.visible).toBe(true)

  page = await openSettings()
  await page.locator('[data-testid="settings-tab-behavior"]').click()
  await page.locator('[data-testid="behavior-hide-on-blur"]').check()
  await expect
    .poll(async () => (await bootstrap()).settings.behavior.hideOnBlur)
    .toBe(true)
  await closeSettings()

  await showMain()
  await focusMain()
  await focusXmessage()
  await expect.poll(async () => (await windowState()).visible, { timeout: 5000 }).toBe(false)

  const behavior = (await bootstrap()).settings.behavior
  const payload = {
    escDirectHideHiddenFromS2: true,
    layeredEsc: ['S2', 'S1', 'S0'],
    hideOnBlurFalseStayedVisibleMs: 1200,
    hideOnBlurTrueHidden: true,
    persisted: behavior
  }
  writeEvidence('task-32b-behavior.json', payload)
  evidence['behavior'] = payload
  checks.behaviorSettings = true
})

test('data tab shows resolved paths and clears history only after confirmation', async () => {
  const created = await mainPage.evaluate(() =>
    (window as unknown as TestWindow).quickask!.sessions.create({ title: 'm2-clear-target' })
  )
  expect(created.ok).toBe(true)

  const page = settingsPage ?? (await openSettings())
  await page.locator('[data-testid="settings-tab-data"]').click()
  await expect(page.locator('[data-testid="data-panel"]')).toBeVisible()

  const paths = await mainPage.evaluate(() =>
    (window as unknown as TestWindow).quickask!.app.paths()
  )
  expect(paths.ok).toBe(true)
  const info = paths.data as AppPathsInfo
  for (const value of [info.dataDir, info.configDir, info.logsDir, info.dbPath]) {
    expect(value.length).toBeGreaterThan(0)
  }
  await expect(page.locator('[data-testid="data-path-data"]')).toHaveText(info.dataDir)
  await expect(page.locator('[data-testid="data-path-logs"]')).toHaveText(info.logsDir)
  await expect(page.locator('[data-testid="data-path-db"]')).toHaveText(info.dbPath)

  const beforeCancel = await mainPage.evaluate(() =>
    (window as unknown as TestWindow).quickask!.sessions.list({ limit: 100 })
  )
  expect(beforeCancel.data?.sessions.length ?? 0).toBeGreaterThan(0)

  await page.locator('[data-testid="data-clear-history"]').click()
  await expect(page.locator('[data-testid="clear-confirm"]')).toBeVisible()
  await page.locator('[data-testid="clear-cancel"]').click()
  await expect(page.locator('[data-testid="clear-confirm"]')).toBeHidden()
  const afterCancel = await mainPage.evaluate(() =>
    (window as unknown as TestWindow).quickask!.sessions.list({ limit: 100 })
  )
  expect(afterCancel.data?.sessions.length).toBe(beforeCancel.data?.sessions.length)

  await page.locator('[data-testid="data-clear-history"]').click()
  await page.locator('[data-testid="clear-confirm-button"]').click()
  await expect(page.locator('[data-testid="clear-result"]')).toContainText('已清空', {
    timeout: 10_000
  })
  const clearedText = await page.locator('[data-testid="clear-result"]').innerText()
  const afterClear = await mainPage.evaluate(async () => {
    const api = (window as unknown as TestWindow).quickask!
    const list = await api.sessions.list({ limit: 100 })
    const state = await api.sessions.state()
    return { sessions: list.data?.sessions ?? [], state: state.data }
  })
  expect(afterClear.sessions).toEqual([])
  expect(afterClear.state?.currentSessionId).toBeNull()
  expect(afterClear.state?.mode).toBe('S1')
  await page.screenshot({ path: join(EVIDENCE_DIR, 'task-32b-data.png') })

  const payload = {
    paths: info,
    sessionsBeforeClear: beforeCancel.data?.sessions.length,
    sessionsAfterCancel: afterCancel.data?.sessions.length,
    clearedText,
    sessionsAfterClear: afterClear.sessions.length,
    stateAfterClear: afterClear.state
  }
  writeEvidence('task-32b-data.json', payload)
  evidence['data'] = payload
  checks.dataPathsAndClear = true
})

test('about shows version, schema, log and data paths', async () => {
  const page = settingsPage ?? (await openSettings())
  await page.locator('[data-testid="settings-tab-about"]').click()
  await expect(page.locator('[data-testid="about-panel"]')).toBeVisible()
  const boot = await bootstrap()
  const paths = await mainPage.evaluate(() =>
    (window as unknown as TestWindow).quickask!.app.paths()
  )
  expect(paths.ok).toBe(true)
  const info = paths.data as AppPathsInfo

  await expect(page.locator('[data-testid="about-version"]')).toHaveText(boot.version)
  await expect(page.locator('[data-testid="about-schema"]')).toHaveText(
    `v${info.schemaVersion}`
  )
  await expect(page.locator('[data-testid="about-log-path"]')).toHaveText(info.logsDir)
  await expect(page.locator('[data-testid="about-data-path"]')).toHaveText(info.dataDir)
  await expect(page.locator('[data-testid="about-open-logs"]')).toBeVisible()
  await expect(page.locator('[data-testid="about-open-data"]')).toBeVisible()
  await expect(page.locator('[data-testid="about-platform-capabilities"]')).toBeVisible()
  await expect(page.locator('[data-testid="about-platform-label"]')).toContainText('Linux')
  await expect(page.locator('[data-testid="about-capability-click-through"]')).toContainText(
    '可用'
  )
  await expect(page.locator('[data-testid="about-capability-blur"]')).toContainText('可用')
  await expect(page.locator('[data-testid="about-build"]')).toContainText('MIT')

  const payload = {
    version: boot.version,
    schemaVersion: info.schemaVersion,
    logsDir: info.logsDir,
    dataDir: info.dataDir,
    build: await page.locator('[data-testid="about-build"]').innerText()
  }
  writeEvidence('task-32b-about.json', payload)
  evidence['about'] = payload
  checks.about = true
})

test('font size updates --fs-* immediately and persists after restart', async () => {
  let page = settingsPage ?? (await openSettings())
  await page.locator('[data-testid="settings-tab-appearance"]').click()
  await showMain()
  const before = await mainPage.evaluate(() =>
    getComputedStyle(document.documentElement).getPropertyValue('--fs-body').trim()
  )
  expect(before).toBe('14px')

  await setRange(page, 'fontsize-range', 16)
  await expect(page.locator('[data-testid="fontsize-value"]')).toHaveText('16px')
  await expect
    .poll(() =>
      mainPage.evaluate(() =>
        getComputedStyle(document.documentElement).getPropertyValue('--fs-body').trim()
      )
    )
    .toBe('16px')
  const bodyFont = await mainPage.evaluate(() =>
    getComputedStyle(document.querySelector('[data-testid="bar"]') as HTMLElement).fontSize
  )
  const inputFont = await mainPage.evaluate(() =>
    getComputedStyle(document.querySelector('[data-testid="composer"]') as HTMLElement)
      .fontSize
  )
  expect(bodyFont).toBe('16px')
  expect(inputFont).toBe('17px')
  await page.screenshot({ path: join(EVIDENCE_DIR, 'task-32b-fontsize.png') })

  await closeApp()
  await launch()
  const boot = await bootstrap()
  expect(boot.appearance.fontSize).toBe(16)
  const behavior: BehaviorSettings = boot.settings.behavior
  expect(behavior).toEqual({
    escDirectHide: false,
    hideOnBlur: true,
    streamingHideDelayMs: 1000,
    contextRounds: 7
  })
  await showMain()
  await expect
    .poll(() =>
      mainPage.evaluate(() =>
        getComputedStyle(document.documentElement).getPropertyValue('--fs-body').trim()
      )
    )
    .toBe('16px')
  page = await openSettings()
  await page.locator('[data-testid="settings-tab-appearance"]').click()
  await expect(page.locator('[data-testid="fontsize-range"]')).toHaveValue('16')

  const payload = {
    before: bodyFont === '' ? null : before,
    after: { bodyFont, inputFont },
    persistedAppearanceFontSize: boot.appearance.fontSize,
    persistedBehavior: behavior
  }
  writeEvidence('task-32b-fontsize.json', payload)
  evidence['fontSize'] = payload
  checks.fontSize = true
})

test('quit leaves no child electron process behind', async () => {
  await closeSettings()
  await closeApp()
  const check = execFileSync('bash', ['-lc', 'pgrep -x electron || true'], {
    encoding: 'utf8'
  }).trim()
  expect(check).toBe('')
  evidence['processes'] = { electron: 0 }
})
