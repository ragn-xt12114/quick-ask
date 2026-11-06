import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  buildContext,
  DEFAULT_CONTEXT_ROUNDS,
  DEFAULT_CONTEXT_TOKEN_BUDGET,
  estimateTokens,
  type ContextMessage
} from '../../src/main/chat/context'

const evidenceDir = join(process.cwd(), '.omo', 'evidence')
const evidence: Record<string, unknown> = {}

function record(name: string, value: unknown): void {
  evidence[name] = value
}

function round(user: string, assistant: string, status: ContextMessage['status'] = 'complete'): ContextMessage[] {
  return [
    { role: 'user', content: user, status: 'complete' },
    { role: 'assistant', content: assistant, status }
  ]
}

describe('estimateTokens', () => {
  it('uses chars/4 for ASCII and chars/2 for CJK', () => {
    expect(estimateTokens('')).toBe(0)
    expect(estimateTokens('abcd')).toBe(1)
    expect(estimateTokens('中文')).toBe(1)
    expect(estimateTokens('中文中文')).toBe(2)
    expect(estimateTokens('a中')).toBe(1)

    const ascii = estimateTokens('a'.repeat(400))
    const cjk = estimateTokens('汉'.repeat(400))
    expect(ascii).toBe(100)
    expect(cjk).toBe(200)
    record('estimate', { ascii400: ascii, han400: cjk })
  })

  it('classifies Han, Hiragana, Katakana and Hangul as CJK', () => {
    expect(estimateTokens('ひらがな')).toBe(2)
    expect(estimateTokens('カタカナ')).toBe(2)
    expect(estimateTokens('한국어')).toBe(2)
  })
})

describe('buildContext', () => {
  it('keeps the last 12 rounds plus the current user', () => {
    const messages: ContextMessage[] = []
    for (let index = 0; index < 20; index += 1) {
      messages.push(...round(`user-${index}`, `assistant-${index}`))
    }
    messages.push({ role: 'user', content: 'current-question' })

    const built = buildContext({ messages })
    expect(built.messages).toHaveLength(DEFAULT_CONTEXT_ROUNDS * 2 + 1)
    expect(built.messages[0]).toEqual({ role: 'user', content: 'user-8' })
    expect(built.messages[built.messages.length - 1]).toEqual({
      role: 'user',
      content: 'current-question'
    })
    expect(built.droppedPairs).toBe(8)
    expect(built.trimmed).toBe(true)
    record('default12', {
      messages: built.messages.length,
      droppedPairs: built.droppedPairs,
      first: built.messages[0]
    })
  })

  it('handles 100 history messages deterministically', () => {
    const messages: ContextMessage[] = []
    for (let index = 0; index < 50; index += 1) {
      messages.push(...round(`q${index}`, `a${index}`))
    }
    messages.push({ role: 'user', content: 'now' })

    const built = buildContext({ messages })
    expect(built.messages).toHaveLength(25)
    expect(built.messages[0].content).toBe('q38')
    expect(built.messages[24]).toEqual({ role: 'user', content: 'now' })
    record('hundredMessages', {
      input: messages.length,
      output: built.messages.length,
      estimatedTokens: built.estimatedTokens,
      droppedPairs: built.droppedPairs
    })
  })

  it('estimates long Chinese history and trims to the budget', () => {
    const longText = '中'.repeat(3000)
    const messages: ContextMessage[] = []
    for (let index = 0; index < 40; index += 1) {
      messages.push(...round(`${longText}${index}`, `${longText}${index}`))
    }
    messages.push({ role: 'user', content: '最终问题' })

    const built = buildContext({ messages, tokenBudget: 32_000 })
    expect(built.estimatedTokens).toBeLessThanOrEqual(32_000)
    expect(built.messages[built.messages.length - 1].content).toBe('最终问题')
    expect(built.droppedPairs).toBeGreaterThan(0)
    expect(built.trimmed).toBe(true)
    record('longChineseTrim', {
      outputMessages: built.messages.length,
      estimatedTokens: built.estimatedTokens,
      droppedPairs: built.droppedPairs
    })
  })

  it('never drops a 50k-char current user even when it alone exceeds the budget', () => {
    const current = '问'.repeat(50_000)
    const built = buildContext({
      messages: [
        ...round('old question', 'old answer'),
        { role: 'user', content: current }
      ],
      tokenBudget: 10_000
    })

    const last = built.messages[built.messages.length - 1]
    expect(last).toEqual({ role: 'user', content: current })
    expect(built.messages).toHaveLength(1)
    expect(built.trimmed).toBe(true)
    expect(built.estimatedTokens).toBeGreaterThan(10_000)
    record('single50k', {
      messages: built.messages.length,
      contentLength: last.content.length,
      estimatedTokens: built.estimatedTokens,
      trimmed: built.trimmed
    })
  })

  it('excludes empty/error/streaming assistant rows but keeps interrupted content', () => {
    const built = buildContext({
      messages: [
        { role: 'user', content: 'q-empty', status: 'complete' },
        { role: 'assistant', content: '', status: 'complete' },
        { role: 'user', content: 'q-error', status: 'complete' },
        { role: 'assistant', content: 'failed answer', status: 'error' },
        { role: 'user', content: 'q-streaming', status: 'complete' },
        { role: 'assistant', content: 'still streaming', status: 'streaming' },
        { role: 'user', content: 'q-stopped', status: 'complete' },
        { role: 'assistant', content: 'stopped answer', status: 'stopped' },
        { role: 'user', content: 'q-interrupted', status: 'complete' },
        { role: 'assistant', content: 'interrupted answer', status: 'interrupted' },
        { role: 'system', content: 'ignored system row', status: 'complete' },
        { role: 'user', content: 'current', status: 'complete' }
      ]
    })

    const contents = built.messages.map((message) => message.content)
    expect(contents).not.toContain('failed answer')
    expect(contents).not.toContain('still streaming')
    expect(contents).not.toContain('')
    expect(contents).not.toContain('ignored system row')
    expect(contents).toContain('stopped answer')
    expect(contents).toContain('interrupted answer')
    expect(contents[contents.length - 1]).toBe('current')
    record('assistantFiltering', contents)
  })

  it('prepends the session system prompt when configured', () => {
    const built = buildContext({
      messages: [...round('q', 'a'), { role: 'user', content: 'current' }],
      systemPrompt: '  You are QuickAsk.  '
    })
    expect(built.messages[0]).toEqual({ role: 'system', content: 'You are QuickAsk.' })
    expect(built.messages[1]).toEqual({ role: 'user', content: 'q' })
    expect(built.messages[2]).toEqual({ role: 'assistant', content: 'a' })
    expect(built.messages[3]).toEqual({ role: 'user', content: 'current' })
  })

  it('honours an explicit round limit and token budget', () => {
    const messages: ContextMessage[] = []
    for (let index = 0; index < 5; index += 1) messages.push(...round(`q${index}`, `a${index}`))
    messages.push({ role: 'user', content: 'current' })

    const built = buildContext({ messages, maxRounds: 2, tokenBudget: 1000 })
    expect(built.messages).toHaveLength(5)
    expect(built.messages.map((message) => message.content)).toEqual([
      'q3',
      'a3',
      'q4',
      'a4',
      'current'
    ])
  })

  it('reports the documented defaults', () => {
    expect(DEFAULT_CONTEXT_ROUNDS).toBe(12)
    expect(DEFAULT_CONTEXT_TOKEN_BUDGET).toBe(32_000)
  })
})

describe('context evidence', () => {
  it('writes evidence JSON', () => {
    mkdirSync(evidenceDir, { recursive: true })
    writeFileSync(
      join(evidenceDir, 'task-16-context.json'),
      `${JSON.stringify(evidence, null, 2)}\n`
    )
    writeFileSync(
      join(evidenceDir, 'task-16-context-trim.json'),
      `${JSON.stringify(
        {
          longChinese: evidence.longChineseTrim,
          single50k: evidence.single50k,
          default12: evidence.default12
        },
        null,
        2
      )}\n`
    )
    expect(Object.keys(evidence).length).toBeGreaterThan(0)
  })
})
