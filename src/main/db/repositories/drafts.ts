import type { DbDriver } from '../driver'
import { asString } from './rows'

export class DraftsRepository {
  constructor(private readonly driver: DbDriver) {}

  get(id: string): string {
    const row = this.driver.prepare('SELECT text FROM drafts WHERE id = ?').get(id)
    return row ? asString(row.text) : ''
  }

  set(id: string, text: string, now: number): boolean {
    this.driver
      .prepare(
        `INSERT INTO drafts (id, session_id, text, updated_at)
         VALUES (?, (SELECT id FROM sessions WHERE id = ?), ?, ?)
         ON CONFLICT(id) DO UPDATE SET
           session_id = excluded.session_id,
           text = excluded.text,
           updated_at = excluded.updated_at`
      )
      .run(id, id === 'new' ? null : id, text, now)
    return true
  }

  delete(id: string): boolean {
    const result = this.driver.prepare('DELETE FROM drafts WHERE id = ?').run(id)
    return result.changes > 0
  }
}
