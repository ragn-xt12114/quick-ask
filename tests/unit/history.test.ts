import { describe, expect, it } from 'vitest'
import type { SessionSummary } from '../../src/shared/channels'
import {
  HISTORY_GROUP_GAP,
  HISTORY_GROUP_HEIGHT,
  HISTORY_ITEM_HEIGHT,
  HISTORY_OVERSCAN,
  buildHistoryRows,
  computeVirtualWindow,
  formatRelativeTime,
  historyGroupFor,
  historyTotalHeight,
  normalizeHistoryTitle
} from '../../src/renderer/src/lib/history'

function at(year: number, month: number, day: number, hour = 12, minute = 0): number {
  return new Date(year, month - 1, day, hour, minute, 0, 0).getTime()
}

function session(
  id: string,
  updatedAt: number,
  title = `会话 ${id}`
): SessionSummary {
  return { id, title, updatedAt, lastMessageAt: updatedAt, model: 'mock' }
}

describe('history relative time (F-05.3 / §3.6)', () => {
  const now = at(2026, 11, 5, 12, 0)

  it('formats 刚刚 / N 分钟 / N 小时 / 昨天 / MM-DD', () => {
    expect(formatRelativeTime(now - 5_000, now)).toBe('刚刚')
    expect(formatRelativeTime(now - 3 * 60_000, now)).toBe('3 分钟')
    expect(formatRelativeTime(now - 2 * 3_600_000, now)).toBe('2 小时')
    expect(formatRelativeTime(at(2026, 11, 4, 9), now)).toBe('昨天')
    expect(formatRelativeTime(at(2026, 11, 1, 9), now)).toBe('11-01')
    expect(formatRelativeTime(now + 60_000, now)).toBe('刚刚')
  })

  it('groups by local calendar day, not elapsed hours', () => {
    expect(historyGroupFor(at(2026, 11, 5, 0, 1), now)).toBe('今天')
    expect(historyGroupFor(at(2026, 11, 4, 23, 59), now)).toBe('昨天')
    expect(historyGroupFor(at(2026, 11, 3, 23, 59), now)).toBe('更早')
  })
})

describe('history rows / virtual window (F-05.8)', () => {
  const now = at(2026, 11, 5, 12, 0)

  it('flattens group headers (24) and items (48) with 12px group gaps', () => {
    const rows = buildHistoryRows(
      [
        session('a', now - 3 * 60_000),
        session('b', now - 60 * 60_000),
        session('c', at(2026, 11, 4, 9)),
        session('d', at(2026, 10, 20, 9))
      ],
      now
    )

    expect(rows.map((row) => (row.kind === 'group' ? row.label : row.session.id))).toEqual([
      '今天',
      'a',
      'b',
      '昨天',
      'c',
      '更早',
      'd'
    ])
    expect(rows[0]).toMatchObject({ kind: 'group', top: 0, height: HISTORY_GROUP_HEIGHT })
    expect(rows[1]).toMatchObject({ kind: 'item', top: 24, height: HISTORY_ITEM_HEIGHT })
    expect(rows[2]).toMatchObject({ kind: 'item', top: 72, height: HISTORY_ITEM_HEIGHT })
    expect(rows[3]).toMatchObject({
      kind: 'group',
      top: 72 + HISTORY_ITEM_HEIGHT + HISTORY_GROUP_GAP
    })
    expect(historyTotalHeight(rows)).toBe(rows[rows.length - 1]!.top + HISTORY_ITEM_HEIGHT)
  })

  it('keeps the 1000-session DOM window bounded (<80 items) at every scroll offset', () => {
    const sessions = Array.from({ length: 1000 }, (_, index) =>
      session(`s-${index}`, now - index * 37 * 60_000)
    )
    const rows = buildHistoryRows(sessions, now)
    expect(historyTotalHeight(rows)).toBeGreaterThan(1000 * HISTORY_ITEM_HEIGHT)

    const viewport = 332
    const offsets = [0, 1, 500, 4_000, 12_345, historyTotalHeight(rows) - viewport]
    for (const offset of offsets) {
      const range = computeVirtualWindow(rows, offset, viewport)
      const itemCount = rows
        .slice(range.start, range.end)
        .filter((row) => row.kind === 'item').length
      expect(itemCount).toBeGreaterThan(0)
      expect(itemCount).toBeLessThan(80)
      const rowCount = range.end - range.start
      expect(rowCount).toBeLessThanOrEqual(
        Math.ceil(viewport / HISTORY_ITEM_HEIGHT) + HISTORY_OVERSCAN * 2 + 4
      )
    }
  })

  it('returns an empty window for empty rows or an unmeasured viewport', () => {
    expect(computeVirtualWindow([], 0, 300)).toEqual({ start: 0, end: 0 })
    expect(computeVirtualWindow(buildHistoryRows([session('x', now)], now), 0, 0)).toEqual({
      start: 0,
      end: 0
    })
  })
})

describe('history title normalization', () => {
  it('trims, caps at 80 code points and rejects empty titles', () => {
    expect(normalizeHistoryTitle('  重命名 会话  ')).toBe('重命名 会话')
    expect(normalizeHistoryTitle('   ')).toBe('')
    const long = '😀'.repeat(100)
    expect(Array.from(normalizeHistoryTitle(long))).toHaveLength(80)
    expect(normalizeHistoryTitle(`${'a'.repeat(90)}`, 80)).toHaveLength(80)
  })
})
