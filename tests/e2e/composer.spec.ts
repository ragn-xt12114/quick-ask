import { _electron as electron, expect, test } from '@playwright/test'
import type { ElectronApplication, Page } from '@playwright/test'
import { execFileSync, spawn, type ChildProcess } from 'node:child_process'
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  writeFileSync
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

interface IpcResponse<T = unknown> {
  ok: boolean
  data?: T
  error?: { code: string; message: string }
}

interface WindowStateLike {
  mode: string
  visible: boolean
}

interface TestApi {
  window: {
    show(): Promise<IpcResponse<WindowStateLike>>
    hide(): Promise<IpcResponse<WindowStateLike>>
    getState(): Promise<IpcResponse<WindowStateLike>>
    setMode(mode: string): Promise<IpcResponse<{ mode: string }>>
    setHeight(request: {
      barLines?: number
      panelHeight?: number
      height?: number
    }): Promise<IpcResponse<{ height: number; barLines: number; panelHeight: number }>>
  }
  chat: { send(request: { sessionId: string | null; text: string }): Promise<IpcResponse> }
  drafts: {
    get(request: { sessionId: string }): Promise<IpcResponse<{ text: string }>>
    set(request: { sessionId: string; text: string }): Promise<IpcResponse<{ saved: boolean }>>
  }
  sessions: {
    new(): Promise<IpcResponse<{ currentSessionId: string | null; mode: string }>>
  }
  provider: {
    list(): Promise<IpcResponse<{ profiles: Array<{ id: string }> }>>
    create(request: Record<string, unknown>): Promise<IpcResponse>
    delete(request: { id: string }): Promise<IpcResponse>
  }
  clipboard: { readText(): Promise<IpcResponse<{ text: string }>> }
}

type TestWindow = typeof globalThis & { quickask?: TestApi }

const EVIDENCE_DIR = resolve('.omo/evidence')
const DISPLAY = process.env['DISPLAY'] ?? ':0'
const MOCK_SCRIPT = resolve('tools/mock-sse-server.mjs')
const DRAFT_DEBOUNCE_WAIT = 450
const NOTICE_WAIT = 1200
// 96x96 PNG probe: red block top-left, blue block bottom-right.
const PNG_96 =
  'iVBORw0KGgoAAAANSUhEUgAAAGAAAABgCAIAAABt+uBvAAABAElEQVR4nO3bsRHCMBAAQczQhwLXQfXU4cCViAIYc0TGwW4oBdLcfPrLnPPGsfu/P3B1AgWBgkBBoCBQECg8ji62Mc78x7rvZz73OxMUBAoCBYGCQEGgIFAQKAgUBAoCBYGCQEGgIFAQKAgUBAoCBYGCQEGgIFAQKAgUBAoCBYGCQEGgIFAQKAgUBAoCBYHCYpnlOxMUBAoCBYGCQEGgcLircQXjuZ353P5aPw9NUBAoCBQECgIFgYJAQaAgUBAoCBQECgIFgYJAQaAgUBAoCBQECgIFgYJAQaAgUBAoCBQECgIFgYJAQaAgUBAoCBQECnY1ggkKAgWBgkBBoCBQeAPysg+5gFCZKgAAAABJRU5ErkJggg=='

let app: ElectronApplication | undefined
let page: Page
let tempRoot = ''
let mock: ChildProcess | undefined
let mockPort = 0
let mockLogPath = ''
let serverStdout = ''
let serverStderr = ''
let previousFocus: string | null = null

const evidence: Record<string, unknown> = {}

function delay(ms: number): Promise<void> {
  return new Promise((resolveDelay) => setTimeout(resolveDelay, ms))
}

function writeJson(name: string, value: unknown): void {
  mkdirSync(EVIDENCE_DIR, { recursive: true })
  writeFileSync(resolve(EVIDENCE_DIR, name), `${JSON.stringify(value, null, 2)}\n`)
}

function mergeEvidence(patch: Record<string, unknown>): void {
  Object.assign(evidence, patch)
}

function baseEnv(root: string): NodeJS.ProcessEnv {
  return {
    ...process.env,
    DISPLAY,
    XDG_CONFIG_HOME: join(root, 'config'),
    XDG_DATA_HOME: join(root, 'data'),
    XDG_STATE_HOME: join(root, 'state'),
    QUICKASK_DATA_DIR: join(root, 'data', 'quickask-db'),
    QUICKASK_DISABLE_ONBOARDING: '1'
  }
}

async function startMockServer(): Promise<void> {
  mockLogPath = join(tempRoot, 'mock-requests.log')
  mock = spawn(
    process.execPath,
    [
      MOCK_SCRIPT,
      '--port',
      '0',
      '--chunks',
      '2',
      '--delay',
      '10',
      '--log',
      mockLogPath,
      '--body-log',
      join(tempRoot, 'mock-bodies.log')
    ],
    { stdio: ['ignore', 'pipe', 'pipe'] }
  )

  await new Promise<void>((resolveStarted, reject) => {
    const timer = setTimeout(() => reject(new Error('mock server did not start')), 10_000)
    mock!.stdout?.setEncoding('utf8')
    mock!.stderr?.setEncoding('utf8')
    mock!.stdout?.on('data', (chunk: string) => {
      serverStdout += chunk
      const match = serverStdout.match(/listening on http:\/\/([^:\s]+):(\d+)/)
      if (match) {
        mockPort = Number(match[2])
        clearTimeout(timer)
        resolveStarted()
      }
    })
    mock!.stderr?.on('data', (chunk: string) => {
      serverStderr += chunk
    })
    mock!.once('exit', (code) => {
      if (mockPort === 0) {
        clearTimeout(timer)
        reject(new Error(`mock server exited early: ${code ?? 'signal'}`))
      }
    })
  })
}

async function stopMockServer(): Promise<void> {
  if (!mock || mock.exitCode !== null) return
  const exited = new Promise<void>((resolveExit) => {
    mock!.once('exit', () => resolveExit())
  })
  mock.kill('SIGTERM')
  await Promise.race([exited, delay(2000)])
  if (mock.exitCode === null) mock.kill('SIGKILL')
  await Promise.race([exited, delay(1000)])
  mock = undefined
}

async function launchApp(root: string): Promise<void> {
  app = await electron.launch({ args: ['.'], env: baseEnv(root) })
  page = await app.firstWindow()
  await page.waitForLoadState('domcontentloaded')
  await page.waitForFunction(() => Boolean((window as unknown as TestWindow).quickask))
}

async function state(): Promise<WindowStateLike> {
  const result = await page.evaluate(() =>
    (window as unknown as TestWindow).quickask!.window.getState()
  )
  expect(result.ok).toBe(true)
  return result.data as WindowStateLike
}

async function waitVisible(visible: boolean): Promise<void> {
  await expect.poll(async () => (await state()).visible, { timeout: 6000 }).toBe(visible)
}

async function show(): Promise<void> {
  const result = await page.evaluate(() =>
    (window as unknown as TestWindow).quickask!.window.show()
  )
  expect(result.ok).toBe(true)
  await waitVisible(true)
  await page.waitForFunction(
    () =>
      document.querySelector('[data-testid="app-root"]')?.getAttribute('data-ui-mode') !== 'S0'
  )
}

async function hide(): Promise<void> {
  const result = await page.evaluate(() =>
    (window as unknown as TestWindow).quickask!.window.hide()
  )
  expect(result.ok).toBe(true)
  await waitVisible(false)
}

async function composerValue(): Promise<string> {
  return page.locator('[data-testid="composer"]').inputValue()
}

async function barBox(): Promise<{ x: number; y: number; width: number; height: number }> {
  const box = await page.locator('[data-testid="bar"]').boundingBox()
  expect(box).not.toBeNull()
  return box!
}

async function waitBarHeight(height: number): Promise<void> {
  await page.waitForFunction(
    (expected) => {
      const el = document.querySelector('[data-testid="bar"]')
      if (!el) return false
      return Math.abs(el.getBoundingClientRect().height - expected) <= 1
    },
    height,
    { timeout: 6000 }
  )
}

async function waitWindowHeight(height: number): Promise<void> {
  await page.waitForFunction(
    (expected) => Math.abs(window.innerHeight - expected) <= 1,
    height,
    { timeout: 6000 }
  )
}

function postCount(): number {
  if (!existsSync(mockLogPath)) return 0
  const text = readFileSync(mockLogPath, 'utf8')
  return text.split('\n').filter((line) => line.startsWith('POST /v1/chat/completions')).length
}

async function waitForPostCount(count: number): Promise<void> {
  await expect.poll(() => postCount(), { timeout: 6000 }).toBe(count)
}

async function dispatchPaste(options: {
  text?: string
  file?: {
    name: string
    type: string
    bytes?: number[]
    base64?: string
    lastModified?: number
  }
  /** Simulates Chromium's separate `files` view for the same clipboard payload. */
  filesLastModified?: number
}): Promise<void> {
  await page.evaluate((payload) => {
    const el = document.querySelector('[data-testid="composer"]') as HTMLTextAreaElement
    el.focus()
    const data = new DataTransfer()
    if (payload.text !== undefined) data.setData('text/plain', payload.text)
    const spec = payload.file
    if (spec) {
      const bytes = spec.base64
        ? Uint8Array.from(atob(spec.base64), (char) => char.charCodeAt(0))
        : new Uint8Array(spec.bytes ?? [])
      const makeFile = (lastModified: number | undefined): File =>
        new File([bytes], spec.name, {
          type: spec.type,
          ...(lastModified === undefined ? {} : { lastModified })
        })
      data.items.add(makeFile(spec.lastModified))
      if (payload.filesLastModified !== undefined) {
        const filesOnly = new DataTransfer()
        filesOnly.items.add(makeFile(payload.filesLastModified))
        Object.defineProperty(data, 'files', { value: filesOnly.files })
      }
    }

    let event: ClipboardEvent
    try {
      event = new ClipboardEvent('paste', {
        bubbles: true,
        cancelable: true,
        clipboardData: data
      })
    } catch {
      event = new Event('paste', { bubbles: true, cancelable: true }) as ClipboardEvent
      Object.defineProperty(event, 'clipboardData', { value: data })
    }
    if (!event.clipboardData) {
      Object.defineProperty(event, 'clipboardData', { value: data })
    }
    el.dispatchEvent(event)
  }, options)
}

async function dispatchCompositionKey(key: string, keyCode: number): Promise<void> {
  await page.evaluate(
    ({ keyName, code }) => {
      const el = document.querySelector('[data-testid="composer"]') as HTMLTextAreaElement
      el.focus()
      el.dispatchEvent(
        new KeyboardEvent('keydown', {
          key: keyName,
          code: keyName,
          keyCode: code,
          which: code,
          bubbles: true,
          cancelable: true,
          isComposing: true
        })
      )
    },
    { keyName: key, code: keyCode }
  )
}

async function dispatchComposingShortcut(
  key: string,
  modifiers: { ctrl?: boolean; shift?: boolean }
): Promise<void> {
  await page.evaluate(
    ({ keyName, ctrl, shift }) => {
      const el = document.querySelector('[data-testid="composer"]') as HTMLTextAreaElement
      el.focus()
      el.dispatchEvent(
        new KeyboardEvent('keydown', {
          key: keyName,
          code: `Key${keyName.toUpperCase()}`,
          keyCode: 229,
          which: 229,
          ctrlKey: ctrl === true,
          shiftKey: shift === true,
          bubbles: true,
          cancelable: true,
          isComposing: true
        })
      )
    },
    { keyName: key, ctrl: modifiers.ctrl, shift: modifiers.shift }
  )
}

async function activeTestId(): Promise<string | null> {
  return page.evaluate(() => {
    const el = document.activeElement as HTMLElement | null
    return el?.getAttribute('data-testid') ?? el?.tagName ?? null
  })
}

test.describe.configure({ mode: 'serial' })

test.describe('composer: grow, send, IME, drafts, paste, clipboard, tab order', () => {
  test.beforeAll(async () => {
    tempRoot = mkdtempSync(join(tmpdir(), 'quickask-task18-'))
    for (const dir of ['config', 'data', 'state']) {
      mkdirSync(join(tempRoot, dir), { recursive: true })
    }
    mkdirSync(EVIDENCE_DIR, { recursive: true })

    try {
      previousFocus = execFileSync('xdotool', ['getwindowfocus'], {
        encoding: 'utf8',
        timeout: 2000
      }).trim()
    } catch {
      previousFocus = null
    }

    await startMockServer()
    await launchApp(tempRoot)

    // Start from a clean clipboard so the chip never distracts other checks.
    await app!.evaluate(async ({ clipboard }) => {
      await clipboard.writeText('')
    })

    await show()
    const created = await page.evaluate(
      async ({ baseUrl }) => {
        const api = (window as unknown as TestWindow).quickask!
        const existing = await api.provider.list()
        for (const profile of existing.data?.profiles ?? []) {
          await api.provider.delete({ id: profile.id })
        }
        return api.provider.create({
          name: 'task18-mock',
          baseUrl,
          model: 'mock',
          isDefault: true
        })
      },
      { baseUrl: `http://127.0.0.1:${mockPort}/v1` }
    )
    expect(created.ok).toBe(true)
  })

  test.afterAll(async () => {
    const observed = evidence as {
      multiline?: { barHeightAt6?: number; topFixed?: boolean; sevenOverflows?: boolean }
      send?: { posts?: number; cleared?: boolean; oldDraftCleared?: boolean; barHeight?: number }
      ime?: { composingEnterRequests?: number; visibleAfterComposingEsc?: boolean }
      paste50k?: { valueLength?: number; notice?: string | null }
      imagePaste?: {
        attached?: boolean
        capped?: boolean
        removable?: boolean
        sentAsPart?: boolean
      }
      imageDedupe?: { chips?: number }
      clipboard?: { autoFilled?: boolean; clickFilled?: boolean; shortcutFilled?: boolean }
      tabOrder?: { tabInserts?: boolean }
      draftHideShow?: { restored?: boolean }
      draftRestart?: { restored?: string }
      sendError?: { textKept?: boolean; postsUnchanged?: boolean }
    }
    const checks = {
      sixLines168: observed.multiline?.barHeightAt6 === 168,
      topFixed: observed.multiline?.topFixed === true,
      seventhScrolls: observed.multiline?.sevenOverflows === true,
      sendOnePost: observed.send?.posts === 1,
      sendClearsAndCollapses:
        observed.send?.cleared === true &&
        observed.send?.oldDraftCleared === true &&
        observed.send?.barHeight === 48,
      imeZeroRequests: observed.ime?.composingEnterRequests === 0,
      imeEscKeepsWindow: observed.ime?.visibleAfterComposingEsc === true,
      paste50kVisibleNotice:
        observed.paste50k?.valueLength === 50_000 &&
        observed.paste50k?.notice === '已截断至 50,000 字符',
      imagePasteAccepted:
        observed.imagePaste?.attached === true &&
        observed.imagePaste?.capped === true &&
        observed.imagePaste?.sentAsPart === true,
      imagePasteDeduped: observed.imageDedupe?.chips === 1,
      clipboardNeverAutoFills: observed.clipboard?.autoFilled === false,
      clipboardExplicitFill:
        observed.clipboard?.clickFilled === true &&
        observed.clipboard?.shortcutFilled === true,
      tabNeverInserts: observed.tabOrder?.tabInserts === false,
      draftHideShow: observed.draftHideShow?.restored === true,
      draftRestart: observed.draftRestart?.restored === 'restart-draft',
      sendErrorKeepsText:
        observed.sendError?.textKept === true && observed.sendError?.postsUnchanged === true
    }
    writeJson('task-18-summary.json', {
      task: 18,
      verdict: Object.values(checks).every(Boolean) ? 'PASS' : 'FAIL',
      checks,
      generatedAt: new Date().toISOString(),
      mockPort,
      serverStderr,
      ...evidence
    })
    // Leave a real window focused; closing while visible drops X focus to the
    // root window and can make the following lifecycle spec's focus poll flaky.
    try {
      await page?.evaluate(() =>
        (window as unknown as TestWindow).quickask?.window.hide()
      )
    } catch {
      // window may already be gone
    }
    if (previousFocus && previousFocus !== '0' && previousFocus !== '1') {
      try {
        execFileSync('xdotool', ['windowactivate', previousFocus], {
          env: { ...process.env, DISPLAY },
          timeout: 3000
        })
      } catch {
        // best effort
      }
    }
    try {
      await app?.close()
    } catch {
      // best effort
    }
    app = undefined
    await stopMockServer()
  })

  test('S1 starts at 1 line with the send button disabled', async () => {
    const box = await barBox()
    expect(box.height).toBe(48)
    expect(box.y).toBe(28)

    const info = await page.evaluate(() => {
      const composer = document.querySelector('[data-testid="composer"]') as HTMLTextAreaElement
      const send = document.querySelector('[data-testid="btn-send"]') as HTMLButtonElement
      const style = getComputedStyle(send)
      return {
        tag: composer.tagName,
        value: composer.value,
        sendDisabled: send.disabled,
        sendOpacity: style.opacity,
        placeholder: composer.placeholder
      }
    })
    expect(info.tag).toBe('TEXTAREA')
    expect(info.value).toBe('')
    expect(info.sendDisabled).toBe(true)
    expect(info.sendOpacity).toBe('0.35')
    expect(info.placeholder).toBe('问点什么…')

    mergeEvidence({ initial: { box, ...info } })
  })

  test('draft: 300ms debounce survives hide/show', async () => {
    const composer = page.locator('[data-testid="composer"]')
    await composer.fill('draft-hide-show')
    await delay(DRAFT_DEBOUNCE_WAIT)

    await hide()
    await show()
    await expect(composer).toHaveValue('draft-hide-show')

    const stored = await page.evaluate(() =>
      (window as unknown as TestWindow).quickask!.drafts.get({ sessionId: 'new' })
    )
    expect(stored.ok).toBe(true)
    expect(stored.data?.text).toBe('draft-hide-show')

    writeJson('task-18-draft-hide-show.json', {
      valueBeforeHide: 'draft-hide-show',
      valueAfterShow: await composerValue(),
      stored,
      debounceMs: 300
    })
    mergeEvidence({
      draftHideShow: {
        restored: (await composerValue()) === 'draft-hide-show',
        stored: stored.data?.text ?? null
      }
    })

    await composer.fill('')
    await delay(DRAFT_DEBOUNCE_WAIT)
  })

  test('auto-grow: 6 lines -> 168px bar with fixed top, 7th line scrolls, send collapses', async () => {
    const composer = page.locator('[data-testid="composer"]')
    const topBefore = (await barBox()).y

    const six = ['line-1', 'line-2', 'line-3', 'line-4', 'line-5', 'line-6'].join('\n')
    await composer.fill(six)
    await waitBarHeight(168)
    await waitWindowHeight(248)
    const sixBox = await barBox()

    const sixMetrics = await page.evaluate(() => {
      const el = document.querySelector('[data-testid="composer"]') as HTMLTextAreaElement
      return {
        value: el.value,
        scrollHeight: el.scrollHeight,
        clientHeight: el.clientHeight,
        overflowY: getComputedStyle(el).overflowY,
        lineHeight: getComputedStyle(el).lineHeight,
        paddingTop: getComputedStyle(el).paddingTop,
        paddingBottom: getComputedStyle(el).paddingBottom
      }
    })

    await page.screenshot({
      path: resolve(EVIDENCE_DIR, 'task-18-multiline.png'),
      omitBackground: true
    })

    const seven = `${six}\nline-7`
    await composer.fill(seven)
    await delay(150)
    const sevenMetrics = await page.evaluate(() => {
      const el = document.querySelector('[data-testid="composer"]') as HTMLTextAreaElement
      return {
        scrollHeight: el.scrollHeight,
        clientHeight: el.clientHeight,
        overflowY: getComputedStyle(el).overflowY
      }
    })

    expect(sixBox.height).toBeGreaterThanOrEqual(167)
    expect(sixBox.height).toBeLessThanOrEqual(169)
    expect(sixBox.y).toBe(topBefore)
    expect(sevenMetrics.scrollHeight).toBeGreaterThan(sevenMetrics.clientHeight)

    writeJson('task-18-multiline.json', {
      lineHeightPx: 24,
      barHeightAt6: sixBox.height,
      barTopAt6: sixBox.y,
      topBefore,
      windowHeightAt6: await page.evaluate(() => window.innerHeight),
      sixMetrics,
      sevenMetrics,
      scrollsAt7: sevenMetrics.scrollHeight > sevenMetrics.clientHeight,
      screenshot: 'task-18-multiline.png'
    })
    mergeEvidence({
      multiline: {
        barHeightAt6: sixBox.height,
        topFixed: sixBox.y === topBefore,
        sevenOverflows: sevenMetrics.scrollHeight > sevenMetrics.clientHeight
      }
    })

    await composer.fill('')
    await waitBarHeight(48)
    await waitWindowHeight(128)
    await delay(DRAFT_DEBOUNCE_WAIT)
  })

  test('send: Enter posts once, clears the composer and collapses to 48px in S2', async () => {
    const composer = page.locator('[data-testid="composer"]')
    await composer.fill('hello')
    await expect(page.locator('[data-testid="btn-send"]')).toBeEnabled()

    await page.keyboard.press('Enter')
    await expect.poll(async () => (await state()).mode, { timeout: 6000 }).toBe('S2')
    await expect(composer).toHaveValue('')
    await waitForPostCount(1)
    await waitBarHeight(48)
    const box = await barBox()
    expect(box.y).toBe(28)

    await delay(250)
    const clearedDraft = await page.evaluate(() =>
      (window as unknown as TestWindow).quickask!.drafts.get({ sessionId: 'new' })
    )
    expect(clearedDraft.ok).toBe(true)
    expect(clearedDraft.data?.text).toBe('')

    await page.screenshot({
      path: resolve(EVIDENCE_DIR, 'task-18-send.png'),
      omitBackground: true
    })

    writeJson('task-18-send.json', {
      text: 'hello',
      postCount: postCount(),
      mode: (await state()).mode,
      composerValue: await composerValue(),
      oldDraftCleared: clearedDraft.data?.text === '',
      bar: box,
      windowHeight: await page.evaluate(() => window.innerHeight),
      screenshot: 'task-18-send.png'
    })
    mergeEvidence({
      send: {
        posts: postCount(),
        cleared: (await composerValue()) === '',
        oldDraftCleared: clearedDraft.data?.text === '',
        barHeight: box.height,
        mode: (await state()).mode
      }
    })
  })

  test('IME: composing Enter/Esc/shortcuts send 0 requests and never hide the window', async () => {
    const beforePosts = postCount()
    const composer = page.locator('[data-testid="composer"]')
    const chip = page.locator('[data-testid="clipboard-chip"]')

    await composer.fill('')
    await app!.evaluate(async ({ clipboard }) => {
      await clipboard.writeText('ime-clip')
    })
    await hide()
    await show()
    await expect(chip).toBeVisible({ timeout: 5000 })

    await composer.fill('composition-text')
    await page.evaluate(() => {
      const el = document.querySelector('[data-testid="composer"]') as HTMLTextAreaElement
      el.focus()
      el.dispatchEvent(new CompositionEvent('compositionstart', { bubbles: true, data: '' }))
    })
    await dispatchCompositionKey('Enter', 229)
    await dispatchCompositionKey('Enter', 13)
    await dispatchComposingShortcut('v', { ctrl: true, shift: true })
    await dispatchComposingShortcut('n', { ctrl: true })
    await dispatchComposingShortcut('h', { ctrl: true })
    await delay(300)

    const afterEnter = {
      posts: postCount(),
      value: await composerValue(),
      state: await state(),
      chipVisible: await chip.isVisible()
    }
    expect(afterEnter.posts).toBe(beforePosts)
    expect(afterEnter.value).toBe('composition-text')
    expect(afterEnter.chipVisible).toBe(true)

    await dispatchCompositionKey('Escape', 229)
    await delay(150)
    const afterEscape = await state()
    expect(afterEscape.visible).toBe(true)

    await page.evaluate(() => {
      const el = document.querySelector('[data-testid="composer"]') as HTMLTextAreaElement
      el.dispatchEvent(new CompositionEvent('compositionend', { bubbles: true }))
    })

    writeJson('task-18-ime.json', {
      beforePosts,
      afterEnter,
      afterEscape,
      guard: 'isComposing || keyCode === 229',
      composingEnterRequests: afterEnter.posts - beforePosts,
      composingShortcutsIgnored: ['Ctrl+Shift+V', 'Ctrl+N', 'Ctrl+H'],
      clipboardChipStillVisible: afterEnter.chipVisible,
      windowVisibleAfterComposingEsc: afterEscape.visible
    })
    mergeEvidence({
      ime: {
        composingEnterRequests: afterEnter.posts - beforePosts,
        visibleAfterComposingEsc: afterEscape.visible,
        shortcutsIgnored: afterEnter.chipVisible
      }
    })

    await app!.evaluate(async ({ clipboard }) => {
      await clipboard.writeText('')
    })
    await hide()
    await show()
    await expect(chip).toBeHidden({ timeout: 3000 })
    await composer.fill('')
    await delay(DRAFT_DEBOUNCE_WAIT)
  })

  test('paste 50,001 chars truncates visibly to 50,000', async () => {
    const beforePosts = postCount()
    const composer = page.locator('[data-testid="composer"]')
    await composer.fill('')

    await dispatchPaste({ text: 'x'.repeat(50_001) })
    await expect.poll(async () => (await composerValue()).length, { timeout: 5000 }).toBe(50_000)
    const notice = page.locator('[data-testid="composer-notice"]')
    await expect(notice).toBeVisible({ timeout: NOTICE_WAIT })
    await expect(notice).toHaveText('已截断至 50,000 字符')

    const valueLength = (await composerValue()).length
    expect(postCount()).toBe(beforePosts)

    await page.screenshot({
      path: resolve(EVIDENCE_DIR, 'task-18-paste50k.png'),
      omitBackground: true
    })

    writeJson('task-18-paste50k.json', {
      pastedChars: 50_001,
      valueLength,
      notice: await notice.textContent(),
      postsUnchanged: postCount() === beforePosts,
      screenshot: 'task-18-paste50k.png'
    })
    mergeEvidence({
      paste50k: {
        valueLength,
        notice: await notice.textContent(),
        postsUnchanged: postCount() === beforePosts
      }
    })
  })

  test('pasted images become chips, cap at 4, remove, and reach the model as parts', async () => {
    const composer = page.locator('[data-testid="composer"]')
    const strip = page.locator('[data-testid="image-strip"]')
    const chips = page.locator('[data-testid="image-remove"]')
    const notice = page.locator('[data-testid="composer-notice"]')

    await composer.fill('看看这张图')
    await dispatchPaste({ file: { name: 'probe.png', type: 'image/png', base64: PNG_96 } })
    await expect(strip).toBeVisible({ timeout: NOTICE_WAIT })
    await expect(chips).toHaveCount(1)
    expect(await composerValue()).toBe('看看这张图')

    for (let index = 0; index < 3; index += 1) {
      await dispatchPaste({
        file: { name: `probe-${index}.png`, type: 'image/png', base64: PNG_96 }
      })
      await expect(chips).toHaveCount(index + 2)
    }
    // The fifth image must be refused instead of silently dropped.
    await dispatchPaste({ file: { name: 'probe-4.png', type: 'image/png', base64: PNG_96 } })
    await expect(chips).toHaveCount(4)
    await expect(notice).toHaveText('最多只能附带 4 张图片')

    await chips.first().click()
    await expect(chips).toHaveCount(3)

    // A non-image file is still refused and must not attach.
    await dispatchPaste({ file: { name: 'notes.txt', type: 'text/plain', bytes: [104, 105] } })
    await expect(notice).toHaveText('暂不支持文件')
    await expect(chips).toHaveCount(3)
    expect(await composerValue()).toBe('看看这张图')

    // Send with one image attached and check what actually left the app.
    while ((await chips.count()) > 1) await chips.last().click()
    await expect(chips).toHaveCount(1)
    const postsBefore = postCount()
    await page.locator('[data-testid="btn-send"]').click()
    await expect.poll(() => postCount(), { timeout: 10_000 }).toBe(postsBefore + 1)
    await expect(strip).toBeHidden({ timeout: 6000 })

    const bodies = readFileSync(join(tempRoot, 'mock-bodies.log'), 'utf8')
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line)) as Array<{
      messages?: Array<{ role: string; content: unknown }>
    }>
    const shape = bodies.map((body) =>
      (body.messages ?? []).map((message) => ({
        role: message.role,
        kind: Array.isArray(message.content)
          ? `parts:${(message.content as Array<{ type: string }>).map((part) => part.type).join('+')}`
          : typeof message.content
      }))
    )

    const parts = bodies
      .flatMap((body) => body.messages ?? [])
      .filter((message) => message.role === 'user' && Array.isArray(message.content))
      .flatMap((message) => message.content as Array<{ type: string; text?: string; image_url?: { url: string } }>)
    const imagePart = parts.find((part) => part.type === 'image_url')
    const textPart = parts.find((part) => part.type === 'text')

    expect(imagePart?.image_url?.url.startsWith('data:image/')).toBe(true)
    expect(textPart?.text).toContain('看看这张图')

    writeJson('task-18-image.json', {
      chipCap: 4,
      noticeOnFifth: '最多只能附带 4 张图片',
      fileNotice: '暂不支持文件',
      sentImagePart: imagePart?.type ?? null,
      imageUrlPrefix: imagePart?.image_url?.url.slice(0, 22) ?? null,
      textKept: textPart?.text ?? null,
      requestShape: shape
    })
    mergeEvidence({
      imagePaste: {
        attached: true,
        capped: true,
        removable: true,
        sentAsPart: imagePart?.type === 'image_url'
      }
    })

    await composer.fill('')
    await delay(DRAFT_DEBOUNCE_WAIT)
    await expect(notice).toBeHidden({ timeout: 6000 })
  })

  test('paste: items and files carrying the same image with different lastModified yield one chip', async () => {
    const composer = page.locator('[data-testid="composer"]')
    const strip = page.locator('[data-testid="image-strip"]')
    const chips = strip.locator('[data-testid="image-remove"]')
    const notice = page.locator('[data-testid="composer-notice"]')

    await composer.fill('')
    await dispatchPaste({
      file: {
        name: 'image.png',
        type: 'image/png',
        base64: PNG_96,
        lastModified: 1_793_923_577_943
      },
      filesLastModified: 1_793_923_577_936
    })

    await expect(strip).toBeVisible({ timeout: NOTICE_WAIT })
    await expect(strip.locator('[role="status"]')).toHaveCount(0, { timeout: 6000 })
    await expect(chips).toHaveCount(1)
    await expect(strip.locator('img')).toHaveCount(1)
    expect(await composerValue()).toBe('')

    const chipCount = await chips.count()
    await page.screenshot({
      path: resolve(EVIDENCE_DIR, 'task-18-image-dedupe.png'),
      omitBackground: true
    })
    writeJson('task-18-image-dedupe.json', {
      itemsLastModified: 1_793_923_577_943,
      filesLastModified: 1_793_923_577_936,
      chipCount,
      screenshot: 'task-18-image-dedupe.png'
    })
    mergeEvidence({ imageDedupe: { chips: chipCount } })

    await chips.first().click()
    await expect(strip).toBeHidden({ timeout: 6000 })
    await expect(notice).toBeHidden({ timeout: 6000 })
  })

  test('clipboard chip: never auto-fills; click and Ctrl+Shift+V fill explicitly', async () => {
    const composer = page.locator('[data-testid="composer"]')
    const chip = page.locator('[data-testid="clipboard-chip"]')

    await composer.fill('')
    await app!.evaluate(async ({ clipboard }) => {
      await clipboard.writeText('clip-click')
    })
    await hide()
    await show()
    await expect(chip).toBeVisible({ timeout: 5000 })
    expect(await composerValue()).toBe('')

    await page.screenshot({
      path: resolve(EVIDENCE_DIR, 'task-18-clipboard.png'),
      omitBackground: true
    })

    await chip.click()
    await expect(composer).toHaveValue('clip-click')
    await expect(chip).toBeHidden()

    await composer.fill('')
    await delay(350)
    await app!.evaluate(async ({ clipboard }) => {
      await clipboard.writeText('clip-hotkey')
    })
    await hide()
    await show()
    await expect(chip).toBeVisible({ timeout: 5000 })
    expect(await composerValue()).toBe('')

    await composer.focus()
    await page.keyboard.press('Control+Shift+V')
    await expect(composer).toHaveValue('clip-hotkey')
    await expect(chip).toBeHidden()

    writeJson('task-18-clipboard.json', {
      first: {
        hint: 'clip-click',
        autoFilled: false,
        valueBeforeClick: '',
        valueAfterClick: 'clip-click'
      },
      second: {
        hint: 'clip-hotkey',
        shortcut: 'Ctrl+Shift+V',
        valueAfterShortcut: 'clip-hotkey'
      },
      chipInlineOnly: true,
      screenshot: 'task-18-clipboard.png'
    })
    mergeEvidence({
      clipboard: {
        autoFilled: false,
        clickFilled: true,
        shortcutFilled: true
      }
    })

    await composer.fill('')
    await delay(350)
    await app!.evaluate(async ({ clipboard }) => {
      await clipboard.writeText('')
    })
    await hide()
    await show()
    await expect(chip).toBeHidden({ timeout: 3000 })
  })

  test('Tab order is history -> expand -> new -> composer -> send -> history, Tab never inserts', async () => {
    const composer = page.locator('[data-testid="composer"]')
    const expand = page.locator('[data-testid="btn-expand"]')
    const send = page.locator('[data-testid="btn-send"]')
    await composer.fill('')
    await expect(send).toBeDisabled()
    await expect(expand).toBeDisabled()

    // Disabled controls still participate in the explicit §3.11 cycle.
    await page.locator('[data-testid="btn-history"]').focus()
    const forward: Array<string | null> = []
    for (let step = 0; step < 4; step += 1) {
      await page.keyboard.press('Tab')
      forward.push(await activeTestId())
    }
    expect(forward).toEqual(['btn-expand', 'btn-new', 'composer', 'btn-send'])

    await page.keyboard.press('Tab')
    const wrapped = await activeTestId()
    expect(wrapped).toBe('btn-history')
    await expect(expand).toBeDisabled()
    await expect(send).toBeDisabled()

    await page.keyboard.press('Shift+Tab')
    const reverse = await activeTestId()
    expect(reverse).toBe('btn-send')
    const sendTemporarilyEnabled = await send.evaluate(
      (element) => !(element as HTMLButtonElement).disabled
    )
    expect(sendTemporarilyEnabled).toBe(true)
    await page.keyboard.press('Tab')
    await expect(send).toBeDisabled()
    const disabledRestored = await send.isDisabled()

    await composer.fill('x')
    await page.locator('[data-testid="composer"]').focus()
    const beforeValue = await composerValue()
    await page.keyboard.press('Tab')
    expect(await composerValue()).toBe(beforeValue)
    expect(await activeTestId()).toBe('btn-send')
    await page.locator('[data-testid="btn-history"]').focus()

    writeJson('task-18-tab.json', {
      forward,
      wrap: wrapped,
      shiftTab: reverse,
      disabledControlsInCycle: true,
      disabledSendFocusable: sendTemporarilyEnabled,
      disabledRestored,
      tabInsertedCharacter: false,
      valueAfterTab: beforeValue
    })
    mergeEvidence({
      tabOrder: {
        forward,
        wrapped,
        reverse,
        disabledControlsInCycle: true,
        disabledSendFocusable: sendTemporarilyEnabled,
        tabInserts: false
      }
    })

    await composer.fill('')
    await delay(DRAFT_DEBOUNCE_WAIT)
  })

  test('send failure shows the typed error notice and keeps the text', async () => {
    const beforePosts = postCount()
    const removed = await page.evaluate(async () => {
      const api = (window as unknown as TestWindow).quickask!
      const existing = await api.provider.list()
      for (const profile of existing.data?.profiles ?? []) {
        await api.provider.delete({ id: profile.id })
      }
      return (await api.provider.list()).data?.profiles.length ?? -1
    })
    expect(removed).toBe(0)

    const composer = page.locator('[data-testid="composer"]')
    await composer.fill('keep-on-fail')
    await page.keyboard.press('Enter')

    const notice = page.locator('[data-testid="composer-notice"]')
    await expect(notice).toBeVisible({ timeout: NOTICE_WAIT })
    await expect(notice).toHaveText('请先在设置中配置模型提供商')
    expect(await composerValue()).toBe('keep-on-fail')
    expect(postCount()).toBe(beforePosts)

    writeJson('task-18-send-error.json', {
      errorNotice: await notice.textContent(),
      valueKept: 'keep-on-fail',
      postsUnchanged: postCount() === beforePosts
    })
    mergeEvidence({
      sendError: {
        notice: await notice.textContent(),
        textKept: (await composerValue()) === 'keep-on-fail',
        postsUnchanged: postCount() === beforePosts
      }
    })

    await composer.fill('')
    await delay(DRAFT_DEBOUNCE_WAIT)
  })

  test('draft survives an app restart with the same data dir (key new)', async () => {
    await page.evaluate(() =>
      (window as unknown as TestWindow).quickask!.drafts.set({
        sessionId: 'new',
        text: 'restart-draft'
      })
    )
    await delay(150)

    const oldEvidence = existsSync(resolve(EVIDENCE_DIR, 'task-18-draft-hide-show.json'))
      ? (JSON.parse(
          readFileSync(resolve(EVIDENCE_DIR, 'task-18-draft-hide-show.json'), 'utf8')
        ) as Record<string, unknown>)
      : {}

    await app!.close()
    app = undefined
    await launchApp(tempRoot)
    await show()
    await page.evaluate(() => (window as unknown as TestWindow).quickask!.sessions.new())

    const composer = page.locator('[data-testid="composer"]')
    await expect(composer).toHaveValue('restart-draft', { timeout: 6000 })
    const restored = await composerValue()

    writeJson('task-18-draft.json', {
      ...oldEvidence,
      restart: {
        key: 'new',
        expected: 'restart-draft',
        restored,
        sameDataDir: true
      },
      storage: 'sqlite drafts table (no localStorage)'
    })
    mergeEvidence({ draftRestart: { restored } })
  })
})
