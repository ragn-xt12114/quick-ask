import { _electron as electron, expect, test } from '@playwright/test'
import type { ElectronApplication, Page } from '@playwright/test'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { PRODUCTION_CSP } from '../../src/shared/csp'

interface IpcResponse {
  ok: boolean
  data?: unknown
  error?: { code: string; message: string }
}

interface QuickAskTestApi {
  app: { bootstrap(): Promise<IpcResponse> }
  chat: {
    send(payload: unknown): Promise<IpcResponse>
    getActive(): Promise<IpcResponse>
    onDelta(listener: (event: unknown) => void): () => void
    onEnd(listener: (event: unknown) => void): () => void
  }
  sessions: {
    list(payload: unknown): Promise<IpcResponse>
  }
  window: {
    show(): Promise<IpcResponse>
    hide(): Promise<IpcResponse>
    getState(): Promise<IpcResponse>
    setMode(mode: string): Promise<IpcResponse>
    onState(listener: (event: unknown) => void): () => void
  }
}

type TestWindow = typeof globalThis & { quickask?: QuickAskTestApi }

const EVIDENCE_DIR = resolve('.omo/evidence')
const SECURITY_EVIDENCE = resolve(EVIDENCE_DIR, 'task-9-security.json')
const INVALID_IPC_EVIDENCE = resolve(EVIDENCE_DIR, 'task-9-invalid-ipc.log')

let app: ElectronApplication | undefined
let page: Page
let tempRoot = ''
const consoleErrors: string[] = []
const pageErrors: string[] = []
const externalRequests: string[] = []
let popupCount = 0
const evidence: Record<string, unknown> = {}

function isExternalUrl(rawUrl: string): boolean {
  if (!/^https?:\/\//i.test(rawUrl)) return false
  try {
    const host = new URL(rawUrl).hostname
    return host !== 'localhost' && host !== '127.0.0.1' && host !== '[::1]'
  } catch {
    return true
  }
}

test.describe.configure({ mode: 'serial' })

test.beforeAll(async () => {
  tempRoot = mkdtempSync(join(tmpdir(), 'quickask-security-e2e-'))
  for (const dir of ['config', 'data', 'state']) {
    mkdirSync(join(tempRoot, dir), { recursive: true })
  }
  app = await electron.launch({
    args: ['.'],
    env: {
      ...process.env,
      XDG_CONFIG_HOME: join(tempRoot, 'config'),
      XDG_DATA_HOME: join(tempRoot, 'data'),
      XDG_STATE_HOME: join(tempRoot, 'state'),
      QUICKASK_DATA_DIR: join(tempRoot, 'data', 'quickask-db'),
      QUICKASK_DISABLE_ONBOARDING: '1'
    }
  })
  page = await app.firstWindow()

  page.on('console', (message) => {
    if (message.type() === 'error') consoleErrors.push(message.text())
  })
  page.on('pageerror', (error) => pageErrors.push(error.message))
  page.on('request', (request) => {
    if (isExternalUrl(request.url())) externalRequests.push(request.url())
  })
  page.on('popup', () => {
    popupCount += 1
  })

  await page.waitForLoadState('domcontentloaded')
  await page.waitForFunction(() => Boolean((window as unknown as TestWindow).quickask))
})

test.afterAll(async () => {
  evidence.consoleErrors = consoleErrors
  evidence.pageErrors = pageErrors
  evidence.externalRequests = externalRequests
  evidence.popupCount = popupCount
  mkdirSync(EVIDENCE_DIR, { recursive: true })
  writeFileSync(SECURITY_EVIDENCE, `${JSON.stringify(evidence, null, 2)}\n`)
  await app?.close()
  rmSync(tempRoot, { recursive: true, force: true })
})

test('renderer has no Node globals and exposes only the approved API', async () => {
  const snapshot = await page.evaluate(() => {
    const scope = globalThis as unknown as Record<string, unknown>
    const testWindow = window as unknown as TestWindow
    const api = testWindow.quickask
    const record = api as unknown as Record<string, unknown> | undefined
    const chat = record?.chat as Record<string, unknown> | undefined
    const windowApi = record?.window as Record<string, unknown> | undefined

    const offDelta = api?.chat.onDelta(() => {})
    const offEnd = api?.chat.onEnd(() => {})
    const offState = api?.window.onState(() => {})
    const unsubscribeTypes = [typeof offDelta, typeof offEnd, typeof offState]
    offDelta?.()
    offEnd?.()
    offState?.()

    return {
      requireType: typeof scope.require,
      processType: typeof scope.process,
      moduleType: typeof scope.module,
      windowRequireType: typeof testWindow.require,
      hasQuickask: Boolean(api),
      namespaces: api ? Object.keys(api).sort() : [],
      hasIpcRenderer: record ? 'ipcRenderer' in record : false,
      hasFs: record ? 'fs' in record : false,
      sendType: typeof chat?.send,
      onDeltaType: typeof chat?.onDelta,
      onEndType: typeof chat?.onEnd,
      onStateType: typeof windowApi?.onState,
      unsubscribeTypes
    }
  })

  expect(snapshot.requireType).toBe('undefined')
  expect(snapshot.processType).toBe('undefined')
  expect(snapshot.moduleType).toBe('undefined')
  expect(snapshot.windowRequireType).toBe('undefined')
  expect(snapshot.hasQuickask).toBe(true)
  expect(snapshot.namespaces).toEqual([
    'app',
    'chat',
    'clipboard',
    'data',
    'drafts',
    'links',
    'provider',
    'sessions',
    'settings',
    'window'
  ])
  expect(snapshot.hasIpcRenderer).toBe(false)
  expect(snapshot.hasFs).toBe(false)
  expect(snapshot.sendType).toBe('function')
  expect(snapshot.onDeltaType).toBe('function')
  expect(snapshot.onEndType).toBe('function')
  expect(snapshot.onStateType).toBe('function')
  expect(snapshot.unsubscribeTypes).toEqual(['function', 'function', 'function'])

  await page.waitForFunction(
    () => document.querySelector('[data-testid="app-root"]')?.getAttribute('data-ui-mode') === 'S0'
  )
  await expect(page.locator('[data-testid="app-root"]')).toHaveAttribute('data-ui-mode', 'S0')
  await expect(page).toHaveTitle('QuickAsk')

  evidence.nodeGlobals = snapshot
})

test('renderer cannot reach the network (CSP connect-src none)', async () => {
  const fetchResult = await page.evaluate(async () => {
    try {
      await fetch('https://example.com/')
      return 'resolved'
    } catch (error) {
      return `rejected:${(error as Error).name}`
    }
  })

  expect(fetchResult.startsWith('rejected:')).toBe(true)
  await page.waitForTimeout(300)
  expect(externalRequests).toEqual([])

  evidence.fetch = { result: fetchResult, externalRequests }
})

test('window.open and external navigation are denied', async () => {
  const popup = await page.evaluate(() => window.open('https://example.com/'))
  expect(popup).toBeNull()

  const before = page.url()
  await page.evaluate(() => {
    window.location.href = 'https://example.com/'
  })
  await page.waitForTimeout(500)

  expect(page.url()).toBe(before)
  expect(popupCount).toBe(0)
  expect(app?.windows().length).toBe(1)

  evidence.navigation = {
    windowOpenResult: popup,
    popupCount,
    windowCount: app?.windows().length,
    urlBefore: before,
    urlAfter: page.url()
  }
})

test('media permission requests are denied', async () => {
  const mediaResult = await page.evaluate(async () => {
    if (!navigator.mediaDevices || typeof navigator.mediaDevices.getUserMedia !== 'function') {
      return 'no-media-devices'
    }
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true })
      for (const track of stream.getTracks()) track.stop()
      return 'granted'
    } catch (error) {
      return `rejected:${(error as Error).name}`
    }
  })

  expect(mediaResult.startsWith('rejected:')).toBe(true)
  evidence.media = { result: mediaResult }
})

test('invalid IPC returns a typed INVALID_ARGUMENT, bootstrap succeeds', async () => {
  const invalid = await page.evaluate(() =>
    (window as unknown as TestWindow).quickask!.chat.send({ bad: true })
  )
  expect(invalid.ok).toBe(false)
  expect(invalid.error?.code).toBe('INVALID_ARGUMENT')
  expect(invalid.error?.message).not.toContain('ZodError')

  const sessions = await page.evaluate(() =>
    (window as unknown as TestWindow).quickask!.sessions.list({})
  )
  expect(sessions.ok).toBe(true)
  const sessionList = (sessions.data ?? {}) as { sessions?: unknown[] }
  expect(Array.isArray(sessionList.sessions)).toBe(true)
  expect(sessionList.sessions).toHaveLength(0)

  const active = await page.evaluate(() =>
    (window as unknown as TestWindow).quickask!.chat.getActive()
  )
  expect(active.ok).toBe(true)
  expect((active.data as { active: unknown }).active).toBeNull()

  const bootstrap = await page.evaluate(() =>
    (window as unknown as TestWindow).quickask!.app.bootstrap()
  )
  expect(bootstrap.ok).toBe(true)
  const info = (bootstrap.data ?? {}) as Record<string, unknown>
  expect(Object.keys(info).sort()).toEqual([
    'animationDurationFactor',
    'appearance',
    'blurStatus',
    'dataDir',
    'firstRun',
    'hotkey',
    'logsDir',
    'onboarding',
    'opaqueMode',
    'platform',
    'platformCapabilities',
    'session',
    'settings',
    'version'
  ])
  expect(typeof info.version).toBe('string')
  expect(typeof info.platform).toBe('string')
  expect(typeof info.dataDir).toBe('string')
  expect(typeof info.logsDir).toBe('string')
  expect(typeof info.firstRun).toBe('boolean')
  const hotkey = info.hotkey as Record<string, unknown>
  expect(typeof hotkey.registered).toBe('boolean')
  expect(typeof hotkey.primary).toBe('string')

  const windowState = await page.evaluate(() =>
    (window as unknown as TestWindow).quickask!.window.getState()
  )
  expect(windowState.ok).toBe(true)
  const state = (windowState.data ?? {}) as Record<string, unknown>
  expect(typeof state.visible).toBe('boolean')
  expect(typeof state.bounds).toBe('object')

  mkdirSync(EVIDENCE_DIR, { recursive: true })
  writeFileSync(
    INVALID_IPC_EVIDENCE,
    [
      'request: window.quickask.chat.send({bad:true})',
      `response: ${JSON.stringify(invalid)}`,
      '',
      'request: window.quickask.sessions.list({})',
      `response: ${JSON.stringify(sessions)}`,
      '',
      'request: window.quickask.app.bootstrap()',
      `response: ${JSON.stringify(bootstrap)}`,
      '',
      'request: window.quickask.window.getState()',
      `response: ${JSON.stringify(windowState)}`,
      ''
    ].join('\n')
  )

  evidence.invalidIpc = invalid
  evidence.sessionsList = sessions
  evidence.bootstrap = bootstrap
  evidence.windowState = windowState
})

test('window show/hide/get-state reflect the real BrowserWindow', async () => {
  const hidden = await page.evaluate(() =>
    (window as unknown as TestWindow).quickask!.window.hide()
  )
  expect(hidden.ok).toBe(true)
  const hiddenState = (hidden.data ?? {}) as Record<string, unknown>
  expect(hiddenState.visible).toBe(false)
  expect(hiddenState.mode).toBe('S0')

  const shown = await page.evaluate(() =>
    (window as unknown as TestWindow).quickask!.window.show()
  )
  expect(shown.ok).toBe(true)
  const shownState = (shown.data ?? {}) as Record<string, unknown>
  expect(shownState.visible).toBe(true)
  expect(shownState.mode).toBe('S1')
  expect(shownState.layout).not.toBeNull()

  await page.waitForFunction(() => {
    const bar = document.querySelector('[data-testid="bar"]') as HTMLElement | null
    return Boolean(bar && bar.getBoundingClientRect().width > 0)
  })
  const barSnapshot = await page.evaluate(() => {
    const bar = document.querySelector('[data-testid="bar"]') as HTMLElement
    const input = document.querySelector('[data-testid="composer"]') as HTMLElement
    const rect = bar.getBoundingClientRect()
    return {
      width: rect.width,
      height: rect.height,
      hasComposer: Boolean(input)
    }
  })
  expect(barSnapshot.width).toBeGreaterThan(0)
  expect(barSnapshot.height).toBeGreaterThan(0)
  expect(barSnapshot.hasComposer).toBe(true)

  const setMode = await page.evaluate(() =>
    (window as unknown as TestWindow).quickask!.window.setMode('S2')
  )
  expect(setMode.ok).toBe(true)
  expect((setMode.data as Record<string, unknown> | undefined)?.mode).toBe('S2')

  await page.waitForFunction(
    () => document.querySelector('[data-testid="panel"]') !== null
  )

  const backToS1 = await page.evaluate(() =>
    (window as unknown as TestWindow).quickask!.window.setMode('S1')
  )
  expect(backToS1.ok).toBe(true)

  evidence.windowLifecycle = { hidden: hiddenState, shown: shownState, setMode, backToS1 }
})

test('built renderer HTML contains the production CSP', () => {
  const html = readFileSync(resolve('out/renderer/index.html'), 'utf8')
  const match = html.match(/<meta http-equiv="Content-Security-Policy" content="([^"]*)"/i)

  expect(match).not.toBeNull()
  expect(match?.[1]).toBe(PRODUCTION_CSP)
  expect(html).toContain("connect-src 'none'")
  expect(html).not.toContain('unsafe-eval')
  expect(html).not.toContain('ws://localhost')

  evidence.builtCsp = {
    meta: match?.[1] ?? null,
    containsConnectSrcNone: html.includes("connect-src 'none'"),
    containsUnsafeEval: html.includes('unsafe-eval'),
    file: 'out/renderer/index.html'
  }
})

test('no uncaught renderer exceptions', () => {
  expect(pageErrors).toEqual([])

  const unexpectedConsoleErrors = consoleErrors.filter(
    (message) =>
      !/Content Security Policy|Refused to connect|Refused to load|permission|Permission/i.test(
        message
      )
  )
  expect(unexpectedConsoleErrors).toEqual([])
})
