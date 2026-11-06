/**
 * Pure window geometry for the S1/S2/S3 layout contract (plan B.3/B.4).
 *
 * All card rectangles are DIP relative to the OS window, so the renderer can
 * position them absolutely. The OS window is the visible content expanded by
 * the asymmetric shadow gutter. Shape/blur rectangles are device pixels.
 */

export interface Rect {
  x: number
  y: number
  width: number
  height: number
}

export interface BarAnchor {
  x: number
  y: number
}

export type LayoutMode = 'S1' | 'S2' | 'S3'

export const GUTTER = Object.freeze({ top: 28, left: 40, right: 40, bottom: 52 })

export const BAR_RADIUS = 24
export const PANEL_RADIUS = 16
export const GAP = 12
export const SIDEBAR_W = 260
export const BAR_W = 680
export const BAR_H_MIN = 48
export const BAR_H_MAX = 168
export const BAR_LINE_H = 24
export const PANEL_EMPTY_H = 120
export const PANEL_H_MAX = 420
export const PANEL_MAX_WORKAREA = 0.6
export const WORKAREA_MARGIN = 24
export const BAR_LINES_MIN = 1
export const BAR_LINES_MAX = 6

export interface ComputeLayoutInput {
  mode: LayoutMode
  barAnchor: BarAnchor
  barWidth: number
  barLines: number
  panelH: number
  workArea: Rect
  scaleFactor: number
  /**
   * Compositor-off fallback: the OS window is the visual bounding box (no
   * shadow gutter). Cards keep their screen positions; ShapeBounding cuts the
   * 12px gaps afterwards.
   */
  opaque?: boolean
}

export interface WindowLayout {
  mode: LayoutMode
  windowBounds: Rect
  windowBoundsDevice: Rect
  barRect: Rect
  panelRect?: Rect
  sidebarRect?: Rect
  visualBounds: Rect
  overlay: boolean
  scaleFactor: number
  anchor: BarAnchor
}

export interface ClampAnchorOptions {
  workArea: Rect
  barWidth: number
  barHeight?: number
  mode?: LayoutMode
  panelHeight?: number
}

function clamp(value: number, min: number, max: number): number {
  if (max < min) return min
  return Math.min(Math.max(value, min), max)
}

function normalizeScale(scaleFactor: number): number {
  return Number.isFinite(scaleFactor) && scaleFactor > 0 ? scaleFactor : 1
}

export function normalizeBarLines(lines: number): number {
  if (!Number.isFinite(lines)) return BAR_LINES_MIN
  return clamp(Math.round(lines), BAR_LINES_MIN, BAR_LINES_MAX)
}

export function barHeight(lines: number): number {
  const count = normalizeBarLines(lines)
  return clamp(BAR_H_MIN + (count - 1) * BAR_LINE_H, BAR_H_MIN, BAR_H_MAX)
}

export function panelHeight(contentH: number, workAreaH: number): number {
  const maxByWorkArea = Math.max(
    PANEL_EMPTY_H,
    Math.min(PANEL_H_MAX, Math.round(workAreaH * PANEL_MAX_WORKAREA))
  )
  if (!Number.isFinite(contentH) || contentH <= 0) return PANEL_EMPTY_H
  return clamp(Math.round(contentH), PANEL_EMPTY_H, maxByWorkArea)
}

export function defaultAnchor(workArea: Rect, barWidth: number): BarAnchor {
  return {
    x: workArea.x + Math.round((workArea.width - barWidth) / 2),
    y: workArea.y + Math.round(workArea.height * 0.12)
  }
}

export function clampAnchor(anchor: BarAnchor, options: ClampAnchorOptions): BarAnchor {
  const { workArea } = options
  const barWidth = Math.max(1, Math.round(options.barWidth))
  const barH = options.barHeight ?? barHeight(1)

  const minX = workArea.x + WORKAREA_MARGIN
  const maxX = Math.max(
    minX,
    workArea.x + workArea.width - WORKAREA_MARGIN - barWidth
  )
  const minY = workArea.y + WORKAREA_MARGIN
  const maxY = Math.max(minY, workArea.y + workArea.height - WORKAREA_MARGIN - barH)

  return {
    x: clamp(Math.round(anchor.x), minX, maxX),
    y: clamp(Math.round(anchor.y), minY, maxY)
  }
}

export interface SettleAnchorInput {
  anchor: BarAnchor
  workArea: Rect
  barWidth: number
  barHeight?: number
  mode?: LayoutMode
  panelHeight?: number
}

export interface SettleAnchorResult {
  anchor: BarAnchor
  panelHeight: number
}

/**
 * Turn an OS window position back into the visual bar anchor (the bar's
 * visible top-left). The OS window carries the shadow gutter, so adding the
 * layout's bar offset removes it again. The bar anchor never includes the
 * gutter.
 */
export function anchorFromWindowBounds(
  windowBounds: Rect,
  layout: WindowLayout
): BarAnchor {
  return {
    x: Math.round(windowBounds.x + layout.barRect.x),
    y: Math.round(windowBounds.y + layout.barRect.y)
  }
}

/**
 * Resolve a drag-settled anchor against the target work area.
 *
 * The bar is clamped first so it always stays fully visible with the 24px
 * margin. When a panel is open and the bottom would overflow, the panel is
 * reduced first (keeping its 120px floor whenever the work area allows it)
 * and the bar only moves when the bar itself would leave the work area.
 */
export function resolveSettledAnchor(input: SettleAnchorInput): SettleAnchorResult {
  const workArea: Rect = {
    x: Math.round(input.workArea.x),
    y: Math.round(input.workArea.y),
    width: Math.max(1, Math.round(input.workArea.width)),
    height: Math.max(1, Math.round(input.workArea.height))
  }
  const barWidth = Math.max(1, Math.round(input.barWidth))
  const barH = input.barHeight ?? barHeight(1)

  const minX = workArea.x + WORKAREA_MARGIN
  const maxX = Math.max(minX, workArea.x + workArea.width - WORKAREA_MARGIN - barWidth)
  const minY = workArea.y + WORKAREA_MARGIN
  const bottomLimit = workArea.y + workArea.height - WORKAREA_MARGIN
  const maxY = Math.max(minY, bottomLimit - barH)

  const anchor: BarAnchor = {
    x: clamp(Math.round(input.anchor.x), minX, maxX),
    y: clamp(Math.round(input.anchor.y), minY, maxY)
  }

  let panel = Math.max(0, Math.round(input.panelHeight ?? 0))
  if ((input.mode ?? 'S1') !== 'S1') {
    const available = Math.max(0, bottomLimit - (anchor.y + barH + GAP))
    if (panel > available) {
      // The 120px floor applies only when the remaining space can hold it.
      const floor = Math.min(PANEL_EMPTY_H, available)
      panel = clamp(panel, floor, available)
    }
  }

  return { anchor, panelHeight: panel }
}

export function toDeviceRect(rect: Rect, scaleFactor: number): Rect {
  const scale = normalizeScale(scaleFactor)
  return {
    x: Math.round(rect.x * scale),
    y: Math.round(rect.y * scale),
    width: Math.round(rect.width * scale),
    height: Math.round(rect.height * scale)
  }
}

function relativeRect(rect: Rect, windowBounds: Rect): Rect {
  return {
    x: rect.x - windowBounds.x,
    y: rect.y - windowBounds.y,
    width: rect.width,
    height: rect.height
  }
}

export function computeLayout(input: ComputeLayoutInput): WindowLayout {
  const workArea: Rect = {
    x: Math.round(input.workArea.x),
    y: Math.round(input.workArea.y),
    width: Math.max(1, Math.round(input.workArea.width)),
    height: Math.max(1, Math.round(input.workArea.height))
  }
  const scaleFactor = normalizeScale(input.scaleFactor)
  const barWidth = Math.max(1, Math.round(input.barWidth))
  const barH = barHeight(input.barLines)
  const anchor = clampAnchor(input.barAnchor, {
    workArea,
    barWidth,
    barHeight: barH,
    mode: input.mode,
    panelHeight: input.panelH
  })

  const hasPanel = input.mode !== 'S1'
  const maxPanel = Math.max(
    PANEL_EMPTY_H,
    Math.min(PANEL_H_MAX, Math.round(workArea.height * PANEL_MAX_WORKAREA))
  )
  let panelH = hasPanel
    ? Math.min(panelHeight(input.panelH, workArea.height), maxPanel)
    : 0

  if (hasPanel) {
    const bottomLimit = workArea.y + workArea.height - WORKAREA_MARGIN
    const available = bottomLimit - (anchor.y + barH + GAP)
    panelH = clamp(panelH, 0, Math.max(0, available))
  }

  const visualTop = anchor.y
  const visualHeight = barH + (hasPanel ? GAP + panelH : 0)

  let visualLeft = anchor.x
  let visualWidth = barWidth
  let overlay = false
  let barLeft = anchor.x

  if (input.mode === 'S3') {
    const normalLeft = anchor.x - GAP - SIDEBAR_W
    overlay = normalLeft < workArea.x + WORKAREA_MARGIN
    visualLeft = overlay ? Math.max(workArea.x + GAP, anchor.x - GAP) : normalLeft
    visualWidth = SIDEBAR_W + GAP + barWidth
    barLeft = overlay ? visualLeft + GAP : visualLeft + GAP + SIDEBAR_W
  }

  const visualBounds: Rect = {
    x: visualLeft,
    y: visualTop,
    width: visualWidth,
    height: visualHeight
  }

  const gutter = input.opaque === true ? { top: 0, left: 0, right: 0, bottom: 0 } : GUTTER
  const windowBounds: Rect = {
    x: visualLeft - gutter.left,
    y: visualTop - gutter.top,
    width: visualWidth + gutter.left + gutter.right,
    height: visualHeight + gutter.top + gutter.bottom
  }

  const barScreen: Rect = {
    x: barLeft,
    y: anchor.y,
    width: barWidth,
    height: barH
  }
  const barRect = relativeRect(barScreen, windowBounds)

  let panelRect: Rect | undefined
  if (hasPanel) {
    panelRect = relativeRect(
      {
        x: barLeft,
        y: anchor.y + barH + GAP,
        width: barWidth,
        height: panelH
      },
      windowBounds
    )
  }

  let sidebarRect: Rect | undefined
  if (input.mode === 'S3') {
    sidebarRect = relativeRect(
      overlay
        ? {
            x: visualLeft,
            y: anchor.y + barH + GAP,
            width: SIDEBAR_W,
            height: panelH
          }
        : {
            x: visualLeft,
            y: anchor.y,
            width: SIDEBAR_W,
            height: visualHeight
          },
      windowBounds
    )
  }

  const layout: WindowLayout = {
    mode: input.mode,
    windowBounds,
    windowBoundsDevice: toDeviceRect(windowBounds, scaleFactor),
    barRect,
    visualBounds,
    overlay,
    scaleFactor,
    anchor
  }
  if (panelRect) layout.panelRect = panelRect
  if (sidebarRect) layout.sidebarRect = sidebarRect
  return layout
}

export function buildShapeRects(layout: WindowLayout): Rect[] {
  const rects = [layout.barRect]
  if (layout.panelRect) rects.push(layout.panelRect)
  if (layout.sidebarRect) rects.push(layout.sidebarRect)
  return rects.map((rect) => toDeviceRect(rect, layout.scaleFactor))
}

/**
 * ShapeBounding uses the same visible-card union as ShapeInput. In opaque mode
 * this is what cuts the 12px gaps out of the otherwise opaque window.
 */
export function buildBoundingShapeRects(layout: WindowLayout): Rect[] {
  return buildShapeRects(layout)
}

export function buildBlurRects(layout: WindowLayout): Rect[] {
  const inset = Math.max(1, Math.round(2 * normalizeScale(layout.scaleFactor)))
  return buildShapeRects(layout).map((rect) => ({
    x: rect.x + inset,
    y: rect.y + inset,
    width: Math.max(1, rect.width - inset * 2),
    height: Math.max(1, rect.height - inset * 2)
  }))
}
