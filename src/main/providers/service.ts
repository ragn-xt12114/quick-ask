/**
 * Provider profile service.
 *
 * SQLite stores only non-secret metadata: name, base_url, model, key_ref,
 * header names + `secret` flags, proxy fields and sampling/timeout settings.
 * API keys and every custom header value live in SecretStore (OS keyring).
 */

import { uuidv7 } from '../../shared/uuidv7'
import type {
  ProviderCreateRequest,
  ProviderDeleteResult,
  ProviderHeaderInput,
  ProviderHeaderView,
  ProviderListModelsResult,
  ProviderProfileView,
  ProviderProxyAuthInput,
  ProviderTestResult,
  ProviderUpdateRequest
} from '../../shared/channels'
import type { DbService } from '../db/service'
import type { ProviderHeaderName, ProviderProfile } from '../db/repositories/providers'
import type { ProviderStreamProfile } from '../provider/client'
import { providerFetch, type ProviderFetch } from '../provider/simple-request'
import {
  buildProviderHeaders,
  isOpencodeGoEndpoint,
  isSensitiveHeaderName,
  OPENCODE_SESSION_HEADER,
  opencodeSessionIdFor,
  ProviderHeaderError,
  validateHeaderName,
  validateHeaderValue
} from '../provider/headers'
import {
  chatCompletionsUrl,
  modelsUrl,
  normalizeProviderBase,
  ProviderUrlError
} from '../provider/url'
import { redactSummary, registerSecretValue } from '../secrets/redact'
import type { OutboundGuard } from '../net/guard'
import type { SecretStore } from '../secrets/store'
import type { Dispatcher } from 'undici'
import {
  createProxyDispatcher,
  maskProxyUsername,
  normalizeProxyMode,
  normalizeProxyUrlForStorage,
  ProviderProxyError,
  resolveProfileProxy,
  withProxyAuth,
  type ProviderProxyEnv,
  type ProxyAuth
} from '../provider/proxy'

export const PROVIDER_KEYRING_SERVICE = 'quickask'

export function providerApiKeyAccount(id: string): string {
  return `provider:${id}:api_key`
}

export function providerHeadersAccount(id: string): string {
  return `provider:${id}:headers`
}

export function providerProxyAccount(id: string): string {
  return `provider:${id}:proxy`
}

function parseProxyAuth(raw: string | null): ProxyAuth | null {
  if (!raw) return null
  try {
    const parsed: unknown = JSON.parse(raw)
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return null
    const record = parsed as { username?: unknown; password?: unknown }
    const username = typeof record.username === 'string' ? record.username : ''
    const password = typeof record.password === 'string' ? record.password : ''
    if (username.length === 0 && password.length === 0) return null
    return { username, password }
  } catch {
    return null
  }
}

export type ProviderErrorCode =
  | 'INVALID_ARGUMENT'
  | 'NOT_FOUND'
  | 'SECRET'
  | 'AUTH'
  | 'NETWORK'
  | 'PROXY'
  | 'TIMEOUT'
  | 'PROTOCOL'
  | 'RATE_LIMIT'
  | 'SERVER'
  | 'BAD_REQUEST'

export class ProviderError extends Error {
  readonly code: ProviderErrorCode

  constructor(code: ProviderErrorCode, message: string) {
    super(message)
    this.name = 'ProviderError'
    this.code = code
  }
}

function invalid(message: string): ProviderError {
  return new ProviderError('INVALID_ARGUMENT', message)
}

function normalizeHeaderName(raw: string): string {
  try {
    return validateHeaderName(raw)
  } catch (error) {
    if (error instanceof ProviderHeaderError) throw invalid(error.message)
    throw error
  }
}

function normalizeHeaderValue(raw: string): string {
  try {
    return validateHeaderValue(raw)
  } catch (error) {
    if (error instanceof ProviderHeaderError) throw invalid(error.message)
    throw error
  }
}

function headerDefaultsToSecret(name: string): boolean {
  return isSensitiveHeaderName(name)
}

interface NormalizedHeaders {
  names: ProviderHeaderName[]
  values: Record<string, string>
}

function findExistingValue(
  existing: Record<string, string>,
  name: string
): string | undefined {
  const lower = name.toLowerCase()
  for (const [key, value] of Object.entries(existing)) {
    if (key.toLowerCase() === lower) return value
  }
  return undefined
}

function normalizeHeaders(
  input: ProviderHeaderInput[] | undefined,
  existing: Record<string, string>
): NormalizedHeaders {
  if (!input) return { names: [], values: {} }

  const byLower = new Map<string, { name: string; secret: boolean; value: string }>()

  for (const entry of input) {
    const name = normalizeHeaderName(entry.name)
    const lower = name.toLowerCase()
    const previous = byLower.get(lower)
    const retained =
      entry.value !== undefined ? normalizeHeaderValue(entry.value) : findExistingValue(existing, name)
    if (retained === undefined) throw invalid(`header "${name}" needs a value`)
    byLower.delete(lower)
    byLower.set(lower, {
      name,
      secret: entry.secret === true || previous?.secret === true || headerDefaultsToSecret(name),
      value: retained
    })
  }

  const names: ProviderHeaderName[] = []
  const values: Record<string, string> = {}
  for (const entry of byLower.values()) {
    names.push({ name: entry.name, secret: entry.secret })
    values[entry.name] = entry.value
  }
  return { names, values }
}

function parseHeaderValues(raw: string | null): Record<string, string> {
  if (!raw) return {}
  try {
    const parsed: unknown = JSON.parse(raw)
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return {}
    const values: Record<string, string> = {}
    for (const [key, value] of Object.entries(parsed)) {
      if (typeof value === 'string') values[key] = value
    }
    return values
  } catch {
    return {}
  }
}

interface RawResponse {
  status: number
  text: string
}

interface ProxyContext {
  mode: string
  url: string | null
  auth: ProxyAuth | null
}

function statusToError(status: number): ProviderError {
  if (status === 401 || status === 403) return new ProviderError('AUTH', '认证失败，请检查 API key/权限')
  if (status === 429) return new ProviderError('RATE_LIMIT', '限流，稍后再试')
  if (status === 400 || status === 422) return new ProviderError('BAD_REQUEST', '请求被拒绝（模型/参数）')
  if (status >= 500) return new ProviderError('SERVER', `服务端错误 (${status})`)
  if (status >= 300 && status < 400) {
    return new ProviderError('PROTOCOL', '端点重定向被阻止')
  }
  return new ProviderError('PROTOCOL', `响应格式不符合 OpenAI 兼容协议 (${status})`)
}

function parseModels(text: string): string[] {
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    throw new ProviderError('PROTOCOL', '响应不是合法 JSON')
  }
  if (typeof parsed !== 'object' || parsed === null) {
    throw new ProviderError('PROTOCOL', '响应格式不符合 OpenAI 兼容协议')
  }
  const record = parsed as { data?: unknown; models?: unknown }
  const list = Array.isArray(record.data) ? record.data : Array.isArray(record.models) ? record.models : null
  if (!list) throw new ProviderError('PROTOCOL', '响应缺少 models/data')

  const ids: string[] = []
  for (const entry of list) {
    if (typeof entry === 'string') ids.push(entry)
    else if (typeof entry === 'object' && entry !== null) {
      const id = (entry as { id?: unknown; name?: unknown }).id ?? (entry as { name?: unknown }).name
      if (typeof id === 'string' && id.length > 0) ids.push(id)
    }
  }
  return ids
}

export interface ProviderServiceOptions {
  fetchImpl?: ProviderFetch
  now?: () => number
  defaultTestTimeoutMs?: number
  version?: string
  /** Runtime outbound allowlist (Task 17). */
  guard?: OutboundGuard
  /** Called whenever the DB profile set changes (Task 17). */
  onProfilesChanged?: (baseUrls: string[]) => void
  /** Environment used by `system` proxy mode; defaults to process.env. */
  env?: ProviderProxyEnv
}

export class ProviderService {
  private readonly fetchImpl: ProviderFetch
  private readonly now: () => number
  private readonly defaultTestTimeoutMs: number
  private readonly version: string
  private readonly guard: OutboundGuard | null
  private readonly onProfilesChanged: ((baseUrls: string[]) => void) | null
  private readonly env: ProviderProxyEnv
  private readonly changeListeners = new Set<() => void>()

  constructor(
    private readonly db: DbService,
    private readonly secrets: SecretStore,
    options: ProviderServiceOptions = {}
  ) {
    this.fetchImpl = options.fetchImpl ?? providerFetch
    this.now = options.now ?? Date.now
    this.defaultTestTimeoutMs = options.defaultTestTimeoutMs ?? 5000
    this.version = options.version ?? '0.0.0'
    this.guard = options.guard ?? null
    this.env = options.env ?? process.env
    this.onProfilesChanged = options.onProfilesChanged ?? null
    this.notifyProfilesChanged()
  }

  // -------------------------------------------------------------------------
  // CRUD
  // -------------------------------------------------------------------------

  async createProfile(input: ProviderCreateRequest): Promise<ProviderProfileView> {
    const name = input.name.trim()
    if (name.length === 0) throw invalid('name is required')
    const model = input.model.trim()
    if (model.length === 0) throw invalid('model is required')

    let baseUrl: string
    try {
      baseUrl = normalizeProviderBase(input.baseUrl)
    } catch (error) {
      if (error instanceof ProviderUrlError) throw invalid(error.message)
      throw error
    }

    let proxyUrl: string | null
    try {
      proxyUrl = normalizeProxyUrlForStorage(input.proxyUrl)
    } catch (error) {
      if (error instanceof ProviderProxyError) throw invalid(error.message)
      throw error
    }
    const proxyMode = normalizeProxyMode(input.proxyMode)

    const id = uuidv7()
    const headers = normalizeHeaders(input.headers, {})

    await this.writeSecrets(id, input.apiKey, headers.values)
    if (input.proxyAuth !== undefined) {
      await this.writeProxyAuth(id, input.proxyAuth)
    }

    const profile = this.db.driver.transaction(() => {
      if (input.isDefault) {
        this.db.driver.prepare('UPDATE provider_profiles SET is_default = 0').run()
      }
      return this.db.providers.create({
        id,
        name,
        baseUrl,
        model,
        keyRef: providerApiKeyAccount(id),
        headerNames: headers.names,
        proxyMode,
        proxyUrl,
        temperature: input.temperature ?? null,
        maxTokens: input.maxTokens ?? null,
        timeoutMs: input.timeoutMs ?? 30_000,
        isDefault: input.isDefault === true,
        createdAt: this.now(),
        updatedAt: this.now()
      })
    })

    this.notifyProfilesChanged()
    return this.toView(profile)
  }

  async updateProfile(id: string, patch: ProviderUpdateRequest): Promise<ProviderProfileView> {
    const current = this.db.providers.get(id)
    if (!current) throw new ProviderError('NOT_FOUND', 'Provider profile not found')

    let baseUrl = current.baseUrl
    if (patch.baseUrl !== undefined) {
      try {
        baseUrl = normalizeProviderBase(patch.baseUrl)
      } catch (error) {
        if (error instanceof ProviderUrlError) throw invalid(error.message)
        throw error
      }
    }

    if (patch.name !== undefined && patch.name.trim().length === 0) {
      throw invalid('name is required')
    }
    if (patch.model !== undefined && patch.model.trim().length === 0) {
      throw invalid('model is required')
    }

    const proxyMode =
      patch.proxyMode !== undefined
        ? normalizeProxyMode(patch.proxyMode)
        : normalizeProxyMode(current.proxyMode)
    let proxyUrl = current.proxyUrl
    if (patch.proxyUrl !== undefined) {
      try {
        proxyUrl = normalizeProxyUrlForStorage(patch.proxyUrl)
      } catch (error) {
        if (error instanceof ProviderProxyError) throw invalid(error.message)
        throw error
      }
    }

    const existingValues = parseHeaderValues(
      await this.secrets.get(PROVIDER_KEYRING_SERVICE, providerHeadersAccount(id))
    )
    const headers = patch.headers
      ? normalizeHeaders(patch.headers, existingValues)
      : { names: current.headerNames, values: existingValues }

    if (patch.apiKey !== undefined || patch.headers !== undefined) {
      await this.writeSecrets(id, patch.apiKey, patch.headers ? headers.values : undefined)
    }
    if (patch.proxyAuth !== undefined) {
      await this.writeProxyAuth(id, patch.proxyAuth)
    }

    const profile = this.db.driver.transaction(() => {
      if (patch.isDefault === true) {
        this.db.driver.prepare('UPDATE provider_profiles SET is_default = 0').run()
      }
      return this.db.providers.update(
        id,
        {
          ...(patch.name !== undefined ? { name: patch.name.trim() } : {}),
          ...(patch.baseUrl !== undefined ? { baseUrl } : {}),
          ...(patch.model !== undefined ? { model: patch.model.trim() } : {}),
          ...(patch.headers ? { headerNames: headers.names } : {}),
          proxyMode,
          proxyUrl,
          ...(patch.temperature !== undefined ? { temperature: patch.temperature } : {}),
          ...(patch.maxTokens !== undefined ? { maxTokens: patch.maxTokens } : {}),
          ...(patch.timeoutMs !== undefined ? { timeoutMs: patch.timeoutMs } : {}),
          ...(patch.isDefault !== undefined ? { isDefault: patch.isDefault } : {})
        },
        this.now()
      )
    })

    if (!profile) throw new ProviderError('NOT_FOUND', 'Provider profile not found')
    this.notifyProfilesChanged()
    return this.toView(profile)
  }

  async deleteProfile(id: string): Promise<ProviderDeleteResult> {
    const current = this.db.providers.get(id)
    if (!current) throw new ProviderError('NOT_FOUND', 'Provider profile not found')

    let keyringCleanup = true
    try {
      await this.secrets.delete(PROVIDER_KEYRING_SERVICE, providerApiKeyAccount(id))
      await this.secrets.delete(PROVIDER_KEYRING_SERVICE, providerHeadersAccount(id))
      await this.secrets.delete(PROVIDER_KEYRING_SERVICE, providerProxyAccount(id))
    } catch {
      keyringCleanup = false
    }

    const deleted = this.db.driver.transaction(() => {
      if (current.isDefault) {
        this.db.driver.prepare('UPDATE provider_profiles SET is_default = 0').run()
      }
      return this.db.providers.delete(id)
    })

    if (deleted) this.notifyProfilesChanged()
    return { deleted, keyringCleanup }
  }

  /** Subscribe to profile CRUD changes (settings/onboarding UI refresh). */
  onProfilesChange(listener: () => void): () => void {
    this.changeListeners.add(listener)
    return () => {
      this.changeListeners.delete(listener)
    }
  }

  async listProfiles(): Promise<ProviderProfileView[]> {
    const profiles = this.db.providers.list()
    const views: ProviderProfileView[] = []
    for (const profile of profiles) views.push(await this.toView(profile))
    return views
  }

  async getProfile(id: string): Promise<ProviderProfileView> {
    const profile = this.db.providers.get(id)
    if (!profile) throw new ProviderError('NOT_FOUND', 'Provider profile not found')
    return this.toView(profile)
  }

  /** Main-only: secrets for the provider client (Task 15). */
  async resolveProfile(id: string): Promise<{
    apiKey: string | null
    headers: Record<string, string>
  }> {
    const profile = this.db.providers.get(id)
    if (!profile) throw new ProviderError('NOT_FOUND', 'Provider profile not found')

    const apiKey = await this.secrets.get(
      PROVIDER_KEYRING_SERVICE,
      providerApiKeyAccount(id)
    )
    registerSecretValue(apiKey)
    const stored = parseHeaderValues(
      await this.secrets.get(PROVIDER_KEYRING_SERVICE, providerHeadersAccount(id))
    )
    const allowed = new Set(profile.headerNames.map((header) => header.name.toLowerCase()))
    const headers: Record<string, string> = {}
    for (const [name, value] of Object.entries(stored)) {
      if (allowed.has(name.toLowerCase())) {
        registerSecretValue(value)
        headers[name] = value
      }
    }

    // opencode-go routes on a stable session id: inject it here so every
    // outbound path (chat, test connection, model list) carries the header
    // without the user having to store a UUID by hand.
    if (isOpencodeGoEndpoint(profile.baseUrl)) {
      const present = Object.keys(headers).some(
        (name) => name.toLowerCase() === OPENCODE_SESSION_HEADER
      )
      if (!present) headers[OPENCODE_SESSION_HEADER] = opencodeSessionIdFor(profile.id)
    }
    return { apiKey, headers }
  }

  /**
   * Main-only profile bundle for `ProviderClient.streamChat` (Task 16).
   * Never crosses the IPC bridge.
   */
  async resolveStreamProfile(id: string): Promise<ProviderStreamProfile> {
    const profile = this.db.providers.get(id)
    if (!profile) throw new ProviderError('NOT_FOUND', 'Provider profile not found')
    const resolved = await this.resolveProfile(id)
    const proxyAuth = await this.readProxyAuth(id)
    return {
      id,
      baseUrl: profile.baseUrl,
      model: profile.model,
      apiKey: resolved.apiKey,
      headers: resolved.headers,
      proxyMode: normalizeProxyMode(profile.proxyMode),
      proxyUrl:
        profile.proxyUrl !== null ? withProxyAuth(profile.proxyUrl, proxyAuth) : null,
      temperature: profile.temperature,
      maxTokens: profile.maxTokens,
      timeoutMs: profile.timeoutMs
    }
  }

  // -------------------------------------------------------------------------
  // Test / models
  // -------------------------------------------------------------------------

  async testConnection(
    id: string,
    options: { timeoutMs?: number } = {}
  ): Promise<ProviderTestResult> {
    const profile = this.db.providers.get(id)
    if (!profile) throw new ProviderError('NOT_FOUND', 'Provider profile not found')

    const started = this.now()
    const timeoutMs = options.timeoutMs ?? this.defaultTestTimeoutMs

    try {
      const resolved = await this.resolveProfile(id)
      const proxy = await this.proxyContext(id, profile)
      const getResult = await this.request(
        modelsUrl(profile.baseUrl),
        'GET',
        resolved,
        timeoutMs,
        undefined,
        proxy
      )

      if (getResult.status === 404 || getResult.status === 405) {
        const postResult = await this.request(
          chatCompletionsUrl(profile.baseUrl),
          'POST',
          resolved,
          timeoutMs,
          JSON.stringify({
            model: profile.model,
            messages: [{ role: 'user', content: 'ping' }],
            stream: false,
            max_tokens: 1
          }),
          proxy
        )
        if (postResult.status < 200 || postResult.status >= 300) {
          throw this.errorFromResponse(postResult)
        }
        return { ok: true, latencyMs: this.now() - started, status: postResult.status }
      }

      if (getResult.status < 200 || getResult.status >= 300) {
        throw this.errorFromResponse(getResult)
      }

      return {
        ok: true,
        latencyMs: this.now() - started,
        status: getResult.status,
        models: parseModels(getResult.text)
      }
    } catch (error) {
      const mapped = this.mapRequestError(error)
      return {
        ok: false,
        latencyMs: this.now() - started,
        error: { code: mapped.code, message: redactSummary(mapped.message, 300) }
      }
    }
  }

  async listModels(id: string): Promise<ProviderListModelsResult> {
    const profile = this.db.providers.get(id)
    if (!profile) throw new ProviderError('NOT_FOUND', 'Provider profile not found')

    const resolved = await this.resolveProfile(id)
    const proxy = await this.proxyContext(id, profile)
    const result = await this.request(
      modelsUrl(profile.baseUrl),
      'GET',
      resolved,
      this.defaultTestTimeoutMs,
      undefined,
      proxy
    )
    if (result.status < 200 || result.status >= 300) throw this.errorFromResponse(result)
    return { models: parseModels(result.text) }
  }

  // -------------------------------------------------------------------------
  // Helpers
  // -------------------------------------------------------------------------

  private notifyProfilesChanged(): void {
    const baseUrls = this.db.providers.list().map((profile) => profile.baseUrl)
    this.guard?.setProviderBaseUrls(baseUrls)
    this.onProfilesChanged?.(baseUrls)
    for (const listener of this.changeListeners) {
      try {
        listener()
      } catch {
        // UI notification must never break a CRUD write.
      }
    }
  }

  private async writeSecrets(
    id: string,
    apiKey: string | null | undefined,
    headerValues: Record<string, string> | undefined
  ): Promise<void> {
    try {
      if (apiKey !== undefined) {
        if (apiKey === null || apiKey.length === 0) {
          await this.secrets.delete(PROVIDER_KEYRING_SERVICE, providerApiKeyAccount(id))
        } else {
          registerSecretValue(apiKey)
          await this.secrets.set(PROVIDER_KEYRING_SERVICE, providerApiKeyAccount(id), apiKey)
        }
      }

      if (headerValues !== undefined) {
        if (Object.keys(headerValues).length === 0) {
          await this.secrets.delete(PROVIDER_KEYRING_SERVICE, providerHeadersAccount(id))
        } else {
          for (const value of Object.values(headerValues)) registerSecretValue(value)
          await this.secrets.set(
            PROVIDER_KEYRING_SERVICE,
            providerHeadersAccount(id),
            JSON.stringify(headerValues)
          )
        }
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : 'secret storage failed'
      throw new ProviderError('SECRET', redactSummary(message, 200))
    }
  }

  private async toView(profile: ProviderProfile): Promise<ProviderProfileView> {
    const key = await this.secrets
      .get(PROVIDER_KEYRING_SERVICE, providerApiKeyAccount(profile.id))
      .catch(() => null)
    const hasApiKey = typeof key === 'string' && key.length > 0

    let values: Record<string, string> = {}
    try {
      values = parseHeaderValues(
        await this.secrets.get(PROVIDER_KEYRING_SERVICE, providerHeadersAccount(profile.id))
      )
    } catch {
      values = {}
    }

    const headers: ProviderHeaderView[] = profile.headerNames.map((header) => ({
      name: header.name,
      secret: header.secret,
      hasValue: Object.prototype.hasOwnProperty.call(values, header.name)
    }))

    const proxyAuth = await this.readProxyAuth(profile.id)
    const proxyUsername = proxyAuth?.username ?? ''
    const hasProxyAuth =
      proxyAuth !== null &&
      (proxyAuth.username.length > 0 || proxyAuth.password.length > 0)

    return {
      id: profile.id,
      name: profile.name,
      baseUrl: profile.baseUrl,
      model: profile.model,
      hasApiKey,
      headers,
      proxyMode: normalizeProxyMode(profile.proxyMode),
      proxyUrl: profile.proxyUrl,
      hasProxyAuth,
      ...(proxyUsername.length > 0
        ? { proxyUsernameMasked: maskProxyUsername(proxyUsername) }
        : {}),
      temperature: profile.temperature,
      maxTokens: profile.maxTokens,
      timeoutMs: profile.timeoutMs,
      isDefault: profile.isDefault,
      createdAt: profile.createdAt,
      updatedAt: profile.updatedAt
    }
  }

  private async readProxyAuth(id: string): Promise<ProxyAuth | null> {
    try {
      return parseProxyAuth(
        await this.secrets.get(PROVIDER_KEYRING_SERVICE, providerProxyAccount(id))
      )
    } catch {
      return null
    }
  }

  private async proxyContext(id: string, profile: ProviderProfile): Promise<ProxyContext> {
    return {
      mode: normalizeProxyMode(profile.proxyMode),
      url: profile.proxyUrl,
      auth: await this.readProxyAuth(id)
    }
  }

  private async writeProxyAuth(
    id: string,
    auth: ProviderProxyAuthInput | null
  ): Promise<void> {
    const username = auth?.username ?? ''
    const password = auth?.password ?? ''
    if (auth === null || username.trim().length === 0) {
      if (auth !== null && password.length > 0) throw invalid('代理用户名不能为空')
      try {
        await this.secrets.delete(PROVIDER_KEYRING_SERVICE, providerProxyAccount(id))
      } catch (error) {
        const message = error instanceof Error ? error.message : 'secret storage failed'
        throw new ProviderError('SECRET', redactSummary(message, 200))
      }
      return
    }

    const existing = await this.readProxyAuth(id)
    const effectivePassword = password.length > 0 ? password : (existing?.password ?? '')
    registerSecretValue(username)
    registerSecretValue(effectivePassword)
    try {
      await this.secrets.set(
        PROVIDER_KEYRING_SERVICE,
        providerProxyAccount(id),
        JSON.stringify({ username, password: effectivePassword })
      )
    } catch (error) {
      const message = error instanceof Error ? error.message : 'secret storage failed'
      throw new ProviderError('SECRET', redactSummary(message, 200))
    }
  }

  private errorFromResponse(response: RawResponse): ProviderError {
    const detail = redactSummary(response.text.trim(), 300)
    const mapped = statusToError(response.status)
    return new ProviderError(mapped.code, `${mapped.message} ${detail}`.trim())
  }

  private mapRequestError(error: unknown): ProviderError {
    if (error instanceof ProviderError) return error
    if (error instanceof ProviderUrlError) return new ProviderError('INVALID_ARGUMENT', error.message)
    if (error instanceof Error) {
      if (error.name === 'AbortError') return new ProviderError('TIMEOUT', '请求超时')
      if (error.name === 'TypeError') return new ProviderError('NETWORK', '网络错误（DNS/拒绝/TLS）')
      return new ProviderError('NETWORK', redactSummary(error.message, 300))
    }
    return new ProviderError('NETWORK', '网络错误')
  }

  private async request(
    url: string,
    method: 'GET' | 'POST',
    resolved: { apiKey: string | null; headers: Record<string, string> },
    timeoutMs: number,
    body?: string,
    proxy?: ProxyContext
  ): Promise<RawResponse> {
    const { headers } = buildProviderHeaders({
      apiKey: resolved.apiKey,
      customHeaders: resolved.headers,
      version: this.version,
      accept: 'application/json'
    })

    // Typed rejection before any socket is opened (Task 17 network guard).
    this.guard?.assertAllowedOutbound(url)

    let proxyUrl: string | null = null
    if (proxy) {
      const effectiveUrl =
        proxy.url !== null ? withProxyAuth(proxy.url, proxy.auth) : null
      try {
        proxyUrl = resolveProfileProxy(
          new URL(url),
          { proxyMode: proxy.mode, proxyUrl: effectiveUrl },
          this.env
        )
      } catch (error) {
        if (error instanceof ProviderProxyError) {
          throw new ProviderError('INVALID_ARGUMENT', error.message)
        }
        throw error
      }
    }

    const dispatcher: Dispatcher | null = proxyUrl
      ? createProxyDispatcher(proxyUrl, { connectMs: timeoutMs })
      : null
    let failed = true

    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), timeoutMs)

    try {
      const response = await this.fetchImpl(url, {
        method,
        headers,
        body,
        signal: controller.signal,
        redirect: 'manual',
        dispatcher: dispatcher ?? undefined
      })
      const text = await response.text()
      failed = false
      return { status: response.status, text: text.slice(0, 1_000_000) }
    } catch (error) {
      if (proxyUrl !== null) {
        throw new ProviderError('PROXY', '代理不可用/认证失败')
      }
      throw error
    } finally {
      clearTimeout(timer)
      if (dispatcher) {
        if (failed) await dispatcher.destroy().catch(() => undefined)
        else await dispatcher.close().catch(() => undefined)
      }
    }
  }
}
