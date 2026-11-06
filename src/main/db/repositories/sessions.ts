import type { Session, SessionSummary } from '../../../shared/channels'
import type { DbDriver, DbRow } from '../driver'
import { DbError } from '../errors'
import { asBoolean, asNullableNumber, asNullableString, asNumber, asString } from './rows'

export interface NewSession {
  id: string
  title: string
  titleAuto: boolean
  createdAt: number
  updatedAt: number
  lastMessageAt?: number | null
  model?: string | null
  systemPrompt?: string | null
}

function mapSummary(row: DbRow): SessionSummary {
  return {
    id: asString(row.id),
    title: asString(row.title),
    updatedAt: asNumber(row.updated_at),
    lastMessageAt: asNullableNumber(row.last_message_at),
    model: asNullableString(row.model)
  }
}

function mapSession(row: DbRow): Session {
  return {
    ...mapSummary(row),
    titleAuto: asBoolean(row.title_auto),
    createdAt: asNumber(row.created_at),
    systemPrompt: asNullableString(row.system_prompt)
  }
}

const SUMMARY_COLUMNS = 'id, title, updated_at, last_message_at, model'
const SESSION_COLUMNS = `${SUMMARY_COLUMNS}, title_auto, created_at, system_prompt`

export class SessionsRepository {
  constructor(private readonly driver: DbDriver) {}

  create(input: NewSession): Session {
    this.driver
      .prepare(
        `INSERT INTO sessions
           (id, title, title_auto, created_at, updated_at, last_message_at, model, system_prompt)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        input.id,
        input.title,
        input.titleAuto ? 1 : 0,
        input.createdAt,
        input.updatedAt,
        input.lastMessageAt ?? null,
        input.model ?? null,
        input.systemPrompt ?? null
      )
    const session = this.get(input.id)
    if (!session) throw new DbError('DB_WRITE', 'Session insert did not persist')
    return session
  }

  get(id: string): Session | null {
    const row = this.driver
      .prepare(`SELECT ${SESSION_COLUMNS} FROM sessions WHERE id = ?`)
      .get(id)
    return row ? mapSession(row) : null
  }

  exists(id: string): boolean {
    const row = this.driver.prepare('SELECT 1 AS one FROM sessions WHERE id = ?').get(id)
    return row !== undefined
  }

  titleOf(id: string): string | null {
    const row = this.driver.prepare('SELECT title FROM sessions WHERE id = ?').get(id)
    return row ? asString(row.title) : null
  }

  list(limit = 50, offset = 0): SessionSummary[] {
    const rows = this.driver
      .prepare(
        `SELECT ${SUMMARY_COLUMNS}
           FROM sessions
          ORDER BY updated_at DESC, created_at DESC
          LIMIT ? OFFSET ?`
      )
      .all(limit, offset)
    return rows.map(mapSummary)
  }

  /** Update activity after a message is inserted/finalized. */
  touch(
    id: string,
    now: number,
    options: { lastMessageAt?: number | null; model?: string | null } = {}
  ): boolean {
    const result = this.driver
      .prepare(
        `UPDATE sessions
            SET updated_at = ?,
                last_message_at = COALESCE(?, last_message_at),
                model = COALESCE(?, model)
          WHERE id = ?`
      )
      .run(now, options.lastMessageAt ?? null, options.model ?? null, id)
    return result.changes > 0
  }

  rename(id: string, title: string, now: number): boolean {
    const result = this.driver
      .prepare('UPDATE sessions SET title = ?, title_auto = 0, updated_at = ? WHERE id = ?')
      .run(title, now, id)
    return result.changes > 0
  }

  delete(id: string): boolean {
    const result = this.driver.prepare('DELETE FROM sessions WHERE id = ?').run(id)
    return result.changes > 0
  }

  count(): number {
    const row = this.driver.prepare('SELECT COUNT(*) AS count FROM sessions').get()
    return asNumber(row?.count)
  }

  listIdsOlderThan(cutoff: number): string[] {
    const rows = this.driver
      .prepare('SELECT id FROM sessions WHERE updated_at < ?')
      .all(cutoff)
    const ids: string[] = []
    for (const row of rows) {
      if (typeof row.id === 'string' && row.id.length > 0) ids.push(row.id)
    }
    return ids
  }
}
