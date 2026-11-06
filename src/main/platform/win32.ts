/**
 * Windows 10/11 platform adapter.
 *
 * There is no X11 helper and no acrylic/Mica API that covers both Windows 10
 * and 11. Click-through therefore degrades from an exact X11 shape mask to a
 * whole-window `setIgnoreMouseEvents` toggle driven by the cursor position.
 * Every method is non-throwing and reports unsupported X11 operations as
 * `{ ok: false }`.
 */

import { app, screen, type BrowserWindow } from 'electron'
import type { CompositorSnapshot } from '../../shared/appearance-runtime'
import type { BlurStatus } from '../../shared/channels'
import type { WindowLayout } from '../../shared/geometry'
import { capability, type PlatformCapabilities } from '../../shared/platform'
import { LoginItemStartupService } from '../startup/login-item'
import { WATCHDOG_UNSUPPORTED_REASON } from '../startup/types'
import {
  PLATFORM_PRIMARY_ACCELERATOR,
  type PlatformAdapter,
  type PlatformWindowAdapter,
  type WindowCallResult
} from './types'

export const WINDOWS_FALLBACK_ACCELERATORS = [
  'Control+Shift+Space',
  'Control+Alt+K',
  'Control+Shift+K'
] as const

export const WINDOWS_FONT_FAMILIES = [
  'Microsoft YaHei UI',
  'Segoe UI',
  'Consolas',
  'Cascadia Mono'
] as const

export const WINDOWS_BLUR_REASON =
  '当前平台不支持毛玻璃：Windows 10/11 没有跨版本的 acrylic/Mica 接口，已使用半透明纯色卡片，不伪造模糊'

export const WINDOWS_CLICK_THROUGH_REASON =
  'Windows 无 X11 shape，无法按 12px 间隙精确裁剪点击区域；使用整窗 setIgnoreMouseEvents 按光标位置切换（约 50ms 切换延迟）'

const POINTER_POLL_MS = 50
const POINTER_MARGIN_DIP = 2

const WINDOWS_BLUR_STATUS: BlurStatus = Object.freeze({
  available: false,
  reason: WINDOWS_BLUR_REASON,
  compositor: null,
  effectEnabled: null
})

const WINDOWS_SNAPSHOT: CompositorSnapshot = Object.freeze({
  compositor: null,
  blurEffect: null,
  blurAvailable: false,
  reason: WINDOWS_BLUR_REASON,
  blurStatus: WINDOWS_BLUR_STATUS,
  opaqueMode: false,
  animationDurationFactor: 1
})

function unsupported(): WindowCallResult {
  return { ok: false }
}

interface PointLike {
  x: number
  y: number
}

interface BoundsLike {
  x: number
  y: number
  width: number
  height: number
}

interface RectLike {
  x: number
  y: number
  width: number
  height: number
}

function insideRect(point: PointLike, rect: RectLike, margin: number): boolean {
  return (
    point.x >= rect.x - margin &&
    point.x <= rect.x + rect.width + margin &&
    point.y >= rect.y - margin &&
    point.y <= rect.y + rect.height + margin
  )
}

/**
 * Pure hit test in DIP coordinates. Layout rects are already relative to the
 * OS window; the cursor and window bounds are DIP, so no DPI scaling is needed.
 * A missing layout is treated as interactive (never silently swallow clicks).
 */
export function pointInsideLayout(
  point: PointLike,
  bounds: BoundsLike,
  layout: WindowLayout | null,
  margin = POINTER_MARGIN_DIP
): boolean {
  if (!layout) return true
  const local = { x: point.x - bounds.x, y: point.y - bounds.y }
  if (insideRect(local, layout.barRect, margin)) return true
  if (layout.panelRect && insideRect(local, layout.panelRect, margin)) return true
  if (layout.sidebarRect && insideRect(local, layout.sidebarRect, margin)) return true
  return false
}

/**
 * Degraded click-through: poll only while visible, cache the ignore state and
 * call `setIgnoreMouseEvents` solely on transitions. `forward: true` keeps
 * hover/IME-related mouse-move events flowing while the window is click-through.
 */
export function startWindowsPointerPassthrough(
  window: BrowserWindow,
  getLayout: () => WindowLayout | null
): () => void {
  let ignored = false
  let timer: NodeJS.Timeout | null = null
  let disposed = false

  const applyIgnore = (next: boolean): void => {
    if (disposed || next === ignored) return
    try {
      if (next) window.setIgnoreMouseEvents(true, { forward: true })
      else window.setIgnoreMouseEvents(false)
      ignored = next
    } catch {
      // A destroyed/hidden window must never break the timer.
    }
  }

  const tick = (): void => {
    if (disposed) return
    try {
      if (window.isDestroyed()) return
      if (!window.isVisible()) {
        applyIgnore(false)
        return
      }
      const layout = getLayout()
      const inside = pointInsideLayout(
        screen.getCursorScreenPoint(),
        window.getBounds(),
        layout
      )
      applyIgnore(!inside)
    } catch {
      applyIgnore(false)
    }
  }

  const handleShow = (): void => {
    if (disposed || timer !== null) return
    applyIgnore(false)
    timer = setInterval(tick, POINTER_POLL_MS)
    timer.unref?.()
    tick()
  }

  const handleHide = (): void => {
    if (timer !== null) {
      clearInterval(timer)
      timer = null
    }
    applyIgnore(false)
  }

  window.on('show', handleShow)
  window.on('hide', handleHide)
  if (window.isVisible()) handleShow()

  return () => {
    if (disposed) return
    disposed = true
    window.removeListener('show', handleShow)
    window.removeListener('hide', handleHide)
    if (timer !== null) {
      clearInterval(timer)
      timer = null
    }
    try {
      if (!window.isDestroyed()) window.setIgnoreMouseEvents(false)
    } catch {
      // ignore teardown races
    }
  }
}

const windowsWindow: PlatformWindowAdapter = {
  prefersSkipTaskbar: true,

  getNativeWindowId() {
    return null
  },

  async setWmClass(): Promise<WindowCallResult> {
    return unsupported()
  },

  async remapStates(window): Promise<WindowCallResult> {
    return windowsWindow.setStates(window)
  },

  async setStates(window): Promise<WindowCallResult> {
    try {
      window.setSkipTaskbar(true)
      window.setAlwaysOnTop(true)
      return { ok: true }
    } catch {
      return unsupported()
    }
  },

  async setBlur(): Promise<WindowCallResult> {
    return unsupported()
  },

  async clearBlur(): Promise<WindowCallResult> {
    return unsupported()
  },

  async setInputShape(): Promise<WindowCallResult> {
    return unsupported()
  },

  async setBoundingShape(): Promise<WindowCallResult> {
    return unsupported()
  },

  async clearBoundingShape(): Promise<WindowCallResult> {
    return unsupported()
  },

  async activate(window): Promise<WindowCallResult> {
    try {
      window.focus()
      return { ok: true }
    } catch {
      return unsupported()
    }
  },

  startPointerPassthrough(window, getLayout) {
    return startWindowsPointerPassthrough(window, getLayout)
  }
}

function windowsCapabilities(): PlatformCapabilities {
  return {
    platform: 'win32',
    label: 'Windows 10/11',
    hotkey: capability('available'),
    clickThrough: {
      ...capability('degraded', WINDOWS_CLICK_THROUGH_REASON),
      precision: 'whole-window'
    },
    blur: capability('unsupported', WINDOWS_BLUR_REASON),
    fonts: {
      ...capability('degraded', '不枚举系统字体，只提供内置候选列表'),
      source: 'static'
    },
    autostart: {
      ...capability('available'),
      mechanism: 'login-item'
    },
    watchdog: capability('unsupported', WATCHDOG_UNSUPPORTED_REASON),
    nativeHelper: capability('unsupported', 'Windows 不使用 X11 helper')
  }
}

export function createWin32Adapter(hostPlatform: string): PlatformAdapter {
  return {
    hostPlatform,
    info: windowsCapabilities(),
    hotkey: {
      primary: PLATFORM_PRIMARY_ACCELERATOR,
      fallbacks: WINDOWS_FALLBACK_ACCELERATORS
    },
    window: windowsWindow,
    blur: {
      capability: capability('unsupported', WINDOWS_BLUR_REASON),
      detectStatus: () => ({ ...WINDOWS_BLUR_STATUS }),
      querySnapshot: async () => ({
        ...WINDOWS_SNAPSHOT,
        blurStatus: { ...WINDOWS_BLUR_STATUS }
      }),
      animationDurationFactorSync: () => 1
    },
    fonts: {
      capability: {
        ...capability('degraded', '不枚举系统字体，只提供内置候选列表'),
        source: 'static'
      },
      list: () => [...WINDOWS_FONT_FAMILIES],
      defaultFor: (fonts) =>
        fonts.includes('Microsoft YaHei UI')
          ? 'Microsoft YaHei UI'
          : (fonts[0] ?? 'Microsoft YaHei UI')
    },
    startup: {
      capability: {
        ...capability('available'),
        mechanism: 'login-item'
      },
      createService: (options) =>
        new LoginItemStartupService(options, options.loginItem ?? app)
    },
    nativeBuild: {
      helperName: null
    },
    applyCommandLineSwitches() {
      // Electron's default backend is correct on Windows; no ozone override.
    }
  }
}
