import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it, vi } from 'vitest'
import { IPC, MAX_CHAT_IMAGES, type ChatImage, type ChatMessage } from '../../src/shared/channels'
import { requestSchemas } from '../../src/shared/ipc'
import {
  buildContext,
  buildContextFromChatMessages,
  IMAGE_TOKEN_ESTIMATE,
  type ContextMessage
} from '../../src/main/chat/context'
import { openDbService, SCHEMA_VERSION } from '../../src/main/db'
import { registerChatHandlers } from '../../src/main/ipc/handlers/chat'

/** 1×1 transparent PNG — enough to exercise the data-URL plumbing. */
const PNG =
  'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=='

function image(overrides: Partial<ChatImage> = {}): ChatImage {
  return { dataUrl: PNG, mime: 'image/png', width: 1, height: 1, bytes: 70, ...overrides }
}

const dirs: string[] = []
afterAll(() => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true })
})

function makeDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'quickask-images-'))
  dirs.push(dir)
  return dir
}

function user(content: string, images?: ChatImage[]): ContextMessage {
  return { role: 'user', content, images, status: 'complete' }
}

function assistant(content: string): ContextMessage {
  return { role: 'assistant', content, status: 'complete' }
}

describe('context builder: clipboard images', () => {
  it('only the latest image-bearing user turn carries image parts', () => {
    const built = buildContext({
      messages: [
        user('第一张图', [image()]),
        assistant('看到了'),
        user('第二张图', [image(), image()]),
        assistant('也看到了'),
        user('这两张有什么不同？')
      ]
    })

    const turns = built.messages
    // Old image turn: plain text, no re-upload on every request.
    expect(turns[0]).toEqual({ role: 'user', content: '第一张图' })
    // Latest image turn: text + one part per image.
    const second = turns[2]
    expect(typeof second.content).not.toBe('string')
    if (typeof second.content === 'string') throw new Error('expected multimodal parts')
    expect(second.content[0]).toEqual({ type: 'text', text: '第二张图' })
    expect(second.content.filter((part) => part.type === 'image_url')).toHaveLength(2)
    expect(second.content[1]).toEqual({ type: 'image_url', image_url: { url: PNG } })
    // Current question stays plain text.
    expect(turns[turns.length - 1]).toEqual({ role: 'user', content: '这两张有什么不同？' })
  })

  it('attaches images to the current turn when it is the image-bearing one', () => {
    const built = buildContext({ messages: [user('图在哪', [image()])] })
    const only = built.messages[built.messages.length - 1]
    if (typeof only.content === 'string') throw new Error('expected multimodal parts')
    expect(only.content[0]).toEqual({ type: 'text', text: '图在哪' })
    expect(only.content).toHaveLength(2)
  })

  it('counts a fixed budget per image instead of the base64 length', () => {
    const textBuilt = buildContext({ messages: [user('看图')] })
    const imageBuilt = buildContext({ messages: [user('看图', [image()])] })
    expect(imageBuilt.estimatedTokens - textBuilt.estimatedTokens).toBe(IMAGE_TOKEN_ESTIMATE)
  })

  it('keeps image-only turns valid by sending an empty text part', () => {
    const built = buildContext({ messages: [user('', [image()])] })
    const only = built.messages[built.messages.length - 1]
    if (typeof only.content === 'string') throw new Error('expected multimodal parts')
    expect(only.content[0]).toEqual({ type: 'text', text: '' })
  })

  it('passes attachments through buildContextFromChatMessages (main path)', () => {
    const rows: ChatMessage[] = [
      {
        id: 'm1',
        sessionId: 's1',
        seq: 1,
        role: 'user',
        content: '这是什么',
        images: [image()],
        status: 'complete',
        errorCode: null,
        errorDetail: null,
        model: null,
        createdAt: 1,
        updatedAt: 1
      }
    ]
    const built = buildContextFromChatMessages(rows)
    const turn = built.messages[built.messages.length - 1]
    if (typeof turn.content === 'string') throw new Error('expected multimodal parts')
    expect(turn.content).toHaveLength(2)
  })
})

describe('CHAT_SEND schema: clipboard images', () => {
  const schema = requestSchemas[IPC.CHAT_SEND]

  it('accepts up to MAX_CHAT_IMAGES images', () => {
    const parsed = schema.safeParse({
      sessionId: null,
      text: '看图',
      images: Array.from({ length: MAX_CHAT_IMAGES }, () => image())
    })
    expect(parsed.success).toBe(true)
  })

  it('rejects more than MAX_CHAT_IMAGES images', () => {
    const parsed = schema.safeParse({
      sessionId: null,
      text: '看图',
      images: Array.from({ length: MAX_CHAT_IMAGES + 1 }, () => image())
    })
    expect(parsed.success).toBe(false)
  })

  it('rejects non-image or non-base64 payloads', () => {
    for (const bad of [
      { ...image(), dataUrl: 'data:text/plain;base64,aGVsbG8=' },
      { ...image(), dataUrl: 'https://example.com/a.png' },
      { ...image(), mime: 'image/svg+xml' },
      { ...image(), width: 0 }
    ]) {
      const parsed = schema.safeParse({ sessionId: null, text: 'x', images: [bad] })
      expect(parsed.success).toBe(false)
    }
  })

  it('keeps images optional for text-only sends', () => {
    expect(schema.safeParse({ sessionId: null, text: '只有文字' }).success).toBe(true)
  })
})

describe('db: image attachments round-trip', () => {
  it('persists images with the user row and migrates old databases', () => {
    const dir = makeDir()
    const service = openDbService({ dataDir: dir })
    expect(service.handle.driver.prepare('PRAGMA user_version').get()?.user_version).toBe(
      SCHEMA_VERSION
    )

    const begin = service.beginSend({ text: '帮我看看这张截图', images: [image()] })
    const rows = service.messages.listBySession(begin.sessionId)
    const userRow = rows.find((row) => row.role === 'user')
    expect(userRow?.images).toHaveLength(1)
    expect(userRow?.images?.[0]?.dataUrl).toBe(PNG)
    expect(rows.find((row) => row.role === 'assistant')?.images).toEqual([])
    service.close()

    // Reopen: the attachment survives a restart.
    const reopened = openDbService({ dataDir: dir })
    const after = reopened.messages.listBySession(begin.sessionId)
    expect(after.find((row) => row.role === 'user')?.images?.[0]?.dataUrl).toBe(PNG)
    reopened.close()
  })

  it('backfills [] for rows that existed before the images column', () => {
    const dir = makeDir()
    const service = openDbService({ dataDir: dir })
    const begin = service.beginSend({ text: '纯文字' })
    // Simulate a v1 row: NULL/absent JSON must degrade to "no images".
    service.handle.driver
      .prepare("UPDATE messages SET images_json = '' WHERE session_id = ?")
      .run(begin.sessionId)
    const row = service.messages.listBySession(begin.sessionId).find((m) => m.role === 'user')
    expect(row?.images).toEqual([])
    service.close()
  })
})

/**
 * Regression guard for the bug the composer e2e caught: the IPC handler used to
 * forward only `payload.text`, so images died at the bridge even though the
 * renderer, the DB and the orchestrator all handled them correctly.
 */
describe('ipc: CHAT_SEND forwards images to the chat layer', () => {
  type Handler = (payload: unknown, context: unknown) => Promise<unknown>

  function captureRouter(): {
    handlers: Map<string, Handler>
    router: never
  } {
    const handlers = new Map<string, Handler>()
    const router = {
      handle(channel: string, _schema: unknown, handler: Handler) {
        handlers.set(channel, handler)
        return router
      }
    }
    return { handlers, router: router as never }
  }

  async function dispatch(handlers: Map<string, Handler>, payload: unknown): Promise<unknown> {
    const handler = handlers.get(IPC.CHAT_SEND)
    if (!handler) throw new Error('CHAT_SEND handler was not registered')
    return handler(payload, {})
  }

  it('passes the images through the session-state path', async () => {
    const { handlers, router } = captureRouter()
    const stateSend = vi.fn(async () => ({ requestId: 'r1', sessionId: 's1' }))
    registerChatHandlers(router, () => null, () => ({ send: stateSend }) as never)

    const result = await dispatch(handlers, { sessionId: null, text: '这是什么', images: [image()] })

    expect(result).toMatchObject({ ok: true })
    expect(stateSend).toHaveBeenCalledWith('这是什么', [image()])
  })

  it('passes the images through when no session state is available', async () => {
    const { handlers, router } = captureRouter()
    const chatSend = vi.fn(async () => ({ requestId: 'r2', sessionId: 's2' }))
    registerChatHandlers(router, () => ({ send: chatSend }) as never)

    const result = await dispatch(handlers, { sessionId: 's9', text: '看图', images: [image()] })

    expect(result).toMatchObject({ ok: true })
    expect(chatSend).toHaveBeenCalledWith({
      sessionId: 's9',
      text: '看图',
      images: [image()]
    })
  })

  it('omits the images key entirely for text-only sends', async () => {
    const { handlers, router } = captureRouter()
    const chatSend = vi.fn(
      async (_input: { sessionId: string | null; text: string; images?: ChatImage[] }) => ({
        requestId: 'r3',
        sessionId: 's3'
      })
    )
    registerChatHandlers(router, () => ({ send: chatSend }) as never, () => null)

    await dispatch(handlers, { sessionId: null, text: '只有文字' })

    expect(chatSend).toHaveBeenCalledWith({ sessionId: null, text: '只有文字' })
    expect(Object.keys(chatSend.mock.calls[0]?.[0] ?? {})).not.toContain('images')
  })
})
