import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { BrowserWindow } from 'electron'
import { computeLayout, type WindowLayout } from '../../src/shared/geometry'

const h = vi.hoisted(() => ({
  screenPoint: { x: 0, y: 0 },
  execFile: vi.fn(),
  execFileSync: vi.fn(),
  x11: {
    getNativeWindowId: vi.fn((): number | null => 123),
    setWmClass: vi.fn(async () => ({ ok: true })),
    remapStates: vi.fn(async () => ({ ok: true })),
    setStates: vi.fn(async () => ({ ok: true })),
    setBlur: vi.fn(async () => ({ ok: true })),
    clearBlur: vi.fn(async () => ({ ok: true })),
    setInputShape: vi.fn(async () => ({ ok: true })),
    setBoundingShape: vi.fn(async () => ({ ok: true })),
    clearBoundingShape: vi.fn(async () => ({ ok: true })),
    activate: vi.fn(async () => ({ ok: true }))
  },
  blur: {
    detectBlurStatus: vi.fn(() => ({
      available: true,
      reason: null,
      compositor: true,
      effectEnabled: true
    })),
    detectStatus: vi.fn(() => ({
      available: true,
      reason: null,
      compositor: true,
      effectEnabled: true
    })),
    resolveX11HelperPath: vi.fn(() => '/nonexistent/quickask-x11')
  },
  compositor: {
    queryCompositorSnapshot: vi.fn(async () => ({ marker: 'snapshot' })),
    readAnimationDurationFactorSync: vi.fn(() => 1.25)
  },
  fonts: {
    listLocalFonts: vi.fn(() => ['Noto Sans CJK SC', 'DejaVu Sans']),
    defaultFontForList: vi.fn(() => 'Noto Sans CJK SC')
  }
}))

vi.mock('electron', () => ({
  app: {
    isPackaged: false,
    getAppPath: () => process.cwd(),
    setLoginItemSettings: vi.fn(),
    getLoginItemSettings: vi.fn(() => ({ openAtLogin: false }))
  },
  screen: {
    getCursorScreenPoint: () => ({ ...h.screenPoint })
  }
}))

vi.mock('node:child_process', () => ({
  execFile: h.execFile,
  execFileSync: h.execFileSync
}))

vi.mock('../../src/main/window/x11', () => h.x11)
vi.mock('../../src/main/settings/blur', () => h.blur)
vi.mock('../../src/main/window/compositor', () => h.compositor)
vi.mock('../../src/main/fonts/list', () => h.fonts)
vi.mock('../../src/main/startup/autostart', () => ({
  AutostartService: class AutostartService {
    constructor(readonly options: unknown) {}
  }
}))

import { AutostartService } from '../../src/main/startup/autostart'
import {
  pointInsideLayout,
  startWindowsPointerPassthrough,
  WINDOWS_BLUR_REASON,
  WINDOWS_FALLBACK_ACCELERATORS,
  WINDOWS_FONT_FAMILIES
} from '../../src/main/platform/win32'
import { selectPlatform } from '../../src/main/platform/index'
import { WINDOWS_LOGIN_ITEM_PATH, WATCHDOG_UNSUPPORTED_REASON } from '../../src/main/startup/types'
import type { LoginItemApi } from '../../src/main/startup/types'

class FakeWindow {
  bounds = { x: 60, y: 172, width: 760, height: 128 }
  visible = true
  destroyed = false
  readonly ignoreCalls: Array<{ ignore: boolean; options?: unknown }> = []
  readonly listeners = new Map<string, Set<() => void>>()
  readonly setIgnoreMouseEvents = vi.fn((ignore: boolean, options?: unknown) => {
    this.ignoreCalls.push({ ignore, options })
  })
  readonly setSkipTaskbar = vi.fn()
  readonly setAlwaysOnTop = vi.fn()
  readonly focus = vi.fn()

  isDestroyed(): boolean {
    return this.destroyed
  }

  isVisible(): boolean {
    return this.visible
  }

  getBounds(): { x: number; y: number; width: number; height: number } {
    return { ...this.bounds }
  }

  on(event: string, listener: () => void): void {
    const bucket = this.listeners.get(event) ?? new Set<() => void>()
    bucket.add(listener)
    this.listeners.set(event, bucket)
  }

  removeListener(event: string, listener: () => void): void {
    this.listeners.get(event)?.delete(listener)
  }

  emit(event: string): void {
    for (const listener of this.listeners.get(event) ?? []) listener()
  }

  asWindow(): BrowserWindow {
    return this as unknown as BrowserWindow
  }
}

function layoutFor(mode: 'S1' | 'S2' | 'S3' = 'S1'): WindowLayout {
  return computeLayout({
    mode,
    barAnchor: { x: 100, y: 200 },
    barWidth: 680,
    barLines: 1,
    panelH: 200,
    workArea: { x: 0, y: 0, width: 1920, height: 1080 },
    scaleFactor: 1
  })
}

function insidePoint(layout: WindowLayout): { x: number; y: number } {
  return {
    x: 60 + layout.barRect.x + 10,
    y: 172 + layout.barRect.y + 10
  }
}

beforeEach(() => {
  vi.clearAllMocks()
  h.screenPoint.x = 0
  h.screenPoint.y = 0
})

describe('platform selector', () => {
  it('maps Linux to the X11 adapter with full capabilities', () => {
    const platform = selectPlatform('linux')
    expect(platform.hostPlatform).toBe('linux')
    expect(platform.info).toMatchObject({
      platform: 'linux',
      label: 'Linux（X11）',
      clickThrough: { state: 'available', precision: 'shape' },
      blur: { state: 'available' },
      fonts: { state: 'available', source: 'fc-list' },
      autostart: { state: 'available', mechanism: 'xdg-desktop' },
      watchdog: { state: 'available' },
      nativeHelper: { state: 'degraded' }
    })
    expect(platform.hotkey.primary).toBe('Control+Alt+Space')
    expect(platform.hotkey.fallbacks).toEqual([
      'Control+Shift+Space',
      'Control+Alt+K',
      'Super+Space'
    ])
    expect(platform.window.prefersSkipTaskbar).toBe(false)
  })

  it('maps win32 to the Windows adapter with honest degraded capabilities', () => {
    const platform = selectPlatform('win32')
    expect(platform.hostPlatform).toBe('win32')
    expect(platform.info).toMatchObject({
      platform: 'win32',
      label: 'Windows 10/11',
      clickThrough: { state: 'degraded', precision: 'whole-window' },
      blur: { state: 'unsupported', reason: WINDOWS_BLUR_REASON },
      fonts: { state: 'degraded', source: 'static' },
      autostart: { state: 'available', mechanism: 'login-item' },
      watchdog: { state: 'unsupported', reason: WATCHDOG_UNSUPPORTED_REASON },
      nativeHelper: { state: 'unsupported' }
    })
    expect(platform.hotkey.fallbacks).toEqual(WINDOWS_FALLBACK_ACCELERATORS)
    expect(platform.window.prefersSkipTaskbar).toBe(true)
  })

  it('maps unknown platforms to a no-op adapter', () => {
    const platform = selectPlatform('darwin')
    expect(platform.info.platform).toBe('other')
    expect(platform.info.clickThrough).toMatchObject({
      state: 'unsupported',
      precision: 'none'
    })
    expect(platform.info.blur.state).toBe('unsupported')
    expect(platform.info.autostart.mechanism).toBe('none')
    expect(platform.window.prefersSkipTaskbar).toBe(false)
    expect(platform.nativeBuild.helperName).toBeNull()
  })

  it('never throws while reading every capability descriptor', () => {
    for (const name of ['linux', 'win32', 'darwin', 'freebsd']) {
      expect(() => JSON.stringify(selectPlatform(name).info)).not.toThrow()
    }
  })
})

describe('Linux adapter', () => {
  it('resolves the XID internally and preserves the X11 call order', async () => {
    const platform = selectPlatform('linux')
    const window = new FakeWindow()
    const layout = layoutFor('S1')
    const rects = [{ x: 1, y: 2, width: 3, height: 4 }]

    await platform.window.setStates(window.asWindow())
    expect(h.x11.getNativeWindowId).toHaveBeenCalledWith(window.asWindow())
    expect(h.x11.setStates).toHaveBeenCalledWith(123)

    await platform.window.setWmClass(window.asWindow(), 'quickask-settings', 'quickask-settings')
    expect(h.x11.setWmClass).toHaveBeenCalledWith(123, 'quickask-settings', 'quickask-settings')

    await platform.window.remapStates(window.asWindow(), rects)
    expect(h.x11.remapStates).toHaveBeenCalledWith(123, rects)

    await platform.window.setBlur(window.asWindow(), rects)
    expect(h.x11.setBlur).toHaveBeenCalledWith(123, rects)

    await platform.window.clearBlur(window.asWindow())
    expect(h.x11.clearBlur).toHaveBeenCalledWith(123)

    await platform.window.setInputShape(window.asWindow(), rects)
    expect(h.x11.setInputShape).toHaveBeenCalledWith(123, rects)

    await platform.window.setBoundingShape(window.asWindow(), rects)
    expect(h.x11.setBoundingShape).toHaveBeenCalledWith(123, rects)

    await platform.window.clearBoundingShape(window.asWindow())
    expect(h.x11.clearBoundingShape).toHaveBeenCalledWith(123)

    await platform.window.activate(window.asWindow())
    expect(h.x11.activate).toHaveBeenCalledWith(123)

    const dispose = platform.window.startPointerPassthrough(window.asWindow(), () => layout)
    dispose()
    expect(window.setIgnoreMouseEvents).not.toHaveBeenCalled()
  })

  it('returns false without calling the helper when the XID is unavailable', async () => {
    const platform = selectPlatform('linux')
    const window = new FakeWindow()
    h.x11.getNativeWindowId.mockReturnValueOnce(null)
    await expect(platform.window.setStates(window.asWindow())).resolves.toEqual({ ok: false })
    expect(h.x11.setStates).not.toHaveBeenCalled()
  })

  it('delegates blur, fonts, startup and command-line switches', async () => {
    const platform = selectPlatform('linux')
    expect(platform.blur.detectStatus()).toEqual({
      available: true,
      reason: null,
      compositor: true,
      effectEnabled: true
    })
    await expect(platform.blur.querySnapshot()).resolves.toEqual({ marker: 'snapshot' })
    expect(platform.blur.animationDurationFactorSync()).toBe(1.25)
    expect(platform.fonts.list()).toEqual(['Noto Sans CJK SC', 'DejaVu Sans'])
    expect(platform.fonts.defaultFor(['x'])).toBe('Noto Sans CJK SC')

    const service = platform.startup.createService({
      settings: {
        getStartup: () => ({ autostart: false, watchdog: false }),
        updateStartup: (patch) => ({ autostart: false, watchdog: false, ...patch })
      },
      projectRoot: '/repo',
      packaged: true,
      execPath: '/repo/quickask'
    })
    expect(service).toBeInstanceOf(AutostartService)

    const appendSwitch = vi.fn()
    platform.applyCommandLineSwitches({ commandLine: { appendSwitch } })
    expect(appendSwitch).toHaveBeenCalledWith('ozone-platform', 'x11')
  })
})

describe('Windows pointer passthrough (pure predicate)', () => {
  it('accepts points inside the bar and rejects the transparent gutter', () => {
    const layout = layoutFor('S1')
    const bounds = { x: 60, y: 172, width: 760, height: 128 }
    expect(pointInsideLayout(insidePoint(layout), bounds, layout)).toBe(true)
    expect(pointInsideLayout({ x: 0, y: 0 }, bounds, layout)).toBe(false)
    expect(pointInsideLayout({ x: 0, y: 0 }, bounds, null)).toBe(true)
  })

  it('includes panel and sidebar rectangles', () => {
    const bounds = { x: 60, y: 172, width: 760, height: 340 }
    const s2 = layoutFor('S2')
    const panel = s2.panelRect!
    expect(
      pointInsideLayout(
        { x: 60 + panel.x + 5, y: 172 + panel.y + 5 },
        bounds,
        s2
      )
    ).toBe(true)

    const s3 = layoutFor('S3')
    const sidebar = s3.sidebarRect!
    expect(
      pointInsideLayout(
        { x: 60 + sidebar.x + 5, y: 172 + sidebar.y + 5 },
        { x: 60, y: 172, width: 760 + 300, height: 340 },
        s3
      )
    ).toBe(true)
  })

  it('adds a small DIP margin to avoid fractional-DPI edge flapping', () => {
    const layout = layoutFor('S1')
    const bounds = { x: 60, y: 172, width: 760, height: 128 }
    const leftEdge = 60 + layout.barRect.x
    expect(pointInsideLayout({ x: leftEdge - 2, y: 210 }, bounds, layout)).toBe(true)
    expect(pointInsideLayout({ x: leftEdge - 4, y: 210 }, bounds, layout)).toBe(false)
  })
})

describe('Windows pointer passthrough (polling)', () => {
  it('toggles only on transitions and resets on hide/dispose', () => {
    vi.useFakeTimers()
    const layout = layoutFor('S1')
    const window = new FakeWindow()
    h.screenPoint = insidePoint(layout)

    const dispose = startWindowsPointerPassthrough(window.asWindow(), () => layout)
    expect(window.ignoreCalls).toHaveLength(0)

    h.screenPoint = { x: 0, y: 0 }
    vi.advanceTimersByTime(50)
    expect(window.ignoreCalls.at(-1)).toEqual({ ignore: true, options: { forward: true } })

    vi.advanceTimersByTime(100)
    expect(window.ignoreCalls).toHaveLength(1)

    h.screenPoint = insidePoint(layout)
    vi.advanceTimersByTime(50)
    expect(window.ignoreCalls.at(-1)).toEqual({ ignore: false, options: undefined })

    window.visible = false
    window.emit('hide')
    expect(window.ignoreCalls.at(-1)?.ignore).toBe(false)

    dispose()
    const afterDispose = window.ignoreCalls.length
    vi.advanceTimersByTime(200)
    expect(window.ignoreCalls).toHaveLength(afterDispose)
    vi.useRealTimers()
  })

  it('does not poll while hidden or after destruction', () => {
    vi.useFakeTimers()
    const layout = layoutFor('S1')
    const window = new FakeWindow()
    window.visible = false
    const dispose = startWindowsPointerPassthrough(window.asWindow(), () => layout)
    vi.advanceTimersByTime(200)
    expect(window.ignoreCalls).toHaveLength(0)

    window.visible = true
    window.destroyed = true
    window.emit('show')
    vi.advanceTimersByTime(100)
    expect(window.ignoreCalls).toHaveLength(0)
    dispose()
    vi.useRealTimers()
  })
})

describe('Windows adapter', () => {
  it('never calls the X11 helper or child_process', async () => {
    const platform = selectPlatform('win32')
    const window = new FakeWindow()
    await platform.window.setWmClass(window.asWindow())
    await platform.window.remapStates(window.asWindow())
    await platform.window.setStates(window.asWindow())
    await platform.window.setBlur(window.asWindow(), [])
    await platform.window.clearBlur(window.asWindow())
    await platform.window.setInputShape(window.asWindow(), [])
    await platform.window.setBoundingShape(window.asWindow(), [])
    await platform.window.clearBoundingShape(window.asWindow())
    await platform.window.activate(window.asWindow())
    platform.fonts.list()
    platform.blur.detectStatus()
    await platform.blur.querySnapshot()
    platform.blur.animationDurationFactorSync()

    expect(h.execFile).not.toHaveBeenCalled()
    expect(h.execFileSync).not.toHaveBeenCalled()
    expect(h.x11.setStates).not.toHaveBeenCalled()
    expect(platform.window.getNativeWindowId(window.asWindow())).toBeNull()
    expect(window.setSkipTaskbar).toHaveBeenCalledWith(true)
    expect(window.setAlwaysOnTop).toHaveBeenCalledWith(true)
    expect(window.focus).toHaveBeenCalled()
  })

  it('returns unsupported for X11-only operations instead of throwing', async () => {
    const platform = selectPlatform('win32')
    const window = new FakeWindow()
    await expect(platform.window.setWmClass(window.asWindow())).resolves.toEqual({ ok: false })
    await expect(platform.window.setBlur(window.asWindow(), [])).resolves.toEqual({ ok: false })
    await expect(platform.window.clearBlur(window.asWindow())).resolves.toEqual({ ok: false })
    await expect(platform.window.setInputShape(window.asWindow(), [])).resolves.toEqual({
      ok: false
    })
    await expect(platform.window.setBoundingShape(window.asWindow(), [])).resolves.toEqual({
      ok: false
    })
    await expect(platform.window.clearBoundingShape(window.asWindow())).resolves.toEqual({
      ok: false
    })
  })

  it('reports unsupported blur and a constant snapshot', async () => {
    const platform = selectPlatform('win32')
    expect(platform.blur.detectStatus()).toEqual({
      available: false,
      reason: WINDOWS_BLUR_REASON,
      compositor: null,
      effectEnabled: null
    })
    const snapshot = await platform.blur.querySnapshot()
    expect(snapshot.blurStatus.available).toBe(false)
    expect(snapshot.compositor).toBeNull()
    expect(snapshot.opaqueMode).toBe(false)
    expect(platform.blur.animationDurationFactorSync()).toBe(1)
  })

  it('returns the fixed Windows font candidates', () => {
    const platform = selectPlatform('win32')
    expect(platform.fonts.list()).toEqual([...WINDOWS_FONT_FAMILIES])
    expect(platform.fonts.defaultFor([...WINDOWS_FONT_FAMILIES])).toBe('Microsoft YaHei UI')
  })

  it('uses the injected login-item API for startup and does not touch X11', () => {
    const platform = selectPlatform('win32')
    const calls: unknown[] = []
    const loginItem: LoginItemApi = {
      setLoginItemSettings: (settings) => calls.push(settings),
      getLoginItemSettings: () => ({ openAtLogin: true, executableWillLaunchAtLogin: true })
    }
    let persisted = { autostart: false, watchdog: false }
    const service = platform.startup.createService({
      settings: {
        getStartup: () => ({ ...persisted }),
        updateStartup: (patch) => {
          persisted = { ...persisted, ...patch }
          return { ...persisted }
        }
      },
      projectRoot: '/repo',
      packaged: true,
      execPath: 'C:/QuickAsk/QuickAsk.exe',
      loginItem
    })
    const state = service.setState({ autostart: true })
    expect(calls).toEqual([
      {
        openAtLogin: true,
        path: 'C:/QuickAsk/QuickAsk.exe',
        args: []
      }
    ])
    expect(state.desktopPath).toBe(WINDOWS_LOGIN_ITEM_PATH)
    expect(state.desktopExists).toBe(true)
    expect(h.execFile).not.toHaveBeenCalled()
  })

  it('does not force an ozone backend on Windows', () => {
    const platform = selectPlatform('win32')
    const appendSwitch = vi.fn()
    platform.applyCommandLineSwitches({ commandLine: { appendSwitch } })
    expect(appendSwitch).not.toHaveBeenCalled()
  })
})
