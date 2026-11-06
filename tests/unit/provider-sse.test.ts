import { describe, expect, it } from 'vitest'
import {
  parseSseEvent,
  SseParser,
  SseProtocolError,
  type ParsedSseEvent
} from '../../src/main/provider/sse'

function collect(chunks: Array<Uint8Array | string>): {
  events: ParsedSseEvent[]
  comments: string[]
  raw: string[]
  parser: SseParser
} {
  const events: ParsedSseEvent[] = []
  const comments: string[] = []
  const raw: string[] = []
  const parser = new SseParser({
    onEvent: (data) => {
      raw.push(data)
      events.push(parseSseEvent(data))
    },
    onComment: (comment) => comments.push(comment)
  })
  for (const chunk of chunks) parser.feed(chunk)
  parser.end()
  return { events, comments, raw, parser }
}

const encoder = new TextEncoder()

describe('SSE parser (D.3)', () => {
  it('parses a normal stream and [DONE] with surrounding spaces', () => {
    const result = collect([
      encoder.encode(
        'data: {"choices":[{"index":0,"delta":{"content":"hello"}}]}\n\n' +
          'data:  [DONE]  \n\n'
      )
    ])
    expect(result.events).toHaveLength(2)
    expect(result.events[0]).toMatchObject({ type: 'delta', content: 'hello' })
    expect(result.events[1]).toEqual({ type: 'done' })
  })

  it('handles CRLF line endings', () => {
    const result = collect([
      encoder.encode(
        'data: {"choices":[{"index":0,"delta":{"content":"crlf"}}]}\r\n\r\n' +
          'data: [DONE]\r\n\r\n'
      )
    ])
    expect(result.events[0]).toMatchObject({ type: 'delta', content: 'crlf' })
    expect(result.events[1]).toEqual({ type: 'done' })
  })

  it('joins multi-line data fields with a newline', () => {
    const result = collect([
      encoder.encode(
        'data: {"choices":[{"index":0,\n' +
          'data: "delta":{"content":"multi"}}]}\n\n'
      )
    ])
    expect(result.events).toHaveLength(1)
    expect(result.events[0]).toMatchObject({ type: 'delta', content: 'multi' })
  })

  it('skips comment lines and blank keep-alives', () => {
    const result = collect([
      encoder.encode(': keep-alive\n\n'),
      encoder.encode('data: {"choices":[{"index":0,"delta":{"content":"safe"}}]}\n\n'),
      encoder.encode(': trailing comment\n\n')
    ])
    expect(result.comments).toEqual([': keep-alive', ': trailing comment'])
    expect(result.events).toHaveLength(1)
    expect(result.events[0]).toMatchObject({ content: 'safe' })
  })

  it('decodes UTF-8 split across chunk boundaries without replacement chars', () => {
    const payload =
      'data: {"choices":[{"index":0,"delta":{"content":"你好，世界"}}]}\n\n' +
      'data: [DONE]\n\n'
    const bytes = encoder.encode(payload)
    const chunks: Uint8Array[] = []
    for (let offset = 0; offset < bytes.length; offset += 3) {
      chunks.push(bytes.subarray(offset, offset + 3))
    }
    const result = collect(chunks)
    expect(result.events[0]).toMatchObject({ type: 'delta', content: '你好，世界' })
    expect(result.events[1]).toEqual({ type: 'done' })
    expect(JSON.stringify(result.events)).not.toContain('\uFFFD')
  })

  it('completes cleanly without [DONE]', () => {
    const result = collect([
      encoder.encode('data: {"choices":[{"index":0,"delta":{"content":"tail"}}]}\n\n')
    ])
    expect(result.events).toHaveLength(1)
    expect(result.events[0]).toMatchObject({ content: 'tail' })
    expect(result.events.some((event) => event.type === 'done')).toBe(false)
  })

  it('discards an unterminated event at EOF', () => {
    const result = collect([
      encoder.encode('data: {"choices":[{"index":0,"delta":{"content":"lost"}}]}\n')
    ])
    expect(result.events).toHaveLength(0)
  })

  it('strips a UTF-8 BOM', () => {
    const result = collect([
      new Uint8Array([
        0xef,
        0xbb,
        0xbf,
        ...encoder.encode('data: {"choices":[{"index":0,"delta":{"content":"bom"}}]}\n\n')
      ])
    ])
    expect(result.events[0]).toMatchObject({ content: 'bom' })
  })

  it('reports malformed JSON as a protocol error', () => {
    expect(() => parseSseEvent('{"choices": [THIS IS NOT JSON]')).toThrow(SseProtocolError)
    try {
      parseSseEvent('{"choices": [THIS IS NOT JSON]')
    } catch (error) {
      expect((error as SseProtocolError).reason).toBe('malformed_json')
      expect((error as SseProtocolError).summary.length).toBeLessThanOrEqual(300)
    }
  })

  it('reports an in-stream error object as a protocol error', () => {
    try {
      parseSseEvent('{"error":{"message":"mock error","type":"mock_error"}}')
      throw new Error('expected a throw')
    } catch (error) {
      expect(error).toBeInstanceOf(SseProtocolError)
      expect((error as SseProtocolError).reason).toBe('sse_error_object')
    }
  })

  it('parses usage, finish_reason and reasoning_content', () => {
    const reasoning = parseSseEvent(
      '{"choices":[{"index":0,"delta":{"reasoning_content":"think"}}]}'
    )
    expect(reasoning).toMatchObject({ type: 'delta', reasoning: 'think', content: null })

    const final = parseSseEvent(
      '{"choices":[{"index":0,"delta":{},"finish_reason":"stop"}],"usage":{"prompt_tokens":5,"completion_tokens":1,"total_tokens":6}}'
    )
    expect(final).toMatchObject({
      type: 'delta',
      content: null,
      finishReason: 'stop',
      usage: { total_tokens: 6 }
    })
  })

  it('stops immediately when the event handler returns false', () => {
    const events: string[] = []
    const parser = new SseParser({
      onEvent: (data) => {
        events.push(data)
        return false
      }
    })
    parser.feed(
      encoder.encode(
        'data: {"choices":[{"index":0,"delta":{"content":"one"}}]}\n\n' +
          'data: {"choices":[{"index":0,"delta":{"content":"two"}}]}\n\n'
      )
    )
    expect(parser.isStopped).toBe(true)
    expect(events).toHaveLength(1)
  })
})
