import { describe, expect, it } from 'vitest'
import {
  DEFAULT_WINDOW_SETTINGS,
  displayKey,
  migrateWindowPosition,
  normalizeWindowPositions,
  normalizeWindowSettings,
  restoreAnchorForDisplay,
  sameAnchor,
  WINDOW_POSITION_MAX_ENTRIES
} from '../../src/shared/window-position'
import type { Rect } from '../../src/shared/geometry'

const workArea: Rect = { x: 0, y: 0, width: 1920, height: 1080 }

describe('display key selection', () => {
  it('prefers a trimmed display label', () => {
    expect(
      displayKey({ id: 7, label: '  DP-1  ', width: 1920, height: 1080, scaleFactor: 1 })
    ).toBe('DP-1|1920x1080@1')
  })

  it('uses the id fallback when the label is empty or unavailable', () => {
    expect(displayKey({ id: 7, label: null, width: 2560, height: 1440, scaleFactor: 1.25 })).toBe(
      'display-7|2560x1440@1.25'
    )
    expect(displayKey({ id: 9, label: '   ', width: 800, height: 600, scaleFactor: 2 })).toBe(
      'display-9|800x600@2'
    )
  })

  it('normalizes scale, dimensions and ambiguous label separators', () => {
    expect(
      displayKey({ id: 1, label: 'HDMI|A', width: 1919.6, height: 0, scaleFactor: 1.23456 })
    ).toBe('HDMI_A|1920x1@1.2346')
  })
})

describe('window position normalization', () => {
  it('returns an empty map for malformed payloads', () => {
    expect(normalizeWindowPositions(undefined)).toEqual({})
    expect(normalizeWindowPositions('nope')).toEqual({})
    expect(normalizeWindowPositions({ positions: {} })).toEqual({})
    expect(normalizeWindowSettings(undefined)).toEqual(DEFAULT_WINDOW_SETTINGS)
  })

  it('drops invalid keys/anchors and rounds finite coordinates', () => {
    expect(
      normalizeWindowPositions({
        'DP-1|1920x1080@1': { x: 10.4, y: -3.6 },
        '': { x: 1, y: 2 },
        'bad\nkey': { x: 1, y: 2 },
        'nope|1x1@1': { x: Number.NaN, y: 2 },
        'ok|1x1@1': { x: 4, y: 5 }
      })
    ).toEqual({
      'DP-1|1920x1080@1': { x: 10, y: -4 },
      'ok|1x1@1': { x: 4, y: 5 }
    })
  })

  it('caps the remembered display count', () => {
    const raw: Record<string, { x: number; y: number }> = {}
    for (let index = 0; index < WINDOW_POSITION_MAX_ENTRIES + 5; index += 1) {
      raw[`display-${index}|1x1@1`] = { x: index, y: index }
    }
    const normalized = normalizeWindowPositions(raw)
    expect(Object.keys(normalized)).toHaveLength(WINDOW_POSITION_MAX_ENTRIES)
    expect(normalized['display-4|1x1@1']).toBeUndefined()
    expect(normalized[`display-${WINDOW_POSITION_MAX_ENTRIES + 4}|1x1@1`]).toEqual({
      x: WINDOW_POSITION_MAX_ENTRIES + 4,
      y: WINDOW_POSITION_MAX_ENTRIES + 4
    })
  })
})

describe('restore and clamp', () => {
  it('restores the exact stored anchor for a matching display key', () => {
    const anchor = restoreAnchorForDisplay(
      { 'DP-1|1920x1080@1': { x: 400, y: 300 } },
      'DP-1|1920x1080@1',
      workArea,
      680,
      48
    )
    expect(anchor).toEqual({ x: 400, y: 300 })
  })

  it('clamps a stored anchor that no longer fits the work area', () => {
    expect(
      restoreAnchorForDisplay(
        { 'DP-1|1920x1080@1': { x: 5000, y: -500 } },
        'DP-1|1920x1080@1',
        workArea,
        680,
        48
      )
    ).toEqual({ x: 1920 - 24 - 680, y: 24 })
  })

  it('falls back to the default anchor for a different simulated display key', () => {
    expect(
      restoreAnchorForDisplay(
        { 'FAKE|800x600@1': { x: 20, y: 20 } },
        'DP-1|1920x1080@1',
        workArea,
        680,
        48
      )
    ).toEqual({ x: 620, y: 130 })
  })
})

describe('display migration', () => {
  it('moves a position to the new key when the old output disappears', () => {
    expect(
      migrateWindowPosition(
        { 'DP-1|1920x1080@1': { x: 100, y: 200 } },
        'DP-1|1920x1080@1',
        'HDMI-1|2560x1440@1.25'
      )
    ).toEqual({ 'HDMI-1|2560x1440@1.25': { x: 100, y: 200 } })
  })

  it('keeps an existing destination position and handles no-op inputs', () => {
    const positions = { a: { x: 1, y: 1 }, b: { x: 2, y: 2 } }
    expect(migrateWindowPosition(positions, 'a', 'b')).toEqual({ b: { x: 2, y: 2 } })
    expect(migrateWindowPosition(positions, null, 'b')).toBe(positions)
    expect(migrateWindowPosition(positions, 'a', 'a')).toBe(positions)
    expect(migrateWindowPosition(positions, 'missing', 'b')).toBe(positions)
  })
})

describe('anchor comparison', () => {
  it('compares both coordinates', () => {
    expect(sameAnchor({ x: 1, y: 2 }, { x: 1, y: 2 })).toBe(true)
    expect(sameAnchor({ x: 1, y: 2 }, { x: 1, y: 3 })).toBe(false)
    expect(sameAnchor(undefined, { x: 1, y: 2 })).toBe(false)
  })
})
