/**
 * Electron security hardening (Task 9).
 *
 * Applied once, after `app.whenReady()` and before the first BrowserWindow is
 * created. The renderer is untrusted: it may only navigate to its own app
 * URL, may not open windows or webviews, and may not obtain permissions.
 */

import { app, session } from 'electron'
import { DEVELOPMENT_CSP, PRODUCTION_CSP } from '../shared/csp'
import { isAllowedNavigation, type SenderPolicy } from './ipc/sender'

export interface SecurityOptions {
  policy: SenderPolicy
  /** True when the renderer is served by the Vite dev server (HMR). */
  isDev: boolean
}

export function installSecurityPolicies(options: SecurityOptions): void {
  app.on('web-contents-created', (_event, contents) => {
    // No <webview> tags, ever.
    contents.on('will-attach-webview', (event) => {
      event.preventDefault()
    })

    // window.open / target=_blank are denied at the source.
    contents.setWindowOpenHandler(() => ({ action: 'deny' }))

    // The renderer may only navigate to its own index.html / dev-server origin.
    contents.on('will-navigate', (event, url) => {
      if (!isAllowedNavigation(url, options.policy)) {
        event.preventDefault()
      }
    })

    contents.on('will-redirect', (event, url) => {
      if (!isAllowedNavigation(url, options.policy)) {
        event.preventDefault()
      }
    })
  })

  const defaultSession = session.defaultSession

  // Chromium downloads Hunspell dictionaries from redirector.gvt1.com even
  // when BrowserWindow.spellcheck is false. Disable the session-level service
  // so idle startup makes zero external requests (NFR-10).
  try {
    defaultSession.setSpellCheckerEnabled(false)
    defaultSession.setSpellCheckerLanguages([])
  } catch {
    // Older Electron builds may not expose one of the APIs; continue.
  }

  // Camera, microphone, notifications, geolocation, clipboard-read, ... all denied.
  defaultSession.setPermissionRequestHandler((_webContents, _permission, callback) => {
    callback(false)
  })
  defaultSession.setPermissionCheckHandler(() => false)

  // Defence in depth for any http(s) response (dev server, future provider
  // pages). The meta tag remains the primary CSP and is never weakened here.
  defaultSession.webRequest.onHeadersReceived((details, callback) => {
    if (!/^https?:/i.test(details.url)) {
      callback({})
      return
    }

    callback({
      responseHeaders: {
        ...(details.responseHeaders ?? {}),
        'Content-Security-Policy': [options.isDev ? DEVELOPMENT_CSP : PRODUCTION_CSP]
      }
    })
  })
}
