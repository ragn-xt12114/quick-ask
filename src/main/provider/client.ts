/**
 * Provider streaming client (plan D.2–D.7).
 *
 * Main process only. Uses an explicitly declared `undici` dependency so the
 * HTTP stack is the same in dev, tests and the packaged app.
 *
 * Guarantees:
 *  - POST `<base>/v1/chat/completions` with `{model, messages, stream:true}`.
 *  - `redirect: 'error'`: redirects are never followed, so `Authorization`
 *    can never be forwarded to another origin.
 *  - HTTP errors are typed (auth/rate_limit/bad_request/server/redirect) and
 *    are never retried automatically.
 *  - 2xx without `text/event-stream` is a protocol error, even if it is JSON.
 *  - connect/headers/idle/total timeouts are enforced independently.
 *  - `abort(requestId)` aborts the request and destroys the dispatcher so the
 *    server observes a closed socket; late chunks are discarded.
 *  - no header value, request body or API key is ever logged.
 */

import { fetch as undiciFetch } from 'undici'
import type { Dispatcher } from 'undici'
import type { ChatContentPart } from '../../shared/channels'
import { redactSummary } from '../secrets/redact'
import type { OutboundGuard } from '../net/guard'
import {
  createProxyDispatcher,
  ProviderProxyError,
  resolveProfileProxy,
  shouldBypassProxy as shouldBypassProxyImpl,
  type ProviderProxyMode
} from './proxy'
import {
  MAX_SSE_RESPONSE_BYTES,
  parseSseEvent,
  SseParser,
  SseProtocolError,
  type SseUsage
} from './sse'
import { buildProviderHeaders, opencodeSessionIdFor } from './headers'
import {
  chatCompletionsUrl,
  ProviderUrlError,
  redactProviderUrl
} from './url'

export type ProviderClientErrorCode =
  | 'network_dns'
  | 'network_refused'
  | 'network_tls'
  | 'network'
  | 'proxy'
  | 'timeout_connect'
  | 'timeout_headers'
  | 'timeout_idle'
  | 'timeout_total'
  | 'auth'
  | 'rate_limit'
  | 'bad_request'
  | 'server'
  | 'protocol'
  | 'redirect'
  | 'aborted'

const ERROR_MESSAGES: Record<ProviderClientErrorCode, string> = {
  network_dns: '无法解析域名，请检查 base_url/DNS',
  network_refused: '连接被拒绝，服务未启动？',
  network_tls: 'TLS 证书校验失败',
  network: '网络错误',
  proxy: '代理不可用/认证失败',
  timeout_connect: '请求超时（连接）',
  timeout_headers: '请求超时（等待响应头）',
  timeout_idle: '请求超时（流空闲）',
  timeout_total: '请求超时（总时长）',
  auth: '认证失败，请检查 API key/权限',
  rate_limit: '限流，稍后再试（不自动重试）',
  bad_request: '请求被拒绝（模型/参数）',
  server: '服务端错误',
  protocol: '响应格式不符合 OpenAI 兼容协议',
  redirect: '端点重定向被阻止（防止 key 泄露）',
  aborted: '已停止'
}

export class ProviderClientError extends Error {
  readonly code: ProviderClientErrorCode
  /** Redacted, ≤300 chars. Safe to show in the UI. */
  readonly detail: string
  readonly status: number | null

  constructor(
    code: ProviderClientErrorCode,
    detail = '',
    options: { status?: number | null; cause?: unknown } = {}
  ) {
    const safeDetail = redactSummary(detail, 300)
    super(ERROR_MESSAGES[code], { cause: options.cause })
    this.name = 'ProviderClientError'
    this.code = code
    this.detail = safeDetail
    this.status = options.status ?? null
  }
}

export interface ProviderTimeouts {
  connectMs: number
  headersMs: number
  idleMs: number
  totalMs: number
}

export const DEFAULT_PROVIDER_TIMEOUTS: ProviderTimeouts = {
  connectMs: 10_000,
  headersMs: 30_000,
  idleMs: 60_000,
  totalMs: 10 * 60_000
}

export interface ProviderStreamProfile {
  id?: string
  baseUrl: string
  model: string
  apiKey?: string | null
  headers?: Record<string, string>
  /** `direct` | `system` | `custom`; legacy values are normalized. */
  proxyMode?: string
  /** Custom proxy URL; may include keyring auth for the in-memory request. */
  proxyUrl?: string | null
  temperature?: number | null
  maxTokens?: number | null
  timeoutMs?: number
}

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant'
  /** Plain text, or OpenAI-style multimodal parts when the turn has images. */
  content: string | ChatContentPart[]
}

export interface StreamChatOptions {
  profile: ProviderStreamProfile
  messages: ChatMessage[]
  requestId: string
  onDelta?: (content: string) => void
  onDone?: (result: StreamChatResult) => void
  onError?: (error: ProviderClientError) => void
  signal?: AbortSignal
}

export interface StreamChatResult {
  requestId: string
  status: 'complete' | 'aborted' | 'error'
  content: string
  reasoningChunks: number
  comments: number
  finishReason: string | null
  usage: SseUsage | null
  sawDone: boolean
  httpStatus: number | null
  elapsedMs: number
  /** Number of content deltas emitted (no content itself). */
  deltaCount?: number
  /** Raw response bytes received (SSE framing included). */
  receivedBytes?: number
  error?: ProviderClientError
}

export interface ActiveRequestInfo {
  requestId: string
  startedAt: number
  /** Redacted endpoint (scheme + host + path). */
  url: string
}

export type ProviderEnv = Record<string, string | undefined>

export type ProviderLogFields = Record<string, unknown>

export interface ProviderClientLogger {
  info(event: string, fields?: ProviderLogFields): void
  warn(event: string, fields?: ProviderLogFields): void
}

export interface ProviderClientOptions {
  env?: ProviderEnv
  version?: string
  timeouts?: Partial<ProviderTimeouts>
  /** Test hook; defaults to `undici.fetch`. */
  fetchImpl?: typeof undiciFetch
  /** Test hook; defaults to a per-request `Agent` / `ProxyAgent`. */
  dispatcherFactory?: (
    proxy: string | null,
    target: URL,
    timeouts: ProviderTimeouts
  ) => Dispatcher
  now?: () => number
  /** Runtime outbound allowlist (Task 17). */
  guard?: OutboundGuard
  /** Structured provider events: request id/status/timing/counts only. */
  logger?: ProviderClientLogger
}

interface ActiveEntry {
  requestId: string
  startedAt: number
  url: string
  controller: AbortController
  dispatcher: Dispatcher | null
  abortReason: ProviderClientErrorCode | null
}

/** Always bypass loopback; honour NO_PROXY / no_proxy for everything else. */
export function shouldBypassProxy(target: URL, env: ProviderEnv = process.env): boolean {
  return shouldBypassProxyImpl(target, env)
}

/**
 * Resolve the system-environment proxy URI for a target. Returns `null` for a
 * direct connection. Throws a `proxy` error for SOCKS or invalid URLs.
 * Custom-profile selection lives in `resolveProfileProxy`.
 */
export function resolveProxyForUrl(
  target: URL,
  env: ProviderEnv = process.env
): string | null {
  const profile: { proxyMode: ProviderProxyMode; proxyUrl: null } = {
    proxyMode: 'system',
    proxyUrl: null
  }
  try {
    return resolveProfileProxy(target, profile, env)
  } catch (error) {
    if (error instanceof ProviderProxyError) {
      throw new ProviderClientError('proxy', error.message, { cause: error })
    }
    throw error
  }
}

function codeOf(error: unknown): string {
  if (typeof error !== 'object' || error === null) return ''
  const record = error as Record<string, unknown>
  const cause = record.cause
  if (typeof cause === 'object' && cause !== null) {
    const causeRecord = cause as Record<string, unknown>
    if (typeof causeRecord.code === 'string') return causeRecord.code
    if (typeof causeRecord.errno === 'string') return causeRecord.errno
  }
  if (typeof record.code === 'string') return record.code
  if (typeof record.errno === 'string') return record.errno
  return ''
}

function messageOf(error: unknown): string {
  if (error instanceof Error) {
    const cause = error.cause
    if (cause instanceof Error && cause.message) return `${error.message} ${cause.message}`
    return error.message
  }
  return String(error)
}

const TLS_CODES = new Set([
  'CERT_HAS_EXPIRED',
  'DEPTH_ZERO_SELF_SIGNED_CERT',
  'SELF_SIGNED_CERT_IN_CHAIN',
  'UNABLE_TO_VERIFY_LEAF_SIGNATURE',
  'UNABLE_TO_GET_ISSUER_CERT_LOCALLY',
  'ERR_TLS_CERT_ALTNAME_INVALID',
  'ERR_SSL_WRONG_VERSION_NUMBER',
  'ERR_SSL_PACKET_LENGTH_TOO_LONG'
])

function mapNetworkError(
  error: unknown,
  options: { proxyConfigured: boolean }
): ProviderClientError {
  const code = codeOf(error).toUpperCase()
  const message = messageOf(error)
  const upperMessage = message.toUpperCase()

  if (code === 'UND_ERR_REDIRECT' || upperMessage.includes('REDIRECT')) {
    return new ProviderClientError('redirect', message, { cause: error })
  }
  if (TLS_CODES.has(code) || /CERT|TLS|SSL|SELF SIGNED/i.test(message)) {
    return new ProviderClientError('network_tls', message, { cause: error })
  }
  if (code === 'UND_ERR_HEADERS_TIMEOUT' || upperMessage.includes('HEADERS TIMEOUT')) {
    return new ProviderClientError('timeout_headers', message, { cause: error })
  }
  if (code === 'UND_ERR_BODY_TIMEOUT' || upperMessage.includes('BODY TIMEOUT')) {
    return new ProviderClientError('timeout_idle', message, { cause: error })
  }
  if (code === 'UND_ERR_CONNECT_TIMEOUT' || upperMessage.includes('CONNECT TIMEOUT')) {
    if (options.proxyConfigured && /PROXY|TUNNEL/i.test(message)) {
      return new ProviderClientError('proxy', message, { cause: error })
    }
    return new ProviderClientError('timeout_connect', message, { cause: error })
  }
  if (options.proxyConfigured) {
    return new ProviderClientError('proxy', message, { cause: error })
  }
  if (code === 'ENOTFOUND' || code === 'EAI_AGAIN' || upperMessage.includes('ENOTFOUND')) {
    return new ProviderClientError('network_dns', message, { cause: error })
  }
  if (code === 'ECONNREFUSED' || upperMessage.includes('ECONNREFUSED')) {
    return new ProviderClientError('network_refused', message, { cause: error })
  }
  return new ProviderClientError('network', message, { cause: error })
}

function statusToClientError(
  status: number,
  detail: string
): ProviderClientError {
  if (status >= 300 && status < 400) {
    return new ProviderClientError('redirect', detail, { status })
  }
  if (status === 401 || status === 403) {
    return new ProviderClientError('auth', detail, { status })
  }
  if (status === 429) {
    return new ProviderClientError('rate_limit', detail, { status })
  }
  if (status >= 400 && status < 500) {
    return new ProviderClientError('bad_request', detail, { status })
  }
  if (status >= 500) {
    return new ProviderClientError('server', detail, { status })
  }
  return new ProviderClientError('protocol', detail, { status })
}

async function readBodyLimited(
  body: ReadableStream<Uint8Array> | null,
  limit: number
): Promise<string> {
  if (!body) return ''
  const reader = body.getReader()
  const decoder = new TextDecoder('utf-8', { fatal: false })
  let total = 0
  let text = ''
  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      total += value.byteLength
      if (total > limit) {
        const keep = Math.max(0, value.byteLength - (total - limit))
        text += decoder.decode(value.subarray(0, keep), { stream: true })
        break
      }
      text += decoder.decode(value, { stream: true })
    }
  } finally {
    try {
      await reader.cancel()
    } catch {
      // body already closed / locked
    }
  }
  text += decoder.decode()
  return text
}

function defaultDispatcherFactory(
  proxy: string | null,
  _target: URL,
  timeouts: ProviderTimeouts
): Dispatcher {
  return createProxyDispatcher(proxy, timeouts)
}

export class ProviderClient {
  private readonly env: ProviderEnv
  private readonly version: string
  private readonly timeouts: ProviderTimeouts
  private readonly fetchImpl: typeof undiciFetch
  private readonly dispatcherFactory: NonNullable<ProviderClientOptions['dispatcherFactory']>
  private readonly now: () => number
  private readonly guard: OutboundGuard | null
  private readonly logger: ProviderClientLogger | null
  private readonly active = new Map<string, ActiveEntry>()

  constructor(options: ProviderClientOptions = {}) {
    this.env = options.env ?? process.env
    this.version = options.version ?? '0.0.0'
    this.timeouts = { ...DEFAULT_PROVIDER_TIMEOUTS, ...options.timeouts }
    this.fetchImpl = options.fetchImpl ?? undiciFetch
    this.dispatcherFactory = options.dispatcherFactory ?? defaultDispatcherFactory
    this.now = options.now ?? Date.now
    this.guard = options.guard ?? null
    this.logger = options.logger ?? null
  }

  getActive(): ActiveRequestInfo[] {
    return Array.from(this.active.values()).map((entry) => ({
      requestId: entry.requestId,
      startedAt: entry.startedAt,
      url: entry.url
    }))
  }

  abort(requestId: string): boolean {
    const entry = this.active.get(requestId)
    if (!entry) return false
    this.abortEntry(entry, 'aborted')
    return true
  }

  abortAll(): void {
    for (const entry of Array.from(this.active.values())) {
      this.abortEntry(entry, 'aborted')
    }
  }

  /**
   * Stream a chat completion. Resolves with a result; errors are also passed
   * to `onError`. Never retries.
   */
  async streamChat(options: StreamChatOptions): Promise<StreamChatResult> {
    const startedAt = this.now()
    const { requestId } = options

    let url: string
    try {
      url = chatCompletionsUrl(options.profile.baseUrl)
    } catch (error) {
      const mapped =
        error instanceof ProviderUrlError
          ? new ProviderClientError('protocol', error.message, { cause: error })
          : new ProviderClientError('protocol', 'base_url 无效', { cause: error })
      return this.finishError(requestId, startedAt, null, mapped, options)
    }

    try {
      this.guard?.assertAllowedOutbound(url)
    } catch (error) {
      const mapped =
        error instanceof Error
          ? new ProviderClientError('network', error.message, { cause: error })
          : new ProviderClientError('network', 'Outbound blocked')
      return this.finishError(requestId, startedAt, null, mapped, options)
    }

    if (this.active.has(requestId)) {
      const error = new ProviderClientError('protocol', 'requestId 已在流式中')
      return this.finishError(requestId, startedAt, null, error, options)
    }

    const controller = new AbortController()
    const entry: ActiveEntry = {
      requestId,
      startedAt,
      url: redactProviderUrl(url),
      controller,
      dispatcher: null,
      abortReason: null
    }
    this.active.set(requestId, entry)

    let proxy: string | null
    try {
      proxy = resolveProfileProxy(new URL(url), options.profile, this.env)
      entry.dispatcher = this.dispatcherFactory(proxy, new URL(url), this.timeouts)
    } catch (error) {
      this.active.delete(requestId)
      const mapped =
        error instanceof ProviderClientError
          ? error
          : new ProviderClientError('proxy', messageOf(error), { cause: error })
      return this.finishError(requestId, startedAt, null, mapped, options)
    }

    let headersResult: ReturnType<typeof buildProviderHeaders>
    try {
      headersResult = buildProviderHeaders({
        apiKey: options.profile.apiKey,
        customHeaders: options.profile.headers,
        version: this.version,
        accept: 'text/event-stream',
        baseUrl: options.profile.baseUrl,
        opencodeSessionId: opencodeSessionIdFor(
          options.profile.id ?? options.profile.baseUrl
        )
      })
    } catch (error) {
      this.active.delete(requestId)
      const dispatcher = entry.dispatcher
      entry.dispatcher = null
      if (dispatcher) await dispatcher.destroy().catch(() => undefined)
      const mapped = new ProviderClientError('bad_request', messageOf(error), { cause: error })
      return this.finishError(requestId, startedAt, null, mapped, options)
    }

    this.logEvent('info', 'provider_request_start', {
      requestId,
      providerId: options.profile.id ?? null,
      model: options.profile.model,
      endpoint: redactProviderUrl(url),
      proxy: proxy !== null,
      messageCount: options.messages.length
    })

    const bodyRecord: Record<string, unknown> = {
      model: options.profile.model,
      messages: options.messages,
      stream: true
    }
    if (options.profile.temperature !== undefined && options.profile.temperature !== null) {
      bodyRecord.temperature = options.profile.temperature
    }
    if (options.profile.maxTokens !== undefined && options.profile.maxTokens !== null) {
      bodyRecord.max_tokens = options.profile.maxTokens
    }
    const body = JSON.stringify(bodyRecord)

    let sawDone = false
    let content = ''
    let reasoningChunks = 0
    let comments = 0
    let finishReason: string | null = null
    let usage: SseUsage | null = null
    let httpStatus: number | null = null
    let protocolError: ProviderClientError | null = null
    let reader: ReadableStreamDefaultReader<Uint8Array> | null = null
    let receivedBytes = 0
    let deltaCount = 0

    let headersTimer: ReturnType<typeof setTimeout> | null = null
    let idleTimer: ReturnType<typeof setTimeout> | null = null
    let totalTimer: ReturnType<typeof setTimeout> | null = null

    const clearTimers = (): void => {
      if (headersTimer) clearTimeout(headersTimer)
      if (idleTimer) clearTimeout(idleTimer)
      if (totalTimer) clearTimeout(totalTimer)
      headersTimer = null
      idleTimer = null
      totalTimer = null
    }

    const abortWith = (code: ProviderClientErrorCode): void => {
      if (entry.abortReason) return
      entry.abortReason = code
      try {
        controller.abort()
      } catch {
        // already aborted
      }
      const dispatcher = entry.dispatcher
      if (dispatcher) {
        void dispatcher.destroy().catch(() => undefined)
      }
    }

    const resetIdle = (): void => {
      if (idleTimer) clearTimeout(idleTimer)
      idleTimer = setTimeout(() => abortWith('timeout_idle'), this.timeouts.idleMs)
    }

    totalTimer = setTimeout(() => abortWith('timeout_total'), this.timeouts.totalMs)
    const headersTimeoutMs =
      options.profile.timeoutMs !== undefined && options.profile.timeoutMs > 0
        ? options.profile.timeoutMs
        : this.timeouts.headersMs
    headersTimer = setTimeout(() => abortWith('timeout_headers'), headersTimeoutMs)

    const externalAbort = (): void => abortWith('aborted')
    if (options.signal) {
      if (options.signal.aborted) externalAbort()
      else options.signal.addEventListener('abort', externalAbort, { once: true })
    }

    const parser = new SseParser({
      onEvent: (data) => {
        if (entry.abortReason) return false
        let event
        try {
          event = parseSseEvent(data)
        } catch (error) {
          if (error instanceof SseProtocolError) {
            protocolError = new ProviderClientError('protocol', error.summary, { cause: error })
          } else {
            protocolError = new ProviderClientError('protocol', messageOf(error), { cause: error })
          }
          return false
        }

        if (event.type === 'done') {
          sawDone = true
          return false
        }

        if (event.content !== null && event.content.length > 0) {
          content += event.content
          deltaCount += 1
          try {
            options.onDelta?.(event.content)
          } catch {
            // A consumer callback must not break the stream bookkeeping.
          }
        }
        if (event.reasoning !== null && event.reasoning.length > 0) {
          reasoningChunks += 1
        }
        if (event.finishReason !== null) finishReason = event.finishReason
        if (event.usage !== null) usage = event.usage
        return true
      },
      onComment: () => {
        comments += 1
      }
    })

    try {
      const response = await this.fetchImpl(url, {
        method: 'POST',
        headers: headersResult.headers,
        body,
        redirect: 'error',
        signal: controller.signal,
        dispatcher: entry.dispatcher
      })
      httpStatus = response.status

      if (headersTimer) {
        clearTimeout(headersTimer)
        headersTimer = null
      }

      if (entry.abortReason) {
        // Timeout/abort won the race with headers; fall through to cleanup.
      } else if (response.status >= 300 && response.status < 400) {
        const detail = await readBodyLimited(response.body, 64 * 1024)
        protocolError = statusToClientError(
          response.status,
          redactSummary(detail || `HTTP ${response.status}`, 300)
        )
      } else if (response.status < 200 || response.status >= 300) {
        const detail = await readBodyLimited(response.body, 64 * 1024)
        protocolError = statusToClientError(
          response.status,
          redactSummary(detail || `HTTP ${response.status}`, 300)
        )
      } else {
        const contentType = response.headers.get('content-type') ?? ''
        if (!/text\/event-stream/i.test(contentType)) {
          const detail = await readBodyLimited(response.body, 1024 * 1024)
          protocolError = new ProviderClientError(
            'protocol',
            redactSummary(detail || `HTTP ${response.status} without text/event-stream`, 300),
            { status: response.status }
          )
        } else if (!response.body) {
          protocolError = new ProviderClientError('protocol', '响应没有 body', {
            status: response.status
          })
        } else {
          reader = response.body.getReader()
          resetIdle()

          for (;;) {
            if (entry.abortReason || protocolError) break

            let chunk: { done: boolean; value?: Uint8Array }
            try {
              chunk = await reader.read()
            } catch (error) {
              if (entry.abortReason) break
              protocolError = mapNetworkError(error, { proxyConfigured: proxy !== null })
              break
            }

            if (entry.abortReason) break
            if (chunk.done) break

            const value = chunk.value
            if (!value) continue
            if (value.byteLength > 0) {
              receivedBytes += value.byteLength
              if (receivedBytes > MAX_SSE_RESPONSE_BYTES) {
                protocolError = new ProviderClientError(
                  'protocol',
                  `响应超过 ${MAX_SSE_RESPONSE_BYTES} bytes`,
                  { status: httpStatus }
                )
                abortWith('protocol')
                break
              }
            }

            resetIdle()
            parser.feed(value)
            if (parser.isStopped) break
          }
        }
      }
    } catch (error) {
      if (!entry.abortReason) {
        protocolError = mapNetworkError(error, { proxyConfigured: proxy !== null })
      }
    } finally {
      clearTimers()
      if (options.signal) options.signal.removeEventListener('abort', externalAbort)

      if (reader) {
        if (parser.isStopped || protocolError || entry.abortReason) {
          try {
            await reader.cancel()
          } catch {
            // locked / already closed
          }
        } else {
          try {
            parser.end()
          } catch {
            // no-op; parse errors are surfaced through onEvent
          }
        }
      }

      const dispatcher = entry.dispatcher
      entry.dispatcher = null
      if (dispatcher) {
        if (protocolError || entry.abortReason) {
          await dispatcher.destroy().catch(() => undefined)
        } else {
          await dispatcher.close().catch(() => undefined)
        }
      }
      this.active.delete(requestId)
    }

    const elapsedMs = this.now() - startedAt

    if (entry.abortReason) {
      const code = entry.abortReason
      const error =
        protocolError ??
        new ProviderClientError(code, code === 'aborted' ? '用户停止' : ERROR_MESSAGES[code], {
          status: httpStatus
        })
      return this.finishError(requestId, startedAt, httpStatus, error, options, {
        content,
        reasoningChunks,
        comments,
        finishReason,
        usage,
        sawDone,
        elapsedMs,
        deltaCount,
        receivedBytes
      })
    }

    if (protocolError) {
      return this.finishError(requestId, startedAt, httpStatus, protocolError, options, {
        content,
        reasoningChunks,
        comments,
        finishReason,
        usage,
        sawDone,
        elapsedMs,
        deltaCount,
        receivedBytes
      })
    }

    const result: StreamChatResult = {
      requestId,
      status: 'complete',
      content,
      reasoningChunks,
      comments,
      finishReason,
      usage,
      sawDone,
      httpStatus,
      elapsedMs,
      deltaCount,
      receivedBytes
    }
    this.logEnd(result)
    try {
      options.onDone?.(result)
    } catch {
      // Consumer callback failures do not change the result.
    }
    return result
  }

  private logEvent(
    level: 'info' | 'warn',
    event: string,
    fields: ProviderLogFields
  ): void {
    if (!this.logger) return
    try {
      this.logger[level](event, fields)
    } catch {
      // Logging must never break the request path.
    }
  }

  private logEnd(result: StreamChatResult): void {
    this.logEvent(result.status === 'error' ? 'warn' : 'info', 'provider_request_end', {
      requestId: result.requestId,
      status: result.status,
      errorCode: result.error?.code ?? null,
      httpStatus: result.httpStatus,
      elapsedMs: result.elapsedMs,
      deltaCount: result.deltaCount ?? 0,
      contentBytes: Buffer.byteLength(result.content, 'utf8'),
      receivedBytes: result.receivedBytes ?? 0
    })
  }

  private abortEntry(entry: ActiveEntry, code: ProviderClientErrorCode): void {
    if (entry.abortReason) return
    entry.abortReason = code
    try {
      entry.controller.abort()
    } catch {
      // already aborted
    }
    if (entry.dispatcher) {
      void entry.dispatcher.destroy().catch(() => undefined)
    }
  }

  private finishError(
    requestId: string,
    startedAt: number,
    httpStatus: number | null,
    error: ProviderClientError,
    options: StreamChatOptions,
    partial: {
      content?: string
      reasoningChunks?: number
      comments?: number
      finishReason?: string | null
      usage?: SseUsage | null
      sawDone?: boolean
      elapsedMs?: number
      deltaCount?: number
      receivedBytes?: number
    } = {}
  ): StreamChatResult {
    const result: StreamChatResult = {
      requestId,
      status: error.code === 'aborted' ? 'aborted' : 'error',
      content: partial.content ?? '',
      reasoningChunks: partial.reasoningChunks ?? 0,
      comments: partial.comments ?? 0,
      finishReason: partial.finishReason ?? null,
      usage: partial.usage ?? null,
      sawDone: partial.sawDone ?? false,
      httpStatus,
      elapsedMs: partial.elapsedMs ?? this.now() - startedAt,
      deltaCount: partial.deltaCount ?? 0,
      receivedBytes: partial.receivedBytes ?? 0,
      error
    }
    this.logEnd(result)
    try {
      options.onError?.(error)
    } catch {
      // Consumer callback failures do not change the result.
    }
    return result
  }
}

/** Factory used by the chat orchestrator (Task 16) and lifecycle hooks. */
export function createProviderClient(options: ProviderClientOptions = {}): ProviderClient {
  return new ProviderClient(options)
}
