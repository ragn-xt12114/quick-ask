import type { ChatImage, ChatMessage, MessageRole, MessageStatus } from '../../../shared/channels'
import type { DbDriver, DbRow } from '../driver'
import { DbError } from '../errors'
import { asNullableString, asNumber, asString } from './rows'

export interface NewMessage {
  id: string
  sessionId: string
  seq: number
  role: MessageRole
  content: string
  /** User-message attachments; omitted for assistant rows. */
  images?: ChatImage[]
  status: MessageStatus
  createdAt: number
  updatedAt: number
  model?: string | null
  errorCode?: string | null
  errorDetail?: string | null
  usageJson?: string | null
}

const COLUMNS =
  'id, session_id, seq, role, content, images_json, status, error_code, error_detail, model, usage_json, created_at, updated_at'

/**
 * Attachment payloads are written by the renderer after downscaling, so the
 * column should always hold a JSON array. A corrupt/hand-edited value must not
 * take the whole message list down: degrade to "no images" instead.
 */
export function parseImagesJson(raw: unknown): ChatImage[] {
  const text = asNullableString(raw)
  if (text === null || text.length === 0) return []
  try {
    const parsed: unknown = JSON.parse(text)
    if (!Array.isArray(parsed)) return []
    const images: ChatImage[] = []
    for (const entry of parsed) {
      if (typeof entry !== 'object' || entry === null) continue
      const candidate = entry as Record<string, unknown>
      if (
        typeof candidate.dataUrl !== 'string' ||
        candidate.dataUrl.length === 0 ||
        typeof candidate.mime !== 'string' ||
        typeof candidate.width !== 'number' ||
        typeof candidate.height !== 'number'
      ) {
        continue
      }
      images.push({
        dataUrl: candidate.dataUrl,
        mime: candidate.mime as ChatImage['mime'],
        width: candidate.width,
        height: candidate.height,
        bytes: typeof candidate.bytes === 'number' ? candidate.bytes : 0
      })
    }
    return images
  } catch {
    return []
  }
}

export function serializeImagesJson(images: readonly ChatImage[] | undefined): string {
  return images === undefined || images.length === 0 ? '[]' : JSON.stringify(images)
}

function mapMessage(row: DbRow): ChatMessage {
  return {
    id: asString(row.id),
    sessionId: asString(row.session_id),
    seq: asNumber(row.seq),
    role: asString(row.role) as MessageRole,
    content: asString(row.content),
    images: parseImagesJson(row.images_json),
    status: asString(row.status) as MessageStatus,
    errorCode: asNullableString(row.error_code),
    errorDetail: asNullableString(row.error_detail),
    model: asNullableString(row.model),
    createdAt: asNumber(row.created_at),
    updatedAt: asNumber(row.updated_at)
  }
}

export class MessagesRepository {
  constructor(private readonly driver: DbDriver) {}

  insert(message: NewMessage): ChatMessage {
    this.driver
      .prepare(
        `INSERT INTO messages
           (id, session_id, seq, role, content, images_json, status, error_code, error_detail, model, usage_json, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        message.id,
        message.sessionId,
        message.seq,
        message.role,
        message.content,
        serializeImagesJson(message.images),
        message.status,
        message.errorCode ?? null,
        message.errorDetail ?? null,
        message.model ?? null,
        message.usageJson ?? null,
        message.createdAt,
        message.updatedAt
      )
    const stored = this.get(message.id)
    if (!stored) throw new DbError('DB_WRITE', 'Message insert did not persist')
    return stored
  }

  get(id: string): ChatMessage | null {
    const row = this.driver.prepare(`SELECT ${COLUMNS} FROM messages WHERE id = ?`).get(id)
    return row ? mapMessage(row) : null
  }

  sessionIdOf(id: string): string | null {
    const row = this.driver.prepare('SELECT session_id FROM messages WHERE id = ?').get(id)
    return row ? asString(row.session_id) : null
  }

  listBySession(sessionId: string): ChatMessage[] {
    const rows = this.driver
      .prepare(`SELECT ${COLUMNS} FROM messages WHERE session_id = ? ORDER BY seq ASC`)
      .all(sessionId)
    return rows.map(mapMessage)
  }

  nextSeq(sessionId: string): number {
    const row = this.driver
      .prepare('SELECT COALESCE(MAX(seq), -1) + 1 AS next_seq FROM messages WHERE session_id = ?')
      .get(sessionId)
    return asNumber(row?.next_seq)
  }

  appendContent(id: string, content: string, now: number): boolean {
    const result = this.driver
      .prepare('UPDATE messages SET content = ?, updated_at = ? WHERE id = ?')
      .run(content, now, id)
    return result.changes > 0
  }

  /**
   * Retry/regenerate reuse the existing assistant row: clear content and
   * error state, set it back to streaming and keep id/seq unchanged.
   */
  resetForStream(id: string, now: number, model?: string | null): boolean {
    const result = this.driver
      .prepare(
        `UPDATE messages
            SET content = '',
                status = 'streaming',
                error_code = NULL,
                error_detail = NULL,
                usage_json = NULL,
                model = COALESCE(?, model),
                updated_at = ?
          WHERE id = ? AND role = 'assistant'`
      )
      .run(model ?? null, now, id)
    return result.changes > 0
  }

  finish(
    id: string,
    status: Exclude<MessageStatus, 'streaming'>,
    now: number,
    options: {
      errorCode?: string | null
      errorDetail?: string | null
      usageJson?: string | null
      model?: string | null
    } = {}
  ): boolean {
    const result = this.driver
      .prepare(
        `UPDATE messages
            SET status = ?,
                error_code = ?,
                error_detail = ?,
                usage_json = ?,
                model = COALESCE(?, model),
                updated_at = ?
          WHERE id = ?`
      )
      .run(
        status,
        options.errorCode ?? null,
        options.errorDetail ?? null,
        options.usageJson ?? null,
        options.model ?? null,
        now,
        id
      )
    return result.changes > 0
  }

  /**
   * Crash recovery: no row may stay in `streaming` forever. Returns the number
   * of recovered rows plus their session ids so FTS can be rebuilt.
   */
  recoverStreaming(): { count: number; sessionIds: string[] } {
    const sessionRows = this.driver
      .prepare("SELECT DISTINCT session_id FROM messages WHERE status = 'streaming'")
      .all()
    const sessionIds = sessionRows.map((row) => asString(row.session_id))
    const result = this.driver
      .prepare("UPDATE messages SET status = 'interrupted' WHERE status = 'streaming'")
      .run()
    return { count: result.changes, sessionIds }
  }

  countByStatus(status: MessageStatus): number {
    const row = this.driver
      .prepare('SELECT COUNT(*) AS count FROM messages WHERE status = ?')
      .get(status)
    return asNumber(row?.count)
  }

  count(): number {
    const row = this.driver.prepare('SELECT COUNT(*) AS count FROM messages').get()
    return asNumber(row?.count)
  }

  /** Body for the FTS row: all message contents in seq order, capped. */
  bodyForSearch(sessionId: string, maxChars = 65_536): string {
    const rows = this.driver
      .prepare('SELECT content FROM messages WHERE session_id = ? ORDER BY seq ASC')
      .all(sessionId)
    const parts: string[] = []
    let length = 0
    for (const row of rows) {
      const content = asString(row.content)
      if (content.length === 0) continue
      if (length + content.length + 1 > maxChars) {
        parts.push(content.slice(0, Math.max(0, maxChars - length)))
        break
      }
      parts.push(content)
      length += content.length + 1
    }
    return parts.join('\n').slice(0, maxChars)
  }
}
