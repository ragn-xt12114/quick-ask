import { describe, expect, it } from 'vitest'
import {
  redactErrorDetail,
  stoppedMessage,
  uiErrorMessage
} from '../../src/renderer/src/lib/errorText'

describe('renderer error text', () => {
  it('maps provider codes to the D.7 labels', () => {
    expect(uiErrorMessage('RATE_LIMIT', null)).toBe('限流，稍后再试（不自动重试）')
    expect(uiErrorMessage('AUTH', null)).toBe('认证失败，请检查 API key/权限')
    expect(uiErrorMessage('SERVER', null)).toBe('服务端错误')
    expect(uiErrorMessage('TIMEOUT', null)).toBe('请求超时')
  })

  it('redacts credentials and caps the visible detail at 300 chars', () => {
    const raw =
      'Authorization: Bearer sk-live1234567890 api_key=super-secret https://x.test/?token=abc123 ' +
      'x'.repeat(600)
    const text = uiErrorMessage('SERVER', raw)
    expect(text.length).toBeLessThanOrEqual(300)
    expect(text).not.toContain('sk-live1234567890')
    expect(text).not.toContain('super-secret')
    expect(text).not.toContain('abc123')
    expect(text).toContain('[REDACTED]')
  })

  it('unwraps provider JSON bodies before display', () => {
    const text = uiErrorMessage(
      'SERVER',
      '{"error":{"message":"upstream exploded","type":"server_error"}}'
    )
    expect(text).toBe('服务端错误 · upstream exploded')
    expect(text).not.toContain('{"')
  })

  it('strips malformed JSON fragments left after secret redaction', () => {
    const text = uiErrorMessage(
      'SERVER',
      '{"error":{"message":"boom Authorization: [REDACTED],"type":"server_error"}}'
    )
    expect(text).toBe('服务端错误 · boom Authorization: [REDACTED]')
    expect(text).not.toContain('"type"')
    expect(text).not.toContain('"}}')
  })

  it('keeps a stopped label free of provider content', () => {
    expect(stoppedMessage()).toContain('已停止')
    expect(redactErrorDetail('Bearer abc.def')).toContain('[REDACTED]')
  })
})
