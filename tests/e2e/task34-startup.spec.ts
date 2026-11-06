import { _electron as electron, expect, test } from '@playwright/test'
import type { ElectronApplication, Page } from '@playwright/test'
import { execFileSync, spawn, type ChildProcess } from 'node:child_process'
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import type { StartupState, WindowState } from '../../src/shared/channels'
import { defaultAnchor } from '../../src/shared/geometry'

interface IpcResponse<T = unknown> {
  ok: boolean
  data?: T
  error?: { code: string; message: string }
}

interface TestApi {
  app: {
    bootstrap(): Promise<IpcResponse>
    setStartup(request: {
      autostart?: boolean
      watchdog?: boolean
    }): Promise<IpcResponse<StartupState>>
  }
  window: {
    show(): Promise<IpcResponse<WindowState>>
    hide(): Promise<IpcResponse<WindowState>>
    getState(): Promise<IpcResponse<WindowState>>
    openSettings(): Promise<IpcResponse<{ open: boolean }>>
    closeSettings(): Promise<IpcResponse<{ open: boolean }>>
  }
  settings: {
    getAll(): Promise<IpcResponse<{ settings: Record<string, unknown> }>>
    set(request: { key: string; value: unknown }): Promise<IpcResponse<{ saved: boolean }>>
  }
}

type TestWindow = typeof globalThis & { quickask?: TestApi }

const EVIDENCE_DIR = resolve('.omo/evidence/m2/session')
const PROJECT_ROOT = resolve('.')
const DISPLAY = process.env['DISPLAY'] ?? ':0'
const ELECTRON_BIN = resolve('node_modules/electron/dist/electron')
const SUPERVISOR = resolve('scripts/quickask-supervisor.sh')

let app: ElectronApplication | undefined
let page: Page

const evidence: Record<string, unknown> = {}

function delay(ms: number): Promise<void> {
  return new Promise((resolveDelay) => setTimeout(resolveDelay, ms))
}

async function waitFor(check: () => boolean, timeoutMs = 8000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (check()) return
    await delay(50)
  }
  throw new Error('condition not met before timeout')
}

function tempRoot(prefix: string): string {
  const root = mkdtempSync(join(tmpdir(), prefix))
  for (const dir of ['config', 'data', 'state', 'runtime']) {
    mkdirSync(join(root, dir), { recursive: true })
  }
  return root
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

function writeEvidence(name: string, value: unknown): void {
  mkdirSync(EVIDENCE_DIR, { recursive: true })
  writeFileSync(join(EVIDENCE_DIR, name), `${JSON.stringify(value, null, 2)}\n`)
}

function runXdotool(args: string[]): string {
  return execFileSync('xdotool', args, {
    env: { ...process.env, DISPLAY },
    encoding: 'utf8',
    timeout: 5000
  }).trim()
}

function screenBar(state: WindowState): { x: number; y: number; width: number; height: number } {
  const layout = state.layout!
  return {
    x: state.bounds.x + layout.barRect.x,
    y: state.bounds.y + layout.barRect.y,
    width: layout.barRect.width,
    height: layout.barRect.height
  }
}

async function launch(root: string): Promise<void> {
  app = await electron.launch({ args: ['.'], env: baseEnv(root) })
  const first = await app.firstWindow()
  await first.waitForLoadState('domcontentloaded')
  await first.waitForFunction(() => Boolean((window as unknown as TestWindow).quickask))
  page = app.windows().find((entry) => !entry.url().includes('settings=1')) ?? first
  await page.waitForFunction(() => Boolean((window as unknown as TestWindow).quickask))
}

async function closeApp(): Promise<void> {
  if (!app) return
  const current = app
  app = undefined
  try {
    await Promise.race([current.close(), delay(5000)])
  } catch {
    current.process().kill('SIGTERM')
  }
  await delay(500)
}

async function callState(): Promise<WindowState> {
  const result = await page.evaluate(() =>
    (window as unknown as TestWindow).quickask!.window.getState()
  )
  expect(result.ok).toBe(true)
  return result.data as WindowState
}

async function hideShow(): Promise<WindowState> {
  await page.evaluate(() => (window as unknown as TestWindow).quickask!.window.hide())
  await delay(100)
  await page.evaluate(() => (window as unknown as TestWindow).quickask!.window.show())
  await delay(400)
  return callState()
}

async function windowId(): Promise<number> {
  return app!.evaluate(({ BrowserWindow }) => {
    const target = BrowserWindow.getAllWindows().find((window) => window.getTitle() === 'QuickAsk')
    if (!target) return 0
    const handle = target.getNativeWindowHandle()
    if (handle.length >= 8) return Number(handle.readBigUInt64LE(0) & 0xffffffffn)
    return handle.readUInt32LE(0)
  })
}

async function dragBar(dx: number, dy: number): Promise<void> {
  const state = await callState()
  const wid = await windowId()
  const bar = screenBar(state)
  const relativeX = bar.x - state.bounds.x + 5
  const relativeY = bar.y - state.bounds.y + Math.round(bar.height / 2)
  runXdotool(['windowraise', String(wid)])
  runXdotool(['windowactivate', '--sync', String(wid)])
  await delay(150)
  runXdotool(['mousemove', '--window', String(wid), String(relativeX), String(relativeY)])
  runXdotool(['mousedown', '1'])
  const stepX = dx / 12
  const stepY = dy / 12
  for (let step = 1; step <= 12; step += 1) {
    runXdotool([
      'mousemove_relative',
      '--sync',
      '--',
      String(Math.round(stepX)),
      String(Math.round(stepY))
    ])
    await delay(20)
  }
  await delay(60)
  runXdotool(['mouseup', '1'])
  await delay(700)
}

test.describe.configure({ mode: 'serial' })

test('position memory survives restart and a different display key falls back', async () => {
  test.setTimeout(90_000)
  const root = tempRoot('quickask-task34-position-')
  try {
    runXdotool(['mousemove', '--sync', '960', '540'])
    await delay(100)
    await launch(root)

    const initial = await page.evaluate(() =>
      (window as unknown as TestWindow).quickask!.window.getState()
    )
    expect(initial.ok).toBe(true)
    expect((initial.data as WindowState).visible).toBe(false)

    const shown = await page.evaluate(() =>
      (window as unknown as TestWindow).quickask!.window.show()
    )
    expect(shown.ok).toBe(true)
    await delay(300)
    const before = await callState()
    expect(before.layout!.anchor).toEqual(
      defaultAnchor(before.display.workArea, before.layout!.barRect.width)
    )

    await dragBar(100, 60)
    const dragged = await callState()
    expect(dragged.layout!.anchor.x).toBeGreaterThan(before.layout!.anchor.x + 80)
    expect(dragged.layout!.anchor.y).toBeGreaterThan(before.layout!.anchor.y + 40)

    const afterHideShow = await hideShow()
    expect(afterHideShow.layout!.anchor).toEqual(dragged.layout!.anchor)

    await closeApp()
    await launch(root)
    await page.evaluate(() => (window as unknown as TestWindow).quickask!.window.show())
    await delay(400)
    const afterRestart = await callState()
    expect(afterRestart.layout!.anchor).toEqual(dragged.layout!.anchor)

    const stored = await page.evaluate(() => (window as unknown as TestWindow).quickask!.settings.getAll())
    expect(stored.ok).toBe(true)
    const windowSettings = (stored.data as { settings: Record<string, unknown> }).settings[
      'window'
    ] as { positions: Record<string, unknown> }
    expect(Object.keys(windowSettings.positions).length).toBeGreaterThanOrEqual(1)

    const fake = await page.evaluate(() =>
      (window as unknown as TestWindow).quickask!.settings.set({
        key: 'window',
        value: { positions: { 'FAKE-DISPLAY|800x600@1': { x: 1, y: 2 } } }
      })
    )
    expect(fake.ok).toBe(true)
    await closeApp()

    await launch(root)
    await page.evaluate(() => (window as unknown as TestWindow).quickask!.window.show())
    await delay(400)
    const afterDifferentKey = await callState()
    expect(afterDifferentKey.layout!.anchor).toEqual(
      defaultAnchor(afterDifferentKey.display.workArea, afterDifferentKey.layout!.barRect.width)
    )

    evidence.position = {
      storedKeyCount: Object.keys(windowSettings.positions).length,
      defaultAnchor: before.layout!.anchor,
      draggedAnchor: dragged.layout!.anchor,
      afterHideShow,
      afterRestartAnchor: afterRestart.layout!.anchor,
      differentKeyAnchor: afterDifferentKey.layout!.anchor,
      differentKeyDefault: defaultAnchor(
        afterDifferentKey.display.workArea,
        afterDifferentKey.layout!.barRect.width
      )
    }
    writeEvidence('task-34-position.json', evidence.position)
  } finally {
    await closeApp()
    rmSync(root, { recursive: true, force: true })
  }
})

test('autostart file is created, rewritten, removed and persists across restart', async () => {
  test.setTimeout(90_000)
  const root = tempRoot('quickask-task34-autostart-')
  const desktopPath = join(root, 'config', 'autostart', 'quickask.desktop')
  try {
    await launch(root)
    const open = await page.evaluate(() =>
      (window as unknown as TestWindow).quickask!.window.openSettings()
    )
    expect(open.ok).toBe(true)
    await waitFor(() => app!.windows().some((entry) => entry.url().includes('settings=1')))
    const settingsPage = app!.windows().find((entry) => entry.url().includes('settings=1'))!
    await settingsPage.waitForLoadState('domcontentloaded')
    await settingsPage.waitForFunction(() =>
      Boolean((window as unknown as TestWindow).quickask)
    )
    await settingsPage.locator('[data-testid="settings-tab-behavior"]').click()
    await expect(settingsPage.locator('[data-testid="startup-autostart"]')).toBeVisible()
    await expect(settingsPage.locator('[data-testid="startup-watchdog"]')).toBeVisible()
    await settingsPage.locator('[data-testid="startup-autostart"]').check()
    await waitFor(() => existsSync(desktopPath))
    const direct = readFileSync(desktopPath, 'utf8')
    expect(direct).toContain('Type=Application')
    expect(direct).toContain('Name=QuickAsk')
    expect(direct).toContain('Terminal=false')
    expect(direct).toContain('X-GNOME-Autostart-enabled=true')
    expect(direct).toContain('Exec="')
    expect(direct).not.toMatch(/api[_-]?key|token|secret/i)
    await expect(settingsPage.locator('[data-testid="startup-desktop-path"]')).toContainText(
      desktopPath
    )

    await settingsPage.locator('[data-testid="startup-watchdog"]').check()
    await waitFor(() => readFileSync(desktopPath, 'utf8').includes('quickask-supervisor.sh'))
    const guarded = readFileSync(desktopPath, 'utf8')

    await settingsPage.locator('[data-testid="startup-autostart"]').uncheck()
    await waitFor(() => !existsSync(desktopPath))

    await settingsPage.locator('[data-testid="startup-autostart"]').check()
    await waitFor(() => existsSync(desktopPath))
    const stateBeforeRestart = await page.evaluate(() =>
      (window as unknown as TestWindow).quickask!.app.setStartup({})
    )
    expect(stateBeforeRestart.ok).toBe(true)
    expect((stateBeforeRestart.data as StartupState).autostart).toBe(true)
    expect((stateBeforeRestart.data as StartupState).watchdog).toBe(true)

    mkdirSync(EVIDENCE_DIR, { recursive: true })
    writeFileSync(join(EVIDENCE_DIR, 'task-34-autostart.desktop'), guarded)

    await closeApp()
    await launch(root)
    const hidden = await page.evaluate(() =>
      (window as unknown as TestWindow).quickask!.window.getState()
    )
    expect((hidden.data as WindowState).visible).toBe(false)
    const restored = await page.evaluate(() =>
      (window as unknown as TestWindow).quickask!.app.setStartup({})
    )
    expect((restored.data as StartupState).autostart).toBe(true)
    expect((restored.data as StartupState).watchdog).toBe(true)
    expect((restored.data as StartupState).desktopExists).toBe(true)
    expect(readFileSync(desktopPath, 'utf8')).toContain('quickask-supervisor.sh')

    evidence.autostart = {
      desktopPath,
      direct,
      guarded,
      restored: restored.data
    }
    writeEvidence('task-34-autostart.json', evidence.autostart)
  } finally {
    await closeApp()
    rmSync(root, { recursive: true, force: true })
  }
})

test('supervisor restarts the real app after SIGKILL and stops one child', async () => {
  test.setTimeout(90_000)
  const root = tempRoot('quickask-task34-supervisor-')
  const wrapper = join(root, 'run-quickask.sh')
  const runtime = join(root, 'runtime')
  writeFileSync(
    wrapper,
    `#!/usr/bin/env bash\nexec "${ELECTRON_BIN}" "${PROJECT_ROOT}"\n`,
    'utf8'
  )
  chmodSync(wrapper, 0o755)

  let supervisor: ChildProcess | undefined
  try {
    supervisor = spawn('bash', [SUPERVISOR], {
      env: {
        ...baseEnv(root),
        QUICKASK_APP_BIN: wrapper,
        QUICKASK_SUPERVISOR_RUNTIME_DIR: runtime,
        QUICKASK_SUPERVISOR_LOG: join(runtime, 'supervisor.log'),
        QUICKASK_SUPERVISOR_STOP: join(runtime, 'stop')
      },
      stdio: 'ignore'
    })

    const childrenOf = (): number[] => {
      if (!supervisor?.pid) return []
      try {
        return readFileSync(`/proc/${supervisor.pid}/task/${supervisor.pid}/children`, 'utf8')
          .trim()
          .split(/\s+/)
          .filter(Boolean)
          .map(Number)
      } catch {
        return []
      }
    }

    await waitFor(() => childrenOf().length === 1 && childrenOf()[0]! > 0, 20_000)
    const first = childrenOf()[0]!
    expect(() => process.kill(first, 0)).not.toThrow()
    process.kill(first, 'SIGKILL')

    await waitFor(() => {
      const current = childrenOf()
      return current.length === 1 && current[0] !== first
    }, 20_000)
    const second = childrenOf()[0]!
    expect(second).not.toBe(first)
    expect(() => process.kill(second, 0)).not.toThrow()
    expect(childrenOf()).toHaveLength(1)

    supervisor.kill('SIGTERM')
    await waitFor(
      () => supervisor.exitCode !== null || supervisor.signalCode !== null,
      10_000
    )
    expect(supervisor.exitCode).toBe(0)
    await waitFor(() => {
      try {
        process.kill(second, 0)
        return false
      } catch {
        return true
      }
    }, 10_000)

    const log = readFileSync(join(runtime, 'supervisor.log'), 'utf8')
    expect(log).toContain('restarting')
    evidence.supervisor = { firstPid: first, secondPid: second, log }
    writeEvidence('task-34-supervisor.json', evidence.supervisor)
  } finally {
    if (supervisor && supervisor.exitCode === null && supervisor.signalCode === null) {
      supervisor.kill('SIGTERM')
    }
    await delay(500)
    rmSync(root, { recursive: true, force: true })
  }
})
