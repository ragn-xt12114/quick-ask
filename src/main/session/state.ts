import {
  IPC,
  type ChatImage,
  type ChatMessage,
  type MainWindowMode,
  type SessionsNewResult,
  type SessionsOpenResult,
  type SessionsStateResult,
  type UiSessionEvent
} from '../../shared/channels'
import { IpcError } from '../../shared/ipc'
import type { DbService } from '../db/service'

export interface SessionChatRequest {
  requestId: string
  sessionId: string
}

export interface SessionChat {
  send(input: { sessionId: string | null; text: string; images?: readonly ChatImage[] }): Promise<{
    requestId: string
    sessionId: string
  }>
  stop(requestId: string): Promise<{ stopped: boolean }>
  getActive(): SessionChatRequest | null
  setActiveListener?(
    listener: (active: SessionChatRequest | null) => void
  ): () => void
}

export interface SessionStateOptions {
  db: DbService
  chat: SessionChat
  getWindowMode: () => MainWindowMode
  setWindowMode: (mode: MainWindowMode) => Promise<unknown>
  emit: (channel: typeof IPC.EVENT_UI_SESSION, payload: UiSessionEvent) => void
  logger?: (line: string, fields?: Record<string, string | number | boolean | null>) => void
}

export interface SessionSnapshot {
  currentSessionId: string | null
  mode: MainWindowMode
  activeRequestId: string | null
}

function isSessionMode(mode: MainWindowMode): boolean {
  return mode === 'S0' || mode === 'S1' || mode === 'S2' || mode === 'S3'
}

/**
 * Main-process session state machine (plan C.5/D.1, F-04/F-05.6/F-06).
 *
 * The main process owns the current session and the active request. Every
 * mutation is serialized: opening/new/deleting always aborts and fully
 * finalizes the in-flight stream before rows are loaded, cleared or removed.
 * The renderer receives `ui:session` and hydrates through IPC; it never
 * invents a session id.
 */
export class SessionState {
  private currentSessionId: string | null
  private activeRequestId: string | null = null
  private tail: Promise<unknown> = Promise.resolve()

  private readonly db: DbService
  private readonly chat: SessionChat
  private readonly getWindowMode: SessionStateOptions['getWindowMode']
  private readonly setWindowMode: SessionStateOptions['setWindowMode']
  private readonly emitEvent: SessionStateOptions['emit']
  private readonly log: NonNullable<SessionStateOptions['logger']>
  private detachActiveListener: (() => void) | null = null

  constructor(options: SessionStateOptions) {
    this.db = options.db
    this.chat = options.chat
    this.getWindowMode = options.getWindowMode
    this.setWindowMode = options.setWindowMode
    this.emitEvent = options.emit
    this.log = options.logger ?? (() => undefined)

    this.currentSessionId = this.mostRecentSessionId()
    this.detachActiveListener = this.chat.setActiveListener?.((active) => {
      this.activeRequestId = active?.requestId ?? null
      if (active && this.currentSessionId === null) {
        this.currentSessionId = active.sessionId
      }
      this.emitSession()
    }) ?? null
  }

  /** Startup fallback M1: newest session is current, but the UI stays S1. */
  private mostRecentSessionId(): string | null {
    try {
      return this.db.listSessions({ limit: 1 })[0]?.id ?? null
    } catch (error) {
      this.log('session_recent_lookup_failed', {
        detail: error instanceof Error ? error.name : 'unknown'
      })
      return null
    }
  }

  private enqueue<T>(fn: () => Promise<T> | T): Promise<T> {
    const run = this.tail.then(fn, fn)
    this.tail = run.then(
      () => undefined,
      () => undefined
    )
    return run
  }

  private async abortActive(): Promise<void> {
    const requestId = this.activeRequestId ?? this.chat.getActive()?.requestId ?? null
    if (requestId !== null) {
      this.log('session_abort_active', { requestId })
      try {
        await this.chat.stop(requestId)
      } finally {
        this.activeRequestId = null
      }
    } else {
      this.activeRequestId = null
    }
  }

  private emitSession(): void {
    const payload: UiSessionEvent = {
      currentSessionId: this.currentSessionId,
      mode: this.getWindowMode(),
      activeRequestId: this.activeRequestId
    }
    try {
      this.emitEvent(IPC.EVENT_UI_SESSION, payload)
    } catch (error) {
      this.log('session_emit_failed', {
        detail: error instanceof Error ? error.name : 'unknown'
      })
    }
  }

  getCurrentSessionId(): string | null {
    return this.currentSessionId
  }

  getMode(): MainWindowMode {
    return this.getWindowMode()
  }

  getActiveRequestId(): string | null {
    return this.activeRequestId
  }

  bootstrap(): { currentSessionId: string | null; mode: MainWindowMode } {
    return { currentSessionId: this.currentSessionId, mode: this.getWindowMode() }
  }

  async getState(): Promise<SessionsStateResult> {
    return this.enqueue(() => {
      const messages: ChatMessage[] =
        this.currentSessionId === null ? [] : this.db.getMessages(this.currentSessionId)
      return {
        currentSessionId: this.currentSessionId,
        mode: this.getWindowMode(),
        activeRequestId: this.activeRequestId,
        messages
      }
    })
  }

  async open(id: string): Promise<SessionsOpenResult> {
    return this.enqueue(async () => {
      await this.abortActive()
      const session = this.db.getSession(id)
      if (!session) throw new IpcError('NOT_FOUND', '会话不存在')
      const messages = this.db.getMessages(id)
      this.currentSessionId = id
      this.activeRequestId = null
      await this.setWindowMode('S2')
      this.emitSession()
      return { session, messages }
    })
  }

  async new(): Promise<SessionsNewResult> {
    return this.enqueue(async () => {
      await this.abortActive()
      this.currentSessionId = null
      this.activeRequestId = null
      await this.setWindowMode('S1')
      this.emitSession()
      return { currentSessionId: null, mode: 'S1' }
    })
  }

  async deleteCurrent(): Promise<boolean> {
    return this.enqueue(async () => {
      await this.abortActive()
      const current = this.currentSessionId
      const deleted = current === null ? false : this.db.deleteSession(current)
      this.currentSessionId = null
      this.activeRequestId = null
      await this.setWindowMode('S1')
      this.emitSession()
      return deleted
    })
  }

  async clearAll(): Promise<number> {
    return this.enqueue(async () => {
      await this.abortActive()
      const cleared = this.db.deleteAllSessions()
      this.currentSessionId = null
      this.activeRequestId = null
      await this.setWindowMode('S1')
      this.emitSession()
      return cleared
    })
  }

  async setMode(mode: MainWindowMode): Promise<MainWindowMode> {
    if (!isSessionMode(mode)) {
      throw new IpcError('INVALID_ARGUMENT', '设置窗口不是会话状态')
    }
    return this.enqueue(async () => {
      await this.setWindowMode(mode)
      this.emitSession()
      return mode
    })
  }

  /** Uses the main current id even if the renderer sends a stale one. */
  async send(text: string, images?: readonly ChatImage[]): Promise<{ requestId: string; sessionId: string }> {
    return this.enqueue(async () => {
      await this.setWindowMode('S2')
      const started = await this.chat.send({
        sessionId: this.currentSessionId,
        text,
        ...(images && images.length > 0 ? { images } : {})
      })
      this.currentSessionId = started.sessionId
      this.activeRequestId = started.requestId
      this.emitSession()
      return started
    })
  }

  async dispose(): Promise<void> {
    this.detachActiveListener?.()
    this.detachActiveListener = null
    await this.tail
  }
}
