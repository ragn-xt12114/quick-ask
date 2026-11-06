export type AutoHideReason = 'blur' | 'streaming' | 'focus'

export interface AutoHideOptions {
  isStreaming(): boolean
  isSettingsOpen(): boolean
  isCursorInside(): boolean
  isFocused?(): boolean
  hide(reason: AutoHideReason): void
  logger?(event: string, fields?: Record<string, unknown>): void
  streamingDelayMs?: number
  hideOnBlur?: boolean
  dragSettleMs?: number
  now?(): number
}

const DEFAULT_STREAMING_DELAY_MS = 3000
const DEFAULT_DRAG_SETTLE_MS = 500
const DEFAULT_SUPPRESS_MS = 1500

interface PendingHide {
  delayMs: number
  reason: AutoHideReason
}

function normalizeDelay(value: number | undefined, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : fallback
}

export class AutoHideController {
  private streamingDelayMs: number
  private hideOnBlurEnabled: boolean
  private readonly dragSettleMs: number
  private hideTimer: ReturnType<typeof setTimeout> | null = null
  private dragTimer: ReturnType<typeof setTimeout> | null = null
  private suppressTimer: ReturnType<typeof setTimeout> | null = null
  private pending: PendingHide | null = null
  private focused: boolean
  private dragging = false
  private suppressing = false
  private disposed = false

  constructor(private readonly options: AutoHideOptions) {
    this.streamingDelayMs = normalizeDelay(options.streamingDelayMs, DEFAULT_STREAMING_DELAY_MS)
    this.hideOnBlurEnabled = options.hideOnBlur !== false
    this.dragSettleMs = normalizeDelay(options.dragSettleMs, DEFAULT_DRAG_SETTLE_MS)
    this.focused = options.isFocused ? options.isFocused() : true
  }

  setHideOnBlur(enabled: boolean): void {
    if (this.hideOnBlurEnabled === enabled) return
    this.hideOnBlurEnabled = enabled
    if (!enabled) {
      this.clearHide()
      return
    }
    if (
      this.disposed ||
      this.isFocusedNow() ||
      this.options.isSettingsOpen() ||
      this.dragging ||
      this.suppressing
    ) {
      return
    }
    this.scheduleHide()
  }

  setStreamingDelayMs(delayMs: number): void {
    const next = normalizeDelay(delayMs, DEFAULT_STREAMING_DELAY_MS)
    if (next === this.streamingDelayMs) return
    this.streamingDelayMs = next
    if (this.pending === null) return
    this.clearHide()
    if (
      this.disposed ||
      !this.hideOnBlurEnabled ||
      this.isFocusedNow() ||
      this.options.isSettingsOpen() ||
      this.dragging ||
      this.suppressing
    ) {
      return
    }
    this.scheduleHide()
  }

  getStreamingDelayMs(): number {
    return this.streamingDelayMs
  }

  isHideOnBlurEnabled(): boolean {
    return this.hideOnBlurEnabled
  }

  onFocus(): void {
    if (this.disposed) return
    this.focused = true
    this.clearHide()
  }

  onBlur(): void {
    if (this.disposed) return
    this.focused = false
    if (!this.hideOnBlurEnabled) return
    if (this.options.isSettingsOpen() || this.dragging) return
    if (this.suppressing) return
    this.scheduleHide()
  }

  onMove(): void {
    if (this.disposed) return
    this.dragging = true
    this.clearHide()
    this.clearDragTimer()
    this.dragTimer = setTimeout(() => {
      this.dragTimer = null
      if (this.disposed) return
      this.dragging = false
      if (this.isFocusedNow() || this.options.isSettingsOpen() || this.suppressing) return
      this.scheduleHide()
    }, this.dragSettleMs)
  }

  suppress(ms: number = DEFAULT_SUPPRESS_MS): void {
    if (this.disposed) return
    const delayMs = normalizeDelay(ms, DEFAULT_SUPPRESS_MS)
    this.suppressing = true
    this.clearHide()
    this.clearSuppressTimer()
    this.suppressTimer = setTimeout(() => {
      this.suppressTimer = null
      if (this.disposed) return
      this.suppressing = false
      if (this.isFocusedNow() || this.options.isSettingsOpen() || this.dragging) return
      this.scheduleHide()
    }, delayMs)
  }

  cancel(): void {
    if (this.disposed) return
    this.clearHide()
    this.clearDragTimer()
    this.clearSuppressTimer()
    this.dragging = false
    this.suppressing = false
  }

  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    this.clearHide()
    this.clearDragTimer()
    this.clearSuppressTimer()
  }

  private isFocusedNow(): boolean {
    return this.options.isFocused ? this.options.isFocused() : this.focused
  }

  private scheduleHide(): void {
    if (!this.hideOnBlurEnabled) return
    this.clearHide()
    const reason: AutoHideReason = this.options.isStreaming() ? 'streaming' : 'blur'
    const delayMs = reason === 'streaming' ? this.streamingDelayMs : 0
    this.pending = { delayMs, reason }
    this.options.logger?.('auto_hide_scheduled', { delayMs, reason })
    this.hideTimer = setTimeout(() => {
      this.fire()
    }, delayMs)
  }

  private fire(): void {
    this.hideTimer = null
    const pending = this.pending
    this.pending = null
    if (this.disposed || pending === null) return
    if (!this.hideOnBlurEnabled) return

    if (
      this.isFocusedNow() ||
      this.options.isSettingsOpen() ||
      this.dragging ||
      this.options.isCursorInside()
    ) {
      this.options.logger?.('auto_hide_cancelled', {
        delayMs: pending.delayMs,
        reason: pending.reason
      })
      return
    }

    const reason: AutoHideReason = this.options.isStreaming() ? 'streaming' : 'blur'
    this.options.logger?.('auto_hide_fired', { delayMs: pending.delayMs, reason })
    this.options.hide(reason)
  }

  private clearHide(): void {
    if (this.hideTimer === null) return
    clearTimeout(this.hideTimer)
    this.hideTimer = null
    const pending = this.pending
    this.pending = null
    if (pending !== null) {
      this.options.logger?.('auto_hide_cancelled', {
        delayMs: pending.delayMs,
        reason: pending.reason
      })
    }
  }

  private clearDragTimer(): void {
    if (this.dragTimer === null) return
    clearTimeout(this.dragTimer)
    this.dragTimer = null
  }

  private clearSuppressTimer(): void {
    if (this.suppressTimer === null) return
    clearTimeout(this.suppressTimer)
    this.suppressTimer = null
  }
}
