import { describe, expect, it } from 'vitest'
import type {
  ChatMessage,
  MainWindowMode,
  Session,
  SessionSummary,
  UiSessionEvent
} from '../../src/shared/channels'
import type { DbService } from '../../src/main/db/service'
import {
  SessionState,
  type SessionChat,
  type SessionChatRequest
} from '../../src/main/session/state'

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

function summary(id: string, updatedAt = 1): SessionSummary {
  return { id, title: id, updatedAt, lastMessageAt: updatedAt, model: null }
}

function sessionOf(id: string, updatedAt = 1): Session {
  return {
    ...summary(id, updatedAt),
    titleAuto: true,
    createdAt: 1,
    systemPrompt: null
  }
}

function messageOf(sessionId: string, seq: number, content: string): ChatMessage {
  return {
    id: `${sessionId}-m${seq}`,
    sessionId,
    seq,
    role: seq % 2 === 0 ? 'user' : 'assistant',
    content,
    status: 'complete',
    errorCode: null,
    errorDetail: null,
    model: null,
    createdAt: 1,
    updatedAt: 1
  }
}

class FakeDb {
  readonly sessions = new Map<string, Session>()
  readonly messages = new Map<string, ChatMessage[]>()
  readonly calls: string[] = []
  deleted: string[] = []

  constructor(recent: string[] = []) {
    recent.forEach((id, index) => this.sessions.set(id, sessionOf(id, index + 1)))
  }

  addMessages(sessionId: string, messages: ChatMessage[]): void {
    this.messages.set(sessionId, messages)
  }

  listSessions(options: { limit?: number } = {}): SessionSummary[] {
    this.calls.push('list')
    const all = [...this.sessions.values()].sort((a, b) => b.updatedAt - a.updatedAt)
    return all.slice(0, options.limit ?? all.length).map((session) => ({ ...session }))
  }

  getSession(id: string): Session | null {
    this.calls.push(`session:${id}`)
    return this.sessions.get(id) ?? null
  }

  getMessages(id: string): ChatMessage[] {
    this.calls.push(`messages:${id}`)
    return [...(this.messages.get(id) ?? [])]
  }

  deleteSession(id: string): boolean {
    this.calls.push(`delete:${id}`)
    this.deleted.push(id)
    this.messages.delete(id)
    return this.sessions.delete(id)
  }
}

class FakeChat implements SessionChat {
  readonly requests: Array<{ sessionId: string | null; text: string }> = []
  readonly stopped: string[] = []
  active: SessionChatRequest | null = null
  private listener: ((active: SessionChatRequest | null) => void) | null = null
  private counter = 0

  constructor(private readonly db: FakeDb) {}

  async send(input: { sessionId: string | null; text: string }): Promise<{
    requestId: string
    sessionId: string
  }> {
    this.requests.push(input)
    this.counter += 1
    const sessionId = input.sessionId ?? `created-${this.counter}`
    if (!this.db.sessions.has(sessionId)) {
      this.db.sessions.set(sessionId, sessionOf(sessionId, Date.now()))
    }
    const request = { requestId: `req-${this.counter}`, sessionId }
    this.active = request
    this.listener?.(this.active)
    return request
  }

  async stop(requestId: string): Promise<{ stopped: boolean }> {
    this.stopped.push(requestId)
    this.db.calls.push(`stop:${requestId}`)
    await sleep(5)
    this.active = null
    this.listener?.(null)
    return { stopped: true }
  }

  getActive(): SessionChatRequest | null {
    return this.active
  }

  setActiveListener(listener: (active: SessionChatRequest | null) => void): () => void {
    this.listener = listener
    return () => {
      if (this.listener === listener) this.listener = null
    }
  }

  emitEnd(): void {
    this.active = null
    this.listener?.(null)
  }
}

interface Harness {
  db: FakeDb
  chat: FakeChat
  state: SessionState
  events: UiSessionEvent[]
  windowMode(): MainWindowMode
}

function harness(recent: string[] = []): Harness {
  const db = new FakeDb(recent)
  const chat = new FakeChat(db)
  const events: UiSessionEvent[] = []
  let windowMode: MainWindowMode = 'S1'
  const state = new SessionState({
    db: db as unknown as DbService,
    chat,
    getWindowMode: () => windowMode,
    setWindowMode: async (mode) => {
      windowMode = mode
    },
    emit: (_channel, payload) => events.push(payload)
  })
  return { db, chat, state, events, windowMode: () => windowMode }
}

describe('SessionState', () => {
  it('startup fallback selects the most recent session but stays in S1', () => {
    const { db, state } = harness(['old', 'recent'])
    db.sessions.set('old', sessionOf('old', 10))
    db.sessions.set('recent', sessionOf('recent', 20))
    expect(state.getCurrentSessionId()).toBe('recent')
    expect(state.getMode()).toBe('S1')
    expect(state.bootstrap()).toEqual({ currentSessionId: 'recent', mode: 'S1' })
  })

  it('open aborts+awaits the active stream before loading rows and enters S2', async () => {
    const { db, chat, state, events } = harness(['A', 'B'])
    db.addMessages('A', [messageOf('A', 0, 'a-user')])
    db.addMessages('B', [messageOf('B', 0, 'b-user'), messageOf('B', 1, 'b-answer')])
    await state.open('A')
    await chat.send({ sessionId: 'A', text: 'hello' })
    db.calls.length = 0

    const opened = await state.open('B')

    expect(chat.stopped).toEqual(['req-1'])
    expect(db.calls).toEqual(['stop:req-1', 'session:B', 'messages:B'])
    expect(opened.session.id).toBe('B')
    expect(opened.messages.map((message) => message.content)).toEqual([
      'b-user',
      'b-answer'
    ])
    expect(state.getCurrentSessionId()).toBe('B')
    expect(state.getMode()).toBe('S2')
    expect(state.getActiveRequestId()).toBeNull()
    expect(events.at(-1)).toEqual({
      currentSessionId: 'B',
      mode: 'S2',
      activeRequestId: null
    })
  })

  it('new aborts, clears state and never creates a DB session', async () => {
    const { db, chat, state } = harness(['A'])
    db.addMessages('A', [messageOf('A', 0, 'a')])
    await state.open('A')
    await chat.send({ sessionId: 'A', text: 'hello' })

    const before = db.sessions.size
    const cleared = await state.new()

    expect(cleared).toEqual({ currentSessionId: null, mode: 'S1' })
    expect(chat.stopped).toEqual(['req-1'])
    expect(state.getCurrentSessionId()).toBeNull()
    expect(state.getMode()).toBe('S1')
    expect(state.getActiveRequestId()).toBeNull()
    expect(db.sessions.size).toBe(before)
    expect((await state.getState()).messages).toEqual([])
  })

  it('deleteCurrent aborts, deletes the current row, clears and stays S1', async () => {
    const { db, chat, state } = harness(['A'])
    db.addMessages('A', [messageOf('A', 0, 'a')])
    await state.open('A')
    await chat.send({ sessionId: 'A', text: 'hello' })

    const deleted = await state.deleteCurrent()

    expect(deleted).toBe(true)
    expect(db.deleted).toEqual(['A'])
    expect(chat.stopped).toEqual(['req-1'])
    expect(state.getCurrentSessionId()).toBeNull()
    expect(state.getMode()).toBe('S1')
    expect(state.getActiveRequestId()).toBeNull()
  })

  it('serializes concurrent mutations: open then new leaves the new state', async () => {
    const { db, chat, state } = harness(['A', 'B'])
    db.addMessages('A', [messageOf('A', 0, 'a')])
    await state.open('A')
    await chat.send({ sessionId: 'A', text: 'hello' })

    const opening = state.open('B')
    const clearing = state.new()
    await Promise.all([opening, clearing])

    expect(chat.stopped).toEqual(['req-1'])
    expect(state.getCurrentSessionId()).toBeNull()
    expect(state.getMode()).toBe('S1')
    expect((await state.getState()).messages).toEqual([])
  })

  it('chat end clears activeRequestId without changing the current session', async () => {
    const { db, chat, state } = harness(['A'])
    db.addMessages('A', [messageOf('A', 0, 'a')])
    await state.open('A')
    const started = await state.send('first turn')
    expect(started.sessionId).toBe('A')
    expect(state.getActiveRequestId()).toBe(started.requestId)
    expect(chat.requests.at(-1)).toEqual({ sessionId: 'A', text: 'first turn' })

    chat.emitEnd()

    expect(state.getActiveRequestId()).toBeNull()
    expect(state.getCurrentSessionId()).toBe('A')
    expect(state.getMode()).toBe('S2')
  })

  it('send uses the main current id, not a renderer-provided stale id', async () => {
    const { db, chat, state } = harness(['A'])
    db.addMessages('A', [messageOf('A', 0, 'a')])
    await state.open('A')
    await state.send('continue')

    expect(chat.requests[0]?.sessionId).toBe('A')
    expect(state.getCurrentSessionId()).toBe('A')
  })

  it('rejects S4 in the session machine and keeps the current session', async () => {
    const { state } = harness(['A'])
    await state.setMode('S2')
    await expect(state.setMode('S4' as never)).rejects.toMatchObject({
      code: 'INVALID_ARGUMENT'
    })
    expect(state.getCurrentSessionId()).toBe('A')
    expect(state.getMode()).toBe('S2')
  })
})
