import { mkdtempSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  applyAppPaths,
  resolveAppPaths,
  type AppPathName
} from '../../src/main/window/app-paths'

const tempDirs: string[] = []

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true })
  }
})

describe('resolveAppPaths', () => {
  it('uses XDG config/state homes for config and logs', () => {
    const paths = resolveAppPaths(
      {
        XDG_CONFIG_HOME: '/tmp/xdg-config',
        XDG_STATE_HOME: '/tmp/xdg-state'
      },
      '/home/tester'
    )

    expect(paths).toEqual({
      config: '/tmp/xdg-config/quickask',
      logs: '/tmp/xdg-state/quickask/logs',
      crashDumps: '/tmp/xdg-config/quickask/Crashpad'
    })
  })

  it('falls back to ~/.config and ~/.local/state', () => {
    const paths = resolveAppPaths({}, '/home/tester')

    expect(paths.config).toBe('/home/tester/.config/quickask')
    expect(paths.logs).toBe('/home/tester/.local/state/quickask/logs')
    expect(paths.crashDumps).toBe('/home/tester/.config/quickask/Crashpad')
  })
})

describe('applyAppPaths', () => {
  it('creates the directories and sets all four Electron paths', () => {
    const root = mkdtempSync(join(tmpdir(), 'quickask-app-paths-'))
    tempDirs.push(root)
    const paths = {
      config: join(root, 'config'),
      logs: join(root, 'state', 'logs'),
      crashDumps: join(root, 'config', 'Crashpad')
    }
    const applied: Array<[AppPathName, string]> = []

    applyAppPaths((name, path) => applied.push([name, path]), paths)

    expect(applied).toEqual([
      ['userData', paths.config],
      ['sessionData', paths.config],
      ['logs', paths.logs],
      ['crashDumps', paths.crashDumps]
    ])
    for (const path of [paths.config, paths.logs, paths.crashDumps]) {
      expect(statSync(path).isDirectory()).toBe(true)
    }
  })
})
