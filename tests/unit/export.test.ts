import { describe, expect, it } from 'vitest'
import {
  assertNoSecretFields,
  defaultExportFilename,
  sanitizeExportFilename,
  sanitizeTitle,
  serializeSessionsToJson,
  serializeSessionsToMarkdown,
  type ExportSessionInput
} from '../../src/main/export/serializers'

function sampleSessions(): ExportSessionInput[] {
  return [
    {
      session: {
        id: 's1',
        title: 'Hello World',
        titleAuto: false,
        createdAt: 1700000000000,
        updatedAt: 1700000001000,
        lastMessageAt: 1700000001000,
        model: 'deepseek-chat',
        systemPrompt: null
      },
      messages: [
        {
          id: 'm1',
          sessionId: 's1',
          seq: 0,
          role: 'user',
          content: 'hi there',
          status: 'complete',
          errorCode: null,
          errorDetail: null,
          model: null,
          createdAt: 1700000000000,
          updatedAt: 1700000000000
        },
        {
          id: 'm2',
          sessionId: 's1',
          seq: 1,
          role: 'assistant',
          content: 'hello!',
          status: 'complete',
          errorCode: null,
          errorDetail: null,
          model: 'deepseek-chat',
          createdAt: 1700000001000,
          updatedAt: 1700000001000
        }
      ]
    }
  ]
}

describe('export serializers', () => {
  it('serializes JSON with sessions/messages metadata and no secret fields', () => {
    const json = serializeSessionsToJson(sampleSessions(), 1700000002000)
    const parsed = JSON.parse(json) as {
      app: string
      version: number
      exportedAt: number
      count: number
      sessions: Array<Record<string, unknown>>
    }
    expect(parsed.app).toBe('quickask')
    expect(parsed.count).toBe(1)
    expect(parsed.sessions).toHaveLength(1)
    const session = parsed.sessions[0]!
    expect(session['id']).toBe('s1')
    expect(session['model']).toBe('deepseek-chat')
    expect(session['messages']).toHaveLength(2)
    expect(JSON.stringify(parsed)).not.toMatch(/api[_-]?key|secret|token|password|key_ref/i)
    expect(() => assertNoSecretFields(parsed)).not.toThrow()
  })

  it('rejects payloads containing secret-looking fields', () => {
    expect(() => assertNoSecretFields({ api_key: 'sk-1234' })).toThrow()
    expect(() => assertNoSecretFields({ nested: { key_ref: 'abc' } })).toThrow()
    expect(() => assertNoSecretFields([{ token: 'x' }])).toThrow()
  })

  it('serializes readable Markdown without secrets', () => {
    const md = serializeSessionsToMarkdown(sampleSessions(), 1700000002000)
    expect(md).toContain('# QuickAsk 导出')
    expect(md).toContain('## Hello World')
    expect(md).toContain('用户')
    expect(md).toContain('助手')
    expect(md).toContain('hi there')
    expect(md).toContain('hello!')
    expect(md).not.toMatch(/api[_-]?key|key_ref/i)
  })

  it('sanitizes titles and filenames', () => {
    expect(sanitizeTitle('  a/b:c*d?e  ')).toBe('abcde')
    expect(sanitizeTitle('')).toBe('untitled')
    expect(sanitizeTitle('x'.repeat(200)).length).toBeLessThanOrEqual(60)
    const name = sanitizeExportFilename('Hello World!', 'json')
    expect(name).toBe('Hello-World!.json')
    expect(sanitizeExportFilename('test', 'markdown')).toBe('test.md')
    expect(defaultExportFilename('all', 'json', 1700000000000)).toMatch(
      /^quickask-all-2023-11-14\.json$/
    )
    expect(defaultExportFilename('current', 'markdown', 1700000000000)).toMatch(
      /^quickask-session-2023-11-14\.md$/
    )
  })

  it('redacts error details and caps long content in markdown', () => {
    const sessions = sampleSessions()
    sessions[0]!.messages[1] = {
      ...sessions[0]!.messages[1]!,
      status: 'error',
      errorCode: 'AUTH',
      errorDetail: 'bad key sk-abcdefgh12345678'
    }
    const md = serializeSessionsToMarkdown(sessions)
    expect(md).toContain('AUTH')
    expect(md).not.toContain('sk-abcdefgh12345678')
  })
})
