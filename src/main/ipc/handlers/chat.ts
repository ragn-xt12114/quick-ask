/**
 * Chat IPC handlers (Task 16).
 *
 * Handlers are thin: all send/stream/retry logic lives in the orchestrator.
 * Every thrown value becomes a typed `IpcResult` failure; raw exceptions and
 * provider payloads never cross the bridge.
 */

import {
  IPC,
  type ChatGetActiveResult,
  type ChatRegenerateRequest,
  type ChatRequestResult,
  type ChatRetryRequest,
  type ChatSendRequest,
  type ChatStopRequest,
  type ChatStopResult
} from '../../../shared/channels'
import {
  fail,
  IpcError,
  ok,
  requestSchemas,
  type IpcFailure,
  type IpcResult
} from '../../../shared/ipc'
import type { ChatOrchestrator } from '../../chat/orchestrator'
import { isDbError } from '../../db/errors'
import type { SessionState } from '../../session/state'
import { registerHandler, type IpcRouter } from '../register'

function failureFrom(error: unknown): IpcFailure {
  if (error instanceof IpcError) {
    return fail(error.code, error.message, error.details)
  }
  return fail('INTERNAL', 'Internal error')
}

function unavailableFailure(error: unknown): IpcError {
  if (isDbError(error)) {
    if (error.code === 'DB_READONLY' || error.code === 'SQLITE_FULL' || error.code === 'DB_WRITE') {
      return new IpcError('DB_WRITE', '本地保存失败（磁盘/权限）')
    }
    if (error.code === 'DB_CORRUPT') {
      return new IpcError('INTERNAL', '本地历史库不可用（损坏/备份处理中）')
    }
  }
  return new IpcError('INTERNAL', 'Chat service unavailable')
}

export function registerChatHandlers(
  router: IpcRouter,
  getOrchestrator: () => ChatOrchestrator | null,
  getState?: () => SessionState | null,
  getDbError?: () => unknown
): void {
  const orchestrator = (): ChatOrchestrator => {
    const chat = getOrchestrator()
    if (!chat) throw unavailableFailure(getDbError?.() ?? null)
    return chat
  }

  registerHandler<ChatSendRequest, ChatRequestResult>(
    router,
    IPC.CHAT_SEND,
    requestSchemas[IPC.CHAT_SEND],
    async (payload): Promise<IpcResult<ChatRequestResult>> => {
      try {
        const state = getState?.() ?? null
        const started = state
          ? await state.send(payload.text, payload.images)
          : await orchestrator().send({
              sessionId: payload.sessionId,
              text: payload.text,
              ...(payload.images && payload.images.length > 0 ? { images: payload.images } : {})
            })
        return ok(started)
      } catch (error) {
        return failureFrom(error)
      }
    }
  )

  registerHandler<ChatStopRequest, ChatStopResult>(
    router,
    IPC.CHAT_STOP,
    requestSchemas[IPC.CHAT_STOP],
    async (payload): Promise<IpcResult<ChatStopResult>> => {
      try {
        return ok(await orchestrator().stop(payload.requestId))
      } catch (error) {
        return failureFrom(error)
      }
    }
  )

  registerHandler<ChatRetryRequest, ChatRequestResult>(
    router,
    IPC.CHAT_RETRY,
    requestSchemas[IPC.CHAT_RETRY],
    async (payload): Promise<IpcResult<ChatRequestResult>> => {
      try {
        return ok(
          await orchestrator().retry({
            sessionId: payload.sessionId,
            messageId: payload.messageId
          })
        )
      } catch (error) {
        return failureFrom(error)
      }
    }
  )

  registerHandler<ChatRegenerateRequest, ChatRequestResult>(
    router,
    IPC.CHAT_REGENERATE,
    requestSchemas[IPC.CHAT_REGENERATE],
    async (payload): Promise<IpcResult<ChatRequestResult>> => {
      try {
        return ok(
          await orchestrator().regenerate({
            sessionId: payload.sessionId,
            messageId: payload.messageId
          })
        )
      } catch (error) {
        return failureFrom(error)
      }
    }
  )

  registerHandler<undefined, ChatGetActiveResult>(
    router,
    IPC.CHAT_GET_ACTIVE,
    requestSchemas[IPC.CHAT_GET_ACTIVE],
    async (): Promise<IpcResult<ChatGetActiveResult>> => {
      try {
        return ok({ active: orchestrator().getActive() })
      } catch (error) {
        return failureFrom(error)
      }
    }
  )
}
