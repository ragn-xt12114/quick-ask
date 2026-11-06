/**
 * Reduced-motion mapping (plan B.9).
 *
 * KDE stores `AnimationDurationFactor` as a multiplier; 0 disables animations.
 * An absent key means the KDE default (1). The renderer combines this with
 * `prefers-reduced-motion` and only disables transitions/animations — it never
 * writes back to KDE configuration.
 */

export const DEFAULT_ANIMATION_DURATION_FACTOR = 1
export const ANIMATION_DURATION_FACTOR_MAX = 10

export function parseAnimationDurationFactor(raw: unknown): number | null {
  if (typeof raw === 'number') {
    return Number.isFinite(raw) ? raw : null
  }
  if (typeof raw !== 'string') return null
  const trimmed = raw.trim()
  if (trimmed.length === 0) return null
  const value = Number(trimmed)
  return Number.isFinite(value) ? value : null
}

export function normalizeAnimationDurationFactor(raw: unknown): number {
  const parsed = parseAnimationDurationFactor(raw)
  if (parsed === null) return DEFAULT_ANIMATION_DURATION_FACTOR
  return Math.min(ANIMATION_DURATION_FACTOR_MAX, Math.max(0, parsed))
}

export function reducedMotionEnabled(
  animationDurationFactor: number,
  prefersReducedMotion: boolean
): boolean {
  return prefersReducedMotion || animationDurationFactor <= 0
}
