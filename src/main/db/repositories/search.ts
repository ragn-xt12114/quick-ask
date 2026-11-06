import type { SessionSummary } from '../../../shared/channels'
import type { DbDriver, DbRow } from '../driver'
import { asNullableNumber, asNullableString, asNumber, asString } from './rows'

function mapSummary(row: DbRow): SessionSummary {
  return {
    id: asString(row.id),
    title: asString(row.title),
    updatedAt: asNumber(row.updated_at),
    lastMessageAt: asNullableNumber(row.last_message_at),
    model: asNullableString(row.model)
  }
}

/** `%`, `_` and `\` must not turn into LIKE wildcards. */
export function escapeLikePattern(value: string): string {
  return value.replace(/[\\%_]/g, (match) => `\\${match}`)
}

/** FTS5 string literal: wrap in double quotes, double internal quotes. */
export function quoteFtsQuery(value: string): string {
  return `"${value.replace(/"/g, '""')}"`
}

function charLength(value: string): number {
  return Array.from(value).length
}

const SUMMARY_COLUMNS = 's.id, s.title, s.updated_at, s.last_message_at, s.model'

export class SearchRepository {
  constructor(
    private readonly driver: DbDriver,
    private readonly ftsAvailable: boolean
  ) {}

  /** Rebuild one session's FTS row: title + all message bodies (≤64k chars). */
  rebuild(sessionId: string): void {
    if (!this.ftsAvailable) return

    this.driver.transaction(() => {
      const session = this.driver
        .prepare('SELECT title FROM sessions WHERE id = ?')
        .get(sessionId)
      if (!session) {
        this.remove(sessionId)
        return
      }

      const bodyRow = this.driver
        .prepare(
          `SELECT content
             FROM messages
            WHERE session_id = ?
            ORDER BY seq ASC`
        )
        .all(sessionId)
      let body = bodyRow.map((row) => asString(row.content)).join('\n')
      if (body.length > 65_536) body = body.slice(0, 65_536)

      this.remove(sessionId)
      this.driver
        .prepare('INSERT INTO session_search (session_id, title, body) VALUES (?, ?, ?)')
        .run(sessionId, asString(session.title), body)
    })
  }

  remove(sessionId: string): void {
    if (!this.ftsAvailable) return
    this.driver.prepare('DELETE FROM session_search WHERE session_id = ?').run(sessionId)
  }

  clearAll(): void {
    if (!this.ftsAvailable) return
    this.driver.prepare('DELETE FROM session_search').run()
  }

  search(query: string, limit = 50, offset = 0): SessionSummary[] {
    const trimmed = query.trim()
    if (trimmed.length === 0) return []

    const safeLimit = Math.max(1, Math.min(1000, Math.floor(limit)))
    const safeOffset = Math.max(0, Math.floor(offset))

    if (!this.ftsAvailable || charLength(trimmed) < 3) {
      return this.searchLike(trimmed, safeLimit, safeOffset)
    }

    try {
      const rows = this.driver
        .prepare(
          `SELECT ${SUMMARY_COLUMNS}
             FROM session_search f
             JOIN sessions s ON s.id = f.session_id
            WHERE session_search MATCH ?
            ORDER BY s.updated_at DESC, s.created_at DESC
            LIMIT ? OFFSET ?`
        )
        .all(quoteFtsQuery(trimmed), safeLimit, safeOffset)
      return rows.map(mapSummary)
    } catch {
      // A malformed/unsupported MATCH must never break the UI: LIKE is a
      // safe, slower fallback.
      return this.searchLike(trimmed, safeLimit, safeOffset)
    }
  }

  private searchLike(query: string, limit: number, offset: number): SessionSummary[] {
    const pattern = `%${escapeLikePattern(query)}%`
    const rows = this.driver
      .prepare(
        `SELECT ${SUMMARY_COLUMNS}
           FROM sessions s
          WHERE s.title LIKE ? ESCAPE '\\'
             OR EXISTS (
                  SELECT 1
                    FROM messages m
                   WHERE m.session_id = s.id
                     AND m.content LIKE ? ESCAPE '\\'
                )
          ORDER BY s.updated_at DESC, s.created_at DESC
          LIMIT ? OFFSET ?`
      )
      .all(pattern, pattern, limit, offset)
    return rows.map(mapSummary)
  }

  count(): number {
    if (!this.ftsAvailable) return 0
    const row = this.driver.prepare('SELECT COUNT(*) AS count FROM session_search').get()
    return asNumber(row?.count)
  }
}
