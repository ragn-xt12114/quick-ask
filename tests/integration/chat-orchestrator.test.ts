import { afterEach, describe, expect, it } from 'vitest'
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { IPC, type ChatDeltaEvent, type ChatEndEvent, type IpcEventChannel } from '../../src/shared/channels'
import { isUuidV7, uuidv7 } from '../../src/shared/uuidv7'
import { openDbService, type DbService } from '../../src/main/db'
import { DbError } from '../../src/main/db/errors'
import type { KeyringBackend } from '../../src/main/secrets/keyring-backend'
import { SecretStore } from '../../src/main/secrets/store'
import { ProviderService } from '../../src/main/providers/service'
import { createProviderClient, type ProviderClient } from '../../src/main/provider/client'
import { ChatOrchestrator } from '../../src/main/chat/orchestrator'

const root = process.cwd()
const evidenceDir = join(root, '.omo', 'evidence')
const mockServer = join(root, 'tools', 'mock-sse-server.mjs')
mkdirSync(evidenceDir, { recursive: true })

const children: ChildProcessWithoutNullStreams[] = []
const harnesses: Harness[] = []
const summary: Record<string, unknown> = {}
const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

class MemoryKeyring implements KeyringBackend {
  private readonly values = new Map<string, string>()

  async set(service: string, account: string, value: string): Promise<void> {
    this.values.set(`${service}\u0000${account}`, value)
  }

  async get(service: string, account: string): Promise<string | null> {
    return this.values.get(`${service}\u0000${account}`) ?? null
  }

  async delete(service: string, account: string): Promise<boolean> {
    return this.values.delete(`${service}\u0000${account}`)
  }

  async ping(): Promise<boolean> {
    return true
  }
}

interface Harness {
  dir: string
  db: DbService
  providers: ProviderService
  client: ProviderClient
  chat: ChatOrchestrator
  profileId: string
  events: Array<{ channel: IpcEventChannel; payload: unknown }>
  logs: Array<{ line: string; fields?: Record<string, string | number | boolean | null> }>
  cleanup(): void
}

async function createHarness(baseUrl: string | null, apiKey: string | null = 'sk-task16-test'): Promise<Harness> {
  const dir = mkdtempSync(join(tmpdir(), 'quickask-chat-'))
  const db = openDbService({ dataDir: dir, recover: false })
  const secrets = new SecretStore({ keyring: new MemoryKeyring(), safeStorage: null, dataDir: dir })
  const providers = new ProviderService(db, secrets, { version: 'task16-test' })
  const client = createProviderClient({
    env: {},
    version: 'task16-test',
    timeouts: { connectMs: 2000, headersMs: 5000, idleMs: 10_000, totalMs: 60_000 }
  })
  const events: Harness['events'] = []
  const logs: Harness['logs'] = []

  const chat = new ChatOrchestrator({
    db,
    providers,
    client,
    emit: (channel, payload) => {
      events.push({ channel, payload })
    },
    logger: (line, fields) => {
      logs.push({ line, ...(fields ? { fields } : {}) })
    }
  })

  let profileId = ''
  if (baseUrl) {
    const profile = await providers.createProfile({
      name: 'mock',
      baseUrl,
      model: 'mock-model',
      ...(apiKey ? { apiKey } : {}),
      isDefault: true
    })
    profileId = profile.id
  }

  const harness: Harness = {
    dir,
    db,
    providers,
    client,
    chat,
    profileId,
    events,
    logs,
    cleanup() {
      try {
        client.abortAll()
      } catch {
        // no active request
      }
      try {
        db.close()
      } catch {
        // already closed
      }
      secrets.close()
      rmSync(dir, { recursive: true, force: true })
    }
  }
  harnesses.push(harness)
  return harness
}

interface StartedMock {
  child: ChildProcessWithoutNullStreams
  port: number
  baseUrl: string
  logPath: string
  bodyLogPath: string
}

async function startMock(options: {
  mode: string
  chunks?: number
  delay?: number
  name: string
}): Promise<StartedMock> {
  const logPath = join(evidenceDir, `task-16-${options.name}.log`)
  const bodyLogPath = join(evidenceDir, `task-16-${options.name}-bodies.log`)
  rmSync(logPath, { force: true })
  rmSync(bodyLogPath, { force: true })

  const args = [
    mockServer,
    '--port',
    '0',
    '--mode',
    options.mode,
    '--log',
    logPath,
    '--body-log',
    bodyLogPath
  ]
  if (options.chunks !== undefined) args.push('--chunks', String(options.chunks))
  if (options.delay !== undefined) args.push('--delay', String(options.delay))

  const child = spawn(process.execPath, args, {
    cwd: root,
    stdio: ['ignore', 'pipe', 'pipe']
  }) as unknown as ChildProcessWithoutNullStreams
  children.push(child)

  let stdout = ''
  let stderr = ''
  const port = await new Promise<number>((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error(`mock did not start: ${stdout} ${stderr}`))
    }, 10_000)
    child.stdout.on('data', (chunk: Buffer) => {
      stdout += chunk.toString('utf8')
      const match = /mock-sse-server listening on http:\/\/[^:\s]+:(\d+)/.exec(stdout)
      if (match) {
        clearTimeout(timer)
        resolve(Number(match[1]))
      }
    })
    child.stderr.on('data', (chunk: Buffer) => {
      stderr += chunk.toString('utf8')
    })
    child.once('error', (error) => {
      clearTimeout(timer)
      reject(error)
    })
    child.once('exit', (code) => {
      if (!stdout.includes('listening')) {
        clearTimeout(timer)
        reject(new Error(`mock exited early (${code}): ${stderr}`))
      }
    })
  })

  return {
    child,
    port,
    baseUrl: `http://127.0.0.1:${port}`,
    logPath,
    bodyLogPath
  }
}

function readText(path: string): string {
  try {
    return readFileSync(path, 'utf8')
  } catch {
    return ''
  }
}

function readBodies(path: string): Array<{ model: string; messages: Array<{ role: string; content: string }> }> {
  return readText(path)
    .split('\n')
    .filter((line) => line.trim().length > 0)
    .map((line) => JSON.parse(line) as { model: string; messages: Array<{ role: string; content: string }> })
}

function countPosts(path: string): number {
  return (readText(path).match(/^POST \/v1\/chat\/completions/gm) ?? []).length
}

async function waitFor(predicate: () => boolean, timeoutMs = 6000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (predicate()) return
    await sleep(10)
  }
  throw new Error('waitFor timed out')
}

function deltas(harness: Harness, requestId: string): ChatDeltaEvent[] {
  return harness.events
    .filter((entry) => entry.channel === IPC.EVENT_CHAT_DELTA)
    .map((entry) => entry.payload as ChatDeltaEvent)
    .filter((event) => event.requestId === requestId)
}

function ends(harness: Harness, requestId: string): ChatEndEvent[] {
  return harness.events
    .filter((entry) => entry.channel === IPC.EVENT_CHAT_END)
    .map((entry) => entry.payload as ChatEndEvent)
    .filter((event) => event.requestId === requestId)
}

function writeEvidence(name: string, value: unknown): void {
  writeFileSync(join(evidenceDir, name), `${JSON.stringify(value, null, 2)}\n`)
}

async function stopChild(child: ChildProcessWithoutNullStreams): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return
  const closed = new Promise<void>((resolve) => child.once('close', () => resolve()))
  child.kill('SIGTERM')
  await Promise.race([closed, sleep(1500)])
  if (child.exitCode === null && child.signalCode === null) {
    child.kill('SIGKILL')
    await Promise.race([closed, sleep(1000)])
  }
}

afterEach(async () => {
  for (const harness of harnesses.splice(0)) harness.cleanup()
  for (const child of children.splice(0)) await stopChild(child)
})

describe('ChatOrchestrator against the real mock SSE server', () => {
  it('send persists user + assistant rows and streams to completion', async () => {
    const mock = await startMock({ mode: 'normal', chunks: 3, delay: 20, name: 'send' })
    const harness = await createHarness(mock.baseUrl)

    const originalAppend = harness.db.appendStream.bind(harness.db)
    let appendCalls = 0
    harness.db.appendStream = (...args: Parameters<DbService['appendStream']>) => {
      appendCalls += 1
      return originalAppend(...args)
    }

    const started = await harness.chat.send({ sessionId: null, text: '你好，流式测试' })
    expect(isUuidV7(started.requestId)).toBe(true)
    await harness.chat.waitForIdle()

    const rows = harness.db.getMessages(started.sessionId)
    expect(rows).toHaveLength(2)
    expect(rows[0].role).toBe('user')
    expect(rows[0].content).toBe('你好，流式测试')
    expect(rows[0].status).toBe('complete')
    expect(rows[1].role).toBe('assistant')
    expect(rows[1].status).toBe('complete')
    expect(rows[1].content).toBe('chunk 1chunk 2chunk 3')
    expect(rows[1].seq).toBe(rows[0].seq + 1)

    const deltaEvents = deltas(harness, started.requestId)
    expect(deltaEvents.map((event) => event.delta).join('')).toBe('chunk 1chunk 2chunk 3')
    const endEvents = ends(harness, started.requestId)
    expect(endEvents).toHaveLength(1)
    expect(endEvents[0].status).toBe('complete')
    expect(endEvents[0].errorCode).toBeNull()

    expect(countPosts(mock.logPath)).toBe(1)
    expect(appendCalls).toBeLessThan(deltaEvents.length)

    summary.send = {
      requestId: started.requestId,
      rows: rows.map((row) => ({ id: row.id, role: row.role, status: row.status, seq: row.seq })),
      deltas: deltaEvents.length,
      appendCalls,
      endStatus: endEvents[0].status,
      posts: countPosts(mock.logPath)
    }
    writeEvidence('task-16-send.json', summary.send)
  })

  it('multi-turn request body contains the previous user + assistant pair', async () => {
    const mock = await startMock({ mode: 'normal', chunks: 2, delay: 10, name: 'multi-turn' })
    const harness = await createHarness(mock.baseUrl)

    const first = await harness.chat.send({ sessionId: null, text: '第一轮问题' })
    await harness.chat.waitForIdle()
    const firstRows = harness.db.getMessages(first.sessionId)
    const firstAnswer = firstRows.find((row) => row.role === 'assistant')?.content

    const second = await harness.chat.send({ sessionId: first.sessionId, text: '第二轮追问' })
    await harness.chat.waitForIdle()

    const bodies = readBodies(mock.bodyLogPath)
    expect(bodies).toHaveLength(2)
    expect(bodies[1].messages).toEqual([
      { role: 'user', content: '第一轮问题' },
      { role: 'assistant', content: firstAnswer },
      { role: 'user', content: '第二轮追问' }
    ])
    expect(bodies[1].model).toBe('mock-model')

    summary.multiTurn = {
      bodies: bodies.length,
      secondMessages: bodies[1].messages,
      firstRequestId: first.requestId,
      secondRequestId: second.requestId
    }
    writeEvidence('task-16-multi-turn.json', summary.multiTurn)
  })

  it('stop finalizes as stopped, keeps content and closes the server ≤500ms', async () => {
    const mock = await startMock({ mode: 'slow', chunks: 100, delay: 100, name: 'abort' })
    const harness = await createHarness(mock.baseUrl)

    const started = await harness.chat.send({ sessionId: null, text: '请生成很长的一段回答' })
    await waitFor(() => deltas(harness, started.requestId).length >= 1)

    const stopAt = Date.now()
    const stopped = await harness.chat.stop(started.requestId)
    expect(stopped).toEqual({ stopped: true })
    const stopReturnedAt = Date.now()

    await waitFor(() => /client closed after/.test(readText(mock.logPath)))
    const closedAt = Date.now()
    const logText = readText(mock.logPath)
    const closeMatch = /client closed after (\d+) chunks at \+(\d+)ms/.exec(logText)
    expect(closeMatch).not.toBeNull()
    const chunksSent = Number(closeMatch?.[1])
    const closeFromRequestMs = Number(closeMatch?.[2])

    const rows = harness.db.getMessages(started.sessionId)
    const assistant = rows.find((row) => row.role === 'assistant')
    expect(assistant?.status).toBe('stopped')
    expect((assistant?.content.length ?? 0)).toBeGreaterThan(0)
    expect(chunksSent).toBeLessThan(100)

    const endEvents = ends(harness, started.requestId)
    expect(endEvents).toHaveLength(1)
    expect(endEvents[0].status).toBe('stopped')

    const deltaCountAtEnd = deltas(harness, started.requestId).length
    await sleep(250)
    expect(deltas(harness, started.requestId).length).toBe(deltaCountAtEnd)

    expect(closeFromRequestMs).toBeLessThanOrEqual(500)
    expect(closedAt - stopAt).toBeLessThanOrEqual(500)
    expect(countPosts(mock.logPath)).toBe(1)

    summary.abort = {
      chunksSent,
      closeFromRequestMs,
      stopToClosedMs: closedAt - stopAt,
      stopReturnedMs: stopReturnedAt - stopAt,
      status: assistant?.status,
      contentLength: assistant?.content.length ?? 0,
      deltasBeforeEnd: deltaCountAtEnd,
      deltasAfterEnd: deltas(harness, started.requestId).length,
      posts: countPosts(mock.logPath)
    }
    writeEvidence('task-16-abort.json', summary.abort)
  })

  it('send during an active stream finalizes the previous request first (no interleaving)', async () => {
    const mock = await startMock({ mode: 'normal', chunks: 10, delay: 40, name: 'during' })
    const harness = await createHarness(mock.baseUrl)

    const first = await harness.chat.send({ sessionId: null, text: '第一个问题' })
    await waitFor(() => deltas(harness, first.requestId).length >= 1)

    const second = await harness.chat.send({ sessionId: first.sessionId, text: '插队的问题' })
    await harness.chat.waitForIdle()

    const firstEndIndex = harness.events.findIndex(
      (entry) =>
        entry.channel === IPC.EVENT_CHAT_END &&
        (entry.payload as ChatEndEvent).requestId === first.requestId
    )
    const secondDeltaIndex = harness.events.findIndex(
      (entry) =>
        entry.channel === IPC.EVENT_CHAT_DELTA &&
        (entry.payload as ChatDeltaEvent).requestId === second.requestId
    )
    expect(firstEndIndex).toBeGreaterThanOrEqual(0)
    expect(secondDeltaIndex).toBeGreaterThan(firstEndIndex)

    const rows = harness.db.getMessages(first.sessionId)
    expect(rows).toHaveLength(4)
    const assistants = rows.filter((row) => row.role === 'assistant')
    expect(assistants[0].status).toBe('stopped')
    expect(assistants[1].status).toBe('complete')
    expect(ends(harness, first.requestId)).toHaveLength(1)
    expect(ends(harness, second.requestId)).toHaveLength(1)
    expect(countPosts(mock.logPath)).toBe(2)

    summary.sendDuringActive = {
      firstStatus: assistants[0].status,
      secondStatus: assistants[1].status,
      firstEndIndex,
      secondDeltaIndex,
      posts: 2
    }
    writeEvidence('task-16-send-during.json', summary.sendDuringActive)
  })

  it('allows a loopback endpoint without an API key', async () => {
    const mock = await startMock({ mode: 'normal', chunks: 1, delay: 5, name: 'loopback' })
    const harness = await createHarness(mock.baseUrl, null)

    const started = await harness.chat.send({ sessionId: null, text: '本地模型你好' })
    await harness.chat.waitForIdle()

    const assistant = harness.db
      .getMessages(started.sessionId)
      .find((row) => row.role === 'assistant')
    expect(assistant?.status).toBe('complete')
    expect(assistant?.content).toBe('chunk 1')
    expect(countPosts(mock.logPath)).toBe(1)

    writeEvidence('task-16-loopback.json', {
      status: assistant?.status,
      content: assistant?.content,
      posts: countPosts(mock.logPath)
    })
  })

  it('returns CONFIG_REQUIRED without DB rows or a request when unconfigured', async () => {
    const harness = await createHarness(null)

    await expect(harness.chat.send({ sessionId: null, text: '你好' })).rejects.toMatchObject({
      code: 'CONFIG_REQUIRED'
    })
    expect(harness.db.counts().sessions).toBe(0)
    expect(harness.db.counts().messages).toBe(0)

    await harness.providers.createProfile({
      name: 'no-key',
      baseUrl: 'https://api.openai.com/v1',
      model: 'gpt-test',
      isDefault: true
    })

    await expect(harness.chat.send({ sessionId: null, text: '你好' })).rejects.toMatchObject({
      code: 'CONFIG_REQUIRED'
    })
    expect(harness.db.counts().sessions).toBe(0)
    expect(harness.db.counts().messages).toBe(0)

    summary.config = { sessions: 0, messages: 0, code: 'CONFIG_REQUIRED' }
    writeEvidence('task-16-config.json', summary.config)
  })

  it('maps a DB write failure mid-stream to error/db_write and sends no second request', async () => {
    const mock = await startMock({ mode: 'normal', chunks: 5, delay: 40, name: 'db-failure' })
    const harness = await createHarness(mock.baseUrl)

    const originalAppend = harness.db.appendStream.bind(harness.db)
    harness.db.appendStream = () => {
      throw new DbError('DB_WRITE', 'injected write failure')
    }

    const started = await harness.chat.send({ sessionId: null, text: '数据库失败测试' })
    await harness.chat.waitForIdle()

    harness.db.appendStream = originalAppend

    const rows = harness.db.getMessages(started.sessionId)
    const assistant = rows.find((row) => row.role === 'assistant')
    expect(assistant?.status).toBe('error')
    expect(assistant?.errorCode).toBe('DB_WRITE')

    const endEvents = ends(harness, started.requestId)
    expect(endEvents).toHaveLength(1)
    expect(endEvents[0].status).toBe('error')
    expect(endEvents[0].errorCode).toBe('DB_WRITE')

    await sleep(200)
    expect(countPosts(mock.logPath)).toBe(1)

    summary.dbFailure = {
      status: assistant?.status,
      errorCode: assistant?.errorCode,
      endStatus: endEvents[0].status,
      posts: countPosts(mock.logPath)
    }
    writeEvidence('task-16-db-failure.json', summary.dbFailure)
  })

  it('retry reuses the assistant row, adds no rows and excludes the failed answer', async () => {
    const failing = await startMock({ mode: 'error', chunks: 1, delay: 10, name: 'retry-first' })
    const harness = await createHarness(failing.baseUrl)

    const first = await harness.chat.send({ sessionId: null, text: '需要重试的问题' })
    await harness.chat.waitForIdle()

    const failedRows = harness.db.getMessages(first.sessionId)
    const user = failedRows.find((row) => row.role === 'user')
    const failedAssistant = failedRows.find((row) => row.role === 'assistant')
    expect(user).toBeDefined()
    expect(failedAssistant?.status).toBe('error')
    expect(failedAssistant?.seq).toBe((user?.seq ?? 0) + 1)
    const rowCountBefore = failedRows.length

    const healthy = await startMock({ mode: 'normal', chunks: 2, delay: 10, name: 'retry-second' })
    await harness.providers.updateProfile(harness.profileId, { id: harness.profileId, baseUrl: healthy.baseUrl })

    const retried = await harness.chat.retry({
      sessionId: first.sessionId,
      messageId: failedAssistant?.id ?? ''
    })
    await harness.chat.waitForIdle()

    const afterAssistantRetry = harness.db.getMessages(first.sessionId)
    expect(afterAssistantRetry).toHaveLength(rowCountBefore)
    expect(afterAssistantRetry.filter((row) => row.role === 'user')).toHaveLength(1)
    expect(afterAssistantRetry.filter((row) => row.role === 'assistant')).toHaveLength(1)
    const reused = afterAssistantRetry.find((row) => row.role === 'assistant')
    expect(reused?.id).toBe(failedAssistant?.id)
    expect(reused?.seq).toBe(failedAssistant?.seq)
    expect(reused?.status).toBe('complete')
    expect(reused?.content).toBe('chunk 1chunk 2')

    const retryBodies = readBodies(healthy.bodyLogPath)
    expect(retryBodies).toHaveLength(1)
    expect(retryBodies[0].messages).toEqual([
      { role: 'user', content: '需要重试的问题' }
    ])
    expect(retryBodies[0].messages.some((message) => message.content === 'chunk 1')).toBe(false)

    await harness.providers.updateProfile(harness.profileId, { id: harness.profileId, baseUrl: healthy.baseUrl })
    const retriedByUser = await harness.chat.retry({
      sessionId: first.sessionId,
      messageId: user?.id ?? ''
    })
    await harness.chat.waitForIdle()

    const finalRows = harness.db.getMessages(first.sessionId)
    expect(finalRows).toHaveLength(rowCountBefore)
    expect(finalRows.filter((row) => row.role === 'assistant')).toHaveLength(1)
    expect(finalRows.find((row) => row.role === 'assistant')?.id).toBe(failedAssistant?.id)
    const userRetryBodies = readBodies(healthy.bodyLogPath)
    expect(userRetryBodies).toHaveLength(2)
    expect(userRetryBodies[1].messages).toEqual([
      { role: 'user', content: '需要重试的问题' }
    ])

    summary.retry = {
      rowsBefore: rowCountBefore,
      rowsAfter: finalRows.length,
      assistantIdReused: finalRows.find((row) => row.role === 'assistant')?.id === failedAssistant?.id,
      seqReused: finalRows.find((row) => row.role === 'assistant')?.seq === failedAssistant?.seq,
      firstBody: retryBodies[0].messages,
      userRetryBody: userRetryBodies[1].messages,
      retriedRequestId: retried.requestId,
      retriedByUserRequestId: retriedByUser.requestId
    }
    writeEvidence('task-16-retry.json', summary.retry)
  })

  it('regenerate replaces the same assistant row without duplicating it', async () => {
    const firstMock = await startMock({ mode: 'normal', chunks: 3, delay: 10, name: 'regen-first' })
    const harness = await createHarness(firstMock.baseUrl)

    const first = await harness.chat.send({ sessionId: null, text: '重新生成的问题' })
    await harness.chat.waitForIdle()
    const before = harness.db.getMessages(first.sessionId)
    const originalAssistant = before.find((row) => row.role === 'assistant')
    expect(originalAssistant?.content).toBe('chunk 1chunk 2chunk 3')

    const secondMock = await startMock({ mode: 'normal', chunks: 2, delay: 10, name: 'regen-second' })
    await harness.providers.updateProfile(harness.profileId, { id: harness.profileId, baseUrl: secondMock.baseUrl })

    const regenerated = await harness.chat.regenerate({
      sessionId: first.sessionId,
      messageId: null
    })
    await harness.chat.waitForIdle()

    const after = harness.db.getMessages(first.sessionId)
    expect(after).toHaveLength(before.length)
    const replaced = after.find((row) => row.role === 'assistant')
    expect(replaced?.id).toBe(originalAssistant?.id)
    expect(replaced?.seq).toBe(originalAssistant?.seq)
    expect(replaced?.content).toBe('chunk 1chunk 2')
    expect(replaced?.status).toBe('complete')

    const bodies = readBodies(secondMock.bodyLogPath)
    expect(bodies).toHaveLength(1)
    expect(bodies[0].messages).toEqual([{ role: 'user', content: '重新生成的问题' }])

    await harness.providers.updateProfile(harness.profileId, { id: harness.profileId, baseUrl: firstMock.baseUrl })
    const targeted = await harness.chat.regenerate({
      sessionId: first.sessionId,
      messageId: originalAssistant?.id ?? null
    })
    await harness.chat.waitForIdle()

    const afterTarget = harness.db.getMessages(first.sessionId)
    expect(afterTarget).toHaveLength(before.length)
    expect(afterTarget.find((row) => row.role === 'assistant')?.id).toBe(originalAssistant?.id)
    expect(afterTarget.find((row) => row.role === 'assistant')?.content).toBe('chunk 1chunk 2chunk 3')

    summary.regenerate = {
      assistantId: originalAssistant?.id,
      seq: originalAssistant?.seq,
      rows: afterTarget.length,
      firstRegeneratedRequestId: regenerated.requestId,
      targetedRequestId: targeted.requestId,
      body: bodies[0].messages,
      contentAfter: afterTarget.find((row) => row.role === 'assistant')?.content
    }
    writeEvidence('task-16-regenerate.json', summary.regenerate)
  })

  it('auto title uses the first 20 chars and a manual rename is never overwritten', async () => {
    const mock = await startMock({ mode: 'normal', chunks: 1, delay: 5, name: 'title' })
    const harness = await createHarness(mock.baseUrl)

    const text = '# 标题\n\n**加粗** `code` [链接](https://example.com) 以及更多文字超过二十个字符'
    const started = await harness.chat.send({ sessionId: null, text })
    await harness.chat.waitForIdle()

    const session = harness.db.getSession(started.sessionId)
    expect(session).not.toBeNull()
    expect(session?.titleAuto).toBe(true)
    expect(Array.from(session?.title ?? '').length).toBeLessThanOrEqual(20)
    expect(session?.title ?? '').not.toMatch(/[\n\r*#`[\]]/)
    expect(session?.title.includes('https://')).toBe(false)

    harness.db.renameSession(started.sessionId, '用户自定义标题')
    const renamed = harness.db.getSession(started.sessionId)
    expect(renamed?.title).toBe('用户自定义标题')
    expect(renamed?.titleAuto).toBe(false)

    const second = await harness.chat.send({ sessionId: started.sessionId, text: '后续消息不应覆盖标题' })
    await harness.chat.waitForIdle()
    const finalSession = harness.db.getSession(started.sessionId)
    expect(finalSession?.title).toBe('用户自定义标题')
    expect(finalSession?.titleAuto).toBe(false)

    summary.title = {
      autoTitle: session?.title,
      autoTitleLength: Array.from(session?.title ?? '').length,
      titleAuto: session?.titleAuto,
      renamed: renamed?.title,
      renamedAuto: renamed?.titleAuto,
      afterSecondSend: finalSession?.title,
      afterSecondSendAuto: finalSession?.titleAuto,
      secondRequestId: second.requestId
    }
    writeEvidence('task-16-title.json', summary.title)
  })

  it('trims long history to the budget and always keeps the current user', async () => {
    const mock = await startMock({ mode: 'normal', chunks: 1, delay: 5, name: 'context-trim' })
    const harness = await createHarness(mock.baseUrl)

    const now = Date.now()
    const sessionId = uuidv7(now)
    harness.db.sessions.create({
      id: sessionId,
      title: '长历史',
      titleAuto: false,
      createdAt: now,
      updatedAt: now,
      lastMessageAt: now
    })
    const long = '中'.repeat(2000)
    for (let index = 0; index < 40; index += 1) {
      harness.db.messages.insert({
        id: uuidv7(now + index * 2),
        sessionId,
        seq: index * 2,
        role: 'user',
        content: `${long}-q${index}`,
        status: 'complete',
        createdAt: now,
        updatedAt: now
      })
      harness.db.messages.insert({
        id: uuidv7(now + index * 2 + 1),
        sessionId,
        seq: index * 2 + 1,
        role: 'assistant',
        content: `${long}-a${index}`,
        status: 'complete',
        createdAt: now,
        updatedAt: now
      })
    }

    const started = await harness.chat.send({ sessionId, text: '当前问题必须保留' })
    await harness.chat.waitForIdle()

    const bodies = readBodies(mock.bodyLogPath)
    expect(bodies).toHaveLength(1)
    const sent = bodies[0].messages
    expect(sent.length).toBeLessThan(81)
    expect(sent[sent.length - 1]).toEqual({ role: 'user', content: '当前问题必须保留' })
    expect(sent.some((message) => message.content === `${long}-q0`)).toBe(false)
    const trimLog = harness.logs.find((entry) => entry.line === 'context_trimmed')
    expect(trimLog).toBeDefined()
    expect(trimLog?.fields?.currentUserKept).toBe(true)

    summary.contextTrim = {
      historyMessages: 80,
      sentMessages: sent.length,
      lastMessage: sent[sent.length - 1],
      oldestDropped: !sent.some((message) => message.content === `${long}-q0`),
      log: trimLog?.fields,
      requestId: started.requestId
    }
    writeEvidence('task-16-context-trim-run.json', summary.contextTrim)
  })

  it('chat:get-active returns in-memory content while streaming', async () => {
    const mock = await startMock({ mode: 'slow', chunks: 100, delay: 100, name: 'active' })
    const harness = await createHarness(mock.baseUrl)

    const started = await harness.chat.send({ sessionId: null, text: '查看活跃请求' })
    await waitFor(() => deltas(harness, started.requestId).length >= 1)

    const active = harness.chat.getActive()
    expect(active).not.toBeNull()
    expect(active?.requestId).toBe(started.requestId)
    expect(active?.sessionId).toBe(started.sessionId)
    expect(active?.status).toBe('streaming')
    expect((active?.content.length ?? 0)).toBeGreaterThan(0)
    expect(active?.content).toContain('chunk 1')

    const stopped = await harness.chat.stop(started.requestId)
    expect(stopped.stopped).toBe(true)
    expect(harness.chat.getActive()).toBeNull()
    expect(harness.chat.getActive()).toBeNull()

    summary.active = {
      requestId: active?.requestId,
      content: active?.content,
      status: active?.status,
      stopped: stopped.stopped,
      afterStop: harness.chat.getActive()
    }
    writeEvidence('task-16-active.json', summary.active)
  })
})

describe('task 16 evidence summary', () => {
  it('writes the summary file', () => {
    writeEvidence('task-16-summary.json', {
      task: 16,
      generatedAt: new Date().toISOString(),
      ...summary
    })
    expect(existsSync(join(evidenceDir, 'task-16-summary.json'))).toBe(true)
  })
})
