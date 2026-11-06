import { describe, expect, it } from 'vitest'
import {
  chatCompletionsUrl,
  modelsUrl,
  normalizeProviderBase,
  ProviderUrlError,
  redactProviderUrl
} from '../../src/main/provider/url'

describe('provider URL normalization (D.2)', () => {
  it('normalizes bare origins and /v1 bases', () => {
    expect(normalizeProviderBase('https://api.deepseek.com/')).toBe('https://api.deepseek.com')
    expect(normalizeProviderBase('https://api.openai.com/v1/')).toBe('https://api.openai.com/v1')

    expect(chatCompletionsUrl('https://api.deepseek.com')).toBe(
      'https://api.deepseek.com/v1/chat/completions'
    )
    expect(chatCompletionsUrl('https://api.openai.com/v1')).toBe(
      'https://api.openai.com/v1/chat/completions'
    )
    expect(chatCompletionsUrl('https://api.openai.com/v1/')).toBe(
      'https://api.openai.com/v1/chat/completions'
    )
  })

  it('preserves path prefixes and never duplicates /v1', () => {
    expect(chatCompletionsUrl('https://host/openai/v1')).toBe(
      'https://host/openai/v1/chat/completions'
    )
    expect(chatCompletionsUrl('https://host/openai/v1/')).toBe(
      'https://host/openai/v1/chat/completions'
    )
    expect(chatCompletionsUrl('https://host/api/v2')).toBe(
      'https://host/api/v2/chat/completions'
    )
  })

  it('leaves an already complete chat URL unchanged', () => {
    expect(chatCompletionsUrl('https://x.test/v1/chat/completions')).toBe(
      'https://x.test/v1/chat/completions'
    )
    expect(chatCompletionsUrl('https://x.test/v1/chat/completions/')).toBe(
      'https://x.test/v1/chat/completions'
    )
    expect(chatCompletionsUrl('https://x.test/openai/v1/chat/completions')).toBe(
      'https://x.test/openai/v1/chat/completions'
    )
  })

  it('builds /models URLs with the same prefix rules', () => {
    expect(modelsUrl('https://x.test')).toBe('https://x.test/v1/models')
    expect(modelsUrl('https://x.test/v1')).toBe('https://x.test/v1/models')
    expect(modelsUrl('https://x.test/v1/')).toBe('https://x.test/v1/models')
    expect(modelsUrl('https://x.test/openai/v1')).toBe('https://x.test/openai/v1/models')
    expect(modelsUrl('https://x.test/v1/models')).toBe('https://x.test/v1/models')
    expect(modelsUrl('https://x.test/v1/chat/completions')).toBe('https://x.test/v1/models')
  })

  it('allows loopback HTTP endpoints for local models', () => {
    expect(chatCompletionsUrl('http://127.0.0.1:11434')).toBe(
      'http://127.0.0.1:11434/v1/chat/completions'
    )
    expect(chatCompletionsUrl('http://localhost:8080')).toBe(
      'http://localhost:8080/v1/chat/completions'
    )
    expect(chatCompletionsUrl('http://[::1]:8080')).toBe(
      'http://[::1]:8080/v1/chat/completions'
    )
  })

  it('rejects forbidden protocols, credentials, query and hash', () => {
    for (const value of [
      'file:///etc/passwd',
      'javascript:alert(1)',
      'data:text/plain,hi',
      'ftp://example.test',
      'ws://example.test',
      'wss://example.test'
    ]) {
      expect(() => normalizeProviderBase(value)).toThrow(ProviderUrlError)
    }

    expect(() => normalizeProviderBase('https://user:pass@example.test')).toThrow(
      /credentials/
    )
    expect(() => normalizeProviderBase('https://example.test?api_key=secret')).toThrow(
      /query|fragment/
    )
    expect(() => normalizeProviderBase('https://example.test#frag')).toThrow(
      /query|fragment/
    )
    expect(() => normalizeProviderBase('   ')).toThrow(/required/)
    expect(() => normalizeProviderBase('not a url')).toThrow(/valid/)
  })

  it('uses the typed invalid_base_url error code', () => {
    try {
      normalizeProviderBase('file:///etc/passwd')
      throw new Error('expected a throw')
    } catch (error) {
      expect(error).toBeInstanceOf(ProviderUrlError)
      expect((error as ProviderUrlError).code).toBe('invalid_base_url')
    }
  })

  it('redacts credentials, query and fragment for logs', () => {
    expect(
      redactProviderUrl('https://user:pass@example.test/v1/chat/completions?api_key=secret#x')
    ).toBe('https://example.test/v1/chat/completions')
    expect(redactProviderUrl('not a url')).toBe('[invalid-url]')
  })
})
