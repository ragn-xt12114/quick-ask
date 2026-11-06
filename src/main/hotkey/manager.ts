import type { HotkeyStatus, UiNoticeEvent } from '../../shared/channels'
import { isValidAccelerator } from '../../shared/settings'
import { getLogger } from '../logging'

export const PRIMARY_ACCELERATOR = 'Control+Alt+Space'
export const FALLBACK_ACCELERATORS = [
  'Control+Shift+Space',
  'Control+Alt+K',
  'Super+Space'
] as const
export const HOTKEY_CANDIDATES = [
  PRIMARY_ACCELERATOR,
  ...FALLBACK_ACCELERATORS
] as const

export const HOTKEY_REGISTER_FAILED = 'HOTKEY_REGISTER_FAILED'
export const HOTKEY_FALLBACK_REGISTERED = 'HOTKEY_FALLBACK_REGISTERED'
export const HOTKEY_RECORD_FAILED = 'HOTKEY_RECORD_FAILED'

export interface GlobalShortcutRegistry {
  register(accelerator: string, callback: () => void): boolean
  unregister(accelerator: string): void
  unregisterAll(): void
  isRegistered(accelerator: string): boolean
}

export interface HotkeyManagerOptions {
  registry: GlobalShortcutRegistry
  onTrigger: () => void
  onNotice?: (notice: UiNoticeEvent) => void
  logger?: (line: string) => void
  initialAccelerator?: string | null
  fallbacks?: readonly string[]
}

export function defaultHotkeyStatus(
  primary: string = PRIMARY_ACCELERATOR,
  alternatives: readonly string[] = FALLBACK_ACCELERATORS
): HotkeyStatus {
  return {
    registered: false,
    accelerator: null,
    primary,
    conflict: false,
    tried: [],
    alternatives: [...alternatives]
  }
}

function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message
  return String(error)
}

function acceleratorKey(accelerator: string): string {
  return accelerator.trim().toLowerCase()
}

function uniqueAccelerators(accelerators: readonly string[]): string[] {
  const seen = new Set<string>()
  const result: string[] = []
  for (const accelerator of accelerators) {
    const key = acceleratorKey(accelerator)
    if (key === '' || seen.has(key)) continue
    seen.add(key)
    result.push(accelerator)
  }
  return result
}

export class HotkeyManager {
  private status: HotkeyStatus
  private registeredAccelerator: string | null = null
  private configuredAccelerator: string
  private fallbacks: string[]

  constructor(private readonly options: HotkeyManagerOptions) {
    this.configuredAccelerator = isValidAccelerator(options.initialAccelerator)
      ? options.initialAccelerator.trim()
      : PRIMARY_ACCELERATOR
    this.fallbacks = uniqueAccelerators(options.fallbacks ?? FALLBACK_ACCELERATORS).filter(
      (accelerator) =>
        acceleratorKey(accelerator) !== acceleratorKey(this.configuredAccelerator)
    )
    this.status = defaultHotkeyStatus(this.configuredAccelerator, this.fallbacks)
  }

  getStatus(): HotkeyStatus {
    return {
      ...this.status,
      tried: this.status.tried.map((attempt) => ({ ...attempt })),
      alternatives: [...this.status.alternatives]
    }
  }

  getConfiguredAccelerator(): string {
    return this.configuredAccelerator
  }

  register(): HotkeyStatus {
    this.unregisterAll()
    return this.attempt()
  }

  retry(): HotkeyStatus {
    this.unregisterAll()
    getLogger().info('hotkey_retry')
    this.log(`[hotkey] retrying registration from ${this.configuredAccelerator}`)
    return this.attempt()
  }

  setAccelerator(accelerator: string): HotkeyStatus {
    const next = typeof accelerator === 'string' ? accelerator.trim() : ''
    if (!isValidAccelerator(next)) {
      return this.getStatus()
    }
    if (
      this.status.registered &&
      this.registeredAccelerator !== null &&
      acceleratorKey(this.registeredAccelerator) === acceleratorKey(next) &&
      acceleratorKey(this.configuredAccelerator) === acceleratorKey(next)
    ) {
      return this.getStatus()
    }

    const previousRegistered = this.registeredAccelerator
    const previousConfigured = this.configuredAccelerator
    const previousStatus = this.getStatus()

    this.releaseRegistered()
    const requested = this.tryRegister(next)
    if (requested.ok) {
      this.registeredAccelerator = next
      this.configuredAccelerator = next
      this.fallbacks = this.fallbacks.filter(
        (candidate) => acceleratorKey(candidate) !== acceleratorKey(next)
      )
      this.status = {
        registered: true,
        accelerator: next,
        primary: next,
        conflict: false,
        tried: [{ accelerator: next, ok: true }],
        alternatives: [...this.fallbacks]
      }
      getLogger().info('hotkey_changed', { accelerator: next })
      this.log(`[hotkey] registered ${next}`)
      return this.getStatus()
    }

    const restore = previousRegistered === null ? null : this.tryRegister(previousRegistered)

    if (previousRegistered !== null && restore?.ok) {
      this.registeredAccelerator = previousRegistered
      this.configuredAccelerator = previousConfigured
      this.status = {
        registered: true,
        accelerator: previousRegistered,
        primary: previousConfigured,
        conflict: true,
        tried: [requested.attempt, { accelerator: previousRegistered, ok: true }],
        alternatives: [...this.fallbacks],
        error: `快捷键 ${next} 注册失败，已恢复 ${previousRegistered}`
      }
      getLogger().warn('hotkey_change_failed_restored', {
        requested: next,
        restored: previousRegistered
      })
      this.log(`[hotkey] HOTKEY_RECORD_FAILED ${next}; restored ${previousRegistered}`)
      this.notice({
        level: 'warning',
        code: HOTKEY_RECORD_FAILED,
        message: `快捷键 ${next} 注册失败，已恢复 ${previousRegistered}。`
      })
      return this.getStatus()
    }

    this.registeredAccelerator = null
    this.configuredAccelerator = previousConfigured
    this.status = {
      registered: false,
      accelerator: null,
      primary: previousConfigured,
      conflict: true,
      tried: [requested.attempt, ...(restore ? [restore.attempt] : [])],
      alternatives: [...this.fallbacks],
      error: `快捷键 ${next} 注册失败${previousStatus.accelerator ? '，且原快捷键无法恢复' : ''}`
    }
    getLogger().error('hotkey_change_failed', { requested: next })
    this.log(`[hotkey] HOTKEY_RECORD_FAILED ${next}: no accelerator restored`)
    this.notice({
      level: 'error',
      code: HOTKEY_RECORD_FAILED,
      message: `${this.status.error}。`
    })
    return this.getStatus()
  }

  unregisterAll(): void {
    const accelerator = this.registeredAccelerator
    this.registeredAccelerator = null
    try {
      if (accelerator !== null) this.options.registry.unregister(accelerator)
      this.options.registry.unregisterAll()
    } catch (error) {
      this.log(`[hotkey] unregister failed: ${errorMessage(error)}`)
    }
    this.status = {
      ...this.status,
      registered: false,
      accelerator: null
    }
  }

  private releaseRegistered(): void {
    const accelerator = this.registeredAccelerator
    this.registeredAccelerator = null
    if (accelerator === null) return
    try {
      this.options.registry.unregister(accelerator)
    } catch (error) {
      this.log(`[hotkey] unregister failed: ${errorMessage(error)}`)
    }
  }

  private tryRegister(accelerator: string): {
    ok: boolean
    attempt: HotkeyStatus['tried'][number]
  } {
    let ok = false
    let error: string | undefined
    try {
      ok = this.options.registry.register(accelerator, () => {
        this.options.onTrigger()
      })
    } catch (thrown) {
      error = errorMessage(thrown)
    }
    if (!ok) {
      try {
        if (this.options.registry.isRegistered(accelerator)) {
          this.options.registry.unregister(accelerator)
        }
      } catch {
        // A failed cleanup must not abort the fallback chain.
      }
    }
    return {
      ok,
      attempt: error === undefined ? { accelerator, ok } : { accelerator, ok, error }
    }
  }

  private attempt(): HotkeyStatus {
    const tried: HotkeyStatus['tried'] = []
    const candidates = [this.configuredAccelerator, ...this.fallbacks]

    for (const accelerator of candidates) {
      const result = this.tryRegister(accelerator)
      tried.push(result.attempt)
      getLogger().info('hotkey_attempt', {
        accelerator,
        ok: result.ok,
        error: result.attempt.error ?? null
      })

      if (result.ok) {
        this.registeredAccelerator = accelerator
        const conflict = tried[0]?.ok === false
        this.status = {
          registered: true,
          accelerator,
          primary: this.configuredAccelerator,
          conflict,
          tried,
          alternatives: [...this.fallbacks]
        }
        getLogger().info('hotkey_registered', {
          accelerator,
          primary: this.configuredAccelerator,
          conflict
        })
        this.log(`[hotkey] registered ${accelerator}`)
        if (accelerator !== this.configuredAccelerator) {
          getLogger().warn('hotkey_fallback_registered', {
            accelerator,
            primary: this.configuredAccelerator
          })
          this.notice({
            level: 'warning',
            code: HOTKEY_FALLBACK_REGISTERED,
            message: `主快捷键 ${this.configuredAccelerator} 注册失败，已改用 ${accelerator}。`
          })
        }
        return this.getStatus()
      }

      this.log(`[hotkey] HOTKEY_REGISTER_FAILED accelerator=${accelerator}`)
    }

    const error = `${this.configuredAccelerator} 及备选快捷键均注册失败`
    this.status = {
      registered: false,
      accelerator: null,
      primary: this.configuredAccelerator,
      conflict: true,
      tried,
      alternatives: [...this.fallbacks],
      error
    }
    getLogger().error('hotkey_register_failed_all', {
      tried: candidates.join(',')
    })
    this.log(
      `[hotkey] HOTKEY_REGISTER_FAILED all accelerators failed: ${candidates.join(', ')}`
    )
    this.notice({
      level: 'error',
      code: HOTKEY_REGISTER_FAILED,
      message: `${error}。备选：${this.fallbacks.join('、')}。可从托盘菜单使用应用，或释放快捷键后重试。`
    })
    return this.getStatus()
  }

  private notice(notice: UiNoticeEvent): void {
    try {
      this.options.onNotice?.(notice)
    } catch (error) {
      this.log(`[hotkey] notice delivery failed: ${errorMessage(error)}`)
    }
  }

  private log(line: string): void {
    if (this.options.logger) this.options.logger(line)
    else getLogger().line('info', line)
  }
}
