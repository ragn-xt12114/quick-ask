/**
 * Per-display window position memory (Task 34).
 *
 * A display key is stable across restarts for the same output configuration:
 *   `${outputName}|${width}x${height}@${scaleFactor}`
 *
 * `outputName` is the display label when the platform reports one, otherwise
 * the synthetic `display-<id>` fallback. Anchors are the visual bar top-left in
 * DIP; they are always clamped to the target work area before use.
 */

import { clampAnchor, defaultAnchor, type BarAnchor, type Rect } from './geometry'

export interface DisplayKeyInput {
  id: number
  label?: string | null
  /** Display width in DIP. */
  width: number
  /** Display height in DIP. */
  height: number
  scaleFactor: number
}

export const WINDOW_POSITION_MAX_ENTRIES = 64
export const WINDOW_POSITION_KEY_MAX_LENGTH = 200
export const WINDOW_POSITION_COORD_MAX = 1_000_000

export interface WindowSettings {
  /** Display key -> bar anchor. Missing key means "use defaultAnchor". */
  positions: Record<string, BarAnchor>
}

export const DEFAULT_WINDOW_SETTINGS: Readonly<WindowSettings> = Object.freeze({
  positions: Object.freeze({}) as Record<string, BarAnchor>
})

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function hasControlCharacter(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index)
    if (code <= 0x1f || code === 0x7f) return true
  }
  return false
}

function finiteDimension(value: number): number {
  if (!Number.isFinite(value)) return 1
  return Math.max(1, Math.round(value))
}

function normalizeScaleFactor(value: number): number {
  if (!Number.isFinite(value) || value <= 0) return 1
  return Number(value.toFixed(4))
}

function sanitizeOutputName(input: DisplayKeyInput): string {
  const raw = typeof input.label === 'string' ? input.label.trim() : ''
  const cleaned = raw.replace(/\|/g, '_').slice(0, 64)
  if (cleaned.length > 0 && !hasControlCharacter(cleaned)) return cleaned
  const id = Number.isFinite(input.id) ? Math.trunc(input.id) : 0
  return `display-${id}`
}

/**
 * Build the settings key for a display. Pure so unit tests can prove the
 * label/id fallback and the width x height @ scale layout without Electron.
 */
export function displayKey(input: DisplayKeyInput): string {
  return `${sanitizeOutputName(input)}|${finiteDimension(input.width)}x${finiteDimension(
    input.height
  )}@${normalizeScaleFactor(input.scaleFactor)}`
}

function normalizeAnchorValue(value: unknown): BarAnchor | null {
  if (!isRecord(value)) return null
  const rawX = value['x']
  const rawY = value['y']
  const x = typeof rawX === 'number' ? rawX : Number(rawX)
  const y = typeof rawY === 'number' ? rawY : Number(rawY)
  if (!Number.isFinite(x) || !Number.isFinite(y)) return null
  return {
    x: Math.round(Math.min(Math.max(x, -WINDOW_POSITION_COORD_MAX), WINDOW_POSITION_COORD_MAX)),
    y: Math.round(Math.min(Math.max(y, -WINDOW_POSITION_COORD_MAX), WINDOW_POSITION_COORD_MAX))
  }
}

export function isValidPositionKey(value: unknown): value is string {
  if (typeof value !== 'string') return false
  const trimmed = value.trim()
  return (
    trimmed.length > 0 &&
    trimmed.length <= WINDOW_POSITION_KEY_MAX_LENGTH &&
    !hasControlCharacter(trimmed)
  )
}

/**
 * Normalize a hand-edited/legacy positions map: drop malformed keys/anchors,
 * clamp coordinates and cap the number of remembered displays.
 */
export function normalizeWindowPositions(raw: unknown): Record<string, BarAnchor> {
  const source = isRecord(raw) ? raw : {}
  const entries = Object.entries(source)
    .filter(([key]) => isValidPositionKey(key))
    .map(([key, value]) => [key.trim(), normalizeAnchorValue(value)] as const)
    .filter((entry): entry is readonly [string, BarAnchor] => entry[1] !== null)
    .slice(-WINDOW_POSITION_MAX_ENTRIES)

  const positions: Record<string, BarAnchor> = {}
  for (const [key, anchor] of entries) {
    positions[key] = anchor
  }
  return positions
}

export function normalizeWindowSettings(raw: unknown): WindowSettings {
  const record = isRecord(raw) ? raw : {}
  return {
    positions: normalizeWindowPositions(record['positions'])
  }
}

/** Clamp a stored anchor to the current work area, preserving the 24px margin. */
export function clampStoredAnchor(
  anchor: BarAnchor,
  workArea: Rect,
  barWidth: number,
  barHeight: number
): BarAnchor {
  return clampAnchor(anchor, { workArea, barWidth, barHeight })
}

/**
 * Restore an anchor for one display. Unknown keys intentionally fall back to
 * the same default the pre-memory build used, so a new monitor never inherits
 * a stale position from another output.
 */
export function restoreAnchorForDisplay(
  positions: Record<string, BarAnchor>,
  key: string,
  workArea: Rect,
  barWidth: number,
  barHeight: number
): BarAnchor {
  const stored = positions[key]
  if (!stored) return defaultAnchor(workArea, barWidth)
  return clampStoredAnchor(stored, workArea, barWidth, barHeight)
}

/**
 * Move a remembered position when a display key disappears (output removed or
 * metrics/scale changed). The destination wins if it already has a position.
 */
export function migrateWindowPosition(
  positions: Record<string, BarAnchor>,
  fromKey: string | null,
  toKey: string
): Record<string, BarAnchor> {
  if (!fromKey || fromKey === toKey) return positions
  const from = positions[fromKey]
  if (!from) return positions
  const next: Record<string, BarAnchor> = { ...positions }
  delete next[fromKey]
  if (!next[toKey]) next[toKey] = from
  return next
}

export function sameAnchor(a: BarAnchor | undefined, b: BarAnchor | undefined): boolean {
  return Boolean(a && b && a.x === b.x && a.y === b.y)
}
