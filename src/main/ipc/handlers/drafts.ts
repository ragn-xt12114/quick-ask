/**
 * Draft IPC handlers (Task 18).
 *
 * Drafts are keyed by session id; the literal `new` holds the composer draft
 * for a session that has not been created yet (Task 10 schema). The renderer
 * never touches SQLite directly.
 */

import {
  IPC,
  type DraftsGetRequest,
  type DraftsGetResult,
  type DraftsSetRequest,
  type DraftsSetResult
} from '../../../shared/channels'
import {
  fail,
  IpcError,
  ok,
  requestSchemas,
  type IpcFailure,
  type IpcResult
} from '../../../shared/ipc'
import { isDbError } from '../../db/errors'
import type { AppServices } from '../../services/app-services'
import { registerHandler, type IpcRouter } from '../register'

function failureFrom(error: unknown): IpcFailure {
  if (error instanceof IpcError) return fail(error.code, error.message, error.details)
  if (isDbError(error)) return fail('INTERNAL', '本地数据库操作失败')
  return fail('INTERNAL', 'Internal error')
}

export function registerDraftHandlers(
  router: IpcRouter,
  getServices: () => AppServices | null
): void {
  const db = (): NonNullable<AppServices['db']> => {
    const services = getServices()
    if (!services?.db) throw new IpcError('INTERNAL', 'Database unavailable')
    return services.db
  }

  registerHandler<DraftsGetRequest, DraftsGetResult>(
    router,
    IPC.DRAFTS_GET,
    requestSchemas[IPC.DRAFTS_GET],
    async (payload): Promise<IpcResult<DraftsGetResult>> => {
      try {
        return ok({ text: db().getDraft(payload.sessionId) })
      } catch (error) {
        return failureFrom(error)
      }
    }
  )

  registerHandler<DraftsSetRequest, DraftsSetResult>(
    router,
    IPC.DRAFTS_SET,
    requestSchemas[IPC.DRAFTS_SET],
    async (payload): Promise<IpcResult<DraftsSetResult>> => {
      try {
        return ok({ saved: db().setDraft(payload.sessionId, payload.text) })
      } catch (error) {
        return failureFrom(error)
      }
    }
  )
}
