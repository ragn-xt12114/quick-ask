/**
 * Chat orchestrator (plan C.5 / D.1 / D.7 / D.8).
 *
 * One active request per process (M1). Sending while a stream is active first
 * aborts and fully finalizes it, so deltas from two requests can never
 * interleave. Stream text is kept in memory, emitted to the renderer
 * immediately and persisted in batches (250 ms or 1 KB), never per token.
 */

import {
  IPC,
  IMAGE_ONLY_PROMPT,
  MAX_CHAT_IMAGE_BYTES_TOTAL,
  MAX_CHAT_IMAGES,
  type ChatEndStatus,
  type IpcEventChannel
} from '../../shared/channels'
import type { ChatImage, ChatMessage } from '../../shared/channels'
import { IpcError, type IpcErrorCode } from '../../shared/ipc'
import { uuidv7 } from '../../shared/uuidv7'
import { isDbError } from '../db/errors'
import type { DbService } from '../db/service'
import type { ProviderClient, ProviderClientErrorCode, ProviderStreamProfile } from '../provider/client'
import type { ProviderService } from '../providers/service'
import type { ProviderProfile } from '../db/repositories/providers'
import type { SettingsService } from '../settings/service'
import { buildContextFromChatMessages, type BuiltContext } from './context'

export type ChatRequestAction = 'send' | 'retry' | 'regenerate'

export interface ActiveRequestState {
  requestId: string
  sessionId: string
  action: ChatRequestAction
  userMessageId: string
  assistantMessageId: string
  startedAt: number
  content: string
  model: string | null
  controller: AbortController
  userStopped: boolean
  quitting: boolean
  dbFailed: boolean
  finalized: boolean
  deltaCount: number
  lastFlushedChars: number
  flushTimer: ReturnType<typeof setTimeout> | null
  done: Promise<void>
  resolveDone: () => void
}

export interface ActiveChatView {
  requestId: string
  sessionId: string
  messageId: string
  startedAt: number
  content: string
  status: 'streaming'
}

export interface ChatOrchestratorLogger {
  (line: string, fields?: Record<string, string | number | boolean | null>): void
}

export interface ChatOrchestratorOptions {
  db: DbService
  providers: ProviderService
  client: ProviderClient
  emit: (channel: IpcEventChannel, payload: unknown) => void
  now?: () => number
  logger?: ChatOrchestratorLogger
  /** DB batch interval (default 250 ms). */
  batchMs?: number
  /** DB batch size in bytes (default 1 KB). */
  batchBytes?: number
  maxRounds?: number
  tokenBudget?: number
  settings?: SettingsService | null
}

export interface SendInput {
  sessionId: string | null
  text: string
  /** Clipboard images pasted into the composer (max 4, pre-sized by the renderer). */
  images?: ChatImage[]
}

export interface RetryInput {
  sessionId: string
  messageId: string
}

export interface RegenerateInput {
  sessionId: string
  messageId: string | null
}

export interface StartedChat {
  requestId: string
  sessionId: string
}

interface StartRequestInput {
  requestId: string
  sessionId: string
  action: ChatRequestAction
  userMessageId: string
  assistantMessageId: string
  profile: ProviderStreamProfile
  context: BuiltContext
}

const DEFAULT_BATCH_MS = 250
const DEFAULT_BATCH_BYTES = 1024
const DB_WRITE_ERROR_DETAIL = '本地保存失败（磁盘/权限）'

/** Map provider-client codes into the shared IPC error taxonomy. */
export function mapProviderErrorCode(
  code: ProviderClientErrorCode | undefined
): IpcErrorCode {
  switch (code) {
    case 'auth':
      return 'AUTH'
    case 'rate_limit':
      return 'RATE_LIMIT'
    case 'bad_request':
      return 'BAD_REQUEST'
    case 'server':
      return 'SERVER'
    case 'redirect':
      return 'REDIRECT'
    case 'protocol':
      return 'PROTOCOL'
    case 'timeout_connect':
    case 'timeout_headers':
    case 'timeout_idle':
    case 'timeout_total':
      return 'TIMEOUT'
    case 'network_dns':
    case 'network_refused':
    case 'network_tls':
    case 'network':
    case 'proxy':
      return 'NETWORK'
    case 'aborted':
      return 'ABORTED'
    default:
      return 'NETWORK'
  }
}

function isLoopbackBaseUrl(baseUrl: string): boolean {
  try {
    const hostname = new URL(baseUrl).hostname.toLowerCase().replace(/^\[|\]$/g, '')
    return hostname === 'localhost' || hostname === '::1' || /^127\./.test(hostname)
  } catch {
    return false
  }
}

function hasAuthHeader(headers: Record<string, string> | undefined): boolean {
  if (!headers) return false
  return Object.keys(headers).some(
    (name) => /authorization|api[-_]?key|token|secret|cookie/i.test(name)
  )
}

function hasCredential(profile: ProviderStreamProfile): boolean {
  const key = typeof profile.apiKey === 'string' ? profile.apiKey.trim() : ''
  return key.length > 0 || hasAuthHeader(profile.headers)
}

function configRequired(message: string): IpcError {
  return new IpcError('CONFIG_REQUIRED', message)
}

function dbWriteError(): IpcError {
  return new IpcError('DB_WRITE', '本地保存失败（磁盘/权限）')
}

export class ChatOrchestrator {
  private readonly db: DbService
  private readonly providers: ProviderService
  private readonly client: ProviderClient
  private readonly emitEvent: ChatOrchestratorOptions['emit']
  private readonly now: () => number
  private readonly log: ChatOrchestratorLogger
  private readonly batchMs: number
  private readonly batchBytes: number
  private readonly maxRounds: number | undefined
  private readonly tokenBudget: number | undefined
  private readonly settings: SettingsService | null

  private active: ActiveRequestState | null = null
  private activeListener: ((active: ActiveChatView | null) => void) | null = null

  constructor(options: ChatOrchestratorOptions) {
    this.db = options.db
    this.providers = options.providers
    this.client = options.client
    this.emitEvent = options.emit
    this.now = options.now ?? Date.now
    this.log = options.logger ?? (() => undefined)
    this.batchMs = options.batchMs ?? DEFAULT_BATCH_MS
    this.batchBytes = options.batchBytes ?? DEFAULT_BATCH_BYTES
    this.maxRounds = options.maxRounds
    this.tokenBudget = options.tokenBudget
    this.settings = options.settings ?? null
  }

  getActive(): ActiveChatView | null {
    const request = this.active
    if (!request) return null
    return {
      requestId: request.requestId,
      sessionId: request.sessionId,
      messageId: request.assistantMessageId,
      startedAt: request.startedAt,
      content: request.content,
      status: 'streaming'
    }
  }

  /** Session state subscribes here to mirror start/end without polling. */
  setActiveListener(listener: (active: ActiveChatView | null) => void): () => void {
    this.activeListener = listener
    return () => {
      if (this.activeListener === listener) this.activeListener = null
    }
  }

  private notifyActive(): void {
    if (!this.activeListener) return
    try {
      this.activeListener(this.getActive())
    } catch {
      // A state listener must never break streaming.
    }
  }

  /** Test/lifecycle helper: resolves when the current request has finalized. */
  async waitForIdle(): Promise<void> {
    const request = this.active
    if (request) await request.done
  }

  async send(input: SendInput): Promise<StartedChat> {
    const images = input.images ?? []
    if (images.length > MAX_CHAT_IMAGES) {
      throw new IpcError('INVALID_ARGUMENT', `最多只能附带 ${MAX_CHAT_IMAGES} 张图片`)
    }
    const imageBytes = images.reduce((total, image) => total + image.bytes, 0)
    if (imageBytes > MAX_CHAT_IMAGE_BYTES_TOTAL) {
      throw new IpcError('INVALID_ARGUMENT', '图片总大小超出限制')
    }

    const typed = typeof input.text === 'string' ? input.text : ''
    // Pasting a screenshot and hitting send without typing anything is a
    // first-class flow: substitute a neutral prompt so the model, the session
    // title and the history all stay coherent.
    const text = typed.trim().length > 0 ? typed : images.length > 0 ? IMAGE_ONLY_PROMPT : ''
    if (text.trim().length === 0) {
      throw new IpcError('INVALID_ARGUMENT', '消息不能为空')
    }

    // Config validation happens before any row or request is created.
    const profile = await this.resolveConfiguredProfile()
    await this.abortActive()

    let sessionId: string
    let userMessageId: string
    let assistantMessageId: string
    let userSeq: number
    try {
      const begin = this.db.beginSend({
        sessionId: input.sessionId,
        text,
        images: images.length > 0 ? images : undefined,
        model: profile.model || null
      })
      sessionId = begin.sessionId
      userMessageId = begin.userMessageId
      assistantMessageId = begin.assistantMessageId
      userSeq = begin.seq
    } catch (error) {
      throw this.mapDbError(error)
    }

    const context = this.buildContext(sessionId, userSeq)
    const requestId = uuidv7(this.now())
    this.startRequest({
      requestId,
      sessionId,
      action: 'send',
      userMessageId,
      assistantMessageId,
      profile,
      context
    })

    return { requestId, sessionId }
  }

  async stop(requestId: string): Promise<{ stopped: boolean }> {
    const request = this.active
    if (!request || request.requestId !== requestId) return { stopped: false }

    this.log('chat_stop_requested', {
      requestId: request.requestId,
      sessionId: request.sessionId
    })
    request.userStopped = true
    request.controller.abort()
    this.client.abort(requestId)
    await request.done
    this.log('chat_stop_completed', {
      requestId: request.requestId,
      sessionId: request.sessionId,
      status: 'stopped'
    })
    return { stopped: true }
  }

  async retry(input: RetryInput): Promise<StartedChat> {
    const target = this.db.messages.get(input.messageId)
    if (!target || target.sessionId !== input.sessionId) {
      throw new IpcError('NOT_FOUND', '消息不存在')
    }

    const pair = this.resolveRetryPair(input.sessionId, target)
    if (!pair) throw new IpcError('NOT_FOUND', '没有可重试的助手消息')

    const profile = await this.resolveConfiguredProfile()
    await this.abortActive()

    try {
      if (!this.db.resetAssistantForStream(pair.assistant.id, profile.model || null)) {
        throw dbWriteError()
      }
    } catch (error) {
      throw this.mapDbError(error)
    }

    const context = this.buildContext(input.sessionId, pair.user.seq)
    const requestId = uuidv7(this.now())
    this.startRequest({
      requestId,
      sessionId: input.sessionId,
      action: 'retry',
      userMessageId: pair.user.id,
      assistantMessageId: pair.assistant.id,
      profile,
      context
    })
    return { requestId, sessionId: input.sessionId }
  }

  async regenerate(input: RegenerateInput): Promise<StartedChat> {
    const messages = this.db.getMessages(input.sessionId)
    if (messages.length === 0) throw new IpcError('NOT_FOUND', '会话不存在')

    let target: ChatMessage | null = null
    if (input.messageId === null) {
      for (let index = messages.length - 1; index >= 0; index -= 1) {
        if (messages[index].role === 'assistant') {
          target = messages[index]
          break
        }
      }
    } else {
      const row = messages.find((message) => message.id === input.messageId)
      if (!row) throw new IpcError('NOT_FOUND', '消息不存在')
      if (row.role === 'assistant') target = row
      else if (row.role === 'user') {
        target =
          messages.find(
            (message) => message.role === 'assistant' && message.seq > row.seq
          ) ?? null
      }
    }
    if (!target) throw new IpcError('NOT_FOUND', '没有可重新生成的助手消息')

    const precedingUser = this.findPrecedingUser(messages, target.seq)
    if (!precedingUser) throw new IpcError('NOT_FOUND', '找不到对应的用户消息')

    const profile = await this.resolveConfiguredProfile()
    await this.abortActive()

    try {
      if (!this.db.resetAssistantForStream(target.id, profile.model || null)) {
        throw dbWriteError()
      }
    } catch (error) {
      throw this.mapDbError(error)
    }

    const context = this.buildContext(input.sessionId, precedingUser.seq)
    const requestId = uuidv7(this.now())
    this.startRequest({
      requestId,
      sessionId: input.sessionId,
      action: 'regenerate',
      userMessageId: precedingUser.id,
      assistantMessageId: target.id,
      profile,
      context
    })
    return { requestId, sessionId: input.sessionId }
  }

  /** Quit hook: abort and finalize (status stopped) within the lifecycle budget. */
  async abortAll(): Promise<void> {
    const request = this.active
    if (!request) return
    this.log('chat_abort_all', {
      requestId: request.requestId,
      sessionId: request.sessionId
    })
    request.quitting = true
    request.userStopped = true
    request.controller.abort()
    this.client.abort(request.requestId)
    await request.done
  }

  // -------------------------------------------------------------------------
  // Request lifecycle
  // -------------------------------------------------------------------------

  /**
   * Pick the profile for the *next* request. The explicit selection stored in
   * `settings.model.profileId` wins when it still exists; otherwise the
   * default profile and then the first profile are tried. A profile that can
   * no longer be resolved (deleted / missing credential) falls through to the
   * same fallback order. The returned snapshot is captured by the request, so
   * a later selection change never mutates an active stream.
   */
  private async resolveConfiguredProfile(): Promise<ProviderStreamProfile> {
    const profiles = this.db.providers.list()
    if (profiles.length === 0) {
      throw configRequired('请先在设置中配置模型提供商')
    }

    const selectedId = this.settings?.getModelSettings().profileId ?? null
    const ordered: ProviderProfile[] = []
    const push = (profile: ProviderProfile | undefined): void => {
      if (profile && !ordered.some((entry) => entry.id === profile.id)) ordered.push(profile)
    }
    push(selectedId !== null ? profiles.find((entry) => entry.id === selectedId) : undefined)
    push(profiles.find((entry) => entry.isDefault))
    push(profiles[0])

    let missingCredential = false
    for (const candidate of ordered) {
      let profile: ProviderStreamProfile
      try {
        profile = await this.providers.resolveStreamProfile(candidate.id)
      } catch {
        continue
      }
      if (!isLoopbackBaseUrl(profile.baseUrl) && !hasCredential(profile)) {
        missingCredential = true
        continue
      }

      const inference = this.settings?.getInference()
      if (inference) {
        return {
          ...profile,
          temperature: profile.temperature ?? inference.temperature,
          maxTokens: profile.maxTokens ?? inference.maxTokens,
          timeoutMs: profile.timeoutMs ?? inference.timeoutMs
        }
      }
      return profile
    }

    if (missingCredential) {
      throw configRequired('请先在设置中配置 API key')
    }
    throw configRequired('请先在设置中配置模型提供商')
  }

  private buildContext(sessionId: string, upToSeq: number): BuiltContext {
    const session = this.db.getSession(sessionId)
    const messages = this.db
      .getMessages(sessionId)
      .filter((message) => message.seq <= upToSeq)

    const inference = this.settings?.getInference()
    const configuredPrompt = inference?.systemPrompt.trim()
    const systemPrompt =
      configuredPrompt && configuredPrompt.length > 0
        ? inference?.systemPrompt ?? null
        : session?.systemPrompt ?? null
    const maxRounds = this.maxRounds ?? this.settings?.getBehavior().contextRounds

    const context = buildContextFromChatMessages(messages, {
      systemPrompt,
      ...(maxRounds !== undefined ? { maxRounds } : {}),
      ...(this.tokenBudget !== undefined ? { tokenBudget: this.tokenBudget } : {})
    })

    if (context.trimmed) {
      this.log('context_trimmed', {
        sessionId,
        droppedPairs: context.droppedPairs,
        estimatedTokens: context.estimatedTokens,
        messages: context.messages.length,
        currentUserKept: true
      })
    }
    return context
  }

  private startRequest(input: StartRequestInput): void {
    let resolveDone: () => void = () => undefined
    const done = new Promise<void>((resolve) => {
      resolveDone = resolve
    })

    const request: ActiveRequestState = {
      requestId: input.requestId,
      sessionId: input.sessionId,
      action: input.action,
      userMessageId: input.userMessageId,
      assistantMessageId: input.assistantMessageId,
      startedAt: this.now(),
      content: '',
      model: input.profile.model || null,
      controller: new AbortController(),
      userStopped: false,
      quitting: false,
      dbFailed: false,
      finalized: false,
      deltaCount: 0,
      lastFlushedChars: 0,
      flushTimer: null,
      done,
      resolveDone
    }
    this.active = request
    this.notifyActive()

    this.log('chat_request_started', {
      requestId: request.requestId,
      sessionId: request.sessionId,
      action: request.action,
      userMessageId: request.userMessageId,
      assistantMessageId: request.assistantMessageId,
      contextMessages: input.context.messages.length,
      estimatedTokens: input.context.estimatedTokens,
      trimmed: input.context.trimmed
    })

    void this.execute(request, input.profile, input.context)
  }

  private async execute(
    request: ActiveRequestState,
    profile: ProviderStreamProfile,
    context: BuiltContext
  ): Promise<void> {
    let result
    try {
      result = await this.client.streamChat({
        profile,
        messages: context.messages,
        requestId: request.requestId,
        signal: request.controller.signal,
        onDelta: (delta) => this.handleDelta(request, delta)
      })
    } catch {
      await this.finalize(request, 'error', {
        errorCode: 'INTERNAL',
        errorDetail: 'Internal error'
      })
      return
    }

    if (request.finalized) return

    if (result.status === 'complete') {
      await this.finalize(request, 'complete', {
        usageJson: result.usage ? JSON.stringify(result.usage) : null
      })
      return
    }

    if (result.status === 'aborted') {
      await this.finalize(request, 'stopped')
      return
    }

    const error = result.error
    await this.finalize(request, 'error', {
      errorCode: mapProviderErrorCode(error?.code),
      errorDetail: error?.detail || error?.message || 'Provider error'
    })
  }

  private handleDelta(request: ActiveRequestState, delta: string): void {
    if (request.finalized || request.userStopped || request.dbFailed) return
    if (delta.length === 0) return

    request.content += delta
    request.deltaCount += 1

    this.emit(IPC.EVENT_CHAT_DELTA, {
      requestId: request.requestId,
      sessionId: request.sessionId,
      messageId: request.assistantMessageId,
      delta
    })

    if (request.flushTimer === null) {
      request.flushTimer = setTimeout(() => {
        request.flushTimer = null
        this.flush(request)
      }, this.batchMs)
      request.flushTimer.unref?.()
    }

    const pending = request.content.slice(request.lastFlushedChars)
    if (Buffer.byteLength(pending, 'utf8') >= this.batchBytes) {
      this.flush(request)
    }
  }

  private flush(request: ActiveRequestState): void {
    if (request.finalized || request.dbFailed) return
    if (request.content.length === request.lastFlushedChars) return

    try {
      this.db.appendStream(request.assistantMessageId, request.content)
      request.lastFlushedChars = request.content.length
    } catch (error) {
      this.handleDbFailure(request, error)
    }
  }

  private handleDbFailure(request: ActiveRequestState, error: unknown): void {
    if (request.finalized || request.dbFailed) return
    request.dbFailed = true
    this.clearFlushTimer(request)

    this.log('chat_db_write_failed', {
      requestId: request.requestId,
      assistantMessageId: request.assistantMessageId,
      code: isDbError(error) ? error.code : 'DB_WRITE'
    })

    try {
      request.controller.abort()
    } catch {
      // already aborted
    }
    this.client.abort(request.requestId)

    void this.finalize(request, 'error', {
      errorCode: 'DB_WRITE',
      errorDetail: DB_WRITE_ERROR_DETAIL
    })
  }

  private async finalize(
    request: ActiveRequestState,
    status: ChatEndStatus,
    options: { errorCode?: IpcErrorCode | null; errorDetail?: string | null; usageJson?: string | null } = {}
  ): Promise<void> {
    if (request.finalized) return
    request.finalized = true
    this.clearFlushTimer(request)

    let finalStatus: ChatEndStatus = status
    let errorCode = options.errorCode ?? null
    let errorDetail = options.errorDetail ?? null

    if (request.dbFailed) {
      finalStatus = 'error'
      errorCode = 'DB_WRITE'
      errorDetail = DB_WRITE_ERROR_DETAIL
    } else if (
      request.content.length > 0 &&
      request.content.length !== request.lastFlushedChars
    ) {
      try {
        this.db.appendStream(request.assistantMessageId, request.content)
        request.lastFlushedChars = request.content.length
      } catch (error) {
        this.log('chat_db_write_failed', {
          requestId: request.requestId,
          assistantMessageId: request.assistantMessageId,
          phase: 'final_flush',
          code: isDbError(error) ? error.code : 'DB_WRITE'
        })
        finalStatus = 'error'
        errorCode = 'DB_WRITE'
        errorDetail = DB_WRITE_ERROR_DETAIL
      }
    }

    try {
      this.db.finishStream(request.assistantMessageId, finalStatus, {
        errorCode: finalStatus === 'error' ? errorCode : null,
        errorDetail: finalStatus === 'error' ? errorDetail : null,
        usageJson: options.usageJson ?? null,
        model: request.model
      })
    } catch (error) {
      this.log('chat_finish_failed', {
        requestId: request.requestId,
        assistantMessageId: request.assistantMessageId,
        code: isDbError(error) ? error.code : 'DB_WRITE'
      })
      if (finalStatus !== 'error' || errorCode !== 'DB_WRITE') {
        finalStatus = 'error'
        errorCode = 'DB_WRITE'
        errorDetail = DB_WRITE_ERROR_DETAIL
        try {
          this.db.finishStream(request.assistantMessageId, 'error', {
            errorCode: 'DB_WRITE',
            errorDetail: DB_WRITE_ERROR_DETAIL,
            model: request.model
          })
        } catch {
          // DB is gone; the error is still surfaced through chat:end below.
        }
      }
    }

    this.active = null
    this.notifyActive()

    this.emit(IPC.EVENT_CHAT_END, {
      requestId: request.requestId,
      sessionId: request.sessionId,
      messageId: request.assistantMessageId,
      status: finalStatus,
      errorCode: finalStatus === 'error' ? errorCode : null,
      errorDetail: finalStatus === 'error' ? errorDetail : null
    })

    this.log('chat_request_end', {
      requestId: request.requestId,
      sessionId: request.sessionId,
      action: request.action,
      assistantMessageId: request.assistantMessageId,
      status: finalStatus,
      errorCode: finalStatus === 'error' ? (errorCode ?? null) : null,
      deltas: request.deltaCount,
      contentChars: request.content.length
    })

    request.resolveDone()
  }

  /** Abort and fully finalize the active request before a new request starts. */
  private async abortActive(): Promise<void> {
    const request = this.active
    if (!request) return
    this.log('chat_abort_active', {
      requestId: request.requestId,
      sessionId: request.sessionId,
      action: request.action
    })
    request.userStopped = true
    request.controller.abort()
    this.client.abort(request.requestId)
    await request.done
  }

  private emit(channel: IpcEventChannel, payload: unknown): void {
    try {
      this.emitEvent(channel, payload)
    } catch (error) {
      this.log('chat_emit_failed', {
        channel,
        code: error instanceof Error ? error.name : 'unknown'
      })
    }
  }

  private clearFlushTimer(request: ActiveRequestState): void {
    if (request.flushTimer !== null) {
      clearTimeout(request.flushTimer)
      request.flushTimer = null
    }
  }

  private resolveRetryPair(
    sessionId: string,
    target: ChatMessage
  ): { user: ChatMessage; assistant: ChatMessage } | null {
    const messages = this.db.getMessages(sessionId)

    if (target.role === 'assistant') {
      const user = this.findPrecedingUser(messages, target.seq)
      return user ? { user, assistant: target } : null
    }

    if (target.role === 'user') {
      const assistant =
        messages.find(
          (message) => message.role === 'assistant' && message.seq > target.seq
        ) ?? null
      return assistant ? { user: target, assistant } : null
    }

    return null
  }

  private findPrecedingUser(messages: ChatMessage[], seq: number): ChatMessage | null {
    for (let index = messages.length - 1; index >= 0; index -= 1) {
      const message = messages[index]
      if (message.seq >= seq) continue
      if (message.role === 'user') return message
    }
    return null
  }

  private mapDbError(error: unknown): IpcError {
    if (error instanceof IpcError) return error
    if (isDbError(error)) {
      if (error.code === 'DB_NOT_FOUND') return new IpcError('NOT_FOUND', '会话不存在')
      return dbWriteError()
    }
    return dbWriteError()
  }
}

export function createChatOrchestrator(options: ChatOrchestratorOptions): ChatOrchestrator {
  return new ChatOrchestrator(options)
}
