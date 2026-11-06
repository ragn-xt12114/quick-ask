import { beforeAll, describe, expect, it } from 'vitest'
import {
  redact,
  redactSummary,
  registerSecretValue,
  registeredSecretCount
} from '../../src/main/secrets/redact'

beforeAll(() => {
  registerSecretValue('custom-header-value-42')
})

describe('redact', () => {
  it('redacts Authorization headers and bearer tokens', () => {
    expect(redact('Authorization: Bearer abc.def.ghi')).not.toContain('abc.def.ghi')
    expect(redact('authorization = token-12345')).not.toContain('token-12345')
    expect(redact('curl -H "Bearer sk-live-1234567890"')).not.toContain('sk-live-1234567890')
  })

  it('redacts api_key/token/secret assignments', () => {
    const input = 'api_key=abc123 token: tok_999 secret = shh'
    const output = redact(input)
    expect(output).not.toContain('abc123')
    expect(output).not.toContain('tok_999')
    expect(output).not.toContain('shh')
    expect(output).toContain('[REDACTED]')
  })

  it('redacts sk- keys and URL query credentials', () => {
    const output = redact(
      'failed sk-proj-AbCdEf12_34 for https://x.test/v1?key=mykey&token=mytoken&safe=1'
    )
    expect(output).not.toContain('sk-proj-AbCdEf12_34')
    expect(output).not.toContain('mykey')
    expect(output).not.toContain('mytoken')
    expect(output).toContain('safe=1')
  })

  it('redacts registered custom header values but keeps normal text', () => {
    expect(registeredSecretCount()).toBeGreaterThanOrEqual(1)
    const input = 'header custom-header-value-42 and normal sentence stays.'
    const output = redact(input)
    expect(output).not.toContain('custom-header-value-42')
    expect(output).toContain('normal sentence stays.')
  })

  it('does not scrub ordinary prose', () => {
    const text = 'The tokenizer reads tokens; a secret garden is fine.'
    expect(redact(text)).toBe(text)
  })

  it('caps summaries at 300 chars after redaction', () => {
    const output = redactSummary(`Authorization: Bearer abcd ${'x'.repeat(1000)}`, 300)
    expect(output.length).toBeLessThanOrEqual(300)
    expect(output).not.toContain('abcd')
  })
})
