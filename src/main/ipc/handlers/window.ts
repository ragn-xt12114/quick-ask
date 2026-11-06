import { IPC, type WindowOpenSettingsRequest } from '../../../shared/channels'
import { ok, requestSchemas } from '../../../shared/ipc'
import type { WindowManager } from '../../window/manager'
import type { IpcRouter } from '../register'

export function registerWindowHandlers(router: IpcRouter, manager: WindowManager): void {
  router.handle(IPC.WINDOW_SHOW, requestSchemas[IPC.WINDOW_SHOW], async () =>
    ok(await manager.show())
  )

  router.handle(IPC.WINDOW_HIDE, requestSchemas[IPC.WINDOW_HIDE], () =>
    ok(manager.hide())
  )

  router.handle(IPC.WINDOW_GET_STATE, requestSchemas[IPC.WINDOW_GET_STATE], () =>
    ok(manager.getState())
  )

  router.handle(IPC.WINDOW_SET_MODE, requestSchemas[IPC.WINDOW_SET_MODE], async (payload) =>
    ok(await manager.setMode(payload.mode))
  )

  router.handle(IPC.WINDOW_SET_HEIGHT, requestSchemas[IPC.WINDOW_SET_HEIGHT], async (payload) =>
    ok(await manager.setHeight(payload))
  )

  router.handle(IPC.WINDOW_SET_BAR_WIDTH, requestSchemas[IPC.WINDOW_SET_BAR_WIDTH], async (payload) =>
    ok(await manager.setBarWidth(payload.width))
  )

  router.handle(
    IPC.WINDOW_OPEN_SETTINGS,
    requestSchemas[IPC.WINDOW_OPEN_SETTINGS],
    async (payload: WindowOpenSettingsRequest | undefined) =>
      ok(await manager.openSettings(payload ?? {}))
  )

  router.handle(IPC.WINDOW_CLOSE_SETTINGS, requestSchemas[IPC.WINDOW_CLOSE_SETTINGS], () =>
    ok(manager.closeSettings())
  )
}
