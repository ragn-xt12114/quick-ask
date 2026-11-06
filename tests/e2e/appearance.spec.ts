import { _electron as electron, expect, test } from '@playwright/test'
import type { ElectronApplication, Page } from '@playwright/test'
import { execFileSync } from 'node:child_process'
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  statSync,
  writeFileSync
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import type { BootstrapInfo, WindowState } from '../../src/shared/channels'
import {
  PRIMARY_COLORS,
  PRIMARY_PRESETS,
  type BehaviorSettings
} from '../../src/shared/settings'

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
    setMode(mode: 'S0' | 'S1' | 'S2' | 'S3'): Promise<IpcResponse<{ mode: string }>>
    getState(): Promise<IpcResponse<WindowState>>
    openSettings(options?: { onboarding?: boolean }): Promise<IpcResponse<{ open: boolean }>>
    closeSettings(): Promise<IpcResponse<{ open: boolean }>>
  }
  settings: {
    set(request: {
      key: string
      value: unknown
    }): Promise<IpcResponse<{ saved: boolean }>>
  }
}

type TestWindow = typeof globalThis & { quickask?: TestApi }

interface ShapeOutput {
  count: number
  rects: Array<{ x: number; y: number; width: number; height: number }>
}

interface PixelRegion {
  rect: number[]
  center_rgb: number[]
  max_luma: number
  bright_ratio: number
  black_ratio: number
  bg_distance: number | null
  center_bg_distance: number | null
}

const EVIDENCE_DIR = resolve('.omo/evidence')
const HELPER = resolve('native/quickask-x11')
const PIXEL_TOOL = resolve('tools/appearance-pixels.py')
const DISPLAY = process.env['DISPLAY'] ?? ':0'
let initialBehavior: BehaviorSettings | undefined
let resolvedPython: string | null = null

let app: ElectronApplication | undefined
let mainPage: Page
let settingsPage: Page | undefined
let tempRoot = ''

const evidence: Record<string, unknown> = {}
const checks = {
  appearanceImmediate: false,
  opacityPixels: false,
  barWidthGeometry: false,
  blurHonest: false,
  compositorOffOpaque: false,
  compositorRestored: false,
  reducedMotion: false,
  persistedAfterRestart: false,
  animationFactorZero: false
}

function delay(ms: number): Promise<void> {
  return new Promise((resolveDelay) => setTimeout(resolveDelay, ms))
}

function pythonHasPillow(command: string): boolean {
  try {
    execFileSync(command, ['-c', 'import PIL'], { stdio: 'ignore', timeout: 5_000 })
    return true
  } catch {
    return false
  }
}

function pythonWithPillow(): string {
  if (resolvedPython !== null) return resolvedPython
  const candidates = [
    'python3',
    process.env['PYTHON'],
    '/usr/bin/python3'
  ].filter((value): value is string => typeof value === 'string' && value.length > 0)
  for (const candidate of new Set(candidates)) {
    if (pythonHasPillow(candidate)) {
      resolvedPython = candidate
      return candidate
    }
  }
  throw new Error(
    '缺 Pillow：找不到可用的 Python 解释器。请设置 PYTHON=/path/to/python，或运行 python3 -m pip install Pillow。'
  )
}

function baseEnv(root: string, extra: Record<string, string> = {}): Record<string, string> {
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
    QUICKASK_DISABLE_ONBOARDING: '1',
    ...extra
  }
}

function writeEvidence(name: string, value: unknown): void {
  mkdirSync(EVIDENCE_DIR, { recursive: true })
  writeFileSync(join(EVIDENCE_DIR, name), `${JSON.stringify(value, null, 2)}\n`)
}

async function launch(extraEnv: Record<string, string> = {}): Promise<void> {
  app = await electron.launch({ args: ['.'], env: baseEnv(tempRoot, extraEnv) })
  const first = await app.firstWindow()
  await first.waitForLoadState('domcontentloaded')
  await first.waitForFunction(() => Boolean((window as unknown as TestWindow).quickask))
  mainPage =
    app.windows().find((page) => !page.url().includes('settings=1')) ?? first
  await mainPage.waitForFunction(() => Boolean((window as unknown as TestWindow).quickask))
}

async function waitForSettings(): Promise<Page> {
  await expect
    .poll(() => app!.windows().filter((page) => page.url().includes('settings=1')).length, {
      timeout: 10_000
    })
    .toBe(1)
  const page = app!.windows().find((entry) => entry.url().includes('settings=1'))!
  await page.waitForLoadState('domcontentloaded')
  await page.waitForFunction(() => Boolean((window as unknown as TestWindow).quickask))
  settingsPage = page
  return page
}

async function openSettings(): Promise<Page> {
  await mainPage.evaluate(() => (window as unknown as TestWindow).quickask!.window.openSettings())
  const page = await waitForSettings()
  await page.locator('[data-testid="settings-tab-appearance"]').click()
  await page.locator('[data-testid="appearance-panel"]').waitFor({ state: 'visible' })
  return page
}

async function closeSettings(): Promise<void> {
  await mainPage.evaluate(() =>
    (window as unknown as TestWindow).quickask!.window.closeSettings()
  )
  await expect
    .poll(() => app!.windows().filter((page) => page.url().includes('settings=1')).length, {
      timeout: 5_000
    })
    .toBe(0)
  settingsPage = undefined
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

async function showMain(mode: 'S1' | 'S2' | 'S3' = 'S1'): Promise<void> {
  await mainPage.evaluate(() => (window as unknown as TestWindow).quickask!.window.show())
  await mainPage.evaluate(
    (target) => (window as unknown as TestWindow).quickask!.window.setMode(target),
    mode
  )
  await mainPage.waitForFunction(
    (target) =>
      document.querySelector('[data-testid="app-root"]')?.getAttribute('data-ui-mode') ===
      target,
    mode
  )
}

function windowMapState(wid: number): string {
  const output = execFileSync('xwininfo', ['-id', hexWid(wid)], {
    encoding: 'utf8',
    timeout: 5_000,
    env: { ...process.env, DISPLAY }
  })
  return output.match(/Map State:\s+(\S+)/)?.[1] ?? 'unknown'
}

async function ensureWindowViewable(
  wid: number,
  mode: 'S1' | 'S2' | 'S3' = 'S1',
  timeoutMs = 8_000
): Promise<void> {
  const deadline = Date.now() + timeoutMs
  let last = 'unknown'
  while (Date.now() < deadline) {
    try {
      last = windowMapState(wid)
    } catch (error) {
      last = `xwininfo failed: ${error instanceof Error ? error.message : String(error)}`
    }
    if (last === 'IsViewable') return
    await mainPage.evaluate(async (target) => {
      const api = (window as unknown as TestWindow).quickask!
      await api.window.show()
      await api.window.setMode(target)
    }, mode)
    await delay(100)
  }
  throw new Error(
    `主窗口 ${hexWid(wid)} 在 ${timeoutMs}ms 内未变为 IsViewable（xwininfo Map State: ${last}）`
  )
}

async function setBehavior(behavior: BehaviorSettings): Promise<void> {
  const result = await mainPage.evaluate(
    (value) =>
      (window as unknown as TestWindow).quickask!.settings.set({
        key: 'behavior',
        value
      }),
    behavior
  )
  expect(result.ok).toBe(true)
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
    return bar ? getComputedStyle(bar).backgroundColor : ''
  })
  if (value.startsWith('rgb(')) return 1
  const match = value.match(/rgba\([^)]*,\s*([\d.]+)\)$/)
  return match ? Number(match[1]) : Number.NaN
}

async function nativeWindowId(): Promise<number> {
  return app!.evaluate(({ BrowserWindow }) => {
    const window = BrowserWindow.getAllWindows().find(
      (entry) => !entry.webContents.getURL().includes('settings=1')
    )
    if (!window) throw new Error('main window not found')
    const handle = window.getNativeWindowHandle()
    return handle.length >= 8
      ? Number(handle.readBigUInt64LE(0) & 0xffffffffn)
      : handle.readUInt32LE(0)
  })
}

function hexWid(wid: number): string {
  return `0x${wid.toString(16)}`
}

function xprop(wid: number, property: string): string {
  return execFileSync('xprop', ['-id', hexWid(wid), property], {
    encoding: 'utf8',
    timeout: 5_000
  })
}

function queryShape(kind: 'bounding' | 'input', wid: number): ShapeOutput {
  const output = execFileSync(
    HELPER,
    [`query-${kind}-shape`, hexWid(wid)],
    { encoding: 'utf8', timeout: 5_000, env: { ...process.env, DISPLAY } }
  )
  const fields = new Map<string, string>()
  for (const line of output.split('\n')) {
    const separator = line.indexOf('=')
    if (separator > 0) fields.set(line.slice(0, separator), line.slice(separator + 1))
  }
  const raw = fields.get('RECTS') ?? ''
  const rects = raw
    .split(';')
    .filter((chunk) => chunk.length > 0)
    .map((chunk) => {
      const [x, y, width, height] = chunk.split(',').map((value) => Number(value))
      return { x: x!, y: y!, width: width!, height: height! }
    })
  return {
    count: Number.parseInt(fields.get(kind === 'bounding' ? 'BOUNDING_SHAPE' : 'INPUT_SHAPE') ?? '0', 10),
    rects
  }
}

function pointInShape(shape: ShapeOutput, x: number, y: number): boolean {
  return shape.rects.some(
    (rect) => x >= rect.x && x < rect.x + rect.width && y >= rect.y && y < rect.y + rect.height
  )
}

async function waitForOpaqueShapes(
  wid: number,
  width: number,
  gapY: number
): Promise<{ bounding: ShapeOutput; input: ShapeOutput }> {
  const deadline = Date.now() + 6_000
  let bounding = queryShape('bounding', wid)
  let input = queryShape('input', wid)
  while (Date.now() < deadline) {
    const ready =
      bounding.count >= 2 &&
      input.count >= 2 &&
      pointInShape(bounding, width / 2, 10) &&
      pointInShape(bounding, width / 2, gapY + 20) &&
      !pointInShape(bounding, width / 2, gapY + 6) &&
      pointInShape(input, width / 2, 10) &&
      !pointInShape(input, width / 2, gapY + 6)
    if (ready) return { bounding, input }
    await delay(100)
    bounding = queryShape('bounding', wid)
    input = queryShape('input', wid)
  }
  return { bounding, input }
}

async function waitForNormalShape(wid: number): Promise<ShapeOutput> {
  const deadline = Date.now() + 6_000
  let shape = queryShape('bounding', wid)
  while (Date.now() < deadline && shape.count > 1) {
    await delay(100)
    shape = queryShape('bounding', wid)
  }
  return shape
}

function compositorActive(): boolean {
  const output = execFileSync(
    'qdbus6',
    ['org.kde.KWin', '/Compositor', 'org.kde.kwin.Compositing.active'],
    { encoding: 'utf8', timeout: 5_000 }
  )
  return output.trim() === 'true'
}

function invokeCompositorShortcut(): void {
  execFileSync(
    'qdbus6',
    [
      'org.kde.kglobalaccel',
      '/component/kwin',
      'org.kde.kglobalaccel.Component.invokeShortcut',
      'Suspend Compositing'
    ],
    { encoding: 'utf8', timeout: 5_000 }
  )
}

function restoreCompositorSync(): void {
  for (let attempt = 0; attempt < 8; attempt++) {
    try {
      if (compositorActive()) return
      invokeCompositorShortcut()
    } catch {
      return
    }
    try {
      execFileSync('sleep', ['0.4'])
    } catch {
      return
    }
  }
}

async function setCompositor(active: boolean): Promise<boolean> {
  for (let attempt = 0; attempt < 4; attempt++) {
    if (compositorActive() === active) return true
    invokeCompositorShortcut()
    for (let poll = 0; poll < 30; poll++) {
      await delay(200)
      if (compositorActive() === active) return true
    }
  }
  return compositorActive() === active
}

function screenBar(state: WindowState): { x: number; y: number; width: number; height: number } {
  const layout = state.layout!
  return {
    x: state.bounds.x + layout.barRect.x,
    y: state.bounds.y + layout.barRect.y,
    width: layout.barRect.width,
    height: layout.barRect.height
  }
}

function xwdAlpha(wid: number, card: { x: number; y: number; width: number; height: number }) {
  const state = windowMapState(wid)
  if (state !== 'IsViewable') {
    throw new Error(
      `xwd 目标 ${hexWid(wid)} 的 Map State=${state}，不是 IsViewable；窗口可能被 blur 自动隐藏`
    )
  }
  const path = join(tempRoot, `alpha-${Date.now()}.xwd`)
  try {
    try {
      execFileSync('xwd', ['-id', hexWid(wid), '-silent', '-out', path], {
        encoding: 'utf8',
        timeout: 10_000
      })
    } catch (error) {
      throw new Error(
        `xwd 失败（${hexWid(wid)}, Map State: ${windowMapState(wid)}）: ${
          error instanceof Error ? error.message : String(error)
        }`,
        { cause: error }
      )
    }
    if (!existsSync(path) || statSync(path).size === 0) {
      throw new Error(
        `xwd 对 ${hexWid(wid)} 产出空文件（Map State: ${windowMapState(wid)}），窗口未真正映射`
      )
    }
    const output = execFileSync(
      pythonWithPillow(),
      [
        resolve('tools/xwd-alpha.py'),
        '--xwd',
        path,
        '--card',
        `${card.x},${card.y},${card.width},${card.height}`
      ],
      { encoding: 'utf8', timeout: 20_000 }
    )
    return JSON.parse(output) as {
      alpha_histogram_peaks: Array<[number, number]>
      samples: Record<string, { alpha: number; rgba: number[] }>
    }
  } finally {
    rmSync(path, { force: true })
  }
}

function dominantAlphaPeak(
  report: { alpha_histogram_peaks: Array<[number, number]> },
  expected: number
): [number, number] | null {
  return (
    report.alpha_histogram_peaks.find(
      ([alpha, count]) => Math.abs(alpha - expected) <= 2 && count > 5_000
    ) ?? null
  )
}

function captureRoot(path: string): void {
  execFileSync('import', ['-window', 'root', path], {
    encoding: 'utf8',
    timeout: 15_000,
    env: { ...process.env, DISPLAY }
  })
  expect(existsSync(path)).toBe(true)
  expect(statSync(path).size).toBeGreaterThan(1_000)
}

function captureWindow(wid: number, path: string): void {
  const state = windowMapState(wid)
  if (state !== 'IsViewable') {
    throw new Error(
      `截图目标 ${hexWid(wid)} 的 Map State=${state}，不是 IsViewable；窗口可能被 blur 自动隐藏`
    )
  }
  execFileSync('import', ['-window', hexWid(wid), path], {
    encoding: 'utf8',
    timeout: 15_000,
    env: { ...process.env, DISPLAY }
  })
  expect(existsSync(path)).toBe(true)
  expect(statSync(path).size).toBeGreaterThan(1_000)
}

async function captureScreen(path: string): Promise<void> {
  try {
    execFileSync('spectacle', ['-b', '-n', '-f', '-o', path], {
      encoding: 'utf8',
      timeout: 15_000,
      env: { ...process.env, DISPLAY }
    })
    if (existsSync(path) && statSync(path).size > 1_000) return
  } catch {
    // fall back to a renderer screenshot below
  }
  await mainPage.screenshot({ path })
}

function pixelRegions(
  image: string,
  rects: number[][],
  background: [number, number, number]
): PixelRegion[] {
  const args = [PIXEL_TOOL, '--image', image, '--bg', background.join(',')]
  for (const rect of rects) args.push('--rect', rect.join(','))
  const output = execFileSync(pythonWithPillow(), args, { encoding: 'utf8', timeout: 30_000 })
  return (JSON.parse(output) as { regions: PixelRegion[] }).regions
}

test.beforeAll(async () => {
  tempRoot = mkdtempSync(join(tmpdir(), 'quickask-task23-'))
  for (const dir of ['config', 'data', 'state']) {
    mkdirSync(join(tempRoot, dir), { recursive: true })
  }
  mkdirSync(EVIDENCE_DIR, { recursive: true })
  for (const name of [
    'task-23-appearance.json',
    'task-23-appearance.png',
    'task-23-opacity.json',
    'task-23-opacity.png',
    'task-23-barwidth.json',
    'task-23-barwidth.png',
    'task-23-blur.json',
    'task-23-compositor-on.json',
    'task-23-compositor-on.png',
    'task-23-compositor-off.json',
    'task-23-compositor-off.png',
    'task-23-compositor-off-screen.png',
    'task-23-reduced-motion.json',
    'task-23-persistence.json',
    'task-23-xprop.txt',
    'task-23-bounding-shape.txt',
    'task-23-summary.json'
  ]) {
    rmSync(join(EVIDENCE_DIR, name), { force: true })
  }

  process.on('exit', restoreCompositorSync)
  await setCompositor(true)
  await launch()
  initialBehavior = (await bootstrap()).settings.behavior
  await setBehavior({ ...initialBehavior, hideOnBlur: false })
  await showMain('S1')
  await openSettings()
})

test.afterAll(async () => {
  const restored = await setCompositor(true)
  checks.compositorRestored = restored && compositorActive()
  if (initialBehavior) {
    await setBehavior(initialBehavior).catch(() => undefined)
  }
  await app?.close()
  app = undefined
  process.removeListener('exit', restoreCompositorSync)

  const allPassed = Object.values(checks).every(Boolean)
  const summary = {
    task: 23,
    verdict: allPassed ? 'PASS' : 'FAIL',
    generatedAt: new Date().toISOString(),
    checks,
    compositingActiveAfter: compositorActive(),
    electronLeft: (() => {
      try {
        return execFileSync('pgrep', ['-x', 'electron'], { encoding: 'utf8' }).trim()
      } catch {
        return ''
      }
    })(),
    evidence: {
      appearance: 'task-23-appearance.json',
      appearancePng: 'task-23-appearance.png',
      opacity: 'task-23-opacity.json',
      opacityPng: 'task-23-opacity.png',
      barWidth: 'task-23-barwidth.json',
      barWidthPng: 'task-23-barwidth.png',
      blur: 'task-23-blur.json',
      compositorOff: 'task-23-compositor-off.json',
      compositorOffPng: 'task-23-compositor-off.png',
      compositorOffScreenPng: 'task-23-compositor-off-screen.png',
      compositorOn: 'task-23-compositor-on.json',
      compositorOnPng: 'task-23-compositor-on.png',
      reducedMotion: 'task-23-reduced-motion.json',
      persistence: 'task-23-persistence.json'
    },
    evidenceMap: evidence
  }
  writeEvidence('task-23-summary.json', summary)
  rmSync(tempRoot, { recursive: true, force: true })
})

test('theme, primary, opacity and bar width apply immediately', async () => {
  const settings = settingsPage!
  const states: Record<string, string> = {}
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
    const expected = await mainPage.evaluate(() =>
      window.matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark'
    )
    expect(resolved).toBe(theme === 'system' ? expected : theme)
    states[theme] = resolved
  }
  expect(Object.keys(states)).toEqual(['dark', 'light', 'system'])

  await settings.locator('[data-testid="appearance-theme-system"]').check()
  const systemRuntime: Record<string, string> = {}
  for (const scheme of ['dark', 'light'] as const) {
    await mainPage.emulateMedia({ colorScheme: scheme })
    await expect
      .poll(() => mainPage.evaluate(() => document.documentElement.dataset['theme'] ?? ''))
      .toBe(scheme)
    systemRuntime[scheme] = await mainPage.evaluate(
      () => document.documentElement.dataset['theme'] ?? ''
    )
  }
  await mainPage.emulateMedia({ colorScheme: null })
  await settings.locator('[data-testid="appearance-theme-dark"]').check()

  const primaries: Record<string, string> = {}
  for (const preset of PRIMARY_PRESETS) {
    await settings.locator(`[data-testid="primary-${preset}"]`).click()
    await expect
      .poll(() =>
        mainPage.evaluate(() => document.documentElement.dataset['primary'] ?? '')
      )
      .toBe(preset)
    const value = await mainPage.evaluate(() =>
      getComputedStyle(document.documentElement).getPropertyValue('--primary').trim()
    )
    expect(value).toBe(PRIMARY_COLORS[preset])
    primaries[preset] = value
  }
  expect(Object.keys(primaries).sort()).toEqual([...PRIMARY_PRESETS].sort())

  await settings.locator('[data-testid="appearance-theme-dark"]').check()
  await settings.locator('[data-testid="primary-everforest"]').click()
  await mainPage.screenshot({ path: join(EVIDENCE_DIR, 'task-23-appearance.png') })

  const current = await bootstrap()
  expect(current.appearance).toMatchObject({
    theme: 'dark',
    primary: 'everforest',
    opacity: 72,
    barWidth: 680
  })
  expect(typeof current.animationDurationFactor).toBe('number')
  expect(current.opaqueMode).toBe(false)

  const payload = {
    themes: states,
    systemRuntime,
    primaries,
    bootstrapAppearance: current.appearance,
    opaqueMode: current.opaqueMode,
    animationDurationFactor: current.animationDurationFactor,
    blurStatus: current.blurStatus
  }
  evidence.appearance = payload
  writeEvidence('task-23-appearance.json', payload)
  checks.appearanceImmediate = true
})

test('opacity 40/72/100 changes only card alpha and is visible in real xwd pixels', async () => {
  await showMain('S1')
  const wid = await nativeWindowId()
  await ensureWindowViewable(wid, 'S1')
  const observations: Array<Record<string, unknown>> = []
  for (const opacity of [40, 72, 100]) {
    await setRange('opacity-range', opacity)
    const expectedAlpha = Math.round((opacity / 100) * 255)
    await expect
      .poll(async () => barAlpha())
      .toBeCloseTo(opacity / 100, 2)
    await delay(300)

    const state = await mainState()
    const report = xwdAlpha(wid, state.layout!.barRect)
    const peak = dominantAlphaPeak(report, expectedAlpha)
    expect(peak).not.toBeNull()
    const pixels = await mainPage.evaluate(() => {
      const bar = document.querySelector('[data-testid="bar"]') as HTMLElement
      const text = document.querySelector('[data-testid="composer"]') as HTMLElement
      return {
        card: getComputedStyle(bar).backgroundColor,
        textColor: getComputedStyle(text).color
      }
    })
    observations.push({
      opacity,
      computedCard: pixels.card,
      textColor: pixels.textColor,
      expectedAlpha,
      dominantPeak: peak,
      alphaHistogramPeaks: report.alpha_histogram_peaks,
      barRect: state.layout!.barRect
    })
  }

  const alphaValues = observations.map((entry) => (entry.dominantPeak as [number, number])[0])
  expect(alphaValues).toEqual([102, 184, 255])
  const textColors = observations.map((entry) => entry.textColor)
  expect(new Set(textColors).size).toBe(1)
  expect(String(textColors[0])).toMatch(/rgba?\(255,\s*255,\s*255/)

  await setRange('opacity-range', 72)
  await expect.poll(() => barAlpha()).toBeCloseTo(0.72, 2)
  await mainPage.screenshot({ path: join(EVIDENCE_DIR, 'task-23-opacity.png') })

  const payload = { observations, textUnaffected: textColors[0] }
  evidence.opacity = payload
  writeEvidence('task-23-opacity.json', payload)
  checks.opacityPixels = true
})

test('bar width 560/680/900 keeps the anchor, composer min 240 and button sizes', async () => {
  await showMain('S1')
  const observations: Array<Record<string, unknown>> = []
  let anchor: { x: number; y: number } | null = null
  for (const width of [560, 680, 900]) {
    await setRange('barwidth-range', width)
    await expect
      .poll(async () => (await mainState()).layout?.barRect.width ?? 0)
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
    const bar = screenBar(state)
    if (anchor === null) anchor = { x: bar.x, y: bar.y }
    expect(Math.abs(bar.x - anchor.x)).toBeLessThanOrEqual(1)
    expect(Math.abs(bar.y - anchor.y)).toBeLessThanOrEqual(1)
    expect(state.bounds.width).toBe(width + 80)
    expect(state.layout!.visualBounds.width).toBe(width)

    const metrics = await mainPage.evaluate(() => {
      const composer = document.querySelector('[data-testid="composer"]') as HTMLElement | null
      const send = document.querySelector('[data-testid="btn-send"]') as HTMLElement | null
      const history = document.querySelector('[data-testid="btn-history"]') as HTMLElement | null
      return {
        composerMinWidth: composer ? getComputedStyle(composer).minWidth : '',
        composerWidth: composer?.getBoundingClientRect().width ?? 0,
        sendSize: send?.getBoundingClientRect().width ?? 0,
        historySize: history?.getBoundingClientRect().width ?? 0
      }
    })
    expect(metrics.composerMinWidth).toBe('240px')
    expect(metrics.composerWidth).toBeGreaterThanOrEqual(240)
    expect(metrics.sendSize).toBeCloseTo(36, 0)
    expect(metrics.historySize).toBeCloseTo(32, 0)
    observations.push({ width, state, bar, metrics })
  }
  expect(anchor).not.toBeNull()
  await mainPage.screenshot({ path: join(EVIDENCE_DIR, 'task-23-barwidth.png') })
  await setRange('barwidth-range', 680)
  await expect
    .poll(async () => (await mainState()).layout?.barRect.width ?? 0)
    .toBe(680)

  const payload = { anchor, observations }
  evidence.barwidth = payload
  writeEvidence('task-23-barwidth.json', payload)
  checks.barWidthGeometry = true
})

test('blur is honest: disabled toggle, reason, no property and no backdrop-filter', async () => {
  await showMain('S1')
  const wid = await nativeWindowId()
  const boot = await bootstrap()
  expect(boot.blurStatus.available).toBe(false)
  expect(boot.blurStatus.effectEnabled).toBe(false)
  expect(boot.opaqueMode).toBe(false)

  const settings = settingsPage!
  const statusText = await settings.locator('[data-testid="blur-status"]').innerText()
  expect(statusText).toContain('KWin 模糊效果未开启')
  await expect(settings.locator('[data-testid="blur-toggle"]')).toBeDisabled()

  const backdropFilters = await mainPage.evaluate(() => {
    const values: string[] = []
    for (const element of Array.from(document.querySelectorAll('*'))) {
      const style = getComputedStyle(element)
      const value =
        style.backdropFilter ||
        (style as unknown as { webkitBackdropFilter?: string }).webkitBackdropFilter
      if (value && value !== 'none') values.push(value)
    }
    return values
  })
  expect(backdropFilters).toEqual([])

  const blurProperty = xprop(wid, '_KDE_NET_WM_BLUR_BEHIND_REGION')
  expect(blurProperty).toContain('not found')
  const normalShape = queryShape('bounding', wid)
  expect(normalShape.count).toBeLessThanOrEqual(1)

  writeFileSync(
    join(EVIDENCE_DIR, 'task-23-xprop.txt'),
    `${xprop(wid, '_NET_WM_STATE')}\n\n${blurProperty}\n\n`
  )
  writeFileSync(
    join(EVIDENCE_DIR, 'task-23-bounding-shape.txt'),
    `normal: ${JSON.stringify(normalShape)}\n`
  )

  const payload = {
    blurStatus: boot.blurStatus,
    statusText,
    toggleDisabled: true,
    backdropFilterMatches: backdropFilters,
    xprop: blurProperty.trim(),
    normalBoundingShape: normalShape
  }
  evidence.blur = payload
  writeEvidence('task-23-blur.json', payload)
  checks.blurHonest = true
})

test('compositor off switches to opaque ShapeBounding; on restores transparency', async () => {
  await closeSettings()
  await showMain('S2')
  const wid = await nativeWindowId()
  await ensureWindowViewable(wid, 'S2')
  const before = await mainState()
  const beforeBar = screenBar(before)
  expect(compositorActive()).toBe(true)
  expect(before.layout!.windowBounds).not.toEqual(before.layout!.visualBounds)
  const beforeShape = queryShape('bounding', wid)
  expect(beforeShape.count).toBeLessThanOrEqual(1)
  const beforeBlur = xprop(wid, '_KDE_NET_WM_BLUR_BEHIND_REGION')
  expect(beforeBlur).toContain('not found')

  try {
    expect(await setCompositor(false)).toBe(true)
    await mainPage.waitForFunction(
      () => document.documentElement.dataset['opaque'] === '1',
      undefined,
      { timeout: 12_000 }
    )
    const bootOff = await bootstrap()
    expect(bootOff.opaqueMode).toBe(true)
    expect(bootOff.blurStatus.compositor).toBe(false)

    const off = await mainState()
    expect(off.layout!.windowBounds).toEqual(off.layout!.visualBounds)
    expect(off.bounds).toEqual(off.layout!.visualBounds)
    const offBar = screenBar(off)
    expect(Math.abs(offBar.x - beforeBar.x)).toBeLessThanOrEqual(1)
    expect(Math.abs(offBar.y - beforeBar.y)).toBeLessThanOrEqual(1)
    expect(off.bounds.width).toBe(off.layout!.barRect.width)

    const { bounding, input } = await waitForOpaqueShapes(wid, off.bounds.width, 48)
    expect(bounding.count).toBeGreaterThanOrEqual(2)
    expect(input.count).toBeGreaterThanOrEqual(2)
    expect(pointInShape(bounding, off.bounds.width / 2, 48 + 6)).toBe(false)
    expect(pointInShape(bounding, off.bounds.width / 2, 48 + 6 + 20)).toBe(true)
    expect(pointInShape(bounding, 0, 0)).toBe(true)
    expect(xprop(wid, '_KDE_NET_WM_BLUR_BEHIND_REGION')).toContain('not found')

    const offShot = join(EVIDENCE_DIR, 'task-23-compositor-off.png')
    const offScreen = join(EVIDENCE_DIR, 'task-23-compositor-off-screen.png')
    await delay(600)
    captureWindow(wid, offShot)
    captureRoot(offScreen)
    const [whole, barCard, panelCard, barBg, text, gap] = pixelRegions(
      offShot,
      [
        [0, 0, off.bounds.width, off.bounds.height],
        [0, 0, off.bounds.width, 48],
        [0, 60, off.bounds.width, 120],
        [100, 2, 480, 4],
        [120, 8, 380, 32],
        [0, 48, off.bounds.width, 12]
      ],
      [28, 30, 32]
    )
    expect(barCard!.black_ratio).toBe(0)
    expect(panelCard!.black_ratio).toBe(0)
    expect(barBg!.center_bg_distance).toBeLessThanOrEqual(3)
    expect(text!.bright_ratio).toBeGreaterThan(0.01)
    expect(text!.max_luma).toBeGreaterThan(150)
    expect(gap!.black_ratio).toBeGreaterThan(0.98)
    const rootStats = pixelRegions(
      offScreen,
      [[off.bounds.x, off.bounds.y, off.bounds.width, off.bounds.height]],
      [28, 30, 32]
    )[0]!

    const offPayload = {
      compositorActive: compositorActive(),
      bootstrap: bootOff,
      bounds: off.bounds,
      layout: off.layout,
      barScreen: offBar,
      beforeBarScreen: beforeBar,
      boundingShape: bounding,
      inputShape: input,
      blurProperty: xprop(wid, '_KDE_NET_WM_BLUR_BEHIND_REGION').trim(),
      pixels: { window: whole, barCard, panelCard, barBg, text, gap, root: rootStats },
      screenshots: [
        'task-23-compositor-off.png',
        'task-23-compositor-off-screen.png'
      ]
    }
    evidence.compositorOff = offPayload
    writeEvidence('task-23-compositor-off.json', offPayload)
    writeFileSync(
      join(EVIDENCE_DIR, 'task-23-bounding-shape.txt'),
      [
        `normal-count=${beforeShape.count} rects=${JSON.stringify(beforeShape.rects)}`,
        `opaque-count=${bounding.count} rects=${JSON.stringify(bounding.rects)}`,
        `opaque-input-count=${input.count} rects=${JSON.stringify(input.rects)}`
      ].join('\n') + '\n'
    )
    checks.compositorOffOpaque = true
  } finally {
    expect(await setCompositor(true)).toBe(true)
  }

  await mainPage.waitForFunction(
    () => document.documentElement.dataset['opaque'] === '0',
    undefined,
    { timeout: 12_000 }
  )
  const bootOn = await bootstrap()
  expect(bootOn.opaqueMode).toBe(false)
  expect(bootOn.blurStatus.compositor).toBe(true)

  const restored = await mainState()
  expect(restored.layout!.windowBounds).not.toEqual(restored.layout!.visualBounds)
  expect(restored.layout!.windowBounds.x).toBe(restored.layout!.visualBounds.x - 40)
  expect(restored.layout!.windowBounds.y).toBe(restored.layout!.visualBounds.y - 28)
  const onBar = screenBar(restored)
  expect(Math.abs(onBar.x - beforeBar.x)).toBeLessThanOrEqual(1)
  expect(Math.abs(onBar.y - beforeBar.y)).toBeLessThanOrEqual(1)
  expect(compositorActive()).toBe(true)

  const restoredShape = await waitForNormalShape(wid)
  expect(restoredShape.count).toBeLessThanOrEqual(1)
  if (restoredShape.count === 1) {
    expect(restoredShape.rects[0]).toEqual({
      x: 0,
      y: 0,
      width: restored.bounds.width,
      height: restored.bounds.height
    })
  }
  expect(xprop(wid, '_KDE_NET_WM_BLUR_BEHIND_REGION')).toContain('not found')

  const onShot = join(EVIDENCE_DIR, 'task-23-compositor-on.png')
  await captureScreen(onShot)
  expect(existsSync(onShot)).toBe(true)

  const onPayload = {
    compositorActive: compositorActive(),
    bootstrap: bootOn,
    bounds: restored.bounds,
    layout: restored.layout,
    barScreen: onBar,
    beforeBarScreen: beforeBar,
    boundingShape: restoredShape,
    blurProperty: xprop(wid, '_KDE_NET_WM_BLUR_BEHIND_REGION').trim(),
    screenshot: 'task-23-compositor-on.png',
    opaqueOffCaptured: checks.compositorOffOpaque
  }
  evidence.compositorOn = onPayload
  writeEvidence('task-23-compositor-on.json', onPayload)
  checks.compositorRestored = compositorActive() && bootOn.opaqueMode === false
})

test('reduced motion media and factor 0 disable transitions', async () => {
  await showMain('S1')
  const normal = await bootstrap()
  expect(normal.animationDurationFactor).toBe(1)
  const before = await mainPage.evaluate(() => {
    const button = document.querySelector('[data-testid="btn-history"]') as HTMLElement
    return {
      reduced: document.documentElement.dataset['reducedMotion'] ?? '',
      duration: getComputedStyle(button).transitionDuration
    }
  })
  expect(before.reduced).toBe('0')
  expect(before.duration).not.toBe('0s')

  await mainPage.emulateMedia({ reducedMotion: 'reduce' })
  await expect
    .poll(() =>
      mainPage.evaluate(() => document.documentElement.dataset['reducedMotion'] ?? '')
    )
    .toBe('1')
  const reduced = await mainPage.evaluate(() => {
    const button = document.querySelector('[data-testid="btn-history"]') as HTMLElement
    const style = getComputedStyle(button)
    return {
      duration: style.transitionDuration,
      animationDuration: style.animationDuration
    }
  })
  expect(reduced.duration.split(',').every((value) => value.trim() === '0s')).toBe(true)
  expect(reduced.animationDuration.split(',').every((value) => value.trim() === '0s')).toBe(
    true
  )
  await mainPage.emulateMedia({ reducedMotion: 'no-preference' })
  await expect
    .poll(() =>
      mainPage.evaluate(() => document.documentElement.dataset['reducedMotion'] ?? '')
    )
    .toBe('0')

  const payload = { before, reduced, cleared: true }
  evidence.reducedMotion = payload
  writeEvidence('task-23-reduced-motion.json', payload)
  checks.reducedMotion = true
})

test('appearance persists after restart; factor 0 override is exposed', async () => {
  await openSettings()
  const settings = settingsPage!
  await settings.locator('[data-testid="appearance-theme-light"]').check()
  await settings.locator('[data-testid="primary-gruvbox"]').click()
  await setRange('opacity-range', 40)
  await setRange('barwidth-range', 900)
  await expect
    .poll(async () => (await bootstrap()).appearance)
    .toMatchObject({ theme: 'light', primary: 'gruvbox', opacity: 40, barWidth: 900 })
  await app!.close()
  app = undefined
  settingsPage = undefined
  await delay(500)

  await launch({ QUICKASK_ANIMATION_DURATION_FACTOR: '0' })
  const boot = await bootstrap()
  expect(boot.appearance).toMatchObject({
    theme: 'light',
    primary: 'gruvbox',
    opacity: 40,
    barWidth: 900
  })
  expect(boot.animationDurationFactor).toBe(0)
  expect(boot.opaqueMode).toBe(false)

  await showMain('S1')
  const dom = await mainPage.evaluate(() => {
    const bar = document.querySelector('[data-testid="bar"]') as HTMLElement
    const button = document.querySelector('[data-testid="btn-history"]') as HTMLElement
    return {
      theme: document.documentElement.dataset['theme'] ?? '',
      primary: document.documentElement.dataset['primary'] ?? '',
      reduced: document.documentElement.dataset['reducedMotion'] ?? '',
      cardBackground: getComputedStyle(bar).backgroundColor,
      transitionDuration: getComputedStyle(button).transitionDuration
    }
  })
  expect(dom.theme).toBe('light')
  expect(dom.primary).toBe('gruvbox')
  expect(dom.reduced).toBe('1')
  expect(dom.transitionDuration.split(',').every((value) => value.trim() === '0s')).toBe(true)
  expect(await barAlpha()).toBeCloseTo(0.4, 2)
  expect((await mainState()).layout!.barRect.width).toBe(900)
  expect((await mainState()).bounds.width).toBe(980)

  await openSettings()
  const reopened = settingsPage!
  await expect(reopened.locator('[data-testid="opacity-range"]')).toHaveValue('40')
  await expect(reopened.locator('[data-testid="barwidth-range"]')).toHaveValue('900')
  await expect(reopened.locator('[data-testid="appearance-theme-light"]')).toBeChecked()
  await expect(reopened.locator('[data-testid="primary-gruvbox"]')).toHaveAttribute(
    'aria-pressed',
    'true'
  )

  const payload = {
    bootstrap: boot,
    dom,
    barWidth: (await mainState()).layout!.barRect.width,
    windowWidth: (await mainState()).bounds.width,
    settingsValues: {
      opacity: await reopened.locator('[data-testid="opacity-range"]').inputValue(),
      barWidth: await reopened.locator('[data-testid="barwidth-range"]').inputValue(),
      theme: 'light',
      primary: 'gruvbox'
    }
  }
  evidence.persistence = payload
  writeEvidence('task-23-persistence.json', payload)
  checks.persistedAfterRestart = true
  checks.animationFactorZero = boot.animationDurationFactor === 0
})
