/**
 * Non-secret settings IPC handlers (Task 11).
 */

import { IPC, type SettingsGetAllResult, type SettingsSetRequest, type SettingsSetResult } from '../../../shared/channels'
import { fail, IpcError, ok, requestSchemas, type IpcResult } from '../../../shared/ipc'
import { isDbError } from '../../db/errors'
import { SettingsError } from '../../settings/service'
import type { AppServices } from '../../services/app-services'
import { registerHandler, type IpcRouter } from '../register'

function settingsFailure(error: unknown): IpcResult<never> {
  if (error instanceof SettingsError) return fail('INVALID_ARGUMENT', error.message)
  if (error instanceof IpcError) return fail(error.code, error.message, error.details)
  if (isDbError(error)) return fail('INTERNAL', '本地数据库操作失败')
  return fail('INTERNAL', 'Internal error')
}

export function registerSettingsHandlers(
  router: IpcRouter,
  getServices: () => AppServices | null
): void {
  const settings = (): NonNullable<AppServices['settings']> => {
    const services = getServices()
    if (!services?.settings) throw new IpcError('INTERNAL', 'Settings service unavailable')
    return services.settings
  }

  registerHandler<undefined, SettingsGetAllResult>(
    router,
    IPC.SETTINGS_GET_ALL,
    requestSchemas[IPC.SETTINGS_GET_ALL],
    (): IpcResult<SettingsGetAllResult> => {
      try {
        return ok({ settings: settings().getAll() })
      } catch (error) {
        return settingsFailure(error)
      }
    }
  )

  registerHandler<SettingsSetRequest, SettingsSetResult>(
    router,
    IPC.SETTINGS_SET,
    requestSchemas[IPC.SETTINGS_SET],
    (payload): IpcResult<SettingsSetResult> => {
      try {
        return ok({ saved: settings().set(payload.key, payload.value) })
      } catch (error) {
        return settingsFailure(error)
      }
    }
  )
}
