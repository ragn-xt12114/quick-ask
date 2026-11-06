import { describe, expect, it } from 'vitest'
import type { MainWindowMode } from '../../src/shared/channels'
import { runTrayAction, type TrayActionContext } from '../../src/main/tray/actions'
import { buildTrayMenuTemplate, TRAY_MENU_LABELS } from '../../src/main/tray/menu'
import type { TrayActionId } from '../../src/main/tray/actions'

interface Recorder {
  context: TrayActionContext
  calls: string[]
}

function recorder(visible: boolean): Recorder {
  const calls: string[] = []
  const context: TrayActionContext = {
    isVisible: () => visible,
    hide: () => calls.push('hide'),
    showAndSetMode: (mode: MainWindowMode) => {
      calls.push(`show:${mode}`)
    },
    openSettings: () => {
      calls.push('settings')
    },
    emitNewSession: () => {
      calls.push('emit:new-session')
    },
    quit: () => {
      calls.push('quit')
    }
  }
  return { context, calls }
}

describe('tray actions', () => {
  it('left-click toggle hides when visible and never switches mode', async () => {
    const { context, calls } = recorder(true)
    await runTrayAction('toggle', context)
    expect(calls).toEqual(['hide'])
  })

  it('left-click toggle shows S1 when hidden', async () => {
    const { context, calls } = recorder(false)
    await runTrayAction('toggle', context)
    expect(calls).toEqual(['show:S1'])
  })

  it('新建会话 shows S1 and then emits ui:new-session', async () => {
    const { context, calls } = recorder(false)
    await runTrayAction('new-session', context)
    expect(calls).toEqual(['show:S1', 'emit:new-session'])
  })

  it('历史 shows S3', async () => {
    const { context, calls } = recorder(false)
    await runTrayAction('history', context)
    expect(calls).toEqual(['show:S3'])
  })

  it('设置 opens settings directly without forcing the main window', async () => {
    const { context, calls } = recorder(false)
    await runTrayAction('settings', context)
    expect(calls).toEqual(['settings'])
  })

  it('退出 really quits instead of hiding', async () => {
    const { context, calls } = recorder(true)
    await runTrayAction('quit', context)
    expect(calls).toEqual(['quit'])
    expect(calls).not.toContain('hide')
  })
})

describe('tray menu', () => {
  it('has exactly five items with the dynamic show/hide label', () => {
    const actions: TrayActionId[] = []
    const onAction = (action: TrayActionId): void => {
      actions.push(action)
    }

    const hiddenMenu = buildTrayMenuTemplate({ visible: false, onAction })
    expect(hiddenMenu).toHaveLength(5)
    expect(hiddenMenu.map((item) => item.label)).toEqual([
      TRAY_MENU_LABELS.show,
      TRAY_MENU_LABELS.newSession,
      TRAY_MENU_LABELS.history,
      TRAY_MENU_LABELS.settings,
      TRAY_MENU_LABELS.quit
    ])
    expect(hiddenMenu.map((item) => item.id)).toEqual([
      'toggle',
      'new-session',
      'history',
      'settings',
      'quit'
    ])

    const visibleMenu = buildTrayMenuTemplate({ visible: true, onAction })
    expect(visibleMenu).toHaveLength(5)
    expect(visibleMenu[0]?.label).toBe(TRAY_MENU_LABELS.hide)

    for (const item of visibleMenu) {
      if (typeof item.click === 'function') {
        ;(item.click as unknown as () => void)()
      }
    }
    expect(actions).toEqual(['toggle', 'new-session', 'history', 'settings', 'quit'])
  })

  it('does not register any double-click or right-click semantics', () => {
    const template = buildTrayMenuTemplate({ visible: false, onAction: () => undefined })
    for (const item of template) {
      expect(item).not.toHaveProperty('doubleClick')
      expect(item).not.toHaveProperty('rightClick')
    }
  })
})
