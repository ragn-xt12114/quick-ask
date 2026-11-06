/**
 * Pure compositor snapshot mapping. The live monitor lives in main; keeping the
 * decision table here makes the blur/opaque contract unit-testable without
 * spawning DBus or touching X11.
 */

import type { AppearanceRuntimeState, BlurStatus } from './channels'
import { blurStatusFromSignals } from './blur-status'
import { normalizeAnimationDurationFactor } from './motion'

export interface CompositorSignals {
  compositor: boolean | null
  blurEffect: boolean | null
  animationDurationFactor?: unknown
}

export interface CompositorSnapshot extends AppearanceRuntimeState {
  compositor: boolean | null
  blurEffect: boolean | null
  blurAvailable: boolean
  reason: string | null
  blurStatus: BlurStatus
}

export function compositorSnapshotFromSignals(
  signals: CompositorSignals
): CompositorSnapshot {
  const animationDurationFactor = normalizeAnimationDurationFactor(
    signals.animationDurationFactor
  )
  const blurStatus = blurStatusFromSignals({
    compositor: signals.compositor,
    effectEnabled: signals.blurEffect
  })
  return {
    compositor: signals.compositor,
    blurEffect: signals.blurEffect,
    blurAvailable: blurStatus.available,
    reason: blurStatus.reason,
    blurStatus,
    opaqueMode: signals.compositor === false,
    animationDurationFactor
  }
}

export function appearanceRuntimeChanged(
  previous: CompositorSnapshot | null,
  next: CompositorSnapshot
): boolean {
  if (previous === null) return true
  return (
    previous.compositor !== next.compositor ||
    previous.blurEffect !== next.blurEffect ||
    previous.blurAvailable !== next.blurAvailable ||
    previous.reason !== next.reason ||
    previous.opaqueMode !== next.opaqueMode ||
    previous.animationDurationFactor !== next.animationDurationFactor
  )
}
