import { describe, expect, it } from 'vitest'
import {
  buildProviderHeaders,
  headerSummary,
  isOpencodeGoEndpoint,
  normalizeCustomHeaders,
  OPENCODE_SESSION_HEADER,
  opencodeSessionIdFor,
  ProviderHeaderError,
  validateHeaderName,
  validateHeaderValue
} from '../../src/main/provider/headers'

describe('provider request headers (D.2)', () => {
  it('sets defaults and injects a Bearer token only when a key exists', () => {
    const withKey = buildProviderHeaders({ apiKey: 'sk-test-key', version: '1.2.3' })
    expect(withKey.headers).toMatchObject({
      'Content-Type': 'application/json',
      Accept: 'text/event-stream',
      'User-Agent': 'QuickAsk/1.2.3',
      Authorization: 'Bearer sk-test-key'
    })
    expect(withKey.injectedAuthorization).toBe(true)

    const withoutKey = buildProviderHeaders({ apiKey: null, version: '1.2.3' })
    expect(withoutKey.headers.Authorization).toBeUndefined()
    expect(withoutKey.injectedAuthorization).toBe(false)

    const emptyKey = buildProviderHeaders({ apiKey: '   ' })
    expect(emptyKey.headers.Authorization).toBeUndefined()
  })

  it('does not inject Bearer when an explicit Authorization header exists', () => {
    const result = buildProviderHeaders({
      apiKey: 'sk-test-key',
      customHeaders: { authorization: 'Custom token-value' }
    })
    expect(result.injectedAuthorization).toBe(false)
    expect(result.headers.authorization).toBe('Custom token-value')
    expect(result.headers.Authorization).toBeUndefined()
  })

  it('lets custom headers override defaults case-insensitively', () => {
    const result = buildProviderHeaders({
      customHeaders: [
        { name: 'content-type', value: 'application/json; charset=utf-8' },
        { name: 'X-Tenant', value: 'tenant-1' }
      ]
    })
    expect(result.headers['content-type']).toBe('application/json; charset=utf-8')
    expect(result.headers['Content-Type']).toBeUndefined()
    expect(result.headers['X-Tenant']).toBe('tenant-1')
  })

  it('de-duplicates custom header names case-insensitively, last wins', () => {
    const headers = normalizeCustomHeaders([
      { name: 'X-Custom', value: 'first' },
      { name: 'x-custom', value: 'second' },
      { name: 'X-Other', value: 'keep' }
    ])
    expect(headers).toEqual({ 'x-custom': 'second', 'X-Other': 'keep' })
  })

  it('rejects dangerous header names and CR/LF injection', () => {
    for (const name of [
      '',
      '   ',
      'Host',
      'Content-Length',
      'Transfer-Encoding',
      'Connection',
      'Upgrade',
      'Proxy-Authorization',
      'Proxy-Connection',
      'Bad\r\nName',
      'Bad Name'
    ]) {
      expect(() => validateHeaderName(name)).toThrow(ProviderHeaderError)
    }

    expect(() => validateHeaderValue('ok')).not.toThrow()
    for (const value of ['bad\r\nInjected: yes', 'bad\nInjected', 'bad\u0000value']) {
      expect(() => validateHeaderValue(value)).toThrow(ProviderHeaderError)
    }
    expect(() =>
      normalizeCustomHeaders([{ name: 'X-Test', value: 'a\r\nb' }])
    ).toThrow(ProviderHeaderError)
  })

  it('exposes names-only diagnostics without values', () => {
    const result = buildProviderHeaders({
      apiKey: 'sk-secret-value',
      customHeaders: { 'X-Secret-Thing': 'super-secret-value' }
    })
    const summary = headerSummary(result.headers)
    expect(summary.count).toBe(5)
    expect(summary.names).toContain('authorization')
    expect(summary.names).toContain('x-secret-thing')
    const serialized = JSON.stringify(summary)
    expect(serialized).not.toContain('sk-secret-value')
    expect(serialized).not.toContain('super-secret-value')
  })
})

describe('opencode-go routing header', () => {
  it('recognises only the zen/go gateway', () => {
    for (const url of [
      'https://opencode.ai/zen/go/v1',
      'https://opencode.ai/zen/go',
      'https://opencode.ai/zen/go/v1/',
      'https://opencode.ai/zen/go/v1/chat/completions',
      '  https://opencode.ai/zen/go/v1  '
    ]) {
      expect(isOpencodeGoEndpoint(url), url).toBe(true)
    }

    for (const url of [
      'https://opencode.ai/zen/v1',
      'https://opencode.ai/v1',
      'https://api.deepseek.com',
      'http://127.0.0.1:11434/v1',
      'not a url',
      '',
      undefined,
      null
    ]) {
      expect(isOpencodeGoEndpoint(url), String(url)).toBe(false)
    }
  })

  it('injects the session header on zen/go endpoints', () => {
    const sessionId = opencodeSessionIdFor('profile-a')
    const result = buildProviderHeaders({
      apiKey: 'sk-test-key',
      baseUrl: 'https://opencode.ai/zen/go/v1',
      opencodeSessionId: sessionId
    })
    expect(result.headers[OPENCODE_SESSION_HEADER]).toBe(sessionId)

    const chatUrl = buildProviderHeaders({
      baseUrl: 'https://opencode.ai/zen/go/v1/chat/completions',
      opencodeSessionId: sessionId
    })
    expect(chatUrl.headers[OPENCODE_SESSION_HEADER]).toBe(sessionId)
  })

  it('leaves non-go endpoints untouched', () => {
    const result = buildProviderHeaders({
      baseUrl: 'https://api.deepseek.com',
      opencodeSessionId: opencodeSessionIdFor('profile-a')
    })
    expect(result.headers[OPENCODE_SESSION_HEADER]).toBeUndefined()
    expect(headerSummary(result.headers).names).not.toContain(OPENCODE_SESSION_HEADER)
  })

  it('skips injection when no session id is available', () => {
    const result = buildProviderHeaders({ baseUrl: 'https://opencode.ai/zen/go/v1' })
    expect(result.headers[OPENCODE_SESSION_HEADER]).toBeUndefined()

    const blank = buildProviderHeaders({
      baseUrl: 'https://opencode.ai/zen/go/v1',
      opencodeSessionId: '   '
    })
    expect(blank.headers[OPENCODE_SESSION_HEADER]).toBeUndefined()
  })

  it('lets an explicit custom session header win', () => {
    const result = buildProviderHeaders({
      baseUrl: 'https://opencode.ai/zen/go/v1',
      opencodeSessionId: opencodeSessionIdFor('profile-a'),
      customHeaders: [{ name: 'X-OpenCode-Session', value: 'user-owned-id' }]
    })
    expect(result.headers['X-OpenCode-Session']).toBe('user-owned-id')
    expect(result.headers[OPENCODE_SESSION_HEADER]).toBeUndefined()
  })

  it('derives a stable uuid-shaped id per profile', () => {
    const pattern = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/
    expect(opencodeSessionIdFor('profile-a')).toMatch(pattern)
    expect(opencodeSessionIdFor('profile-a')).toBe(opencodeSessionIdFor('profile-a'))
    expect(opencodeSessionIdFor('profile-a')).not.toBe(opencodeSessionIdFor('profile-b'))
    expect(opencodeSessionIdFor('https://opencode.ai/zen/go/v1')).toMatch(pattern)
  })
})
