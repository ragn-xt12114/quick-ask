/**
 * F-06.1 / §3.11 — global Ctrl+N and Ctrl+H shortcuts.
 *
 * Uses a seeded database so a current session exists without any network
 * request. Composition is simulated by dispatching compositionstart plus a
 * keyCode 229 keydown, mirroring the IME guard used by the Esc suite.
 */
import { _electron as electron, expect, test } from '@playwright/test'
import type { ElectronApplication, Page } from '@playwright/test'
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

interface IpcResponse<T = unknown> {
  ok: boolean
  data?: T
  error?: { code: string; message: string }
}

interface SessionSummaryLike {
  id: string
  title: string
}

interface ChatMessageLike {
  id: string
  sessionId: string
  seq: number
  role: string
  content: string
  status: string
}

interface SessionStateLike {
  currentSessionId: string | null
  mode: string
  messages: ChatMessageLike[]
}

interface TestApi {
  window: {
    show(): Promise<IpcResponse<{ mode: string; visible: boolean }>>
    setMode(mode: string): Promise<IpcResponse<{ mode: string }>>
  }
  sessions: {
    list(request?: {
      query?: string
      limit?: number
      offset?: number
    }): Promise<IpcResponse<{ sessions: SessionSummaryLike[] }>>
    open(request: { id: string }): Promise<IpcResponse<{ session: SessionSummaryLike }>>
    state(): Promise<IpcResponse<SessionStateLike>>
  }
}

type TestWindow = typeof globalThis & { quickask?: TestApi }

const EVIDENCE_DIR = resolve('.omo/evidence/final-qa')
const DISPLAY = process.env['DISPLAY'] ?? ':0'
const SEED_SCRIPT = resolve('tools/seed-history.mjs')

let app: ElectronApplication | undefined
let page: Page
let tempRoot = ''
let dbPath = ''
const evidence: Record<string, unknown> = {}
const pageErrors: string[] = []

function delay(ms: number): Promise<void> {
  return new Promise((resolveDelay) => setTimeout(resolveDelay, ms))
}

function baseEnv(root: string): Record<string, string> {
  const inherited: Record<string, string> = {}
  for (const [key, value] of Object.entries(process.env)) {
    if (value !== undefined) inherited[key] = value
  }
  return {
    ...inherited,
    DISPLAY,
    XDG_CONFIG_HOME: join(root, 'config'),
    XDG_DATA_HOME: join(root, 'data'),
    XDG_STATE_HOME: join(root, 'state'),
    QUICKASK_DATA_DIR: join(root, 'data', 'quickask-db'),
    QUICKASK_DISABLE_ONBOARDING: '1'
  }
}

async function sessionState(): Promise<SessionStateLike> {
  const result = await page.evaluate(() =>
    (window as unknown as TestWindow).quickask!.sessions.state()
  )
  expect(result.ok).toBe(true)
  return result.data as SessionStateLike
}

async function listSessions(): Promise<SessionSummaryLike[]> {
  const result = await page.evaluate(() =>
    (window as unknown as TestWindow).quickask!.sessions.list({ limit: 100 })
  )
  expect(result.ok).toBe(true)
  return result.data?.sessions ?? []
}

async function waitMode(mode: string): Promise<void> {
  await page.waitForFunction(
    (expected) =>
      document.querySelector('[data-testid="app-root"]')?.getAttribute('data-ui-mode') ===
      expected,
    mode
  )
}

async function setMode(mode: string): Promise<void> {
  const result = await page.evaluate(
    (next) => (window as unknown as TestWindow).quickask!.window.setMode(next),
    mode
  )
  expect(result.ok).toBe(true)
  await waitMode(mode)
}

async function openSession(id: string): Promise<void> {
  const result = await page.evaluate(
    async (sessionId) =>
      (window as unknown as TestWindow).quickask!.sessions.open({ id: sessionId }),
    id
  )
  expect(result.ok).toBe(true)
  await waitMode('S2')
}

async function waitForNewSession(): Promise<void> {
  await page.waitForFunction(async () => {
    const state = await (window as unknown as TestWindow).quickask!.sessions.state()
    return state.data?.currentSessionId === null && state.data?.mode === 'S1'
  })
}

test.describe.configure({ mode: 'serial' })

test.describe('shortcuts: Ctrl+N new session, Ctrl+H history, IME guard', () => {
  test.beforeAll(async () => {
    tempRoot = mkdtempSync(join(tmpdir(), 'quickask-shortcuts-e2e-'))
    for (const dir of ['config', 'data', 'state']) {
      mkdirSync(join(tempRoot, dir), { recursive: true })
    }
    dbPath = join(tempRoot, 'data', 'quickask-db', 'quickask.db')
    mkdirSync(join(tempRoot, 'data', 'quickask-db'), { recursive: true })
    mkdirSync(EVIDENCE_DIR, { recursive: true })

    const seedOut = execFileSync(
      process.execPath,
      [SEED_SCRIPT, '--sessions', '3', '--messages', '2', '--fts', '--db', dbPath],
      { encoding: 'utf8' }
    )
    expect(seedOut).toContain('seeded 3 sessions / 6 messages')

    app = await electron.launch({ args: ['.'], env: baseEnv(tempRoot) })
    page = await app.firstWindow()
    page.on('pageerror', (error) => pageErrors.push(error.message))
    await page.waitForLoadState('domcontentloaded')
    await page.waitForFunction(() => Boolean((window as unknown as TestWindow).quickask))
    const shown = await page.evaluate(() =>
      (window as unknown as TestWindow).quickask!.window.show()
    )
    expect(shown.ok).toBe(true)
    await waitMode('S1')
  })

  test.afterAll(async () => {
    evidence['pageErrors'] = pageErrors
    writeFileSync(
      join(EVIDENCE_DIR, 'f4-shortcuts-e2e.json'),
      `${JSON.stringify({ generatedAt: new Date().toISOString(), ...evidence }, null, 2)}\n`
    )
    await app?.close()
    await delay(200)
    try {
      rmSync(tempRoot, { recursive: true, force: true })
    } catch {
      // best effort
    }
  })

  test('Ctrl+N clears the current session, returns to S1 and focuses an empty composer', async () => {
    const sessions = await listSessions()
    expect(sessions.length).toBeGreaterThan(0)
    const target = sessions[0]!
    await openSession(target.id)
    await setMode('S1')

    const composer = page.locator('[data-testid="composer"]')
    await composer.fill('draft that must be cleared')
    await expect(composer).toHaveValue('draft that must be cleared')
    await composer.focus()

    const countBefore = (await listSessions()).length
    const before = await sessionState()
    expect(before.currentSessionId).toBe(target.id)

    await page.keyboard.press('Control+N')
    await waitForNewSession()

    const after = await sessionState()
    expect(after.currentSessionId).toBeNull()
    expect(after.mode).toBe('S1')
    expect(after.messages).toEqual([])
    expect((await listSessions()).length).toBe(countBefore)
    await expect(composer).toHaveValue('')
    await expect(composer).toBeFocused()

    evidence['ctrlN'] = {
      target: target.id,
      before: {
        currentSessionId: before.currentSessionId,
        mode: before.mode,
        messages: before.messages.length
      },
      after: {
        currentSessionId: after.currentSessionId,
        mode: after.mode,
        messages: after.messages.length
      },
      sessionCount: { before: countBefore, after: (await listSessions()).length },
      composerValue: await composer.inputValue(),
      composerFocused: await composer.evaluate((element) => element === document.activeElement)
    }
  })

  test('Ctrl+H opens the history sidebar (S3) without changing the session', async () => {
    await setMode('S1')
    await page.locator('[data-testid="composer"]').focus()
    const before = await sessionState()

    await page.keyboard.press('Control+H')
    await waitMode('S3')

    const state = await sessionState()
    expect(state.mode).toBe('S3')
    expect(state.currentSessionId).toBe(before.currentSessionId)
    await expect(page.locator('[data-testid="history-item"]').first()).toBeVisible()
    const historyCount = await page.locator('[data-testid="history-item"]').count()

    await page.locator('[data-testid="composer"]').focus()
    await page.keyboard.press('Control+H')
    await waitMode('S2')

    const toggled = await sessionState()
    expect(toggled.mode).toBe('S2')
    expect(toggled.currentSessionId).toBe(before.currentSessionId)

    evidence['ctrlH'] = {
      mode: state.mode,
      currentSessionId: state.currentSessionId,
      historyItems: historyCount,
      toggleMode: toggled.mode,
      toggleSessionId: toggled.currentSessionId
    }
  })

  test('Ctrl+N / Ctrl+H are ignored during IME composition', async () => {
    const sessions = await listSessions()
    const target = sessions[1] ?? sessions[0]!
    await openSession(target.id)
    await setMode('S1')
    await page.bringToFront()
    await app!.evaluate(({ BrowserWindow }) => {
      const w = BrowserWindow.getAllWindows()[0]!
      w.show()
      w.focus()
      w.webContents.focus()
    })

    const composer = page.locator('[data-testid="composer"]')
    await composer.fill('composition draft')
    await composer.focus()

    const bounds = await app!.evaluate(({ BrowserWindow }) => {
      const w = BrowserWindow.getAllWindows()[0]!
      return w.getBounds()
    })
    execFileSync('xdotool', [
      'mousemove',
      String(bounds.x + Math.floor(bounds.width / 2)),
      String(bounds.y + 24)
    ])
    await composer.focus()

    const dispatched = await page.evaluate(() => {
      const element = document.querySelector(
        '[data-testid="composer"]'
      ) as HTMLTextAreaElement | null
      element?.dispatchEvent(
        new CompositionEvent('compositionstart', { bubbles: true, data: '' })
      )
      const events: Array<Record<string, unknown>> = []
      for (const key of ['n', 'h']) {
        const event = new KeyboardEvent('keydown', {
          key,
          code: `Key${key.toUpperCase()}`,
          keyCode: 229,
          which: 229,
          ctrlKey: true,
          bubbles: true,
          cancelable: true,
          isComposing: true
        })
        element?.dispatchEvent(event)
        events.push({
          key,
          keyCode: event.keyCode,
          isComposing: event.isComposing,
          defaultPrevented: event.defaultPrevented
        })
      }
      return { events, composing: true }
    })
    expect(dispatched.events.every((entry) => entry['keyCode'] === 229)).toBe(true)

    await delay(500)
    const during = await sessionState()
    expect(during.currentSessionId).toBe(target.id)
    expect(during.mode).toBe('S1')
    await expect(composer).toHaveValue('composition draft')

    await page.evaluate(() => {
      const element = document.querySelector(
        '[data-testid="composer"]'
      ) as HTMLTextAreaElement | null
      element?.dispatchEvent(
        new CompositionEvent('compositionend', { bubbles: true, data: '' })
      )
    })

    evidence['imeGuard'] = {
      target: target.id,
      during: {
        currentSessionId: during.currentSessionId,
        mode: during.mode,
        composerValue: await composer.inputValue()
      },
      events: dispatched.events
    }
  })
})
