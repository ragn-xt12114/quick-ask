/**
 * Session/history IPC handlers (Task 20).
 *
 * All reads and writes go through `DbService`; handlers never touch SQL,
 * never construct FTS MATCH syntax (the repository quotes/escapes), and never
 * leak raw database error text across the bridge.
 */

import {
  IPC,
  type Session,
  type SessionsCreateRequest,
  type SessionsDeleteRequest,
  type SessionsDeleteResult,
  type SessionsClearAllResult,
  type SessionsGetMessagesRequest,
  type SessionsGetMessagesResult,
  type SessionsGetRequest,
  type SessionsListRequest,
  type SessionsListResult,
  type SessionsNewResult,
  type SessionsOpenRequest,
  type SessionsOpenResult,
  type SessionsRenameRequest,
  type SessionsStateResult
} from '../../../shared/channels'
import {
  fail,
  IpcError,
  ok,
  requestSchemas,
  type IpcFailure,
  type IpcResult
} from '../../../shared/ipc'
import { uuidv7 } from '../../../shared/uuidv7'
import { isDbError } from '../../db/errors'
import type { AppServices } from '../../services/app-services'
import { prioritizeCurrentSession } from '../../session/history-order'
import type { SessionState } from '../../session/state'
import { registerHandler, type IpcRouter } from '../register'

/** UI default: render the full 1000-session history in the virtual list. */
export const HISTORY_LIST_LIMIT = 1000
export const MAX_SESSION_TITLE_CHARS = 80
const DEFAULT_SESSION_TITLE = '新会话'

function failureFrom(error: unknown): IpcFailure {
  if (error instanceof IpcError) return fail(error.code, error.message, error.details)
  if (isDbError(error)) {
    if (error.code === 'DB_NOT_FOUND') return fail('NOT_FOUND', '会话不存在')
    return fail('INTERNAL', '本地数据库操作失败')
  }
  return fail('INTERNAL', 'Internal error')
}

/** Trim, cap at 80 Unicode code points; returns null for an empty title. */
export function normalizeSessionTitle(value: string): string | null {
  const trimmed = value.trim()
  if (trimmed.length === 0) return null
  return Array.from(trimmed).slice(0, MAX_SESSION_TITLE_CHARS).join('').trim() || null
}

export function checkpointBestEffort(checkpoint: () => unknown): void {
  try {
    checkpoint()
  } catch {
    return
  }
}

export function registerSessionHandlers(
  router: IpcRouter,
  getServices: () => AppServices | null,
  getState?: () => SessionState | null
): void {
  const db = (): NonNullable<AppServices['db']> => {
    const services = getServices()
    if (!services?.db) throw new IpcError('INTERNAL', 'Database unavailable')
    return services.db
  }

  registerHandler<SessionsListRequest, SessionsListResult>(
    router,
    IPC.SESSIONS_LIST,
    requestSchemas[IPC.SESSIONS_LIST],
    async (payload): Promise<IpcResult<SessionsListResult>> => {
      try {
        const query = payload.query?.trim() ?? ''
        const limit = payload.limit ?? HISTORY_LIST_LIMIT
        const offset = payload.offset ?? 0
        const sessions =
          query.length > 0
            ? db().searchSessions(query, limit)
            : db().listSessions({ limit, offset })
        return ok({
          sessions: prioritizeCurrentSession(
            sessions,
            getState?.()?.getCurrentSessionId() ?? null,
            offset
          )
        })
      } catch (error) {
        return failureFrom(error)
      }
    }
  )

  registerHandler<SessionsGetRequest, Session>(
    router,
    IPC.SESSIONS_GET,
    requestSchemas[IPC.SESSIONS_GET],
    async (payload): Promise<IpcResult<Session>> => {
      try {
        const session = db().getSession(payload.id)
        if (!session) throw new IpcError('NOT_FOUND', '会话不存在')
        return ok(session)
      } catch (error) {
        return failureFrom(error)
      }
    }
  )

  registerHandler<SessionsGetMessagesRequest, SessionsGetMessagesResult>(
    router,
    IPC.SESSIONS_GET_MESSAGES,
    requestSchemas[IPC.SESSIONS_GET_MESSAGES],
    async (payload): Promise<IpcResult<SessionsGetMessagesResult>> => {
      try {
        const service = db()
        // A deleted session (and therefore its cascade-deleted messages) is
        // NOT_FOUND, which lets callers distinguish "empty" from "gone".
        if (!service.getSession(payload.sessionId)) {
          throw new IpcError('NOT_FOUND', '会话不存在')
        }
        return ok({ messages: service.getMessages(payload.sessionId) })
      } catch (error) {
        return failureFrom(error)
      }
    }
  )

  registerHandler<SessionsCreateRequest, Session>(
    router,
    IPC.SESSIONS_CREATE,
    requestSchemas[IPC.SESSIONS_CREATE],
    async (payload): Promise<IpcResult<Session>> => {
      try {
        const service = db()
        const title =
          payload.title === undefined
            ? DEFAULT_SESSION_TITLE
            : normalizeSessionTitle(payload.title)
        if (title === null) throw new IpcError('INVALID_ARGUMENT', '标题不能为空')
        const now = Date.now()
        const session = service.driver.transaction(() => {
          const created = service.sessions.create({
            id: uuidv7(now),
            title,
            titleAuto: payload.title === undefined,
            createdAt: now,
            updatedAt: now,
            lastMessageAt: null,
            model: null
          })
          service.search.rebuild(created.id)
          return created
        })
        return ok(session)
      } catch (error) {
        return failureFrom(error)
      }
    }
  )

  registerHandler<SessionsRenameRequest, Session>(
    router,
    IPC.SESSIONS_RENAME,
    requestSchemas[IPC.SESSIONS_RENAME],
    async (payload): Promise<IpcResult<Session>> => {
      try {
        const title = normalizeSessionTitle(payload.title)
        if (title === null) throw new IpcError('INVALID_ARGUMENT', '标题不能为空')
        const service = db()
        if (!service.renameSession(payload.id, title)) {
          throw new IpcError('NOT_FOUND', '会话不存在')
        }
        const session = service.getSession(payload.id)
        if (!session) throw new IpcError('NOT_FOUND', '会话不存在')
        return ok(session)
      } catch (error) {
        return failureFrom(error)
      }
    }
  )

  registerHandler<SessionsDeleteRequest, SessionsDeleteResult>(
    router,
    IPC.SESSIONS_DELETE,
    requestSchemas[IPC.SESSIONS_DELETE],
    async (payload): Promise<IpcResult<SessionsDeleteResult>> => {
      try {
        const state = getState?.() ?? null
        if (state?.getCurrentSessionId() === payload.id) {
          return ok({ deleted: await state.deleteCurrent() })
        }
        return ok({ deleted: db().deleteSession(payload.id) })
      } catch (error) {
        return failureFrom(error)
      }
    }
  )

  registerHandler<undefined, SessionsClearAllResult>(
    router,
    IPC.SESSIONS_CLEAR_ALL,
    requestSchemas[IPC.SESSIONS_CLEAR_ALL],
    async (): Promise<IpcResult<SessionsClearAllResult>> => {
      try {
        const state = getState?.() ?? null
        if (!state) throw new IpcError('INTERNAL', 'Database unavailable')
        const cleared = await state.clearAll()
        checkpointBestEffort(() => db().checkpoint())
        return ok({ cleared })
      } catch (error) {
        return failureFrom(error)
      }
    }
  )
}

export function registerSessionStateHandlers(
  router: IpcRouter,
  getServices: () => AppServices | null,
  state: SessionState | null
): void {
  const currentState = (): SessionState => {
    if (!getServices()?.db || !state) throw new IpcError('INTERNAL', 'Database unavailable')
    return state
  }

  registerHandler<SessionsOpenRequest, SessionsOpenResult>(
    router,
    IPC.SESSIONS_OPEN,
    requestSchemas[IPC.SESSIONS_OPEN],
    async (payload): Promise<IpcResult<SessionsOpenResult>> => {
      try {
        return ok(await currentState().open(payload.id))
      } catch (error) {
        return failureFrom(error)
      }
    }
  )

  registerHandler<Record<string, never>, SessionsNewResult>(
    router,
    IPC.SESSIONS_NEW,
    requestSchemas[IPC.SESSIONS_NEW],
    async (): Promise<IpcResult<SessionsNewResult>> => {
      try {
        return ok(await currentState().new())
      } catch (error) {
        return failureFrom(error)
      }
    }
  )

  registerHandler<Record<string, never>, SessionsStateResult>(
    router,
    IPC.SESSIONS_STATE,
    requestSchemas[IPC.SESSIONS_STATE],
    async (): Promise<IpcResult<SessionsStateResult>> => {
      try {
        return ok(await currentState().getState())
      } catch (error) {
        return failureFrom(error)
      }
    }
  )
}
