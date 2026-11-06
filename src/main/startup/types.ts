/**
 * Platform-neutral startup contract.
 *
 * Linux uses the XDG `.desktop` file (see `autostart.ts`); Windows uses an
 * Electron login item. Both return the same `StartupState` so the settings UI
 * never needs a platform branch.
 */

import type { StartupState } from '../../shared/channels'
import type { StartupSettings } from '../../shared/settings'

export interface StartupSettingsStore {
  getStartup(): StartupSettings
  updateStartup(patch: Partial<StartupSettings>): StartupSettings
}

export interface LoginItemApi {
  setLoginItemSettings(settings: {
    openAtLogin: boolean
    path?: string
    args?: string[]
  }): void
  getLoginItemSettings(options?: { path?: string; args?: string[] }): {
    openAtLogin: boolean
    executableWillLaunchAtLogin?: boolean
  }
}

export interface StartupServiceOptions {
  settings: StartupSettingsStore
  projectRoot: string
  packaged: boolean
  execPath: string
  env?: NodeJS.ProcessEnv
  home?: string
  /** Injected Electron app for tests; the Windows adapter passes the real app. */
  loginItem?: LoginItemApi
}

export interface StartupService {
  getState(error?: string | null): StartupState
  setState(patch: { autostart?: boolean; watchdog?: boolean }): StartupState
  reconcile(): StartupState
}

/** Registry Run key shown in Settings → Behavior on Windows. */
export const WINDOWS_LOGIN_ITEM_PATH =
  'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Run\\QuickAsk'

export const WATCHDOG_UNSUPPORTED_REASON =
  '当前平台不支持看门狗（仅 Linux XDG 自启动支持守护脚本），已保留登录自启'
