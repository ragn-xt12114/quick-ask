/**
 * Platform adapter contract.
 *
 * Every capability is exposed as a typed descriptor plus (where needed) a
 * non-throwing implementation. `WindowManager` and the composition root only
 * ever talk to this interface; `process.platform` decisions live exclusively
 * under `src/main/platform/`.
 */

import type { BrowserWindow } from 'electron'
import type { CompositorSnapshot } from '../../shared/appearance-runtime'
import type { BlurStatus } from '../../shared/channels'
import type { Rect, WindowLayout } from '../../shared/geometry'
import type { PlatformCapabilities } from '../../shared/platform'
import type { StartupService, StartupServiceOptions } from '../startup/types'

export interface WindowCallResult {
  ok: boolean
}

export interface CommandLineApp {
  commandLine: {
    appendSwitch(name: string, value?: string): void
  }
}

/**
 * Window-level OS integration. Linux resolves the X11 window id internally and
 * keeps the native helper call order; Windows uses Electron-native behaviour and
 * returns `ok: false` for X11-only operations instead of throwing.
 */
export interface PlatformWindowAdapter {
  /** Windows hides the bar from the taskbar via Electron; Linux uses X11 atoms. */
  readonly prefersSkipTaskbar: boolean
  getNativeWindowId(window: BrowserWindow): number | null
  setWmClass(window: BrowserWindow, instance?: string, klass?: string): Promise<WindowCallResult>
  remapStates(window: BrowserWindow, rects?: Rect[]): Promise<WindowCallResult>
  setStates(window: BrowserWindow): Promise<WindowCallResult>
  setBlur(window: BrowserWindow, rects: Rect[]): Promise<WindowCallResult>
  clearBlur(window: BrowserWindow): Promise<WindowCallResult>
  setInputShape(window: BrowserWindow, rects: Rect[]): Promise<WindowCallResult>
  setBoundingShape(window: BrowserWindow, rects: Rect[]): Promise<WindowCallResult>
  clearBoundingShape(window: BrowserWindow): Promise<WindowCallResult>
  activate(window: BrowserWindow): Promise<WindowCallResult>
  /**
   * Windows cannot apply an X11 shape mask. The degraded implementation polls
   * the cursor and toggles `setIgnoreMouseEvents` only when the hit state
   * changes. Linux returns a no-op disposer.
   */
  startPointerPassthrough(
    window: BrowserWindow,
    getLayout: () => WindowLayout | null
  ): () => void
}

export interface PlatformBlurAdapter {
  readonly capability: PlatformCapabilities['blur']
  /** Synchronous snapshot for `app:bootstrap` before the first async poll. */
  detectStatus(): BlurStatus
  /** Live snapshot used by `CompositorMonitor`; must never spawn unsupported tools. */
  querySnapshot(): Promise<CompositorSnapshot>
  animationDurationFactorSync(): number
}

export interface PlatformFontAdapter {
  readonly capability: PlatformCapabilities['fonts']
  list(): string[]
  defaultFor(fonts: readonly string[]): string
}

export interface PlatformStartupAdapter {
  readonly capability: PlatformCapabilities['autostart']
  createService(options: StartupServiceOptions): StartupService
}

export interface PlatformAdapter {
  /** Raw `process.platform` value for logs and `BootstrapInfo.platform`. */
  readonly hostPlatform: string
  readonly info: PlatformCapabilities
  readonly hotkey: {
    readonly primary: string
    readonly fallbacks: readonly string[]
  }
  readonly window: PlatformWindowAdapter
  readonly blur: PlatformBlurAdapter
  readonly fonts: PlatformFontAdapter
  readonly startup: PlatformStartupAdapter
  readonly nativeBuild: {
    /** Native helper file name, or null when the platform has none. */
    readonly helperName: string | null
  }
  applyCommandLineSwitches(app: CommandLineApp): void
}

/** Common primary accelerator; every supported platform keeps this default. */
export const PLATFORM_PRIMARY_ACCELERATOR = 'Control+Alt+Space'
