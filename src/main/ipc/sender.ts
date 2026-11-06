/**
 * Pure sender/navigation validation helpers.
 *
 * Kept free of Electron imports so the unit tests can exercise them without
 * booting a real BrowserWindow.
 */

import type { IpcFailure } from '../../shared/ipc'

export interface SenderPolicy {
  /** Vite dev-server URL, or null when the built renderer is loaded from disk. */
  devServerUrl: string | null
  /** `file://` URL of the built `out/renderer/index.html`. */
  rendererFileUrl: string
}

function stripHashAndQuery(href: string): string {
  const hashIndex = href.indexOf('#')
  const queryIndex = href.indexOf('?')
  const cut = Math.min(
    hashIndex === -1 ? href.length : hashIndex,
    queryIndex === -1 ? href.length : queryIndex
  )
  return href.slice(0, cut)
}

function isLoopbackHostname(hostname: string): boolean {
  return hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '[::1]'
}

/**
 * The renderer may only be the built `index.html` (file://) or the configured
 * local Vite dev server (http://localhost:*). Everything else is rejected.
 */
export function isAllowedRendererUrl(rawUrl: string, policy: SenderPolicy): boolean {
  let url: URL
  try {
    url = new URL(rawUrl)
  } catch {
    return false
  }

  if (url.protocol === 'file:') {
    return stripHashAndQuery(url.href) === stripHashAndQuery(policy.rendererFileUrl)
  }

  if (policy.devServerUrl) {
    try {
      const dev = new URL(policy.devServerUrl)
      return (
        url.protocol === 'http:' &&
        url.origin === dev.origin &&
        isLoopbackHostname(url.hostname)
      )
    } catch {
      return false
    }
  }

  return false
}

/**
 * A request is only accepted from the main window's own webContents, with a
 * live frame whose URL is the app renderer.
 */
export function isAllowedSender(
  sender: { id: number },
  mainContents: { id: number } | null,
  senderFrameUrl: string | null,
  policy: SenderPolicy
): boolean {
  if (!mainContents) return false
  if (sender.id !== mainContents.id) return false
  if (!senderFrameUrl) return false
  return isAllowedRendererUrl(senderFrameUrl, policy)
}

/** Navigation is only allowed to the same renderer URL/origin. */
export function isAllowedNavigation(rawUrl: string, policy: SenderPolicy): boolean {
  return isAllowedRendererUrl(rawUrl, policy)
}

/**
 * Typed failure for a rejected sender, or null when the sender is allowed.
 * This is the exact mapping the router returns to the renderer.
 */
export function senderFailure(
  sender: { id: number },
  mainContents: { id: number } | null,
  senderFrameUrl: string | null,
  policy: SenderPolicy
): IpcFailure | null {
  if (isAllowedSender(sender, mainContents, senderFrameUrl, policy)) return null
  return { ok: false, error: { code: 'FORBIDDEN', message: 'Sender is not allowed' } }
}
