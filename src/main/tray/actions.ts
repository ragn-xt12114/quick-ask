import type { MainWindowMode } from '../../shared/channels'

export type TrayActionId = 'toggle' | 'new-session' | 'history' | 'settings' | 'quit'

export interface TrayActionContext {
  isVisible(): boolean
  hide(): void
  showAndSetMode(mode: MainWindowMode): Promise<void> | void
  openSettings(): Promise<void> | void
  emitNewSession(): void
  quit(): void
}

export async function runTrayAction(
  action: TrayActionId,
  context: TrayActionContext
): Promise<void> {
  switch (action) {
    case 'toggle':
      if (context.isVisible()) {
        context.hide()
        return
      }
      await context.showAndSetMode('S1')
      return

    case 'new-session':
      await context.showAndSetMode('S1')
      context.emitNewSession()
      return

    case 'history':
      await context.showAndSetMode('S3')
      return

    case 'settings':
      await context.openSettings()
      return

    case 'quit':
      context.quit()
      return
  }
}
