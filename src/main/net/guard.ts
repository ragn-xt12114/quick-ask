/**
 * Outbound network guard (plan D.9 / NFR-10).
 *
 * Runtime policy for the main process:
 *   - only `http:` / `https:` targets;
 *   - exact origin allowlist built from configured provider base URLs;
 *   - configured proxy origins (environment HTTP_PROXY/HTTPS_PROXY/ALL_PROXY);
 *   - loopback (`localhost`, `127.0.0.0/8`, `::1`) for local models/mocks.
 *
 * There is deliberately no wildcard, suffix or `*.example.com` support: a
 * compromised renderer/plugin cannot pivot the provider transport to an
 * arbitrary host.
 *
 * The registry is updated by `ProviderService` whenever profiles change; see
 * `src/main/services/app-services.ts` for the composition root.
 */

export type NetworkGuardErrorCode =
  | 'INVALID_URL'
  | 'OUTBOUND_BLOCKED'
  | 'RENDERER_NETWORK'

export class NetworkGuardError extends Error {
  readonly code: NetworkGuardErrorCode
  /** Hostname only (never a URL with query/userinfo). */
  readonly host: string | null

  constructor(code: NetworkGuardErrorCode, message: string, host: string | null = null) {
    super(message)
    this.name = 'NetworkGuardError'
    this.code = code
    this.host = host
  }
}

export interface OutboundAllowlist {
  providerBaseUrls?: readonly string[]
  proxyUrls?: readonly string[]
}

export interface OutboundGuardOptions extends OutboundAllowlist {
  /** When provided, proxy origins are read from this environment. */
  env?: NodeJS.ProcessEnv
}

export interface OutboundGuardSnapshot {
  providerOrigins: string[]
  proxyOrigins: string[]
  loopback: true
}

export type ProxyEnv = Record<string, string | undefined>

function normalizeHostname(hostname: string): string {
  return hostname.toLowerCase().replace(/^\[|\]$/g, '')
}

export function isLoopbackHostname(hostname: string): boolean {
  const host = normalizeHostname(hostname)
  if (host === 'localhost' || host === '::1' || host === '0:0:0:0:0:0:0:1') return true
  if (host === '::ffff:127.0.0.1') return true

  if (!host.startsWith('127.')) return false
  const parts = host.split('.')
  if (parts.length !== 4) return false
  return parts.every((part) => {
    if (!/^\d{1,3}$/.test(part)) return false
    const value = Number(part)
    return value >= 0 && value <= 255
  })
}

function parseOrigin(raw: string): string | null {
  try {
    const url = new URL(raw)
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return null
    if (url.hostname.length === 0) return null
    if (url.username.length > 0 || url.password.length > 0) return null
    return url.origin
  } catch {
    return null
  }
}

function readEnv(env: ProxyEnv, name: string): string {
  const upper = env[name]
  if (typeof upper === 'string' && upper.trim().length > 0) return upper.trim()
  const lower = env[name.toLowerCase()]
  if (typeof lower === 'string' && lower.trim().length > 0) return lower.trim()
  return ''
}

/** Proxy URLs from HTTP_PROXY / HTTPS_PROXY / ALL_PROXY (both cases). */
export function proxyUrlsFromEnv(env: ProxyEnv = process.env): string[] {
  const urls: string[] = []
  for (const name of ['HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY']) {
    const value = readEnv(env, name)
    if (value.length > 0) urls.push(value)
  }
  return urls
}

export class OutboundGuard {
  private providerOrigins = new Set<string>()
  private proxyOrigins = new Set<string>()

  constructor(options: OutboundGuardOptions = {}) {
    if (options.providerBaseUrls) this.setProviderBaseUrls(options.providerBaseUrls)
    if (options.proxyUrls) this.setProxyUrls(options.proxyUrls)
    if (options.env) this.setProxyUrls(proxyUrlsFromEnv(options.env))
  }

  setProviderBaseUrls(urls: readonly string[]): void {
    const next = new Set<string>()
    for (const url of urls) {
      const origin = parseOrigin(url)
      if (origin !== null) next.add(origin)
    }
    this.providerOrigins = next
  }

  setProxyUrls(urls: readonly string[]): void {
    const next = new Set<string>()
    for (const url of urls) {
      const origin = parseOrigin(url)
      if (origin !== null) next.add(origin)
    }
    this.proxyOrigins = next
  }

  refreshProxyFromEnv(env: ProxyEnv = process.env): void {
    this.setProxyUrls(proxyUrlsFromEnv(env))
  }

  /** Throws `NetworkGuardError` unless the target is explicitly allowed. */
  assertAllowedOutbound(input: string | URL): URL {
    let url: URL
    try {
      url = input instanceof URL ? new URL(input.toString()) : new URL(input)
    } catch {
      throw new NetworkGuardError('INVALID_URL', 'Outbound URL is not a valid URL')
    }

    if (url.protocol !== 'http:' && url.protocol !== 'https:') {
      throw new NetworkGuardError(
        'OUTBOUND_BLOCKED',
        `Outbound blocked: unsupported protocol ${url.protocol}`,
        normalizeHostname(url.hostname) || null
      )
    }

    if (url.username.length > 0 || url.password.length > 0) {
      throw new NetworkGuardError(
        'OUTBOUND_BLOCKED',
        'Outbound blocked: credentials in URL',
        normalizeHostname(url.hostname) || null
      )
    }

    if (url.hostname.length === 0) {
      throw new NetworkGuardError('INVALID_URL', 'Outbound URL has no hostname')
    }

    if (isLoopbackHostname(url.hostname)) return url

    const origin = url.origin
    if (this.providerOrigins.has(origin) || this.proxyOrigins.has(origin)) return url

    throw new NetworkGuardError(
      'OUTBOUND_BLOCKED',
      `Outbound blocked: ${normalizeHostname(url.hostname)} is not a configured provider, proxy or loopback host`,
      normalizeHostname(url.hostname)
    )
  }

  /** No secrets, no paths from the request: just the allowlist snapshot. */
  snapshot(): OutboundGuardSnapshot {
    return {
      providerOrigins: Array.from(this.providerOrigins).sort(),
      proxyOrigins: Array.from(this.proxyOrigins).sort(),
      loopback: true
    }
  }
}

/** Stateless helper requested by the Task 17 contract. */
export function assertAllowedOutbound(
  input: string | URL,
  allowlist: OutboundAllowlist = {}
): URL {
  return new OutboundGuard(allowlist).assertAllowedOutbound(input)
}

export interface RendererNetworkPolicy {
  csp: string
  contextIsolation: boolean
  sandbox: boolean
  nodeIntegration: boolean
  webSecurity: boolean
  webviewTag: boolean
}

/**
 * Belt-and-braces check for the renderer boundary (Task 9 already installs
 * CSP `connect-src 'none'` and denies permissions). Called once at startup.
 */
export function assertNoRendererNetwork(policy: RendererNetworkPolicy): void {
  if (!/connect-src\s+'none'/i.test(policy.csp)) {
    throw new NetworkGuardError('RENDERER_NETWORK', 'Renderer CSP must contain connect-src \'none\'')
  }
  if (
    policy.contextIsolation !== true ||
    policy.sandbox !== true ||
    policy.nodeIntegration !== false ||
    policy.webSecurity !== true ||
    policy.webviewTag !== false
  ) {
    throw new NetworkGuardError(
      'RENDERER_NETWORK',
      'Renderer Node/network isolation flags were weakened'
    )
  }
}
