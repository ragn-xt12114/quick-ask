/**
 * Linux (X11) platform adapter.
 *
 * This module is the only place that knows about X11, KWin, `fc-list` and XDG
 * autostart. Every method is non-throwing: the native helper already returns
 * typed failures, and detection helpers swallow their own probe errors.
 */

import { existsSync } from 'node:fs'
import { AutostartService } from '../startup/autostart'
import { defaultFontForList, listLocalFonts } from '../fonts/list'
import { detectBlurStatus, resolveX11HelperPath } from '../settings/blur'
import { queryCompositorSnapshot, readAnimationDurationFactorSync } from '../window/compositor'
import * as x11 from '../window/x11'
import { capability, type CapabilityStatus, type PlatformCapabilities } from '../../shared/platform'
import {
  PLATFORM_PRIMARY_ACCELERATOR,
  type PlatformAdapter,
  type PlatformWindowAdapter,
  type WindowCallResult
} from './types'

export const LINUX_FALLBACK_ACCELERATORS = [
  'Control+Shift+Space',
  'Control+Alt+K',
  'Super+Space'
] as const

function nativeHelperStatus(): CapabilityStatus {
  try {
    const path = resolveX11HelperPath()
    if (existsSync(path)) return capability('available')
    return capability(
      'degraded',
      'native/quickask-x11 未编译；点击穿透/毛玻璃能力不可用（运行 npm run build:native 后重启）'
    )
  } catch {
    return capability('degraded', '无法检查 X11 helper 路径')
  }
}

function linuxCapabilities(): PlatformCapabilities {
  return {
    platform: 'linux',
    label: 'Linux（X11）',
    hotkey: capability('available'),
    clickThrough: {
      ...capability('available'),
      precision: 'shape'
    },
    blur: capability('available'),
    fonts: {
      ...capability('available'),
      source: 'fc-list'
    },
    autostart: {
      ...capability('available'),
      mechanism: 'xdg-desktop'
    },
    watchdog: capability('available'),
    nativeHelper: nativeHelperStatus()
  }
}

function x11WindowId(window: Parameters<PlatformWindowAdapter['getNativeWindowId']>[0]): number | null {
  return x11.getNativeWindowId(window)
}

const linuxWindow: PlatformWindowAdapter = {
  prefersSkipTaskbar: false,

  getNativeWindowId(window) {
    return x11.getNativeWindowId(window)
  },

  async setWmClass(window, instance = 'quickask', klass = instance): Promise<WindowCallResult> {
    const wid = x11WindowId(window)
    if (wid === null) return { ok: false }
    return x11.setWmClass(wid, instance, klass)
  },

  async remapStates(window, rects): Promise<WindowCallResult> {
    const wid = x11WindowId(window)
    if (wid === null) return { ok: false }
    return x11.remapStates(wid, rects)
  },

  async setStates(window): Promise<WindowCallResult> {
    const wid = x11WindowId(window)
    if (wid === null) return { ok: false }
    return x11.setStates(wid)
  },

  async setBlur(window, rects): Promise<WindowCallResult> {
    const wid = x11WindowId(window)
    if (wid === null) return { ok: false }
    return x11.setBlur(wid, rects)
  },

  async clearBlur(window): Promise<WindowCallResult> {
    const wid = x11WindowId(window)
    if (wid === null) return { ok: false }
    return x11.clearBlur(wid)
  },

  async setInputShape(window, rects): Promise<WindowCallResult> {
    const wid = x11WindowId(window)
    if (wid === null) return { ok: false }
    return x11.setInputShape(wid, rects)
  },

  async setBoundingShape(window, rects): Promise<WindowCallResult> {
    const wid = x11WindowId(window)
    if (wid === null) return { ok: false }
    return x11.setBoundingShape(wid, rects)
  },

  async clearBoundingShape(window): Promise<WindowCallResult> {
    const wid = x11WindowId(window)
    if (wid === null) return { ok: false }
    return x11.clearBoundingShape(wid)
  },

  async activate(window): Promise<WindowCallResult> {
    const wid = x11WindowId(window)
    if (wid === null) return { ok: false }
    return x11.activate(wid)
  },

  startPointerPassthrough() {
    return () => {
      // X11 uses ShapeInput; there is nothing to toggle.
    }
  }
}

export function createLinuxAdapter(hostPlatform: string): PlatformAdapter {
  return {
    hostPlatform,
    info: linuxCapabilities(),
    hotkey: {
      primary: PLATFORM_PRIMARY_ACCELERATOR,
      fallbacks: LINUX_FALLBACK_ACCELERATORS
    },
    window: linuxWindow,
    blur: {
      capability: capability('available'),
      detectStatus: () => detectBlurStatus(),
      querySnapshot: () => queryCompositorSnapshot(),
      animationDurationFactorSync: () => readAnimationDurationFactorSync()
    },
    fonts: {
      capability: {
        ...capability('available'),
        source: 'fc-list'
      },
      list: () => listLocalFonts(),
      defaultFor: (fonts) => defaultFontForList(fonts)
    },
    startup: {
      capability: {
        ...capability('available'),
        mechanism: 'xdg-desktop'
      },
      createService: (options) => new AutostartService(options)
    },
    nativeBuild: {
      helperName: 'quickask-x11'
    },
    applyCommandLineSwitches(appLike) {
      appLike.commandLine.appendSwitch('ozone-platform', 'x11')
    }
  }
}
