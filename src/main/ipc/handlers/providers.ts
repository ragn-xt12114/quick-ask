/**
 * Provider + provider-test IPC handlers (Task 11).
 *
 * Handlers are registered on the Task 9 router before `install()`, so sender
 * checks, request zod validation and response validation all still apply.
 * Responses contain only ProviderProfileView (booleans, never secret values).
 */

import {
  IPC,
  type ProviderCreateRequest,
  type ProviderDeleteRequest,
  type ProviderDeleteResult,
  type ProviderGetRequest,
  type ProviderListModelsResult,
  type ProviderListResult,
  type ProviderProfileView,
  type ProviderTestRequest,
  type ProviderTestResult,
  type ProviderUpdateRequest
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
import { ProviderError } from '../../providers/service'
import { isSecretError } from '../../secrets/errors'
import type { AppServices } from '../../services/app-services'
import { registerHandler, type IpcRouter } from '../register'

function failureFrom(error: unknown): IpcFailure {
  if (error instanceof IpcError) return fail(error.code, error.message, error.details)
  if (error instanceof ProviderError) {
    switch (error.code) {
      case 'NOT_FOUND':
        return fail('NOT_FOUND', error.message)
      case 'INVALID_ARGUMENT':
        return fail('INVALID_ARGUMENT', error.message)
      case 'AUTH':
        return fail('AUTH', error.message)
      case 'NETWORK':
        return fail('NETWORK', error.message)
      case 'PROXY':
        return fail('NETWORK', error.message)
      case 'TIMEOUT':
        return fail('TIMEOUT', error.message)
      case 'PROTOCOL':
        return fail('PROTOCOL', error.message)
      case 'RATE_LIMIT':
        return fail('RATE_LIMIT', error.message)
      case 'SERVER':
        return fail('SERVER', error.message)
      case 'BAD_REQUEST':
        return fail('BAD_REQUEST', error.message)
      case 'SECRET':
        return fail('INTERNAL', '凭据存储失败')
    }
  }
  if (isSecretError(error)) return fail(error.code, error.message)
  if (isDbError(error)) {
    return error.code === 'DB_NOT_FOUND'
      ? fail('NOT_FOUND', 'Provider profile not found')
      : fail('INTERNAL', '本地数据库操作失败')
  }
  return fail('INTERNAL', 'Internal error')
}

export function registerProviderHandlers(
  router: IpcRouter,
  getServices: () => AppServices | null
): void {
  const providers = (): NonNullable<AppServices['providers']> => {
    const services = getServices()
    if (!services?.providers) throw new IpcError('INTERNAL', 'Provider service unavailable')
    return services.providers
  }

  registerHandler<undefined, ProviderListResult>(
    router,
    IPC.PROVIDER_LIST,
    requestSchemas[IPC.PROVIDER_LIST],
    async (): Promise<IpcResult<ProviderListResult>> => {
      try {
        return ok({ profiles: await providers().listProfiles() })
      } catch (error) {
        return failureFrom(error)
      }
    }
  )

  registerHandler<ProviderGetRequest, ProviderProfileView>(
    router,
    IPC.PROVIDER_GET,
    requestSchemas[IPC.PROVIDER_GET],
    async (payload): Promise<IpcResult<ProviderProfileView>> => {
      try {
        return ok(await providers().getProfile(payload.id))
      } catch (error) {
        return failureFrom(error)
      }
    }
  )

  registerHandler<ProviderCreateRequest, ProviderProfileView>(
    router,
    IPC.PROVIDER_CREATE,
    requestSchemas[IPC.PROVIDER_CREATE],
    async (payload): Promise<IpcResult<ProviderProfileView>> => {
      try {
        return ok(await providers().createProfile(payload))
      } catch (error) {
        return failureFrom(error)
      }
    }
  )

  registerHandler<ProviderUpdateRequest, ProviderProfileView>(
    router,
    IPC.PROVIDER_UPDATE,
    requestSchemas[IPC.PROVIDER_UPDATE],
    async (payload): Promise<IpcResult<ProviderProfileView>> => {
      try {
        return ok(await providers().updateProfile(payload.id, payload))
      } catch (error) {
        return failureFrom(error)
      }
    }
  )

  registerHandler<ProviderDeleteRequest, ProviderDeleteResult>(
    router,
    IPC.PROVIDER_DELETE,
    requestSchemas[IPC.PROVIDER_DELETE],
    async (payload): Promise<IpcResult<ProviderDeleteResult>> => {
      try {
        return ok(await providers().deleteProfile(payload.id))
      } catch (error) {
        return failureFrom(error)
      }
    }
  )

  registerHandler<ProviderTestRequest, ProviderTestResult>(
    router,
    IPC.PROVIDER_TEST,
    requestSchemas[IPC.PROVIDER_TEST],
    async (payload): Promise<IpcResult<ProviderTestResult>> => {
      try {
        return ok(await providers().testConnection(payload.profileId))
      } catch (error) {
        return failureFrom(error)
      }
    }
  )

  registerHandler<ProviderTestRequest, ProviderListModelsResult>(
    router,
    IPC.PROVIDER_LIST_MODELS,
    requestSchemas[IPC.PROVIDER_LIST_MODELS],
    async (payload): Promise<IpcResult<ProviderListModelsResult>> => {
      try {
        return ok(await providers().listModels(payload.profileId))
      } catch (error) {
        return failureFrom(error)
      }
    }
  )
}
