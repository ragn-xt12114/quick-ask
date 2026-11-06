import { describe, expect, it } from 'vitest'
import {
  Lifecycle,
  type DbCheckpointResult,
  type LifecycleOptions,
  type LifecycleWebContentsLike,
  type LifecycleWindowLike
} from '../../src/main/lifecycle'

class FakeWindow implements LifecycleWindowLike {
  readonly listeners: ((event: { preventDefault(): void }) => void)[] = []
  preventDefaultCalls = 0

  on(
    _event: 'close',
    listener: (event: { preventDefault(): void }) => void
  ): this {
    this.listeners.push(listener)
    return this
  }

  close(): void {
    for (const listener of this.listeners) {
      listener({
        preventDefault: () => {
          this.preventDefaultCalls += 1
        }
      })
    }
  }
}

class FakeContents implements LifecycleWebContentsLike {
  private readonly listeners: ((
    event: unknown,
    details: { reason: string; exitCode: number }
  ) => void)[] = []

  on(
    _event: 'render-process-gone',
    listener: (event: unknown, details: { reason: string; exitCode: number }) => void
  ): this {
    this.listeners.push(listener)
    return this
  }

  crash(reason: string, exitCode = 134): void {
    for (const listener of this.listeners) listener({}, { reason, exitCode })
  }
}

interface Recorder {
  lifecycle: Lifecycle
  steps: string[]
  logs: string[]
  exits: number[]
}

function recorder(overrides: Partial<LifecycleOptions> = {}): Recorder {
  const steps: string[] = []
  const logs: string[] = []
  const exits: number[] = []
  const lifecycle = new Lifecycle({
    hideMain: () => steps.push('hide'),
    checkpointDb: (): DbCheckpointResult => {
      steps.push('checkpoint')
      return { ok: true, busy: 0, log: 0, checkpointed: 0 }
    },
    destroyTray: () => steps.push('tray'),
    unregisterHotkeys: () => steps.push('hotkeys'),
    closeServices: () => steps.push('services'),
    destroyWindows: () => steps.push('windows'),
    exit: (code) => {
      exits.push(code)
    },
    logger: (line) => logs.push(line),
    hookTimeoutMs: 500,
    forceExitTimeoutMs: 500,
    ...overrides
  })
  return { lifecycle, steps, logs, exits }
}

describe('Lifecycle close handling', () => {
  it('Alt+F4 / close is prevented and hidden while the app stays alive', () => {
    const h = recorder()
    const window = new FakeWindow()
    h.lifecycle.attachMainWindow(window)

    window.close()

    expect(window.preventDefaultCalls).toBe(1)
    expect(h.steps).toEqual(['hide'])
    expect(h.lifecycle.isQuitting()).toBe(false)
  })

  it('does not attach duplicate close handlers to the same window', () => {
    const h = recorder()
    const window = new FakeWindow()
    h.lifecycle.attachMainWindow(window)
    h.lifecycle.attachMainWindow(window)
    expect(window.listeners).toHaveLength(1)
  })

  it('lets close pass through once quitting starts', () => {
    const h = recorder()
    const window = new FakeWindow()
    h.lifecycle.attachMainWindow(window)

    void h.lifecycle.quit('test')
    expect(h.lifecycle.isQuitting()).toBe(true)
    window.close()

    expect(window.preventDefaultCalls).toBe(0)
    expect(h.steps).not.toContain('hide')
  })
})

describe('Lifecycle quit sequencing', () => {
  it('runs hooks once, then checkpoint, tray, hotkeys, services, windows and exit', async () => {
    const h = recorder()
    h.lifecycle.registerQuitHook(() => {
      h.steps.push('hook-1')
    })
    h.lifecycle.registerQuitHook(() => {
      h.steps.push('hook-2')
    })

    await h.lifecycle.quit('tray')
    await h.lifecycle.quit('tray-again')

    expect(h.steps).toEqual([
      'hook-1',
      'hook-2',
      'checkpoint',
      'tray',
      'hotkeys',
      'services',
      'windows'
    ])
    expect(h.exits).toEqual([0])
  })

  it('keeps going when one cleanup step throws', async () => {
    const h = recorder({
      checkpointDb: () => {
        throw new Error('disk sk-secret-123')
      },
      destroyTray: () => {
        throw new Error('tray gone')
      }
    })

    await h.lifecycle.quit('test')

    expect(h.steps).toEqual(['hotkeys', 'services', 'windows'])
    expect(h.exits).toEqual([0])
    expect(h.logs.join('\n')).not.toContain('sk-secret-123')
  })

  it('runs only once even when before-quit is triggered twice', async () => {
    const h = recorder()
    h.lifecycle.handleBeforeQuit()
    h.lifecycle.handleBeforeQuit()
    await Promise.resolve()
    await Promise.resolve()
    await Promise.resolve()
    expect(h.exits).toEqual([0])
  })

  it('times out hanging quit hooks and still exits', async () => {
    const h = recorder({ hookTimeoutMs: 20, forceExitTimeoutMs: 500 })
    h.lifecycle.registerQuitHook(() => new Promise<void>(() => undefined))

    const started = Date.now()
    await h.lifecycle.quit('hooks-hang')
    const elapsed = Date.now() - started

    expect(elapsed).toBeLessThan(400)
    expect(h.steps).toEqual(['checkpoint', 'tray', 'hotkeys', 'services', 'windows'])
    expect(h.exits).toEqual([0])
    expect(h.logs.some((line) => line.includes('budget'))).toBe(true)
  })

  it('force-exits when total cleanup exceeds the 3s-style budget', async () => {
    const h = recorder({ hookTimeoutMs: 400, forceExitTimeoutMs: 30 })
    h.lifecycle.registerQuitHook(() => new Promise<void>(() => undefined))

    void h.lifecycle.quit('force')
    await new Promise((resolve) => setTimeout(resolve, 120))

    expect(h.exits).toEqual([0])
    expect(h.logs.some((line) => line.includes('forcing exit'))).toBe(true)
  })
})

describe('Lifecycle crash diagnostics', () => {
  it('logs render-process-gone without leaking secrets', () => {
    const h = recorder()
    const contents = new FakeContents()
    h.lifecycle.attachWebContents(contents)
    h.lifecycle.attachWebContents(contents)

    contents.crash('crashed sk-abcdef123456', 139)

    const log = h.logs.join('\n')
    expect(log).toContain('render-process-gone')
    expect(log).toContain('exitCode=139')
    expect(log).not.toContain('sk-abcdef123456')
    expect(log).toContain('[REDACTED]')
  })

  it('reloads the renderer once after a crash without touching the main lifecycle', async () => {
    let reloads = 0
    const h = recorder({ reloadRenderer: () => { reloads += 1 }, rendererReloadDelayMs: 20 })
    const contents = new FakeContents()
    h.lifecycle.attachWebContents(contents)

    contents.crash('crashed')
    contents.crash('crashed')
    expect(reloads).toBe(0)
    expect(h.lifecycle.isQuitting()).toBe(false)

    await new Promise((resolve) => setTimeout(resolve, 60))
    expect(reloads).toBe(1)
    expect(h.logs.some((line) => line.includes('renderer reloaded'))).toBe(true)
    expect(h.exits).toEqual([])
  })

  it('does not schedule a renderer reload while quitting or after clean-exit', async () => {
    let reloads = 0
    const h = recorder({ reloadRenderer: () => { reloads += 1 }, rendererReloadDelayMs: 10 })
    const contents = new FakeContents()
    h.lifecycle.attachWebContents(contents)

    contents.crash('clean-exit')
    void h.lifecycle.quit('test')
    contents.crash('crashed')
    await new Promise((resolve) => setTimeout(resolve, 30))

    expect(reloads).toBe(0)
    expect(h.exits).toEqual([0])
  })
})
