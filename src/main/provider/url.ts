/**
 * Provider URL normalization (plan D.2).
 *
 * Rules:
 *   https://api.deepseek.com            -> .../v1/chat/completions
 *   https://api.openai.com/v1           -> .../v1/chat/completions
 *   https://api.openai.com/v1/          -> .../v1/chat/completions
 *   .../chat/completions (any prefix)   -> unchanged
 *   https://host/openai/v1              -> .../openai/v1/chat/completions
 *   /models                             -> /v1/models
 *
 * Only `http:` / `https:` is allowed. Credentials in the URL, query strings
 * and fragments are rejected outright rather than silently stripped: a
 * provider base URL is an endpoint, not a link with parameters, and keeping
 * them would make redacted logging ambiguous.
 *
 * Local endpoints (`http://127.0.0.1`, `http://localhost`, `http://[::1]`)
 * are intentionally allowed for Ollama / llama.cpp.
 */

const ALLOWED_PROTOCOLS = new Set(['http:', 'https:'])

export const PROVIDER_URL_ERROR_CODE = 'invalid_base_url' as const

export class ProviderUrlError extends Error {
  readonly code = PROVIDER_URL_ERROR_CODE

  constructor(message: string) {
    super(message)
    this.name = 'ProviderUrlError'
  }
}

function invalid(message: string): ProviderUrlError {
  return new ProviderUrlError(message)
}

/**
 * Validate + normalize a base URL.
 *
 * Returns `<origin><path>` without a trailing slash and without query/hash.
 * Throws `ProviderUrlError` (`code: 'invalid_base_url'`) for anything that
 * could turn into a request to an unexpected origin.
 */
export function normalizeProviderBase(raw: string): string {
  if (typeof raw !== 'string') throw invalid('base_url is required')
  const trimmed = raw.trim()
  if (trimmed.length === 0) throw invalid('base_url is required')

  let url: URL
  try {
    url = new URL(trimmed)
  } catch {
    throw invalid('base_url must be a valid http(s) URL')
  }

  if (!ALLOWED_PROTOCOLS.has(url.protocol)) {
    throw invalid('base_url must use http or https')
  }
  if (url.hostname.length === 0) throw invalid('base_url must include a host')
  if (url.username.length > 0 || url.password.length > 0) {
    throw invalid('base_url must not contain credentials')
  }
  if (url.search.length > 0 || url.hash.length > 0) {
    throw invalid('base_url must not contain a query string or fragment')
  }

  let pathname = url.pathname.replace(/\/+$/, '')
  if (pathname === '/') pathname = ''
  return `${url.origin}${pathname}`
}

function pathnameOf(normalizedBase: string): string {
  return new URL(normalizedBase).pathname.replace(/\/+$/, '')
}

function hasChatCompletions(pathname: string): boolean {
  return /\/chat\/completions$/.test(pathname)
}

function hasModels(pathname: string): boolean {
  return /\/models$/.test(pathname)
}

function hasVersionSuffix(pathname: string): boolean {
  return /\/v\d+$/.test(pathname)
}

/** `<base>/v1/chat/completions` per D.2. */
export function chatCompletionsUrl(rawBase: string): string {
  const base = normalizeProviderBase(rawBase)
  const parsed = new URL(base)
  const pathname = pathnameOf(base)

  if (hasChatCompletions(pathname)) return base
  if (hasVersionSuffix(pathname)) return `${parsed.origin}${pathname}/chat/completions`
  return `${parsed.origin}${pathname}/v1/chat/completions`
}

/** `<base>/v1/models` per D.2. */
export function modelsUrl(rawBase: string): string {
  const base = normalizeProviderBase(rawBase)
  const parsed = new URL(base)
  const pathname = pathnameOf(base)

  if (hasModels(pathname)) return base
  if (hasChatCompletions(pathname)) {
    const prefix = pathname.slice(0, -'/chat/completions'.length)
    return `${parsed.origin}${prefix}/models`
  }
  if (hasVersionSuffix(pathname)) return `${parsed.origin}${pathname}/models`
  return `${parsed.origin}${pathname}/v1/models`
}

/**
 * Safe form of a provider URL for logs/errors.
 *
 * Keeps scheme + host + path (useful to identify the endpoint) and drops
 * credentials, query and fragment. Never returns the raw input when it cannot
 * be parsed.
 */
export function redactProviderUrl(raw: string): string {
  try {
    const url = new URL(raw)
    return `${url.protocol}//${url.host}${url.pathname}`
  } catch {
    return '[invalid-url]'
  }
}
