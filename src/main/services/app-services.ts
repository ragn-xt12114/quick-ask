/**
 * Main-process composition root.
 *
 * Opens the database, builds the secret store (worker-backed keyring +
 * safeStorage fallback) and the provider/settings services. A database
 * failure must not crash the app: handlers keep returning INTERNAL and the
 * error is logged after redaction.
 */

import { app, safeStorage } from 'electron'
import { getLogger } from '../logging'
import { OutboundGuard } from '../net/guard'
import { openDbService, resolveDataDir } from '../db'
import type { DbService } from '../db/service'
import { createProviderClient, type ProviderClient } from '../provider/client'
import { ProviderService } from '../providers/service'
import { redactSummary } from '../secrets/redact'
import { SecretStore } from '../secrets/store'
import { WorkerKeyringBackend } from '../secrets/keyring-backend-worker'
import { SettingsService } from '../settings/service'

export interface AppServicesOptions {
  dataDir?: string
  db?: DbService
  /** Optional pre-built guard (tests / future plugins). */
  guard?: OutboundGuard
}

export interface AppServices {
  db: DbService | null
  secrets: SecretStore
  providers: ProviderService | null
  providerClient: ProviderClient
  settings: SettingsService | null
  dbError: Error | null
  guard: OutboundGuard
  close(): void
}

export function createAppServices(options: AppServicesOptions = {}): AppServices {
  const dataDir = resolveDataDir(options.dataDir)
  const log = getLogger()

  // Runtime outbound allowlist: provider endpoints + environment proxies +
  // loopback. ProviderService refreshes provider origins on every CRUD write.
  const guard = options.guard ?? new OutboundGuard()
  guard.refreshProxyFromEnv(process.env)

  const secrets = new SecretStore({
    keyring: new WorkerKeyringBackend(),
    safeStorage,
    dataDir,
    logger: (message) => log.warn('secret_store', { detail: message })
  })

  let db: DbService | null = options.db ?? null
  let dbError: Error | null = null

  if (!db) {
    try {
      db = openDbService({ dataDir: options.dataDir })
    } catch (error) {
      dbError = error instanceof Error ? error : new Error('database open failed')
      log.error('db_open_failed', {
        detail: redactSummary(dbError.message, 300)
      })
    }
  }

  if (db) {
    let schemaVersion: number
    try {
      const row = db.driver.prepare('PRAGMA user_version').get()
      schemaVersion = Number(Object.values(row ?? {})[0] ?? -1)
    } catch {
      schemaVersion = -1
    }
    log.info('db_open', {
      ok: true,
      recovered: db.handle.recovered,
      ftsAvailable: db.handle.ftsAvailable,
      schemaVersion,
      recoveredFrom: db.handle.corruptBackupPath !== null,
      recoveredStreaming: db.lastRecoveryCount
    })
    if (db.lastRecoveryCount > 0) {
      log.warn('db_streaming_recovered', {
        count: db.lastRecoveryCount,
        action: 'streaming->interrupted'
      })
    }
  }

  const version = app.getVersion()
  const providers = db
    ? new ProviderService(db, secrets, {
        version,
        guard,
        onProfilesChanged: (baseUrls) => guard.setProviderBaseUrls(baseUrls)
      })
    : null
  if (db) {
    guard.setProviderBaseUrls(db.providers.list().map((profile) => profile.baseUrl))
  }
  const providerClient = createProviderClient({
    version,
    guard,
    logger: {
      info: (event, fields) => log.info(event, fields),
      warn: (event, fields) => log.warn(event, fields)
    }
  })
  const settings = db ? new SettingsService(db) : null

  let closed = false
  return {
    db,
    secrets,
    providers,
    providerClient,
    settings,
    dbError,
    guard,
    close() {
      if (closed) return
      closed = true
      providerClient.abortAll()
      secrets.close()
      try {
        db?.close()
      } catch {
        // already closed / process exiting
      }
    }
  }
}
