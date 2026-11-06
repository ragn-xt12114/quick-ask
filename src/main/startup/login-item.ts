/**
 * Windows login-item autostart.
 *
 * `setLoginItemSettings` writes an HKCU Run entry; the value is read back with
 * `getLoginItemSettings({ path, args })` so the UI never claims a registration
 * that Windows did not actually persist. Watchdog is Linux-only and is forced
 * off with an explicit reason instead of pretending it works.
 */

import type { StartupState } from '../../shared/channels'
import { normalizeStartup, type StartupSettings } from '../../shared/settings'
import {
  WATCHDOG_UNSUPPORTED_REASON,
  WINDOWS_LOGIN_ITEM_PATH,
  type LoginItemApi,
  type StartupService,
  type StartupServiceOptions
} from './types'

function describeError(error: unknown): string {
  const message = error instanceof Error ? error.message : 'login item update failed'
  return message.length > 300 ? `${message.slice(0, 297)}...` : message
}

interface ReadResult {
  registered: boolean
  error: string | null
}

export class LoginItemStartupService implements StartupService {
  constructor(
    private readonly options: StartupServiceOptions,
    private readonly api: LoginItemApi
  ) {}

  private loginArgs(): string[] {
    return this.options.packaged ? [] : [this.options.projectRoot]
  }

  private readRegistered(): ReadResult {
    try {
      const settings = this.api.getLoginItemSettings({
        path: this.options.execPath,
        args: this.loginArgs()
      })
      const registered =
        typeof settings.executableWillLaunchAtLogin === 'boolean'
          ? settings.executableWillLaunchAtLogin
          : settings.openAtLogin
      return { registered, error: null }
    } catch (error) {
      return { registered: false, error: describeError(error) }
    }
  }

  getState(error: string | null = null): StartupState {
    const startup = normalizeStartup(this.options.settings.getStartup())
    const read = this.readRegistered()
    const watchdogError = startup.watchdog ? WATCHDOG_UNSUPPORTED_REASON : null
    return {
      autostart: startup.autostart,
      watchdog: false,
      desktopPath: WINDOWS_LOGIN_ITEM_PATH,
      desktopExists: read.registered,
      error: error ?? read.error ?? watchdogError
    }
  }

  setState(patch: { autostart?: boolean; watchdog?: boolean }): StartupState {
    const requested = this.options.settings.updateStartup({
      ...(typeof patch.autostart === 'boolean' ? { autostart: patch.autostart } : {}),
      ...(typeof patch.watchdog === 'boolean' ? { watchdog: patch.watchdog } : {})
    })
    const persisted = this.options.settings.updateStartup({ watchdog: false })
    return this.apply(persisted, requested.watchdog || persisted.watchdog)
  }

  reconcile(): StartupState {
    const startup = normalizeStartup(this.options.settings.getStartup())
    const persisted = startup.watchdog
      ? this.options.settings.updateStartup({ watchdog: false })
      : startup
    return this.apply(persisted, startup.watchdog)
  }

  private apply(startup: StartupSettings, requestedWatchdog = false): StartupState {
    try {
      this.api.setLoginItemSettings({
        openAtLogin: startup.autostart,
        path: this.options.execPath,
        args: this.loginArgs()
      })
      const read = this.readRegistered()
      if (read.error) return this.getState(read.error)
      if (read.registered !== startup.autostart) {
        return this.getState('登录项状态未生效')
      }
      return this.getState(requestedWatchdog ? WATCHDOG_UNSUPPORTED_REASON : null)
    } catch (error) {
      return this.getState(describeError(error))
    }
  }
}
