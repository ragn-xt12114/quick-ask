import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  AutoHideController,
  type AutoHideReason
} from '../../src/main/window/focus'

interface HarnessOverrides {
  streamingDelayMs?: number
  hideOnBlur?: boolean
  dragSettleMs?: number
  isFocused?: () => boolean
}

const controllers: AutoHideController[] = []

function createHarness(overrides: HarnessOverrides = {}) {
  const state = { streaming: false, settingsOpen: false, cursorInside: false }
  const hide = vi.fn<(reason: AutoHideReason) => void>()
  const logger = vi.fn<(event: string, fields?: Record<string, unknown>) => void>()
  const controller = new AutoHideController({
    isStreaming: () => state.streaming,
    isSettingsOpen: () => state.settingsOpen,
    isCursorInside: () => state.cursorInside,
    hide,
    logger,
    ...overrides
  })
  controllers.push(controller)
  return { controller, state, hide, logger }
}

beforeEach(() => {
  vi.useFakeTimers()
})

afterEach(() => {
  for (const controller of controllers) controller.dispose()
  controllers.length = 0
  vi.clearAllTimers()
  vi.useRealTimers()
})

describe('AutoHideController', () => {
  it('waits streamingDelayMs while streaming', () => {
    const { controller, state, hide } = createHarness()
    state.streaming = true

    controller.onBlur()

    expect(hide).not.toHaveBeenCalled()
    vi.advanceTimersByTime(2999)
    expect(hide).not.toHaveBeenCalled()
    vi.advanceTimersByTime(1)
    expect(hide).toHaveBeenCalledTimes(1)
    expect(hide).toHaveBeenCalledWith('streaming')
    expect(vi.getTimerCount()).toBe(0)
  })

  it('hides asynchronously on the next tick when not streaming', () => {
    const { controller, hide } = createHarness()

    controller.onBlur()

    expect(hide).not.toHaveBeenCalled()
    vi.advanceTimersByTime(0)
    expect(hide).toHaveBeenCalledTimes(1)
    expect(hide).toHaveBeenCalledWith('blur')
    expect(vi.getTimerCount()).toBe(0)
  })

  it('cancels a pending hide on focus', () => {
    const { controller, state, hide } = createHarness()
    state.streaming = true

    controller.onBlur()
    vi.advanceTimersByTime(2999)
    controller.onFocus()
    expect(vi.getTimerCount()).toBe(0)

    vi.advanceTimersByTime(10_000)
    expect(hide).not.toHaveBeenCalled()
  })

  it('respects an externally supplied focus probe at fire time', () => {
    let focused = true
    const { controller, hide } = createHarness({ isFocused: () => focused })

    controller.onBlur()
    vi.advanceTimersByTime(0)
    expect(hide).not.toHaveBeenCalled()

    focused = false
    controller.onBlur()
    vi.advanceTimersByTime(0)
    expect(hide).toHaveBeenCalledWith('blur')
  })

  it('does not schedule while settings are open and does not hide retroactively', () => {
    const { controller, state, hide } = createHarness()
    state.settingsOpen = true

    controller.onBlur()
    vi.advanceTimersByTime(10_000)
    expect(hide).not.toHaveBeenCalled()
    expect(vi.getTimerCount()).toBe(0)

    state.settingsOpen = false
    vi.advanceTimersByTime(10_000)
    expect(hide).not.toHaveBeenCalled()

    controller.onBlur()
    vi.advanceTimersByTime(0)
    expect(hide).toHaveBeenCalledWith('blur')
  })

  it('does not hide while dragging and reschedules after the drag settles', () => {
    const { controller, state, hide } = createHarness()
    state.streaming = true

    controller.onMove()
    controller.onBlur()
    vi.advanceTimersByTime(499)
    expect(hide).not.toHaveBeenCalled()
    expect(vi.getTimerCount()).toBe(1)

    vi.advanceTimersByTime(1)
    expect(hide).not.toHaveBeenCalled()
    expect(vi.getTimerCount()).toBe(1)

    vi.advanceTimersByTime(2999)
    expect(hide).not.toHaveBeenCalled()
    vi.advanceTimersByTime(1)
    expect(hide).toHaveBeenCalledWith('streaming')
  })

  it('cancels a pending hide when a move starts and restarts the drag settle timer', () => {
    const { controller, state, hide } = createHarness()
    state.streaming = true

    controller.onBlur()
    vi.advanceTimersByTime(1000)
    controller.onMove()

    vi.advanceTimersByTime(499)
    expect(hide).not.toHaveBeenCalled()
    controller.onMove()
    vi.advanceTimersByTime(499)
    expect(hide).not.toHaveBeenCalled()
    expect(vi.getTimerCount()).toBe(1)

    vi.advanceTimersByTime(1)
    expect(hide).not.toHaveBeenCalled()
    vi.advanceTimersByTime(3000)
    expect(hide).toHaveBeenCalledWith('streaming')
  })

  it('cancels at fire time when the cursor is inside the window', () => {
    const { controller, state, hide, logger } = createHarness()
    state.streaming = true
    state.cursorInside = true

    controller.onBlur()
    vi.advanceTimersByTime(3000)

    expect(hide).not.toHaveBeenCalled()
    expect(vi.getTimerCount()).toBe(0)
    expect(logger).toHaveBeenCalledWith('auto_hide_cancelled', {
      delayMs: 3000,
      reason: 'streaming'
    })

    state.cursorInside = false
    controller.onBlur()
    vi.advanceTimersByTime(3000)
    expect(hide).toHaveBeenCalledWith('streaming')
  })

  it('suppresses hiding for the tray interaction window, then reschedules', () => {
    const { controller, state, hide } = createHarness()
    state.streaming = true

    controller.onBlur()
    vi.advanceTimersByTime(1000)
    controller.suppress()

    vi.advanceTimersByTime(1499)
    expect(hide).not.toHaveBeenCalled()
    vi.advanceTimersByTime(1)
    expect(hide).not.toHaveBeenCalled()

    vi.advanceTimersByTime(2999)
    expect(hide).not.toHaveBeenCalled()
    vi.advanceTimersByTime(1)
    expect(hide).toHaveBeenCalledWith('streaming')
  })

  it('cancel clears every timer without hiding', () => {
    const { controller, state, hide } = createHarness()
    state.streaming = true

    controller.onBlur()
    controller.onMove()
    controller.suppress(1000)
    expect(vi.getTimerCount()).toBe(2)

    controller.cancel()
    expect(vi.getTimerCount()).toBe(0)
    vi.advanceTimersByTime(10_000)
    expect(hide).not.toHaveBeenCalled()
  })

  it('dispose clears everything and makes later calls no-ops', () => {
    const { controller, state, hide } = createHarness()
    state.streaming = true

    controller.onBlur()
    controller.suppress(5000)
    controller.onMove()
    expect(vi.getTimerCount()).toBe(2)

    controller.dispose()
    expect(vi.getTimerCount()).toBe(0)

    vi.advanceTimersByTime(10_000)
    expect(hide).not.toHaveBeenCalled()

    controller.onBlur()
    controller.onMove()
    controller.suppress()
    controller.onFocus()
    controller.cancel()
    controller.dispose()
    expect(vi.getTimerCount()).toBe(0)
    expect(hide).not.toHaveBeenCalled()
  })

  it('logs only reason and delay metadata', () => {
    const { controller, state, logger } = createHarness()
    state.streaming = true

    controller.onBlur()
    vi.advanceTimersByTime(3000)

    expect(logger).toHaveBeenCalledWith('auto_hide_scheduled', {
      delayMs: 3000,
      reason: 'streaming'
    })
    expect(logger).toHaveBeenCalledWith('auto_hide_fired', {
      delayMs: 3000,
      reason: 'streaming'
    })

    for (const [event, fields] of logger.mock.calls) {
      expect(['auto_hide_scheduled', 'auto_hide_cancelled', 'auto_hide_fired']).toContain(event)
      expect(Object.keys(fields ?? {}).sort()).toEqual(['delayMs', 'reason'])
    }
  })

  it('logs cancellation metadata without exposing anything else', () => {
    const { controller, state, logger } = createHarness()
    state.streaming = true

    controller.onBlur()
    vi.advanceTimersByTime(1000)
    controller.onFocus()

    expect(logger).toHaveBeenCalledWith('auto_hide_cancelled', {
      delayMs: 3000,
      reason: 'streaming'
    })
    for (const [, fields] of logger.mock.calls) {
      expect(Object.keys(fields ?? {}).sort()).toEqual(['delayMs', 'reason'])
    }
  })
})

describe('AutoHideController drag without streaming', () => {
  it('reschedules after a drag settles without streaming', () => {
    const { controller, hide } = createHarness()

    controller.onMove()
    controller.onBlur()
    vi.advanceTimersByTime(500)
    expect(hide).not.toHaveBeenCalled()
    vi.advanceTimersByTime(1)

    expect(hide).toHaveBeenCalledWith('blur')
    expect(vi.getTimerCount()).toBe(0)
  })
})

describe('AutoHideController behavior settings', () => {
  it('never hides on blur while hideOnBlur is false, and resumes when enabled', () => {
    const { controller, hide } = createHarness({ hideOnBlur: false })
    expect(controller.isHideOnBlurEnabled()).toBe(false)

    controller.onBlur()
    vi.advanceTimersByTime(10_000)
    expect(hide).not.toHaveBeenCalled()

    controller.setHideOnBlur(true)
    expect(controller.isHideOnBlurEnabled()).toBe(true)
    vi.advanceTimersByTime(0)
    expect(hide).toHaveBeenCalledWith('blur')
  })

  it('cancels a pending hide when hideOnBlur is turned off', () => {
    const { controller, state, hide } = createHarness()
    state.streaming = true

    controller.onBlur()
    vi.advanceTimersByTime(1000)
    controller.setHideOnBlur(false)
    vi.advanceTimersByTime(10_000)
    expect(hide).not.toHaveBeenCalled()
  })

  it('uses the updated streaming delay and reschedules a pending hide', () => {
    const { controller, state, hide } = createHarness()
    state.streaming = true

    controller.setStreamingDelayMs(1200)
    expect(controller.getStreamingDelayMs()).toBe(1200)
    controller.onBlur()
    vi.advanceTimersByTime(1199)
    expect(hide).not.toHaveBeenCalled()
    vi.advanceTimersByTime(1)
    expect(hide).toHaveBeenCalledWith('streaming')

    hide.mockClear()
    controller.onBlur()
    vi.advanceTimersByTime(300)
    controller.setStreamingDelayMs(800)
    vi.advanceTimersByTime(799)
    expect(hide).not.toHaveBeenCalled()
    vi.advanceTimersByTime(1)
    expect(hide).toHaveBeenCalledWith('streaming')
  })

  it('normalizes invalid delays and keeps the 3000ms/true defaults', () => {
    const { controller } = createHarness()
    expect(controller.getStreamingDelayMs()).toBe(3000)
    expect(controller.isHideOnBlurEnabled()).toBe(true)
    controller.setStreamingDelayMs(Number.NaN)
    expect(controller.getStreamingDelayMs()).toBe(3000)
    controller.setStreamingDelayMs(-5)
    expect(controller.getStreamingDelayMs()).toBe(3000)
  })
})
