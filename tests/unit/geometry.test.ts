import { describe, expect, it } from 'vitest'
import {
  BAR_H_MAX,
  BAR_H_MIN,
  BAR_W,
  GAP,
  GUTTER,
  PANEL_EMPTY_H,
  SIDEBAR_W,
  WORKAREA_MARGIN,
  anchorFromWindowBounds,
  barHeight,
  buildBlurRects,
  buildBoundingShapeRects,
  buildShapeRects,
  clampAnchor,
  computeLayout,
  defaultAnchor,
  panelHeight,
  resolveSettledAnchor,
  type LayoutMode,
  type Rect,
  type WindowLayout
} from '../../src/shared/geometry'

const WORK_AREA_1080: Rect = { x: 0, y: 0, width: 1920, height: 1080 }

function pointInRect(rect: Rect, x: number, y: number): boolean {
  return x >= rect.x && x < rect.x + rect.width && y >= rect.y && y < rect.y + rect.height
}

function pointInAny(rects: Rect[], x: number, y: number): boolean {
  return rects.some((rect) => pointInRect(rect, x, y))
}

function layoutFor(mode: LayoutMode, anchor = { x: 620, y: 130 }, panelH = 200, scaleFactor = 1) {
  return computeLayout({
    mode,
    barAnchor: anchor,
    barWidth: BAR_W,
    barLines: 1,
    panelH,
    workArea: WORK_AREA_1080,
    scaleFactor
  })
}

function screenBar(layout: WindowLayout) {
  return {
    x: layout.windowBounds.x + layout.barRect.x,
    y: layout.windowBounds.y + layout.barRect.y,
    width: layout.barRect.width,
    height: layout.barRect.height
  }
}

describe('geometry constants', () => {
  it('matches the plan token values', () => {
    expect(GUTTER).toEqual({ top: 28, left: 40, right: 40, bottom: 52 })
    expect(BAR_W).toBe(680)
    expect(SIDEBAR_W).toBe(260)
    expect(GAP).toBe(12)
    expect(WORKAREA_MARGIN).toBe(24)
    expect(PANEL_EMPTY_H).toBe(120)
  })
})

describe('barHeight', () => {
  it('grows 24px per line and clamps to 48..168', () => {
    expect(barHeight(1)).toBe(BAR_H_MIN)
    expect(barHeight(2)).toBe(72)
    expect(barHeight(3)).toBe(96)
    expect(barHeight(6)).toBe(BAR_H_MAX)
    expect(barHeight(7)).toBe(BAR_H_MAX)
    expect(barHeight(0)).toBe(BAR_H_MIN)
    expect(barHeight(Number.NaN)).toBe(BAR_H_MIN)
  })
})

describe('panelHeight', () => {
  it('uses 120 for empty content and clamps to min(420, workArea*0.6)', () => {
    expect(panelHeight(0, 1080)).toBe(120)
    expect(panelHeight(100, 1080)).toBe(120)
    expect(panelHeight(200, 1080)).toBe(200)
    expect(panelHeight(999, 1080)).toBe(420)
    expect(panelHeight(999, 500)).toBe(300)
    expect(panelHeight(200, 500)).toBe(200)
    expect(panelHeight(999, 100)).toBe(120)
  })
})

describe('defaultAnchor / clampAnchor', () => {
  it('centers horizontally and uses 12% of the work area height', () => {
    expect(defaultAnchor(WORK_AREA_1080, BAR_W)).toEqual({ x: 620, y: 130 })
    expect(defaultAnchor({ x: 1920, y: 0, width: 2560, height: 1440 }, BAR_W)).toEqual({
      x: 2860,
      y: 173
    })
  })

  it('clamps to 24px margins and keeps the bar inside the work area', () => {
    const options = { workArea: WORK_AREA_1080, barWidth: BAR_W, barHeight: 48 }
    expect(clampAnchor({ x: -1000, y: -1000 }, options)).toEqual({ x: 24, y: 24 })
    expect(clampAnchor({ x: 5000, y: 5000 }, options)).toEqual({ x: 1216, y: 1008 })
    expect(clampAnchor({ x: 620, y: 130 }, options)).toEqual({ x: 620, y: 130 })
  })
})

describe('S1 layout', () => {
  it('wraps the 680x48 bar in the asymmetric gutter at 100%', () => {
    const layout = layoutFor('S1')

    expect(layout.visualBounds).toEqual({ x: 620, y: 130, width: 680, height: 48 })
    expect(layout.windowBounds).toEqual({ x: 580, y: 102, width: 760, height: 128 })
    expect(layout.windowBoundsDevice).toEqual(layout.windowBounds)
    expect(layout.barRect).toEqual({ x: 40, y: 28, width: 680, height: 48 })
    expect(layout.panelRect).toBeUndefined()
    expect(layout.sidebarRect).toBeUndefined()
    expect(layout.overlay).toBe(false)
    expect(buildShapeRects(layout)).toEqual([{ x: 40, y: 28, width: 680, height: 48 }])
    expect(buildBlurRects(layout)).toEqual([{ x: 42, y: 30, width: 676, height: 44 }])
  })
})

describe('S2 layout', () => {
  it('stacks the panel below the 12px gap without moving the bar', () => {
    const layout = layoutFor('S2')

    expect(layout.visualBounds).toEqual({ x: 620, y: 130, width: 680, height: 260 })
    expect(layout.windowBounds).toEqual({ x: 580, y: 102, width: 760, height: 340 })
    expect(layout.barRect).toEqual({ x: 40, y: 28, width: 680, height: 48 })
    expect(layout.panelRect).toEqual({ x: 40, y: 88, width: 680, height: 200 })
    expect(buildShapeRects(layout)).toEqual([
      { x: 40, y: 28, width: 680, height: 48 },
      { x: 40, y: 88, width: 680, height: 200 }
    ])
    expect(screenBar(layout)).toEqual({ x: 620, y: 130, width: 680, height: 48 })
  })

  it('reduces panel height first when the bottom edge would overflow', () => {
    const layout = computeLayout({
      mode: 'S2',
      barAnchor: { x: 620, y: 900 },
      barWidth: BAR_W,
      barLines: 1,
      panelH: 420,
      workArea: WORK_AREA_1080,
      scaleFactor: 1
    })

    expect(layout.anchor.y).toBe(900)
    expect(layout.panelRect?.height).toBe(96)
    expect(layout.windowBounds.y + layout.barRect.y + layout.barRect.height).toBe(948)
  })
})

describe('S3 normal layout', () => {
  it('places the sidebar to the left and keeps the bar anchored', () => {
    const layout = layoutFor('S3')

    expect(layout.overlay).toBe(false)
    expect(layout.visualBounds).toEqual({ x: 348, y: 130, width: 952, height: 260 })
    expect(layout.windowBounds).toEqual({ x: 308, y: 102, width: 1032, height: 340 })
    expect(layout.sidebarRect).toEqual({ x: 40, y: 28, width: 260, height: 260 })
    expect(layout.barRect).toEqual({ x: 312, y: 28, width: 680, height: 48 })
    expect(layout.panelRect).toEqual({ x: 312, y: 88, width: 680, height: 200 })
    expect(screenBar(layout)).toEqual({ x: 620, y: 130, width: 680, height: 48 })
  })

  it('switches to overlay exactly when the normal left edge would be under 24px', () => {
    expect(layoutFor('S3', { x: 295, y: 130 }).overlay).toBe(true)
    expect(layoutFor('S3', { x: 296, y: 130 }).overlay).toBe(false)
  })
})

describe('S3 overlay layout', () => {
  it('keeps the bar anchored and moves the sidebar below it at the left edge', () => {
    const layout = layoutFor('S3', { x: 100, y: 130 })

    expect(layout.overlay).toBe(true)
    expect(layout.visualBounds).toEqual({ x: 88, y: 130, width: 952, height: 260 })
    expect(layout.windowBounds).toEqual({ x: 48, y: 102, width: 1032, height: 340 })
    expect(layout.sidebarRect).toEqual({ x: 40, y: 88, width: 260, height: 200 })
    expect(layout.barRect).toEqual({ x: 52, y: 28, width: 680, height: 48 })
    expect(layout.panelRect).toEqual({ x: 52, y: 88, width: 680, height: 200 })
    expect(screenBar(layout)).toEqual({ x: 100, y: 130, width: 680, height: 48 })
  })

  it('clamps an anchor under the left margin without moving the bar again', () => {
    const layout = layoutFor('S3', { x: 10, y: 130 })

    expect(layout.anchor.x).toBe(24)
    expect(screenBar(layout).x).toBe(24)
    expect(layout.visualBounds.x).toBe(12)
  })
})

describe('shape and blur rectangles', () => {
  it('excludes the gutter and the 12px gap from ShapeInput', () => {
    const layout = layoutFor('S2')
    const shape = buildShapeRects(layout)

    expect(pointInAny(shape, 0, 0)).toBe(false)
    expect(pointInAny(shape, 40, 28 + 48 + 6)).toBe(false)
    expect(pointInAny(shape, 40 + 680 / 2, 28 + 24)).toBe(true)
    expect(pointInAny(shape, 40 + 680 / 2, 88 + 100)).toBe(true)
  })

  it('excludes the S3 overlay L-shaped dead area from ShapeInput', () => {
    const layout = layoutFor('S3', { x: 100, y: 130 })
    const shape = buildShapeRects(layout)

    expect(pointInAny(shape, 45, 50)).toBe(false)
    expect(pointInAny(shape, 900, 50)).toBe(false)
    expect(pointInAny(shape, 52 + 340, 28 + 24)).toBe(true)
    expect(pointInAny(shape, 40 + 130, 88 + 100)).toBe(true)
  })

  it('insets every blur rectangle by 2px at 100% (min 1px)', () => {
    const layout = layoutFor('S2')
    expect(buildBlurRects(layout)).toEqual([
      { x: 42, y: 30, width: 676, height: 44 },
      { x: 42, y: 90, width: 676, height: 196 }
    ])
  })
})

describe('opaque compositor-off layout', () => {
  function opaqueFor(mode: LayoutMode, anchor = { x: 620, y: 130 }) {
    return computeLayout({
      mode,
      barAnchor: anchor,
      barWidth: BAR_W,
      barLines: 1,
      panelH: 200,
      workArea: WORK_AREA_1080,
      scaleFactor: 1,
      opaque: true
    })
  }

  it('removes the shadow gutter so the window equals the visual bounds', () => {
    for (const mode of ['S1', 'S2', 'S3'] as const) {
      const layout = opaqueFor(mode)
      expect(layout.windowBounds).toEqual(layout.visualBounds)
      expect(layout.windowBoundsDevice).toEqual(layout.visualBounds)
    }
  })

  it('keeps the bar screen position fixed across normal/opaque and widths', () => {
    const normal = layoutFor('S2')
    const opaque = opaqueFor('S2')
    expect(screenBar(opaque)).toEqual(screenBar(normal))
    expect(screenBar(opaque).x).toBe(620)
    expect(screenBar(opaque).y).toBe(130)

    for (const width of [560, 680, 900]) {
      const base = { ...opaqueFor('S2') }
      const variant = computeLayout({
        mode: 'S2',
        barAnchor: { x: 620, y: 130 },
        barWidth: width,
        barLines: 1,
        panelH: 200,
        workArea: WORK_AREA_1080,
        scaleFactor: 1,
        opaque: true
      })
      expect(screenBar(variant).x).toBe(620)
      expect(screenBar(variant).y).toBe(130)
      expect(variant.windowBounds.width).toBe(width)
      expect(base.windowBounds.width).toBe(BAR_W)
    }
  })

  it('builds a bounding shape that cuts the 12px gap and uses no gutter', () => {
    const layout = opaqueFor('S2')
    const shape = buildBoundingShapeRects(layout)
    expect(shape).toEqual(buildShapeRects(layout))
    expect(pointInAny(shape, 0, 0)).toBe(true)
    expect(pointInAny(shape, BAR_W / 2, 48 + GAP / 2)).toBe(false)
    expect(pointInAny(shape, BAR_W / 2, 48 + GAP + 20)).toBe(true)
    expect(pointInAny(shape, -1, 0)).toBe(false)
  })
})

describe('device pixels at 125%', () => {
  it('rounds window and card rectangles independently', () => {
    const layout = layoutFor('S1', { x: 620, y: 130 }, 200, 1.25)

    expect(layout.windowBounds).toEqual({ x: 580, y: 102, width: 760, height: 128 })
    expect(layout.windowBoundsDevice).toEqual({ x: 725, y: 128, width: 950, height: 160 })
    expect(buildShapeRects(layout)).toEqual([{ x: 50, y: 35, width: 850, height: 60 }])
    expect(buildBlurRects(layout)).toEqual([{ x: 53, y: 38, width: 844, height: 54 }])
  })
})

describe('bar stability across modes', () => {
  const anchors = [
    { x: 620, y: 130 },
    { x: 100, y: 130 },
    { x: 1216, y: 1008 }
  ]

  it.each(anchors)('keeps the bar screen position within 1px for %j at 100%%', (anchor) => {
    const s1 = screenBar(layoutFor('S1', anchor))
    const s2 = screenBar(layoutFor('S2', anchor))
    const s3 = screenBar(layoutFor('S3', anchor))

    for (const candidate of [s2, s3]) {
      expect(Math.abs(candidate.x - s1.x)).toBeLessThanOrEqual(1)
      expect(Math.abs(candidate.y - s1.y)).toBeLessThanOrEqual(1)
    }
  })

  it.each(anchors)('keeps the bar screen position within 1px for %j at 125%%', (anchor) => {
    const s1 = screenBar(layoutFor('S1', anchor, 200, 1.25))
    const s2 = screenBar(layoutFor('S2', anchor, 200, 1.25))
    const s3 = screenBar(layoutFor('S3', anchor, 200, 1.25))

    for (const candidate of [s2, s3]) {
      expect(Math.abs(candidate.x - s1.x)).toBeLessThanOrEqual(1)
      expect(Math.abs(candidate.y - s1.y)).toBeLessThanOrEqual(1)
    }
  })
})

describe('bar line and panel combinations', () => {
  it('keeps the bar anchored while the bar grows from 1 to 6 lines', () => {
    for (const lines of [1, 2, 3, 4, 5, 6]) {
      const layout = computeLayout({
        mode: 'S2',
        barAnchor: { x: 620, y: 130 },
        barWidth: BAR_W,
        barLines: lines,
        panelH: 120,
        workArea: WORK_AREA_1080,
        scaleFactor: 1
      })
      expect(layout.barRect.height).toBe(barHeight(lines))
      expect(screenBar(layout).x).toBe(620)
      expect(screenBar(layout).y).toBe(130)
    }
  })
})

const SECOND_WORK_AREA: Rect = { x: 1920, y: 0, width: 2560, height: 1440 }

describe('resolveSettledAnchor clamping', () => {
  const base = {
    workArea: WORK_AREA_1080,
    barWidth: BAR_W,
    barHeight: 48,
    mode: 'S1' as const,
    panelHeight: PANEL_EMPTY_H
  }

  it('clamps at all four edges with the 24px work-area margin', () => {
    expect(resolveSettledAnchor({ ...base, anchor: { x: -500, y: -500 } }).anchor).toEqual({
      x: 24,
      y: 24
    })
    expect(resolveSettledAnchor({ ...base, anchor: { x: 5000, y: 5000 } }).anchor).toEqual({
      x: 1216,
      y: 1008
    })
    expect(resolveSettledAnchor({ ...base, anchor: { x: -1, y: 500 } }).anchor).toEqual({
      x: 24,
      y: 500
    })
    expect(resolveSettledAnchor({ ...base, anchor: { x: 1300, y: -1 } }).anchor).toEqual({
      x: 1216,
      y: 24
    })
  })

  it('leaves an in-bounds anchor untouched', () => {
    expect(resolveSettledAnchor({ ...base, anchor: { x: 620, y: 130 } })).toEqual({
      anchor: { x: 620, y: 130 },
      panelHeight: PANEL_EMPTY_H
    })
  })
})

describe('resolveSettledAnchor across displays', () => {
  it('keeps a second-display anchor and rebuilds DIP/device rectangles at 125%', () => {
    const anchor = { x: 2860, y: 173 }
    const resolved = resolveSettledAnchor({
      anchor,
      workArea: SECOND_WORK_AREA,
      barWidth: BAR_W,
      barHeight: 48,
      mode: 'S1',
      panelHeight: PANEL_EMPTY_H
    })
    expect(resolved.anchor).toEqual(anchor)

    const layout = computeLayout({
      mode: 'S1',
      barAnchor: resolved.anchor,
      barWidth: BAR_W,
      barLines: 1,
      panelH: PANEL_EMPTY_H,
      workArea: SECOND_WORK_AREA,
      scaleFactor: 1.25
    })
    expect(layout.windowBounds).toEqual({ x: 2820, y: 145, width: 760, height: 128 })
    expect(layout.windowBoundsDevice).toEqual({ x: 3525, y: 181, width: 950, height: 160 })
    expect(buildShapeRects(layout)).toEqual([{ x: 50, y: 35, width: 850, height: 60 }])
  })

  it('clamps a fallback anchor into the primary work area when a display disappeared', () => {
    const resolved = resolveSettledAnchor({
      anchor: { x: 2860, y: 173 },
      workArea: WORK_AREA_1080,
      barWidth: BAR_W,
      barHeight: 48,
      mode: 'S1',
      panelHeight: PANEL_EMPTY_H
    })
    expect(resolved.anchor).toEqual({ x: 1216, y: 173 })
  })

  it('converts an OS window position back into the visual top-left anchor', () => {
    const layout = layoutFor('S1', { x: 620, y: 130 })
    expect(anchorFromWindowBounds(layout.windowBounds, layout)).toEqual({ x: 620, y: 130 })

    const moved = {
      ...layout.windowBounds,
      x: layout.windowBounds.x + 100,
      y: layout.windowBounds.y + 60
    }
    expect(anchorFromWindowBounds(moved, layout)).toEqual({ x: 720, y: 190 })
  })

  it('applies the S3 overlay threshold relative to each display origin', () => {
    const options = {
      mode: 'S3' as const,
      barWidth: BAR_W,
      barLines: 1,
      panelH: 200,
      workArea: SECOND_WORK_AREA,
      scaleFactor: 1
    }
    expect(computeLayout({ ...options, barAnchor: { x: 2215, y: 130 } }).overlay).toBe(true)
    expect(computeLayout({ ...options, barAnchor: { x: 2216, y: 130 } }).overlay).toBe(false)
    expect(screenBar(computeLayout({ ...options, barAnchor: { x: 2216, y: 130 } })).x).toBe(2216)
  })
})

describe('resolveSettledAnchor bottom shrink', () => {
  it('shrinks the panel first and keeps the bar when the bottom is tight', () => {
    const resolved = resolveSettledAnchor({
      anchor: { x: 620, y: 800 },
      workArea: WORK_AREA_1080,
      barWidth: BAR_W,
      barHeight: 48,
      mode: 'S2',
      panelHeight: 420
    })
    expect(resolved.anchor).toEqual({ x: 620, y: 800 })
    expect(resolved.panelHeight).toBe(196)

    const layout = computeLayout({
      mode: 'S2',
      barAnchor: resolved.anchor,
      barWidth: BAR_W,
      barLines: 1,
      panelH: resolved.panelHeight,
      workArea: WORK_AREA_1080,
      scaleFactor: 1
    })
    expect(layout.panelRect?.height).toBe(196)
    expect(screenBar(layout)).toEqual({ x: 620, y: 800, width: BAR_W, height: 48 })
  })

  it('keeps a 120px panel when the remaining space can hold it', () => {
    const resolved = resolveSettledAnchor({
      anchor: { x: 620, y: 780 },
      workArea: WORK_AREA_1080,
      barWidth: BAR_W,
      barHeight: 48,
      mode: 'S2',
      panelHeight: 420
    })
    expect(resolved.anchor.y).toBe(780)
    expect(resolved.panelHeight).toBe(216)
  })

  it('never lets the bar itself leave the work area', () => {
    const resolved = resolveSettledAnchor({
      anchor: { x: 620, y: 5000 },
      workArea: WORK_AREA_1080,
      barWidth: BAR_W,
      barHeight: 48,
      mode: 'S2',
      panelHeight: 420
    })
    expect(resolved.anchor).toEqual({ x: 620, y: 1008 })
    expect(resolved.panelHeight).toBe(0)
  })

  it('leaves the S1 panel height untouched', () => {
    const resolved = resolveSettledAnchor({
      anchor: { x: 620, y: 800 },
      workArea: WORK_AREA_1080,
      barWidth: BAR_W,
      barHeight: 48,
      mode: 'S1',
      panelHeight: 420
    })
    expect(resolved.panelHeight).toBe(420)
  })
})

describe('settled anchor device pixels at 100% and 125%', () => {
  it('rounds 125% device rectangles from the same DIP rectangles', () => {
    const resolved = resolveSettledAnchor({
      anchor: { x: 720, y: 190 },
      workArea: WORK_AREA_1080,
      barWidth: BAR_W,
      barHeight: 48,
      mode: 'S2',
      panelHeight: 200
    })
    const dip = computeLayout({
      mode: 'S2',
      barAnchor: resolved.anchor,
      barWidth: BAR_W,
      barLines: 1,
      panelH: resolved.panelHeight,
      workArea: WORK_AREA_1080,
      scaleFactor: 1
    })
    const hidpi = computeLayout({
      mode: 'S2',
      barAnchor: resolved.anchor,
      barWidth: BAR_W,
      barLines: 1,
      panelH: resolved.panelHeight,
      workArea: WORK_AREA_1080,
      scaleFactor: 1.25
    })

    const expectedDevice = buildShapeRects(dip).map((rect) => ({
      x: Math.round(rect.x * 1.25),
      y: Math.round(rect.y * 1.25),
      width: Math.round(rect.width * 1.25),
      height: Math.round(rect.height * 1.25)
    }))
    expect(buildShapeRects(hidpi)).toEqual(expectedDevice)
    expect(hidpi.windowBounds).toEqual(dip.windowBounds)
    expect(hidpi.windowBoundsDevice).toEqual({
      x: Math.round(dip.windowBounds.x * 1.25),
      y: Math.round(dip.windowBounds.y * 1.25),
      width: Math.round(dip.windowBounds.width * 1.25),
      height: Math.round(dip.windowBounds.height * 1.25)
    })
  })
})
