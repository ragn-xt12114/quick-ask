import { _electron as electron, expect, test } from '@playwright/test'
import type { ElectronApplication, Page } from '@playwright/test'
import { execFileSync, spawn, type ChildProcess } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { DatabaseSync } from 'node:sqlite'

interface IpcResponse<T = unknown> {
  ok: boolean
  data?: T
  error?: { code: string; message: string }
}

interface SessionSummaryLike {
  id: string
  title: string
  updatedAt: number
  lastMessageAt: number | null
  model: string | null
}

interface SessionLike extends SessionSummaryLike {
  titleAuto: boolean
  createdAt: number
  systemPrompt: string | null
}

interface ChatMessageLike {
  id: string
  sessionId: string
  seq: number
  role: string
  content: string
  status: string
}

interface WindowStateLike {
  mode: string
  visible: boolean
  layout: {
    sidebarRect?: { x: number; y: number; width: number; height: number }
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
    openSettings(): Promise<IpcResponse<{ open: boolean }>>
    closeSettings(): Promise<IpcResponse<{ open: boolean }>>
  }
  chat: {
    send(request: { sessionId: string | null; text: string }): Promise<IpcResponse>
    getActive(): Promise<IpcResponse<{ active: { requestId: string; sessionId: string } | null }>>
  }
  sessions: {
    list(request?: {
      query?: string
      limit?: number
      offset?: number
    }): Promise<IpcResponse<{ sessions: SessionSummaryLike[] }>>
    get(request: { id: string }): Promise<IpcResponse<SessionLike>>
    getMessages(
      request: { sessionId: string }
    ): Promise<IpcResponse<{ messages: ChatMessageLike[] }>>
    delete(request: { id: string }): Promise<IpcResponse<{ deleted: boolean }>>
    state(): Promise<
      IpcResponse<{
        currentSessionId: string | null
        mode: string
        activeRequestId: string | null
        messages: ChatMessageLike[]
      }>
    >
  }
  provider: {
    list(): Promise<IpcResponse<{ profiles: Array<{ id: string; model: string }> }>>
    create(request: Record<string, unknown>): Promise<IpcResponse>
    delete(request: { id: string }): Promise<IpcResponse>
  }
}

type TestWindow = typeof globalThis & { quickask?: TestApi }

declare global {
  interface Window {
    quickask?: TestApi
  }
}

interface MockHandle {
  proc: ChildProcess
  port: number
  stdout: string
  stderr: string
}

const EVIDENCE_DIR = resolve('.omo/evidence')
const M1_EVIDENCE_DIR = resolve('.omo/evidence/m1')
const DISPLAY = process.env['DISPLAY'] ?? ':0'
const SEED_SCRIPT = resolve('tools/seed-history.mjs')
const MOCK_SCRIPT = resolve('tools/mock-sse-server.mjs')

let app: ElectronApplication | undefined
let page: Page
let tempRoot = ''
let dbPath = ''
let mockLogPath = ''
let mock: MockHandle | undefined

const evidence: Record<string, unknown> = {}
const pageErrors: string[] = []
let seedInfo = { sessions: 0, messages: 0, ftsRows: 0 }

function delay(ms: number): Promise<void> {
  return new Promise((resolveDelay) => setTimeout(resolveDelay, ms))
}

function writeJson(name: string, value: unknown, dir = EVIDENCE_DIR): void {
  mkdirSync(dir, { recursive: true })
  writeFileSync(resolve(dir, name), `${JSON.stringify(value, null, 2)}\n`)
}

function writeM1Json(name: string, value: unknown): void {
  writeJson(name, value, M1_EVIDENCE_DIR)
}

function readM1Json(name: string): Record<string, unknown> | null {
  try {
    return JSON.parse(readFileSync(resolve(M1_EVIDENCE_DIR, name), 'utf8')) as Record<
      string,
      unknown
    >
  } catch {
    return null
  }
}

function baseEnv(root: string): Record<string, string> {
  const env: Record<string, string> = {}
  for (const [key, value] of Object.entries(process.env)) {
    if (value !== undefined) env[key] = value
  }
  return {
    ...env,
    DISPLAY,
    XDG_CONFIG_HOME: join(root, 'config'),
    XDG_DATA_HOME: join(root, 'data'),
    XDG_STATE_HOME: join(root, 'state'),
    QUICKASK_DATA_DIR: root,
    QUICKASK_DISABLE_ONBOARDING: '1'
  }
}

async function startMock(args: string[]): Promise<MockHandle> {
  const handle: MockHandle = {
    proc: spawn(process.execPath, [MOCK_SCRIPT, ...args], {
      stdio: ['ignore', 'pipe', 'pipe']
    }),
    port: 0,
    stdout: '',
    stderr: ''
  }
  mock = handle

  await new Promise<void>((resolveStarted, reject) => {
    const timer = setTimeout(() => reject(new Error('mock did not start')), 10_000)
    handle.proc.stdout?.setEncoding('utf8')
    handle.proc.stderr?.setEncoding('utf8')
    handle.proc.stdout?.on('data', (chunk: string) => {
      handle.stdout += chunk
      const found = handle.stdout.match(/listening on http:\/\/([^:\s]+):(\d+)/)
      if (found) {
        handle.port = Number(found[2])
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
        reject(new Error(`mock exited early: ${code ?? 'signal'}`))
      }
    })
  })
  return handle
}

async function stopMock(): Promise<void> {
  if (!mock || mock.proc.exitCode !== null) return
  const exited = new Promise<void>((resolveExit) => {
    mock!.proc.once('exit', () => resolveExit())
  })
  mock.proc.kill('SIGTERM')
  await Promise.race([exited, delay(2000)])
  if (mock.proc.exitCode === null) mock.proc.kill('SIGKILL')
}

async function launchApp(root: string): Promise<void> {
  app = await electron.launch({ args: ['.'], env: baseEnv(root) })
  page = await app.firstWindow()
  page.on('pageerror', (error) => pageErrors.push(error.message))
  await page.waitForLoadState('domcontentloaded')
  await page.waitForFunction(() => Boolean((window as unknown as TestWindow).quickask))
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

async function show(): Promise<void> {
  const result = await page.evaluate(() =>
    (window as unknown as TestWindow).quickask!.window.show()
  )
  expect(result.ok).toBe(true)
  await page.waitForFunction(
    () =>
      document.querySelector('[data-testid="app-root"]')?.getAttribute('data-ui-mode') !== 'S0'
  )
  await app?.evaluate(({ BrowserWindow }) => {
    const window = BrowserWindow.getAllWindows()[0]
    window?.focus()
    window?.webContents.setBackgroundThrottling(false)
  })
}

async function setProvider(baseUrl: string): Promise<void> {
  const created = await page.evaluate(async ({ url }) => {
    const api = (window as unknown as TestWindow).quickask!
    const existing = await api.provider.list()
    for (const profile of existing.data?.profiles ?? []) {
      await api.provider.delete({ id: profile.id })
    }
    return api.provider.create({
      name: 'history-mock',
      baseUrl: url,
      model: 'mock',
      isDefault: true
    })
  }, { url: baseUrl })
  expect(created.ok).toBe(true)
}

async function listSessions(query?: string): Promise<SessionSummaryLike[]> {
  const result = await page.evaluate(
    async (value) =>
      (window as unknown as TestWindow).quickask!.sessions.list({
        query: value,
        limit: 1000
      }),
    query
  )
  expect(result.ok).toBe(true)
  return result.data?.sessions ?? []
}

function readDb<T>(fn: (db: DatabaseSync) => T): T {
  const db = new DatabaseSync(dbPath, { readOnly: true })
  try {
    return fn(db)
  } finally {
    db.close()
  }
}

function countEmptySessions(): number {
  return readDb((db) => {
    const row = db
      .prepare(
        `SELECT COUNT(*) AS count
           FROM sessions s
          WHERE NOT EXISTS (SELECT 1 FROM messages m WHERE m.session_id = s.id)`
      )
      .get() as { count: number }
    return Number(row.count)
  })
}

function countSessions(): number {
  return readDb((db) => {
    const row = db.prepare('SELECT COUNT(*) AS count FROM sessions').get() as {
      count: number
    }
    return Number(row.count)
  })
}

function titleAutoOf(id: string): boolean {
  return readDb((db) => {
    const row = db.prepare('SELECT title_auto FROM sessions WHERE id = ?').get(id) as
      | { title_auto: number }
      | undefined
    return row ? Number(row.title_auto) === 1 : false
  })
}

function messageCountOf(id: string): number {
  return readDb((db) => {
    const row = db
      .prepare('SELECT COUNT(*) AS count FROM messages WHERE session_id = ?')
      .get(id) as { count: number }
    return Number(row.count)
  })
}

async function inputSearch(value: string): Promise<void> {
  await page.evaluate((next) => {
    const input = document.querySelector('[data-testid="sidebar-search"]') as
      | HTMLInputElement
      | null
    if (!input) throw new Error('missing history search input')
    const setter = Object.getOwnPropertyDescriptor(
      HTMLInputElement.prototype,
      'value'
    )?.set
    setter?.call(input, next)
    input.dispatchEvent(new Event('input', { bubbles: true }))
  }, value)
}

async function waitSearchApplied(value: string): Promise<void> {
  await page.waitForFunction(
    (expected) => {
      const scroll = document.querySelector('[data-testid="sidebar-scroll"]')
      return (
        scroll?.getAttribute('data-applied-query') === expected &&
        scroll?.getAttribute('data-pending') === 'false'
      )
    },
    value
  )
}

async function measureSearchUi(value: string): Promise<{
  elapsedMs: number
  resultCount: number
}> {
  return page.evaluate(async (next) => {
    const scroll = document.querySelector('[data-testid="sidebar-scroll"]') as
      | HTMLElement
      | null
    if (!scroll) throw new Error('missing history scroll')
    const input = document.querySelector('[data-testid="sidebar-search"]') as
      | HTMLInputElement
      | null
    if (!input) throw new Error('missing history search input')
    const setter = Object.getOwnPropertyDescriptor(
      HTMLInputElement.prototype,
      'value'
    )?.set
    const started = performance.now()
    const done = new Promise<void>((resolveDone) => {
      const observer = new MutationObserver(() => {
        if (
          scroll.getAttribute('data-applied-query') === next &&
          scroll.getAttribute('data-pending') === 'false'
        ) {
          observer.disconnect()
          resolveDone()
        }
      })
      observer.observe(scroll, {
        attributes: true,
        attributeFilter: ['data-applied-query', 'data-pending']
      })
      setTimeout(() => {
        observer.disconnect()
        resolveDone()
      }, 3000)
    })
    setter?.call(input, next)
    input.dispatchEvent(new Event('input', { bubbles: true }))
    await done
    return {
      elapsedMs: performance.now() - started,
      resultCount: Number(scroll.getAttribute('data-result-count') ?? 0)
    }
  }, value)
}

async function openItemMenu(index: number): Promise<void> {
  const row = page.locator('[data-testid="history-item"]').nth(index)
  await row.hover()
  await row.locator('.qa-session-more').click()
  await expect(page.locator('[data-testid="history-menu"]')).toBeVisible()
}

test.describe.configure({ mode: 'serial' })

test.beforeAll(async () => {
  tempRoot = mkdtempSync(join(tmpdir(), 'quickask-task20-'))
  for (const dir of ['config', 'data', 'state']) {
    mkdirSync(join(tempRoot, dir), { recursive: true })
  }
  dbPath = join(tempRoot, 'quickask.db')
  mockLogPath = join(tempRoot, 'mock-sse.log')
  mkdirSync(EVIDENCE_DIR, { recursive: true })
  mkdirSync(M1_EVIDENCE_DIR, { recursive: true })

  const seedOut = execFileSync(
    process.execPath,
    [SEED_SCRIPT, '--sessions', '1000', '--messages', '10', '--fts', '--db', dbPath],
    { encoding: 'utf8' }
  )
  writeFileSync(resolve(EVIDENCE_DIR, 'task-20-seed.log'), seedOut)
  writeFileSync(resolve(M1_EVIDENCE_DIR, 'history-1000-e2e-seed.log'), seedOut)
  const seeded = /seeded (\d+) sessions \/ (\d+) messages(?: \+ (\d+) FTS rows)?/.exec(seedOut)
  seedInfo = {
    sessions: Number(seeded?.[1] ?? 0),
    messages: Number(seeded?.[2] ?? 0),
    ftsRows: Number(seeded?.[3] ?? 0)
  }
  expect(seedOut).toContain('seeded 1000 sessions / 10000 messages')

  mock = await startMock([
    '--mode',
    'slow',
    '--chunks',
    '100',
    '--delay',
    '100',
    '--log',
    mockLogPath
  ])

  await launchApp(tempRoot)
  await show()
  await setProvider(`http://127.0.0.1:${mock.port}/v1`)
  await setMode('S1')
  expect((await listSessions()).length).toBe(1000)
})

test.afterAll(async () => {
  writeJson('task-20-summary.json', {
    ...evidence,
    pageErrors,
    mockStderr: mock?.stderr ?? '',
    mockStdout: mock?.stdout ?? ''
  })
  await app?.close()
  await stopMock()
})

test('history: 1000 sessions open under 150ms with a bounded virtual DOM', async () => {
  // S3 keeps the panel height from the previous session (Task 14/19): set a
  // realistic 420px panel so the sidebar is 480px tall for scrolling below.
  await setMode('S3')
  const height = await page.evaluate(() =>
    (window as unknown as TestWindow).quickask!.window.setHeight({ panelHeight: 420 })
  )
  expect(height.ok).toBe(true)
  await page.waitForFunction(
    () => Math.round(window.innerHeight) === 560
  )
  await setMode('S1')
  await page.waitForFunction(() => !document.querySelector('[data-testid="sidebar"]'))

  const measured = await page.evaluate(async () => {
    const started = performance.now()
    await new Promise<void>((resolveOpen, rejectOpen) => {
      const timer = setTimeout(() => {
        observer.disconnect()
        rejectOpen(new Error('first history item did not render'))
      }, 5000)
      const observer = new MutationObserver(() => {
        if (document.querySelector('[data-testid="history-item"]')) {
          clearTimeout(timer)
          observer.disconnect()
          resolveOpen()
        }
      })
      observer.observe(document.body, { childList: true, subtree: true })
      void window.quickask!.window.setMode('S3')
    })
    return performance.now() - started
  })

  await expect(page.locator('[data-testid="history-item"]').first()).toBeVisible()
  await expect
    .poll(
      async () =>
        Math.round((await page.locator('[data-testid="sidebar"]').boundingBox())?.width ?? 0),
      { timeout: 6000 }
    )
    .toBe(260)
  const snapshot = await page.evaluate(() => {
    const items = Array.from(document.querySelectorAll('[data-testid="history-item"]'))
    const first = items[0] as HTMLElement
    const group = document.querySelector('[data-testid="history-group"]') as HTMLElement | null
    const scroll = document.querySelector('[data-testid="sidebar-scroll"]') as HTMLElement | null
    const bar = document.querySelector('[data-testid="bar"]') as HTMLElement | null
    const barRect = bar?.getBoundingClientRect()
    return {
      domItems: items.length,
      resultCount: Number(scroll?.getAttribute('data-result-count') ?? 0),
      rendered: Number(scroll?.getAttribute('data-rendered-items') ?? 0),
      firstTitle: first?.querySelector('.qa-session-title')?.textContent ?? '',
      itemHeight: first?.getBoundingClientRect().height ?? 0,
      groupLabel: group?.textContent ?? '',
      groupHeight: group?.getBoundingClientRect().height ?? 0,
      currentCount: document.querySelectorAll('.qa-session-item--current').length,
      currentSessionId:
        document.querySelector('.qa-session-item--current')?.getAttribute('data-session-id') ??
        null,
      sidebar: document.querySelector('[data-testid="sidebar"]')?.getBoundingClientRect().toJSON(),
      window: { screenX: window.screenX, screenY: window.screenY, dpr: window.devicePixelRatio },
      barAnchor: barRect
        ? {
            x: Math.round(window.screenX + barRect.x),
            y: Math.round(window.screenY + barRect.y),
            width: Math.round(barRect.width),
            height: Math.round(barRect.height)
          }
        : null
    }
  })

  expect(measured).toBeLessThan(150)
  expect(snapshot.resultCount).toBe(1000)
  expect(snapshot.domItems).toBeLessThan(80)
  expect(snapshot.rendered).toBeLessThan(80)
  expect(snapshot.firstTitle).toContain('#1000')
  expect(snapshot.itemHeight).toBe(48)
  expect(snapshot.groupHeight).toBe(24)
  expect(snapshot.groupLabel).toBe('更早')
  expect(snapshot.currentCount).toBe(1)
  expect(snapshot.currentSessionId).not.toBeNull()
  expect(snapshot.sidebar).toMatchObject({ width: 260, height: 480 })

  writeJson('task-20-history.json', {
    measuredFrom: 'window.setMode("S3") -> first [data-testid="history-item"]',
    openS3Ms: Number(measured.toFixed(2)),
    budgetMs: 150,
    sessions: snapshot.resultCount,
    domItems: snapshot.domItems,
    renderedItems: snapshot.rendered,
    domItemBudget: 80,
    firstTitle: snapshot.firstTitle,
    group: snapshot.groupLabel,
    itemHeight: snapshot.itemHeight,
    groupHeight: snapshot.groupHeight,
    currentCount: snapshot.currentCount,
    sidebar: snapshot.sidebar,
    pageErrors
  })

  writeM1Json('history-1000.json', {
    measuredFrom: 'window.setMode("S3") -> first [data-testid="history-item"]',
    openS3Ms: Number(measured.toFixed(2)),
    budgetMs: 150,
    verdict: measured < 150 ? 'PASS' : 'FAIL',
    seedCount: seedInfo.sessions,
    seedMessages: seedInfo.messages,
    seedFtsRows: seedInfo.ftsRows,
    sessions: snapshot.resultCount,
    domItems: snapshot.domItems,
    renderedItems: snapshot.rendered,
    domItemBudget: 80,
    domBounded: snapshot.domItems < 80,
    firstTitle: snapshot.firstTitle,
    group: snapshot.groupLabel,
    itemHeight: snapshot.itemHeight,
    groupHeight: snapshot.groupHeight,
    currentCount: snapshot.currentCount,
    anchor: snapshot.barAnchor,
    sidebarAnchor: snapshot.sidebar,
    screenshot: '.omo/evidence/m1/history-1000-open.png',
    pageErrors
  })

  await page.screenshot({ path: resolve(EVIDENCE_DIR, 'task-20-history.png') })
  await page.screenshot({ path: resolve(M1_EVIDENCE_DIR, 'history-1000-open.png') })
})

test('scroll: 5s rAF p95 target recorded, no blank rows, bounded DOM', async () => {
  await expect(page.locator('[data-testid="history-item"]').first()).toBeVisible()
  const result = await page.evaluate(async () => {
    const scroll = document.querySelector('[data-testid="sidebar-scroll"]') as HTMLElement
    const deltas: number[] = []
    let blankRows = 0
    let maxDomItems = 0
    let minDomItems = Number.POSITIVE_INFINITY
    const started = performance.now()
    let last = started

    await new Promise<void>((resolveScroll) => {
      const frame = (now: number): void => {
        deltas.push(now - last)
        last = now
        if (now - started >= 5000) {
          resolveScroll()
          return
        }
        const max = scroll.scrollHeight - scroll.clientHeight
        const next = scroll.scrollTop + 32
        scroll.scrollTop = next >= max ? 0 : next
        const items = Array.from(
          document.querySelectorAll('[data-testid="history-item"]')
        ) as HTMLElement[]
        maxDomItems = Math.max(maxDomItems, items.length)
        minDomItems = Math.min(minDomItems, items.length)
        blankRows += items.filter(
          (item) => (item.textContent ?? '').trim().length === 0
        ).length
        requestAnimationFrame(frame)
      }
      requestAnimationFrame(frame)
    })

    const sorted = [...deltas].sort((a, b) => a - b)
    const percentile = (value: number): number =>
      sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * value))] ?? 0
    const items = Array.from(
      document.querySelectorAll('[data-testid="history-item"]')
    ) as HTMLElement[]
    return {
      frames: deltas.length,
      durationMs: performance.now() - started,
      p50: percentile(0.5),
      p95: percentile(0.95),
      p99: percentile(0.99),
      max: sorted[sorted.length - 1] ?? 0,
      maxDomItems,
      minDomItems,
      finalDomItems: items.length,
      blankRows: blankRows + items.filter((item) => !item.textContent?.trim()).length,
      scrollTop: scroll.scrollTop,
      scrollHeight: scroll.scrollHeight
    }
  })

  expect(result.blankRows).toBe(0)
  expect(result.maxDomItems).toBeLessThan(80)
  expect(result.p95).toBeLessThanOrEqual(32)
  const note =
    result.p95 <= 16.7
      ? 'p95 meets the 16.7ms 60Hz target'
      : 'p95 falls in the allowed ≤32ms device band (X11/Electron compositor variance); no blank rows'

  writeJson('task-20-scroll.json', {
    durationMs: Number(result.durationMs.toFixed(1)),
    frames: result.frames,
    p50Ms: Number(result.p50.toFixed(2)),
    p95Ms: Number(result.p95.toFixed(2)),
    p99Ms: Number(result.p99.toFixed(2)),
    maxMs: Number(result.max.toFixed(2)),
    target: 'p95 <16.7ms (or ≤32ms with device note)',
    note,
    domItems: {
      min: result.minDomItems,
      max: result.maxDomItems,
      final: result.finalDomItems,
      budget: 80
    },
    blankRows: result.blankRows,
    scrollTop: result.scrollTop,
    scrollHeight: result.scrollHeight,
    device: {
      display: process.env['DISPLAY'] ?? ':0',
      platform: process.platform,
      dpr: await page.evaluate(() => window.devicePixelRatio)
    }
  })

  writeM1Json('history-scroll.json', {
    durationMs: Number(result.durationMs.toFixed(1)),
    frames: result.frames,
    p50Ms: Number(result.p50.toFixed(2)),
    p95Ms: Number(result.p95.toFixed(2)),
    p99Ms: Number(result.p99.toFixed(2)),
    maxMs: Number(result.max.toFixed(2)),
    target: 'p95 <16.7ms (or ≤32ms with device note)',
    verdict: result.p95 <= 32 ? 'PASS' : 'FAIL',
    note,
    domItems: {
      min: result.minDomItems,
      max: result.maxDomItems,
      final: result.finalDomItems,
      budget: 80
    },
    blankRows: result.blankRows,
    scrollTop: result.scrollTop,
    scrollHeight: result.scrollHeight,
    device: {
      display: process.env['DISPLAY'] ?? ':0',
      platform: process.platform,
      dpr: await page.evaluate(() => window.devicePixelRatio),
      note: 'X11/Electron software compositor on the test VM; p95 ≤32ms is the documented device band when 16.7ms is not reached'
    },
    screenshot: '.omo/evidence/m1/history-1000-scroll.png'
  })

  await page.screenshot({ path: resolve(EVIDENCE_DIR, 'task-20-scroll.png') })
  await page.screenshot({ path: resolve(M1_EVIDENCE_DIR, 'history-1000-scroll.png') })
})

test('search: 2-char LIKE <150ms, 3+ FTS <100ms, special chars safe, empty text, IME guard', async () => {
  await inputSearch('')
  await waitSearchApplied('')

  const direct = await page.evaluate(async () => {
    const api = window.quickask!
    const time = async (query: string): Promise<{ ms: number; count: number; ok: boolean }> => {
      const started = performance.now()
      const result = await api.sessions.list({ query, limit: 1000 })
      return {
        ms: performance.now() - started,
        count: result.ok ? (result.data?.sessions.length ?? 0) : -1,
        ok: result.ok
      }
    }
    return {
      like: await time('报错'),
      fts: await time('虚拟列表'),
      special: await time('"*()-'),
      percent: await time('%_')
    }
  })

  expect(direct.like.ok).toBe(true)
  expect(direct.like.count).toBeGreaterThan(0)
  expect(direct.like.ms).toBeLessThan(150)
  expect(direct.fts.ok).toBe(true)
  expect(direct.fts.count).toBeGreaterThan(0)
  expect(direct.fts.ms).toBeLessThan(100)
  expect(direct.special.ok).toBe(true)
  expect(direct.special.count).toBe(0)
  expect(direct.percent.ok).toBe(true)

  const uiLike = await measureSearchUi('报错')
  expect(uiLike.resultCount).toBe(direct.like.count)
  await page.waitForFunction(
    () =>
      document.querySelectorAll('[data-testid="history-item"]').length > 0 &&
      document.querySelector('[data-testid="sidebar-scroll"]')?.getAttribute(
        'data-applied-query'
      ) === '报错'
  )
  await page.screenshot({ path: resolve(EVIDENCE_DIR, 'task-20-search.png') })

  const uiFts = await measureSearchUi('虚拟列表')
  expect(uiFts.resultCount).toBe(direct.fts.count)

  // Special MATCH/LIKE characters must never throw or blank the sidebar.
  await inputSearch('"*()-')
  await waitSearchApplied('"*()-')
  await expect(page.locator('[data-testid="history-empty"]')).toHaveText('没有匹配的会话')
  await expect(page.locator('[data-testid="history-error"]')).toHaveCount(0)
  const specialUi = await page.evaluate(() => {
    const scroll = document.querySelector('[data-testid="sidebar-scroll"]') as HTMLElement
    return {
      applied: scroll.getAttribute('data-applied-query'),
      resultCount: Number(scroll.getAttribute('data-result-count') ?? 0),
      emptyVisible: Boolean(document.querySelector('[data-testid="history-empty"]')),
      errorCount: document.querySelectorAll('[data-testid="history-error"]').length
    }
  })

  await inputSearch('nowhere-xyz')
  await waitSearchApplied('nowhere-xyz')
  await expect(page.locator('[data-testid="history-empty"]')).toHaveText('没有匹配的会话')
  const emptyResult = await page.evaluate(() => {
    const scroll = document.querySelector('[data-testid="sidebar-scroll"]') as HTMLElement
    return {
      query: scroll.getAttribute('data-applied-query'),
      resultCount: Number(scroll.getAttribute('data-result-count') ?? 0),
      itemCount: document.querySelectorAll('[data-testid="history-item"]').length,
      emptyText: document.querySelector('[data-testid="history-empty"]')?.textContent ?? '',
      errorCount: document.querySelectorAll('[data-testid="history-error"]').length
    }
  })
  expect(emptyResult.resultCount).toBe(0)
  expect(emptyResult.itemCount).toBe(0)
  expect(emptyResult.errorCount).toBe(0)

  // IME: input events during composition must not schedule/apply a query.
  await inputSearch('')
  await waitSearchApplied('')
  const emptyQuery = await page.evaluate(() => {
    const scroll = document.querySelector('[data-testid="sidebar-scroll"]') as HTMLElement
    return {
      applied: scroll.getAttribute('data-applied-query'),
      resultCount: Number(scroll.getAttribute('data-result-count') ?? 0)
    }
  })
  const ime = await page.evaluate(async () => {
    const input = document.querySelector('[data-testid="sidebar-search"]') as HTMLInputElement
    const scroll = document.querySelector('[data-testid="sidebar-scroll"]') as HTMLElement
    const setter = Object.getOwnPropertyDescriptor(
      HTMLInputElement.prototype,
      'value'
    )?.set
    input.dispatchEvent(new CompositionEvent('compositionstart', { bubbles: true, data: '' }))
    setter?.call(input, '报错')
    input.dispatchEvent(new Event('input', { bubbles: true }))
    await new Promise((resolveWait) => setTimeout(resolveWait, 320))
    const during = {
      applied: scroll.getAttribute('data-applied-query'),
      count: Number(scroll.getAttribute('data-result-count') ?? 0)
    }
    input.dispatchEvent(
      new CompositionEvent('compositionend', { bubbles: true, data: '报错' })
    )
    const started = performance.now()
    await new Promise<void>((resolveWait) => {
      const observer = new MutationObserver(() => {
        if (
          scroll.getAttribute('data-applied-query') === '报错' &&
          scroll.getAttribute('data-pending') === 'false'
        ) {
          observer.disconnect()
          resolveWait()
        }
      })
      observer.observe(scroll, {
        attributes: true,
        attributeFilter: ['data-applied-query', 'data-pending']
      })
      setTimeout(() => {
        observer.disconnect()
        resolveWait()
      }, 3000)
    })
    return {
      during,
      afterMs: performance.now() - started,
      after: {
        applied: scroll.getAttribute('data-applied-query'),
        count: Number(scroll.getAttribute('data-result-count') ?? 0)
      }
    }
  })

  expect(ime.during.applied).toBe('')
  expect(ime.during.count).toBe(1000)
  expect(ime.after.applied).toBe('报错')
  expect(ime.after.count).toBe(direct.like.count)
  expect(ime.afterMs).toBeLessThan(150)

  writeJson('task-20-search.json', {
    direct: {
      '2char_报错': { ms: Number(direct.like.ms.toFixed(2)), count: direct.like.count, budgetMs: 150 },
      '3char_虚拟列表': { ms: Number(direct.fts.ms.toFixed(2)), count: direct.fts.count, budgetMs: 100 },
      specialChars: { ms: Number(direct.special.ms.toFixed(2)), count: direct.special.count },
      percentUnderscore: { ms: Number(direct.percent.ms.toFixed(2)), count: direct.percent.count }
    },
    ui: {
      likeMs: Number(uiLike.elapsedMs.toFixed(2)),
      likeCount: uiLike.resultCount,
      ftsMs: Number(uiFts.elapsedMs.toFixed(2)),
      ftsCount: uiFts.resultCount,
      debounceMs: 120
    },
    emptyText: '没有匹配的会话',
    specialCharsSafe: direct.special.ok && direct.special.count === 0,
    ime
  })

  const sqlEvidence = readM1Json('history-1000-sql.json')
  const sqlSummary = (sample: unknown): unknown => {
    if (!sample || typeof sample !== 'object') return null
    const row = sample as Record<string, unknown>
    return {
      p50Ms: row.p50Ms,
      p95Ms: row.p95Ms,
      maxMs: row.maxMs,
      rows: row.rows,
      iterations: row.iterations
    }
  }
  writeM1Json('search-cjk.json', {
    sessions: seedInfo.sessions,
    note:
      'dbMs = sessions.list IPC round-trip from the renderer (query + IPC + serialization); uiMs = input event to applied result and includes the 120ms debounce. The C.8 SQL budgets (<150ms LIKE, <100ms FTS) are judged on repository-only timings in history-1000-sql.json.',
    like2char: {
      query: '报错',
      path: 'LIKE / ESCAPE over sessions.title + messages.content',
      dbMs: Number(direct.like.ms.toFixed(2)),
      dbCount: direct.like.count,
      uiMs: Number(uiLike.elapsedMs.toFixed(2)),
      uiCount: uiLike.resultCount,
      budgetMs: 150,
      verdict: direct.like.ms < 150 ? 'PASS' : 'FAIL'
    },
    fts3plus: {
      query: '虚拟列表',
      path: 'FTS5 trigram MATCH over session_search',
      dbMs: Number(direct.fts.ms.toFixed(2)),
      dbCount: direct.fts.count,
      uiMs: Number(uiFts.elapsedMs.toFixed(2)),
      uiCount: uiFts.resultCount,
      budgetMs: 100,
      verdict: direct.fts.ms < 100 ? 'PASS' : 'FAIL',
      uiNote: 'uiMs includes the fixed 120ms debounce; the SQL budget is dbMs'
    },
    specialChars: {
      query: '"*()-',
      dbMs: Number(direct.special.ms.toFixed(2)),
      dbCount: direct.special.count,
      ui: specialUi,
      safe: direct.special.ok && direct.special.count === 0 && specialUi.errorCount === 0,
      verdict:
        direct.special.ok && direct.special.count === 0 && specialUi.errorCount === 0
          ? 'PASS'
          : 'FAIL'
    },
    percentUnderscore: {
      query: '%_',
      dbMs: Number(direct.percent.ms.toFixed(2)),
      dbCount: direct.percent.count,
      safe: direct.percent.ok,
      verdict: direct.percent.ok ? 'PASS' : 'FAIL'
    },
    emptyResult: {
      ...emptyResult,
      expectedText: '没有匹配的会话',
      verdict:
        emptyResult.resultCount === 0 &&
        emptyResult.itemCount === 0 &&
        emptyResult.emptyText === '没有匹配的会话' &&
        emptyResult.errorCount === 0
          ? 'PASS'
          : 'FAIL'
    },
    emptyQuery,
    repositorySql: sqlEvidence
      ? {
          source: 'history-1000-sql.json',
          method: 'real SessionsRepository/SearchRepository via openDbService',
          list50: sqlSummary(sqlEvidence.list50),
          like2char: sqlSummary(sqlEvidence.like2char),
          fts4char: sqlSummary(sqlEvidence.fts4char),
          budgetsMs: sqlEvidence.budgetsMs,
          verdicts: sqlEvidence.verdicts
        }
      : null,
    imeGuard: {
      duringComposition: ime.during,
      afterCompositionMs: Number(ime.afterMs.toFixed(2)),
      afterComposition: ime.after,
      verdict:
        ime.during.applied === '' &&
        ime.during.count === 1000 &&
        ime.after.applied === '报错' &&
        ime.after.count === direct.like.count &&
        ime.afterMs < 150
          ? 'PASS'
          : 'FAIL'
    },
    screenshot: '.omo/evidence/m1/history-1000-search.png'
  })

  await page.screenshot({ path: resolve(M1_EVIDENCE_DIR, 'history-1000-search.png') })

  await inputSearch('')
  await waitSearchApplied('')
})

test('rename: inline input, Enter commit, titleAuto=false, composing Enter no commit, Esc cancel', async () => {
  const items = page.locator('[data-testid="history-item"]')
  const target = items.first()
  const id = (await target.getAttribute('data-session-id')) ?? ''
  expect(id).not.toBe('')
  const originalTitle = (await target.locator('.qa-session-title').textContent()) ?? ''

  await target.locator('.qa-session-title').dblclick()
  await expect(page.locator('[data-testid="rename-input"]')).toBeVisible()
  await expect(page.locator('[data-testid="app-root"]')).toHaveAttribute(
    'data-ui-mode',
    'S3'
  )
  await page.locator('[data-testid="rename-input"]').fill('重命名测试 会话')
  await page.screenshot({ path: resolve(EVIDENCE_DIR, 'task-20-rename.png') })
  await page.locator('[data-testid="rename-input"]').press('Enter')
  await expect(page.locator('[data-testid="rename-input"]')).toHaveCount(0)

  const renamed = await page.evaluate(
    async (sessionId) =>
      (window as unknown as TestWindow).quickask!.sessions.get({ id: sessionId }),
    id
  )
  expect(renamed.ok).toBe(true)
  expect(renamed.data?.title).toBe('重命名测试 会话')
  expect(renamed.data?.titleAuto).toBe(false)
  expect(titleAutoOf(id)).toBe(false)
  await expect(page.locator(`[data-session-id="${id}"] .qa-session-title`)).toHaveText(
    '重命名测试 会话'
  )

  // Composing Enter must not commit.
  const second = items.nth(1)
  const secondId = (await second.getAttribute('data-session-id')) ?? ''
  const secondTitle = (await second.locator('.qa-session-title').textContent()) ?? ''
  await second.locator('.qa-session-title').dblclick()
  const renameInput = page.locator('[data-testid="rename-input"]')
  await expect(renameInput).toBeVisible()
  await renameInput.fill('组合期不应提交')
  await page.evaluate(() => {
    const input = document.querySelector('[data-testid="rename-input"]') as HTMLInputElement
    input.dispatchEvent(new CompositionEvent('compositionstart', { bubbles: true, data: '' }))
  })
  await renameInput.press('Enter')
  await delay(150)
  const duringComposition = await page.evaluate(
    async (sessionId) =>
      (window as unknown as TestWindow).quickask!.sessions.get({ id: sessionId }),
    secondId
  )
  expect(duringComposition.data?.title).toBe(secondTitle)
  await expect(renameInput).toBeVisible()
  await page.evaluate(() => {
    const input = document.querySelector('[data-testid="rename-input"]') as HTMLInputElement
    input.dispatchEvent(new CompositionEvent('compositionend', { bubbles: true, data: '' }))
  })
  await renameInput.press('Enter')
  await expect(renameInput).toHaveCount(0)
  const afterComposition = await page.evaluate(
    async (sessionId) =>
      (window as unknown as TestWindow).quickask!.sessions.get({ id: sessionId }),
    secondId
  )
  expect(afterComposition.data?.title).toBe('组合期不应提交')
  expect(afterComposition.data?.titleAuto).toBe(false)

  // Esc cancels without writing.
  const third = items.nth(2)
  const thirdId = (await third.getAttribute('data-session-id')) ?? ''
  const thirdTitle = (await third.locator('.qa-session-title').textContent()) ?? ''
  await third.locator('.qa-session-title').dblclick()
  await expect(renameInput).toBeVisible()
  await renameInput.fill('不应保存的标题')
  await renameInput.press('Escape')
  await expect(renameInput).toHaveCount(0)
  const escaped = await page.evaluate(
    async (sessionId) =>
      (window as unknown as TestWindow).quickask!.sessions.get({ id: sessionId }),
    thirdId
  )
  expect(escaped.data?.title).toBe(thirdTitle)

  writeJson('task-20-rename.json', {
    target: { id, from: originalTitle, to: renamed.data?.title, titleAuto: renamed.data?.titleAuto },
    dbTitleAuto: titleAutoOf(id),
    composingEnter: {
      id: secondId,
      titleDuring: duringComposition.data?.title,
      titleAfter: afterComposition.data?.title,
      titleAuto: afterComposition.data?.titleAuto,
      inputStayedOpen: true
    },
    escapeCancel: { id: thirdId, title: escaped.data?.title }
  })
})

test('delete: in-window confirm, cancel keeps row, non-current cascade, current returns to S1', async () => {
  await setMode('S3')
  await inputSearch('')
  await waitSearchApplied('')
  const before = await listSessions()
  const currentBeforeDelete = await page.evaluate(async () => {
    const state = await (window as unknown as TestWindow).quickask!.sessions.state()
    return state.data?.currentSessionId ?? null
  })
  const historyRows = page.locator('[data-testid="history-item"]')
  const rowCount = await historyRows.count()
  let targetIndex = -1
  for (let index = 0; index < rowCount; index += 1) {
    const id = (await historyRows.nth(index).getAttribute('data-session-id')) ?? ''
    if (id !== currentBeforeDelete) {
      targetIndex = index
      break
    }
  }
  expect(targetIndex).toBeGreaterThanOrEqual(0)
  const target = historyRows.nth(targetIndex)
  const targetId = (await target.getAttribute('data-session-id')) ?? ''
  expect(targetId).not.toBe(currentBeforeDelete)
  const targetTitle = (await target.locator('.qa-session-title').textContent()) ?? ''

  // Cancel path: row and DB stay untouched.
  await openItemMenu(targetIndex)
  await page.locator('[data-testid="history-menu"]').getByText('删除', { exact: true }).click()
  await expect(page.locator('[data-testid="delete-confirm"]')).toBeVisible()
  await expect(page.locator('[data-testid="delete-confirm"]')).toContainText(targetTitle)
  await page.screenshot({ path: resolve(EVIDENCE_DIR, 'task-20-delete.png') })
  await page.locator('[data-testid="delete-cancel"]').click()
  await expect(page.locator('[data-testid="delete-confirm"]')).toHaveCount(0)
  expect((await listSessions()).length).toBe(before.length)

  // Confirm non-current delete.
  await openItemMenu(targetIndex)
  await page.locator('[data-testid="history-menu"]').getByText('删除', { exact: true }).click()
  await page.locator('[data-testid="delete-confirm-button"]').click()
  await expect(page.locator(`[data-session-id="${targetId}"]`)).toHaveCount(0)
  await expect
    .poll(async () => (await listSessions()).length)
    .toBe(before.length - 1)
  const gone = await page.evaluate(
    async (sessionId) =>
      (window as unknown as TestWindow).quickask!.sessions.getMessages({ sessionId }),
    targetId
  )
  expect(gone.ok).toBe(false)
  expect(gone.error?.code).toBe('NOT_FOUND')
  expect(messageCountOf(targetId)).toBe(0)

  // Load a session, reopen S3, then delete the current one.
  await inputSearch('')
  await waitSearchApplied('')
  const currentRow = page.locator('[data-testid="history-item"]').first()
  const currentId = (await currentRow.getAttribute('data-session-id')) ?? ''
  const loaded = await page.evaluate(
    async (sessionId) =>
      (window as unknown as TestWindow).quickask!.sessions.getMessages({ sessionId }),
    currentId
  )
  expect(loaded.data?.messages.length ?? 0).toBeGreaterThan(0)
  await currentRow.locator('.qa-session-main').click()
  await waitMode('S2')
  await expect(page.locator('[data-testid="sidebar"]')).toHaveCount(0)

  await setMode('S3')
  await expect(page.locator('.qa-session-item--current')).toHaveCount(1)
  const current = page.locator('.qa-session-item--current')
  await current.hover()
  await current.locator('.qa-session-more').click()
  await page.locator('[data-testid="history-menu"]').getByText('删除', { exact: true }).click()
  await page.locator('[data-testid="delete-confirm-button"]').click()
  await waitMode('S1')
  await expect(page.locator('[data-testid="sidebar"]')).toHaveCount(0)
  await expect(page.locator('[data-testid="composer"]')).toBeFocused()
  const active = await page.evaluate(() =>
    (window as unknown as TestWindow).quickask!.chat.getActive()
  )
  expect(active.data?.active).toBeNull()
  const currentGone = await page.evaluate(
    async (sessionId) =>
      (window as unknown as TestWindow).quickask!.sessions.get({ id: sessionId }),
    currentId
  )
  expect(currentGone.ok).toBe(false)
  expect(currentGone.error?.code).toBe('NOT_FOUND')
  const currentMessages = await page.evaluate(
    async (sessionId) =>
      (window as unknown as TestWindow).quickask!.sessions.getMessages({ sessionId }),
    currentId
  )
  expect(currentMessages.error?.code).toBe('NOT_FOUND')
  expect(messageCountOf(currentId)).toBe(0)
  const draft = await page.evaluate(() =>
    (window as unknown as TestWindow).quickask!.window.getState()
  )
  expect((draft.data as WindowStateLike).mode).toBe('S1')

  writeJson('task-20-delete.json', {
    cancel: { id: targetId, title: targetTitle, rowKept: true, countUnchanged: before.length },
    nonCurrent: {
      id: targetId,
      sessionsBefore: before.length,
      sessionsAfter: before.length - 1,
      getMessagesError: gone.error?.code,
      remainingMessages: messageCountOf(targetId)
    },
    current: {
      id: currentId,
      modeAfter: 'S1',
      sessionsGetError: currentGone.error?.code,
      getMessagesError: currentMessages.error?.code,
      remainingMessages: messageCountOf(currentId),
      active: null,
      composerFocused: true
    }
  })
})

test('new: aborts an active stream, clears state, focuses composer, creates no empty row', async () => {
  const emptyBefore = countEmptySessions()
  expect(emptyBefore).toBe(0)
  const countBefore = countSessions()

  await setMode('S3')
  await page.locator('[data-testid="sidebar-btn-new"]').click()
  await waitMode('S1')
  await page.locator('[data-testid="composer"]').fill('慢速流式测试')
  await page.locator('[data-testid="btn-send"]').click()
  await waitMode('S2')
  await page.waitForFunction(async () => {
    const state = await window.quickask!.sessions.state()
    return Boolean(state.data?.activeRequestId)
  })
  const active = await page.evaluate(() =>
    (window as unknown as TestWindow).quickask!.sessions.state()
  )
  expect(active.data?.activeRequestId ?? null).not.toBeNull()

  await setMode('S3')
  await expect(page.locator('.qa-session-item--current')).toHaveCount(1)
  await page.locator('[data-testid="sidebar-btn-new"]').click()
  await waitMode('S1')
  await expect(page.locator('[data-testid="composer"]')).toBeFocused()
  await expect
    .poll(async () => {
      const result = await page.evaluate(() =>
        (window as unknown as TestWindow).quickask!.chat.getActive()
      )
      return result.data?.active ?? null
    })
    .toBeNull()

  await expect
    .poll(
      () => {
        try {
          return readFileSync(mockLogPath, 'utf8')
        } catch {
          return ''
        }
      },
      { timeout: 5000 }
    )
    .toContain('client closed after')

  const log = readFileSync(mockLogPath, 'utf8')
  const after = countSessions()
  const emptyAfter = countEmptySessions()
  expect(after).toBe(countBefore + 1) // only the streamed session was created
  expect(emptyAfter).toBe(0)

  writeJson('task-20-new.json', {
    abort: {
      activeBefore: active.data?.activeRequestId ?? null,
      activeAfter: null,
      serverClosed: /client closed after \d+ chunks/.exec(log)?.[0] ?? null,
      logTail: log.trim().split('\n').slice(-4)
    },
    sessions: { before: countBefore, after, expectedDelta: 1 },
    emptySessions: { before: emptyBefore, after: emptyAfter },
    mode: 'S1',
    composerFocused: true
  })

  await page.screenshot({ path: resolve(EVIDENCE_DIR, 'task-20-new.png') })
})

test('load: click item hydrates messages into S2, closes sidebar, gear opens S4', async () => {
  await setMode('S3')
  await inputSearch('')
  await waitSearchApplied('')
  const row = page.locator('[data-testid="history-item"]').first()
  const id = (await row.getAttribute('data-session-id')) ?? ''
  const messages = await page.evaluate(
    async (sessionId) =>
      (window as unknown as TestWindow).quickask!.sessions.getMessages({ sessionId }),
    id
  )
  const expected = messages.data?.messages.length ?? 0
  expect(expected).toBeGreaterThan(0)

  await row.locator('.qa-session-main').click()
  await waitMode('S2')
  await expect(page.locator('[data-testid="sidebar"]')).toHaveCount(0)
  await expect.poll(() => page.locator('.qa-msg').count()).toBeGreaterThan(0)
  const renderedMessages = await page.locator('.qa-msg').count()
  const panelText = (await page.locator('[data-testid="panel"]').textContent()) ?? ''
  const firstContent = messages.data?.messages[0]?.content ?? ''
  expect(panelText).toContain(firstContent.slice(0, 12))
  expect(renderedMessages).toBeGreaterThanOrEqual(expected)

  await page.screenshot({ path: resolve(EVIDENCE_DIR, 'task-20-load.png') })

  await setMode('S3')
  await expect(page.locator('.qa-session-item--current')).toHaveCount(1)
  const settingsPromise = app!.waitForEvent('window')
  await page.locator('[data-testid="sidebar-settings"]').click()
  const settings = await settingsPromise
  await settings.waitForLoadState('domcontentloaded')
  await expect(settings.locator('[data-testid="settings"]')).toBeVisible()
  await expect(settings).toHaveTitle('QuickAsk 设置')
  const settingsTitle = await settings.title()

  const close = await page.evaluate(() =>
    (window as unknown as TestWindow).quickask!.window.closeSettings()
  )
  expect(close.ok).toBe(true)
  await expect.poll(() => app!.windows().length).toBe(1)

  writeJson('task-20-load.json', {
    sessionId: id,
    dbMessages: expected,
    renderedMessages,
    mode: 'S2',
    sidebarClosed: true,
    firstContentPreview: firstContent.slice(0, 40),
    currentHighlightedBeforeGear: true,
    settingsOpened: true,
    settingsTitle,
    windowsAfterClose: app!.windows().length
  })
})
