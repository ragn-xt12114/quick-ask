import type { DbDriver, DbRow } from '../driver'
import { DbError } from '../errors'
import { asBoolean, asNullableNumber, asNullableString, asNumber, asString } from './rows'

export interface ProviderHeaderName {
  name: string
  /** Values never live in SQLite; secret values go to the OS keyring. */
  secret: boolean
}

export interface ProviderProfile {
  id: string
  name: string
  baseUrl: string
  model: string
  keyRef: string | null
  headerNames: ProviderHeaderName[]
  proxyMode: string
  proxyUrl: string | null
  temperature: number | null
  maxTokens: number | null
  timeoutMs: number
  isDefault: boolean
  createdAt: number
  updatedAt: number
}

export interface ProviderProfileInput {
  id: string
  name: string
  baseUrl: string
  model?: string
  keyRef?: string | null
  headerNames?: ProviderHeaderName[]
  proxyMode?: string
  proxyUrl?: string | null
  temperature?: number | null
  maxTokens?: number | null
  timeoutMs?: number
  isDefault?: boolean
  createdAt?: number
  updatedAt?: number
}

export type ProviderProfilePatch = Partial<Omit<ProviderProfile, 'id' | 'createdAt'>>

const COLUMNS =
  'id, name, base_url, model, key_ref, header_names_json, proxy_mode, proxy_url, temperature, max_tokens, timeout_ms, is_default, created_at, updated_at'

function parseHeaderNames(raw: unknown): ProviderHeaderName[] {
  const text = asString(raw)
  if (text.length === 0) return []
  try {
    const parsed: unknown = JSON.parse(text)
    if (!Array.isArray(parsed)) return []
    return parsed
      .filter(
        (entry): entry is { name: unknown; secret?: unknown } =>
          typeof entry === 'object' && entry !== null && 'name' in entry
      )
      .map((entry) => ({
        name: String(entry.name),
        secret: entry.secret === true
      }))
      .filter((entry) => entry.name.length > 0)
  } catch {
    return []
  }
}

function mapProvider(row: DbRow): ProviderProfile {
  return {
    id: asString(row.id),
    name: asString(row.name),
    baseUrl: asString(row.base_url),
    model: asString(row.model),
    keyRef: asNullableString(row.key_ref),
    headerNames: parseHeaderNames(row.header_names_json),
    proxyMode: asString(row.proxy_mode),
    proxyUrl: asNullableString(row.proxy_url),
    temperature: asNullableNumber(row.temperature),
    maxTokens: asNullableNumber(row.max_tokens),
    timeoutMs: asNumber(row.timeout_ms),
    isDefault: asBoolean(row.is_default),
    createdAt: asNumber(row.created_at),
    updatedAt: asNumber(row.updated_at)
  }
}

export class ProvidersRepository {
  constructor(private readonly driver: DbDriver) {}

  create(input: ProviderProfileInput): ProviderProfile {
    const now = input.updatedAt ?? Date.now()
    const createdAt = input.createdAt ?? now
    this.driver
      .prepare(
        `INSERT INTO provider_profiles
           (id, name, base_url, model, key_ref, header_names_json, proxy_mode, proxy_url,
            temperature, max_tokens, timeout_ms, is_default, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        input.id,
        input.name,
        input.baseUrl,
        input.model ?? '',
        input.keyRef ?? null,
        JSON.stringify(input.headerNames ?? []),
        input.proxyMode ?? 'system',
        input.proxyUrl ?? null,
        input.temperature ?? null,
        input.maxTokens ?? null,
        input.timeoutMs ?? 30_000,
        input.isDefault ? 1 : 0,
        createdAt,
        now
      )
    const profile = this.get(input.id)
    if (!profile) throw new DbError('DB_WRITE', 'Provider insert did not persist')
    return profile
  }

  get(id: string): ProviderProfile | null {
    const row = this.driver
      .prepare(`SELECT ${COLUMNS} FROM provider_profiles WHERE id = ?`)
      .get(id)
    return row ? mapProvider(row) : null
  }

  list(): ProviderProfile[] {
    const rows = this.driver
      .prepare(
        `SELECT ${COLUMNS}
           FROM provider_profiles
          ORDER BY is_default DESC, updated_at DESC, name ASC`
      )
      .all()
    return rows.map(mapProvider)
  }

  update(id: string, patch: ProviderProfilePatch, now = Date.now()): ProviderProfile | null {
    const current = this.get(id)
    if (!current) return null
    const next: ProviderProfile = { ...current, ...patch, id, createdAt: current.createdAt, updatedAt: now }
    const result = this.driver
      .prepare(
        `UPDATE provider_profiles
            SET name = ?, base_url = ?, model = ?, key_ref = ?, header_names_json = ?,
                proxy_mode = ?, proxy_url = ?, temperature = ?, max_tokens = ?,
                timeout_ms = ?, is_default = ?, updated_at = ?
          WHERE id = ?`
      )
      .run(
        next.name,
        next.baseUrl,
        next.model,
        next.keyRef,
        JSON.stringify(next.headerNames),
        next.proxyMode,
        next.proxyUrl,
        next.temperature,
        next.maxTokens,
        next.timeoutMs,
        next.isDefault ? 1 : 0,
        now,
        id
      )
    if (result.changes === 0) return null
    return this.get(id)
  }

  setDefault(id: string, now = Date.now()): boolean {
    return this.driver.transaction(() => {
      if (!this.get(id)) return false
      this.driver.prepare('UPDATE provider_profiles SET is_default = 0, updated_at = ?').run(now)
      this.driver
        .prepare('UPDATE provider_profiles SET is_default = 1, updated_at = ? WHERE id = ?')
        .run(now, id)
      return true
    })
  }

  delete(id: string): boolean {
    const result = this.driver.prepare('DELETE FROM provider_profiles WHERE id = ?').run(id)
    return result.changes > 0
  }

  count(): number {
    const row = this.driver.prepare('SELECT COUNT(*) AS count FROM provider_profiles').get()
    return asNumber(row?.count)
  }
}
