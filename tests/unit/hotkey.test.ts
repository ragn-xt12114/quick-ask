import { describe, expect, it } from 'vitest'
import type { UiNoticeEvent } from '../../src/shared/channels'
import {
  FALLBACK_ACCELERATORS,
  HOTKEY_RECORD_FAILED,
  HotkeyManager,
  PRIMARY_ACCELERATOR,
  type GlobalShortcutRegistry
} from '../../src/main/hotkey/manager'

class FakeRegistry implements GlobalShortcutRegistry {
  readonly pressed = new Map<string, () => void>()
  readonly blocked = new Set<string>()

  register(accelerator: string, callback: () => void): boolean {
    if (this.blocked.has(accelerator) || this.pressed.has(accelerator)) return false
    this.pressed.set(accelerator, callback)
    return true
  }

  unregister(accelerator: string): void {
    this.pressed.delete(accelerator)
  }

  unregisterAll(): void {
    this.pressed.clear()
  }

  isRegistered(accelerator: string): boolean {
    return this.pressed.has(accelerator)
  }

  trigger(accelerator = PRIMARY_ACCELERATOR): void {
    this.pressed.get(accelerator)?.()
  }
}

interface Harness {
  registry: FakeRegistry
  manager: HotkeyManager
  notices: UiNoticeEvent[]
  logs: string[]
  triggers: number
}

function harness(blocked: string[] = [], initialAccelerator?: string): Harness {
  const registry = new FakeRegistry()
  for (const accelerator of blocked) registry.blocked.add(accelerator)
  const notices: UiNoticeEvent[] = []
  const logs: string[] = []
  const state = { triggers: 0 }
  const manager = new HotkeyManager({
    registry,
    ...(initialAccelerator !== undefined ? { initialAccelerator } : {}),
    onTrigger: () => {
      state.triggers += 1
    },
    onNotice: (notice) => notices.push(notice),
    logger: (line) => logs.push(line)
  })
  return {
    registry,
    manager,
    notices,
    logs,
    get triggers() {
      return state.triggers
    }
  }
}

describe('HotkeyManager', () => {
  it('registers the primary accelerator first', () => {
    const h = harness()
    const status = h.manager.register()

    expect(status.registered).toBe(true)
    expect(status.accelerator).toBe(PRIMARY_ACCELERATOR)
    expect(status.primary).toBe(PRIMARY_ACCELERATOR)
    expect(status.conflict).toBe(false)
    expect(status.tried).toEqual([{ accelerator: PRIMARY_ACCELERATOR, ok: true }])
    expect(status.alternatives).toEqual([...FALLBACK_ACCELERATORS])
    expect(h.notices).toEqual([])
    expect([...h.registry.pressed.keys()]).toEqual([PRIMARY_ACCELERATOR])

    h.registry.trigger()
    expect(h.triggers).toBe(1)
  })

  it('falls back to Control+Shift+Space when the primary is occupied', () => {
    const h = harness([PRIMARY_ACCELERATOR])
    const status = h.manager.register()

    expect(status.registered).toBe(true)
    expect(status.accelerator).toBe(FALLBACK_ACCELERATORS[0])
    expect(status.conflict).toBe(true)
    expect(status.tried).toEqual([
      { accelerator: PRIMARY_ACCELERATOR, ok: false },
      { accelerator: FALLBACK_ACCELERATORS[0], ok: true }
    ])
    expect(h.notices[0]?.level).toBe('warning')
    expect(h.notices[0]?.code).toBe('HOTKEY_FALLBACK_REGISTERED')
    expect(h.notices[0]?.message).toContain(FALLBACK_ACCELERATORS[0]!)
    expect([...h.registry.pressed.keys()]).toEqual([FALLBACK_ACCELERATORS[0]])
  })

  it('walks the complete fallback chain and records every failure', () => {
    const h = harness([PRIMARY_ACCELERATOR, ...FALLBACK_ACCELERATORS.slice(0, 2)])
    const status = h.manager.register()

    expect(status.registered).toBe(true)
    expect(status.accelerator).toBe(FALLBACK_ACCELERATORS[2])
    expect(status.tried.map((attempt) => attempt.ok)).toEqual([false, false, false, true])
  })

  it('keeps the app alive and emits an error notice when every accelerator fails', () => {
    const h = harness([PRIMARY_ACCELERATOR, ...FALLBACK_ACCELERATORS])
    const status = h.manager.register()

    expect(status.registered).toBe(false)
    expect(status.accelerator).toBeNull()
    expect(status.conflict).toBe(true)
    expect(status.tried).toHaveLength(4)
    expect(status.error).toContain('失败')
    expect(h.notices).toHaveLength(1)
    expect(h.notices[0]?.level).toBe('error')
    expect(h.notices[0]?.code).toBe('HOTKEY_REGISTER_FAILED')
    for (const accelerator of FALLBACK_ACCELERATORS) {
      expect(h.notices[0]?.message).toContain(accelerator)
    }
    expect(h.logs.some((line) => line.includes('HOTKEY_REGISTER_FAILED'))).toBe(true)
    expect(h.registry.pressed.size).toBe(0)
  })

  it('retry() recovers the primary after the conflicting client releases it', () => {
    const h = harness([PRIMARY_ACCELERATOR, FALLBACK_ACCELERATORS[0], FALLBACK_ACCELERATORS[1]])
    const first = h.manager.register()
    expect(first.accelerator).toBe(FALLBACK_ACCELERATORS[2])

    h.registry.blocked.clear()
    const retried = h.manager.retry()

    expect(retried.registered).toBe(true)
    expect(retried.accelerator).toBe(PRIMARY_ACCELERATOR)
    expect(retried.conflict).toBe(false)
    expect(retried.tried).toEqual([{ accelerator: PRIMARY_ACCELERATOR, ok: true }])
    expect([...h.registry.pressed.keys()]).toEqual([PRIMARY_ACCELERATOR])

    h.registry.trigger()
    expect(h.triggers).toBe(1)
  })

  it('retry() after total failure reports success and does not duplicate notices', () => {
    const h = harness([PRIMARY_ACCELERATOR, ...FALLBACK_ACCELERATORS])
    expect(h.manager.register().registered).toBe(false)
    expect(h.notices).toHaveLength(1)

    h.registry.blocked.clear()
    const retried = h.manager.retry()
    expect(retried.registered).toBe(true)
    expect(retried.accelerator).toBe(PRIMARY_ACCELERATOR)
    expect(h.notices).toHaveLength(1)
  })

  it('records a custom accelerator and makes it the primary', () => {
    const h = harness([], 'Control+Alt+J')
    const status = h.manager.register()

    expect(status.registered).toBe(true)
    expect(status.accelerator).toBe('Control+Alt+J')
    expect(status.primary).toBe('Control+Alt+J')
    expect(status.tried).toEqual([{ accelerator: 'Control+Alt+J', ok: true }])
    expect([...h.registry.pressed.keys()]).toEqual(['Control+Alt+J'])

    h.registry.trigger('Control+Alt+J')
    expect(h.triggers).toBe(1)
  })

  it('uses the configured accelerator at startup, then falls back', () => {
    const h = harness(['Control+Alt+J'], 'Control+Alt+J')
    const status = h.manager.register()

    expect(status.registered).toBe(true)
    expect(status.primary).toBe('Control+Alt+J')
    expect(status.accelerator).toBe(FALLBACK_ACCELERATORS[0])
    expect(status.conflict).toBe(true)
    expect(status.tried.map((attempt) => attempt.accelerator)).toEqual([
      'Control+Alt+J',
      FALLBACK_ACCELERATORS[0]
    ])
    expect(h.notices[0]?.code).toBe('HOTKEY_FALLBACK_REGISTERED')
    expect(h.notices[0]?.message).toContain('Control+Alt+J')
  })

  it('setAccelerator() registers the new accelerator transactionally', () => {
    const h = harness()
    h.manager.register()

    const status = h.manager.setAccelerator('Control+Shift+J')

    expect(status.registered).toBe(true)
    expect(status.accelerator).toBe('Control+Shift+J')
    expect(status.primary).toBe('Control+Shift+J')
    expect(status.conflict).toBe(false)
    expect([...h.registry.pressed.keys()]).toEqual(['Control+Shift+J'])
    expect(h.manager.getConfiguredAccelerator()).toBe('Control+Shift+J')

    h.registry.trigger('Control+Shift+J')
    expect(h.triggers).toBe(1)
  })

  it('setAccelerator() rolls back to the previous accelerator on conflict', () => {
    const h = harness(['Control+Shift+J'])
    h.manager.register()
    expect(h.manager.getStatus().accelerator).toBe(PRIMARY_ACCELERATOR)

    const status = h.manager.setAccelerator('Control+Shift+J')

    expect(status.registered).toBe(true)
    expect(status.accelerator).toBe(PRIMARY_ACCELERATOR)
    expect(status.primary).toBe(PRIMARY_ACCELERATOR)
    expect(status.conflict).toBe(true)
    expect(status.error).toContain('Control+Shift+J')
    expect(status.error).toContain(PRIMARY_ACCELERATOR)
    expect(status.tried).toEqual([
      { accelerator: 'Control+Shift+J', ok: false },
      { accelerator: PRIMARY_ACCELERATOR, ok: true }
    ])
    expect(h.manager.getConfiguredAccelerator()).toBe(PRIMARY_ACCELERATOR)
    expect([...h.registry.pressed.keys()]).toEqual([PRIMARY_ACCELERATOR])

    h.registry.trigger()
    expect(h.triggers).toBe(1)
    expect(h.notices.at(-1)?.code).toBe(HOTKEY_RECORD_FAILED)
  })

  it('setAccelerator() rejects an invalid accelerator without releasing the old one', () => {
    const h = harness()
    h.manager.register()

    const status = h.manager.setAccelerator('Space')

    expect(status.registered).toBe(true)
    expect(status.accelerator).toBe(PRIMARY_ACCELERATOR)
    expect(status.conflict).toBe(false)
    expect([...h.registry.pressed.keys()]).toEqual([PRIMARY_ACCELERATOR])
  })

  it('unregisterAll() releases the active shortcut and clears the status', () => {
    const h = harness()
    h.manager.register()
    h.manager.unregisterAll()

    expect(h.registry.pressed.size).toBe(0)
    expect(h.manager.getStatus().registered).toBe(false)
    expect(h.manager.getStatus().accelerator).toBeNull()
  })
})
