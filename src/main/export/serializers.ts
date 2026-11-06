import type { ChatMessage, Session } from '../../shared/channels'
import { redactSummary } from '../secrets/redact'

export interface ExportSessionInput {
  session: Session
  messages: ChatMessage[]
}

export interface ExportPayload {
  app: string
  version: number
  exportedAt: number
  count: number
  sessions: ExportSessionInput[]
}

const SECRET_KEY_PATTERN = /api[_-]?key|secret|token|password|authorization|bearer|key_ref/i

function hasSecretField(name: string): boolean {
  return SECRET_KEY_PATTERN.test(name)
}

export function assertNoSecretFields(value: unknown, path = '$'): void {
  if (Array.isArray(value)) {
    for (let index = 0; index < value.length; index += 1) {
      assertNoSecretFields(value[index], `${path}[${index}]`)
    }
    return
  }
  if (typeof value === 'object' && value !== null) {
    for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
      if (hasSecretField(key)) {
        throw new Error(`secret field leaked at ${path}.${key}`)
      }
      assertNoSecretFields(entry, `${path}.${key}`)
    }
  }
}

export function sanitizeTitle(title: string): string {
  const cleaned = title
    .replace(/[\r\n\t]+/g, ' ')
    // eslint-disable-next-line no-control-regex
    .replace(/[<>:"/\\|?*\x00-\x1f]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
  const sliced = Array.from(cleaned).slice(0, 60).join('').trim()
  return sliced.length > 0 ? sliced : 'untitled'
}

export function sanitizeExportFilename(title: string, format: 'json' | 'markdown'): string {
  const base = sanitizeTitle(title)
    .replace(/\s+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60)
  const safe = base.length > 0 ? base : 'export'
  return `${safe}.${format === 'json' ? 'json' : 'md'}`
}

export function defaultExportFilename(
  scope: 'current' | 'all',
  format: 'json' | 'markdown',
  now: number = Date.now()
): string {
  const date = new Date(now).toISOString().slice(0, 10)
  const ext = format === 'json' ? 'json' : 'md'
  return scope === 'all' ? `quickask-all-${date}.${ext}` : `quickask-session-${date}.${ext}`
}

function toExportMessage(message: ChatMessage): Record<string, unknown> {
  return {
    id: message.id,
    seq: message.seq,
    role: message.role,
    content: message.content,
    status: message.status,
    errorCode: message.errorCode,
    model: message.model,
    createdAt: message.createdAt,
    updatedAt: message.updatedAt
  }
}

function toExportSession(input: ExportSessionInput): Record<string, unknown> {
  return {
    id: input.session.id,
    title: input.session.title,
    createdAt: input.session.createdAt,
    updatedAt: input.session.updatedAt,
    lastMessageAt: input.session.lastMessageAt,
    model: input.session.model,
    messages: input.messages.map(toExportMessage)
  }
}

export function serializeSessionsToJson(
  sessions: ExportSessionInput[],
  now: number = Date.now()
): string {
  const payload: ExportPayload = {
    app: 'quickask',
    version: 1,
    exportedAt: now,
    count: sessions.length,
    sessions
  }
  const plain = {
    app: payload.app,
    version: payload.version,
    exportedAt: payload.exportedAt,
    count: payload.count,
    sessions: sessions.map(toExportSession)
  }
  assertNoSecretFields(plain)
  return `${JSON.stringify(plain, null, 2)}\n`
}

function markdownEscape(text: string): string {
  return text.replace(/\r/g, '')
}

export function serializeSessionsToMarkdown(
  sessions: ExportSessionInput[],
  now: number = Date.now()
): string {
  const lines: string[] = []
  lines.push('# QuickAsk 导出')
  lines.push('')
  lines.push(`导出时间: ${new Date(now).toISOString()}`)
  lines.push(`会话数: ${sessions.length}`)
  lines.push('')
  for (const input of sessions) {
    lines.push(`## ${markdownEscape(sanitizeTitle(input.session.title))}`)
    lines.push('')
    lines.push(`- id: \`${input.session.id}\``)
    lines.push(`- 更新: ${new Date(input.session.updatedAt).toISOString()}`)
    if (input.session.model) lines.push(`- 模型: \`${input.session.model}\``)
    lines.push('')
    if (input.messages.length === 0) {
      lines.push('_（空会话）_')
      lines.push('')
      continue
    }
    for (const message of input.messages) {
      const label = message.role === 'user' ? '用户' : message.role === 'assistant' ? '助手' : '系统'
      lines.push(`### ${label}`)
      lines.push('')
      lines.push(markdownEscape(redactSummary(message.content, 20_000) || ''))
      lines.push('')
      if (message.status === 'error' && message.errorCode) {
        lines.push(`> 错误: \`${message.errorCode}\``)
        lines.push('')
      }
    }
  }
  const output = `${lines.join('\n').trimEnd()}\n`
  assertNoSecretFields({ output })
  return output
}
