/**
 * Provider proxy selection (Task 33a).
 *
 * Modes:
 *   - `direct`: never use a proxy.
 *   - `system`: read HTTP_PROXY / HTTPS_PROXY / ALL_PROXY / NO_PROXY
 *     (upper and lower case). Loopback always bypasses. SOCKS is rejected:
 *     system mode keeps the M1 HTTP(S)-only contract.
 *   - `custom`: use the explicitly configured proxy URL. HTTP(S) uses
 *     `undici.ProxyAgent`, SOCKS5/SOCKS5H uses `undici.Socks5ProxyAgent`.
 *
 * Credentials are never persisted in SQLite. `ProviderService` reads the
 * keyring entry and embeds it into the in-memory URL right before a request;
 * this module registers those values for log redaction.
 */

import { Agent, ProxyAgent, Socks5ProxyAgent, buildConnector } from 'undici'
import type { Dispatcher } from 'undici'
import { registerSecretValue } from '../secrets/redact'

export type ProviderProxyMode = 'direct' | 'system' | 'custom'
export type ProviderProxyKind = 'http' | 'socks5'
export type ProviderProxyEnv = Record<string, string | undefined>

export interface ProviderProxyProfile {
  proxyMode?: string | null
  proxyUrl?: string | null
}

export interface ProviderProxyTimeouts {
  connectMs: number
}

export class ProviderProxyError extends Error {
  readonly code = 'proxy' as const

  constructor(message: string) {
    super(message)
    this.name = 'ProviderProxyError'
  }
}

const STORABLE_PROTOCOLS = new Set(['http:', 'https:', 'socks5:', 'socks5h:'])

const LEGACY_DIRECT = new Set(['direct', 'none', 'off', 'disabled', 'no_proxy', 'noproxy', 'bypass'])
const LEGACY_SYSTEM = new Set([
  'system',
  'env',
  'environment',
  'auto',
  'proxy',
  'on',
  'default'
])

/** Normalize DB/legacy values to the three supported modes. */
export function normalizeProxyMode(raw: string | null | undefined): ProviderProxyMode {
  const value = typeof raw === 'string' ? raw.trim().toLowerCase() : ''
  if (value.length === 0) return 'system'
  if (value === 'custom') return 'custom'
  if (LEGACY_DIRECT.has(value)) return 'direct'
  if (LEGACY_SYSTEM.has(value)) return 'system'
  return 'system'
}

function readEnv(env: ProviderProxyEnv, name: string): string {
  const upper = env[name]
  if (typeof upper === 'string' && upper.trim().length > 0) return upper.trim()
  const lower = env[name.toLowerCase()]
  if (typeof lower === 'string' && lower.trim().length > 0) return lower.trim()
  return ''
}

function normalizeHostname(hostname: string): string {
  return hostname.toLowerCase().replace(/^\[|\]$/g, '')
}

function isLoopbackHost(hostname: string): boolean {
  const host = normalizeHostname(hostname)
  return host === 'localhost' || host === '127.0.0.1' || host === '::1'
}

function parseNoProxyEntries(value: string): string[] {
  return value
    .split(',')
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0)
}

function noProxyMatches(entries: string[], target: URL): boolean {
  const targetHost = normalizeHostname(target.hostname)
  const targetPort = target.port || (target.protocol === 'https:' ? '443' : '80')

  for (const rawEntry of entries) {
    if (rawEntry === '*') return true

    let entry = rawEntry
    // Accept entries with a scheme (`http://host`) defensively.
    if (/^[a-z][a-z0-9+.-]*:\/\//i.test(entry)) {
      try {
        const parsed = new URL(entry)
        entry = parsed.host
      } catch {
        continue
      }
    }

    let entryHost = entry
    let entryPort: string | null = null

    if (entry.startsWith('[')) {
      const close = entry.indexOf(']')
      if (close !== -1) {
        entryHost = entry.slice(0, close + 1)
        const rest = entry.slice(close + 1)
        if (rest.startsWith(':')) entryPort = rest.slice(1)
      }
    } else {
      const lastColon = entry.lastIndexOf(':')
      if (lastColon > 0 && entry.indexOf(':') === lastColon) {
        const maybePort = entry.slice(lastColon + 1)
        if (/^\d+$/.test(maybePort)) {
          entryHost = entry.slice(0, lastColon)
          entryPort = maybePort
        }
      }
    }

    if (entryPort !== null && entryPort !== targetPort) continue

    let host = normalizeHostname(entryHost)
    if (host.startsWith('.')) host = host.slice(1)
    if (host.length === 0) continue

    if (targetHost === host || targetHost.endsWith(`.${host}`)) return true
  }
  return false
}

/** Always bypass loopback; honour NO_PROXY / no_proxy for everything else. */
export function shouldBypassProxy(
  target: URL,
  env: ProviderProxyEnv = process.env
): boolean {
  if (isLoopbackHost(target.hostname)) return true
  const noProxy = readEnv(env, 'NO_PROXY')
  if (noProxy.length === 0) return false
  return noProxyMatches(parseNoProxyEntries(noProxy), target)
}

function parseProxyEndpoint(raw: string, label: string): URL {
  let parsed: URL
  try {
    parsed = new URL(raw)
  } catch {
    throw new ProviderProxyError(`${label} URL 无效`)
  }

  if (!STORABLE_PROTOCOLS.has(parsed.protocol.toLowerCase())) {
    throw new ProviderProxyError(
      `${label} URL 必须是 http/https/socks5/socks5h`
    )
  }
  if (parsed.hostname.length === 0) {
    throw new ProviderProxyError(`${label} URL 缺少主机`)
  }
  return parsed
}

/** Resolve the system-environment proxy. `null` means a direct connection. */
export function resolveEnvProxy(
  target: URL,
  env: ProviderProxyEnv = process.env
): string | null {
  if (shouldBypassProxy(target, env)) return null

  const https = target.protocol === 'https:'
  const candidates = https
    ? [
        readEnv(env, 'HTTPS_PROXY'),
        readEnv(env, 'ALL_PROXY'),
        readEnv(env, 'HTTP_PROXY')
      ]
    : [readEnv(env, 'HTTP_PROXY'), readEnv(env, 'ALL_PROXY')]

  const raw = candidates.find((value) => value.length > 0)
  if (!raw) return null

  const parsed = parseProxyEndpoint(raw, '代理')
  const protocol = parsed.protocol.toLowerCase()
  if (protocol === 'socks5:' || protocol === 'socks5h:') {
    throw new ProviderProxyError('系统环境中的 SOCKS 代理需要切换到自定义代理模式')
  }
  if (protocol !== 'http:' && protocol !== 'https:') {
    throw new ProviderProxyError('代理 URL 必须是 http/https')
  }
  return parsed.toString()
}

/**
 * Resolve the proxy for a profile. `custom` intentionally ignores NO_PROXY and
 * loopback: the user explicitly chose this proxy for the profile.
 */
export function resolveProfileProxy(
  target: URL,
  profile: ProviderProxyProfile,
  env: ProviderProxyEnv = process.env
): string | null {
  const mode = normalizeProxyMode(profile.proxyMode)
  if (mode === 'direct') return null
  if (mode === 'system') return resolveEnvProxy(target, env)

  const raw = typeof profile.proxyUrl === 'string' ? profile.proxyUrl.trim() : ''
  if (raw.length === 0) {
    throw new ProviderProxyError('自定义代理 URL 不能为空')
  }
  const parsed = parseProxyEndpoint(raw, '自定义代理')
  if (parsed.username.length > 0) registerSecretValue(decodeURIComponent(parsed.username))
  if (parsed.password.length > 0) registerSecretValue(decodeURIComponent(parsed.password))
  return parsed.toString()
}

/** Kind of proxy endpoint, for diagnostics and dispatcher selection. */
export function proxyKind(proxyUrl: string): ProviderProxyKind {
  const protocol = new URL(proxyUrl).protocol.toLowerCase()
  return protocol === 'socks5:' || protocol === 'socks5h:' ? 'socks5' : 'http'
}

export interface ProxyAuth {
  username: string
  password: string
}

/**
 * Insert keyring credentials into an in-memory proxy URL. Never persist the
 * result. The URL API percent-encodes userinfo, and undici decodes it.
 */
export function withProxyAuth(
  proxyUrl: string,
  auth: ProxyAuth | null | undefined
): string {
  if (!auth || (auth.username.length === 0 && auth.password.length === 0)) return proxyUrl
  const url = new URL(proxyUrl)
  url.username = auth.username
  url.password = auth.password
  registerSecretValue(auth.username)
  registerSecretValue(auth.password)
  registerSecretValue(encodeURIComponent(auth.username))
  registerSecretValue(encodeURIComponent(auth.password))
  return url.toString()
}

/** `alice` -> `a***e`; never exposes the full username. */
export function maskProxyUsername(username: string): string {
  if (username.length === 0) return ''
  if (username.length === 1) return `${username}***`
  if (username.length === 2) return `${username[0]}***`
  return `${username[0]}***${username[username.length - 1]}`
}

/**
 * Validate/normalize a proxy URL for storage. Credentials must never reach
 * SQLite, so userinfo is rejected here rather than stripped silently.
 */
export function normalizeProxyUrlForStorage(raw: string | null | undefined): string | null {
  if (raw === null || raw === undefined) return null
  const trimmed = raw.trim()
  if (trimmed.length === 0) return null

  const parsed = parseProxyEndpoint(trimmed, '代理')
  if (parsed.username.length > 0 || parsed.password.length > 0) {
    throw new ProviderProxyError('代理 URL 不能包含用户名或密码，请使用独立认证字段')
  }
  if (parsed.search.length > 0 || parsed.hash.length > 0) {
    throw new ProviderProxyError('代理 URL 不能包含查询串或片段')
  }
  return parsed.toString()
}

function agentOptions(timeouts: ProviderProxyTimeouts): {
  connect: { timeout: number }
  connectTimeout: number
  headersTimeout: number
  bodyTimeout: number
} {
  return {
    connect: { timeout: timeouts.connectMs },
    connectTimeout: timeouts.connectMs,
    // Our own timers are authoritative; disable undici's defaults so they
    // cannot fire first with a less specific code.
    headersTimeout: 0,
    bodyTimeout: 0
  }
}

/** Build a per-request dispatcher. `null` selects the direct HTTP stack. */
export function createProxyDispatcher(
  proxy: string | null,
  timeouts: ProviderProxyTimeouts
): Dispatcher {
  const options = agentOptions(timeouts)
  if (!proxy) return new Agent(options)

  const parsed = new URL(proxy)
  if (proxyKind(proxy) === 'socks5') {
    // undici accepts socks5:/socks: only. It already sends the target hostname
    // to the proxy, so socks5h semantics (remote DNS) are preserved.
    const normalized = new URL(proxy)
    normalized.protocol = 'socks5:'
    return new Socks5ProxyAgent(normalized.toString(), {
      connect: buildConnector({ timeout: timeouts.connectMs }),
      connections: 1
    })
  }

  return new ProxyAgent({
    uri: parsed.toString(),
    proxyTunnel: true,
    ...options
  })
}
