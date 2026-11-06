import { afterEach, describe, expect, it } from 'vitest'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { IPC, type ChatEndEvent } from '../../src/shared/channels'
import { openDbService, type DbService } from '../../src/main/db'
import { DbError } from '../../src/main/db/errors'
import { ChatOrchestrator } from '../../src/main/chat/orchestrator'
import type { ProviderClient, StreamChatOptions, StreamChatResult } from '../../src/main/provider/client'
import type { ProviderService } from '../../src/main/providers/service'

const EVIDENCE_DIR = resolve(process.cwd(), '.omo', 'evidence')
mkdirSync(EVIDENCE_DIR, { recursive: true })
const dirs: string[] = []
const services: DbService[] = []

function makeDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'quickask-crash-'))
  dirs.push(dir)
  return dir
}

function writeEvidence(name: string, value: unknown): void {
  writeFileSync(join(EVIDENCE_DIR, name), `${JSON.stringify(value, null, 2)}\n`)
}

const sleep = (ms: number): Promise<void> => new Promise((done) => setTimeout(done, ms))

async function waitFor(predicate: () => boolean, timeoutMs = 5000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (predicate()) return
    await sleep(10)
  }
  throw new Error('waitFor timed out')
}

function track(service: DbService): DbService {
  services.push(service)
  return service
}

afterEach(() => {
  for (const service of services.splice(0)) {
    try {
      service.close()
    } catch {
      // already closed
    }
  }
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

describe('startup recovery (NFR-11 / C.5)', () => {
  it('turns streaming rows into interrupted, keeps content, rebuilds FTS and never duplicates', () => {
    const dir = makeDir()
    const at = 1_700_200_000_000
    const userText = '崩溃恢复探针 kill9-recovery-ABC'
    const partial = '已经生成的部分内容'

    let service = openDbService({ dataDir: dir, recover: false, now: () => at })
    const begin = service.beginSend({ text: userText }, at)
    service.appendStream(begin.assistantMessageId, partial, at + 5)
    service.close() // SIGKILL at this point

    service = track(openDbService({ dataDir: dir, now: () => at + 10 }))
    expect(service.lastRecoveryCount).toBe(1)

    const messages = service.getMessages(begin.sessionId)
    expect(messages).toHaveLength(2)
    const user = messages.find((message) => message.role === 'user')
    const assistant = messages.find((message) => message.role === 'assistant')
    expect(user?.content).toBe(userText)
    expect(user?.status).toBe('complete')
    expect(assistant?.content).toBe(partial)
    expect(assistant?.status).toBe('interrupted')
    expect(service.counts()).toMatchObject({
      sessions: 1,
      messages: 2,
      streaming: 0,
      interrupted: 1
    })

    // FTS is rebuilt for the affected session during recovery.
    expect(service.searchSessions('kill9', 10).map((row) => row.id)).toContain(begin.sessionId)

    // Re-opening again is idempotent and cannot create a half/duplicate row.
    service.close()
    service = track(openDbService({ dataDir: dir, now: () => at + 20 }))
    expect(service.lastRecoveryCount).toBe(0)
    expect(service.getMessages(begin.sessionId)).toHaveLength(2)
    expect(service.recoverStreaming()).toBe(0)

    writeEvidence('task-26-recovery.json', {
      streamingAfterOpen: 0,
      interrupted: 1,
      contentPreserved: assistant?.content === partial,
      contentChars: assistant?.content.length ?? 0,
      duplicateAssistantMessages: 0,
      messages: messages.map((message) => ({
        role: message.role,
        status: message.status,
        contentChars: message.content.length
      })),
      ftsRebuilt: true,
      ftsQuery: 'kill9',
      secondOpenRecoveryCount: 0,
      idempotentRecovery: true
    })
  })

  it('keeps complete/stopped rows intact while recovering only streaming rows', () => {
    const dir = makeDir()
    let service = openDbService({ dataDir: dir, recover: false })

    const complete = service.beginSend({ text: '完成的消息' })
    service.appendStream(complete.assistantMessageId, '完整回答')
    service.finishStream(complete.assistantMessageId, 'complete')

    const stopped = service.beginSend({ text: '停止的消息' })
    service.appendStream(stopped.assistantMessageId, '停止前内容')
    service.finishStream(stopped.assistantMessageId, 'stopped')

    const streaming = service.beginSend({ text: '崩溃中的消息' })
    service.appendStream(streaming.assistantMessageId, '中断前内容')
    service.close()

    service = track(openDbService({ dataDir: dir }))
    expect(service.lastRecoveryCount).toBe(1)
    const byId = (id: string) => service.messages.get(id)
    expect(byId(complete.assistantMessageId)?.status).toBe('complete')
    expect(byId(stopped.assistantMessageId)?.status).toBe('stopped')
    expect(byId(streaming.assistantMessageId)?.status).toBe('interrupted')
    expect(byId(streaming.assistantMessageId)?.content).toBe('中断前内容')
    expect(service.counts().streaming).toBe(0)

    writeEvidence('task-26-status-transitions.json', {
      complete: byId(complete.assistantMessageId)?.status,
      stopped: byId(stopped.assistantMessageId)?.status,
      interrupted: byId(streaming.assistantMessageId)?.status,
      streamingRows: 0,
      recoveredCount: 1
    })
  })
})

describe('quit/abortAll finalization (C.4/C.5)', () => {
  it('abortAll finalizes the active stream as stopped with content and no streaming rows', async () => {
    const dir = makeDir()
    const db = track(openDbService({ dataDir: dir, recover: false }))
    db.providers.create({
      id: 'provider-crash-test',
      name: 'fake',
      baseUrl: 'http://127.0.0.1:9/v1',
      model: 'mock',
      isDefault: true
    })

    const providers = {
      resolveStreamProfile: async () => ({
        id: 'provider-crash-test',
        baseUrl: 'http://127.0.0.1:9/v1',
        model: 'mock'
      })
    } as unknown as ProviderService

    let aborts = 0
    const client = {
      abort: () => {
        aborts += 1
        return true
      },
      abortAll: () => undefined,
      streamChat: async (options: StreamChatOptions): Promise<StreamChatResult> => {
        for (let index = 0; index < 200; index += 1) {
          if (options.signal?.aborted) {
            return {
              requestId: options.requestId,
              status: 'aborted',
              content: '',
              reasoningChunks: 0,
              comments: 0,
              finishReason: null,
              usage: null,
              sawDone: false,
              httpStatus: 200,
              elapsedMs: index * 10
            }
          }
          options.onDelta?.(`chunk ${index} `)
          await sleep(10)
        }
        return {
          requestId: options.requestId,
          status: 'complete',
          content: '',
          reasoningChunks: 0,
          comments: 0,
          finishReason: 'stop',
          usage: null,
          sawDone: true,
          httpStatus: 200,
          elapsedMs: 2000
        }
      }
    } as unknown as ProviderClient

    const events: Array<{ channel: string; payload: unknown }> = []
    const chat = new ChatOrchestrator({
      db,
      providers,
      client,
      emit: (channel, payload) => events.push({ channel, payload })
    })

    const started = await chat.send({ sessionId: null, text: '退出中的流式请求' })
    await waitFor(() => {
      const assistant = db
        .getMessages(started.sessionId)
        .find((message) => message.role === 'assistant')
      return (assistant?.content.length ?? 0) > 0
    })

    const began = Date.now()
    await chat.abortAll()
    const elapsedMs = Date.now() - began
    expect(elapsedMs).toBeLessThan(1000)
    expect(aborts).toBeGreaterThan(0)

    const rows = db.getMessages(started.sessionId)
    const assistant = rows.find((message) => message.role === 'assistant')
    expect(assistant?.status).toBe('stopped')
    expect((assistant?.content.length ?? 0)).toBeGreaterThan(0)
    expect(db.counts().streaming).toBe(0)
    const end = events
      .filter((entry) => entry.channel === IPC.EVENT_CHAT_END)
      .map((entry) => entry.payload as ChatEndEvent)
      .find((event) => event.requestId === started.requestId)
    expect(end?.status).toBe('stopped')

    writeEvidence('task-26-quit-integration.json', {
      abortMs: elapsedMs,
      abortCalls: aborts,
      status: assistant?.status,
      contentChars: assistant?.content.length ?? 0,
      streamingRows: db.counts().streaming,
      endStatus: end?.status,
      budgetMs: 3000
    })
  })
})

describe('disk-full typed failure (C.4)', () => {
  it('maps max_page_count exhaustion to SQLITE_FULL and stays usable after reset', () => {
    const dir = makeDir()
    const service = track(openDbService({ dataDir: dir, recover: false }))
    const pageCount = Number(
      Object.values(service.driver.prepare('PRAGMA page_count').get() ?? {})[0] ?? 0
    )
    service.driver.exec(`PRAGMA max_page_count = ${pageCount}`)

    let fullError: DbError | null = null
    try {
      service.beginSend({ text: 'x'.repeat(2_000_000) })
    } catch (error) {
      fullError = error as DbError
    }
    expect(fullError?.code).toBe('SQLITE_FULL')
    expect(service.counts().sessions).toBe(0)

    service.driver.exec('PRAGMA max_page_count = 1000000')
    const begin = service.beginSend({ text: '磁盘恢复后仍可写入' })
    expect(service.getMessages(begin.sessionId)).toHaveLength(2)

    writeEvidence('task-26-full.json', {
      code: fullError?.code,
      sqliteCode: fullError?.sqliteCode,
      usableAfterReset: true,
      method: 'PRAGMA max_page_count',
      limitation:
        'A real full tmpfs was not mounted because the test user has no mount/sudo permission; Task 10 already uses the same typed SQLITE_FULL path.'
    })
  })
})
