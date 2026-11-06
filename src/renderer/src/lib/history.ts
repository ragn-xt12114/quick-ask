/**
 * Pure history-sidebar helpers (Task 20).
 *
 * Kept renderer-agnostic so Node/Vitest can cover grouping, relative-time
 * formatting, title normalization and the manual virtual window without a DOM.
 */

import type { SessionSummary } from '../../../shared/channels'

export const HISTORY_GROUP_HEIGHT = 24
export const HISTORY_ITEM_HEIGHT = 48
export const HISTORY_GROUP_GAP = 12
export const HISTORY_OVERSCAN = 10
export const HISTORY_MAX_TITLE_CHARS = 80

const MINUTE_MS = 60_000
const HOUR_MS = 3_600_000
const DAY_MS = 86_400_000

export type HistoryGroupLabel = '今天' | '昨天' | '更早'

export interface HistoryGroupRow {
  kind: 'group'
  key: string
  label: HistoryGroupLabel
  top: number
  height: number
}

export interface HistoryItemRow {
  kind: 'item'
  key: string
  session: SessionSummary
  top: number
  height: number
}

export type HistoryRow = HistoryGroupRow | HistoryItemRow

/** Local calendar day index (DST-safe: built from Y/M/D, not epoch hours). */
function localDayIndex(timestamp: number): number {
  const date = new Date(timestamp)
  return Date.UTC(date.getFullYear(), date.getMonth(), date.getDate()) / DAY_MS
}

/** `今天` / `昨天` / `更早` based on local calendar dates. */
export function historyGroupFor(timestamp: number, now = Date.now()): HistoryGroupLabel {
  const diff = localDayIndex(now) - localDayIndex(timestamp)
  if (diff <= 0) return '今天'
  if (diff === 1) return '昨天'
  return '更早'
}

function pad2(value: number): string {
  return String(value).padStart(2, '0')
}

/**
 * F-05.3 / §3.6: 刚刚 · N 分钟 · N 小时 · 昨天 · MM-DD.
 * Calendar labels win over raw elapsed hours for the previous day; future
 * timestamps (clock skew) render as 刚刚.
 */
export function formatRelativeTime(timestamp: number, now = Date.now()): string {
  const diff = Math.max(0, now - timestamp)
  if (diff < MINUTE_MS) return '刚刚'

  if (diff < HOUR_MS) {
    return `${Math.floor(diff / MINUTE_MS)} 分钟`
  }

  const group = historyGroupFor(timestamp, now)
  if (group === '今天') {
    return `${Math.floor(diff / HOUR_MS)} 小时`
  }
  if (group === '昨天') return '昨天'

  const date = new Date(timestamp)
  return `${pad2(date.getMonth() + 1)}-${pad2(date.getDate())}`
}

/** Trim first, then cap at 80 Unicode code points; empty means invalid. */
export function normalizeHistoryTitle(
  value: string,
  maxChars = HISTORY_MAX_TITLE_CHARS
): string {
  const trimmed = value.trim()
  if (trimmed.length === 0) return ''
  return Array.from(trimmed).slice(0, Math.max(1, maxChars)).join('').trim()
}

/**
 * Flatten sessions into group headers + item rows with absolute offsets.
 * Extra 12px is inserted between groups (§3.6 `.qa-sidebar-group + ...`).
 */
export function buildHistoryRows(
  sessions: readonly SessionSummary[],
  now = Date.now()
): HistoryRow[] {
  if (sessions.length === 0) return []

  const ordered = [...sessions].sort((a, b) => {
    if (b.updatedAt !== a.updatedAt) return b.updatedAt - a.updatedAt
    return b.id.localeCompare(a.id)
  })

  const rows: HistoryRow[] = []
  let top = 0
  let groupCount = 0
  let currentLabel: HistoryGroupLabel | null = null
  let currentIndex = -1

  for (const session of ordered) {
    const label = historyGroupFor(session.updatedAt, now)
    if (label !== currentLabel) {
      if (groupCount > 0) top += HISTORY_GROUP_GAP
      currentIndex += 1
      rows.push({
        kind: 'group',
        key: `group-${currentIndex}-${label}`,
        label,
        top,
        height: HISTORY_GROUP_HEIGHT
      })
      top += HISTORY_GROUP_HEIGHT
      currentLabel = label
      groupCount += 1
    }

    rows.push({
      kind: 'item',
      key: session.id,
      session,
      top,
      height: HISTORY_ITEM_HEIGHT
    })
    top += HISTORY_ITEM_HEIGHT
  }

  return rows
}

export function historyTotalHeight(rows: readonly HistoryRow[]): number {
  const last = rows[rows.length - 1]
  return last ? last.top + last.height : 0
}

function firstRowEndingAfter(rows: readonly HistoryRow[], offset: number): number {
  let low = 0
  let high = rows.length
  while (low < high) {
    const mid = (low + high) >>> 1
    const row = rows[mid]!
    if (row.top + row.height <= offset) low = mid + 1
    else high = mid
  }
  return low
}

export interface VirtualWindow {
  start: number
  end: number
}

/**
 * Manual windowing: only rows intersecting the viewport plus `overscan` rows
 * on each side. For the 1000-session seed this keeps the DOM far below 80
 * items even on a tall window.
 */
export function computeVirtualWindow(
  rows: readonly HistoryRow[],
  scrollTop: number,
  viewportHeight: number,
  overscan = HISTORY_OVERSCAN
): VirtualWindow {
  if (rows.length === 0 || viewportHeight <= 0) return { start: 0, end: 0 }

  const offset = Math.max(0, scrollTop)
  const firstVisible = firstRowEndingAfter(rows, offset)
  if (firstVisible >= rows.length) {
    const start = Math.max(0, rows.length - Math.max(0, overscan))
    return { start, end: rows.length }
  }

  let end = firstVisible
  const bottom = offset + viewportHeight
  while (end < rows.length && rows[end]!.top < bottom) end += 1

  const start = Math.max(0, firstVisible - Math.max(0, overscan))
  end = Math.min(rows.length, end + Math.max(0, overscan))
  return { start, end }
}
