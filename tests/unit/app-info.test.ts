import { describe, expect, it } from 'vitest'
import { join } from 'node:path'
import { buildAppPathsInfo, pathForKind } from '../../src/main/app-info'
import { SETTINGS_SCHEMA_VERSION } from '../../src/shared/settings'

describe('app paths info', () => {
  const info = buildAppPathsInfo({
    version: '9.9.9-test',
    dataDir: '/tmp/quickask-data',
    configDir: '/tmp/quickask-config',
    logsDir: '/tmp/quickask-logs'
  })

  it('derives the db path and reports the settings schema version', () => {
    expect(info).toEqual({
      version: '9.9.9-test',
      dataDir: '/tmp/quickask-data',
      configDir: '/tmp/quickask-config',
      logsDir: '/tmp/quickask-logs',
      dbPath: join('/tmp/quickask-data', 'quickask.db'),
      schemaVersion: SETTINGS_SCHEMA_VERSION
    })
  })

  it('maps only the three allowed kinds to resolved directories', () => {
    expect(pathForKind(info, 'data')).toBe('/tmp/quickask-data')
    expect(pathForKind(info, 'config')).toBe('/tmp/quickask-config')
    expect(pathForKind(info, 'logs')).toBe('/tmp/quickask-logs')
  })
})
