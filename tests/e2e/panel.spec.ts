import { _electron as electron, expect, test } from '@playwright/test'
import type { ElectronApplication, Page } from '@playwright/test'
import { execFileSync, spawn, type ChildProcess } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
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
  layout: {
    panelRect?: { x: number; y: number; width: number; height: number }
  } | null
}

interface TestApi {
  window: {
    show(): Promise<IpcResponse<WindowStateLike>>
    getState(): Promise<IpcResponse<WindowStateLike>>
    setMode(mode: string): Promise<IpcResponse<{ mode: string }>>
    setHeight(request: {
      barLines?: number
      panelHeight?: number
      height?: number
    }): Promise<IpcResponse<{ height: number; barLines: number; panelHeight: number }>>
  }
  chat: {
    send(request: { sessionId: string | null; text: string }): Promise<IpcResponse>
    getActive(): Promise<IpcResponse<{ active: unknown }>>
  }
  drafts: {
    get(request: { sessionId: string }): Promise<IpcResponse<{ text: string }>>
    set(request: { sessionId: string; text: string }): Promise<IpcResponse<{ saved: boolean }>>
  }
  provider: {
    list(): Promise<IpcResponse<{ profiles: Array<{ id: string; model: string }> }>>
    create(request: Record<string, unknown>): Promise<IpcResponse>
    delete(request: { id: string }): Promise<IpcResponse>
  }
  clipboard: {
    readText(): Promise<IpcResponse<{ text: string }>>
    writeText(text: string): Promise<IpcResponse<{ written: boolean }>>
  }
  links: {
    openExternal(url: string): Promise<IpcResponse<{ opened: boolean }>>
  }
}

type TestWindow = typeof globalThis & {
  quickask?: TestApi
  __xss?: number
  __openedExternal?: string
}

interface MockHandle {
  name: string
  proc: ChildProcess
  port: number
  stdout: string
  stderr: string
}

interface RequestRecord {
  url: string
  method: string
  resourceType: string
}

const EVIDENCE_DIR = resolve('.omo/evidence')
const DISPLAY = process.env['DISPLAY'] ?? ':0'
const MOCK_SCRIPT = resolve('tools/mock-sse-server.mjs')
const FAKE_CODE_FIRST = 'const order = ["history", "expand", "new"]'

let app: ElectronApplication | undefined
let page: Page
let tempRoot = ''
let mockLogPath = ''
let previousFocus: string | null = null

const mocks = new Map<string, MockHandle>()
const requests: RequestRecord[] = []
const pageErrors: string[] = []
const evidence: Record<string, unknown> = {}
const checks: Record<string, boolean> = {}

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

async function startMock(name: string, args: string[]): Promise<MockHandle> {
  const handle: MockHandle = {
    name,
    proc: spawn(process.execPath, [MOCK_SCRIPT, ...args], {
      stdio: ['ignore', 'pipe', 'pipe']
    }),
    port: 0,
    stdout: '',
    stderr: ''
  }
  mocks.set(name, handle)

  await new Promise<void>((resolveStarted, reject) => {
    const timer = setTimeout(
      () => reject(new Error(`mock ${name} did not start`)),
      10_000
    )
    handle.proc.stdout?.setEncoding('utf8')
    handle.proc.stderr?.setEncoding('utf8')
    handle.proc.stdout?.on('data', (chunk: string) => {
      handle.stdout += chunk
      const match = handle.stdout.match(/listening on http:\/\/([^:\s]+):(\d+)/)
      if (match) {
        handle.port = Number(match[2])
        clearTimeout(timer)
        resolveStarted()
      }
    })
    handle.proc.stderr?.on('data', (chunk: string) => {
      handle.stderr += chunk
    })
    handle.proc.once('exit', (code) => {
      if (handle.port === 0) {
        clearTimeout(timer)
        reject(new Error(`mock ${name} exited early: ${code ?? 'signal'}`))
      }
    })
  })
  return handle
}

async function stopMocks(): Promise<void> {
  for (const handle of mocks.values()) {
    if (handle.proc.exitCode !== null) continue
    const exited = new Promise<void>((resolveExit) => {
      handle.proc.once('exit', () => resolveExit())
    })
    handle.proc.kill('SIGTERM')
    await Promise.race([exited, delay(2000)])
    if (handle.proc.exitCode === null) handle.proc.kill('SIGKILL')
  }
  mocks.clear()
}

async function launchApp(root: string): Promise<void> {
  app = await electron.launch({ args: ['.'], env: baseEnv(root) })
  page = await app.firstWindow()
  page.on('request', (request) => {
    requests.push({
      url: request.url(),
      method: request.method(),
      resourceType: request.resourceType()
    })
  })
  page.on('pageerror', (error) => pageErrors.push(error.message))
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

async function setMode(mode: string): Promise<void> {
  const result = await page.evaluate(
    (next) => (window as unknown as TestWindow).quickask!.window.setMode(next),
    mode
  )
  expect(result.ok).toBe(true)
  await page.waitForFunction(
    (expected) =>
      document.querySelector('[data-testid="app-root"]')?.getAttribute('data-ui-mode') ===
      expected,
    mode
  )
}

async function setProvider(baseUrl: string): Promise<void> {
  const created = await page.evaluate(async ({ url }) => {
    const api = (window as unknown as TestWindow).quickask!
    const existing = await api.provider.list()
    for (const profile of existing.data?.profiles ?? []) {
      await api.provider.delete({ id: profile.id })
    }
    return api.provider.create({
      name: 'panel-mock',
      baseUrl: url,
      model: 'mock',
      isDefault: true
    })
  }, { url: baseUrl })
  expect(created.ok).toBe(true)
}

function mockPort(name: string): number {
  const handle = mocks.get(name)
  if (!handle) throw new Error(`mock ${name} not started`)
  return handle.port
}

function mockBaseUrl(name: string): string {
  return `http://127.0.0.1:${mockPort(name)}/v1`
}

function postCount(): number {
  try {
    const text = readFileSync(mockLogPath, 'utf8')
    return text.split('\n').filter((line) => line.startsWith('POST /v1/chat/completions')).length
  } catch {
    return 0
  }
}

async function sendQuestion(text: string): Promise<void> {
  const composer = page.locator('[data-testid="composer"]')
  await composer.fill(text)
  await page.keyboard.press('Enter')
  await expect.poll(async () => (await state()).mode, { timeout: 8000 }).toBe('S2')
}

function lastAssistant() {
  return page.locator('[data-testid="assistant-message"]').last()
}

async function waitLastStatus(status: string, timeout = 30_000): Promise<void> {
  await expect
    .poll(async () => lastAssistant().getAttribute('data-status'), { timeout })
    .toBe(status)
}

async function lastMarkdownText(): Promise<string> {
  return (await lastAssistant().locator('[data-testid="markdown"]').last().textContent()) ?? ''
}

async function renderCount(): Promise<number> {
  const raw = await page
    .locator('[data-testid="markdown"]')
    .last()
    .getAttribute('data-render-count')
  return Number.parseInt(raw ?? '0', 10)
}

async function readClipboard(): Promise<string> {
  return app!.evaluate(async ({ clipboard }) => await clipboard.readText())
}

async function clearClipboard(): Promise<void> {
  await app!.evaluate(async ({ clipboard }) => {
    await clipboard.writeText('')
  })
}

async function screenshot(name: string): Promise<void> {
  await page.screenshot({
    path: resolve(EVIDENCE_DIR, name),
    omitBackground: true
  })
}

function isExternalUrl(rawUrl: string): boolean {
  return /^https?:/i.test(rawUrl)
}

test.describe.configure({ mode: 'serial' })

test.describe('panel: markdown, safety, streaming, stop, retry, regenerate, errors', () => {
  test.beforeAll(async () => {
    tempRoot = mkdtempSync(join(tmpdir(), 'quickask-task19-'))
    for (const dir of ['config', 'data', 'state']) {
      mkdirSync(join(tempRoot, dir), { recursive: true })
    }
    mkdirSync(EVIDENCE_DIR, { recursive: true })
    mockLogPath = join(tempRoot, 'mock-requests.log')

    try {
      previousFocus = execFileSync('xdotool', ['getwindowfocus'], {
        encoding: 'utf8',
        timeout: 2000
      }).trim()
    } catch {
      previousFocus = null
    }

    const shared = ['--log', mockLogPath, '--port', '0']
    await startMock('markdown', [
      ...shared,
      '--mode',
      'markdown',
      '--chunks',
      '24',
      '--delay',
      '12'
    ])
    await startMock('slow', [
      ...shared,
      '--mode',
      'slow',
      '--chunks',
      '80',
      '--delay',
      '80'
    ])
    await startMock('long', [
      ...shared,
      '--mode',
      'normal',
      '--chunks',
      '300',
      '--delay',
      '20'
    ])
    await startMock('rate', [...shared, '--mode', '429'])
    await startMock('server500', [...shared, '--mode', '500'])

    await launchApp(tempRoot)
    await app!.evaluate(async ({ clipboard }) => {
      await clipboard.writeText('')
    })
    await show()
    await setProvider(mockBaseUrl('markdown'))
  })

  test.afterAll(async () => {
    const externalRequests = requests.filter((request) => isExternalUrl(request.url))
    const trackerRequests = requests.filter((request) => request.url.includes('tracker.example'))
    const pageResources = await page
      .evaluate(() =>
        performance
          .getEntriesByType('resource')
          .map((entry) => entry.name)
          .filter((url) => /^https?:/i.test(url))
      )
      .catch(() => [])

    checks.noExternalRendererRequests =
      externalRequests.length === 0 && pageResources.length === 0
    checks.noTrackerRequests = trackerRequests.length === 0
    checks.noPageErrors = pageErrors.length === 0

    const summary = {
      task: 19,
      verdict: Object.values(checks).every(Boolean) ? 'PASS' : 'FAIL',
      checks,
      generatedAt: new Date().toISOString(),
      mockPorts: Object.fromEntries(
        [...mocks.entries()].map(([name, handle]) => [name, handle.port])
      ),
      externalRequests,
      trackerRequests,
      pageResources,
      pageErrors,
      mockStderr: Object.fromEntries(
        [...mocks.entries()].map(([name, handle]) => [name, handle.stderr])
      ),
      ...evidence
    }
    writeJson('task-19-summary.json', summary)

    try {
      await page?.evaluate(() =>
        (window as unknown as TestWindow).quickask?.window.hide()
      )
    } catch {
      // window may be gone
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
    await stopMocks()
  })

  test('empty S2 shows the centered shortcut hint and a 120px panel', async () => {
    await setMode('S2')
    const empty = page.locator('[data-testid="panel-empty"]')
    await expect(empty).toBeVisible({ timeout: 5000 })
    await expect(empty).toHaveText('Enter 发送 · Shift+Enter 换行')

    await expect
      .poll(async () => (await state()).layout?.panelRect?.height ?? 0, { timeout: 6000 })
      .toBe(120)
    await expect
      .poll(
        async () =>
          Math.round((await page.locator('[data-testid="panel"]').boundingBox())?.height ?? 0),
        { timeout: 6000 }
      )
      .toBe(120)
    const panel = await page.locator('[data-testid="panel"]').boundingBox()
    expect(Math.round(panel?.height ?? 0)).toBe(120)
    await screenshot('task-19-empty.png')

    writeJson('task-19-empty.json', {
      text: await empty.textContent(),
      panelHeight: panel?.height,
      screenshot: 'task-19-empty.png'
    })
    checks.emptyState = true
    mergeEvidence({ emptyState: { text: await empty.textContent(), panelHeight: panel?.height } })

    await setMode('S1')
  })

  test('markdown renders safely; XSS, remote images and javascript links do nothing', async () => {
    await setProvider(mockBaseUrl('markdown'))
    await sendQuestion('markdown fixture')
    await waitLastStatus('complete')

    await expect(page.locator('[data-testid="panel-model"]')).toHaveText('mock', {
      timeout: 6000
    })

    const markdown = page.locator('[data-testid="markdown"]').last()
    await expect(markdown.locator('h1')).toHaveText('Markdown 安全夹具')
    await expect(markdown.locator('.qa-table')).toHaveCount(1)
    await expect(markdown.locator('.qa-table th').first()).toHaveText('列A')
    await expect(markdown.locator('blockquote')).toHaveCount(1)
    await expect(markdown.locator('[data-testid="code-block"]')).toHaveCount(1)
    await expect(markdown.locator('[data-testid="markdown-image-placeholder"]')).toHaveText(
      '[图片: tracker]'
    )
    await expect(markdown.locator('a[href="https://example.com"]')).toHaveCount(1)
    await expect(markdown.locator('a[href^="javascript"]')).toHaveCount(0)
    await expect(markdown.locator('a[href^="file"]')).toHaveCount(0)
    await expect(markdown.locator('img')).toHaveCount(0)
    await expect(markdown.locator('script')).toHaveCount(0)

    const text = (await markdown.textContent()) ?? ''
    expect(text).toContain('$x^2$')
    expect(text).toContain('<img src=x onerror="window.__xss=1">')

    const highlighted = await markdown.locator('.hljs-keyword, .hljs-string').count()
    expect(highlighted).toBeGreaterThan(0)

    const xss = await page.evaluate(() => (window as unknown as TestWindow).__xss ?? null)
    expect(xss).toBeNull()
    const trackerRequests = requests.filter((request) => request.url.includes('tracker.example'))
    expect(trackerRequests).toEqual([])

    const panelHeight = (await state()).layout?.panelRect?.height ?? 0
    expect(panelHeight).toBeGreaterThan(120)
    expect(panelHeight).toBeLessThanOrEqual(420)

    await screenshot('task-19-markdown.png')
    await page.evaluate(() => {
      const body = document.querySelector('[data-testid="panel-body"]') as HTMLElement
      body.scrollTop = 0
      body.dispatchEvent(new Event('scroll'))
    })
    await delay(150)
    await screenshot('task-19-xss.png')

    const xssEvidence = {
      task: 19,
      fixture:
        '<img src=x onerror> + <script> + [bad](javascript:) + ![tracker](https://tracker.example/x.png)',
      windowXss: xss,
      scriptElements: await markdown.locator('script').count(),
      imgElements: await markdown.locator('img').count(),
      javascriptAnchors: await markdown.locator('a[href^="javascript"]').count(),
      trackerRequests,
      imagePlaceholder: await markdown
        .locator('[data-testid="markdown-image-placeholder"]')
        .textContent(),
      dollarLiteral: text.includes('$x^2$'),
      panelHeight,
      screenshots: ['task-19-xss.png', 'task-19-markdown.png']
    }
    writeJson('task-19-xss.json', xssEvidence)
    checks.xssSafe = xss === null && trackerRequests.length === 0
    checks.markdownRendered =
      (await markdown.locator('h1').count()) === 1 &&
      (await markdown.locator('.qa-table').count()) === 1 &&
      (await markdown.locator('[data-testid="code-block"]').count()) === 1
    checks.dollarLiteral = text.includes('$x^2$')
    mergeEvidence({ xss: xssEvidence })
  })

  test('external link opens through the main links handler without navigating', async () => {
    await app!.evaluate(({ shell }) => {
      const target = shell as unknown as {
        openExternal: (url: string) => Promise<void>
      }
      target.openExternal = async (url: string) => {
        Reflect.set(globalThis, '__openedExternal', url)
      }
    })

    const urlBefore = page.url()
    await page.locator('a[href="https://example.com"]').click()
    await delay(300)
    const opened = await app!.evaluate(() =>
      Reflect.get(globalThis, '__openedExternal') ?? null
    )

    expect(page.url()).toBe(urlBefore)
    expect(opened).toBe('https://example.com')
    checks.linkViaMain = opened === 'https://example.com'
    mergeEvidence({ linkOpen: { urlBefore, urlAfter: page.url(), opened } })
  })

  test('code copy and copy-all use the main-process clipboard', async () => {
    const block = page.locator('[data-testid="markdown"] [data-testid="code-block"]').last()
    await block.hover()
    await block.locator('[data-testid="code-copy"]').click()
    await delay(200)
    const copiedCode = await readClipboard()
    expect(copiedCode).toContain(FAKE_CODE_FIRST)
    expect(copiedCode).toContain('console.log(order.length)')

    const assistant = lastAssistant()
    const fullSource = (await assistant.locator('[data-testid="markdown"]').textContent()) ?? ''
    await assistant.hover()
    await assistant.locator('[data-testid="copy-full"]').click()
    await delay(200)
    const copiedFull = await readClipboard()
    expect(copiedFull).toContain('# Markdown 安全夹具')
    expect(copiedFull).toContain('$x^2$')
    expect(copiedFull.length).toBeGreaterThan(fullSource.length)

    await clearClipboard()
    writeJson('task-19-copy.json', {
      copiedCode,
      copiedFullLength: copiedFull.length,
      clipboard: 'main process via clipboard:write-text',
      codeButtonLabel: await block.locator('[data-testid="code-copy"]').textContent()
    })
    checks.codeCopied = copiedCode.includes(FAKE_CODE_FIRST)
    checks.fullCopied = copiedFull.includes('# Markdown 安全夹具')
    mergeEvidence({ copy: { copiedCode, copiedFullLength: copiedFull.length } })
  })

  test('regenerate replaces the same assistant row', async () => {
    const assistant = lastAssistant()
    const beforeId = await assistant.getAttribute('data-message-id')
    const beforeCount = await page.locator('[data-testid="assistant-message"]').count()
    const beforePosts = postCount()

    await assistant.hover()
    await assistant.locator('[data-testid="btn-regenerate"]').click()
    await expect.poll(() => postCount(), { timeout: 10_000 }).toBe(beforePosts + 1)
    await waitLastStatus('complete')

    const afterId = await lastAssistant().getAttribute('data-message-id')
    const afterCount = await page.locator('[data-testid="assistant-message"]').count()
    expect(afterId).toBe(beforeId)
    expect(afterCount).toBe(beforeCount)
    await expect(
      page.locator('[data-testid="markdown"]').last().locator('h1')
    ).toHaveText('Markdown 安全夹具')

    writeJson('task-19-regenerate.json', {
      beforeId,
      afterId,
      beforeCount,
      afterCount,
      postsBefore: beforePosts,
      postsAfter: postCount(),
      replacedSameRow: beforeId === afterId && beforeCount === afterCount
    })
    checks.regenerateSameRow = beforeId === afterId && beforeCount === afterCount
    mergeEvidence({ regenerate: { beforeId, afterId, beforeCount, afterCount } })
  })

  test('long answer streams at <=30fps, grows the panel and scrolls with fades', async () => {
    await setProvider(mockBaseUrl('long'))
    const beforePosts = postCount()
    await sendQuestion('long answer')
    await expect.poll(() => postCount(), { timeout: 10_000 }).toBe(beforePosts + 1)
    await expect(page.locator('[data-testid="markdown"]').last()).toBeVisible({
      timeout: 10_000
    })

    const framesStart = await renderCount()
    await delay(1000)
    const framesEnd = await renderCount()
    const framesPerSecond = framesEnd - framesStart

    await screenshot('task-19-streaming.png')
    await waitLastStatus('complete', 45_000)
    await delay(600)

    const text = await lastMarkdownText()
    expect(text).toContain('chunk 300')
    expect(framesPerSecond).toBeLessThanOrEqual(30)

    const panelHeight = (await state()).layout?.panelRect?.height ?? 0
    expect(panelHeight).toBe(420)

    await expect
      .poll(
        async () =>
          page.evaluate(() => {
            const body = document.querySelector('[data-testid="panel-body"]') as HTMLElement
            return body.scrollHeight - body.scrollTop - body.clientHeight
          }),
        { timeout: 5000 }
      )
      .toBeLessThanOrEqual(4)

    const scroll = await page.evaluate(() => {
      const body = document.querySelector('[data-testid="panel-body"]') as HTMLElement
      return {
        scrollTop: body.scrollTop,
        scrollHeight: body.scrollHeight,
        clientHeight: body.clientHeight,
        distance: body.scrollHeight - body.scrollTop - body.clientHeight,
        fadeTop: body.dataset['fadeTop'] ?? null,
        fadeBottom: body.dataset['fadeBottom'] ?? null
      }
    })
    expect(scroll.scrollHeight).toBeGreaterThan(scroll.clientHeight)
    expect(scroll.distance).toBeLessThanOrEqual(4)

    await page.evaluate(() => {
      const body = document.querySelector('[data-testid="panel-body"]') as HTMLElement
      body.scrollTop = 0
      body.dispatchEvent(new Event('scroll'))
    })
    await delay(150)
    const atTop = await page.evaluate(() => {
      const body = document.querySelector('[data-testid="panel-body"]') as HTMLElement
      return {
        fadeTop: body.dataset['fadeTop'] ?? null,
        fadeBottom: body.dataset['fadeBottom'] ?? null
      }
    })
    expect(atTop.fadeTop).toBe('false')
    expect(atTop.fadeBottom).toBe('true')

    await page.evaluate(() => {
      const body = document.querySelector('[data-testid="panel-body"]') as HTMLElement
      body.scrollTop = body.scrollHeight
      body.dispatchEvent(new Event('scroll'))
    })
    await delay(150)
    const atBottom = await page.evaluate(() => {
      const body = document.querySelector('[data-testid="panel-body"]') as HTMLElement
      return {
        fadeTop: body.dataset['fadeTop'] ?? null,
        fadeBottom: body.dataset['fadeBottom'] ?? null
      }
    })
    expect(atBottom.fadeBottom).toBe('false')

    writeJson('task-19-streaming.json', {
      framesPerSecond,
      sampleWindowMs: 1000,
      panelHeight,
      scroll,
      atTop,
      atBottom,
      contentComplete: text.includes('chunk 300'),
      screenshot: 'task-19-streaming.png'
    })
    checks.throttle30fps = framesPerSecond <= 30
    checks.longComplete = text.includes('chunk 300')
    checks.panelGrows = panelHeight === 420
    checks.scrollFades =
      atTop.fadeTop === 'false' && atTop.fadeBottom === 'true' && atBottom.fadeBottom === 'false'
    mergeEvidence({
      streaming: {
        framesPerSecond,
        panelHeight,
        contentComplete: text.includes('chunk 300'),
        scroll
      }
    })
  })

  test('stop preserves the generated text and retry replaces the same row', async () => {
    await setProvider(mockBaseUrl('slow'))
    const beforePosts = postCount()
    await sendQuestion('stop request')
    await expect.poll(() => postCount(), { timeout: 10_000 }).toBe(beforePosts + 1)

    const assistant = lastAssistant()
    await expect
      .poll(async () => (await lastMarkdownText()).length, { timeout: 10_000 })
      .toBeGreaterThan(0)
    await expect(page.locator('[data-testid="btn-stop"]')).toBeVisible()
    const beforeStop = await lastMarkdownText()

    await page.locator('[data-testid="btn-stop"]').click()
    await waitLastStatus('stopped', 15_000)
    const statusLabel = await assistant.locator('[data-testid="msg-status"]').textContent()
    const afterStop = await lastMarkdownText()
    expect(statusLabel).toBe('已停止')
    expect(afterStop.length).toBeGreaterThanOrEqual(beforeStop.length)
    expect(afterStop.trimEnd().startsWith(beforeStop.trim())).toBe(true)
    expect(await page.locator('[data-testid="btn-stop"]').count()).toBe(0)

    await delay(700)
    const afterWait = await lastMarkdownText()
    expect(afterWait).toBe(afterStop)

    const log = readFileSync(mockLogPath, 'utf8')
    expect(log).toContain('client closed after')

    await screenshot('task-19-stopped.png')
    await assistant.hover()
    await expect(assistant.locator('[data-testid="btn-retry"]')).toBeVisible()
    await expect(page.locator('[data-testid="error-retry"]')).toBeVisible()

    const stopEvidence = {
      task: 19,
      mode: 'slow',
      beforeStopChars: beforeStop.length,
      afterStopChars: afterStop.length,
      afterWaitChars: afterWait.length,
      statusLabel,
      noNewDeltas: afterWait === afterStop,
      serverSawClose: log.includes('client closed after'),
      retryVisible: true,
      screenshot: 'task-19-stopped.png'
    }
    writeJson('task-19-stop.json', stopEvidence)
    checks.stopPreserved = afterStop.trimEnd().startsWith(beforeStop.trim()) && afterWait === afterStop
    checks.stopServerClosed = log.includes('client closed after')
    mergeEvidence({ stop: stopEvidence })

    const retryPosts = postCount()
    const retryCount = await page.locator('[data-testid="assistant-message"]').count()
    const retryId = await lastAssistant().getAttribute('data-message-id')
    await setProvider(mockBaseUrl('markdown'))
    await page.locator('[data-testid="error-retry"]').click()
    await expect.poll(() => postCount(), { timeout: 10_000 }).toBe(retryPosts + 1)
    await waitLastStatus('complete', 30_000)

    const afterRetryCount = await page.locator('[data-testid="assistant-message"]').count()
    const afterRetryId = await lastAssistant().getAttribute('data-message-id')
    const afterRetryText = await lastMarkdownText()
    expect(afterRetryCount).toBe(retryCount)
    expect(afterRetryId).toBe(retryId)
    expect(afterRetryText).toContain('Markdown 安全夹具')

    writeJson('task-19-retry.json', {
      retryCount,
      afterRetryCount,
      retryId,
      afterRetryId,
      posts: postCount(),
      contentReplaced: afterRetryText.includes('Markdown 安全夹具')
    })
    checks.retrySameRow =
      afterRetryCount === retryCount &&
      afterRetryId === retryId &&
      afterRetryText.includes('Markdown 安全夹具')
    mergeEvidence({ retry: { retryId, afterRetryId, retryCount, afterRetryCount } })
  })

  test('get-active hydrates a streaming assistant after renderer reload', async () => {
    await setProvider(mockBaseUrl('slow'))
    const beforePosts = postCount()
    await sendQuestion('hydrate active request')
    await expect.poll(() => postCount(), { timeout: 10_000 }).toBe(beforePosts + 1)
    await expect
      .poll(async () => (await lastMarkdownText()).length, { timeout: 10_000 })
      .toBeGreaterThan(0)

    await page.reload()
    await page.waitForLoadState('domcontentloaded')
    await page.waitForFunction(() => Boolean((window as unknown as TestWindow).quickask))
    await page.waitForFunction(
      () =>
        document.querySelector('[data-testid="app-root"]')?.getAttribute('data-ui-mode') ===
        'S2'
    )
    await expect
      .poll(() => page.locator('[data-testid="assistant-message"]').count(), {
        timeout: 10_000
      })
      .toBeGreaterThanOrEqual(1)
    await expect(page.locator('[data-testid="btn-stop"]')).toBeVisible({ timeout: 10_000 })
    await waitLastStatus('streaming', 10_000)
    const hydrated = await lastMarkdownText()
    expect(hydrated.length).toBeGreaterThan(0)

    await page.locator('[data-testid="btn-stop"]').click()
    await waitLastStatus('stopped', 15_000)
    const stopped = await lastMarkdownText()
    expect(stopped.length).toBeGreaterThanOrEqual(hydrated.length)

    writeJson('task-19-get-active.json', {
      posts: postCount(),
      hydratedChars: hydrated.length,
      stoppedChars: stopped.length,
      statusAfterReload: 'streaming',
      stopAfterReload: '已停止',
      note: 'restart hydration loads persisted history (sessions:state) and the active assistant row'
    })
    checks.getActiveHydrated = hydrated.length > 0 && stopped.length >= hydrated.length
    mergeEvidence({
      getActive: {
        hydratedChars: hydrated.length,
        stoppedChars: stopped.length,
        stopAfterReload: true
      }
    })
  })

  test('429 shows a manual-retry error bar with no automatic retry storm', async () => {
    await setProvider(mockBaseUrl('rate'))
    const composer = page.locator('[data-testid="composer"]')
    await composer.fill('rate limit question')
    const beforePosts = postCount()
    await page.keyboard.press('Enter')
    await expect.poll(() => postCount(), { timeout: 10_000 }).toBe(beforePosts + 1)

    const errorBar = page.locator('[data-testid="panel-error"]')
    await expect(errorBar).toBeVisible({ timeout: 10_000 })
    await expect(errorBar).toContainText('限流')
    await expect(lastAssistant().locator('[data-testid="msg-status"]')).toHaveText('生成失败')
    await expect(page.locator('[data-testid="user-text"]').last()).toHaveText(
      'rate limit question'
    )

    await delay(1200)
    expect(postCount()).toBe(beforePosts + 1)

    writeJson('task-19-error-429.json', {
      errorText: await errorBar.textContent(),
      posts: postCount(),
      autoRetried: postCount() !== beforePosts + 1,
      statusLabel: '生成失败',
      userText: 'rate limit question'
    })
    checks.rateLimitManual = postCount() === beforePosts + 1
    checks.errorVisible = true
    mergeEvidence({ rateLimit: { text: await errorBar.textContent(), posts: postCount() } })
  })

  test('500 shows a redacted <=300-char error bar without secrets or raw body overflow', async () => {
    await setProvider(mockBaseUrl('server500'))
    const beforePosts = postCount()
    await sendQuestion('server failure question')
    await expect.poll(() => postCount(), { timeout: 10_000 }).toBe(beforePosts + 1)

    const errorBar = page.locator('[data-testid="panel-error"]')
    await expect(errorBar).toBeVisible({ timeout: 10_000 })
    await expect(errorBar).toContainText('服务端错误')
    await expect(lastAssistant().locator('[data-testid="msg-status"]')).toHaveText('生成失败')
    await expect(page.locator('[data-testid="user-text"]').last()).toHaveText(
      'server failure question'
    )

    const errorText = (await errorBar.locator('.qa-error-text').textContent()) ?? ''
    expect(errorText.length).toBeLessThanOrEqual(300)
    expect(errorText).not.toContain('sk-mock1234567890')
    expect(errorText).not.toContain('leak-secret')
    expect(errorText).not.toContain('"error"')
    expect(errorText).not.toContain('{"')
    expect(errorText).not.toContain('"type"')
    expect(errorText).not.toContain('"}}')

    await screenshot('task-19-error.png')

    writeJson('task-19-error.json', {
      errorText,
      length: errorText.length,
      maxChars: 300,
      containsSecret: errorText.includes('sk-mock1234567890'),
      containsRawJson: errorText.includes('"error"'),
      userText: 'server failure question',
      screenshot: 'task-19-error.png'
    })
    checks.serverErrorRedacted =
      errorText.length <= 300 &&
      !errorText.includes('sk-mock1234567890') &&
      !errorText.includes('leak-secret') &&
      !errorText.includes('"error"') &&
      !errorText.includes('"type"')
    mergeEvidence({ serverError: { errorText, length: errorText.length } })
  })
})
