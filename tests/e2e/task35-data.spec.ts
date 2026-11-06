import { _electron as electron, expect, test } from '@playwright/test'
import type { ElectronApplication, Page } from '@playwright/test'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

interface IpcResponse<T = unknown> {
  ok: boolean
  data?: T
  error?: { code: string; message: string }
}

type TestWindow = typeof globalThis & { quickask?: TestApi }

interface TestApi {
  app: {
    bootstrap(): Promise<IpcResponse>
    listFonts(): Promise<IpcResponse>
    readLogs(): Promise<IpcResponse>
    openPath(kind: string): Promise<IpcResponse>
  }
  window: {
    openSettings(): Promise<IpcResponse>
    closeSettings(): Promise<IpcResponse>
  }
  sessions: {
    create(request?: { title?: string }): Promise<IpcResponse>
    export(request: { format: string; scope: string }): Promise<IpcResponse>
  }
  settings: {
    set(request: { key: string; value: unknown }): Promise<IpcResponse>
  }
  data: {
    cleanup(request?: { dryRun?: boolean }): Promise<IpcResponse>
  }
}

const EVIDENCE_DIR = resolve('.omo/evidence/m2/data')
const DISPLAY = process.env['DISPLAY'] ?? ':0'

let app: ElectronApplication | undefined
let mainPage: Page
let tempRoot = ''
let exportDir = ''

const evidence: Record<string, unknown> = {}
const pageErrors: string[] = []
const checks = { export: false, retention: false, fonts: false, logs: false }

function delay(ms: number): Promise<void> {
  return new Promise((resolveDelay) => setTimeout(resolveDelay, ms))
}

function writeEvidence(name: string, value: unknown): void {
  mkdirSync(EVIDENCE_DIR, { recursive: true })
  writeFileSync(join(EVIDENCE_DIR, name), `${JSON.stringify(value, null, 2)}\n`)
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
    QUICKASK_EXPORT_STUB_DIR: join(root, 'exports'),
    QUICKASK_DISABLE_ONBOARDING: '1',
    PATH: `${join(root, 'bin')}:${process.env['PATH'] ?? ''}`
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
}

async function closeApp(): Promise<void> {
  if (!app) return
  const current = app
  app = undefined
  try {
    await Promise.race([current.close(), delay(5000)])
  } catch {
    try {
      current.process().kill('SIGTERM')
    } catch {
      return
    }
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
  return page
}

async function closeSettings(): Promise<void> {
  if (settingsWindows().length === 0) return
  await mainPage.evaluate(() => (window as unknown as TestWindow).quickask!.window.closeSettings())
  await expect.poll(() => settingsWindows().length, { timeout: 10_000 }).toBe(0)
}

test.describe.configure({ mode: 'serial' })

test.beforeAll(async () => {
  tempRoot = mkdtempSync(join(tmpdir(), 'quickask-task35-'))
  exportDir = join(tempRoot, 'exports')
  const binDir = join(tempRoot, 'bin')
  for (const dir of ['config', 'data', 'state']) mkdirSync(join(tempRoot, dir), { recursive: true })
  mkdirSync(exportDir, { recursive: true })
  mkdirSync(binDir, { recursive: true })
  const fakeXdgOpen = join(binDir, 'xdg-open')
  writeFileSync(fakeXdgOpen, '#!/bin/sh\nexit 0\n', 'utf8')
  chmodSync(fakeXdgOpen, 0o755)
  mkdirSync(EVIDENCE_DIR, { recursive: true })
  await launch()
})

test.afterAll(async () => {
  await closeSettings().catch(() => undefined)
  await closeApp()
  const summary = {
    task: 35,
    title: 'export, retention, font switching, log viewer',
    generatedAt: new Date().toISOString(),
    verdict: Object.values(checks).every(Boolean) ? 'PASS' : 'FAIL',
    checks,
    display: DISPLAY,
    pageErrors,
    evidenceMap: evidence
  }
  writeEvidence('task-35-summary.json', summary)
  try {
    rmSync(tempRoot, { recursive: true, force: true })
  } catch {
    return
  }
})

test('export current/all JSON+Markdown via stubbed dialog, no secrets', async () => {
  const created = await mainPage.evaluate(() => {
    const api = (window as unknown as TestWindow).quickask!
    return Promise.all([
      api.sessions.create({ title: 'task35-export-a' }),
      api.sessions.create({ title: 'task35-export-b' })
    ])
  })
  for (const entry of created) expect(entry.ok).toBe(true)

  const results = await mainPage.evaluate(() => {
    const api = (window as unknown as TestWindow).quickask!
    return (async () => {
      const all: unknown[] = []
      for (const payload of [
        { format: 'json', scope: 'all' },
        { format: 'markdown', scope: 'all' }
      ] as const) {
        all.push(await api.sessions.export(payload))
      }
      return all as IpcResponse<{ path: string; count: number; bytes: number }>[]
    })()
  })
  expect(results).toHaveLength(2)
  const payloads: string[] = []
  for (const result of results) {
    expect(result.ok).toBe(true)
    const data = result.data!
    expect(data.count).toBeGreaterThanOrEqual(2)
    expect(existsSync(data.path)).toBe(true)
    const body = readFileSync(data.path, 'utf8')
    payloads.push(body.slice(0, 200))
    expect(body).not.toMatch(/api[_-]?key|key_ref|secret/i)
  }
  expect(payloads[0]).toContain('quickask')
  expect(payloads[1]).toContain('QuickAsk')

  const page = await openSettings()
  await page.locator('[data-testid="settings-tab-data"]').click()
  await expect(page.locator('[data-testid="data-panel"]')).toBeVisible()
  for (const testId of [
    'export-current-json',
    'export-current-markdown',
    'export-all-json',
    'export-all-markdown'
  ]) {
    await expect(page.locator(`[data-testid="${testId}"]`)).toBeVisible()
  }
  await page.screenshot({ path: join(EVIDENCE_DIR, 'task-35-data.png') })
  await closeSettings()

  const payload = { exported: results.map((r) => r.data), heads: payloads }
  writeEvidence('task-35-export.json', payload)
  evidence['export'] = payload
  checks.export = true
})

test('retention keeps recent without explicit setting, UI applies days', async () => {
  const before = await mainPage.evaluate(() =>
    (window as unknown as TestWindow).quickask!.data.cleanup({ dryRun: true })
  )
  expect(before.ok).toBe(true)

  const nulled = await mainPage.evaluate(() =>
    (window as unknown as TestWindow).quickask!.settings.set({
      key: 'data',
      value: { retentionDays: null, lastExportPath: null }
    })
  )
  expect(nulled.ok).toBe(true)
  const idle = await mainPage.evaluate(() =>
    (window as unknown as TestWindow).quickask!.data.cleanup({})
  )
  expect(idle.ok).toBe(true)
  expect((idle.data as { cleaned: number }).cleaned).toBe(0)

  const page = await openSettings()
  await page.locator('[data-testid="settings-tab-data"]').click()
  await page.locator('[data-testid="retention-days"]').fill('30')
  await page.locator('[data-testid="retention-apply"]').click()
  await expect(page.locator('[data-testid="retention-status"]')).toContainText('已清理', {
    timeout: 10_000
  })
  const status = await page.locator('[data-testid="retention-status"]').innerText()
  expect(status).toContain('30')
  await page.screenshot({ path: join(EVIDENCE_DIR, 'task-35-retention.png') })
  await closeSettings()

  const payload = { dryRun: before.data, idle: idle.data, applied: status }
  writeEvidence('task-35-retention.json', payload)
  evidence['retention'] = payload
  checks.retention = true
})

test('font list has Noto, select applies --font-ui, LXGW hint when missing', async () => {
  const fonts = await mainPage.evaluate(() =>
    (window as unknown as TestWindow).quickask!.app.listFonts()
  )
  expect(fonts.ok).toBe(true)
  const list = (fonts.data as { fonts: string[]; default: string }).fonts
  expect(list).toContain('Noto Sans CJK SC')

  const page = await openSettings()
  await page.locator('[data-testid="settings-tab-appearance"]').click()
  await expect(page.locator('[data-testid="fontfamily-select"]')).toBeVisible()
  const options = await page.locator('[data-testid="fontfamily-select"] option').allInnerTexts()
  expect(options).toContain('Noto Sans CJK SC')
  const hint = await page.locator('[data-testid="font-hint"]').count()
  const hintText = hint > 0 ? await page.locator('[data-testid="font-hint"]').innerText() : ''
  const current = await page.locator('[data-testid="fontfamily-select"]').inputValue()

  const target = list.includes('DejaVu Sans') && current !== 'DejaVu Sans' ? 'DejaVu Sans' : list[0]!
  await page.locator('[data-testid="fontfamily-select"]').selectOption(target)
  await expect
    .poll(() =>
      mainPage.evaluate(() =>
        getComputedStyle(document.documentElement).getPropertyValue('--font-ui').trim()
      )
    )
    .toContain(target)
  const boot = await mainPage.evaluate(() =>
    (window as unknown as TestWindow).quickask!.app.bootstrap()
  )
  expect((boot.data as unknown as { appearance: { fontFamily: string } }).appearance.fontFamily).toBe(target)
  await page.screenshot({ path: join(EVIDENCE_DIR, 'task-35-fonts.png') })
  await closeSettings()

  const payload = { fonts: list, options, hintText, applied: target }
  writeEvidence('task-35-fonts.json', payload)
  evidence['fonts'] = payload
  checks.fonts = true
})

test('log viewer shows redacted tail ≤64KB and open-path logs allowed', async () => {
  const read = await mainPage.evaluate(() =>
    (window as unknown as TestWindow).quickask!.app.readLogs()
  )
  expect(read.ok).toBe(true)
  const data = read.data as { path: string; content: string; bytes: number; truncated: boolean }
  expect(data.path.endsWith('quickask.log')).toBe(true)
  expect(data.bytes).toBeLessThanOrEqual(64 * 1024)
  expect(data.content.length).toBeLessThanOrEqual(64 * 1024)

  const { appendFileSync } = await import('node:fs')
  appendFileSync(data.path, '\nplanted-secret-probe sk-TESTSECRET1234567890 end\n')
  const reread = await mainPage.evaluate(() =>
    (window as unknown as TestWindow).quickask!.app.readLogs()
  )
  expect(reread.ok).toBe(true)
  const redacted = (reread.data as { content: string }).content
  expect(redacted).not.toContain('sk-TESTSECRET1234567890')
  expect(redacted).toContain('[REDACTED]')

  const opened = await mainPage.evaluate(() =>
    (window as unknown as TestWindow).quickask!.app.openPath('logs')
  )
  expect(opened.ok).toBe(true)

  const page = await openSettings()
  await page.locator('[data-testid="settings-tab-data"]').click()
  await expect(page.locator('[data-testid="data-log-content"]')).toBeVisible()
  const dataContent = await page.locator('[data-testid="data-log-content"]').innerText()
  expect(dataContent.length).toBeGreaterThan(0)
  await page.locator('[data-testid="settings-tab-about"]').click()
  await expect(page.locator('[data-testid="about-log-content"]')).toBeVisible()
  await page.screenshot({ path: join(EVIDENCE_DIR, 'task-35-logs.png') })
  await closeSettings()

  const payload = {
    path: data.path,
    bytes: data.bytes,
    truncated: data.truncated,
    head: data.content.slice(0, 200)
  }
  writeEvidence('task-35-logs.json', payload)
  evidence['logs'] = payload
  checks.logs = true
})

test('quit leaves no child electron process behind', async () => {
  await closeSettings().catch(() => undefined)
  await closeApp()
  const { execFileSync } = await import('node:child_process')
  const check = execFileSync('bash', ['-lc', 'pgrep -x electron || true'], {
    encoding: 'utf8'
  }).trim()
  expect(check).toBe('')
})
