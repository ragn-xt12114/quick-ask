import { app, shell } from 'electron'
import { resolveDataDir } from '../../db'
import { buildAppPathsInfo, pathForKind } from '../../app-info'
import {
  IPC,
  type AppOpenPathRequest,
  type AppOpenPathResult,
  type AppPathsInfo,
  type AppSetStartupRequest,
  type ListFontsResult,
  type ReadLogsRequest,
  type ReadLogsResult,
  type StartupState
} from '../../../shared/channels'
import { fail, ok, requestSchemas, type IpcResult } from '../../../shared/ipc'
import type { StartupService } from '../../startup/types'
import type { PlatformFontAdapter } from '../../platform/types'
import { getPlatform } from '../../platform'
import { DEFAULT_FONT_FAMILY } from '../../../shared/settings'
import { getLogger } from '../../logging'
import { MAX_LOG_VIEW_BYTES, readRecentLogs } from '../../logs/reader'
import { registerHandler, type IpcRouter } from '../register'

export function currentAppPathsInfo(): AppPathsInfo {
  return buildAppPathsInfo({
    version: app.getVersion(),
    dataDir: resolveDataDir(),
    configDir: app.getPath('userData'),
    logsDir: app.getPath('logs')
  })
}

export function registerAppHandlers(
  router: IpcRouter,
  getAutostart: () => StartupService | null = () => null,
  getFonts: () => PlatformFontAdapter = () => getPlatform().fonts
): void {
  registerHandler<undefined, AppPathsInfo>(
    router,
    IPC.APP_PATHS,
    requestSchemas[IPC.APP_PATHS],
    (): IpcResult<AppPathsInfo> => ok(currentAppPathsInfo())
  )

  registerHandler<AppOpenPathRequest, AppOpenPathResult>(
    router,
    IPC.APP_OPEN_PATH,
    requestSchemas[IPC.APP_OPEN_PATH],
    async (payload): Promise<IpcResult<AppOpenPathResult>> => {
      const target = pathForKind(currentAppPathsInfo(), payload.kind)
      const error = await shell.openPath(target)
      return ok({ opened: error === '' })
    }
  )

  registerHandler<AppSetStartupRequest, StartupState>(
    router,
    IPC.APP_SET_STARTUP,
    requestSchemas[IPC.APP_SET_STARTUP],
    (payload): IpcResult<StartupState> => {
      const service = getAutostart()
      if (!service) return fail('NOT_IMPLEMENTED', 'autostart is unavailable')
      return ok(service.setState(payload))
    }
  )

  registerHandler<undefined, ListFontsResult>(
    router,
    IPC.APP_LIST_FONTS,
    requestSchemas[IPC.APP_LIST_FONTS],
    (): IpcResult<ListFontsResult> => {
      try {
        const fonts = getFonts()
        const list = fonts.list()
        return ok({ fonts: list, default: fonts.defaultFor(list) })
      } catch {
        return ok({ fonts: [DEFAULT_FONT_FAMILY], default: DEFAULT_FONT_FAMILY })
      }
    }
  )

  registerHandler<ReadLogsRequest | undefined, ReadLogsResult>(
    router,
    IPC.APP_READ_LOGS,
    requestSchemas[IPC.APP_READ_LOGS],
    (payload): IpcResult<ReadLogsResult> => {
      try {
        const info = currentAppPathsInfo()
        const maxBytes =
          typeof payload?.maxBytes === 'number' ? payload.maxBytes : MAX_LOG_VIEW_BYTES
        const recent = readRecentLogs(info.logsDir, 'quickask.log', maxBytes)
        return ok(recent)
      } catch (error) {
        getLogger().error('read_logs_failed', {})
        void error
        return fail('INTERNAL', 'Internal error')
      }
    }
  )
}
