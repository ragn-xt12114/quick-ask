import { _electron as electron, expect, test } from '@playwright/test'
import type { ElectronApplication, Page } from '@playwright/test'
import { execFileSync, spawn } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import type { WindowLayout, WindowState } from '../../src/shared/channels'
import { buildBlurRects, buildShapeRects, type Rect } from '../../src/shared/geometry'

interface IpcResponse<T = unknown> {
  ok: boolean
  data?: T
  error?: { code: string; message: string }
}

interface BootstrapInfo {
  appearance: { blurEnabled: boolean }
  blurStatus: { available: boolean; effectEnabled: boolean | null; compositor: boolean | null }
  opaqueMode: boolean
}

interface TestApi {
  app: {
    bootstrap(): Promise<IpcResponse<BootstrapInfo>>
  }
  window: {
    show(): Promise<IpcResponse<WindowState>>
    hide(): Promise<IpcResponse<WindowState>>
    getState(): Promise<IpcResponse<WindowState>>
    setMode(mode: string): Promise<IpcResponse<{ mode: string }>>
    openSettings(): Promise<IpcResponse<{ open: boolean }>>
    closeSettings(): Promise<IpcResponse<{ open: boolean }>>
  }
}

type TestWindow = typeof globalThis & { quickask?: TestApi; __quickaskClickCount?: number }

const EVIDENCE_DIR = resolve('.omo/evidence')
const HELPER = resolve('native/quickask-x11')

let app: ElectronApplication | undefined
let page: Page
let tempRoot = ''

function delay(ms: number): Promise<void> {
  return new Promise((resolveDelay) => setTimeout(resolveDelay, ms))
}

function pointInRect(rect: Rect, x: number, y: number): boolean {
  return x >= rect.x && x < rect.x + rect.width && y >= rect.y && y < rect.y + rect.height
}

function pointInAny(rects: Rect[], x: number, y: number): boolean {
  return rects.some((rect) => pointInRect(rect, x, y))
}

function parseShape(stdout: string): { count: number; rects: Rect[] } {
  const countMatch = stdout.match(/INPUT_SHAPE=(\d+)/)
  const rectsMatch = stdout.match(/RECTS=([^\n]*)/)
  const rects: Rect[] = []
  for (const chunk of (rectsMatch?.[1] ?? '').split(';')) {
    if (!chunk) continue
    const [x, y, width, height] = chunk.split(',').map((value) => Number(value))
    rects.push({ x: x!, y: y!, width: width!, height: height! })
  }
  return { count: Number(countMatch?.[1] ?? rects.length), rects }
}

function screenBar(layout: WindowLayout): Rect {
  return {
    x: layout.windowBounds.x + layout.barRect.x,
    y: layout.windowBounds.y + layout.barRect.y,
    width: layout.barRect.width,
    height: layout.barRect.height
  }
}


async function waitForShape(
  wid: string,
  expected: Rect[],
  gap?: { x: number; y: number }
): Promise<{ output: string; shape: { count: number; rects: Rect[] } }> {
  const deadline = Date.now() + 4000
  let output = ''
  let shape = { count: 0, rects: [] as Rect[] }
  while (Date.now() < deadline) {
    output = execFileSync(HELPER, ['query-input-shape', wid], { encoding: 'utf8' })
    shape = parseShape(output)
    const covered = expected.every((rect) =>
      pointInAny(shape.rects, rect.x + rect.width / 2, rect.y + rect.height / 2)
    )
    const gapExcluded = gap ? !pointInAny(shape.rects, gap.x, gap.y) : true
    if (covered && gapExcluded) return { output, shape }
    await delay(100)
  }
  return { output, shape }
}

async function callState(): Promise<WindowState> {
  const result = await page.evaluate(() =>
    (window as unknown as TestWindow).quickask!.window.getState()
  )
  expect(result.ok).toBe(true)
  return result.data as WindowState
}

async function waitForMode(mode: string, layout: WindowLayout | null = null): Promise<void> {
  await page.waitForFunction(
    (expected) =>
      document.querySelector('[data-testid="app-root"]')?.getAttribute('data-ui-mode') ===
      expected,
    mode
  )
  if (layout) {
    await page.waitForFunction(
      (width) => Math.abs(window.innerWidth - width) <= 1,
      layout.windowBounds.width
    )
  }
}

async function getWid(): Promise<string> {
  const value = await app!.evaluate(({ BrowserWindow }) => {
    const windows = BrowserWindow.getAllWindows()
    const main = windows.find((window) => window.getTitle() === 'QuickAsk') ?? windows[0]
    if (!main) return 0
    const handle = main.getNativeWindowHandle()
    if (!handle || handle.length < 4) return 0
    if (handle.length >= 8) return Number(handle.readBigUInt64LE(0) & 0xffffffffn)
    return handle.readUInt32LE(0)
  })
  return `0x${value.toString(16)}`
}

test.describe.configure({ mode: 'serial' })

test.beforeAll(async () => {
  tempRoot = mkdtempSync(join(tmpdir(), 'quickask-task12-'))
  for (const dir of ['config', 'data', 'state']) {
    mkdirSync(join(tempRoot, dir), { recursive: true })
  }
  mkdirSync(EVIDENCE_DIR, { recursive: true })

  app = await electron.launch({
    args: ['.'],
    env: {
      ...process.env,
      DISPLAY: process.env['DISPLAY'] ?? ':0',
      XDG_CONFIG_HOME: join(tempRoot, 'config'),
      XDG_DATA_HOME: join(tempRoot, 'data'),
      XDG_STATE_HOME: join(tempRoot, 'state'),
      QUICKASK_DATA_DIR: join(tempRoot, 'data', 'quickask-db'),
      QUICKASK_DISABLE_ONBOARDING: '1'
    }
  })
  page = await app.firstWindow()
  await page.waitForLoadState('domcontentloaded')
  await page.waitForFunction(() => Boolean((window as unknown as TestWindow).quickask))
})

test.afterAll(async () => {
  await app?.close()
})

test('S1: show from hidden, bar rect and shape are exact', async () => {
  const hidden = await callState()
  expect(hidden.mode).toBe('S0')
  expect(hidden.visible).toBe(false)

  const shown = await page.evaluate(() =>
    (window as unknown as TestWindow).quickask!.window.show()
  )
  expect(shown.ok).toBe(true)
  const state = shown.data as WindowState
  expect(state.mode).toBe('S1')
  expect(state.visible).toBe(true)
  expect(state.layout).not.toBeNull()

  await waitForMode('S1', state.layout)
  const box = await page.locator('[data-testid="bar"]').boundingBox()
  expect(box).not.toBeNull()
  expect(Math.abs(box!.x - 40)).toBeLessThanOrEqual(1)
  expect(Math.abs(box!.y - 28)).toBeLessThanOrEqual(1)
  expect(Math.abs(box!.width - 680)).toBeLessThanOrEqual(1)
  expect(Math.abs(box!.height - 48)).toBeLessThanOrEqual(1)

  await page.screenshot({
    path: resolve(EVIDENCE_DIR, 'task-12-s1.png'),
    omitBackground: true
  })

  const wid = await getWid()
  let xprop = ''
  await expect
    .poll(() => {
      try {
        const text = execFileSync('xprop', ['-id', wid, '_NET_WM_STATE'], {
          encoding: 'utf8'
        })
        const matches = [
          '_NET_WM_STATE_SKIP_TASKBAR',
          '_NET_WM_STATE_SKIP_PAGER',
          '_KDE_NET_WM_STATE_SKIP_SWITCHER',
          '_NET_WM_STATE_ABOVE'
        ].every((atom) => text.includes(atom))
        if (matches) xprop = text
        return matches ? text : ''
      } catch {
        return ''
      }
    })
    .toContain('_NET_WM_STATE_ABOVE')

  const expected = buildShapeRects(state.layout!)
  const { output: shapeOutput, shape } = await waitForShape(wid, expected)
  expect(shape.count).toBeGreaterThanOrEqual(1)
  for (const rect of expected) {
    expect(pointInAny(shape.rects, rect.x + rect.width / 2, rect.y + rect.height / 2)).toBe(true)
  }
  expect(pointInAny(shape.rects, 0, 0)).toBe(false)

  writeFileSync(
    resolve(EVIDENCE_DIR, 'task-12-xprop.txt'),
    [
      `WID=${wid}`,
      `state.layout=${JSON.stringify(state.layout)}`,
      '',
      'xprop -id <wid> _NET_WM_STATE',
      xprop,
      '',
      'quickask-x11 query-input-shape <wid>',
      shapeOutput,
      ''
    ].join('\n')
  )

  writeFileSync(
    resolve(EVIDENCE_DIR, 'task-12-anchor.json'),
    `${JSON.stringify(
      {
        display: state.display,
        modes: {
          S1: {
            windowBounds: state.layout!.windowBounds,
            barRect: state.layout!.barRect,
            screenBar: screenBar(state.layout!),
            domBar: box
          }
        }
      },
      null,
      2
    )}\n`
  )
})

test('S2: panel opens and the bar screen position does not move', async () => {
  const before = await callState()
  const beforeBar = screenBar(before.layout!)

  const result = await page.evaluate(() =>
    (window as unknown as TestWindow).quickask!.window.setMode('S2')
  )
  expect(result.ok).toBe(true)
  const state = await callState()
  expect(state.mode).toBe('S2')
  expect(state.layout?.panelRect).toBeDefined()
  await waitForMode('S2', state.layout)

  const afterBar = screenBar(state.layout!)
  expect(Math.abs(afterBar.x - beforeBar.x)).toBeLessThanOrEqual(1)
  expect(Math.abs(afterBar.y - beforeBar.y)).toBeLessThanOrEqual(1)

  const barBox = await page.locator('[data-testid="bar"]').boundingBox()
  expect(Math.abs(barBox!.x - 40)).toBeLessThanOrEqual(1)
  expect(Math.abs(barBox!.y - 28)).toBeLessThanOrEqual(1)
  await expect(page.locator('[data-testid="panel"]')).toBeVisible()

  await page.screenshot({
    path: resolve(EVIDENCE_DIR, 'task-12-s2.png'),
    omitBackground: true
  })
})

test('S3: sidebar opens, the bar stays fixed, ShapeInput matches the card union', async () => {
  const before = await callState()
  const beforeBar = screenBar(before.layout!)

  const result = await page.evaluate(() =>
    (window as unknown as TestWindow).quickask!.window.setMode('S3')
  )
  expect(result.ok).toBe(true)
  const state = await callState()
  expect(state.mode).toBe('S3')
  expect(state.layout?.sidebarRect).toBeDefined()
  expect(state.layout?.panelRect).toBeDefined()
  await waitForMode('S3', state.layout)

  const afterBar = screenBar(state.layout!)
  expect(Math.abs(afterBar.x - beforeBar.x)).toBeLessThanOrEqual(1)
  expect(Math.abs(afterBar.y - beforeBar.y)).toBeLessThanOrEqual(1)

  await expect(page.locator('[data-testid="sidebar"]')).toBeVisible()
  await expect(page.locator('[data-testid="panel"]')).toBeVisible()

  const wid = await getWid()
  const expected = buildShapeRects(state.layout!)
  const gapX = state.layout!.barRect.x + state.layout!.barRect.width / 2
  const gapY = state.layout!.barRect.y + state.layout!.barRect.height + 6
  const { output: s3ShapeOutput, shape } = await waitForShape(wid, expected, {
    x: gapX,
    y: gapY
  })
  for (const rect of expected) {
    expect(pointInAny(shape.rects, rect.x + rect.width / 2, rect.y + rect.height / 2)).toBe(true)
  }
  expect(pointInAny(shape.rects, gapX, gapY)).toBe(false)

  const blurProp = execFileSync(
    'xprop',
    ['-id', wid, '_KDE_NET_WM_BLUR_BEHIND_REGION'],
    { encoding: 'utf8' }
  )
  const actualBlur = blurProp.includes('not found')
    ? []
    : (blurProp.split('=')[1] ?? '')
        .split(',')
        .map((value) => Number(value.trim()))
        .filter((value) => Number.isFinite(value))
  const boot = await page.evaluate(() =>
    (window as unknown as TestWindow).quickask!.app.bootstrap()
  )
  expect(boot.ok).toBe(true)
  const expectedBlur =
    boot.data!.blurStatus.available &&
    boot.data!.appearance.blurEnabled &&
    !boot.data!.opaqueMode
      ? buildBlurRects(state.layout!).flatMap((rect) => [
          rect.x,
          rect.y,
          rect.width,
          rect.height
        ])
      : []
  if (expectedBlur.length === 0) {
    expect(blurProp).toContain('not found')
    expect(actualBlur).toEqual([])
  } else {
    expect(actualBlur).toEqual(expectedBlur)
  }

  writeFileSync(
    resolve(EVIDENCE_DIR, 'task-12-shape.txt'),
    [
      `WID=${wid}`,
      `layout=${JSON.stringify(state.layout)}`,
      '',
      'expected_shape=' + JSON.stringify(expected),
      'actual_shape=' + JSON.stringify(shape.rects),
      'expected_blur=' + JSON.stringify(expectedBlur),
      'actual_blur=' + JSON.stringify(actualBlur),
      '',
      s3ShapeOutput,
      blurProp,
      ''
    ].join('\n')
  )

  await page.screenshot({
    path: resolve(EVIDENCE_DIR, 'task-12-s3.png'),
    omitBackground: true
  })

  try {
    execFileSync(
      'spectacle',
      ['-b', '-n', '-f', '-o', resolve(EVIDENCE_DIR, 'task-12-desktop-s3.png')],
      { timeout: 20_000, stdio: 'ignore' }
    )
  } catch {
    // Spectacle is optional evidence; the page screenshot above is authoritative.
  }

  const anchorPath = resolve(EVIDENCE_DIR, 'task-12-anchor.json')
  const previous = JSON.parse(readFileSync(anchorPath, 'utf8')) as Record<string, unknown>
  const modes = previous['modes'] as Record<string, unknown>
  modes['S2'] = { barScreen: beforeBar }
  modes['S3'] = {
    windowBounds: state.layout!.windowBounds,
    barRect: state.layout!.barRect,
    screenBar: afterBar,
    overlay: state.layout!.overlay
  }
  previous['modes'] = modes
  writeFileSync(anchorPath, `${JSON.stringify(previous, null, 2)}\n`)
})

test('12px gap click-through reaches the window below and not the renderer', async () => {
  const state = await callState()
  expect(state.mode).toBe('S3')
  const layout = state.layout!
  const gapX = Math.round(layout.windowBounds.x + layout.barRect.x + layout.barRect.width / 2)
  const gapY = Math.round(
    layout.windowBounds.y + layout.barRect.y + layout.barRect.height + 6
  )

  const previousFocus = execFileSync('xdotool', ['getwindowfocus'], { encoding: 'utf8' }).trim()
  const xevX = Math.max(0, gapX - 300)
  const xevY = Math.max(0, gapY - 300)
  const xevGeometry = `600x600+${xevX}+${xevY}`
  const xev = spawn(
    'xev',
    ['-geometry', xevGeometry, '-name', 'QuickAskGapTarget'],
    { stdio: ['ignore', 'pipe', 'pipe'] }
  )
  let xevOutput = ''
  xev.stdout?.on('data', (data: Buffer) => {
    xevOutput += data.toString()
  })
  xev.stderr?.on('data', (data: Buffer) => {
    xevOutput += data.toString()
  })

  await delay(800)
  const beforeClicks = await page.evaluate(
    () => (window as unknown as TestWindow).__quickaskClickCount ?? 0
  )

  execFileSync('xdotool', ['mousemove', String(gapX), String(gapY), 'click', '1'], {
    timeout: 3000
  })
  await delay(500)

  const afterClicks = await page.evaluate(
    () => (window as unknown as TestWindow).__quickaskClickCount ?? 0
  )

  xev.kill('SIGTERM')
  try {
    execFileSync('xdotool', ['windowactivate', previousFocus], { timeout: 3000 })
  } catch {
    // best effort focus restore
  }

  expect(afterClicks).toBe(beforeClicks)
  expect(xevOutput).toContain('ButtonPress')

  const buttonLines = xevOutput
    .split('\n')
    .filter((line) => /ButtonPress|ButtonRelease/.test(line))
    .slice(0, 10)

  writeFileSync(
    resolve(EVIDENCE_DIR, 'task-12-clickthrough.log'),
    [
      `DISPLAY=${process.env['DISPLAY'] ?? ':0'}`,
      `gap_screen=${gapX},${gapY}`,
      `xev_geometry=${xevGeometry}`,
      '',
      '--- xev output (first 4000 chars) ---',
      xevOutput.slice(0, 4000),
      '',
      '--- button events ---',
      ...buttonLines,
      '',
      '--- summary ---',
      `renderer_clicks_before=${beforeClicks}`,
      `renderer_clicks_after=${afterClicks}`,
      `previous_focus=${previousFocus}`,
      `xev_buttonpress=${xevOutput.includes('ButtonPress')}`,
      ''
    ].join('\n')
  )
})

test('S4: settings window opens and closes independently of the hidden main window', async () => {
  const opened = await page.evaluate(() =>
    (window as unknown as TestWindow).quickask!.window.openSettings()
  )
  expect(opened.ok).toBe(true)

  await expect.poll(() => app!.windows().length).toBe(2)
  await expect
    .poll(async () => {
      const list = await app!.evaluate(({ BrowserWindow }) =>
        BrowserWindow.getAllWindows().map((window) => ({
          title: window.getTitle(),
          visible: window.isVisible(),
          url: window.webContents.getURL()
        }))
      )
      return Boolean(
        list.find((window) => window.url.includes('settings=1'))?.visible
      )
    })
    .toBe(true)
  let windows = await app!.evaluate(({ BrowserWindow }) =>
    BrowserWindow.getAllWindows().map((window) => ({
      title: window.getTitle(),
      visible: window.isVisible(),
      url: window.webContents.getURL()
    }))
  )
  const settings =
    windows.find((window) => window.title === 'QuickAsk 设置') ??
    windows.find((window) => window.url.includes('settings=1'))
  expect(settings).toBeDefined()
  expect(settings!.visible).toBe(true)
  expect(settings!.url).toContain('settings=1')

  const settingsWid = await app!.evaluate(({ BrowserWindow }) => {
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
  await expect
    .poll(() => {
      try {
        return execFileSync('xprop', ['-id', settingsWid, '_NET_WM_STATE'], {
          encoding: 'utf8'
        })
      } catch {
        return ''
      }
    })
    .toContain('_NET_WM_STATE_SKIP_TASKBAR')
  await expect
    .poll(() => {
      try {
        return execFileSync('xprop', ['-id', settingsWid, '_NET_WM_STATE'], {
          encoding: 'utf8'
        })
      } catch {
        return ''
      }
    })
    .toContain('_NET_WM_STATE_SKIP_PAGER')
  await expect
    .poll(() => {
      try {
        return execFileSync('xprop', ['-id', settingsWid, '_NET_WM_STATE'], {
          encoding: 'utf8'
        })
      } catch {
        return ''
      }
    })
    .toContain('_KDE_NET_WM_STATE_SKIP_SWITCHER')
  const requireAtoms = [
    '_NET_WM_STATE_SKIP_TASKBAR',
    '_NET_WM_STATE_SKIP_PAGER',
    '_KDE_NET_WM_STATE_SKIP_SWITCHER'
  ]
  let settingsXprop = ''
  await expect
    .poll(() => {
      try {
        const text = execFileSync('xprop', ['-id', settingsWid, '_NET_WM_STATE'], {
          encoding: 'utf8'
        })
        const matches = requireAtoms.every((atom) => text.includes(atom))
        if (matches) settingsXprop = text
        return matches ? text : ''
      } catch {
        return ''
      }
    })
    .toContain('_KDE_NET_WM_STATE_SKIP_SWITCHER')

  const closed = await page.evaluate(() =>
    (window as unknown as TestWindow).quickask!.window.closeSettings()
  )
  expect(closed.ok).toBe(true)
  await expect.poll(() => app!.windows().length).toBe(1)

  await page.evaluate(() => (window as unknown as TestWindow).quickask!.window.hide())
  const reopened = await page.evaluate(() =>
    (window as unknown as TestWindow).quickask!.window.openSettings()
  )
  expect(reopened.ok).toBe(true)
  await expect.poll(() => app!.windows().length).toBe(2)
  await expect
    .poll(async () => {
      const list = await app!.evaluate(({ BrowserWindow }) =>
        BrowserWindow.getAllWindows().map((window) => ({
          visible: window.isVisible(),
          url: window.webContents.getURL()
        }))
      )
      return Boolean(
        list.find((window) => window.url.includes('settings=1'))?.visible
      )
    })
    .toBe(true)

  windows = await app!.evaluate(({ BrowserWindow }) =>
    BrowserWindow.getAllWindows().map((window) => ({
      title: window.getTitle(),
      visible: window.isVisible(),
      url: window.webContents.getURL()
    }))
  )
  const independentSettings =
    windows.find((window) => window.title === 'QuickAsk 设置') ??
    windows.find((window) => window.url.includes('settings=1'))
  const main = windows.find((window) => !window.url.includes('settings=1'))
  expect(independentSettings?.visible).toBe(true)
  expect(main?.visible).toBe(false)

  await page.evaluate(() =>
    (window as unknown as TestWindow).quickask!.window.closeSettings()
  )
  await expect.poll(() => app!.windows().length).toBe(1)

  writeFileSync(
    resolve(EVIDENCE_DIR, 'task-12-s4.json'),
    `${JSON.stringify({ opened, closed, reopened, windows, settingsWid, settingsXprop }, null, 2)}\n`
  )
})
