import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { app, Menu, nativeImage, Tray } from 'electron'
import { getLogger } from '../logging'
import type { WindowManager } from '../window/manager'
import { runTrayAction, type TrayActionId } from './actions'
import { buildTrayMenuTemplate } from './menu'

export interface TrayControllerOptions {
  manager: WindowManager
  emitNewSession: () => void
  sessionNew?: () => void | Promise<void>
  sessionHistory?: () => void | Promise<void>
  quit: () => void
  /**
   * Called when the user interacts with the tray. Used to suppress auto-hide
   * for a short window so opening the menu/showing the panel does not race
   * with blur-driven hiding.
   *
   * Best effort: on Plasma, right-click tray menus may not emit an Electron
   * event at all (Task 6), so this hook never sees those interactions.
   */
  onInteraction?: () => void
  iconPath?: string
  logger?: (line: string) => void
}

const TRAY_TOOLTIP = 'QuickAsk'

function resolveTrayIconPath(explicit?: string): string {
  if (explicit) return explicit
  const candidates = app.isPackaged
    ? [
        join(process.resourcesPath, 'assets', 'tray-32.png'),
        join(process.resourcesPath, 'build', 'icons', '32x32.png')
      ]
    : [
        join(app.getAppPath(), 'assets', 'tray-32.png'),
        join(app.getAppPath(), 'build', 'icons', '32x32.png')
      ]
  return candidates.find((candidate) => existsSync(candidate)) ?? candidates[0]!
}

export class TrayController {
  private tray: Tray | null = null
  private unsubscribeState: (() => void) | null = null

  constructor(private readonly options: TrayControllerOptions) {}

  create(): void {
    if (this.tray) return

    const iconPath = resolveTrayIconPath(this.options.iconPath)
    const icon = nativeImage.createFromPath(iconPath)
    if (icon.isEmpty()) {
      getLogger().warn('tray_icon_empty', { path: iconPath })
      this.log(`[tray] icon is empty or missing: ${iconPath}`)
    }

    const tray = new Tray(icon)
    tray.setToolTip(TRAY_TOOLTIP)
    tray.on('click', () => {
      this.options.onInteraction?.()
      void this.run('toggle')
    })
    this.tray = tray

    this.unsubscribeState = this.options.manager.onStateChange(() => {
      this.refreshMenu()
    })
    this.refreshMenu()
    getLogger().info('tray_created', {
      iconPath,
      width: icon.getSize().width,
      height: icon.getSize().height
    })
    this.log(`[tray] created icon=${iconPath} size=${JSON.stringify(icon.getSize())}`)
  }

  refreshMenu(): void {
    if (!this.tray) return
    const visible = this.options.manager.getState().visible
    this.tray.setContextMenu(
      Menu.buildFromTemplate(
        buildTrayMenuTemplate({
          visible,
          onAction: (action) => {
            // Best effort (Task 6): Plasma right-click menus may not emit an
            // Electron event, so suppression cannot be guaranteed there.
            this.options.onInteraction?.()
            void this.run(action)
          }
        })
      )
    )
  }

  destroy(): void {
    this.unsubscribeState?.()
    this.unsubscribeState = null
    if (this.tray) {
      this.tray.destroy()
      this.tray = null
      getLogger().info('tray_destroyed')
      this.log('[tray] destroyed')
    }
  }

  private async run(action: TrayActionId): Promise<void> {
    getLogger().info('tray_action', { action })
    try {
      if (action === 'new-session') await this.options.sessionNew?.()
      if (action === 'history') await this.options.sessionHistory?.()
      await runTrayAction(action, {
        isVisible: () => this.options.manager.getState().visible,
        hide: () => {
          this.options.manager.hide()
          this.refreshMenu()
        },
        showAndSetMode: async (mode) => {
          await this.options.manager.setMode(mode)
          this.refreshMenu()
        },
        openSettings: async () => {
          await this.options.manager.openSettings()
        },
        emitNewSession: () => {
          this.options.emitNewSession()
        },
        quit: () => {
          this.options.quit()
        }
      })
    } catch (error) {
      getLogger().error('tray_action_failed', {
        action,
        detail: error instanceof Error ? error.message : String(error)
      })
      this.log(`[tray] action ${action} failed: ${error instanceof Error ? error.message : error}`)
    }
    this.refreshMenu()
  }

  private log(line: string): void {
    if (this.options.logger) this.options.logger(line)
    else getLogger().line('info', line)
  }
}
