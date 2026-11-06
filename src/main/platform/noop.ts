/**
 * No-op adapter for platforms QuickAsk has not been ported to.
 *
 * Everything reports `unsupported`; nothing throws and nothing spawns a
 * process. The app can still start and show the honest capability matrix.
 */

import type { CompositorSnapshot } from '../../shared/appearance-runtime'
import type { BlurStatus } from '../../shared/channels'
import { capability, type PlatformCapabilities } from '../../shared/platform'
import { NoopStartupService } from '../startup/noop'
import { WATCHDOG_UNSUPPORTED_REASON } from '../startup/types'
import {
  PLATFORM_PRIMARY_ACCELERATOR,
  type PlatformAdapter,
  type PlatformWindowAdapter,
  type WindowCallResult
} from './types'

const UNSUPPORTED_REASON = '当前平台尚未适配，QuickAsk 只在 Linux X11 和 Windows 10/11 上受支持'

const NOOP_BLUR_STATUS: BlurStatus = Object.freeze({
  available: false,
  reason: UNSUPPORTED_REASON,
  compositor: null,
  effectEnabled: null
})

const NOOP_SNAPSHOT: CompositorSnapshot = Object.freeze({
  compositor: null,
  blurEffect: null,
  blurAvailable: false,
  reason: UNSUPPORTED_REASON,
  blurStatus: NOOP_BLUR_STATUS,
  opaqueMode: false,
  animationDurationFactor: 1
})

function unsupported(): WindowCallResult {
  return { ok: false }
}

const noopWindow: PlatformWindowAdapter = {
  prefersSkipTaskbar: false,
  getNativeWindowId() {
    return null
  },
  async setWmClass() {
    return unsupported()
  },
  async remapStates() {
    return unsupported()
  },
  async setStates() {
    return unsupported()
  },
  async setBlur() {
    return unsupported()
  },
  async clearBlur() {
    return unsupported()
  },
  async setInputShape() {
    return unsupported()
  },
  async setBoundingShape() {
    return unsupported()
  },
  async clearBoundingShape() {
    return unsupported()
  },
  async activate() {
    return unsupported()
  },
  startPointerPassthrough() {
    return () => {
      // no platform integration
    }
  }
}

function noopCapabilities(): PlatformCapabilities {
  return {
    platform: 'other',
    label: '未适配平台',
    hotkey: capability('degraded', 'Electron globalShortcut 可能可用，但未验证'),
    clickThrough: {
      ...capability('unsupported', UNSUPPORTED_REASON),
      precision: 'none'
    },
    blur: capability('unsupported', UNSUPPORTED_REASON),
    fonts: {
      ...capability('degraded', '使用系统默认字体，不枚举字体列表'),
      source: 'none'
    },
    autostart: {
      ...capability('unsupported', UNSUPPORTED_REASON),
      mechanism: 'none'
    },
    watchdog: capability('unsupported', WATCHDOG_UNSUPPORTED_REASON),
    nativeHelper: capability('unsupported', '当前平台没有 X11 helper')
  }
}

export function createNoopAdapter(hostPlatform: string): PlatformAdapter {
  return {
    hostPlatform,
    info: noopCapabilities(),
    hotkey: {
      primary: PLATFORM_PRIMARY_ACCELERATOR,
      fallbacks: ['Control+Shift+Space', 'Control+Alt+K']
    },
    window: noopWindow,
    blur: {
      capability: capability('unsupported', UNSUPPORTED_REASON),
      detectStatus: () => ({ ...NOOP_BLUR_STATUS }),
      querySnapshot: async () => ({
        ...NOOP_SNAPSHOT,
        blurStatus: { ...NOOP_BLUR_STATUS }
      }),
      animationDurationFactorSync: () => 1
    },
    fonts: {
      capability: {
        ...capability('degraded', '使用系统默认字体，不枚举字体列表'),
        source: 'none'
      },
      list: () => ['system-ui', 'sans-serif'],
      defaultFor: (fonts) => fonts[0] ?? 'system-ui'
    },
    startup: {
      capability: {
        ...capability('unsupported', UNSUPPORTED_REASON),
        mechanism: 'none'
      },
      createService: () => new NoopStartupService()
    },
    nativeBuild: {
      helperName: null
    },
    applyCommandLineSwitches() {
      // Do not force an ozone backend on an unknown platform.
    }
  }
}
