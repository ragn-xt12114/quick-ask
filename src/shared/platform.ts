/**
 * Platform capability wire types shared by main, preload and renderer.
 *
 * These types are deliberately dependency-free: the sandboxed preload imports
 * shared modules at runtime. Capability descriptors are the only honest way the
 * UI learns that a platform can do less than another; a reason is mandatory for
 * every `degraded`/`unsupported` state.
 */

export type PlatformKind = 'linux' | 'win32' | 'other'

export type CapabilityState = 'available' | 'degraded' | 'unsupported'

export type ClickThroughPrecision = 'shape' | 'whole-window' | 'none'

export type FontSource = 'fc-list' | 'static' | 'none'

export type AutostartMechanism = 'xdg-desktop' | 'login-item' | 'none'

export interface CapabilityStatus {
  state: CapabilityState
  reason: string | null
}

export interface PlatformCapabilities {
  platform: PlatformKind
  label: string
  hotkey: CapabilityStatus
  clickThrough: CapabilityStatus & { precision: ClickThroughPrecision }
  blur: CapabilityStatus
  fonts: CapabilityStatus & { source: FontSource }
  autostart: CapabilityStatus & { mechanism: AutostartMechanism }
  watchdog: CapabilityStatus
  nativeHelper: CapabilityStatus
}

export function capability(
  state: CapabilityState,
  reason: string | null = null
): CapabilityStatus {
  return { state, reason }
}
