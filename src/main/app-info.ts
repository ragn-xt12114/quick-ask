import { join } from 'node:path'
import { DB_FILE_NAME } from './db/open'
import { SETTINGS_SCHEMA_VERSION } from '../shared/settings'
import type { AppPathKind, AppPathsInfo } from '../shared/channels'

export interface AppPathsInfoInput {
  version: string
  dataDir: string
  configDir: string
  logsDir: string
}

export function buildAppPathsInfo(input: AppPathsInfoInput): AppPathsInfo {
  return {
    version: input.version,
    dataDir: input.dataDir,
    configDir: input.configDir,
    logsDir: input.logsDir,
    dbPath: join(input.dataDir, DB_FILE_NAME),
    schemaVersion: SETTINGS_SCHEMA_VERSION
  }
}

/**
 * Only the resolved local directories may be opened. `kind` is already an
 * enum at the IPC schema boundary; this function guarantees no caller-supplied
 * path ever reaches `shell.openPath`.
 */
export function pathForKind(info: AppPathsInfo, kind: AppPathKind): string {
  switch (kind) {
    case 'data':
      return info.dataDir
    case 'config':
      return info.configDir
    case 'logs':
      return info.logsDir
  }
}
