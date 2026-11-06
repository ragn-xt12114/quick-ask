import type { DbService } from '../db/service'
import { getLogger } from '../logging'

export interface RetentionPruneOptions {
  retentionDays: number | null
  now?: number
  excludeSessionIds?: readonly string[]
}

export interface RetentionPruneResult {
  cleaned: number
  cutoff: number | null
}

export function cutoffForRetention(retentionDays: number | null, now: number): number | null {
  if (retentionDays === null) return null
  if (!Number.isFinite(retentionDays) || retentionDays < 1) return null
  return now - Math.floor(retentionDays) * 86_400_000
}

export function pruneOldSessions(
  db: DbService,
  options: RetentionPruneOptions
): RetentionPruneResult {
  const now = options.now ?? Date.now()
  const cutoff = cutoffForRetention(options.retentionDays, now)
  if (cutoff === null) return { cleaned: 0, cutoff: null }
  const excluded = new Set(options.excludeSessionIds ?? [])
  const candidates = db.sessions.listIdsOlderThan(cutoff)
  let cleaned = 0
  for (const id of candidates) {
    if (excluded.has(id)) continue
    if (db.deleteSession(id)) cleaned += 1
  }
  return { cleaned, cutoff }
}

export class RetentionService {
  private lastCleanupAt: number | null = null
  private lastCleaned = 0
  private timer: NodeJS.Timeout | null = null

  constructor(
    private readonly getDb: () => DbService | null,
    private readonly getRetentionDays: () => number | null,
    private readonly getCurrentSessionId: () => string | null = () => null
  ) {}

  runOnce(now: number = Date.now()): RetentionPruneResult & { lastCleanupAt: number | null } {
    const db = this.getDb()
    const retentionDays = this.getRetentionDays()
    if (!db || retentionDays === null) {
      return { cleaned: 0, cutoff: null, lastCleanupAt: this.lastCleanupAt }
    }
    const current = this.getCurrentSessionId()
    const result = pruneOldSessions(db, {
      retentionDays,
      now,
      excludeSessionIds: current ? [current] : []
    })
    this.lastCleanupAt = now
    this.lastCleaned = result.cleaned
    if (result.cleaned > 0) {
      try {
        db.checkpoint()
      } catch {
        return { ...result, lastCleanupAt: this.lastCleanupAt }
      }
    }
    getLogger().info('retention_cleanup', {
      retentionDays,
      cleaned: result.cleaned
    })
    return { ...result, lastCleanupAt: this.lastCleanupAt }
  }

  status(): { lastCleanupAt: number | null; lastCleaned: number } {
    return { lastCleanupAt: this.lastCleanupAt, lastCleaned: this.lastCleaned }
  }

  startDaily(): void {
    if (this.timer) return
    this.timer = setInterval(() => {
      this.runOnce()
    }, 86_400_000)
    if (typeof this.timer === 'object' && this.timer !== null && 'unref' in this.timer) {
      ;(this.timer as unknown as { unref: () => void }).unref()
    }
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer)
      this.timer = null
    }
  }
}
