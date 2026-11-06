import { describe, expect, it } from 'vitest'
import { IPC, SETTINGS_WINDOW_CHANNELS } from '../../src/shared/channels'
import { DEVELOPMENT_CSP, PRODUCTION_CSP } from '../../src/shared/csp'
import {
  fail,
  formatZodError,
  IpcError,
  isKnownChannel,
  ok,
  requestSchemas,
  responseSchemas,
  toIpcFailure
} from '../../src/shared/ipc'
import {
  isAllowedNavigation,
  isAllowedRendererUrl,
  isAllowedSender,
  senderFailure
} from '../../src/main/ipc/sender'

const rendererFileUrl = 'file:///opt/QuickAsk/out/renderer/index.html'
const prodPolicy = { devServerUrl: null, rendererFileUrl }
const devPolicy = { devServerUrl: 'http://localhost:5173', rendererFileUrl }

type RequestChannel = keyof typeof requestSchemas

function parse(channel: RequestChannel, payload: unknown) {
  return requestSchemas[channel].safeParse(payload)
}

describe('IPC request schemas', () => {
  it('accepts valid payloads across the M1 surface', () => {
    expect(parse(IPC.APP_BOOTSTRAP, undefined).success).toBe(true)
    expect(parse(IPC.APP_RETRY_HOTKEY, undefined).success).toBe(true)
    expect(parse(IPC.APP_SET_HOTKEY, { accelerator: 'Control+Alt+Space' }).success).toBe(true)
    expect(parse(IPC.APP_SET_HOTKEY, { accelerator: 'Control+Shift+J' }).success).toBe(true)
    expect(parse(IPC.WINDOW_SHOW, undefined).success).toBe(true)
    expect(parse(IPC.WINDOW_SET_MODE, { mode: 'S2' }).success).toBe(true)
    expect(parse(IPC.WINDOW_SET_MODE, { mode: 'S0' }).success).toBe(true)
    expect(parse(IPC.WINDOW_SET_MODE, { mode: 'S4' }).success).toBe(true)
    expect(parse(IPC.WINDOW_SET_HEIGHT, { height: 420 }).success).toBe(true)
    expect(parse(IPC.WINDOW_SET_HEIGHT, { barLines: 3 }).success).toBe(true)
    expect(parse(IPC.WINDOW_SET_HEIGHT, { panelHeight: 200 }).success).toBe(true)
    expect(parse(IPC.WINDOW_SET_HEIGHT, { height: 420, barLines: 2 }).success).toBe(true)
    expect(parse(IPC.WINDOW_SET_BAR_WIDTH, { width: 560 }).success).toBe(true)
    expect(parse(IPC.WINDOW_SET_BAR_WIDTH, { width: 900 }).success).toBe(true)
    expect(parse(IPC.WINDOW_OPEN_SETTINGS, undefined).success).toBe(true)
    expect(parse(IPC.WINDOW_OPEN_SETTINGS, { onboarding: true }).success).toBe(true)
    expect(parse(IPC.CHAT_SEND, { sessionId: null, text: 'hello' }).success).toBe(true)
    expect(parse(IPC.CHAT_SEND, { sessionId: 'session-1', text: 'x'.repeat(50_000) }).success).toBe(
      true
    )
    expect(parse(IPC.CHAT_STOP, { requestId: 'request-1' }).success).toBe(true)
    expect(parse(IPC.CHAT_RETRY, { sessionId: 's1', messageId: 'm1' }).success).toBe(true)
    expect(parse(IPC.CHAT_REGENERATE, { sessionId: 's1', messageId: null }).success).toBe(true)
    expect(parse(IPC.SESSIONS_LIST, {}).success).toBe(true)
    expect(parse(IPC.SESSIONS_LIST, { query: 'hi', limit: 20, offset: 0 }).success).toBe(true)
    expect(parse(IPC.SESSIONS_CREATE, {}).success).toBe(true)
    expect(parse(IPC.SESSIONS_RENAME, { id: 's1', title: 'Renamed' }).success).toBe(true)
    expect(parse(IPC.SESSIONS_OPEN, { id: 's1' }).success).toBe(true)
    expect(parse(IPC.SESSIONS_NEW, {}).success).toBe(true)
    expect(parse(IPC.SESSIONS_STATE, {}).success).toBe(true)
    expect(parse(IPC.DRAFTS_SET, { sessionId: 'new', text: '' }).success).toBe(true)
    expect(parse(IPC.SETTINGS_SET, { key: 'theme', value: { mode: 'dark' } }).success).toBe(true)
    expect(parse(IPC.PROVIDER_TEST, { profileId: 'default' }).success).toBe(true)
    expect(parse(IPC.LINKS_OPEN_EXTERNAL, { url: 'https://example.com' }).success).toBe(true)
    expect(parse(IPC.LINKS_OPEN_EXTERNAL, { url: 'http://localhost:8080/x' }).success).toBe(true)
    expect(parse(IPC.CLIPBOARD_WRITE_TEXT, { text: 'copied code' }).success).toBe(true)
    expect(parse(IPC.CLIPBOARD_WRITE_TEXT, { text: '' }).success).toBe(true)
  })

  it('rejects invalid and extra payload keys (.strict())', () => {
    expect(parse(IPC.CHAT_SEND, { bad: true }).success).toBe(false)
    expect(parse(IPC.CHAT_SEND, { sessionId: null, text: 'hi', extra: 1 }).success).toBe(false)
    expect(parse(IPC.CHAT_SEND, { sessionId: null, text: '' }).success).toBe(false)
    expect(parse(IPC.CHAT_SEND, { sessionId: null, text: '   ' }).success).toBe(false)
    expect(parse(IPC.CHAT_SEND, { sessionId: null, text: 'x'.repeat(50_001) }).success).toBe(false)
    expect(parse(IPC.CHAT_SEND, { sessionId: null }).success).toBe(false)
    expect(parse(IPC.WINDOW_SET_MODE, { mode: 'S5' }).success).toBe(false)
    expect(parse(IPC.WINDOW_SET_HEIGHT, { height: 10 }).success).toBe(false)
    expect(parse(IPC.WINDOW_SET_HEIGHT, { height: 4000 }).success).toBe(false)
    expect(parse(IPC.WINDOW_SET_HEIGHT, {}).success).toBe(false)
    expect(parse(IPC.WINDOW_SET_HEIGHT, { barLines: 0 }).success).toBe(false)
    expect(parse(IPC.WINDOW_SET_HEIGHT, { barLines: 7 }).success).toBe(false)
    expect(parse(IPC.WINDOW_SET_HEIGHT, { panelHeight: -1 }).success).toBe(false)
    expect(parse(IPC.WINDOW_SET_BAR_WIDTH, { width: 559 }).success).toBe(false)
    expect(parse(IPC.WINDOW_SET_BAR_WIDTH, { width: 901 }).success).toBe(false)
    expect(parse(IPC.WINDOW_SET_BAR_WIDTH, { width: 680.5 }).success).toBe(false)
    expect(parse(IPC.WINDOW_OPEN_SETTINGS, { onboarding: 'yes' }).success).toBe(false)
    expect(parse(IPC.WINDOW_OPEN_SETTINGS, { extra: 1 }).success).toBe(false)
    expect(parse(IPC.SESSIONS_LIST, { limit: 0 }).success).toBe(false)
    expect(parse(IPC.SESSIONS_RENAME, { id: 's1', title: '   ' }).success).toBe(false)
    expect(parse(IPC.SESSIONS_OPEN, { id: '' }).success).toBe(false)
    expect(parse(IPC.SESSIONS_OPEN, { id: 's1', extra: 1 }).success).toBe(false)
    expect(parse(IPC.SESSIONS_NEW, { extra: 1 }).success).toBe(false)
    expect(parse(IPC.SESSIONS_STATE, { extra: 1 }).success).toBe(false)
    expect(parse(IPC.SETTINGS_SET, { key: '', value: 1 }).success).toBe(false)
    expect(parse(IPC.LINKS_OPEN_EXTERNAL, { url: 'file:///etc/passwd' }).success).toBe(false)
    expect(parse(IPC.LINKS_OPEN_EXTERNAL, { url: 'javascript:alert(1)' }).success).toBe(false)
    expect(parse(IPC.LINKS_OPEN_EXTERNAL, { url: 'not a url' }).success).toBe(false)
    expect(parse(IPC.CLIPBOARD_WRITE_TEXT, { text: 'x'.repeat(1_000_001) }).success).toBe(false)
    expect(parse(IPC.CLIPBOARD_WRITE_TEXT, { text: 'hi', extra: 1 }).success).toBe(false)
    expect(parse(IPC.APP_BOOTSTRAP, {}).success).toBe(false)
    expect(parse(IPC.APP_SET_HOTKEY, { accelerator: 'Space' }).success).toBe(false)
    expect(parse(IPC.APP_SET_HOTKEY, { accelerator: 'ab' }).success).toBe(false)
    expect(parse(IPC.APP_SET_HOTKEY, { accelerator: 'K' }).success).toBe(false)
    expect(parse(IPC.APP_SET_HOTKEY, { accelerator: 'Control+Alt+Space', extra: 1 }).success).toBe(
      false
    )
  })

  it('rejects non-JSON settings values', () => {
    expect(parse(IPC.SETTINGS_SET, { key: 'x', value: () => 1 }).success).toBe(false)
    expect(parse(IPC.SETTINGS_SET, { key: 'x', value: Number.NaN }).success).toBe(false)
  })
})

describe('settings window sender allowlist', () => {
  it('allows settings/provider/appearance actions only', () => {
    const allowed = new Set<string>(SETTINGS_WINDOW_CHANNELS)
    for (const channel of [
      IPC.APP_BOOTSTRAP,
      IPC.APP_SET_HOTKEY,
      IPC.WINDOW_OPEN_SETTINGS,
      IPC.WINDOW_CLOSE_SETTINGS,
      IPC.WINDOW_SET_BAR_WIDTH,
      IPC.SETTINGS_GET_ALL,
      IPC.SETTINGS_SET,
      IPC.PROVIDER_LIST,
      IPC.PROVIDER_GET,
      IPC.PROVIDER_CREATE,
      IPC.PROVIDER_UPDATE,
      IPC.PROVIDER_DELETE,
      IPC.PROVIDER_TEST,
      IPC.PROVIDER_LIST_MODELS
    ]) {
      expect(allowed.has(channel)).toBe(true)
    }
    for (const channel of [
      IPC.CHAT_SEND,
      IPC.CHAT_STOP,
      IPC.SESSIONS_LIST,
      IPC.SESSIONS_STATE,
      IPC.WINDOW_SHOW,
      IPC.WINDOW_HIDE,
      IPC.WINDOW_SET_MODE,
      IPC.APP_RETRY_HOTKEY,
      IPC.CLIPBOARD_READ_TEXT,
      IPC.LINKS_OPEN_EXTERNAL
    ]) {
      expect(allowed.has(channel)).toBe(false)
    }
  })
})

describe('channel registry', () => {
  it('knows request and event channels and rejects unknown ones', () => {
    expect(isKnownChannel(IPC.CHAT_SEND)).toBe(true)
    expect(isKnownChannel(IPC.EVENT_UI_STATE)).toBe(true)
    expect(isKnownChannel('chat:not-a-channel')).toBe(false)
    expect(isKnownChannel('')).toBe(false)
    expect(Object.prototype.hasOwnProperty.call(requestSchemas, 'nope:nope')).toBe(false)
  })
})

describe('CSP constants', () => {
  it('keeps production locked down and dev limited to Vite HMR', () => {
    expect(PRODUCTION_CSP).toContain("connect-src 'none'")
    expect(PRODUCTION_CSP).toContain("script-src 'self'")
    expect(PRODUCTION_CSP).not.toContain('unsafe-eval')
    expect(PRODUCTION_CSP).not.toContain('ws://localhost')

    expect(DEVELOPMENT_CSP).toContain("'unsafe-eval'")
    expect(DEVELOPMENT_CSP).toContain('ws://localhost:*')
    expect(DEVELOPMENT_CSP).toContain("connect-src 'self' ws://localhost:* http://localhost:*")
  })
})

describe('sender validation', () => {
  const mainContents = { id: 42 }

  it('accepts only the main window webContents with the renderer file URL', () => {
    expect(
      isAllowedSender({ id: 42 }, mainContents, 'file:///opt/QuickAsk/out/renderer/index.html', prodPolicy)
    ).toBe(true)
    expect(
      isAllowedSender({ id: 42 }, mainContents, 'file:///opt/QuickAsk/out/renderer/index.html#/chat', prodPolicy)
    ).toBe(true)
    expect(
      isAllowedSender({ id: 42 }, mainContents, 'file:///opt/QuickAsk/out/renderer/index.html?x=1', prodPolicy)
    ).toBe(true)
  })

  it('rejects sender mismatch, missing frame, and foreign URLs', () => {
    expect(
      isAllowedSender({ id: 43 }, mainContents, 'file:///opt/QuickAsk/out/renderer/index.html', prodPolicy)
    ).toBe(false)
    expect(
      isAllowedSender({ id: 42 }, null, 'file:///opt/QuickAsk/out/renderer/index.html', prodPolicy)
    ).toBe(false)
    expect(isAllowedSender({ id: 42 }, mainContents, null, prodPolicy)).toBe(false)
    expect(
      isAllowedSender({ id: 42 }, mainContents, 'file:///opt/QuickAsk/out/renderer/other.html', prodPolicy)
    ).toBe(false)
    expect(
      isAllowedSender({ id: 42 }, mainContents, 'file:///opt/QuickAsk/out/renderer/index.html.evil', prodPolicy)
    ).toBe(false)
    expect(isAllowedSender({ id: 42 }, mainContents, 'https://example.com', prodPolicy)).toBe(false)
  })

  it('maps a rejected sender to a typed FORBIDDEN result', () => {
    expect(
      senderFailure(
        { id: 43 },
        mainContents,
        'file:///opt/QuickAsk/out/renderer/index.html',
        prodPolicy
      )
    ).toEqual({ ok: false, error: { code: 'FORBIDDEN', message: 'Sender is not allowed' } })
    expect(
      senderFailure(
        { id: 42 },
        mainContents,
        'file:///opt/QuickAsk/out/renderer/index.html',
        prodPolicy
      )
    ).toBeNull()
  })

  it('allows only the configured loopback dev server origin', () => {
    expect(isAllowedRendererUrl('http://localhost:5173/', devPolicy)).toBe(true)
    expect(isAllowedRendererUrl('http://localhost:5173/src/main.tsx', devPolicy)).toBe(true)
    expect(isAllowedRendererUrl('http://127.0.0.1:5173/', devPolicy)).toBe(false)
    expect(isAllowedRendererUrl('http://localhost:5174/', devPolicy)).toBe(false)
    expect(isAllowedRendererUrl('https://localhost:5173/', devPolicy)).toBe(false)
    expect(isAllowedRendererUrl('http://evil.test:5173/', devPolicy)).toBe(false)
    expect(isAllowedRendererUrl('not a url', devPolicy)).toBe(false)
  })

  it('allows navigation only to the renderer itself', () => {
    expect(isAllowedNavigation('file:///opt/QuickAsk/out/renderer/index.html', prodPolicy)).toBe(true)
    expect(isAllowedNavigation('https://example.com', prodPolicy)).toBe(false)
    expect(isAllowedNavigation('http://localhost:5173/', devPolicy)).toBe(true)
    expect(isAllowedNavigation('http://localhost:5173/elsewhere', devPolicy)).toBe(true)
    expect(isAllowedNavigation('https://example.com', devPolicy)).toBe(false)
  })
})

describe('error serialization', () => {
  it('builds the typed result envelope', () => {
    expect(ok({ value: 1 })).toEqual({ ok: true, data: { value: 1 } })
    expect(fail('INVALID_ARGUMENT', 'bad payload')).toEqual({
      ok: false,
      error: { code: 'INVALID_ARGUMENT', message: 'bad payload' }
    })
  })

  it('keeps typed errors and hides raw Error messages', () => {
    expect(toIpcFailure(new IpcError('NOT_FOUND', 'session missing', { id: 'abc' }))).toEqual({
      ok: false,
      error: { code: 'NOT_FOUND', message: 'session missing', details: { id: 'abc' } }
    })

    const internal = toIpcFailure(new Error('secret sk-123456'))
    expect(internal.ok).toBe(false)
    if (!internal.ok) {
      expect(internal.error.code).toBe('INTERNAL')
      expect(internal.error.message).not.toContain('sk-123456')
    }

    const abort = toIpcFailure(Object.assign(new Error('aborted'), { name: 'AbortError' }))
    expect(abort).toEqual({ ok: false, error: { code: 'ABORTED', message: 'Operation aborted' } })
  })

  it('formats zod issues without dumping the raw error', () => {
    const result = requestSchemas[IPC.CHAT_SEND].safeParse({ bad: true })
    expect(result.success).toBe(false)
    if (!result.success) {
      const message = formatZodError(result.error)
      expect(message).toContain('(root)')
      expect(message).not.toContain('ZodError')
      expect(message.length).toBeLessThanOrEqual(500)
    }
  })
})

describe('response schemas', () => {
  it('accepts valid window state and rejects extra keys', () => {
    const state = {
      mode: 'S1',
      visible: true,
      bounds: { x: 580, y: 102, width: 760, height: 128 },
      display: {
        id: 1,
        workArea: { x: 0, y: 0, width: 1920, height: 1080 },
        scaleFactor: 1
      },
      layout: {
        mode: 'S1',
        windowBounds: { x: 580, y: 102, width: 760, height: 128 },
        windowBoundsDevice: { x: 580, y: 102, width: 760, height: 128 },
        barRect: { x: 40, y: 28, width: 680, height: 48 },
        visualBounds: { x: 620, y: 130, width: 680, height: 48 },
        overlay: false,
        scaleFactor: 1,
        anchor: { x: 620, y: 130 }
      }
    }
    expect(responseSchemas[IPC.WINDOW_GET_STATE].safeParse(state).success).toBe(true)
    expect(
      responseSchemas[IPC.WINDOW_GET_STATE].safeParse({ ...state, extra: 1 }).success
    ).toBe(false)
    expect(
      responseSchemas[IPC.WINDOW_GET_STATE].safeParse({ ...state, mode: 'S9' }).success
    ).toBe(false)
  })

  it('accepts chat:get-active content/status and rejects incomplete active payloads', () => {
    const active = {
      requestId: 'req-1',
      sessionId: 'session-1',
      messageId: 'message-1',
      startedAt: 1_700_000_000_000,
      content: 'partial answer',
      status: 'streaming'
    }
    expect(responseSchemas[IPC.CHAT_GET_ACTIVE].safeParse({ active }).success).toBe(true)
    expect(responseSchemas[IPC.CHAT_GET_ACTIVE].safeParse({ active: null }).success).toBe(true)
    expect(
      responseSchemas[IPC.CHAT_GET_ACTIVE].safeParse({
        active: { requestId: 'req-1', sessionId: 's', messageId: 'm', startedAt: 1 }
      }).success
    ).toBe(false)
    expect(
      responseSchemas[IPC.CHAT_GET_ACTIVE].safeParse({
        active: { ...active, status: 'complete' }
      }).success
    ).toBe(false)
  })

  it('accepts the extended set-height response', () => {
    expect(
      responseSchemas[IPC.WINDOW_SET_HEIGHT].safeParse({
        height: 340,
        barLines: 1,
        panelHeight: 200
      }).success
    ).toBe(true)
    expect(
      responseSchemas[IPC.WINDOW_SET_HEIGHT].safeParse({ height: 340 }).success
    ).toBe(false)
  })

  it('accepts a bootstrap payload with hotkey status and no secrets', () => {
    const hotkey = {
      registered: true,
      accelerator: 'Control+Alt+Space',
      primary: 'Control+Alt+Space',
      conflict: false,
      tried: [{ accelerator: 'Control+Alt+Space', ok: true }],
      alternatives: ['Control+Shift+Space', 'Control+Alt+K', 'Super+Space']
    }
    const info = {
      version: '0.1.0',
      platform: 'linux',
      dataDir: '/tmp/quickask',
      logsDir: '/tmp/quickask/logs',
      firstRun: true,
      hotkey,
      session: { currentSessionId: null, mode: 'S1' },
      appearance: {
        theme: 'dark',
        primary: 'everforest',
        opacity: 72,
        blurEnabled: true,
        barWidth: 680,
        fontFamily: 'Noto Sans CJK SC',
        fontSize: 14
      },
      settings: {
        appearance: {
          theme: 'dark',
          primary: 'everforest',
          opacity: 72,
          blurEnabled: true,
          barWidth: 680,
          fontFamily: 'Noto Sans CJK SC',
          fontSize: 14
        },
        shortcut: { accelerator: 'Control+Alt+Space' },
        behavior: {
          escDirectHide: false,
          hideOnBlur: true,
          streamingHideDelayMs: 3000,
          contextRounds: 12
        },
        inference: {
          systemPrompt: '',
          temperature: null,
          maxTokens: null,
          timeoutMs: 30000
        },
        data: { retentionDays: null, lastExportPath: null },
        window: { positions: {} },
        startup: { autostart: false, watchdog: false },
        schemaVersion: 2
      },
      onboarding: { required: true, reason: 'no_profile' },
      blurStatus: {
        available: false,
        reason: 'KWin 模糊效果未开启',
        compositor: true,
        effectEnabled: false
      },
      platformCapabilities: {
        platform: 'linux',
        label: 'Linux（X11）',
        hotkey: { state: 'available', reason: null },
        clickThrough: { state: 'available', reason: null, precision: 'shape' },
        blur: { state: 'available', reason: null },
        fonts: { state: 'available', reason: null, source: 'fc-list' },
        autostart: { state: 'available', reason: null, mechanism: 'xdg-desktop' },
        watchdog: { state: 'available', reason: null },
        nativeHelper: { state: 'available', reason: null }
      },
      opaqueMode: false,
      animationDurationFactor: 1
    }
    expect(responseSchemas[IPC.APP_BOOTSTRAP].safeParse(info).success).toBe(true)
    expect(
      responseSchemas[IPC.APP_BOOTSTRAP].safeParse({
        ...info,
        platformCapabilities: undefined
      }).success
    ).toBe(false)
    expect(
      responseSchemas[IPC.APP_BOOTSTRAP].safeParse({
        ...info,
        platformCapabilities: {
          ...info.platformCapabilities,
          clickThrough: { state: 'available', reason: null, precision: 'bogus' }
        }
      }).success
    ).toBe(false)
    expect(
      responseSchemas[IPC.APP_BOOTSTRAP].safeParse({
        ...info,
        session: { currentSessionId: 's1', mode: 'S1' }
      }).success
    ).toBe(true)
    expect(
      responseSchemas[IPC.APP_BOOTSTRAP].safeParse({
        ...info,
        session: { currentSessionId: null, mode: 'S4' }
      }).success
    ).toBe(false)
    expect(
      responseSchemas[IPC.APP_BOOTSTRAP].safeParse({ ...info, hotkey: undefined }).success
    ).toBe(false)
    expect(responseSchemas[IPC.APP_BOOTSTRAP].safeParse({ ...info, apiKey: 'x' }).success).toBe(
      false
    )
    expect(
      responseSchemas[IPC.APP_BOOTSTRAP].safeParse({
        ...info,
        appearance: { ...info.appearance, barWidth: 1000 }
      }).success
    ).toBe(false)
    expect(
      responseSchemas[IPC.APP_BOOTSTRAP].safeParse({
        ...info,
        onboarding: { required: true, reason: 'bogus' }
      }).success
    ).toBe(false)
    expect(responseSchemas[IPC.APP_RETRY_HOTKEY].safeParse(hotkey).success).toBe(true)
    expect(
      responseSchemas[IPC.APP_RETRY_HOTKEY].safeParse({
        ...hotkey,
        registered: false,
        accelerator: null,
        conflict: true,
        error: 'all failed'
      }).success
    ).toBe(true)
    expect(
      responseSchemas[IPC.APP_RETRY_HOTKEY].safeParse({ ...hotkey, accelerator: 3 }).success
    ).toBe(false)
  })
})
