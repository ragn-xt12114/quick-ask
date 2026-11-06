import { describe, expect, it } from 'vitest'
import { PRODUCTION_CSP } from '../../src/shared/csp'
import {
  assertAllowedOutbound,
  assertNoRendererNetwork,
  isLoopbackHostname,
  NetworkGuardError,
  OutboundGuard,
  proxyUrlsFromEnv
} from '../../src/main/net/guard'

function codeOf(fn: () => unknown): string | null {
  try {
    fn()
    return null
  } catch (error) {
    return error instanceof NetworkGuardError ? error.code : 'NOT_GUARD_ERROR'
  }
}

describe('OutboundGuard', () => {
  const guard = new OutboundGuard({
    providerBaseUrls: ['https://api.example.com/v1', 'http://127.0.0.1:11434'],
    proxyUrls: ['http://proxy.corp:8080']
  })

  it('allows exact provider origins and their request paths', () => {
    expect(
      guard.assertAllowedOutbound('https://api.example.com/v1/chat/completions').hostname
    ).toBe('api.example.com')
    expect(guard.assertAllowedOutbound('http://127.0.0.1:11434/v1/models').hostname).toBe(
      '127.0.0.1'
    )
    expect(guard.assertAllowedOutbound('http://proxy.corp:8080/health').hostname).toBe(
      'proxy.corp'
    )
  })

  it('allows loopback on any port/protocol http(s)', () => {
    expect(guard.assertAllowedOutbound('http://localhost:9/v1').hostname).toBe('localhost')
    expect(guard.assertAllowedOutbound('http://127.0.0.1:18080/v1').hostname).toBe('127.0.0.1')
    expect(guard.assertAllowedOutbound('http://127.99.1.2:1234/').hostname).toBe('127.99.1.2')
    expect(guard.assertAllowedOutbound('http://[::1]:1234/').hostname).toBe('[::1]')
    expect(isLoopbackHostname('127.0.0.1')).toBe(true)
    expect(isLoopbackHostname('128.0.0.1')).toBe(false)
  })

  it('rejects other hosts, scheme changes, credentials and non-http protocols', () => {
    expect(codeOf(() => guard.assertAllowedOutbound('https://evil.example.com/v1'))).toBe(
      'OUTBOUND_BLOCKED'
    )
    expect(codeOf(() => guard.assertAllowedOutbound('http://api.example.com/v1'))).toBe(
      'OUTBOUND_BLOCKED'
    )
    expect(codeOf(() => guard.assertAllowedOutbound('https://user:pass@api.example.com/v1'))).toBe(
      'OUTBOUND_BLOCKED'
    )
    expect(codeOf(() => guard.assertAllowedOutbound('file:///etc/passwd'))).toBe(
      'OUTBOUND_BLOCKED'
    )
    expect(codeOf(() => guard.assertAllowedOutbound('javascript:alert(1)'))).toBe(
      'OUTBOUND_BLOCKED'
    )
    expect(codeOf(() => guard.assertAllowedOutbound('not a url'))).toBe('INVALID_URL')
  })

  it('never treats a wildcard as an allowlist entry', () => {
    const wildcard = new OutboundGuard({ providerBaseUrls: ['*'] })
    expect(codeOf(() => wildcard.assertAllowedOutbound('https://any.example.com'))).toBe(
      'OUTBOUND_BLOCKED'
    )
  })

  it('updates the provider registry when profiles change', () => {
    const live = new OutboundGuard()
    expect(codeOf(() => live.assertAllowedOutbound('https://new-provider.test/v1'))).toBe(
      'OUTBOUND_BLOCKED'
    )
    live.setProviderBaseUrls(['https://new-provider.test'])
    expect(live.assertAllowedOutbound('https://new-provider.test/v1/chat')).toBeTruthy()
    expect(live.snapshot().providerOrigins).toEqual(['https://new-provider.test'])
  })

  it('reads proxy URLs from the environment (both cases) and ignores socks', () => {
    const urls = proxyUrlsFromEnv({
      HTTPS_PROXY: 'http://proxy-a.test:3128',
      http_proxy: 'http://proxy-b.test:8080',
      ALL_PROXY: 'socks5://proxy-c.test:1080'
    })
    expect(urls).toContain('http://proxy-a.test:3128')
    expect(urls).toContain('http://proxy-b.test:8080')
    const envGuard = new OutboundGuard({ env: { HTTPS_PROXY: 'http://proxy-a.test:3128' } })
    expect(envGuard.assertAllowedOutbound('http://proxy-a.test:3128/').hostname).toBe(
      'proxy-a.test'
    )
    // socks entries do not become allowlist origins
    expect(codeOf(() => envGuard.assertAllowedOutbound('http://proxy-c.test:1080/'))).toBe(
      'OUTBOUND_BLOCKED'
    )
  })

  it('stateless helper matches the class contract', () => {
    const allowed = assertAllowedOutbound('https://p.test/v1', {
      providerBaseUrls: ['https://p.test']
    })
    expect(allowed.origin).toBe('https://p.test')
    expect(
      codeOf(() => assertAllowedOutbound('https://q.test', { providerBaseUrls: ['https://p.test'] }))
    ).toBe('OUTBOUND_BLOCKED')
  })
})

describe('assertNoRendererNetwork', () => {
  const good = {
    csp: PRODUCTION_CSP,
    contextIsolation: true,
    sandbox: true,
    nodeIntegration: false,
    webSecurity: true,
    webviewTag: false
  }

  it('accepts the Task 9 production boundary', () => {
    expect(() => assertNoRendererNetwork(good)).not.toThrow()
  })

  it('rejects a CSP without connect-src none', () => {
    expect(
      codeOf(() => assertNoRendererNetwork({ ...good, csp: "default-src 'self'" }))
    ).toBe('RENDERER_NETWORK')
  })

  it('rejects weakened Node/sandbox flags', () => {
    expect(codeOf(() => assertNoRendererNetwork({ ...good, sandbox: false }))).toBe(
      'RENDERER_NETWORK'
    )
    expect(codeOf(() => assertNoRendererNetwork({ ...good, nodeIntegration: true }))).toBe(
      'RENDERER_NETWORK'
    )
    expect(codeOf(() => assertNoRendererNetwork({ ...good, webSecurity: false }))).toBe(
      'RENDERER_NETWORK'
    )
  })
})
