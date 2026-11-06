import type { MenuItemConstructorOptions } from 'electron'
import type { TrayActionId } from './actions'

export interface TrayMenuOptions {
  visible: boolean
  onAction: (action: TrayActionId) => void
}

export const TRAY_MENU_LABELS = {
  show: '显示',
  hide: '隐藏',
  newSession: '新建会话',
  history: '历史',
  settings: '设置',
  quit: '退出'
} as const

/**
 * Exactly five items. Q4: left click toggles, right click opens this menu;
 * there is deliberately no double-click behaviour.
 */
export function buildTrayMenuTemplate(
  options: TrayMenuOptions
): MenuItemConstructorOptions[] {
  return [
    {
      id: 'toggle',
      label: options.visible ? TRAY_MENU_LABELS.hide : TRAY_MENU_LABELS.show,
      click: () => options.onAction('toggle')
    },
    {
      id: 'new-session',
      label: TRAY_MENU_LABELS.newSession,
      click: () => options.onAction('new-session')
    },
    {
      id: 'history',
      label: TRAY_MENU_LABELS.history,
      click: () => options.onAction('history')
    },
    {
      id: 'settings',
      label: TRAY_MENU_LABELS.settings,
      click: () => options.onAction('settings')
    },
    {
      id: 'quit',
      label: TRAY_MENU_LABELS.quit,
      click: () => options.onAction('quit')
    }
  ]
}
