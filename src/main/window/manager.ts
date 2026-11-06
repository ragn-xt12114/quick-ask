import { app, BrowserWindow, screen } from 'electron'
import type { Display } from 'electron'
import {
  IPC,
  type BlurStatus,
  type MainWindowMode,
  type UiAppearanceEvent,
  type UiStateEvent,
  type WindowDisplayInfo,
  type WindowMode,
  type WindowOpenSettingsRequest,
  type WindowSetBarWidthResult,
  type WindowSetHeightRequest,
  type WindowSetHeightResult,
  type WindowSetModeResult,
  type WindowSettingsResult,
  type WindowState
} from '../../shared/channels'
import {
  GAP,
  GUTTER,
  PANEL_EMPTY_H,
  anchorFromWindowBounds,
  barHeight,
  buildBlurRects,
  buildBoundingShapeRects,
  buildShapeRects,
  computeLayout,
  normalizeBarLines,
  resolveSettledAnchor,
  type LayoutMode,
  type Rect,
  type WindowLayout
} from '../../shared/geometry'
import {
  DEFAULT_APPEARANCE,
  normalizeAppearance,
  normalizeBarWidth,
  type AppearanceSettings
} from '../../shared/settings'
import {
  displayKey,
  migrateWindowPosition,
  normalizeWindowPositions,
  restoreAnchorForDisplay,
  sameAnchor
} from '../../shared/window-position'
import type { BarAnchor } from '../../shared/geometry'
import type { CompositorSnapshot } from '../../shared/appearance-runtime'
import { getLogger } from '../logging'
import { getPlatform } from '../platform'
import type { PlatformAdapter } from '../platform/types'

export interface WindowManagerOptions {
  preloadPath: string
  rendererIndexPath: string
  rendererFileUrl: string
  devServerUrl: string | null
  /** Persisted appearance applied before the first layout. */
  initialAppearance?: AppearanceSettings
  initialBarWidth?: number
  initialBlurStatus?: BlurStatus
  initialAnimationDurationFactor?: number
  /** Injected for tests; defaults to the process-wide platform adapter. */
  platform?: PlatformAdapter
  positionMemory?: {
    get(): Record<string, BarAnchor>
    set(positions: Record<string, BarAnchor>): void
  }
}

const DEFAULT_BLUR_STATUS: BlurStatus = Object.freeze({
  available: false,
  reason: null,
  compositor: null,
  effectEnabled: null
})

const REASSERT_DELAY_MS = 50
const REASSERT_LATE_MS = 600
const BOUNDS_SETTLE_MS = 250

function showTracer(): ((stage: string) => void) | null {
  if (process.env['QUICKASK_LOG_LEVEL'] !== 'debug') return null
  const started = Date.now()
  return (stage: string): void => {
    getLogger().debug('show_timing', { stage, delta_ms: Date.now() - started })
  }
}

function sameBounds(a: Rect, b: Rect): boolean {
  return a.x === b.x && a.y === b.y && a.width === b.width && a.height === b.height
}

export class WindowManager {
  private window: BrowserWindow | null = null
  private settingsWindow: BrowserWindow | null = null
  private mode: MainWindowMode = 'S0'
  private visible = false
  private barAnchor = { x: 0, y: 0 }
  private barWidth: number
  private appearance: AppearanceSettings
  private blurStatus: BlurStatus
  private opaqueMode: boolean
  private animationDurationFactor: number
  private barLines = 1
  private panelHeight = PANEL_EMPTY_H
  private currentDisplayId: number | null = null
  private currentDisplayKey: string | null = null
  private positions: Record<string, BarAnchor>
  private layout: WindowLayout | null = null
  private reassertTimers: NodeJS.Timeout[] = []
  private settleTimer: NodeJS.Timeout | null = null
  private suppressTracking = 0
  private lastAppliedBounds: Rect | null = null
  private listenersAttached = false
  private pointerDisposer: (() => void) | null = null
  private readonly platform: PlatformAdapter
  private readonly stateListeners = new Set<(state: WindowState) => void>()
  private readonly onDisplayChange = (): void => {
    this.handleDisplayChange()
  }
  private readonly onBoundsSettled = (): void => {
    this.scheduleSettle()
  }

  constructor(private readonly options: WindowManagerOptions) {
    this.platform = options.platform ?? getPlatform()
    this.appearance = normalizeAppearance({
      ...DEFAULT_APPEARANCE,
      ...(options.initialAppearance ?? {}),
      ...(options.initialBarWidth === undefined ? {} : { barWidth: options.initialBarWidth })
    })
    this.barWidth = normalizeBarWidth(this.appearance.barWidth)
    this.appearance = { ...this.appearance, barWidth: this.barWidth }
    this.blurStatus = options.initialBlurStatus ?? DEFAULT_BLUR_STATUS
    this.opaqueMode = this.blurStatus.compositor === false
    this.animationDurationFactor = options.initialAnimationDurationFactor ?? 1
    this.positions = normalizeWindowPositions(options.positionMemory?.get() ?? {})
  }

  create(): BrowserWindow {
    if (this.window && !this.window.isDestroyed()) return this.window

    const display = this.displayForCursor()
    this.currentDisplayId = display.id
    this.currentDisplayKey = this.positionKeyFor(display)
    this.barAnchor = restoreAnchorForDisplay(
      this.positions,
      this.currentDisplayKey,
      display.workArea,
      this.barWidth,
      barHeight(this.barLines)
    )
    const initial = computeLayout({
      mode: 'S1',
      barAnchor: this.barAnchor,
      barWidth: this.barWidth,
      barLines: this.barLines,
      panelH: this.panelHeight,
      workArea: display.workArea,
      scaleFactor: display.scaleFactor,
      opaque: this.opaqueMode
    })

    const window = new BrowserWindow({
      width: initial.windowBounds.width,
      height: initial.windowBounds.height,
      useContentSize: true,
      frame: false,
      transparent: true,
      backgroundColor: '#00000000',
      hasShadow: false,
      resizable: false,
      show: false,
      alwaysOnTop: true,
      skipTaskbar: this.platform.window.prefersSkipTaskbar,
      title: 'QuickAsk',
      webPreferences: {
        preload: this.options.preloadPath,
        contextIsolation: true,
        sandbox: true,
        nodeIntegration: false,
        webSecurity: true,
        webviewTag: false,
        devTools: !app.isPackaged,
        spellcheck: false,
        backgroundThrottling: false
      }
    })

    window.setMenuBarVisibility(false)
    window.setAlwaysOnTop(true)
    window.on('closed', () => {
      this.pointerDisposer?.()
      this.pointerDisposer = null
      if (this.window === window) {
        this.window = null
        this.visible = false
        this.mode = 'S0'
      }
    })
    window.on('move', this.onBoundsSettled)
    window.on('resize', this.onBoundsSettled)

    void this.platform.window.setWmClass(window)

    if (this.options.devServerUrl) {
      void window.loadURL(this.options.devServerUrl)
    } else {
      void window.loadFile(this.options.rendererIndexPath)
    }

    if (!this.listenersAttached) {
      this.listenersAttached = true
      screen.on('display-added', this.onDisplayChange)
      screen.on('display-removed', this.onDisplayChange)
      screen.on('display-metrics-changed', this.onDisplayChange)
    }

    this.window = window
    this.pointerDisposer?.()
    this.pointerDisposer = this.platform.window.startPointerPassthrough(
      window,
      () => this.layout
    )
    return window
  }

  getMainWindow(): BrowserWindow | null {
    return this.window
  }

  getSettingsWindow(): BrowserWindow | null {
    return this.settingsWindow
  }

  onStateChange(listener: (state: WindowState) => void): () => void {
    this.stateListeners.add(listener)
    return () => {
      this.stateListeners.delete(listener)
    }
  }

  getAppearance(): AppearanceSettings {
    return { ...this.appearance }
  }

  getAppearanceEvent(): UiAppearanceEvent {
    return {
      ...this.appearance,
      blurStatus: { ...this.blurStatus },
      opaqueMode: this.opaqueMode,
      animationDurationFactor: this.animationDurationFactor
    }
  }

  getBlurStatus(): BlurStatus {
    return { ...this.blurStatus }
  }

  getOpaqueMode(): boolean {
    return this.opaqueMode
  }

  getAnimationDurationFactor(): number {
    return this.animationDurationFactor
  }

  /**
   * Persisted appearance changes are applied immediately. The event carries
   * the live blur/opaque/motion runtime so both renderers stay in sync.
   */
  async setAppearance(appearance: AppearanceSettings): Promise<void> {
    const next = normalizeAppearance(appearance)
    this.appearance = { ...next }
    this.barWidth = normalizeBarWidth(next.barWidth)
    await this.applyLayoutIfVisible()
    this.emitAppearance()
  }

  async setCompositorState(state: CompositorSnapshot): Promise<void> {
    const previousOpaque = this.opaqueMode
    this.blurStatus = { ...state.blurStatus }
    this.animationDurationFactor = state.animationDurationFactor
    if (state.opaqueMode !== previousOpaque) {
      await this.setOpaqueMode(state.opaqueMode)
      return
    }
    this.emitAppearance()
    if (this.visible && this.layout) {
      await this.applyBlurDecision(this.layout)
      this.scheduleReassert()
    }
  }

  /**
   * Compositor-off fallback: remove the gutter, make the window equal to the
   * visual bounding box and clip ShapeBounding to the card union. The bar's
   * screen position is preserved because the layout anchor never changes.
   */
  async setOpaqueMode(opaque: boolean): Promise<void> {
    this.opaqueMode = opaque
    if (!this.visible || this.mode === 'S0') {
      this.layout = null
      this.emitAppearance()
      return
    }

    const layout = this.recomputeLayout()
    const window = this.ensureWindow()
    this.applyWindowBounds(window, layout.windowBounds)
    await this.applyX11(layout)
    this.emitState()
    this.emitAppearance()
    this.repaintWindow(window)
    this.scheduleReassert()
  }

  private repaintWindow(window: BrowserWindow): void {
    if (window.isDestroyed()) return
    window.webContents.invalidate()
    for (const delay of [120, 400, 900]) {
      setTimeout(() => {
        if (!window.isDestroyed()) window.webContents.invalidate()
      }, delay)
    }
  }

  notifySystemThemeChanged(): void {
    this.emitAppearance()
  }

  async show(): Promise<WindowState> {
    const trace = showTracer()
    trace?.('enter')
    const window = this.ensureWindow()
    const needsRemap = this.mode === 'S0' || !this.visible
    trace?.('ensure')

    if (needsRemap) {
      const display = this.displayForCursor()
      this.currentDisplayId = display.id
      this.currentDisplayKey = this.positionKeyFor(display)
      this.barAnchor = restoreAnchorForDisplay(
        this.positions,
        this.currentDisplayKey,
        display.workArea,
        this.barWidth,
        barHeight(this.barLines)
      )
      this.mode = 'S1'
    }

    this.resolveStoredAnchor()
    trace?.('resolve_anchor')
    const layout = this.recomputeLayout()
    trace?.('recompute_layout')
    this.applyWindowBounds(window, layout.windowBounds)
    trace?.('set_bounds')
    if (needsRemap) window.setOpacity(0)
    window.show()
    trace?.('show')
    window.setAlwaysOnTop(true)

    if (needsRemap) {
      // `remap-states` unmaps, rewrites the skip atoms while unmapped, maps and
      // re-asserts them, so KWin reads the correct state during the manage pass
      // triggered by this map. No fixed settle delay is required. Passing the
      // input shape here keeps both X operations in one helper process.
      const remapped = await this.platform.window.remapStates(
        window,
        buildShapeRects(layout)
      )
      trace?.('remap_states')
      if (!remapped.ok) {
        await this.applyCriticalX11(layout)
        trace?.('apply_critical_x11')
      }
    } else {
      await this.applyCriticalX11(layout)
      trace?.('apply_critical_x11')
    }
    if (needsRemap) window.setOpacity(1)
    trace?.('opacity')
    window.focus()
    trace?.('focus')
    window.webContents.focus()
    trace?.('web_focus')
    this.visible = true
    this.emitState()
    trace?.('emit_state')
    this.scheduleReassert()
    void this.applyDecorativeX11(layout)
    trace?.('decorative_scheduled')
    return this.getState()
  }

  hide(): WindowState {
    this.mode = 'S0'
    this.visible = false
    this.clearReassert()
    this.window?.hide()
    this.emitState()
    return this.getState()
  }

  async setMode(mode: WindowMode): Promise<WindowSetModeResult> {
    if (mode === 'S4') {
      await this.openSettings()
      return { mode }
    }
    if (mode === 'S0') {
      this.hide()
      return { mode }
    }

    if (!this.visible) await this.show()
    this.mode = mode

    const layout = this.recomputeLayout()
    const window = this.ensureWindow()
    this.applyWindowBounds(window, layout.windowBounds)
    await this.applyX11(layout)
    this.emitState()
    this.scheduleReassert()
    return { mode }
  }

  async setBarLines(lines: number): Promise<WindowSetHeightResult> {
    return this.setHeight({ barLines: lines })
  }

  async setPanelHeight(panelHeight: number): Promise<WindowSetHeightResult> {
    return this.setHeight({ panelHeight })
  }

  /**
   * F-07 bar width (560–900, step 20). The bar's absolute anchor is preserved;
   * the shared layout clamps it if the wider bar would leave the work area.
   */
  async setBarWidth(width: number): Promise<WindowSetBarWidthResult> {
    const next = normalizeBarWidth(width)
    if (next !== this.barWidth) {
      await this.setAppearance({ ...this.appearance, barWidth: next })
    }
    return { width: this.barWidth }
  }

  async setHeight(request: WindowSetHeightRequest): Promise<WindowSetHeightResult> {
    if (request.barLines !== undefined) {
      this.barLines = normalizeBarLines(request.barLines)
    }
    if (request.panelHeight !== undefined) {
      this.panelHeight = Math.max(0, Math.round(request.panelHeight))
    } else if (request.height !== undefined) {
      const gutter = this.opaqueMode ? 0 : GUTTER.top + GUTTER.bottom
      const chrome = gutter + barHeight(this.barLines) + GAP
      this.panelHeight = Math.max(0, Math.round(request.height - chrome))
    }

    if (this.visible && this.mode !== 'S0') {
    const layout = this.recomputeLayout()
    const window = this.ensureWindow()
    this.applyWindowBounds(window, layout.windowBounds)
    await this.applyX11(layout)
      this.emitState()
      this.scheduleReassert()
    }

    const bounds = this.window?.getBounds()
    return {
      height: bounds?.height ?? 0,
      barLines: this.barLines,
      panelHeight: this.panelHeight
    }
  }

  getState(): WindowState {
    const display = this.currentDisplay()
    const bounds = this.window?.getBounds() ?? { x: 0, y: 0, width: 1, height: 1 }
    const displayInfo: WindowDisplayInfo = {
      id: display.id,
      workArea: {
        x: display.workArea.x,
        y: display.workArea.y,
        width: display.workArea.width,
        height: display.workArea.height
      },
      scaleFactor: display.scaleFactor
    }

    return {
      mode: this.mode,
      visible: this.visible,
      bounds: {
        x: bounds.x,
        y: bounds.y,
        width: Math.max(1, bounds.width),
        height: Math.max(1, bounds.height)
      },
      display: displayInfo,
      layout: this.layout
    }
  }

  async openSettings(
    options: WindowOpenSettingsRequest = {}
  ): Promise<WindowSettingsResult> {
    if (this.settingsWindow && !this.settingsWindow.isDestroyed()) {
      if (options.onboarding && !this.settingsWindow.webContents.getURL().includes('onboarding=1')) {
        void this.settingsWindow.loadURL(this.settingsUrl(options))
      }
      this.settingsWindow.show()
      this.settingsWindow.focus()
      return { open: true }
    }

    const main = this.window
    const parentVisible = Boolean(main && !main.isDestroyed() && main.isVisible())
    const settings = new BrowserWindow({
      width: 720,
      height: 560,
      minWidth: 640,
      minHeight: 480,
      useContentSize: true,
      frame: true,
      show: false,
      resizable: true,
      skipTaskbar: true,
      title: 'QuickAsk 设置',
      ...(parentVisible && main ? { parent: main, modal: true } : {}),
      webPreferences: {
        preload: this.options.preloadPath,
        contextIsolation: true,
        sandbox: true,
        nodeIntegration: false,
        webSecurity: true,
        webviewTag: false,
        devTools: !app.isPackaged,
        spellcheck: false,
        backgroundThrottling: false
      }
    })

    this.settingsWindow = settings
    settings.setMenuBarVisibility(false)
    settings.center()

    settings.on('closed', () => {
      if (this.settingsWindow === settings) this.settingsWindow = null
    })

    settings.on('page-title-updated', (event) => {
      event.preventDefault()
      settings.setTitle('QuickAsk 设置')
    })

    let settingsWid: number | null = null
    let settingsX11Applied = false

    const reassertSettingsStates = (): void => {
      if (settingsWid !== null && !settings.isDestroyed()) {
        void this.platform.window.setStates(settings)
      }
    }

    const applySettingsX11 = (): void => {
      if (settings.isDestroyed()) return
      if (settingsWid === null) {
        settingsWid = this.platform.window.getNativeWindowId(settings)
      }
      if (settingsWid === null) return
      if (settingsX11Applied) {
        void this.platform.window.setStates(settings)
        return
      }
      settingsX11Applied = true
      void (async () => {
        await this.platform.window.setWmClass(
          settings,
          'quickask-settings',
          'quickask-settings'
        )
        await this.platform.window.remapStates(settings)
        await this.platform.window.setStates(settings)
        setTimeout(reassertSettingsStates, REASSERT_DELAY_MS)
        setTimeout(reassertSettingsStates, REASSERT_LATE_MS)
      })()
    }

    settings.on('move', () => {
      setTimeout(reassertSettingsStates, BOUNDS_SETTLE_MS)
    })
    settings.on('resize', () => {
      setTimeout(reassertSettingsStates, BOUNDS_SETTLE_MS)
    })

    settings.once('ready-to-show', () => {
      settings.show()
      settings.focus()
      setTimeout(applySettingsX11, 50)
    })
    settings.webContents.once('did-finish-load', () => {
      setTimeout(applySettingsX11, 50)
    })

    void settings.loadURL(this.settingsUrl(options))

    return { open: true }
  }

  closeSettings(): WindowSettingsResult {
    const settings = this.settingsWindow
    if (settings && !settings.isDestroyed()) settings.close()
    return { open: false }
  }

  destroy(): void {
    this.clearReassert()
    this.pointerDisposer?.()
    this.pointerDisposer = null
    if (this.listenersAttached) {
      this.listenersAttached = false
      screen.removeListener('display-added', this.onDisplayChange)
      screen.removeListener('display-removed', this.onDisplayChange)
      screen.removeListener('display-metrics-changed', this.onDisplayChange)
    }
    if (this.settingsWindow && !this.settingsWindow.isDestroyed()) {
      this.settingsWindow.destroy()
    }
    this.settingsWindow = null
    if (this.window && !this.window.isDestroyed()) this.window.destroy()
    this.window = null
  }

  private settingsUrl(options: WindowOpenSettingsRequest): string {
    const base = this.options.devServerUrl ?? this.options.rendererFileUrl
    const url = new URL(base)
    url.searchParams.set('settings', '1')
    if (options.onboarding) url.searchParams.set('onboarding', '1')
    return url.href
  }

  private ensureWindow(): BrowserWindow {
    if (!this.window || this.window.isDestroyed()) return this.create()
    return this.window
  }

  private recomputeLayout(): WindowLayout {
    const display = this.currentDisplay()
    this.currentDisplayId = display.id
    this.currentDisplayKey = this.positionKeyFor(display)
    const mode: LayoutMode = this.mode === 'S0' ? 'S1' : this.mode
    const layout = computeLayout({
      mode,
      barAnchor: this.barAnchor,
      barWidth: this.barWidth,
      barLines: this.barLines,
      panelH: this.panelHeight,
      workArea: display.workArea,
      scaleFactor: display.scaleFactor,
      opaque: this.opaqueMode
    })
    this.barAnchor = layout.anchor
    this.layout = layout
    return layout
  }

  /**
   * Keep a persisted anchor valid when the display layout changed underneath
   * the window (removed output, smaller work area, scale change).
   */
  private resolveStoredAnchor(): void {
    const display = this.currentDisplay()
    const resolved = resolveSettledAnchor({
      anchor: this.barAnchor,
      workArea: display.workArea,
      barWidth: this.barWidth,
      barHeight: barHeight(this.barLines),
      mode: this.mode === 'S0' ? 'S1' : this.mode,
      panelHeight: this.panelHeight
    })
    this.currentDisplayId = display.id
    this.currentDisplayKey = this.positionKeyFor(display)
    this.barAnchor = resolved.anchor
    this.panelHeight = resolved.panelHeight
  }

  private applyWindowBounds(window: BrowserWindow, bounds: Rect): void {
    this.lastAppliedBounds = { ...bounds }
    this.suppressTracking += 1
    try {
      window.setBounds(bounds)
    } finally {
      setTimeout(() => {
        this.suppressTracking = Math.max(0, this.suppressTracking - 1)
      }, 0)
    }
  }

  private handleBoundsSettled(): void {
    const window = this.window
    if (!window || window.isDestroyed()) return
    if (this.suppressTracking > 0) return
    if (!this.visible || this.mode === 'S0' || !this.layout) return

    const bounds = window.getBounds()
    if (this.lastAppliedBounds && sameBounds(bounds, this.lastAppliedBounds)) {
      void this.reassertX11()
      return
    }

    const previous = this.layout
    const anchor = anchorFromWindowBounds(bounds, previous)
    const barH = barHeight(this.barLines)
    const center = {
      x: anchor.x + Math.round(this.barWidth / 2),
      y: anchor.y + Math.round(barH / 2)
    }
    const display = screen.getDisplayNearestPoint(center)
    const previousDisplayId = this.currentDisplayId
    const previousPanelHeight = this.panelHeight

    const resolved = resolveSettledAnchor({
      anchor,
      workArea: display.workArea,
      barWidth: this.barWidth,
      barHeight: barH,
      mode: previous.mode,
      panelHeight: this.panelHeight
    })

    this.currentDisplayId = display.id
    this.currentDisplayKey = this.positionKeyFor(display)
    this.barAnchor = resolved.anchor
    this.panelHeight = resolved.panelHeight
    this.persistPosition(this.currentDisplayKey, resolved.anchor)

    const displayChanged = previousDisplayId !== display.id
    const scaleChanged = previous.scaleFactor !== display.scaleFactor
    const panelChanged = previousPanelHeight !== this.panelHeight
    const correction = resolved.anchor.x !== anchor.x || resolved.anchor.y !== anchor.y

    const layout = this.recomputeLayout()
    let corrected = false
    if (correction || !sameBounds(window.getBounds(), layout.windowBounds)) {
      this.applyWindowBounds(window, layout.windowBounds)
      corrected = true
    }
    if (displayChanged || scaleChanged || panelChanged || correction) {
      void this.applyX11(layout)
    } else {
      void this.reassertX11()
    }
    if (!corrected) this.lastAppliedBounds = { ...window.getBounds() }
    this.emitState()
    this.scheduleReassert()
  }

  private async applyLayoutIfVisible(): Promise<void> {
    if (!this.visible || this.mode === 'S0') {
      this.layout = null
      return
    }
    const layout = this.recomputeLayout()
    const window = this.ensureWindow()
    this.applyWindowBounds(window, layout.windowBounds)
    await this.applyX11(layout)
    this.emitState()
    this.scheduleReassert()
  }

  private async applyBlurDecision(layout: WindowLayout): Promise<void> {
    const window = this.window
    if (!window || window.isDestroyed()) return

    const shouldBlur =
      !this.opaqueMode && this.appearance.blurEnabled && this.blurStatus.available
    if (shouldBlur) {
      await this.platform.window.setBlur(window, buildBlurRects(layout))
    } else {
      await this.platform.window.clearBlur(window)
    }
  }

  private async applyCriticalX11(layout: WindowLayout): Promise<void> {
    const window = this.window
    if (!window || window.isDestroyed()) return
    const trace = showTracer()
    await this.platform.window.setStates(window)
    trace?.('x11_states')
    await this.platform.window.setInputShape(window, buildShapeRects(layout))
    trace?.('x11_input_shape')
  }

  private async applyDecorativeX11(layout: WindowLayout): Promise<void> {
    const window = this.window
    if (!window || window.isDestroyed()) return
    const trace = showTracer()
    if (this.opaqueMode) {
      await this.platform.window.setBoundingShape(
        window,
        buildBoundingShapeRects(layout)
      )
    } else {
      await this.platform.window.clearBoundingShape(window)
    }
    trace?.('x11_bounding')
    await this.applyBlurDecision(layout)
    trace?.('x11_blur')
  }

  private async applyX11(layout: WindowLayout): Promise<void> {
    await this.applyCriticalX11(layout)
    await this.applyDecorativeX11(layout)
  }

  private async reassertX11(): Promise<void> {
    if (!this.visible || this.mode === 'S0' || !this.layout) return
    await this.applyX11(this.layout)
  }

  private scheduleReassert(): void {
    this.clearReassertTimers()
    for (const delay of [REASSERT_DELAY_MS, REASSERT_LATE_MS]) {
      const timer = setTimeout(() => {
        this.reassertTimers = this.reassertTimers.filter((entry) => entry !== timer)
        void this.reassertX11()
      }, delay)
      this.reassertTimers.push(timer)
    }
  }

  private scheduleSettle(): void {
    if (this.settleTimer) clearTimeout(this.settleTimer)
    this.settleTimer = setTimeout(() => {
      this.settleTimer = null
      this.handleBoundsSettled()
    }, BOUNDS_SETTLE_MS)
  }

  private clearReassertTimers(): void {
    for (const timer of this.reassertTimers) clearTimeout(timer)
    this.reassertTimers = []
  }

  private clearReassert(): void {
    this.clearReassertTimers()
    if (this.settleTimer) {
      clearTimeout(this.settleTimer)
      this.settleTimer = null
    }
  }

  private emitAppearance(): void {
    const event = this.getAppearanceEvent()
    for (const window of [this.window, this.settingsWindow]) {
      if (!window || window.isDestroyed()) continue
      try {
        window.webContents.send(IPC.EVENT_UI_APPEARANCE, event)
      } catch {
        // A closing window must not break the appearance state machine.
      }
    }
  }

  private emitState(): void {
    const window = this.window
    if (window && !window.isDestroyed()) {
      const display = this.currentDisplay()
      const event: UiStateEvent = {
        mode: this.mode,
        visible: this.visible,
        layout: this.layout,
        barLines: this.barLines,
        panelHeight: this.panelHeight,
        scaleFactor: this.layout?.scaleFactor ?? display.scaleFactor
      }
      window.webContents.send(IPC.EVENT_UI_STATE, event)
    }

    if (this.stateListeners.size > 0) {
      const state = this.getState()
      for (const listener of this.stateListeners) {
        try {
          listener(state)
        } catch {
          // A tray/menu listener must never break window state changes.
        }
      }
    }
  }

  private positionKeyFor(display: Display): string {
    return displayKey({
      id: display.id,
      label: display.label,
      width: display.bounds.width,
      height: display.bounds.height,
      scaleFactor: display.scaleFactor
    })
  }

  private persistPosition(key: string, anchor: BarAnchor): void {
    if (sameAnchor(this.positions[key], anchor)) return
    this.replacePositions({ ...this.positions, [key]: anchor })
  }

  private replacePositions(positions: Record<string, BarAnchor>): void {
    this.positions = normalizeWindowPositions(positions)
    this.options.positionMemory?.set(this.positions)
  }

  private displayForCursor(): Display {
    return screen.getDisplayNearestPoint(screen.getCursorScreenPoint())
  }

  private currentDisplay(): Display {
    if (this.currentDisplayId !== null) {
      const found = screen
        .getAllDisplays()
        .find((display) => display.id === this.currentDisplayId)
      if (found) return found
    }
    return this.displayForCursor()
  }

  private handleDisplayChange(): void {
    const window = this.window
    if (!window || window.isDestroyed()) return

    const bounds = window.getBounds()
    const anchor = this.layout ? anchorFromWindowBounds(bounds, this.layout) : this.barAnchor
    const barH = barHeight(this.barLines)
    const display = screen.getDisplayNearestPoint({
      x: anchor.x + Math.round(this.barWidth / 2),
      y: anchor.y + Math.round(barH / 2)
    })
    const previousKey = this.currentDisplayKey
    const nextKey = this.positionKeyFor(display)
    const activeKeys = new Set(screen.getAllDisplays().map((entry) => this.positionKeyFor(entry)))
    if (previousKey && previousKey !== nextKey && !activeKeys.has(previousKey)) {
      this.replacePositions(migrateWindowPosition(this.positions, previousKey, nextKey))
    }
    this.currentDisplayId = display.id
    this.currentDisplayKey = nextKey

    const resolved = resolveSettledAnchor({
      anchor,
      workArea: display.workArea,
      barWidth: this.barWidth,
      barHeight: barH,
      mode: this.mode === 'S0' ? 'S1' : this.mode,
      panelHeight: this.panelHeight
    })
    this.barAnchor = resolved.anchor
    this.panelHeight = resolved.panelHeight
    this.persistPosition(nextKey, resolved.anchor)

    if (!this.visible || this.mode === 'S0') {
      this.layout = null
      return
    }

    const layout = this.recomputeLayout()
    this.applyWindowBounds(window, layout.windowBounds)
    void this.applyX11(layout)
    this.emitState()
    this.scheduleReassert()
  }
}
