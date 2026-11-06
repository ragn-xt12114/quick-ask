import {
  IPC,
  type DataCleanupRequest,
  type DataCleanupResult
} from '../../shared/channels'
import { fail, ok, requestSchemas, type IpcResult } from '../../shared/ipc'
import type { AppServices } from '../services/app-services'
import type { SessionState } from '../session/state'
import type { RetentionService } from './retention'
import { cutoffForRetention, pruneOldSessions } from './retention'
import { registerHandler, type IpcRouter } from '../ipc/register'

export function registerDataHandlers(
  router: IpcRouter,
  getServices: () => AppServices | null,
  getState: () => SessionState | null = () => null,
  getRetention: () => RetentionService | null = () => null
): void {
  registerHandler<DataCleanupRequest | undefined, DataCleanupResult>(
    router,
    IPC.DATA_CLEANUP,
    requestSchemas[IPC.DATA_CLEANUP],
    async (payload): Promise<IpcResult<DataCleanupResult>> => {
      try {
        const services = getServices()
        if (!services?.db || !services.settings) {
          return fail('INTERNAL', 'Database unavailable')
        }
        const retentionDays = services.settings.getData().retentionDays
        const dryRun = payload?.dryRun === true
        const now = Date.now()
        if (retentionDays === null) {
          return ok({ cleaned: 0, retentionDays: null, lastCleanupAt: null })
        }
        const cutoff = cutoffForRetention(retentionDays, now)
        if (cutoff === null) {
          return ok({ cleaned: 0, retentionDays, lastCleanupAt: null })
        }
        if (dryRun) {
          const ids = services.db.sessions.listIdsOlderThan(cutoff)
          const current = getState()?.getCurrentSessionId() ?? null
          const count = ids.filter((id) => id !== current).length
          return ok({ cleaned: count, retentionDays, lastCleanupAt: null })
        }
        const retention = getRetention()
        if (retention) {
          const result = retention.runOnce(now)
          return ok({
            cleaned: result.cleaned,
            retentionDays,
            lastCleanupAt: result.lastCleanupAt
          })
        }
        const current = getState()?.getCurrentSessionId() ?? null
        const result = pruneOldSessions(services.db, {
          retentionDays,
          now,
          excludeSessionIds: current ? [current] : []
        })
        return ok({ cleaned: result.cleaned, retentionDays, lastCleanupAt: now })
      } catch {
        return fail('INTERNAL', 'Internal error')
      }
    }
  )
}
