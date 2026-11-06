import { _electron as electron, expect, test } from '@playwright/test'
import type { ElectronApplication, Page } from '@playwright/test'
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import type { WindowLayout } from '../../src/shared/channels'

interface IpcResponse<T> {
  ok: boolean
  data?: T
  error?: { code: string; message: string }
}

interface VisualState {
  mode: string
  visible: boolean
  layout: WindowLayout | null
}

interface VisualApi {
  window: {
    show(): Promise<IpcResponse<VisualState>>
    getState(): Promise<IpcResponse<VisualState>>
    setMode(mode: string): Promise<IpcResponse<{ mode: string }>>
    setHeight(request: {
      panelHeight?: number
      barLines?: number
      height?: number
    }): Promise<IpcResponse<{ height: number; barLines: number; panelHeight: number }>>
  }
}

type TestWindow = typeof globalThis & { quickask?: VisualApi }

interface RequestRecord {
  url: string
  method: string
  resourceType: string
}

const EVIDENCE_DIR = resolve('.omo/evidence')
const SNAPSHOT_NOTE = 'tests/visual/layout.spec.ts-snapshots'

let app: ElectronApplication | undefined
let page: Page
let tempRoot = ''

const requests: RequestRecord[] = []
const pageErrors: string[] = []
const consoleErrors: string[] = []

const geometry: Record<string, unknown> = {}
const typographyEvidence: Record<string, unknown> = {}

function isExternalUrl(rawUrl: string): boolean {
  return !/^(file|data):/i.test(rawUrl)
}

async function callState(): Promise<VisualState> {
  const result = await page.evaluate(() =>
    (window as unknown as TestWindow).quickask!.window.getState()
  )
  expect(result.ok).toBe(true)
  return result.data as VisualState
}

async function settle(): Promise<void> {
  await page.evaluate(async () => {
    await document.fonts.ready
    await new Promise<void>((resolveFrame) => {
      requestAnimationFrame(() => requestAnimationFrame(() => resolveFrame()))
    })
  })
}

async function waitForLayout(mode: string, width: number, height: number): Promise<void> {
  await page.waitForFunction(
    (expected) => {
      const root = document.querySelector('[data-testid="app-root"]')
      return (
        root?.getAttribute('data-ui-mode') === expected.mode &&
        Math.abs(window.innerWidth - expected.width) <= 1 &&
        Math.abs(window.innerHeight - expected.height) <= 1
      )
    },
    { mode, width, height }
  )
  await settle()
}

async function screenshotInto(path: string): Promise<void> {
  await page.screenshot({ path, animations: 'disabled', caret: 'hide', scale: 'css' })
}

test.describe.configure({ mode: 'serial' })

test.beforeAll(async () => {
  tempRoot = mkdtempSync(join(tmpdir(), 'quickask-task14-'))
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

  page.on('request', (request) => {
    requests.push({
      url: request.url(),
      method: request.method(),
      resourceType: request.resourceType()
    })
  })
  page.on('pageerror', (error) => pageErrors.push(error.message))
  page.on('console', (message) => {
    if (message.type() === 'error') consoleErrors.push(message.text())
  })

  await page.waitForLoadState('domcontentloaded')
  await page.waitForFunction(() => Boolean((window as unknown as TestWindow).quickask))

  const baseUrl = page.url().split('?')[0]!
  await page.goto(`${baseUrl}?visual=1`)
  await page.waitForLoadState('domcontentloaded')
  await page.waitForFunction(() => Boolean((window as unknown as TestWindow).quickask))
  await page.waitForFunction(
    () => document.documentElement.getAttribute('data-visual') === '1'
  )
  await settle()

  const shown = await page.evaluate(() =>
    (window as unknown as TestWindow).quickask!.window.show()
  )
  expect(shown.ok).toBe(true)
  expect((shown.data as VisualState).mode).toBe('S1')
})

test.afterAll(async () => {
  const externalRequests = requests.filter((request) => isExternalUrl(request.url))
  const externalResources = await page
    .evaluate(() =>
      performance
        .getEntriesByType('resource')
        .map((entry) => entry.name)
        .filter((url) => !/^(file|data):/i.test(url))
    )
    .catch(() => [])

  writeFileSync(
    resolve(EVIDENCE_DIR, 'task-14-network.json'),
    `${JSON.stringify(
      {
        visualModeUrl: page.url(),
        devicePixelRatio: await page
          .evaluate(() => window.devicePixelRatio)
          .catch(() => null),
        totalRequests: requests.length,
        protocols: [...new Set(requests.map((request) => new URL(request.url).protocol))],
        requests,
        externalRequests,
        externalResources,
        pageErrors,
        unexpectedConsoleErrors: consoleErrors.filter(
          (message) =>
            !/Content Security Policy|Refused to connect|Refused to load|permission|Permission/i.test(
              message
            )
        ),
        fonts: typographyEvidence,
        snapshots: SNAPSHOT_NOTE
      },
      null,
      2
    )}\n`
  )

  writeFileSync(
    resolve(EVIDENCE_DIR, 'task-14-visual.log'),
    [
      'Task 14 visual baseline (100% scale, visual=1 solid backdrop)',
      `url=${page.url()}`,
      `devicePixelRatio=${await page.evaluate(() => window.devicePixelRatio).catch(() => '?')}`,
      '',
      ...Object.entries(geometry).map(([key, value]) => `${key}=${JSON.stringify(value)}`),
      '',
      `totalRequests=${requests.length}`,
      `externalRequests=${externalRequests.length}`,
      `externalResources=${externalResources.length}`,
      `pageErrors=${pageErrors.length}`,
      `snapshots=${SNAPSHOT_NOTE}/{s1,s2,s3}.png`,
      ''
    ].join('\n')
  )
})

test('S1: capsule geometry, token colors, disabled states and CJK font', async () => {
  const state = await callState()
  expect(state.mode).toBe('S1')
  expect(state.layout?.barRect).toEqual({ x: 40, y: 28, width: 680, height: 48 })
  await waitForLayout('S1', 760, 128)

  const snapshot = await page.evaluate(() => {
    const query = (selector: string): HTMLElement => {
      const element = document.querySelector(selector)
      if (!element) throw new Error(`missing ${selector}`)
      return element as HTMLElement
    }
    const box = (element: Element) => {
      const rect = element.getBoundingClientRect()
      return {
        x: rect.x,
        y: rect.y,
        width: rect.width,
        height: rect.height,
        right: rect.right,
        bottom: rect.bottom
      }
    }
    const style = (element: Element) => getComputedStyle(element)
    const bar = query('[data-testid="bar"]')
    const history = query('[data-testid="btn-history"]')
    const expand = query('[data-testid="btn-expand"]')
    const newButton = query('[data-testid="btn-new"]')
    const divider = query('[data-testid="bar-divider"]')
    const composer = query('[data-testid="composer"]') as HTMLInputElement
    const send = query('[data-testid="btn-send"]') as HTMLButtonElement
    const barStyle = style(bar)

    return {
      bar: box(bar),
      barRadius: barStyle.borderRadius,
      paddingLeft: barStyle.paddingLeft,
      paddingRight: barStyle.paddingRight,
      barBackground: barStyle.backgroundColor,
      barShadow: barStyle.boxShadow,
      barRegion: barStyle.getPropertyValue('-webkit-app-region'),
      childOrder: Array.from(bar.children).map(
        (child) => child.getAttribute('data-testid') ?? child.className
      ),
      history: box(history),
      expand: box(expand),
      newButton: box(newButton),
      divider: box(divider),
      dividerMargins: [
        style(divider).marginLeft,
        style(divider).marginRight
      ],
      composer: box(composer),
      composerMinWidth: style(composer).minWidth,
      composerPlaceholder: composer.placeholder,
      composerFontSize: style(composer).fontSize,
      composerRegion: style(composer).getPropertyValue('-webkit-app-region'),
      send: box(send),
      sendDisabled: send.disabled,
      sendOpacity: style(send).opacity,
      sendRadius: style(send).borderRadius,
      sendFontIconRegion: style(send).getPropertyValue('-webkit-app-region'),
      historyDisabled: (history as HTMLButtonElement).disabled,
      expandDisabled: (expand as HTMLButtonElement).disabled,
      newDisabled: (newButton as HTMLButtonElement).disabled,
      historyTooltip: history.getAttribute('title'),
      expandTooltip: expand.getAttribute('title'),
      newTooltip: newButton.getAttribute('title'),
      historyAria: history.getAttribute('aria-label'),
      expandAria: expand.getAttribute('aria-label'),
      newAria: newButton.getAttribute('aria-label'),
      fontFamily: barStyle.fontFamily,
      fontCheck: document.fonts.check('14px "Noto Sans CJK SC"'),
      visualMode: document.documentElement.getAttribute('data-visual'),
      backdrop: getComputedStyle(document.documentElement).backgroundColor,
      dpr: window.devicePixelRatio
    }
  })

  expect(snapshot.bar.width).toBe(680)
  expect(snapshot.bar.height).toBe(48)
  expect(snapshot.barRadius).toBe('24px')
  expect(snapshot.paddingLeft).toBe('8px')
  expect(snapshot.paddingRight).toBe('6px')
  expect(snapshot.barBackground).toBe('rgba(24, 26, 28, 0.72)')
  expect(snapshot.barShadow).toContain('0px 12px 40px')
  expect(snapshot.barShadow).toContain('inset')
  expect(snapshot.barRegion).toBe('drag')
  expect(snapshot.composerRegion).toBe('no-drag')
  expect(snapshot.sendFontIconRegion).toBe('no-drag')

  expect(snapshot.childOrder).toEqual([
    'btn-history',
    'btn-expand',
    'btn-new',
    'bar-divider',
    'composer',
    'btn-send'
  ])
  for (const button of [snapshot.history, snapshot.expand, snapshot.newButton]) {
    expect(button.width).toBe(32)
    expect(button.height).toBe(32)
  }
  expect(snapshot.expand.x - snapshot.history.right).toBe(2)
  expect(snapshot.newButton.x - snapshot.expand.right).toBe(2)
  expect(snapshot.divider.width).toBe(1)
  expect(snapshot.divider.height).toBe(20)
  expect(snapshot.divider.x - snapshot.newButton.right).toBe(8)
  expect(snapshot.dividerMargins).toEqual(['8px', '8px'])
  expect(snapshot.composer.x - snapshot.divider.right).toBe(8)
  expect(snapshot.composerMinWidth).toBe('240px')
  expect(snapshot.composer.width).toBeGreaterThanOrEqual(240)
  expect(snapshot.composerPlaceholder).toBe('问点什么…')
  expect(snapshot.composerFontSize).toBe('15px')
  expect(snapshot.send.width).toBe(36)
  expect(snapshot.send.height).toBe(36)
  expect(snapshot.sendRadius).toBe('50%')
  expect(snapshot.bar.right - snapshot.send.right).toBe(6)
  expect(snapshot.sendDisabled).toBe(true)
  expect(snapshot.sendOpacity).toBe('0.35')
  expect(snapshot.expandDisabled).toBe(true)
  expect(snapshot.historyDisabled).toBe(false)
  expect(snapshot.newDisabled).toBe(false)
  expect(snapshot.historyTooltip).toBe('历史 (Ctrl+H)')
  expect(snapshot.expandTooltip).toBe('展开对话')
  expect(snapshot.newTooltip).toBe('新建会话 (Ctrl+N)')
  expect(snapshot.historyAria).toBe('历史')
  expect(snapshot.expandAria).toBe('展开对话')
  expect(snapshot.newAria).toBe('新建会话')
  expect(snapshot.fontFamily).toContain('Noto Sans CJK SC')
  expect(snapshot.fontCheck).toBe(true)
  expect(snapshot.visualMode).toBe('1')
  expect(snapshot.backdrop).toBe('rgb(43, 47, 54)')
  expect(snapshot.dpr).toBe(1)

  Object.assign(geometry, { s1: snapshot })

  await screenshotInto(resolve(EVIDENCE_DIR, 'task-14-s1.png'))
  await expect(page).toHaveScreenshot('s1.png', {
    animations: 'disabled',
    caret: 'hide',
    scale: 'css'
  })
})

test('S2: panel shell, message spacing, code/table tokens and no inner input', async () => {
  const opened = await page.evaluate(() =>
    (window as unknown as TestWindow).quickask!.window.setMode('S2')
  )
  expect(opened.ok).toBe(true)
  const height = await page.evaluate(() =>
    (window as unknown as TestWindow).quickask!.window.setHeight({ panelHeight: 420 })
  )
  expect(height.ok).toBe(true)
  await waitForLayout('S2', 760, 560)

  const state = await callState()
  expect(state.mode).toBe('S2')
  expect(state.layout?.barRect).toEqual({ x: 40, y: 28, width: 680, height: 48 })
  expect(state.layout?.panelRect).toEqual({ x: 40, y: 88, width: 680, height: 420 })

  const snapshot = await page.evaluate(() => {
    const query = (selector: string): HTMLElement => {
      const element = document.querySelector(selector)
      if (!element) throw new Error(`missing ${selector}`)
      return element as HTMLElement
    }
    const box = (element: Element) => {
      const rect = element.getBoundingClientRect()
      return {
        x: rect.x,
        y: rect.y,
        width: rect.width,
        height: rect.height,
        right: rect.right,
        bottom: rect.bottom
      }
    }
    const style = (element: Element) => getComputedStyle(element)
    const bar = query('[data-testid="bar"]')
    const panel = query('[data-testid="panel"]')
    const panelStyle = style(panel)
    const body = query('[data-testid="panel-body"]')
    const title = query('[data-testid="panel-title"]')
    const model = query('[data-testid="panel-model"]')
    const user = query('[data-role="user"]')
    const userStyle = style(user)
    const assistant = query('[data-role="assistant"]')
    const assistantStyle = style(assistant)
    const code = query('[data-testid="code-block"]')
    const codeStyle = style(code)
    const codeCopy = query('[data-testid="code-copy"]')
    const table = query('.qa-table-wrap')
    const tableStyle = style(table)
    const firstCell = query('.qa-table th')
    const textStyle = style(query('.qa-table td'))

    return {
      bar: box(bar),
      panel: box(panel),
      panelRadius: panelStyle.borderRadius,
      panelPadding: panelStyle.padding,
      panelBackground: panelStyle.backgroundColor,
      panelMinHeight: panelStyle.minHeight,
      bodyMaxHeight: style(body).maxHeight,
      infoRow: box(query('.qa-panel-info')),
      title: { box: box(title), fontSize: style(title).fontSize, color: style(title).color, overflow: style(title).textOverflow, whiteSpace: style(title).whiteSpace },
      model: { box: box(model), fontSize: style(model).fontSize, color: style(model).color },
      user: {
        box: box(user),
        background: userStyle.backgroundColor,
        borderRadius: [userStyle.borderTopLeftRadius, userStyle.borderTopRightRadius, userStyle.borderBottomRightRadius, userStyle.borderBottomLeftRadius],
        padding: userStyle.padding,
        fontSize: userStyle.fontSize
      },
      assistant: {
        box: box(assistant),
        fontSize: assistantStyle.fontSize,
        lineHeight: assistantStyle.lineHeight,
        background: assistantStyle.backgroundColor
      },
      code: {
        box: box(code),
        background: codeStyle.backgroundColor,
        radius: codeStyle.borderRadius,
        fontFamily: style(query('.qa-code-pre')).fontFamily,
        fontSize: style(query('.qa-code-pre')).fontSize,
        copyOpacity: style(codeCopy).opacity
      },
      table: {
        borderColor: tableStyle.borderTopColor,
        borderWidth: tableStyle.borderTopWidth,
        headerBackground: style(firstCell).backgroundColor,
        fontSize: textStyle.fontSize
      },
      hasInputInsidePanel: panel.querySelectorAll('input, textarea').length,
      gapBarPanel: box(panel).y - (box(bar).y + box(bar).height),
      userToAssistantGap: box(assistant).y - (box(user).y + box(user).height)
    }
  })

  expect(snapshot.panel.width).toBe(680)
  expect(snapshot.panel.height).toBe(420)
  expect(snapshot.panelRadius).toBe('16px')
  expect(snapshot.panelPadding).toBe('16px')
  expect(snapshot.panelBackground).toBe('rgba(24, 26, 28, 0.72)')
  expect(snapshot.panelMinHeight).toBe('120px')
  expect(snapshot.bodyMaxHeight).toBe('336px')
  expect(snapshot.gapBarPanel).toBe(12)
  expect(snapshot.infoRow.height).toBe(28)
  expect(snapshot.title.fontSize).toBe('13px')
  expect(snapshot.title.overflow).toBe('ellipsis')
  expect(snapshot.title.whiteSpace).toBe('nowrap')
  expect(snapshot.model.fontSize).toBe('12px')
  expect(snapshot.user.background).toBe('rgba(127, 187, 179, 0.12)')
  expect(snapshot.user.borderRadius).toEqual(['12px', '12px', '4px', '12px'])
  expect(snapshot.user.padding).toBe('10px 14px')
  expect(snapshot.user.fontSize).toBe('14px')
  expect(snapshot.user.box.right).toBeGreaterThan(snapshot.panel.x + snapshot.panel.width / 2)
  expect(snapshot.user.box.width).toBeLessThanOrEqual(
    (snapshot.panel.width - 32) * 0.78 + 1
  )
  expect(snapshot.assistant.fontSize).toBe('14px')
  expect(snapshot.assistant.lineHeight).toBe('23.8px')
  expect(snapshot.assistant.box.x).toBeCloseTo(snapshot.panel.x + 16, 1)
  expect(snapshot.userToAssistantGap).toBe(16)
  expect(snapshot.code.background).toBe('rgba(0, 0, 0, 0.28)')
  expect(snapshot.code.radius).toBe('8px')
  expect(snapshot.code.fontSize).toBe('13px')
  expect(snapshot.code.fontFamily).toContain('LXGW WenKai Mono')
  expect(snapshot.code.copyOpacity).toBe('0')
  expect(snapshot.table.borderColor).toBe('rgba(255, 255, 255, 0.08)')
  expect(snapshot.table.borderWidth).toBe('1px')
  expect(snapshot.table.headerBackground).toBe('rgba(255, 255, 255, 0.04)')
  expect(snapshot.hasInputInsidePanel).toBe(0)

  const codeBox = await page.locator('[data-testid="code-block"]').boundingBox()
  await page.mouse.move(codeBox!.x + codeBox!.width / 2, codeBox!.y + codeBox!.height / 2)
  expect(
    await page.locator('[data-testid="code-copy"]').evaluate((element) =>
      getComputedStyle(element).opacity
    )
  ).toBe('1')
  await page.mouse.move(0, 0)
  await settle()

  Object.assign(geometry, { s2: snapshot })

  await screenshotInto(resolve(EVIDENCE_DIR, 'task-14-s2.png'))
  await expect(page).toHaveScreenshot('s2.png', {
    animations: 'disabled',
    caret: 'hide',
    scale: 'css'
  })
})

test('S3: sidebar geometry, groups, current marker and hover-only menu', async () => {
  const opened = await page.evaluate(() =>
    (window as unknown as TestWindow).quickask!.window.setMode('S3')
  )
  expect(opened.ok).toBe(true)
  await waitForLayout('S3', 1032, 560)

  const state = await callState()
  expect(state.mode).toBe('S3')
  expect(state.layout?.barRect).toEqual({ x: 312, y: 28, width: 680, height: 48 })
  expect(state.layout?.panelRect).toEqual({ x: 312, y: 88, width: 680, height: 420 })
  expect(state.layout?.sidebarRect).toEqual({ x: 40, y: 28, width: 260, height: 480 })

  const snapshot = await page.evaluate(() => {
    const query = (selector: string): HTMLElement => {
      const element = document.querySelector(selector)
      if (!element) throw new Error(`missing ${selector}`)
      return element as HTMLElement
    }
    const box = (element: Element) => {
      const rect = element.getBoundingClientRect()
      return {
        x: rect.x,
        y: rect.y,
        width: rect.width,
        height: rect.height,
        right: rect.right,
        bottom: rect.bottom
      }
    }
    const style = (element: Element) => getComputedStyle(element)
    const sidebar = query('[data-testid="sidebar"]')
    const sidebarStyle = style(sidebar)
    const bar = query('[data-testid="bar"]')
    const panel = query('[data-testid="panel"]')
    const search = query('[data-testid="sidebar-search"]') as HTMLInputElement
    const searchStyle = style(search)
    const item = query('.qa-session-item--current')
    const itemStyle = style(item)
    const marker = getComputedStyle(item, '::before')
    const more = query('.qa-session-more')
    const moreBox = item.querySelector('.qa-session-more') as HTMLElement

    return {
      sidebar: box(sidebar),
      sidebarRadius: sidebarStyle.borderRadius,
      sidebarPadding: sidebarStyle.padding,
      sidebarBackground: sidebarStyle.backgroundColor,
      bar: box(bar),
      panel: box(panel),
      gapSidebarBar: box(bar).x - (box(sidebar).x + box(sidebar).width),
      gapBarPanel: box(panel).y - (box(bar).y + box(bar).height),
      titleRow: box(query('.qa-sidebar-title-row')),
      search: {
        box: box(search),
        radius: searchStyle.borderRadius,
        background: searchStyle.backgroundColor,
        placeholder: search.placeholder,
        fontSize: searchStyle.fontSize
      },
      groupLabel: box(query('.qa-sidebar-group-label')),
      groupLabelFontSize: style(query('.qa-sidebar-group-label')).fontSize,
      groupLabelColor: style(query('.qa-sidebar-group-label')).color,
      item: box(item),
      itemRadius: itemStyle.borderRadius,
      itemPaddingLeft: itemStyle.paddingLeft,
      itemBackground: itemStyle.backgroundColor,
      markerWidth: marker.width,
      markerColor: marker.backgroundColor,
      title: {
        fontSize: style(query('.qa-session-title')).fontSize,
        overflow: style(query('.qa-session-title')).textOverflow,
        whiteSpace: style(query('.qa-session-title')).whiteSpace
      },
      timeFontSize: style(query('.qa-session-time')).fontSize,
      moreOpacity: style(more).opacity,
      moreBox: moreBox ? moreBox.getBoundingClientRect().width : 0,
      footer: box(query('.qa-sidebar-footer')),
      footerText: query('.qa-footer-settings').textContent?.trim(),
      version: query('[data-testid="sidebar-version"]').textContent?.trim(),
      currentCount: document.querySelectorAll('.qa-session-item--current').length,
      groupLabels: Array.from(document.querySelectorAll('.qa-sidebar-group-label')).map(
        (element) => element.textContent?.trim()
      )
    }
  })

  expect(snapshot.sidebar.width).toBe(260)
  expect(snapshot.sidebar.height).toBe(480)
  expect(snapshot.sidebarRadius).toBe('16px')
  expect(snapshot.sidebarPadding).toBe('12px')
  expect(snapshot.sidebarBackground).toBe('rgba(24, 26, 28, 0.72)')
  expect(snapshot.gapSidebarBar).toBe(12)
  expect(snapshot.gapBarPanel).toBe(12)
  expect(snapshot.titleRow.height).toBe(32)
  expect(snapshot.search.box.height).toBe(36)
  expect(snapshot.search.box.width).toBe(236)
  expect(snapshot.search.radius).toBe('8px')
  expect(snapshot.search.background).toBe('rgba(0, 0, 0, 0.2)')
  expect(snapshot.search.placeholder).toBe('搜索会话…')
  expect(snapshot.groupLabel.height).toBe(24)
  expect(snapshot.groupLabelFontSize).toBe('12px')
  expect(snapshot.groupLabelColor).toBe('rgba(255, 255, 255, 0.4)')
  expect(snapshot.groupLabels).toEqual(['今天', '昨天', '更早'])
  expect(snapshot.item.height).toBe(48)
  expect(snapshot.itemRadius).toBe('8px')
  expect(snapshot.itemPaddingLeft).toBe('10px')
  expect(snapshot.itemBackground).toBe('rgba(255, 255, 255, 0.08)')
  expect(snapshot.markerWidth).toBe('2px')
  expect(snapshot.markerColor).toBe('rgb(127, 187, 179)')
  expect(snapshot.title.fontSize).toBe('13px')
  expect(snapshot.title.overflow).toBe('ellipsis')
  expect(snapshot.title.whiteSpace).toBe('nowrap')
  expect(snapshot.timeFontSize).toBe('11px')
  expect(snapshot.moreOpacity).toBe('0')
  expect(snapshot.moreBox).toBe(24)
  expect(snapshot.footer.height).toBe(32)
  expect(snapshot.footerText).toBe('设置')
  expect(snapshot.version).toBe('v0.1')
  expect(snapshot.currentCount).toBe(1)

  const firstItem = await page.locator('.qa-session-item--current').boundingBox()
  await page.mouse.move(firstItem!.x + firstItem!.width / 2, firstItem!.y + firstItem!.height / 2)
  expect(
    await page.locator('.qa-session-item--current .qa-session-more').evaluate((element) =>
      getComputedStyle(element).opacity
    )
  ).toBe('1')
  await page.mouse.move(0, 0)
  await settle()

  Object.assign(geometry, { s3: snapshot })

  await screenshotInto(resolve(EVIDENCE_DIR, 'task-14-s3.png'))
  await expect(page).toHaveScreenshot('s3.png', {
    animations: 'disabled',
    caret: 'hide',
    scale: 'css'
  })
})

test('tokens, fonts, no CDN network and no remote @font-face', async () => {
  const evidence = await page.evaluate(() => {
    const root = getComputedStyle(document.documentElement)
    const read = (name: string): string => root.getPropertyValue(name).trim()
    const geometryTokens = {
      w: read('--w'),
      barWidth: read('--bar-width'),
      barHeight: read('--bar-h'),
      barRadius: read('--r-bar'),
      cardRadius: read('--r-card'),
      gap: read('--gap'),
      sidebarWidth: read('--sidebar-w'),
      panelMinHeight: read('--panel-min-h'),
      panelMaxHeight: read('--panel-max-h'),
      padding: read('--pad'),
      iconButton: read('--icon-btn'),
      iconSize: read('--icon-size'),
      sendButton: read('--send-btn'),
      sendIcon: read('--send-icon')
    }
    const spacing = {
      s2: read('--space-2'),
      s4: read('--space-4'),
      s8: read('--space-8'),
      s12: read('--space-12'),
      s16: read('--space-16'),
      s24: read('--space-24')
    }
    const fontSize = {
      body: read('--fs-body'),
      input: read('--fs-input'),
      title: read('--fs-title'),
      titleLg: read('--fs-title-lg'),
      secondary: read('--fs-secondary'),
      time: read('--fs-time'),
      code: read('--fs-code')
    }
    const darkColors = {
      cardBackground: read('--card-bg'),
      cardBorder: read('--card-border'),
      cardShadow: read('--card-shadow'),
      text1: read('--text-1'),
      text2: read('--text-2'),
      text3: read('--text-3'),
      primary: read('--primary'),
      opaque: read('--bg-opaque')
    }
    const presets: Record<string, string> = {}
    const presetNames = [
      'everforest',
      'nord',
      'kanagawa',
      'gruvbox',
      'solarized',
      'catppuccin'
    ]
    for (const name of presetNames) {
      const probe = document.createElement('div')
      probe.className = `primary-${name}`
      document.body.appendChild(probe)
      presets[name] = getComputedStyle(probe).getPropertyValue('--primary').trim()
      probe.remove()
    }
    const lightProbe = document.createElement('div')
    lightProbe.setAttribute('data-theme', 'light')
    document.body.appendChild(lightProbe)
    const lightStyle = getComputedStyle(lightProbe)
    const light = {
      cardBackground: lightStyle.getPropertyValue('--card-bg').trim(),
      cardBorder: lightStyle.getPropertyValue('--card-border').trim(),
      cardShadow: lightStyle.getPropertyValue('--card-shadow').trim(),
      text1: lightStyle.getPropertyValue('--text-1').trim(),
      text2: lightStyle.getPropertyValue('--text-2').trim(),
      text3: lightStyle.getPropertyValue('--text-3').trim(),
      opaque: lightStyle.getPropertyValue('--bg-opaque').trim()
    }
    lightProbe.remove()

    const fontFaces: string[] = []
    for (const sheet of Array.from(document.styleSheets)) {
      try {
        for (const rule of Array.from(sheet.cssRules)) {
          if (rule.type === CSSRule.FONT_FACE_RULE) {
            fontFaces.push((rule as CSSFontFaceRule).style.getPropertyValue('src'))
          }
        }
      } catch {
        fontFaces.push('unreadable-stylesheet')
      }
    }

    const sample = document.createElement('span')
    sample.textContent = '中文渲染检查'
    sample.style.position = 'absolute'
    sample.style.visibility = 'hidden'
    sample.style.whiteSpace = 'nowrap'
    sample.style.fontFamily = read('--font-ui')
    sample.style.fontSize = read('--fs-body')
    document.body.appendChild(sample)
    const cjkWidth = sample.getBoundingClientRect().width
    sample.remove()

    const resources = performance
      .getEntriesByType('resource')
      .map((entry) => entry.name)

    return {
      geometryTokens,
      spacing,
      fontSize,
      darkColors,
      fontStack: read('--font-ui'),
      monoStack: read('--font-mono'),
      presets,
      light,
      fontFaces,
      externalStylesheets: Array.from(
        document.querySelectorAll<HTMLLinkElement>('link[rel="stylesheet"]')
      )
        .map((link) => link.href)
        .filter((href) => !/^(file|data):/i.test(href)),
      fontCheck: document.fonts.check('14px "Noto Sans CJK SC"'),
      fontStatus: document.fonts.status,
      cjkWidth,
      resources,
      externalResources: resources.filter((url) => !/^(file|data):/i.test(url)),
      dpr: window.devicePixelRatio
    }
  })

  expect(evidence.geometryTokens).toEqual({
    w: '680px',
    barWidth: '680px',
    barHeight: '48px',
    barRadius: '24px',
    cardRadius: '16px',
    gap: '12px',
    sidebarWidth: '260px',
    panelMinHeight: '120px',
    panelMaxHeight: 'min(560px, 60vh)',
    padding: '16px',
    iconButton: '32px',
    iconSize: '18px',
    sendButton: '36px',
    sendIcon: '16px'
  })
  expect(evidence.spacing).toEqual({
    s2: '2px',
    s4: '4px',
    s8: '8px',
    s12: '12px',
    s16: '16px',
    s24: '24px'
  })
  expect(evidence.fontSize).toEqual({
    body: '14px',
    input: '15px',
    title: '13px',
    titleLg: '14px',
    secondary: '12px',
    time: '11px',
    code: '13px'
  })
  expect(evidence.darkColors).toEqual({
    cardBackground: 'rgba(24, 26, 28, 0.72)',
    cardBorder: 'rgba(255, 255, 255, 0.1)',
    cardShadow: '0 12px 40px rgba(0, 0, 0, 0.45)',
    text1: 'rgba(255, 255, 255, 0.92)',
    text2: 'rgba(255, 255, 255, 0.62)',
    text3: 'rgba(255, 255, 255, 0.4)',
    primary: '#7fbbb3',
    opaque: '#1c1e20'
  })
  expect(evidence.light).toEqual({
    cardBackground: 'rgba(250, 250, 248, 0.78)',
    cardBorder: 'rgba(0, 0, 0, 0.08)',
    cardShadow: '0 8px 28px rgba(0, 0, 0, 0.16)',
    text1: 'rgba(0, 0, 0, 0.88)',
    text2: 'rgba(0, 0, 0, 0.6)',
    text3: 'rgba(0, 0, 0, 0.42)',
    opaque: '#fafaf8'
  })
  expect(Object.keys(evidence.presets)).toHaveLength(6)
  expect(new Set(Object.values(evidence.presets)).size).toBe(6)
  expect(evidence.presets['everforest']).toBe('#7fbbb3')
  expect(evidence.fontStack).toContain('Noto Sans CJK SC')
  expect(evidence.fontStack).toContain('Noto Sans SC')
  expect(evidence.fontStack).toContain('Source Han Sans SC')
  expect(evidence.monoStack).toContain('LXGW WenKai Mono')
  expect(evidence.monoStack).toContain('Noto Sans Mono CJK SC')
  expect(evidence.fontFaces).toEqual([])
  expect(evidence.externalStylesheets).toEqual([])
  expect(evidence.fontCheck).toBe(true)
  expect(evidence.fontStatus).toBe('loaded')
  expect(evidence.cjkWidth).toBeGreaterThan(0)
  expect(evidence.dpr).toBe(1)
  expect(evidence.externalResources).toEqual([])

  const externalRequests = requests.filter((request) => isExternalUrl(request.url))
  expect(externalRequests).toEqual([])
  expect(evidence.resources).toEqual([])
  expect(requests.some((request) => request.resourceType === 'stylesheet')).toBe(true)
  expect(requests.some((request) => request.resourceType === 'script')).toBe(true)
  expect(
    [...requests, ...evidence.resources.map((url) => ({ url }))].every((entry) =>
      /^(file|data):/i.test(entry.url)
    )
  ).toBe(true)

  const componentCss = readFileSync(
    resolve('src/renderer/src/styles/components.css'),
    'utf8'
  ).replace(/\/\*[\s\S]*?\*\//g, '')
  expect(componentCss).not.toMatch(/\b\d+(?:\.\d+)?px\b/)
  expect(componentCss).not.toMatch(/#[0-9a-f]{3,8}\b/i)
  expect(componentCss).not.toMatch(/rgba?\(/)
  expect(componentCss).not.toContain('@font-face')

  const tokensCss = readFileSync(resolve('src/renderer/src/styles/tokens.css'), 'utf8')
  expect(tokensCss).not.toContain('@font-face')
  expect(tokensCss).not.toMatch(/https?:\/\//i)

  typographyEvidence.fontStack = evidence.fontStack
  typographyEvidence.monoStack = evidence.monoStack
  typographyEvidence.fontCheck = evidence.fontCheck
  typographyEvidence.fontStatus = evidence.fontStatus
  typographyEvidence.cjkWidth = evidence.cjkWidth
  typographyEvidence.fontFaces = evidence.fontFaces
  typographyEvidence.externalStylesheets = evidence.externalStylesheets
  typographyEvidence.dpr = evidence.dpr

  const tokenEvidence = {
    source: 'src/renderer/src/styles/tokens.css',
    visualMode: '?visual=1',
    devicePixelRatio: evidence.dpr,
    geometryTokens: evidence.geometryTokens,
    spacing: evidence.spacing,
    fontSize: evidence.fontSize,
    darkColors: evidence.darkColors,
    lightColors: evidence.light,
    primaryPresets: evidence.presets,
    defaultPrimary: evidence.darkColors.primary,
    fontStack: evidence.fontStack,
    monoStack: evidence.monoStack,
    fontCheck: evidence.fontCheck,
    fontFaceRules: evidence.fontFaces,
    externalStylesheets: evidence.externalStylesheets,
    cjkSampleWidth: evidence.cjkWidth,
    computed: {
      bar: {
        width: 680,
        height: 48,
        borderRadius: '24px',
        paddingLeft: '8px',
        paddingRight: '6px'
      },
      iconButton: { width: 32, height: 32 },
      sendButton: { width: 36, height: 36 },
      composerMinWidth: '240px',
      divider: { width: 1, height: 20 },
      cardRadius: '16px',
      gap: 12,
      sidebarWidth: 260,
      panelMinHeight: '120px',
      panelBodyMaxHeight: '336px'
    },
    modeScreenshots: {
      s1: '.omo/evidence/task-14-s1.png',
      s2: '.omo/evidence/task-14-s2.png',
      s3: '.omo/evidence/task-14-s3.png'
    },
    snapshots: SNAPSHOT_NOTE
  }

  writeFileSync(
    resolve(EVIDENCE_DIR, 'task-14-tokens.json'),
    `${JSON.stringify(tokenEvidence, null, 2)}\n`
  )

  await app?.close()
})
