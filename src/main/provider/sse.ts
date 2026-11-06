/**
 * Strict Server-Sent Events parser for OpenAI-compatible chat completions
 * (plan D.3).
 *
 * Dependency-free. The parser owns a `TextDecoder('utf-8', {fatal:false})`
 * so a multi-byte character split across two network chunks is decoded
 * correctly. It handles CRLF/LF, multi-line `data:` fields (joined with
 * `\n`), comments (`:`), blank-line dispatch and a final `data: [DONE]`.
 *
 * The streaming layer emits raw event data strings; `parseSseEvent()` turns a
 * data payload into the fields QuickAsk cares about. Malformed JSON and
 * in-stream `{error:...}` objects are protocol errors and stop the stream.
 */

export const MAX_SSE_RESPONSE_BYTES = 10 * 1024 * 1024
export const PROTOCOL_SUMMARY_MAX = 300

export type SseUsage = {
  prompt_tokens?: number
  completion_tokens?: number
  total_tokens?: number
  [key: string]: unknown
}

export interface SseDelta {
  content: string | null
  reasoning: string | null
  finishReason: string | null
  usage: SseUsage | null
}

export type ParsedSseEvent = { type: 'done' } | ({ type: 'delta' } & SseDelta)

export type SseProtocolReason =
  | 'malformed_json'
  | 'sse_error_object'
  | 'non_sse_2xx'
  | 'response_too_large'
  | 'empty_body'

export class SseProtocolError extends Error {
  readonly code = 'protocol' as const
  readonly reason: SseProtocolReason
  readonly summary: string

  constructor(reason: SseProtocolReason, summary: string) {
    super(summary)
    this.name = 'SseProtocolError'
    this.reason = reason
    this.summary = summary
  }
}

function capSummary(value: string, max = PROTOCOL_SUMMARY_MAX): string {
  const text = value.replace(/\s+/g, ' ').trim()
  if (text.length <= max) return text
  return `${text.slice(0, Math.max(0, max - 3))}...`
}

/**
 * Parse one SSE `data:` payload.
 *
 * `data: [DONE]` (surrounding whitespace allowed) => `{type:'done'}`.
 * Any other payload must be JSON; `{error:...}` is a protocol error.
 */
export function parseSseEvent(data: string): ParsedSseEvent {
  const trimmed = data.trim()
  if (trimmed === '[DONE]') return { type: 'done' }

  let payload: unknown
  try {
    payload = JSON.parse(data)
  } catch {
    throw new SseProtocolError('malformed_json', capSummary(data))
  }

  if (typeof payload !== 'object' || payload === null) {
    throw new SseProtocolError('malformed_json', capSummary(data))
  }

  const record = payload as Record<string, unknown>
  if (record.error !== undefined && record.error !== null) {
    let summary: string
    try {
      summary = JSON.stringify(record.error)
    } catch {
      summary = String(record.error)
    }
    throw new SseProtocolError('sse_error_object', capSummary(summary))
  }

  const choices = Array.isArray(record.choices) ? record.choices : []
  const choice = (choices[0] ?? null) as Record<string, unknown> | null
  const delta = (choice?.delta ?? null) as Record<string, unknown> | null

  const content = typeof delta?.content === 'string' ? delta.content : null
  const reasoning =
    typeof delta?.reasoning_content === 'string' ? delta.reasoning_content : null
  const finishReason =
    typeof choice?.finish_reason === 'string' ? choice.finish_reason : null
  const usage =
    typeof record.usage === 'object' && record.usage !== null
      ? (record.usage as SseUsage)
      : null

  return { type: 'delta', content, reasoning, finishReason, usage }
}

export interface SseParserHandlers {
  /** Return `false` to stop parsing immediately (e.g. [DONE] or protocol error). */
  onEvent: (data: string) => boolean | void
  onComment?: (comment: string) => void
}

/**
 * Incremental SSE parser. Feed `Uint8Array` chunks as they arrive from the
 * network, then call `end()` once the body closes cleanly.
 */
export class SseParser {
  private readonly decoder = new TextDecoder('utf-8', { fatal: false })
  private line = ''
  private pendingCR = false
  private dataLines: string[] = []
  private firstChunk = true
  private stopped = false

  constructor(private readonly handlers: SseParserHandlers) {}

  get isStopped(): boolean {
    return this.stopped
  }

  feed(chunk: Uint8Array | string): void {
    if (this.stopped) return
    if (typeof chunk === 'string') {
      this.consume(chunk)
      return
    }
    const text = this.decoder.decode(chunk, { stream: true })
    if (text.length > 0) this.consume(text)
  }

  end(): void {
    if (this.stopped) return
    const tail = this.decoder.decode()
    if (tail.length > 0) this.consume(tail)
    if (this.stopped) return

    if (this.pendingCR) {
      this.pendingCR = false
      this.endLine()
    }
    if (this.line.length > 0) this.endLine()
    if (this.stopped) return

    // SSE spec: an event not terminated by a blank line is discarded on EOF.
    this.dataLines = []
  }

  private consume(text: string): void {
    let input = text
    if (this.firstChunk && input.length > 0) {
      this.firstChunk = false
      if (input.charCodeAt(0) === 0xfeff) input = input.slice(1)
    }

    for (let index = 0; index < input.length; index += 1) {
      const char = input[index]

      if (this.pendingCR) {
        this.pendingCR = false
        this.endLine()
        if (this.stopped) return
        if (char === '\n') continue
      }

      if (char === '\r') {
        this.pendingCR = true
      } else if (char === '\n') {
        this.endLine()
        if (this.stopped) return
      } else {
        this.line += char
      }
    }
  }

  private endLine(): void {
    const value = this.line
    this.line = ''
    this.handleLine(value)
  }

  private handleLine(value: string): void {
    if (value === '') {
      this.dispatch()
      return
    }
    if (value.startsWith(':')) {
      this.handlers.onComment?.(value)
      return
    }

    const colon = value.indexOf(':')
    let field: string
    let fieldValue: string
    if (colon === -1) {
      field = value
      fieldValue = ''
    } else {
      field = value.slice(0, colon)
      fieldValue = value.slice(colon + 1)
      if (fieldValue.startsWith(' ')) fieldValue = fieldValue.slice(1)
    }

    if (field === 'data') this.dataLines.push(fieldValue)
    // `event:`, `id:` and `retry:` are intentionally ignored.
  }

  private dispatch(): void {
    if (this.dataLines.length === 0) return
    const data = this.dataLines.join('\n')
    this.dataLines = []
    if (this.handlers.onEvent(data) === false) this.stopped = true
  }
}
