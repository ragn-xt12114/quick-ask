/**
 * Task 33b — model profiles management + quick switch (F-04.4).
 *
 * Covers: create two profiles, set default, select, restart persistence,
 * quick-switch menu updates panel-model and the next request body, an active
 * stream keeps its original model while a new selection applies afterwards,
 * and deleting the selected profile falls back to default/first without
 * touching the current session.
 */
import { _electron as electron, expect, test } from '@playwright/test'
import type { ElectronApplication, Page } from '@playwright/test'
import { spawn, type ChildProcess } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

interface IpcResponse<T = unknown> {
  ok: boolean
  data?: T
  error?: { code: string; message: string }
}

interface ProfileView {
  id: string
  name: string
  model: string
  isDefault: boolean
}

interface TestApi {
  app: {
    bootstrap(): Promise<IpcResponse<{ onboarding: { required: boolean } }>>
  }
  window: {
    show(): Promise<IpcResponse>
    getState(): Promise<IpcResponse<{ visible: boolean; mode: string }>>
    setMode(mode: string): Promise<IpcResponse>
    openSettings(): Promise<IpcResponse>
    closeSettings(): Promise<IpcResponse>
  }
  settings: {
    getAll(): Promise<IpcResponse<{ settings: Record<string, unknown> }>>
  }
  provider: {
    list(): Promise<IpcResponse<{ profiles: ProfileView[] }>>
  }
  sessions: {
    list(request?: { limit?: number }): Promise<IpcResponse<{ sessions: Array<{ id: string }> }>>
    state(): Promise<IpcResponse<{ currentSessionId: string | null }>>
  }
  chat: {
    send(request: { sessionId: string | null; text: string }): Promise<IpcResponse>
    getActive(): Promise<IpcResponse<{ active: { requestId: string; sessionId: string } | null }>>
  }
}

type TestWindow = typeof globalThis & { quickask?: TestApi }

const DISPLAY = process.env['DISPLAY'] ?? ':0'
const MOCK_SCRIPT = resolve('tools/mock-sse-server.mjs')
const EVIDENCE_DIR = resolve('.omo/evidence/m2/proxy')
const PROFILE_ITEM = '[data-testid^="model-profile-"]:not([data-testid="model-profile-list"])'

let app: ElectronApplication | undefined
let mainPage: Page
let tempRoot = ''
let mock: ChildProcess | undefined
let mockBaseUrl = ''
let bodyLogPath = ''
const pageErrors: string[] = []
const checks = {
  createTwoSetDefaultSelect: false,
  restartPersistsSelection: false,
  quickSwitchUpdatesPanelAndBody: false,
  activeStreamKeepsModel: false,
  deleteSelectedFallsBack: false,
  noEmptySessionImpact: false
}
const evidence: Record<string, unknown> = {}

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

function writeEvidence(name: string, value: unknown): void {
  mkdirSync(EVIDENCE_DIR, { recursive: true })
  writeFileSync(join(EVIDENCE_DIR, name), `${JSON.stringify(value, null, 2)}\n`)
}

async function startMock(): Promise<void> {
  bodyLogPath = join(tempRoot, 'bodies.log')
  mock = spawn(
    process.execPath,
    [MOCK_SCRIPT, '--port', '0', '--mode', 'slow', '--chunks', '24', '--delay', '40', '--body-log', bodyLogPath],
    { cwd: process.cwd(), stdio: ['ignore', 'pipe', 'pipe'] }
  )
  await new Promise<void>((resolveStarted, reject) => {
    let stdout = ''
    let stderr = ''
    const timer = setTimeout(() => reject(new Error(`mock did not start: ${stderr}`)), 10_000)
    mock!.stdout?.setEncoding('utf8')
    mock!.stderr?.setEncoding('utf8')
    mock!.stdout?.on('data', (chunk: string) => {
      stdout += chunk
      const match = /listening on (http:\/\/[^:\s]+:\d+)/.exec(stdout)
      if (match) {
        clearTimeout(timer)
        mockBaseUrl = match[1]!
        resolveStarted()
      }
    })
    mock!.stderr?.on('data', (chunk: string) => {
      stderr += chunk
    })
    mock!.once('exit', (code) => {
      clearTimeout(timer)
      reject(new Error(`mock exited early (${code}): ${stderr}`))
    })
  })
}

function readBodies(): Array<{ model: string }> {
  try {
    return readFileSync(bodyLogPath, 'utf8')
      .split('\n')
      .filter((line) => line.trim().length > 0)
      .map((line) => JSON.parse(line) as { model: string })
  } catch {
    return []
  }
}

async function launch(): Promise<void> {
  app = await electron.launch({ args: ['.'], env: baseEnv(tempRoot) })
  const first = await app.firstWindow()
  first.on('pageerror', (error) => pageErrors.push(error.message))
  await first.waitForLoadState('domcontentloaded')
  await first.waitForFunction(() => Boolean((window as unknown as TestWindow).quickask))
  mainPage = app.windows().find((page) => !page.url().includes('settings=1')) ?? first
  mainPage.on('pageerror', (error) => pageErrors.push(error.message))
  const shown = await mainPage.evaluate(() =>
    (window as unknown as TestWindow).quickask!.window.show()
  )
  expect(shown.ok).toBe(true)
  await mainPage.evaluate(() =>
    (window as unknown as TestWindow).quickask!.window.setMode('S2')
  )
}

async function closeApp(): Promise<void> {
  if (!app) return
  const current = app
  app = undefined
  try {
    await Promise.race([current.close(), delay(5000)])
  } catch {
    const proc = current.process()
    if (proc.exitCode === null) proc.kill('SIGTERM')
  }
  await delay(400)
}

function settingsWindows(): Page[] {
  if (!app) return []
  return app.windows().filter((page) => page.url().includes('settings=1'))
}

async function openSettings(): Promise<Page> {
  const result = await mainPage.evaluate(() =>
    (window as unknown as TestWindow).quickask!.window.openSettings()
  )
  expect(result.ok).toBe(true)
  await expect.poll(() => settingsWindows().length, { timeout: 10_000 }).toBe(1)
  const page = settingsWindows()[0]!
  await page.waitForLoadState('domcontentloaded')
  await page.waitForFunction(() => Boolean((window as unknown as TestWindow).quickask))
  page.on('pageerror', (error) => pageErrors.push(error.message))
  await expect(page.locator('[data-testid="model-panel"]')).toBeVisible()
  return page
}

async function closeSettings(): Promise<void> {
  if (settingsWindows().length === 0) return
  await mainPage.evaluate(() =>
    (window as unknown as TestWindow).quickask!.window.closeSettings()
  )
  await expect.poll(() => settingsWindows().length, { timeout: 10_000 }).toBe(0)
}

async function allSettings(): Promise<Record<string, unknown>> {
  const result = await mainPage.evaluate(() =>
    (window as unknown as TestWindow).quickask!.settings.getAll()
  )
  expect(result.ok).toBe(true)
  return result.data?.settings ?? {}
}

async function modelProfileId(): Promise<string | null> {
  const settings = await allSettings()
  const model = settings['model']
  if (typeof model !== 'object' || model === null) return null
  const profileId = (model as { profileId?: unknown }).profileId
  return typeof profileId === 'string' ? profileId : null
}

async function profiles(): Promise<ProfileView[]> {
  const result = await mainPage.evaluate(() =>
    (window as unknown as TestWindow).quickask!.provider.list()
  )
  expect(result.ok).toBe(true)
  return result.data?.profiles ?? []
}

async function fillProfile(page: Page, name: string, model: string): Promise<void> {
  await page.locator('[data-testid="model-name"]').fill(name)
  await page.locator('[data-testid="model-base-url"]').fill(mockBaseUrl)
  await page.locator('[data-testid="model-model"]').fill(model)
  await page.locator('[data-testid="model-model"]').press('Tab')
  await expect
    .poll(async () => (await profiles()).some((profile) => profile.name === name), {
      timeout: 10_000
    })
    .toBe(true)
}

async function selectProfile(page: Page, id: string): Promise<void> {
  await page.locator(`[data-testid="model-profile-${id}"]`).click()
  await expect
    .poll(async () => (await modelProfileId()) === id, { timeout: 10_000 })
    .toBe(true)
}

async function quickSwitchTo(id: string): Promise<void> {
  await mainPage.locator('[data-testid="model-switch"]').click()
  await mainPage.locator(`[data-testid="model-option-${id}"]`).click()
  await expect
    .poll(async () => (await modelProfileId()) === id, { timeout: 10_000 })
    .toBe(true)
}

async function waitForActive(timeoutMs = 10_000): Promise<string> {
  let requestId = ''
  await expect
    .poll(
      async () => {
        const result = await mainPage.evaluate(() =>
          (window as unknown as TestWindow).quickask!.chat.getActive()
        )
        if (!result.ok || !result.data) return ''
        requestId = result.data.active?.requestId ?? ''
        return requestId
      },
      { timeout: timeoutMs }
    )
    .not.toBe('')
  return requestId
}

async function waitForIdle(timeoutMs = 20_000): Promise<void> {
  await expect
    .poll(
      async () => {
        const result = await mainPage.evaluate(() =>
          (window as unknown as TestWindow).quickask!.chat.getActive()
        )
        return result.ok && result.data && result.data.active === null
      },
      { timeout: timeoutMs }
    )
    .toBe(true)
}

test.describe.configure({ mode: 'serial' })

test.beforeAll(async () => {
  tempRoot = mkdtempSync(join(tmpdir(), 'quickask-task33b-'))
  for (const dir of ['config', 'data', 'state']) {
    mkdirSync(join(tempRoot, dir), { recursive: true })
  }
  mkdirSync(EVIDENCE_DIR, { recursive: true })
  await startMock()
  await launch()
})

test.afterAll(async () => {
  await closeSettings()
  await closeApp()
  if (mock && mock.exitCode === null) {
    const closed = new Promise<void>((resolveClosed) => mock!.once('close', () => resolveClosed()))
    mock.kill('SIGTERM')
    await Promise.race([closed, delay(2000)])
    if (mock.exitCode === null) mock.kill('SIGKILL')
  }
  const summary = {
    task: '33b',
    title: 'model profiles management + quick switch (F-04.4)',
    generatedAt: new Date().toISOString(),
    verdict: Object.values(checks).every(Boolean) ? 'PASS' : 'FAIL',
    checks,
    count: { profiles: (evidence['finalProfiles'] as unknown[] | undefined)?.length ?? null },
    display: DISPLAY,
    pageErrors,
    evidence
  }
  writeEvidence('task-33b-summary.json', summary)
  try {
    rmSync(tempRoot, { recursive: true, force: true })
  } catch {
    // best effort
  }
})

test('creates two profiles, sets default, selects, and persists selection across restart', async () => {
  const page = await openSettings()
  const initial = await page.locator(PROFILE_ITEM).count()
  if (initial === 0) {
    await page.locator('[data-testid="model-new"]').click()
  }
  await fillProfile(page, 'Alpha', 'model-a')
  await expect(page.locator(PROFILE_ITEM)).toHaveCount(initial + 1)

  await page.locator('[data-testid="model-new"]').click()
  await expect(page.locator('[data-testid="model-name"]')).toHaveValue('新配置')
  await fillProfile(page, 'Beta', 'model-b')
  await expect(page.locator(PROFILE_ITEM)).toHaveCount(initial + 2)

  const list = await profiles()
  const alpha = list.find((profile) => profile.name === 'Alpha')!
  const beta = list.find((profile) => profile.name === 'Beta')!
  expect(alpha).toBeTruthy()
  expect(beta).toBeTruthy()

  await selectProfile(page, alpha.id)
  await page.locator('[data-testid="model-default"]').click()
  await expect(page.locator(`[data-testid="model-default-marker-${alpha.id}"]`)).toBeVisible()
  await expect
    .poll(async () => (await profiles()).find((profile) => profile.id === alpha.id)?.isDefault)
    .toBe(true)

  await selectProfile(page, beta.id)
  await expect(page.locator(`[data-testid="model-profile-${beta.id}"]`)).toHaveAttribute(
    'aria-current',
    'true'
  )

  evidence['step1'] = { alpha: alpha.id, beta: beta.id, selected: await modelProfileId() }
  checks.createTwoSetDefaultSelect = (await modelProfileId()) === beta.id

  await closeSettings()
  await closeApp()
  await launch()
  const reopened = await openSettings()
  await expect(reopened.locator(`[data-testid="model-profile-${beta.id}"]`)).toHaveAttribute(
    'aria-current',
    'true'
  )
  await expect(reopened.locator('[data-testid="model-name"]')).toHaveValue('Beta')
  expect(await modelProfileId()).toBe(beta.id)
  checks.restartPersistsSelection = true
})

test('quick switch menu updates panel-model and the next mock request body', async () => {
  const list = await profiles()
  const alpha = list.find((profile) => profile.name === 'Alpha')!
  const beta = list.find((profile) => profile.name === 'Beta')!
  await mainPage.evaluate(() =>
    (window as unknown as TestWindow).quickask!.window.setMode('S2')
  )
  await expect(mainPage.locator('[data-testid="panel-model"]')).toHaveText(beta.model, {
    timeout: 8000
  })

  await quickSwitchTo(alpha.id)
  await expect(mainPage.locator('[data-testid="panel-model"]')).toHaveText(alpha.model, {
    timeout: 8000
  })

  const before = readBodies().length
  const sent = await mainPage.evaluate(() =>
    (window as unknown as TestWindow).quickask!.chat.send({
      sessionId: null,
      text: 'quick switch request'
    })
  )
  expect(sent.ok).toBe(true)
  await waitForIdle()
  const bodies = readBodies()
  expect(bodies.length).toBeGreaterThan(before)
  expect(bodies.at(-1)?.model).toBe(alpha.model)

  evidence['step2'] = {
    panelModel: await mainPage.locator('[data-testid="panel-model"]').textContent(),
    requestModel: bodies.at(-1)?.model
  }
  checks.quickSwitchUpdatesPanelAndBody =
    bodies.at(-1)?.model === alpha.model && (await modelProfileId()) === alpha.id
})

test('active stream keeps its model after switching; next send uses the new one', async () => {
  const list = await profiles()
  const alpha = list.find((profile) => profile.name === 'Alpha')!
  const beta = list.find((profile) => profile.name === 'Beta')!
  const state = await mainPage.evaluate(() =>
    (window as unknown as TestWindow).quickask!.sessions.state()
  )
  const sessionId = state.data?.currentSessionId ?? null

  await quickSwitchTo(alpha.id)
  const sent = await mainPage.evaluate(
    async ({ sessionId: current }) =>
      (window as unknown as TestWindow).quickask!.chat.send({
        sessionId: current,
        text: 'slow stream on Alpha'
      }),
    { sessionId }
  )
  expect(sent.ok).toBe(true)
  const requestId = await waitForActive()
  const beforeSwitch = readBodies().length

  await quickSwitchTo(beta.id)
  await expect(mainPage.locator('[data-testid="panel-model"]')).toHaveText(beta.model, {
    timeout: 8000
  })
  const stillActive = await mainPage.evaluate(() =>
    (window as unknown as TestWindow).quickask!.chat.getActive()
  )
  expect(stillActive.ok && stillActive.data?.active?.requestId).toBe(requestId)

  await waitForIdle()
  const bodies = readBodies()
  expect(bodies.length).toBe(beforeSwitch)
  expect(bodies.at(-1)?.model).toBe(alpha.model)

  const next = await mainPage.evaluate(() =>
    (window as unknown as TestWindow).quickask!.chat.send({
      sessionId: null,
      text: 'next request on Beta'
    })
  )
  expect(next.ok).toBe(true)
  await waitForIdle()
  expect(readBodies().at(-1)?.model).toBe(beta.model)

  evidence['step3'] = {
    firstRequestModel: bodies.at(-1)?.model ?? null,
    switchedTo: beta.model,
    nextRequestModel: readBodies().at(-1)?.model
  }
  checks.activeStreamKeepsModel =
    bodies.at(-1)?.model === alpha.model && readBodies().at(-1)?.model === beta.model
})

test('deleting the selected profile falls back to default/first without touching sessions', async () => {
  const page = settingsWindows()[0] ?? (await openSettings())
  const beforeSessions = await mainPage.evaluate(() =>
    (window as unknown as TestWindow).quickask!.sessions.list({ limit: 100 })
  )
  const beforeCount = beforeSessions.data?.sessions.length ?? 0
  const list = await profiles()
  const alpha = list.find((profile) => profile.name === 'Alpha')!
  const beta = list.find((profile) => profile.name === 'Beta')!

  await selectProfile(page, beta.id)
  await page.locator('[data-testid="model-delete"]').click()
  await expect(page.locator('[data-testid="model-delete-confirm"]')).toBeVisible()
  await page.locator('[data-testid="model-delete-confirm"]').click()

  await expect
    .poll(async () => (await profiles()).some((profile) => profile.id === beta.id), {
      timeout: 10_000
    })
    .toBe(false)
  const remaining = await profiles()
  const fallback = remaining.find((profile) => profile.isDefault) ?? remaining[0] ?? null
  expect(fallback?.id).toBe(alpha.id)
  await expect(page.locator(`[data-testid="model-profile-${alpha.id}"]`)).toHaveAttribute(
    'aria-current',
    'true'
  )
  await expect(page.locator('[data-testid="model-name"]')).toHaveValue('Alpha')
  expect(await modelProfileId()).toBe(alpha.id)

  const afterSessions = await mainPage.evaluate(() =>
    (window as unknown as TestWindow).quickask!.sessions.list({ limit: 100 })
  )
  expect(afterSessions.data?.sessions.length ?? -1).toBe(beforeCount)
  const afterState = await mainPage.evaluate(() =>
    (window as unknown as TestWindow).quickask!.sessions.state()
  )
  expect(afterState.ok).toBe(true)

  evidence['step4'] = {
    deleted: beta.id,
    fallback: fallback?.id,
    sessionsBefore: beforeCount,
    sessionsAfter: afterSessions.data?.sessions.length ?? null
  }
  evidence['finalProfiles'] = remaining
  checks.deleteSelectedFallsBack = fallback?.id === alpha.id && (await modelProfileId()) === alpha.id
  checks.noEmptySessionImpact = (afterSessions.data?.sessions.length ?? -1) === beforeCount
})
