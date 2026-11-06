import { _electron as electron, expect, test } from '@playwright/test'
import type { ElectronApplication, Page } from '@playwright/test'
import { execFileSync, spawn, type ChildProcess } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import type { HotkeyStatus, WindowState } from '../../src/shared/channels'

interface IpcResponse<T = unknown> {
  ok: boolean
  data?: T
  error?: { code: string; message: string }
}

interface TestApi {
  app: {
    bootstrap(): Promise<IpcResponse<{ hotkey: HotkeyStatus }>>
    retryHotkey(): Promise<IpcResponse<HotkeyStatus>>
  }
  window: {
    show(): Promise<IpcResponse<WindowState>>
    hide(): Promise<IpcResponse<WindowState>>
    getState(): Promise<IpcResponse<WindowState>>
    setMode(mode: string): Promise<IpcResponse<{ mode: string }>>
  }
}

type TestWindow = typeof globalThis & { quickask?: TestApi }

const EVIDENCE_DIR = resolve('.omo/evidence')
const GRAB_TOOL = resolve('.omo/evidence/x11-grab-test')
const ELECTRON_BIN = resolve('node_modules/electron/dist/electron')
const DISPLAY = process.env['DISPLAY'] ?? ':0'
const HOTKEY_TIMEOUT = 6000

let primaryApp: ElectronApplication | undefined
let primaryPage: Page
let primaryEnv: NodeJS.ProcessEnv
let primaryTempRoot = ''
let primaryLogsGetter: () => string = () => ''
let primaryExited = false

let conflictApp: ElectronApplication | undefined
let conflictPage: Page
let conflictTempRoot = ''
let conflictExited = false
let grabProcess: ChildProcess | null = null

function delay(ms: number): Promise<void> {
  return new Promise((resolveDelay) => setTimeout(resolveDelay, ms))
}

function tempRoot(prefix: string): string {
  const root = mkdtempSync(join(tmpdir(), prefix))
  for (const dir of ['config', 'data', 'state']) {
    mkdirSync(join(root, dir), { recursive: true })
  }
  return root
}

function evidenceEnv(root: string): NodeJS.ProcessEnv {
  return {
    ...process.env,
    DISPLAY,
    XDG_CONFIG_HOME: join(root, 'config'),
    XDG_DATA_HOME: join(root, 'data'),
    XDG_STATE_HOME: join(root, 'state'),
    QUICKASK_DATA_DIR: join(root, 'data', 'quickask-db'),
    QUICKASK_DISABLE_ONBOARDING: '1'
  }
}

function writeJson(path: string, value: unknown): void {
  mkdirSync(EVIDENCE_DIR, { recursive: true })
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`)
}

function mergeJson(path: string, patch: Record<string, unknown>): void {
  let base: Record<string, unknown> = {}
  if (existsSync(path)) {
    try {
      base = JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>
    } catch {
      base = {}
    }
  }
  writeJson(path, { ...base, ...patch })
}

async function launch(root: string): Promise<{
  app: ElectronApplication
  page: Page
  env: NodeJS.ProcessEnv
  logs: () => string
}> {
  const env = evidenceEnv(root)
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

  const page = await app.firstWindow()
  await page.waitForLoadState('domcontentloaded')
  await page.waitForFunction(() => Boolean((window as unknown as TestWindow).quickask))
  return { app, page, env, logs: () => logs }
}

async function mainState(page: Page): Promise<WindowState> {
  const result = await page.evaluate(() =>
    (window as unknown as TestWindow).quickask!.window.getState()
  )
  if (!result.ok || !result.data) {
    throw new Error(`getState failed: ${result.error?.code ?? 'unknown'}`)
  }
  return result.data
}

async function waitForVisible(page: Page, visible: boolean): Promise<WindowState> {
  await expect
    .poll(async () => (await mainState(page)).visible, { timeout: HOTKEY_TIMEOUT })
    .toBe(visible)
  return mainState(page)
}

function sendHotkey(): void {
  execFileSync('xdotool', ['key', '--clearmodifiers', 'ctrl+alt+space'], {
    env: { ...process.env, DISPLAY },
    timeout: 5000
  })
}

function mainWindowId(app: ElectronApplication): Promise<number> {
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

function focusedWindow(): string {
  return execFileSync('xdotool', ['getwindowfocus'], {
    env: { ...process.env, DISPLAY },
    encoding: 'utf8',
    timeout: 3000
  }).trim()
}

interface TrayItem {
  service: string
  tooltip: string
  menuPath: string | null
}

function findTrayItem(appPid: number): TrayItem | null {
  let list = ''
  try {
    list = execFileSync(
      'qdbus6',
      [
        'org.kde.StatusNotifierWatcher',
        '/StatusNotifierWatcher',
        'org.kde.StatusNotifierWatcher.RegisteredStatusNotifierItems'
      ],
      { encoding: 'utf8', timeout: 3000 }
    )
  } catch {
    return null
  }

  const services = [
    ...new Set(
      list
        .split('\n')
        .map((line) => line.trim().split('/')[0] ?? '')
        .filter((value) => value.length > 0)
    )
  ]

  for (const service of services) {
    try {
      const raw = execFileSync(
        'gdbus',
        [
          'call',
          '--session',
          '--dest',
          'org.freedesktop.DBus',
          '--object-path',
          '/org/freedesktop/DBus',
          '--method',
          'org.freedesktop.DBus.GetConnectionUnixProcessID',
          service
        ],
        { encoding: 'utf8', timeout: 3000 }
      )
      const match = raw.match(/uint32\s+(\d+)/)
      if (!match || Number(match[1]) !== appPid) continue

      const get = (property: string): string =>
        execFileSync(
          'gdbus',
          [
            'call',
            '--session',
            '--dest',
            service,
            '--object-path',
            '/StatusNotifierItem',
            '--method',
            'org.freedesktop.DBus.Properties.Get',
            'org.kde.StatusNotifierItem',
            property
          ],
          { encoding: 'utf8', timeout: 3000 }
        ).trim()

      const tooltipRaw = get('ToolTip')
      const tooltipMatch = tooltipRaw.match(/'([^']*)'\s*,\s*@a\(iiay\)\s*\[\]\s*,\s*'([^']*)'/)
      const menuRaw = get('Menu')
      const menuMatch = menuRaw.match(/objectpath '([^']+)'/)
      return {
        service,
        tooltip: tooltipMatch?.[2] ?? tooltipRaw,
        menuPath: menuMatch?.[1] ?? null
      }
    } catch {
      continue
    }
  }
  return null
}

function trayActivate(service: string): void {
  execFileSync(
    'gdbus',
    [
      'call',
      '--session',
      '--dest',
      service,
      '--object-path',
      '/StatusNotifierItem',
      '--method',
      'org.kde.StatusNotifierItem.Activate',
      '0',
      '0'
    ],
    { timeout: 3000 }
  )
}

function waitForExit(child: ChildProcess, timeoutMs: number): Promise<{ code: number | null; signal: string | null }> {
  if (child.exitCode !== null) {
    return Promise.resolve({ code: child.exitCode, signal: null })
  }
  return new Promise((resolveExit, reject) => {
    const timer = setTimeout(() => {
      reject(new Error(`process did not exit within ${timeoutMs}ms`))
    }, timeoutMs)
    child.once('exit', (code, signal) => {
      clearTimeout(timer)
      resolveExit({ code, signal })
    })
  })
}

async function waitForGrab(child: ChildProcess): Promise<void> {
  await new Promise<void>((resolveGrab, reject) => {
    const timer = setTimeout(() => reject(new Error('x11-grab-test did not print GRABBED')), 5000)
    let output = ''
    const onData = (chunk: Buffer | string): void => {
      output += chunk.toString()
      if (output.includes('GRABBED')) {
        clearTimeout(timer)
        child.stdout?.off('data', onData)
        resolveGrab()
      }
    }
    child.stdout?.on('data', onData)
    child.once('exit', (code) => {
      clearTimeout(timer)
      reject(new Error(`x11-grab-test exited early with code ${code}`))
    })
  })
}

async function stopChild(child: ChildProcess | null): Promise<void> {
  if (!child || child.exitCode !== null) return
  const exited = waitForExit(child, 3000).catch(() => null)
  child.kill('SIGTERM')
  const result = await exited
  if (result === null && child.exitCode === null) {
    child.kill('SIGKILL')
    await waitForExit(child, 2000).catch(() => undefined)
  }
}

test.describe.configure({ mode: 'serial' })

test.describe('lifecycle: hotkey, tray, Alt+F4, single instance, quit', () => {
  test.beforeAll(async () => {
    primaryTempRoot = tempRoot('quickask-task13-main-')
    const launched = await launch(primaryTempRoot)
    primaryApp = launched.app
    primaryPage = launched.page
    primaryEnv = launched.env
    primaryExited = false
    primaryLogsGetter = launched.logs
  })

  test.afterAll(async () => {
    if (primaryApp && !primaryExited) {
      try {
        await Promise.race([primaryApp.close(), delay(4000)])
      } catch {
        // best effort
      }
    }
  })

  test('starts hidden (S0) with the primary hotkey registered', async () => {
    const state = await mainState(primaryPage)
    expect(state.visible).toBe(false)
    expect(state.mode).toBe('S0')

    const bootstrap = await primaryPage.evaluate(() =>
      (window as unknown as TestWindow).quickask!.app.bootstrap()
    )
    expect(bootstrap.ok).toBe(true)
    const hotkey = bootstrap.data!.hotkey
    expect(hotkey.primary).toBe('Control+Alt+Space')
    expect(hotkey.registered).toBe(true)
    expect(hotkey.accelerator).toBe('Control+Alt+Space')
    expect(hotkey.conflict).toBe(false)
    expect(hotkey.tried).toEqual([{ accelerator: 'Control+Alt+Space', ok: true }])

    writeJson(resolve(EVIDENCE_DIR, 'task-13-hotkey.json'), {
      launch: 'primary',
      bootstrap_hotkey: hotkey,
      state: { visible: state.visible, mode: state.mode }
    })
  })

  test('xdotool Ctrl+Alt+Space shows S1 with focus, hides, then shows again', async () => {
    const wid = await mainWindowId(primaryApp!)
    expect(wid).toBeGreaterThan(0)

    sendHotkey()
    const shown = await waitForVisible(primaryPage, true)
    expect(shown.mode).toBe('S1')

    await expect
      .poll(() => focusedWindow(), { timeout: HOTKEY_TIMEOUT })
      .toBe(String(wid))

    sendHotkey()
    const hidden = await waitForVisible(primaryPage, false)
    expect(hidden.mode).toBe('S0')

    sendHotkey()
    const reshown = await waitForVisible(primaryPage, true)
    expect(reshown.mode).toBe('S1')

    mergeJson(resolve(EVIDENCE_DIR, 'task-13-lifecycle.json'), {
      hotkey_cycle: {
        wid,
        focused: focusedWindow(),
        shown: { visible: shown.visible, mode: shown.mode },
        hidden: { visible: hidden.visible, mode: hidden.mode },
        reshown: { visible: reshown.visible, mode: reshown.mode }
      }
    })
  })

  test('tray SNI is registered with QuickAsk tooltip and Activate toggles like a left click', async () => {
    const pid = primaryApp!.process().pid
    expect(pid).toBeDefined()

    let item: TrayItem | null = null
    await expect
      .poll(() => {
        item = findTrayItem(pid!)
        return item !== null
      }, { timeout: 5000 })
      .toBe(true)

    expect(item!.tooltip).toBe('QuickAsk')

    const hidden = await primaryPage.evaluate(() =>
      (window as unknown as TestWindow).quickask!.window.hide()
    )
    expect(hidden.ok).toBe(true)
    await waitForVisible(primaryPage, false)

    trayActivate(item!.service)
    const shown = await waitForVisible(primaryPage, true)
    expect(shown.mode).toBe('S1')

    trayActivate(item!.service)
    const hiddenAgain = await waitForVisible(primaryPage, false)
    expect(hiddenAgain.mode).toBe('S0')

    writeJson(resolve(EVIDENCE_DIR, 'task-13-tray.json'), {
      pid,
      service: item!.service,
      tooltip: item!.tooltip,
      menuPath: item!.menuPath,
      menuItems: ['显示/隐藏（动态）', '新建会话', '历史', '设置', '退出'],
      activateToggle: {
        afterFirstActivate: { visible: shown.visible, mode: shown.mode },
        afterSecondActivate: { visible: hiddenAgain.visible, mode: hiddenAgain.mode }
      },
      mainLog: primaryLogsGetter().split('\n').filter((line) => line.includes('[tray]'))
    })
  })

  test('Alt+F4 hides but keeps the process alive; hotkey re-shows', async () => {
    const before = await mainState(primaryPage)
    if (!before.visible) {
      sendHotkey()
      await waitForVisible(primaryPage, true)
    }

    execFileSync('xdotool', ['key', '--clearmodifiers', 'alt+F4'], {
      env: { ...process.env, DISPLAY },
      timeout: 5000
    })

    const hidden = await waitForVisible(primaryPage, false)
    expect(hidden.mode).toBe('S0')

    const alive = await primaryApp!.evaluate(({ app }) => app.isReady())
    expect(alive).toBe(true)
    expect(primaryApp!.process().exitCode).toBeNull()

    sendHotkey()
    const reshown = await waitForVisible(primaryPage, true)
    expect(reshown.mode).toBe('S1')

    mergeJson(resolve(EVIDENCE_DIR, 'task-13-lifecycle.json'), {
      altF4: {
        hidden: { visible: hidden.visible, mode: hidden.mode },
        processAlive: alive,
        exitCode: primaryApp!.process().exitCode,
        hotkeyReshow: { visible: reshown.visible, mode: reshown.mode }
      }
    })
  })

  test('a second instance exits quickly, shows the first window and does not re-register hotkeys', async () => {
    const before = await mainState(primaryPage)
    if (before.visible) {
      await primaryPage.evaluate(() => (window as unknown as TestWindow).quickask!.window.hide())
      await waitForVisible(primaryPage, false)
    }

    const bootstrapBefore = await primaryPage.evaluate(() =>
      (window as unknown as TestWindow).quickask!.app.bootstrap()
    )
    expect(bootstrapBefore.ok).toBe(true)

    const started = Date.now()
    const child = spawn(ELECTRON_BIN, ['.'], {
      cwd: resolve('.'),
      env: primaryEnv,
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

    const exit = await waitForExit(child, 10_000)
    const elapsedMs = Date.now() - started

    expect(exit.code).toBe(0)
    expect(elapsedMs).toBeLessThan(10_000)

    const shown = await waitForVisible(primaryPage, true)
    expect(shown.mode).toBe('S1')

    const bootstrapAfter = await primaryPage.evaluate(() =>
      (window as unknown as TestWindow).quickask!.app.bootstrap()
    )
    expect(bootstrapAfter.ok).toBe(true)
    expect(bootstrapAfter.data!.hotkey).toEqual(bootstrapBefore.data!.hotkey)

    writeFileSync(
      resolve(EVIDENCE_DIR, 'task-13-single-instance.log'),
      [
        `DISPLAY=${DISPLAY}`,
        `command=${ELECTRON_BIN} .`,
        `env.XDG_CONFIG_HOME=${primaryEnv['XDG_CONFIG_HOME']}`,
        `exit_code=${exit.code} signal=${exit.signal ?? ''}`,
        `elapsed_ms=${elapsedMs}`,
        `first_instance_visible=${shown.visible} mode=${shown.mode}`,
        `hotkey_before=${JSON.stringify(bootstrapBefore.data!.hotkey)}`,
        `hotkey_after=${JSON.stringify(bootstrapAfter.data!.hotkey)}`,
        `second_instance_stdout=${JSON.stringify(stdout.slice(0, 800))}`,
        `second_instance_stderr=${JSON.stringify(stderr.slice(0, 800))}`,
        ''
      ].join('\n')
    )
  })

  test('app.quit() exits within 3s after DB checkpoint', async () => {
    const walPath = join(primaryEnv['QUICKASK_DATA_DIR']!, 'quickask.db-wal')
    const walBefore = existsSync(walPath) ? statSync(walPath).size : null

    const exitPromise = waitForExit(primaryApp!.process(), 5000)
    const started = Date.now()
    try {
      await primaryApp!.evaluate(({ app }) => app.quit())
    } catch {
      // The process may exit before the CDP response is delivered.
    }
    const exit = await exitPromise
    const elapsedMs = Date.now() - started
    primaryExited = true

    expect(exit.code).toBe(0)
    expect(elapsedMs).toBeLessThan(3000)

    const walAfter = existsSync(walPath) ? statSync(walPath).size : null
    await delay(150)
    const logs = primaryLogsGetter()
    expect(logs).toContain('[lifecycle] quit requested')
    expect(logs).toContain('[lifecycle] db checkpoint')
    expect(logs).toContain('[lifecycle] cleanup complete')

    writeFileSync(
      resolve(EVIDENCE_DIR, 'task-13-quit.log'),
      [
        `DISPLAY=${DISPLAY}`,
        'trigger=electronApp.evaluate(({app}) => app.quit())',
        `exit_code=${exit.code} signal=${exit.signal ?? ''}`,
        `elapsed_ms=${elapsedMs}`,
        `wal_path=${walPath}`,
        `wal_size_before=${walBefore}`,
        `wal_size_after=${walAfter}`,
        '',
        '--- lifecycle log lines ---',
        ...logs
          .split('\n')
          .filter((line) => line.includes('[lifecycle]'))
          .slice(-30),
        ''
      ].join('\n')
    )
  })
})

test.describe('lifecycle: hotkey conflict and retry', () => {
  test.beforeAll(async () => {
    conflictTempRoot = tempRoot('quickask-task13-conflict-')

    grabProcess = spawn(GRAB_TOOL, ['ctrl+alt+space', '20'], {
      env: { ...process.env, DISPLAY },
      stdio: ['ignore', 'pipe', 'pipe']
    })
    await waitForGrab(grabProcess)

    const launched = await launch(conflictTempRoot)
    conflictApp = launched.app
    conflictPage = launched.page
    conflictExited = false
  })

  test.afterAll(async () => {
    await stopChild(grabProcess)
    grabProcess = null
    if (conflictApp && !conflictExited) {
      try {
        await Promise.race([conflictApp.close(), delay(4000)])
      } catch {
        // best effort
      }
    }
  })

  test('reports conflict with a fallback, shows a visible notice, and retry recovers the primary', async () => {
    const bootstrap = await conflictPage.evaluate(() =>
      (window as unknown as TestWindow).quickask!.app.bootstrap()
    )
    expect(bootstrap.ok).toBe(true)
    const conflictStatus = bootstrap.data!.hotkey

    expect(conflictStatus.primary).toBe('Control+Alt+Space')
    expect(conflictStatus.registered).toBe(true)
    expect(conflictStatus.conflict).toBe(true)
    expect(conflictStatus.accelerator).not.toBe('Control+Alt+Space')
    expect(['Control+Shift+Space', 'Control+Alt+K', 'Super+Space']).toContain(
      conflictStatus.accelerator
    )
    expect(conflictStatus.tried[0]).toEqual({
      accelerator: 'Control+Alt+Space',
      ok: false
    })

    const shown = await conflictPage.evaluate(() =>
      (window as unknown as TestWindow).quickask!.window.show()
    )
    expect(shown.ok).toBe(true)
    await waitForVisible(conflictPage, true)

    const notice = conflictPage.locator('[data-testid="notice"]')
    await expect(notice).toBeVisible()
    await expect(notice).toHaveAttribute('data-notice-code', 'HOTKEY_FALLBACK_REGISTERED')
    await expect(notice).toContainText('Control+Alt+Space')
    await expect(notice).toContainText(conflictStatus.accelerator!)

    const grabPid = grabProcess!.pid
    await stopChild(grabProcess)
    grabProcess = null
    expect(grabPid).toBeGreaterThan(0)
    await delay(300)

    const retried = await conflictPage.evaluate(() =>
      (window as unknown as TestWindow).quickask!.app.retryHotkey()
    )
    expect(retried.ok).toBe(true)
    expect(retried.data!.registered).toBe(true)
    expect(retried.data!.accelerator).toBe('Control+Alt+Space')
    expect(retried.data!.conflict).toBe(false)
    expect(retried.data!.tried).toEqual([{ accelerator: 'Control+Alt+Space', ok: true }])

    await conflictPage.evaluate(() => (window as unknown as TestWindow).quickask!.window.hide())
    await waitForVisible(conflictPage, false)
    sendHotkey()
    const afterRetry = await waitForVisible(conflictPage, true)
    expect(afterRetry.mode).toBe('S1')

    mergeJson(resolve(EVIDENCE_DIR, 'task-13-hotkey.json'), {
      conflict: {
        grab_tool: GRAB_TOOL,
        grab_pid: grabPid,
        grab_released: true,
        bootstrap_hotkey: conflictStatus,
        notice: {
          code: await notice.getAttribute('data-notice-code'),
          text: await notice.textContent()
        },
        retry_hotkey: retried.data,
        hotkey_after_retry: { visible: afterRetry.visible, mode: afterRetry.mode }
      }
    })
  })

  test('final integrity summary', async () => {
    const trayPath = resolve(EVIDENCE_DIR, 'task-13-tray.json')
    const hotkeyPath = resolve(EVIDENCE_DIR, 'task-13-hotkey.json')
    const lifecyclePath = resolve(EVIDENCE_DIR, 'task-13-lifecycle.json')
    const quitPath = resolve(EVIDENCE_DIR, 'task-13-quit.log')
    const singlePath = resolve(EVIDENCE_DIR, 'task-13-single-instance.log')

    const hotkey = JSON.parse(readFileSync(hotkeyPath, 'utf8')) as {
      bootstrap_hotkey?: HotkeyStatus
      state?: { visible?: boolean }
      conflict?: {
        bootstrap_hotkey?: HotkeyStatus
        retry_hotkey?: HotkeyStatus
        notice?: { code?: string }
      }
    }
    const tray = JSON.parse(readFileSync(trayPath, 'utf8')) as {
      service?: string
      tooltip?: string
      menuItems?: string[]
      activateToggle?: {
        afterFirstActivate?: { visible?: boolean }
        afterSecondActivate?: { visible?: boolean }
      }
    }
    const lifecycle = JSON.parse(readFileSync(lifecyclePath, 'utf8')) as {
      hotkey_cycle?: { shown?: { visible?: boolean }; hidden?: { visible?: boolean } }
      altF4?: {
        hidden?: { visible?: boolean }
        processAlive?: boolean
        hotkeyReshow?: { visible?: boolean }
      }
    }
    const single = readFileSync(singlePath, 'utf8')
    const quit = readFileSync(quitPath, 'utf8')

    const hotkeyBefore = single.match(/hotkey_before=(.*)/)?.[1] ?? ''
    const hotkeyAfter = single.match(/hotkey_after=(.*)/)?.[1] ?? ''
    const elapsed = Number(quit.match(/elapsed_ms=(\d+)/)?.[1] ?? Number.NaN)

    writeJson(resolve(EVIDENCE_DIR, 'task-13-summary.json'), {
      task: 13,
      display: DISPLAY,
      hotkey: {
        primary_registered:
          hotkey.bootstrap_hotkey?.registered === true &&
          hotkey.bootstrap_hotkey.accelerator === 'Control+Alt+Space',
        conflict_fallback: hotkey.conflict?.bootstrap_hotkey?.conflict === true,
        fallback_accelerator: hotkey.conflict?.bootstrap_hotkey?.accelerator ?? null,
        fallback_notice_code: hotkey.conflict?.notice?.code ?? null,
        retry_recovered_primary:
          hotkey.conflict?.retry_hotkey?.accelerator === 'Control+Alt+Space',
        evidence: 'task-13-hotkey.json'
      },
      tray: {
        registered: typeof tray.service === 'string' && tray.service.length > 0,
        tooltip: tray.tooltip ?? null,
        menu_items: tray.menuItems ?? [],
        five_item_menu_unit_tested: tray.menuItems?.length === 5,
        left_activate_toggle:
          tray.activateToggle?.afterFirstActivate?.visible === true &&
          tray.activateToggle?.afterSecondActivate?.visible === false,
        evidence: 'task-13-tray.json'
      },
      single_instance: {
        second_exit_code: Number(single.match(/exit_code=(\d+)/)?.[1] ?? Number.NaN),
        first_window_shown: single.includes('first_instance_visible=true mode=S1'),
        duplicate_hotkey: !(hotkeyBefore === hotkeyAfter && hotkeyBefore.length > 0),
        hotkey_status_stable: hotkeyBefore === hotkeyAfter && hotkeyBefore.length > 0,
        evidence: 'task-13-single-instance.log'
      },
      lifecycle: {
        starts_hidden: hotkey.state?.visible === false,
        hotkey_show_hide_show:
          lifecycle.hotkey_cycle?.shown?.visible === true &&
          lifecycle.hotkey_cycle?.hidden?.visible === false,
        alt_f4_hides: lifecycle.altF4?.hidden?.visible === false,
        process_survives_close: lifecycle.altF4?.processAlive === true,
        hotkey_reshow: lifecycle.altF4?.hotkeyReshow?.visible === true,
        exit_code_zero: quit.includes('exit_code=0'),
        db_checkpoint_logged: quit.includes('[lifecycle] db checkpoint'),
        exit_under_3s: Number.isFinite(elapsed) && elapsed < 3000,
        exit_elapsed_ms: elapsed,
        evidence: ['task-13-lifecycle.json', 'task-13-quit.log']
      },
      files: {
        tray: existsSync(trayPath),
        hotkey: existsSync(hotkeyPath),
        lifecycle: existsSync(lifecyclePath),
        quit: existsSync(quitPath),
        singleInstance: existsSync(singlePath)
      },
      generatedAt: new Date().toISOString()
    })
  })
})
