import { homedir } from 'node:os'
import { join, resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  platformKindOf,
  resolveHostDataDir,
  resolveHostPlatformPaths,
  resolvePlatformPaths,
  type PlatformPaths
} from '../../src/main/platform/paths'

function paths(kind: Parameters<typeof resolvePlatformPaths>[0], env: NodeJS.ProcessEnv, home = '/home/u'): PlatformPaths {
  return resolvePlatformPaths(kind, { env, home })
}

describe('platformKindOf', () => {
  it('maps supported and unknown platform strings', () => {
    expect(platformKindOf('linux')).toBe('linux')
    expect(platformKindOf('win32')).toBe('win32')
    expect(platformKindOf('darwin')).toBe('other')
    expect(platformKindOf('')).toBe('other')
  })
})

describe('Linux XDG paths', () => {
  it('honours XDG_CONFIG_HOME, XDG_STATE_HOME and XDG_DATA_HOME', () => {
    const result = paths(
      'linux',
      {
        XDG_CONFIG_HOME: '/tmp/xdg-config',
        XDG_STATE_HOME: '/tmp/xdg-state',
        XDG_DATA_HOME: '/tmp/xdg-data'
      },
      '/home/u'
    )
    expect(result).toEqual({
      config: '/tmp/xdg-config/quickask',
      logs: '/tmp/xdg-state/quickask/logs',
      crashDumps: '/tmp/xdg-config/quickask/Crashpad',
      data: '/tmp/xdg-data/quickask'
    })
  })

  it('falls back to the historical home-directory layout', () => {
    expect(paths('linux', {}, '/home/u')).toEqual({
      config: join('/home/u', '.config', 'quickask'),
      logs: join('/home/u', '.local', 'state', 'quickask', 'logs'),
      crashDumps: join('/home/u', '.config', 'quickask', 'Crashpad'),
      data: join('/home/u', '.local', 'share', 'quickask')
    })
  })

  it('lets QUICKASK_DATA_DIR win over XDG_DATA_HOME', () => {
    const result = paths(
      'linux',
      { XDG_DATA_HOME: '/tmp/xdg-data', QUICKASK_DATA_DIR: '/tmp/explicit-db' },
      '/home/u'
    )
    expect(result.data).toBe(resolve('/tmp/explicit-db'))
  })
})

describe('Windows paths', () => {
  it('splits Roaming config from Local logs, crash dumps and database', () => {
    const result = paths(
      'win32',
      { APPDATA: '/tmp/roaming', LOCALAPPDATA: '/tmp/local' },
      'C:/Users/u'
    )
    expect(result).toEqual({
      config: '/tmp/roaming/QuickAsk',
      logs: '/tmp/local/QuickAsk/logs',
      crashDumps: '/tmp/local/QuickAsk/Crashpad',
      data: '/tmp/local/QuickAsk'
    })
  })

  it('ignores XDG variables on Windows', () => {
    const result = paths(
      'win32',
      {
        APPDATA: '/tmp/roaming',
        LOCALAPPDATA: '/tmp/local',
        XDG_CONFIG_HOME: '/tmp/xdg-config',
        XDG_STATE_HOME: '/tmp/xdg-state',
        XDG_DATA_HOME: '/tmp/xdg-data'
      },
      'C:/Users/u'
    )
    expect(result.config).toBe('/tmp/roaming/QuickAsk')
    expect(result.logs).toBe('/tmp/local/QuickAsk/logs')
    expect(result.data).toBe('/tmp/local/QuickAsk')
  })

  it('falls back to AppData/Roaming and AppData/Local', () => {
    const result = paths('win32', {}, 'C:/Users/u')
    expect(result).toEqual({
      config: join('C:/Users/u', 'AppData', 'Roaming', 'QuickAsk'),
      logs: join('C:/Users/u', 'AppData', 'Local', 'QuickAsk', 'logs'),
      crashDumps: join('C:/Users/u', 'AppData', 'Local', 'QuickAsk', 'Crashpad'),
      data: join('C:/Users/u', 'AppData', 'Local', 'QuickAsk')
    })
  })

  it('keeps QUICKASK_DATA_DIR as the highest-priority override', () => {
    const result = paths(
      'win32',
      { APPDATA: '/tmp/roaming', LOCALAPPDATA: '/tmp/local', QUICKASK_DATA_DIR: '/tmp/db' },
      'C:/Users/u'
    )
    expect(result.data).toBe(resolve('/tmp/db'))
  })
})

describe('unsupported platform paths', () => {
  it('uses a single hidden directory', () => {
    expect(paths('other', {}, '/home/u')).toEqual({
      config: join('/home/u', '.quickask'),
      logs: join('/home/u', '.quickask', 'logs'),
      crashDumps: join('/home/u', '.quickask', 'Crashpad'),
      data: join('/home/u', '.quickask', 'data')
    })
  })

  it('uses the real home directory when the input is empty', () => {
    const result = paths('other', {}, '   ')
    expect(result.config).toBe(join(homedir(), '.quickask'))
  })
})

describe('host helpers', () => {
  it('resolves an explicit data directory absolutely', () => {
    expect(resolveHostDataDir('relative/data')).toBe(resolve('relative/data'))
  })

  it('honours QUICKASK_DATA_DIR through the host helper', () => {
    const env: NodeJS.ProcessEnv = { QUICKASK_DATA_DIR: '/tmp/quickask-db' }
    expect(resolveHostDataDir(undefined, env)).toBe(resolve('/tmp/quickask-db'))
  })

  it('returns an absolute host path set', () => {
    const result = resolveHostPlatformPaths({}, '/home/u')
    expect(result.config.startsWith('/')).toBe(true)
    expect(result.logs.startsWith('/')).toBe(true)
    expect(result.data.startsWith('/')).toBe(true)
  })
})
