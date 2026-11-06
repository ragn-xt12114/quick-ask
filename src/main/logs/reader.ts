import { existsSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { redact } from '../secrets/redact'

export const MAX_LOG_VIEW_BYTES = 64 * 1024

export interface RecentLogs {
  path: string
  content: string
  bytes: number
  truncated: boolean
}

export function readRecentLogs(
  logDir: string,
  fileName = 'quickask.log',
  maxBytes: number = MAX_LOG_VIEW_BYTES,
  fs: {
    existsSync(path: string): boolean
    statSync(path: string): { size: number }
    readFileSync(path: string): Buffer
  } = { existsSync, statSync, readFileSync }
): RecentLogs {
  const cap = Math.max(1, Math.min(MAX_LOG_VIEW_BYTES, Math.floor(maxBytes)))
  const path = join(logDir, fileName)
  if (!fs.existsSync(path)) {
    return { path, content: '', bytes: 0, truncated: false }
  }
  try {
    fs.statSync(path)
  } catch {
    return { path, content: '', bytes: 0, truncated: false }
  }
  let raw: Buffer
  try {
    raw = fs.readFileSync(path)
  } catch {
    return { path, content: '', bytes: 0, truncated: false }
  }
  const truncated = raw.length > cap
  const tail = truncated ? raw.subarray(raw.length - cap) : raw
  const text = tail.toString('utf8')
  const redacted = redact(text)
  return {
    path,
    content: redacted.slice(-cap),
    bytes: Math.min(raw.length, cap),
    truncated
  }
}
