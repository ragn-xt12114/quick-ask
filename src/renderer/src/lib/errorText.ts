const MAX_ERROR_CHARS = 300

const CODE_LABELS: Record<string, string> = {
  AUTH: '认证失败，请检查 API key/权限',
  RATE_LIMIT: '限流，稍后再试（不自动重试）',
  BAD_REQUEST: '请求被拒绝（模型/参数）',
  SERVER: '服务端错误',
  TIMEOUT: '请求超时',
  NETWORK: '网络不可达',
  PROTOCOL: '响应格式不符合 OpenAI 兼容协议',
  REDIRECT: '端点重定向被阻止（防止 key 泄露）',
  DB_WRITE: '本地保存失败（磁盘/权限）',
  CONFIG_REQUIRED: '请先在设置中配置模型提供商'
}

const SECRET_PATTERNS: Array<[RegExp, string]> = [
  [/(authorization\s*[:=]\s*)([^\s,;]+)/gi, '$1[REDACTED]'],
  [/((?:api[-_]?key|token|password|secret)\s*[:=]\s*)([^\s,;]+)/gi, '$1[REDACTED]'],
  [/(bearer\s+)[A-Za-z0-9._~+/=-]+/gi, '$1[REDACTED]'],
  [/\bsk-[A-Za-z0-9_-]{8,}\b/g, '[REDACTED]'],
  [/([?&](?:key|token|api_key|apikey|password|secret)=)[^&\s]+/gi, '$1[REDACTED]'],
  [/\b(?:file|javascript|data):[^\s)]+/gi, '[BLOCKED_URL]']
]

function summarizeProviderDetail(detail: string): string {
  const trimmed = detail.trim()
  try {
    const parsed = JSON.parse(trimmed) as {
      error?: { message?: unknown }
      message?: unknown
    }
    const parsedMessage = parsed.error?.message ?? parsed.message
    if (typeof parsedMessage === 'string' && parsedMessage.length > 0) {
      return parsedMessage
    }
  } catch {
    // Truncated provider bodies are handled below.
  }

  const messageMatch = trimmed.match(/^\s*\{[\s\S]*?"message"\s*:\s*"([\s\S]*)$/)
  if (messageMatch) {
    return messageMatch[1]!
      .replace(/",\s*"[A-Za-z_]+"\s*:[\s\S]*$/, '')
      .replace(/"\s*\}[\s\S]*$/, '')
      .replace(/\\n/g, ' ')
      .replace(/\\"/g, '"')
      .replace(/\\\\/g, '\\')
  }
  return trimmed
}

export function redactErrorDetail(detail: string): string {
  let text = summarizeProviderDetail(detail)
  for (const [pattern, replacement] of SECRET_PATTERNS) {
    text = text.replace(pattern, replacement)
  }
  text = text.replace(/,\s*"(?:type|code|param|error|message)"\s*:[\s\S]*$/i, '')
  text = text.replace(/"?\s*\}\s*\}?\s*$/, '')
  return text.replace(/\s+/g, ' ').trim()
}

export function uiErrorMessage(code: string | null, detail: string | null): string {
  const label = (code && CODE_LABELS[code]) || '请求失败'
  const safeDetail = detail ? redactErrorDetail(detail) : ''
  const message =
    safeDetail.length > 0 && safeDetail !== label && !label.startsWith(safeDetail)
      ? `${label} · ${safeDetail}`
      : label
  return Array.from(message).slice(0, MAX_ERROR_CHARS).join('')
}

export function stoppedMessage(): string {
  return '已停止生成，可重试'
}

export function interruptedMessage(): string {
  return '生成已中断，可重试'
}
