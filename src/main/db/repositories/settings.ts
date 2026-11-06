import type { JsonValue } from '../../../shared/channels'
import type { DbDriver } from '../driver'
import { asString } from './rows'

export class SettingsRepository {
  constructor(private readonly driver: DbDriver) {}

  getAll(): Record<string, JsonValue> {
    const rows = this.driver.prepare('SELECT key, value_json FROM settings').all()
    const result: Record<string, JsonValue> = {}
    for (const row of rows) {
      const key = asString(row.key)
      try {
        result[key] = JSON.parse(asString(row.value_json)) as JsonValue
      } catch {
        // Ignore unreadable rows rather than breaking the whole settings view.
      }
    }
    return result
  }

  get(key: string): JsonValue | undefined {
    const row = this.driver.prepare('SELECT value_json FROM settings WHERE key = ?').get(key)
    if (!row) return undefined
    try {
      return JSON.parse(asString(row.value_json)) as JsonValue
    } catch {
      return undefined
    }
  }

  set(key: string, value: JsonValue, now = Date.now()): void {
    this.driver
      .prepare(
        `INSERT INTO settings (key, value_json, updated_at)
         VALUES (?, ?, ?)
         ON CONFLICT(key) DO UPDATE SET
           value_json = excluded.value_json,
           updated_at = excluded.updated_at`
      )
      .run(key, JSON.stringify(value), now)
  }

  delete(key: string): boolean {
    const result = this.driver.prepare('DELETE FROM settings WHERE key = ?').run(key)
    return result.changes > 0
  }
}
