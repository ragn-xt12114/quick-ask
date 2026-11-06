import { describe, expect, it } from 'vitest'
import { OutboundGuard } from '../../src/main/net/guard'
import { createProviderClient } from '../../src/main/provider/client'

describe('ProviderClient + OutboundGuard', () => {
  it('rejects a non-allowlisted provider host without calling fetch', async () => {
    let fetchCalls = 0
    const guard = new OutboundGuard({ providerBaseUrls: ['https://allowed.example'] })
    const client = createProviderClient({
      guard,
      fetchImpl: async () => {
        fetchCalls += 1
        throw new Error('fetch must not be reached')
      }
    })

    const result = await client.streamChat({
      requestId: 'blocked-request',
      profile: { baseUrl: 'https://evil.example', model: 'test' },
      messages: [{ role: 'user', content: 'secret prompt' }]
    })

    expect(fetchCalls).toBe(0)
    expect(result.status).toBe('error')
    expect(result.error?.code).toBe('network')
    expect(result.error?.detail).toContain('Outbound blocked')
    expect(result.content).toBe('')
  })

  it('allows a loopback target even when no provider is registered', async () => {
    let fetchCalls = 0
    const guard = new OutboundGuard()
    const client = createProviderClient({
      guard,
      fetchImpl: async () => {
        fetchCalls += 1
        return new Response(
          `data: ${JSON.stringify({ choices: [{ delta: { content: 'ok' } }] })}\n\ndata: [DONE]\n\n`,
          { status: 200, headers: { 'content-type': 'text/event-stream' } }
        ) as never
      }
    })

    const result = await client.streamChat({
      requestId: 'loopback-request',
      profile: { baseUrl: 'http://127.0.0.1:65535', model: 'test' },
      messages: [{ role: 'user', content: 'hello' }]
    })

    expect(fetchCalls).toBe(1)
    expect(result.status).toBe('complete')
    expect(result.content).toBe('ok')
  })
})
