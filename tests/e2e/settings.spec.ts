import { _electron as electron, expect, test } from '@playwright/test'
import type { ElectronApplication, Page } from '@playwright/test'
import { execFileSync, spawn, type ChildProcess } from 'node:child_process'
import { createHash } from 'node:crypto'
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import type {
  BootstrapInfo,
  ProviderListResult,
  WindowState
} from '../../src/shared/channels'

interface IpcResponse<T = unknown> {
  ok: boolean
  data?: T
  error?: { code: string; message: string }
}

interface TestApi {
  app: {
    bootstrap(): Promise<IpcResponse<BootstrapInfo>>
  }
  window: {
    show(): Promise<IpcResponse<WindowState>>
    hide(): Promise<IpcResponse<WindowState>>
    getState(): Promise<IpcResponse<WindowState>>
    openSettings(options?: { onboarding?: boolean }): Promise<IpcResponse<{ open: boolean }>>
  }
  provider: {
    list(): Promise<IpcResponse<ProviderListResult>>
  }
  settings: {
    getAll(): Promise<IpcResponse<{ settings: Record<string, unknown> }>>
  }
}

type TestWindow = typeof globalThis & { quickask?: TestApi }

const EVIDENCE_DIR = resolve('.omo/evidence')
const MOCK_SCRIPT = resolve('tools/mock-sse-server.mjs')
const DISPLAY = process.env['DISPLAY'] ?? ':0'

let app: ElectronApplication | undefined
let mainPage: Page
let settingsPage: Page | undefined
let tempRoot = ''
let dataDir = ''
let mock: ChildProcess | undefined
let mockPort = 0
let mockLogPath = ''
let serverStdout = ''
let serverStderr = ''

const httpRequests: Array<{ page: 'main' | 'settings'; url: string; method: string }> = []
const evidence: Record<string, unknown> = {}
const keyringCleanup: Array<{ service: string; account: string }> = []
const checks = {
  onboardingAutoOpened: false,
  loopbackTestAndSend: false,
  keyWriteOnly: false,
  appearanceImmediate: false,
  barWidthGeometry: false,
  blurHonest: false,
  s4Semantics: false,
  persistedAfterRestart: false
}

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
    QUICKASK_DATA_DIR: join(root, 'data', 'quickask-db')
  }
}

function writeEvidence(name: string, value: unknown): void {
  mkdirSync(EVIDENCE_DIR, { recursive: true })
  writeFileSync(join(EVIDENCE_DIR, name), `${JSON.stringify(value, null, 2)}\n`)
}

function isHttp(url: string): boolean {
  return /^https?:/i.test(url)
}

function track(page: Page, role: 'main' | 'settings'): void {
  page.on('request', (request) => {
    if (isHttp(request.url())) {
      httpRequests.push({ page: role, url: request.url(), method: request.method() })
    }
  })
}

async function startMock(): Promise<void> {
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
      mockLogPath
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

async function stopMock(): Promise<void> {
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

function readMockLog(): string {
  try {
    return readFileSync(mockLogPath, 'utf8')
  } catch {
    return ''
  }
}

function postCount(): number {
  return readMockLog()
    .split('\n')
    .filter((line) => line.startsWith('POST /v1/chat/completions')).length
}

async function launch(): Promise<void> {
  app = await electron.launch({ args: ['.'], env: baseEnv(tempRoot) })
  const first = await app.firstWindow()
  await first.waitForLoadState('domcontentloaded')
  await first.waitForFunction(() => Boolean((window as unknown as TestWindow).quickask))
  mainPage =
    app
      .windows()
      .find((page) => !page.url().includes('settings=1')) ?? first
  track(mainPage, 'main')
  if (!mainPage.url().includes('settings=1')) {
    await mainPage.waitForFunction(() => Boolean((window as unknown as TestWindow).quickask))
  }
}

async function waitForSettings(expected: { onboarding?: boolean } = {}): Promise<Page> {
  await expect
    .poll(() => app!.windows().filter((page) => page.url().includes('settings=1')).length, {
      timeout: 10_000
    })
    .toBe(1)
  const page = app!.windows().find((entry) => entry.url().includes('settings=1'))!
  await page.waitForLoadState('domcontentloaded')
  await page.waitForFunction(() => Boolean((window as unknown as TestWindow).quickask))
  if (expected.onboarding === true) {
    await expect.poll(() => page.url().includes('onboarding=1')).toBe(true)
  }
  if (expected.onboarding === false) {
    await expect.poll(() => page.url().includes('onboarding=1')).toBe(false)
  }
  track(page, 'settings')
  settingsPage = page
  return page
}

async function focusWindow(page: Page): Promise<void> {
  const url = page.url()
  await app!.evaluate(({ BrowserWindow }, target) => {
    const window = BrowserWindow.getAllWindows().find(
      (entry) => entry.webContents.getURL() === target
    )
    if (window) {
      window.show()
      window.focus()
    }
  }, url)
}

async function mainState(): Promise<WindowState> {
  const result = await mainPage.evaluate(() =>
    (window as unknown as TestWindow).quickask!.window.getState()
  )
  expect(result.ok).toBe(true)
  return result.data as WindowState
}

async function bootstrap(): Promise<BootstrapInfo> {
  const result = await mainPage.evaluate(() =>
    (window as unknown as TestWindow).quickask!.app.bootstrap()
  )
  expect(result.ok).toBe(true)
  return result.data as BootstrapInfo
}

async function showMain(): Promise<void> {
  const result = await mainPage.evaluate(() =>
    (window as unknown as TestWindow).quickask!.window.show()
  )
  expect(result.ok).toBe(true)
  await mainPage.waitForFunction(
    () =>
      document.querySelector('[data-testid="app-root"]')?.getAttribute('data-ui-mode') !==
      'S0'
  )
}

async function setRange(testId: string, value: number): Promise<void> {
  const page = settingsPage!
  await page.locator(`[data-testid="${testId}"]`).evaluate((element, next) => {
    const input = element as HTMLInputElement
    const setter = Object.getOwnPropertyDescriptor(
      window.HTMLInputElement.prototype,
      'value'
    )?.set
    setter?.call(input, String(next))
    input.dispatchEvent(new Event('input', { bubbles: true }))
    input.dispatchEvent(new Event('change', { bubbles: true }))
  }, value)
}

async function barAlpha(): Promise<number> {
  const value = await mainPage.evaluate(() => {
    const bar = document.querySelector('[data-testid="bar"]') as HTMLElement | null
    if (!bar) return ''
    return getComputedStyle(bar).backgroundColor
  })
  const match = value.match(/rgba?\([^)]*,\s*([\d.]+)\)$/)
  return match ? Number(match[1]) : Number.NaN
}

function collectFiles(root: string, output: string[]): void {
  if (!existsSync(root)) return
  for (const entry of readdirSync(root)) {
    const full = join(root, entry)
    const info = statSync(full)
    if (info.isDirectory()) {
      collectFiles(full, output)
      continue
    }
    if (info.size <= 20 * 1024 * 1024) output.push(full)
  }
}

function filesContain(files: string[], needles: string[]): string[] {
  const hits: string[] = []
  for (const file of files) {
    let content: Buffer
    try {
      content = readFileSync(file)
    } catch {
      continue
    }
    for (const needle of needles) {
      if (content.includes(Buffer.from(needle, 'utf8'))) {
        hits.push(file)
        break
      }
    }
  }
  return hits
}

function dbProviderRow(profileId: string): Record<string, unknown> | null {
  const dbPath = join(dataDir, 'quickask.db')
  const db = new DatabaseSync(dbPath)
  try {
    const row = db
      .prepare('SELECT key_ref, header_names_json FROM provider_profiles WHERE id = ?')
      .get(profileId)
    return (row as Record<string, unknown> | undefined) ?? null
  } finally {
    db.close()
  }
}

async function keyringValue(account: string): Promise<string | null> {
  const { Entry } = await import('@napi-rs/keyring')
  try {
    const entry = new Entry('quickask', account, { linux: { store: 'secret-service' } })
    return entry.getPassword()
  } catch {
    return null
  }
}

async function keyringDelete(account: string): Promise<void> {
  try {
    const { Entry } = await import('@napi-rs/keyring')
    const entry = new Entry('quickask', account, { linux: { store: 'secret-service' } })
    entry.deletePassword()
  } catch {
    // best effort
  }
}

test.describe.configure({ mode: 'serial' })

test.beforeAll(async () => {
  tempRoot = mkdtempSync(join(tmpdir(), 'quickask-task22-'))
  for (const dir of ['config', 'data', 'state']) {
    mkdirSync(join(tempRoot, dir), { recursive: true })
  }
  dataDir = join(tempRoot, 'data', 'quickask-db')
  mkdirSync(EVIDENCE_DIR, { recursive: true })
  for (const name of [
    'task-22-onboarding.json',
    'task-22-onboarding.png',
    'task-22-model.json',
    'task-22-key.json',
    'task-22-appearance.json',
    'task-22-barwidth.json',
    'task-22-persistence.json',
    'task-22-s4.json',
    'task-22-settings-appearance.png',
    'task-22-settings-model.png',
    'task-22-summary.json'
  ]) {
    rmSync(join(EVIDENCE_DIR, name), { force: true })
  }
  await startMock()
  await launch()
})

test.afterAll(async () => {
  for (const entry of keyringCleanup) await keyringDelete(entry.account)
  await app?.close()
  await stopMock()
  const allPassed = Object.values(checks).every(Boolean)
  const summary = {
    task: 22,
    verdict: allPassed ? 'PASS' : 'FAIL',
    generatedAt: new Date().toISOString(),
    checks,
    evidence: {
      onboarding: 'task-22-onboarding.json',
      model: 'task-22-model.json',
      key: 'task-22-key.json',
      appearance: 'task-22-appearance.json',
      barwidth: 'task-22-barwidth.json',
      persistence: 'task-22-persistence.json',
      s4: 'task-22-s4.json',
      screenshots: [
        'task-22-onboarding.png',
        'task-22-settings-appearance.png'
      ]
    },
    mock: { stdout: serverStdout.slice(0, 2000), stderr: serverStderr.slice(0, 2000) },
    evidenceMap: evidence
  }
  writeEvidence('task-22-summary.json', summary)
  rmSync(tempRoot, { recursive: true, force: true })
})

test('empty data dir auto-opens S4 onboarding, main hidden, zero requests', async () => {
  const settings = await waitForSettings({ onboarding: true })
  const state = await mainState()
  expect(state.mode).toBe('S0')
  expect(state.visible).toBe(false)

  const url = settings.url()
  expect(url).toContain('settings=1')
  expect(url).toContain('onboarding=1')
  await expect(settings.locator('[data-testid="onboarding-wizard"]')).toBeVisible()
  await expect(settings.locator('[data-testid="settings-nav"]')).toBeVisible()

  // Give any accidental startup request a moment to show up.
  await delay(600)
  expect(httpRequests).toEqual([])
  expect(postCount()).toBe(0)

  await showMain()
  const composer = mainPage.locator('[data-testid="composer"]')
  await expect(composer).toBeDisabled()
  await expect(composer).toHaveAttribute('placeholder', '请先配置模型')
  await expect(mainPage.locator('[data-testid="btn-send"]')).toBeDisabled()
  const boot = await bootstrap()
  expect(boot.onboarding.required).toBe(true)
  expect(boot.onboarding.reason).toBe('no_profile')

  await settings.screenshot({ path: join(EVIDENCE_DIR, 'task-22-onboarding.png') })
  const payload = {
    settingsUrl: url,
    mainMode: state.mode,
    composerDisabled: await composer.isDisabled(),
    placeholder: await composer.getAttribute('placeholder'),
    onboarding: boot.onboarding,
    requestsBeforeTest: httpRequests,
    mockPostsBeforeTest: postCount()
  }
  evidence.onboarding = payload
  writeEvidence('task-22-onboarding.json', payload)
  checks.onboardingAutoOpened = true
})

test('loopback base_url + model with empty key: test connection succeeds, composer enables, send works', async () => {
  const settings = settingsPage!
  await settings.locator('[data-testid="onboarding-base-url"]').fill(
    `http://127.0.0.1:${mockPort}/v1`
  )
  await settings.locator('[data-testid="onboarding-next"]').click()
  await settings.locator('[data-testid="model-api-key"]').waitFor({ state: 'visible' })
  await settings.locator('[data-testid="onboarding-next"]').click()
  await settings.locator('[data-testid="model-model"]').fill('mock')
  expect(postCount()).toBe(0)
  await settings.locator('[data-testid="onboarding-test"]').click()

  await expect(settings.locator('[data-testid="onboarding-done"]')).toBeVisible({
    timeout: 15_000
  })
  await expect(settings.locator('[data-testid="model-test-result"]')).toContainText(
    '连接成功'
  )
  await settings.locator('[data-testid="model-test-result"]').scrollIntoViewIfNeeded()
  await settings.screenshot({ path: join(EVIDENCE_DIR, 'task-22-settings-model.png') })

  expect(postCount()).toBe(1)

  await expect
    .poll(async () => {
      const state = await mainState()
      return state.visible && state.mode !== 'S0'
    })
    .toBe(true)
  const composer = mainPage.locator('[data-testid="composer"]')
  await expect(composer).toBeEnabled({ timeout: 10_000 })
  await expect(composer).toHaveAttribute('placeholder', '问点什么…')

  const boot = await bootstrap()
  expect(boot.onboarding).toEqual({ required: false, reason: null })
  const allSettings = await mainPage.evaluate(() =>
    (window as unknown as TestWindow).quickask!.settings.getAll()
  )
  expect(allSettings.ok).toBe(true)
  expect(allSettings.data?.settings['onboardingComplete']).toBe(true)

  const list = await mainPage.evaluate(() =>
    (window as unknown as TestWindow).quickask!.provider.list()
  )
  expect(list.ok).toBe(true)
  const profiles = list.data?.profiles ?? []
  expect(profiles).toHaveLength(1)
  expect(profiles[0]).toMatchObject({
    name: '127.0.0.1',
    baseUrl: `http://127.0.0.1:${mockPort}/v1`,
    model: 'mock',
    isDefault: true,
    hasApiKey: false
  })

  await focusWindow(mainPage)
  await composer.fill('hello from onboarding')
  await composer.press('Enter')
  await expect.poll(() => postCount(), { timeout: 10_000 }).toBe(2)

  const payload = {
    baseUrl: `http://127.0.0.1:${mockPort}/v1`,
    model: 'mock',
    key: 'empty (loopback)',
    testLatencyText: await settings.locator('[data-testid="model-test-result"]').innerText(),
    postsBeforeTest: 0,
    postsAfterTest: 1,
    postsAfterSend: postCount(),
    onboarding: boot.onboarding,
    onboardingComplete: true,
    composerEnabled: !(await composer.isDisabled()),
    placeholder: await composer.getAttribute('placeholder'),
    profile: profiles[0],
    httpRequests: httpRequests.map((entry) => ({ method: entry.method, url: entry.url, page: entry.page }))
  }
  evidence.model = payload
  writeEvidence('task-22-model.json', payload)
  checks.loopbackTestAndSend = true
})

test('api key and secret header are write-only and never hit DB/logs/renderer', async () => {
  if (settingsPage && !settingsPage.isClosed()) {
    await settingsPage.locator('[data-testid="settings-close"]').click()
  }
  await expect.poll(() => app!.windows().filter((page) => page.url().includes('settings=1')).length).toBe(0)

  await mainPage.evaluate(() => (window as unknown as TestWindow).quickask!.window.openSettings())
  const settings = await waitForSettings({ onboarding: false })
  await settings.locator('[data-testid="model-api-key"]').waitFor({ state: 'visible' })

  const fakeKey = `sk-task22-${createHash('sha256').update(String(Date.now())).digest('hex').slice(0, 20)}`
  const fakeHeader = `header-task22-${createHash('sha256').update(`${Date.now()}h`).digest('hex').slice(0, 20)}`

  await settings.locator('[data-testid="model-api-key"]').fill(fakeKey)
  await settings.locator('[data-testid="model-header-add"]').click()
  await settings.locator('[data-testid="model-header-name-0"]').fill('Authorization')
  await settings.locator('[data-testid="model-header-value-0"]').fill(fakeHeader)
  await settings.locator('[data-testid="model-header-secret-0"]').check()
  await settings.locator('[data-testid="model-name"]').click()
  // Blurring the api_key with a non-empty value forces a non-silent save.
  await settings.locator('[data-testid="model-api-key"]').focus()
  await settings.locator('[data-testid="model-name"]').click()

  await expect(settings.locator('[data-testid="model-key-state"]')).toContainText(
    '已配置（只写不读）',
    { timeout: 10_000 }
  )
  await expect
    .poll(async () => {
      const list = await mainPage.evaluate(() =>
        (window as unknown as TestWindow).quickask!.provider.list()
      )
      const profile = list.data?.profiles[0]
      return profile?.headers.some((header) => header.name === 'Authorization' && header.hasValue)
    })
    .toBe(true)

  const list = await mainPage.evaluate(() =>
    (window as unknown as TestWindow).quickask!.provider.list()
  )
  expect(list.ok).toBe(true)
  const profiles = list.data?.profiles ?? []
  const profile = profiles[0]!
  expect(profile.hasApiKey).toBe(true)
  expect(profile.headers).toContainEqual({
    name: 'Authorization',
    secret: true,
    hasValue: true
  })
  const serializedView = JSON.stringify(list)
  expect(serializedView.includes(fakeKey)).toBe(false)
  expect(serializedView.includes(fakeHeader)).toBe(false)

  const rendererText = `${await settings.evaluate(() => document.body.innerText)}\n${await mainPage.evaluate(() => document.body.innerText)}`
  expect(rendererText.includes(fakeKey)).toBe(false)
  expect(rendererText.includes(fakeHeader)).toBe(false)

  const dbRow = dbProviderRow(profile.id)
  expect(String(dbRow?.key_ref)).toBe(`provider:${profile.id}:api_key`)
  expect(String(dbRow?.header_names_json)).toContain('Authorization')
  expect(String(dbRow?.header_names_json)).not.toContain(fakeHeader)

  const dataFiles: string[] = []
  collectFiles(dataDir, dataFiles)
  const dataHits = filesContain(dataFiles, [fakeKey, fakeHeader])
  expect(dataHits).toEqual([])

  const logFiles: string[] = []
  collectFiles(join(tempRoot, 'state'), logFiles)
  const logHits = filesContain(logFiles, [fakeKey, fakeHeader])
  expect(logHits).toEqual([])

  const storedKey = await keyringValue(`provider:${profile.id}:api_key`)
  const storedHeaders = await keyringValue(`provider:${profile.id}:headers`)
  keyringCleanup.push(
    { service: 'quickask', account: `provider:${profile.id}:api_key` },
    { service: 'quickask', account: `provider:${profile.id}:headers` }
  )
  expect(storedKey).toBe(fakeKey)
  expect(storedHeaders ? JSON.parse(storedHeaders) : null).toMatchObject({
    Authorization: fakeHeader
  })

  const payload = {
    profileId: profile.id,
    providerView: {
      hasApiKey: profile.hasApiKey,
      headers: profile.headers,
      containsKey: serializedView.includes(fakeKey),
      containsHeaderValue: serializedView.includes(fakeHeader)
    },
    db: {
      keyRef: dbRow?.key_ref,
      headerNamesJson: dbRow?.header_names_json,
      plaintextHits: dataHits,
      filesScanned: dataFiles.length
    },
    renderer: { containsKey: rendererText.includes(fakeKey), containsHeaderValue: rendererText.includes(fakeHeader) },
    logs: { plaintextHits: logHits, filesScanned: logFiles.length },
    keyring: {
      apiKeyFingerprint: storedKey
        ? createHash('sha256').update(storedKey).digest('hex')
        : null,
      apiKeyMatches: storedKey === fakeKey,
      headersFingerprint: storedHeaders
        ? createHash('sha256').update(storedHeaders).digest('hex')
        : null,
      headersMatch: storedHeaders ? storedHeaders.includes(fakeHeader) : false
    }
  }
  evidence.key = payload
  writeEvidence('task-22-key.json', payload)
  checks.keyWriteOnly = true
})

test('appearance applies immediately: theme/primary/opacity/bar width, honest blur status', async () => {
  const settings = settingsPage!
  await settings.locator('[data-testid="settings-tab-appearance"]').click()
  await expect(settings.locator('[data-testid="appearance-panel"]')).toBeVisible()

  const blurText = await settings.locator('[data-testid="blur-status"]').innerText()
  expect(blurText).toContain('模糊')
  // The e2e run redirects XDG_CONFIG_HOME, so KWin may be unreadable; both
  // "effect disabled" and "cannot detect" are honest unavailable states.
  expect(blurText).toMatch(/未开启|无法检测/)
  expect(blurText).not.toContain('KWin 模糊效果可用')
  await expect(settings.locator('[data-testid="blur-toggle"]')).toBeDisabled()

  const backdropFilters = await mainPage.evaluate(() => {
    const values: string[] = []
    for (const element of Array.from(document.querySelectorAll('*'))) {
      const style = getComputedStyle(element)
      const value = style.backdropFilter || (style as unknown as { webkitBackdropFilter?: string }).webkitBackdropFilter
      if (value && value !== 'none') values.push(value)
    }
    return values
  })
  expect(backdropFilters).toEqual([])

  const themeStates: Record<string, string> = {}
  for (const theme of ['dark', 'light', 'system'] as const) {
    await settings.locator(`[data-testid="appearance-theme-${theme}"]`).check()
    await expect
      .poll(() =>
        mainPage.evaluate(() => document.documentElement.dataset['themeMode'] ?? '')
      )
      .toBe(theme)
    const resolved = await mainPage.evaluate(
      () => document.documentElement.dataset['theme'] ?? ''
    )
    expect(['dark', 'light']).toContain(resolved)
    themeStates[theme] = resolved
  }
  await settings.locator('[data-testid="appearance-theme-dark"]').check()

  await settings.locator('[data-testid="primary-nord"]').click()
  await expect
    .poll(() => mainPage.evaluate(() => document.documentElement.dataset['primary'] ?? ''))
    .toBe('nord')
  const primary = await mainPage.evaluate(() =>
    getComputedStyle(document.documentElement).getPropertyValue('--primary').trim()
  )
  expect(primary).toBe('#88c0d0')

  await setRange('opacity-range', 40)
  await expect.poll(() => barAlpha()).toBeCloseTo(0.4, 2)
  const alpha40 = await barAlpha()
  await setRange('opacity-range', 72)
  await expect.poll(() => barAlpha()).toBeCloseTo(0.72, 2)
  const alpha72 = await barAlpha()

  await settings.locator('[data-testid="appearance-theme-light"]').check()
  await settings.locator('[data-testid="primary-gruvbox"]').click()
  await settings.locator('[data-testid="appearance-theme-dark"]').check()
  await settings.locator('[data-testid="primary-everforest"]').click()
  await settings.screenshot({ path: join(EVIDENCE_DIR, 'task-22-settings-appearance.png') })

  const payload = {
    themes: themeStates,
    primary: { id: 'nord', cssVariable: primary },
    opacity: { alpha40, alpha72 },
    blur: {
      statusText: blurText,
      toggleDisabled: await settings.locator('[data-testid="blur-toggle"]').isDisabled(),
      backdropFilterMatches: backdropFilters
    }
  }
  evidence.appearance = payload
  writeEvidence('task-22-appearance.json', payload)
  checks.appearanceImmediate = true
  checks.blurHonest = true
})

test('bar width 560/680/900 updates window + layout, composer min 240, buttons unchanged', async () => {
  const settings = settingsPage!
  await settings.locator('[data-testid="settings-tab-appearance"]').click()
  await showMain()

  const widths = [560, 680, 900]
  const observations: Array<Record<string, unknown>> = []
  for (const width of widths) {
    await setRange('barwidth-range', width)
    await expect
      .poll(async () => {
        const state = await mainState()
        return state.layout?.barRect.width ?? 0
      })
      .toBe(width)
    await mainPage.waitForFunction(
      (expected) => {
        const bar = document.querySelector('[data-testid="bar"]') as HTMLElement | null
        if (!bar) return false
        if (Math.abs(window.innerWidth - (expected + 80)) > 1) return false
        return Math.abs(bar.getBoundingClientRect().width - expected) <= 1
      },
      width
    )
    const state = await mainState()
    const metrics = await mainPage.evaluate(() => {
      const composer = document.querySelector('[data-testid="composer"]') as HTMLElement | null
      const bar = document.querySelector('[data-testid="bar"]') as HTMLElement | null
      const send = document.querySelector('[data-testid="btn-send"]') as HTMLElement | null
      const history = document.querySelector('[data-testid="btn-history"]') as HTMLElement | null
      return {
        composerMinWidth: composer ? getComputedStyle(composer).minWidth : '',
        barWidth: bar?.getBoundingClientRect().width ?? 0,
        sendSize: send?.getBoundingClientRect().width ?? 0,
        historySize: history?.getBoundingClientRect().width ?? 0
      }
    })
    expect(metrics.composerMinWidth).toBe('240px')
    expect(metrics.sendSize).toBeCloseTo(36, 0)
    expect(metrics.historySize).toBeCloseTo(32, 0)
    expect(metrics.barWidth).toBeCloseTo(width, 0)
    observations.push({
      width,
      windowWidth: state.bounds.width,
      barRectWidth: state.layout?.barRect.width,
      windowInnerWidth: await mainPage.evaluate(() => window.innerWidth),
      barLeft: state.layout?.anchor.x,
      ...metrics
    })
  }

  const payload = { widths: observations, gutter: 80 }
  evidence.barWidth = payload
  writeEvidence('task-22-barwidth.json', payload)
  checks.barWidthGeometry = true
})

test('S4 is 720x560 with nav, Esc closes, Alt+F4 closes only settings', async () => {
  const settings = settingsPage!
  await focusWindow(settings)
  const size = await app!.evaluate(({ BrowserWindow }) => {
    const window = BrowserWindow.getAllWindows().find((entry) =>
      entry.webContents.getURL().includes('settings=1')
    )
    return window ? window.getContentSize() : [0, 0]
  })
  expect(size).toEqual([720, 560])

  const navText = await settings.locator('[data-testid="settings-nav"]').innerText()
  for (const label of ['模型', '外观', '快捷键', '行为', '数据', '关于']) {
    expect(navText).toContain(label)
  }
  expect(navText).not.toContain('即将支持')
  await expect(settings.locator('[data-testid="settings-close"]')).toBeVisible()

  await focusWindow(settings)
  try {
    // Closing on keydown may tear down the target before Playwright finishes
    // the keyup half of press(), which is expected and not a failure.
    await settings.keyboard.down('Escape')
  } catch {
    // window already closed
  }
  await expect
    .poll(() => app!.windows().filter((page) => page.url().includes('settings=1')).length, {
      timeout: 10_000
    })
    .toBe(0)
  expect(app!.windows().some((page) => !page.url().includes('settings=1'))).toBe(true)
  const afterEsc = await mainState()
  expect(afterEsc.mode).not.toBe('S4')

  await mainPage.evaluate(() => (window as unknown as TestWindow).quickask!.window.openSettings())
  const reopened = await waitForSettings({ onboarding: false })
  await focusWindow(reopened)
  const wid = await app!.evaluate(({ BrowserWindow }) => {
    const window = BrowserWindow.getAllWindows().find((entry) =>
      entry.webContents.getURL().includes('settings=1')
    )
    if (!window) return '0x0'
    const handle = window.getNativeWindowHandle()
    const value =
      handle.length >= 8
        ? Number(handle.readBigUInt64LE(0) & 0xffffffffn)
        : handle.readUInt32LE(0)
    return `0x${value.toString(16)}`
  })
  expect(wid).not.toBe('0x0')
  try {
    execFileSync('xdotool', ['windowactivate', '--sync', wid], {
      env: { ...process.env, DISPLAY },
      timeout: 5000
    })
  } catch {
    // Electron focusWindow() above is the fallback.
  }
  try {
    execFileSync('xdotool', ['key', '--clearmodifiers', 'alt+F4'], {
      env: { ...process.env, DISPLAY },
      timeout: 5000
    })
  } catch {
    // The assertion below reports whether the window closed.
  }
  await expect
    .poll(() => app!.windows().filter((page) => page.url().includes('settings=1')).length, {
      timeout: 10_000
    })
    .toBe(0)
  // The app (main window) must still be alive.
  const alive = await mainPage.evaluate(() =>
    (window as unknown as TestWindow).quickask!.window.getState()
  )
  expect(alive.ok).toBe(true)

  const payload = {
    contentSize: size,
    navText,
    escClosed: true,
    altF4ClosedOnlySettings: true,
    mainAliveAfterAltF4: alive.ok,
    settingsWid: wid
  }
  evidence.s4 = payload
  writeEvidence('task-22-s4.json', payload)
  checks.s4Semantics = true
})

test('appearance persists after restart and bar width is restored before first layout', async () => {
  let settings =
    settingsPage && !settingsPage.isClosed() ? settingsPage : undefined
  if (!settings) {
    await mainPage.evaluate(() => (window as unknown as TestWindow).quickask!.window.openSettings())
    settings = await waitForSettings({ onboarding: false })
  }
  await settings.locator('[data-testid="settings-tab-appearance"]').click()
  await settings.locator('[data-testid="appearance-theme-light"]').check()
  await settings.locator('[data-testid="primary-gruvbox"]').click()
  await setRange('opacity-range', 40)
  await setRange('barwidth-range', 900)
  await expect
    .poll(async () => (await bootstrap()).appearance)
    .toMatchObject({
      theme: 'light',
      primary: 'gruvbox',
      opacity: 40,
      barWidth: 900
    })

  await app!.close()
  app = undefined
  await delay(500)

  await launch()
  const boot = await bootstrap()
  expect(boot.appearance).toMatchObject({
    theme: 'light',
    primary: 'gruvbox',
    opacity: 40,
    barWidth: 900
  })
  expect(boot.onboarding.required).toBe(false)

  await showMain()
  await expect
    .poll(() => mainPage.evaluate(() => document.documentElement.dataset['theme'] ?? ''))
    .toBe('light')
  expect(
    await mainPage.evaluate(() => document.documentElement.dataset['primary'] ?? '')
  ).toBe('gruvbox')
  await expect.poll(() => barAlpha()).toBeCloseTo(0.4, 2)
  await expect
    .poll(async () => (await mainState()).layout?.barRect.width ?? 0)
    .toBe(900)
  expect((await mainState()).bounds.width).toBe(980)

  await mainPage.evaluate(() => (window as unknown as TestWindow).quickask!.window.openSettings())
  const reopened = await waitForSettings({ onboarding: false })
  await reopened.locator('[data-testid="settings-tab-appearance"]').click()
  await expect(reopened.locator('[data-testid="opacity-range"]')).toHaveValue('40')
  await expect(reopened.locator('[data-testid="barwidth-range"]')).toHaveValue('900')
  await expect(reopened.locator('[data-testid="appearance-theme-light"]')).toBeChecked()
  await expect(reopened.locator('[data-testid="primary-gruvbox"]')).toHaveAttribute(
    'aria-pressed',
    'true'
  )

  const payload = {
    bootstrapAppearance: boot.appearance,
    resolvedTheme: await mainPage.evaluate(
      () => document.documentElement.dataset['theme'] ?? ''
    ),
    primary: await mainPage.evaluate(
      () => document.documentElement.dataset['primary'] ?? ''
    ),
    alpha: await barAlpha(),
    barRectWidth: (await mainState()).layout?.barRect.width,
    windowWidth: (await mainState()).bounds.width,
    settingsValues: {
      opacity: await reopened.locator('[data-testid="opacity-range"]').inputValue(),
      barWidth: await reopened.locator('[data-testid="barwidth-range"]').inputValue(),
      theme: 'light',
      primary: 'gruvbox'
    }
  }
  evidence.persistence = payload
  writeEvidence('task-22-persistence.json', payload)
  checks.persistedAfterRestart = true
})
