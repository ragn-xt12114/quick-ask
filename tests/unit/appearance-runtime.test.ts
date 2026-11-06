import { describe, expect, it } from 'vitest'
import {
  appearanceRuntimeChanged,
  compositorSnapshotFromSignals
} from '../../src/shared/appearance-runtime'
import {
  DEFAULT_ANIMATION_DURATION_FACTOR,
  normalizeAnimationDurationFactor,
  parseAnimationDurationFactor,
  reducedMotionEnabled
} from '../../src/shared/motion'

describe('compositor snapshot mapping', () => {
  it('enables blur only when compositor and effect are both on', () => {
    const on = compositorSnapshotFromSignals({
      compositor: true,
      blurEffect: true,
      animationDurationFactor: 1
    })
    expect(on).toMatchObject({
      compositor: true,
      blurEffect: true,
      blurAvailable: true,
      opaqueMode: false,
      reason: null
    })
    expect(on.blurStatus.available).toBe(true)
  })

  it('reports the honest reason and never enables blur otherwise', () => {
    const effectOff = compositorSnapshotFromSignals({
      compositor: true,
      blurEffect: false
    })
    expect(effectOff.blurAvailable).toBe(false)
    expect(effectOff.reason).toContain('KWin 模糊效果未开启')
    expect(effectOff.opaqueMode).toBe(false)

    const compositorOff = compositorSnapshotFromSignals({
      compositor: false,
      blurEffect: true
    })
    expect(compositorOff.blurAvailable).toBe(false)
    expect(compositorOff.opaqueMode).toBe(true)
    expect(compositorOff.reason).toContain('合成器未运行')

    const unknown = compositorSnapshotFromSignals({
      compositor: null,
      blurEffect: null
    })
    expect(unknown.blurAvailable).toBe(false)
    expect(unknown.opaqueMode).toBe(false)
    expect(unknown.reason).toContain('无法检测')
  })

  it('detects runtime changes for polling', () => {
    const first = compositorSnapshotFromSignals({
      compositor: true,
      blurEffect: false,
      animationDurationFactor: 1
    })
    const same = compositorSnapshotFromSignals({
      compositor: true,
      blurEffect: false,
      animationDurationFactor: 1
    })
    const changed = compositorSnapshotFromSignals({
      compositor: false,
      blurEffect: false,
      animationDurationFactor: 1
    })
    expect(appearanceRuntimeChanged(null, first)).toBe(true)
    expect(appearanceRuntimeChanged(first, same)).toBe(false)
    expect(appearanceRuntimeChanged(first, changed)).toBe(true)
  })
})

describe('reduced motion mapping', () => {
  it('defaults a missing KDE factor to 1 and clamps 0..10', () => {
    expect(parseAnimationDurationFactor('')).toBeNull()
    expect(parseAnimationDurationFactor('0')).toBe(0)
    expect(parseAnimationDurationFactor('0.5')).toBe(0.5)
    expect(parseAnimationDurationFactor('nope')).toBeNull()
    expect(normalizeAnimationDurationFactor('')).toBe(DEFAULT_ANIMATION_DURATION_FACTOR)
    expect(normalizeAnimationDurationFactor('-2')).toBe(0)
    expect(normalizeAnimationDurationFactor('99')).toBe(10)
  })

  it('disables motion when either the factor is 0 or the media query matches', () => {
    expect(reducedMotionEnabled(1, false)).toBe(false)
    expect(reducedMotionEnabled(0, false)).toBe(true)
    expect(reducedMotionEnabled(1, true)).toBe(true)
  })
})
