import { describe, expect, it } from 'vitest'
import type { StartupState } from '../../src/shared/channels'
import {
  DEFAULT_STARTUP,
  normalizeStartup,
  type StartupSettings
} from '../../src/shared/settings'
import { LoginItemStartupService } from '../../src/main/startup/login-item'
import {
  WATCHDOG_UNSUPPORTED_REASON,
  WINDOWS_LOGIN_ITEM_PATH,
  type LoginItemApi,
  type StartupSettingsStore
} from '../../src/main/startup/types'
import { NoopStartupService, STARTUP_UNSUPPORTED_REASON } from '../../src/main/startup/noop'

class FakeSettingsStore implements StartupSettingsStore {
  private startup: StartupSettings

  constructor(initial: Partial<StartupSettings> = {}) {
    this.startup = normalizeStartup({ ...DEFAULT_STARTUP, ...initial })
  }

  getStartup(): StartupSettings {
    return { ...this.startup }
  }

  updateStartup(patch: Partial<StartupSettings>): StartupSettings {
    this.startup = normalizeStartup({ ...this.startup, ...patch })
    return { ...this.startup }
  }
}

interface SetCall {
  openAtLogin: boolean
  path?: string
  args?: string[]
}

class FakeLoginItem implements LoginItemApi {
  openAtLogin = false
  executableWillLaunchAtLogin: boolean | undefined
  readonly setCalls: SetCall[] = []
  readonly getCalls: Array<{ path?: string; args?: string[] }> = []
  failSet = false
  failGet = false
  ignoreSet = false

  setLoginItemSettings(settings: SetCall): void {
    if (this.failSet) throw new Error('set failed')
    this.setCalls.push({ ...settings })
    if (this.ignoreSet) return
    this.openAtLogin = settings.openAtLogin
    if (this.executableWillLaunchAtLogin !== undefined) {
      this.executableWillLaunchAtLogin = settings.openAtLogin
    }
  }

  getLoginItemSettings(options?: { path?: string; args?: string[] }): {
    openAtLogin: boolean
    executableWillLaunchAtLogin?: boolean
  } {
    if (this.failGet) throw new Error('read failed')
    this.getCalls.push({ ...options })
    return {
      openAtLogin: this.openAtLogin,
      ...(this.executableWillLaunchAtLogin === undefined
        ? {}
        : { executableWillLaunchAtLogin: this.executableWillLaunchAtLogin })
    }
  }
}

function service(
  initial: Partial<StartupSettings> = {},
  options: { packaged?: boolean } = {}
): {
  service: LoginItemStartupService
  store: FakeSettingsStore
  api: FakeLoginItem
} {
  const store = new FakeSettingsStore(initial)
  const api = new FakeLoginItem()
  return {
    store,
    api,
    service: new LoginItemStartupService(
      {
        settings: store,
        projectRoot: '/repo/quick-ask',
        packaged: options.packaged ?? true,
        execPath: 'C:/Program Files/QuickAsk/QuickAsk.exe'
      },
      api
    )
  }
}

describe('LoginItemStartupService', () => {
  it('registers the packaged executable with no dev args and reads it back', () => {
    const { service: instance, api } = service({ autostart: false })
    const state = instance.setState({ autostart: true })

    expect(api.setCalls).toEqual([
      {
        openAtLogin: true,
        path: 'C:/Program Files/QuickAsk/QuickAsk.exe',
        args: []
      }
    ])
    expect(api.getCalls[0]).toEqual({
      path: 'C:/Program Files/QuickAsk/QuickAsk.exe',
      args: []
    })
    expect(state.autostart).toBe(true)
    expect(state.desktopExists).toBe(true)
    expect(state.desktopPath).toBe(WINDOWS_LOGIN_ITEM_PATH)
    expect(state.error).toBeNull()
  })

  it('passes the project root as an argument in development', () => {
    const { service: instance, api } = service({}, { packaged: false })
    instance.setState({ autostart: true })
    expect(api.setCalls[0]).toEqual({
      openAtLogin: true,
      path: 'C:/Program Files/QuickAsk/QuickAsk.exe',
      args: ['/repo/quick-ask']
    })
    expect(api.getCalls[0]?.args).toEqual(['/repo/quick-ask'])
  })

  it('prefers executableWillLaunchAtLogin over openAtLogin when reading back', () => {
    const { service: instance, api } = service({ autostart: true })
    api.openAtLogin = false
    api.executableWillLaunchAtLogin = true
    expect(instance.getState().desktopExists).toBe(true)
  })

  it('removes the login item when autostart is disabled', () => {
    const { service: instance, api } = service({ autostart: true })
    api.openAtLogin = true
    const state = instance.setState({ autostart: false })
    expect(api.setCalls[0]?.openAtLogin).toBe(false)
    expect(state.autostart).toBe(false)
    expect(state.desktopExists).toBe(false)
    expect(state.desktopPath).toBe(WINDOWS_LOGIN_ITEM_PATH)
  })

  it('forces watchdog off and reports the unsupported reason', () => {
    const { service: instance, store } = service({ autostart: true, watchdog: true })
    const state = instance.setState({ watchdog: true })
    expect(store.getStartup().watchdog).toBe(false)
    expect(state.watchdog).toBe(false)
    expect(state.error).toBe(WATCHDOG_UNSUPPORTED_REASON)
  })

  it('reports a read-back mismatch instead of pretending success', () => {
    const { service: instance, api } = service({ autostart: false })
    api.ignoreSet = true
    const state = instance.setState({ autostart: true })
    expect(state.desktopExists).toBe(false)
    expect(state.error).toBe('登录项状态未生效')
  })

  it('never throws when the login item API fails', () => {
    const { service: instance, api } = service({ autostart: false })
    api.failSet = true
    let state: StartupState | undefined
    expect(() => {
      state = instance.setState({ autostart: true })
    }).not.toThrow()
    expect(state?.error).toBe('set failed')
    expect(state?.desktopExists).toBe(false)
  })

  it('reconcile repairs a missing registration', () => {
    const { service: instance, api } = service({ autostart: true })
    const state = instance.reconcile()
    expect(api.setCalls).toHaveLength(1)
    expect(api.setCalls[0]?.openAtLogin).toBe(true)
    expect(state.desktopExists).toBe(true)
  })

  it('getState never throws when reading the login item fails', () => {
    const { service: instance, api } = service({ autostart: true })
    api.failGet = true
    let state: StartupState | undefined
    expect(() => {
      state = instance.getState()
    }).not.toThrow()
    expect(state?.error).toBe('read failed')
    expect(state?.desktopExists).toBe(false)
  })
})

describe('NoopStartupService', () => {
  it('reports unsupported without writing anything', () => {
    const instance = new NoopStartupService()
    expect(instance.getState()).toEqual({
      autostart: false,
      watchdog: false,
      desktopPath: 'N/A',
      desktopExists: false,
      error: STARTUP_UNSUPPORTED_REASON
    })
    expect(instance.setState({ autostart: true }).error).toBe(STARTUP_UNSUPPORTED_REASON)
    expect(instance.reconcile().error).toBe(STARTUP_UNSUPPORTED_REASON)
  })
})
