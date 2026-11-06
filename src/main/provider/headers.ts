import { createHash } from 'node:crypto'

/**
 * Provider request headers (plan D.2).
 *
 * Defaults:
 *   Content-Type: application/json
 *   Accept:       text/event-stream
 *   User-Agent:   QuickAsk/<version>
 *
 * `Authorization: Bearer <apiKey>` is added only when a key exists AND the
 * caller did not provide an explicit `Authorization` custom header.
 *
 * Custom headers are validated with the Task 11 rules: no empty names, no
 * CR/LF (name or value), no hop-by-hop / Host / Content-Length /
 * Transfer-Encoding / Connection / Upgrade / Proxy-* headers. Duplicate names
 * are case-insensitive and the last one wins.
 *
 * Header values are secrets in this app: nothing here ever logs them. Use
 * `headerSummary()` for diagnostics; it returns names + count only.
 *
 * Provider rule: the opencode-go gateway (`https://opencode.ai/zen/go/v1`)
 * answers 400 `MissingSessionID` unless `x-opencode-session` is present. When
 * `baseUrl` points at that gateway and the caller supplies a stable
 * `opencodeSessionId`, the header is injected (an explicit custom value still
 * wins).
 */

const FORBIDDEN_HEADER_NAMES = new Set([
  'host',
  'content-length',
  'transfer-encoding',
  'connection',
  'upgrade'
])

const HTTP_TOKEN = /^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/
const SENSITIVE_HEADER_NAME = /authorization|api[-_]?key|token|secret|cookie/i

export const PROVIDER_HEADER_ERROR_CODE = 'invalid_header' as const

export class ProviderHeaderError extends Error {
  readonly code = PROVIDER_HEADER_ERROR_CODE

  constructor(message: string) {
    super(message)
    this.name = 'ProviderHeaderError'
  }
}

function invalid(message: string): ProviderHeaderError {
  return new ProviderHeaderError(message)
}

export interface HeaderEntry {
  name: string
  value: string
}

/** Validate a header name (Task 11 rules) and return it trimmed. */
export function validateHeaderName(raw: string): string {
  if (typeof raw !== 'string') throw invalid('header name cannot be empty')
  const name = raw.trim()
  if (name.length === 0) throw invalid('header name cannot be empty')
  if (name.includes('\r') || name.includes('\n')) {
    throw invalid('header name cannot contain CR/LF')
  }
  if (!HTTP_TOKEN.test(name)) throw invalid('header name contains invalid characters')

  const lower = name.toLowerCase()
  if (FORBIDDEN_HEADER_NAMES.has(lower) || lower.startsWith('proxy-')) {
    throw invalid(`header "${name}" is not allowed`)
  }
  return name
}

/** Validate a header value: no CR/LF/NUL (header injection). */
export function validateHeaderValue(raw: string): string {
  if (typeof raw !== 'string') throw invalid('header value must be a string')
  if (raw.includes('\r') || raw.includes('\n') || raw.includes('\u0000')) {
    throw invalid('header value cannot contain CR/LF/NUL')
  }
  return raw
}

export function isSensitiveHeaderName(name: string): boolean {
  return SENSITIVE_HEADER_NAME.test(name)
}

function hasHeader(headers: Record<string, string>, name: string): boolean {
  const lower = name.toLowerCase()
  return Object.keys(headers).some((key) => key.toLowerCase() === lower)
}

/** opencode-go routing header: the gateway answers 400 `MissingSessionID` without it. */
export const OPENCODE_SESSION_HEADER = 'x-opencode-session'

/**
 * True for the opencode-go gateway (`https://opencode.ai/zen/go/v1`).
 * Trailing slashes and query strings are tolerated; the plain zen endpoint
 * (`/zen/v1`) and other opencode.ai paths are not part of the go plan.
 */
export function isOpencodeGoEndpoint(rawUrl: string | null | undefined): boolean {
  if (!rawUrl) return false
  let url: URL
  try {
    url = new URL(rawUrl.trim())
  } catch {
    return false
  }
  const host = url.hostname.toLowerCase()
  if (host !== 'opencode.ai' && !host.endsWith('.opencode.ai')) return false
  return /\/zen\/go(\/|$)/i.test(url.pathname)
}

/**
 * Stable per-profile routing id for opencode-go (UUID v4 shape).
 *
 * Derived from the profile id, so the gateway sees the same session across
 * restarts without storing yet another secret. Any stable UUID is accepted;
 * values differ per profile so two profiles do not share a routing lane.
 */
export function opencodeSessionIdFor(seed: string): string {
  const digest = createHash('sha256').update(`quickask:opencode-session:${seed}`).digest()
  const bytes = Buffer.from(digest.subarray(0, 16))
  bytes[6] = (bytes[6]! & 0x0f) | 0x40
  bytes[8] = (bytes[8]! & 0x3f) | 0x80
  const hex = bytes.toString('hex')
  return [
    hex.slice(0, 8),
    hex.slice(8, 12),
    hex.slice(12, 16),
    hex.slice(16, 20),
    hex.slice(20)
  ].join('-')
}

/**
 * Validate and de-duplicate custom headers.
 * Case-insensitive duplicate names: the last entry wins, and the winning
 * spelling is kept.
 */
export function normalizeCustomHeaders(
  input: Record<string, string> | HeaderEntry[] | undefined
): Record<string, string> {
  if (!input) return {}

  const entries: HeaderEntry[] = Array.isArray(input)
    ? input
    : Object.entries(input).map(([name, value]) => ({ name, value }))

  const byLower = new Map<string, HeaderEntry>()
  for (const entry of entries) {
    const name = validateHeaderName(entry.name)
    const value = validateHeaderValue(entry.value)
    const lower = name.toLowerCase()
    byLower.delete(lower)
    byLower.set(lower, { name, value })
  }

  const result: Record<string, string> = {}
  for (const entry of byLower.values()) result[entry.name] = entry.value
  return result
}

export interface BuildProviderHeadersOptions {
  apiKey?: string | null
  customHeaders?: Record<string, string> | HeaderEntry[]
  /** App version; rendered as `QuickAsk/<version>`. */
  version?: string
  /** Override the default `Accept` (default `text/event-stream`). */
  accept?: string
  /** Endpoint being called; enables provider-specific header rules. */
  baseUrl?: string
  /** Stable routing id for opencode-go (`x-opencode-session`). */
  opencodeSessionId?: string
}

export interface ProviderHeadersResult {
  headers: Record<string, string>
  /** Whether a Bearer token was injected from `apiKey`. */
  injectedAuthorization: boolean
  /** Lower-case header names present in the request (no values). */
  names: string[]
}

/** Build the final request headers (defaults + auth + validated custom). */
export function buildProviderHeaders(
  options: BuildProviderHeadersOptions = {}
): ProviderHeadersResult {
  const version = (options.version ?? '0.0.0').trim() || '0.0.0'
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    Accept: options.accept ?? 'text/event-stream',
    'User-Agent': `QuickAsk/${version}`
  }

  const custom = normalizeCustomHeaders(options.customHeaders)

  let injectedAuthorization = false
  const apiKey = typeof options.apiKey === 'string' ? options.apiKey.trim() : ''
  if (apiKey.length > 0 && !hasHeader(custom, 'authorization')) {
    headers.Authorization = `Bearer ${apiKey}`
    injectedAuthorization = true
  }

  // opencode-go refuses to route without a stable session id, so add one for
  // `zen/go` endpoints unless the user configured the header themselves.
  const sessionId = (options.opencodeSessionId ?? '').trim()
  if (
    sessionId.length > 0 &&
    isOpencodeGoEndpoint(options.baseUrl) &&
    !hasHeader(custom, OPENCODE_SESSION_HEADER)
  ) {
    headers[OPENCODE_SESSION_HEADER] = sessionId
  }

  // Custom headers win over defaults (case-insensitively).
  for (const [name, value] of Object.entries(custom)) {
    const lower = name.toLowerCase()
    for (const existing of Object.keys(headers)) {
      if (existing.toLowerCase() === lower) delete headers[existing]
    }
    headers[name] = value
  }

  return {
    headers,
    injectedAuthorization,
    names: Object.keys(headers).map((name) => name.toLowerCase())
  }
}

/**
 * Diagnostics-only summary. Never includes header values or the API key.
 */
export function headerSummary(headers: Record<string, string>): {
  count: number
  names: string[]
} {
  const names = Object.keys(headers)
    .map((name) => name.toLowerCase())
    .sort()
  return { count: names.length, names }
}
