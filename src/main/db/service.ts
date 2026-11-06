/**
 * DbService — the only write surface used by the chat/history orchestrators.
 *
 * All methods are synchronous (node:sqlite is synchronous); stream content is
 * written in caller-batched chunks, never per token. Every multi-row operation
 * uses a single BEGIN IMMEDIATE transaction so a crash cannot leave half a
 * send or a half-finished stream.
 */

import { uuidv7 } from '../../shared/uuidv7'
import type { ChatMessage, JsonValue, Session, SessionSummary } from '../../shared/channels'
import type { ChatImage } from '../../shared/channels'
import type { DbDriver } from './driver'
import { DbError } from './errors'
import type { DatabaseHandle, OpenDatabaseOptions } from './open'
import { openDatabase } from './open'
import { DraftsRepository } from './repositories/drafts'
import { MessagesRepository } from './repositories/messages'
import { ProvidersRepository, type ProviderProfile, type ProviderProfileInput, type ProviderProfilePatch } from './repositories/providers'
import { SearchRepository } from './repositories/search'
import { SessionsRepository } from './repositories/sessions'
import { SettingsRepository } from './repositories/settings'

export interface BeginSendInput {
  sessionId?: string | null
  text: string
  /** Clipboard images attached to this user turn. */
  images?: ChatImage[]
  model?: string | null
}

export interface BeginSendResult {
  sessionId: string
  userMessageId: string
  assistantMessageId: string
  /** Sequence of the inserted user message (assistant is seq + 1). */
  seq: number
}

export interface FinishStreamOptions {
  errorCode?: string | null
  errorDetail?: string | null
  usageJson?: string | null
  model?: string | null
}

export interface ListSessionsOptions {
  query?: string
  limit?: number
  offset?: number
}

export interface DbServiceOptions {
  /** Injectable clock (tests). */
  now?: () => number
}

/** Strip newlines/markdown and keep the first 20 Unicode code points. */
export function autoTitle(text: string): string {
  const stripped = text
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/[`*_~>#]+/g, '')
    .replace(/\s+/g, ' ')
    .trim()
  const title = Array.from(stripped).slice(0, 20).join('').trim()
  return title.length > 0 ? title : '新会话'
}

/** error_detail is capped before it ever reaches SQLite (UI redaction is Task 11/17). */
export function truncateErrorDetail(detail: string | null | undefined): string | null {
  if (detail === null || detail === undefined) return null
  const chars = Array.from(detail)
  if (chars.length <= 300) return detail
  return chars.slice(0, 300).join('')
}

export class DbService {
  readonly driver: DbDriver
  readonly sessions: SessionsRepository
  readonly messages: MessagesRepository
  readonly drafts: DraftsRepository
  readonly providers: ProvidersRepository
  readonly settings: SettingsRepository
  readonly search: SearchRepository

  /** Number of streaming rows repaired by the most recent recoverStreaming(). */
  lastRecoveryCount = 0

  private readonly now: () => number

  constructor(
    readonly handle: DatabaseHandle,
    options: DbServiceOptions = {}
  ) {
    this.driver = handle.driver
    this.now = options.now ?? Date.now
    this.sessions = new SessionsRepository(this.driver)
    this.messages = new MessagesRepository(this.driver)
    this.drafts = new DraftsRepository(this.driver)
    this.providers = new ProvidersRepository(this.driver)
    this.settings = new SettingsRepository(this.driver)
    this.search = new SearchRepository(this.driver, handle.ftsAvailable)
  }

  // -------------------------------------------------------------------------
  // Send / stream lifecycle (NFR-11)
  // -------------------------------------------------------------------------

  beginSend(input: BeginSendInput, now?: number): BeginSendResult {
    const at = now ?? this.now()
    const text = input.text
    if (typeof text !== 'string' || text.trim().length === 0) {
      throw new DbError('DB_WRITE', 'Cannot persist an empty user message')
    }

    return this.driver.transaction(() => {
      let sessionId = input.sessionId ?? null

      if (sessionId === null) {
        sessionId = uuidv7(at)
        this.sessions.create({
          id: sessionId,
          title: autoTitle(text),
          titleAuto: true,
          createdAt: at,
          updatedAt: at,
          lastMessageAt: at,
          model: input.model ?? null
        })
      } else {
        const session = this.sessions.get(sessionId)
        if (!session) {
          throw new DbError('DB_NOT_FOUND', `Session not found: ${sessionId}`)
        }
      }

      const seq = this.messages.nextSeq(sessionId)
      const userMessageId = uuidv7(at)
      const assistantMessageId = uuidv7(at)

      this.messages.insert({
        id: userMessageId,
        sessionId,
        seq,
        role: 'user',
        content: text,
        images: input.images,
        status: 'complete',
        createdAt: at,
        updatedAt: at
      })

      this.messages.insert({
        id: assistantMessageId,
        sessionId,
        seq: seq + 1,
        role: 'assistant',
        content: '',
        status: 'streaming',
        createdAt: at,
        updatedAt: at,
        model: input.model ?? null
      })

      this.sessions.touch(sessionId, at, {
        lastMessageAt: at,
        model: input.model ?? null
      })

      return { sessionId, userMessageId, assistantMessageId, seq }
    })
  }

  /**
   * Replace the assistant content with the full accumulated text. Callers
   * batch deltas (250ms / 1KB); this method performs exactly one UPDATE.
   */
  appendStream(messageId: string, fullContent: string, now?: number): boolean {
    return this.messages.appendContent(messageId, fullContent, now ?? this.now())
  }

  /** Retry/regenerate reset: same assistant id/seq, cleared content/error. */
  resetAssistantForStream(messageId: string, model?: string | null, now?: number): boolean {
    return this.messages.resetForStream(messageId, now ?? this.now(), model)
  }

  finishStream(
    messageId: string,
    status: 'complete' | 'stopped' | 'interrupted' | 'error',
    options: FinishStreamOptions = {},
    now?: number
  ): boolean {
    const at = now ?? this.now()

    return this.driver.transaction(() => {
      const sessionId = this.messages.sessionIdOf(messageId)
      if (sessionId === null) {
        throw new DbError('DB_NOT_FOUND', `Message not found: ${messageId}`)
      }

      const updated = this.messages.finish(messageId, status, at, {
        errorCode: options.errorCode ?? null,
        errorDetail: truncateErrorDetail(options.errorDetail),
        usageJson: options.usageJson ?? null,
        model: options.model ?? null
      })
      if (!updated) {
        throw new DbError('DB_NOT_FOUND', `Message not found: ${messageId}`)
      }

      this.sessions.touch(sessionId, at, {
        lastMessageAt: at,
        model: options.model ?? null
      })
      this.search.rebuild(sessionId)
      return true
    })
  }

  /** Startup recovery: no message may remain `streaming` after a crash. */
  recoverStreaming(): number {
    return this.driver.transaction(() => {
      const { count, sessionIds } = this.messages.recoverStreaming()
      for (const sessionId of sessionIds) {
        this.search.rebuild(sessionId)
      }
      this.lastRecoveryCount = count
      return count
    })
  }

  // -------------------------------------------------------------------------
  // Sessions / messages
  // -------------------------------------------------------------------------

  listSessions(options: ListSessionsOptions = {}): SessionSummary[] {
    const limit = Math.max(1, Math.min(1000, Math.floor(options.limit ?? 50)))
    const offset = Math.max(0, Math.floor(options.offset ?? 0))
    const query = options.query?.trim() ?? ''
    if (query.length > 0) {
      return this.search.search(query, limit, offset)
    }
    return this.sessions.list(limit, offset)
  }

  searchSessions(query: string, limit = 50): SessionSummary[] {
    return this.search.search(query, limit)
  }

  getSession(id: string): Session | null {
    return this.sessions.get(id)
  }

  getMessages(sessionId: string): ChatMessage[] {
    return this.messages.listBySession(sessionId)
  }

  renameSession(id: string, title: string, now?: number): boolean {
    return this.driver.transaction(() => {
      const renamed = this.sessions.rename(id, title, now ?? this.now())
      if (!renamed) return false
      this.search.rebuild(id)
      return true
    })
  }

  deleteSession(id: string): boolean {
    return this.driver.transaction(() => {
      if (!this.sessions.exists(id)) return false
      this.search.remove(id)
      return this.sessions.delete(id)
    })
  }

  /** Clear history: one transaction removes sessions, messages, drafts and FTS rows. */
  deleteAllSessions(): number {
    return this.driver.transaction(() => {
      const count = this.sessions.count()
      this.search.clearAll()
      this.driver.prepare('DELETE FROM sessions').run()
      return count
    })
  }

  // -------------------------------------------------------------------------
  // Drafts / settings / providers
  // -------------------------------------------------------------------------

  getDraft(id: string): string {
    return this.drafts.get(id)
  }

  setDraft(id: string, text: string, now?: number): boolean {
    return this.drafts.set(id, text, now ?? this.now())
  }

  settingsGetAll(): Record<string, JsonValue> {
    return this.settings.getAll()
  }

  settingsGet(key: string): JsonValue | undefined {
    return this.settings.get(key)
  }

  settingsSet(key: string, value: JsonValue, now?: number): boolean {
    this.settings.set(key, value, now ?? this.now())
    return true
  }

  settingsDelete(key: string): boolean {
    return this.settings.delete(key)
  }

  createProviderProfile(input: ProviderProfileInput): ProviderProfile {
    return this.providers.create(input)
  }

  getProviderProfile(id: string): ProviderProfile | null {
    return this.providers.get(id)
  }

  listProviderProfiles(): ProviderProfile[] {
    return this.providers.list()
  }

  updateProviderProfile(
    id: string,
    patch: ProviderProfilePatch,
    now?: number
  ): ProviderProfile | null {
    return this.providers.update(id, patch, now ?? this.now())
  }

  deleteProviderProfile(id: string): boolean {
    return this.providers.delete(id)
  }

  setDefaultProviderProfile(id: string, now?: number): boolean {
    return this.providers.setDefault(id, now ?? this.now())
  }

  // -------------------------------------------------------------------------
  // Diagnostics (tests / tools)
  // -------------------------------------------------------------------------

  counts(): {
    sessions: number
    messages: number
    streaming: number
    interrupted: number
    ftsRows: number
  } {
    return {
      sessions: this.sessions.count(),
      messages: this.messages.count(),
      streaming: this.messages.countByStatus('streaming'),
      interrupted: this.messages.countByStatus('interrupted'),
      ftsRows: this.search.count()
    }
  }

  close(): void {
    this.handle.close()
  }

  checkpoint(): { ok: boolean; busy: number; log: number; checkpointed: number } {
    const row = this.driver.prepare('PRAGMA wal_checkpoint(TRUNCATE)').get()
    const busy = Number(row?.['busy'] ?? -1)
    const log = Number(row?.['log'] ?? -1)
    const checkpointed = Number(row?.['checkpointed'] ?? -1)
    return {
      ok: busy === 0,
      busy: Number.isFinite(busy) ? busy : -1,
      log: Number.isFinite(log) ? log : -1,
      checkpointed: Number.isFinite(checkpointed) ? checkpointed : -1
    }
  }
}

export interface OpenedDbService extends DbService {
  /** Always defined on services created through openDbService(). */
  readonly handle: DatabaseHandle
}

/**
 * Production entry point: open, migrate, then repair any stream rows left by
 * a previous crash. `recover:false` is useful for crash-recovery tests.
 */
export function openDbService(
  options: OpenDatabaseOptions & DbServiceOptions & { recover?: boolean } = {}
): DbService {
  const handle = openDatabase(options)
  const service = new DbService(handle, options)
  if (options.recover !== false) {
    service.recoverStreaming()
  }
  return service
}
