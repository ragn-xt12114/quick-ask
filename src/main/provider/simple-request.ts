/**
 * Small non-streaming HTTP helper for provider test/list-models calls.
 *
 * Kept inside `src/main/provider/**` so every outbound code path is covered by
 * the network audit allowlist and the runtime `OutboundGuard`.
 */

import { fetch as undiciFetch } from 'undici'
import type { Dispatcher } from 'undici'

export interface ProviderFetchInit {
  method?: string
  headers?: Record<string, string>
  body?: string
  signal?: AbortSignal
  redirect?: 'follow' | 'error' | 'manual'
  dispatcher?: Dispatcher
}

export interface ProviderFetchResponse {
  status: number
  text(): Promise<string>
}

export type ProviderFetch = (
  url: string,
  init?: ProviderFetchInit
) => Promise<ProviderFetchResponse>

/** Explicit undici dependency: the same stack in dev, tests and packaged app. */
export const providerFetch: ProviderFetch = async (url, init = {}) => {
  const response = await undiciFetch(url, {
    method: init.method,
    headers: init.headers,
    body: init.body,
    signal: init.signal,
    redirect: init.redirect,
    dispatcher: init.dispatcher
  })
  return {
    status: response.status,
    text: () => response.text()
  }
}
