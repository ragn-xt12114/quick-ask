/**
 * Platform-specific application directories.
 *
 * Pure Node helpers (no Electron) so they can run before `app.whenReady()` and
 * be unit-tested without launching Electron. The Linux branch reproduces the
 * previous XDG behaviour exactly; Windows uses the Roaming/Local split that
 * Microsoft recommends (roaming profile for user settings, local for caches,
 * logs and SQLite).
 */

import { homedir } from 'node:os'
import { join, resolve } from 'node:path'
import type { PlatformKind } from '../../shared/platform'

export interface PlatformPathsInput {
  env: NodeJS.ProcessEnv
  home: string
}

export interface PlatformPaths {
  /** userData/sessionData root. */
  config: string
  /** Log directory. */
  logs: string
  /** Crash dump directory. */
  crashDumps: string
  /** SQLite database directory. */
  data: string
}

export function platformKindOf(platform: string): PlatformKind {
  if (platform === 'linux') return 'linux'
  if (platform === 'win32') return 'win32'
  return 'other'
}

function envValue(env: NodeJS.ProcessEnv, key: string): string | null {
  const value = env[key]
  if (typeof value !== 'string') return null
  const trimmed = value.trim()
  return trimmed.length > 0 ? trimmed : null
}

function resolveHome(home: string): string {
  return home.trim().length > 0 ? home : homedir()
}

function dataDirFromEnv(
  env: NodeJS.ProcessEnv,
  fallback: string,
  xdgDataHome: string | null
): string {
  const override = envValue(env, 'QUICKASK_DATA_DIR')
  if (override) return resolve(override)
  if (xdgDataHome) return join(resolve(xdgDataHome), 'quickask')
  return fallback
}

export function resolvePlatformPaths(
  kind: PlatformKind,
  input: PlatformPathsInput
): PlatformPaths {
  const env = input.env
  const home = resolveHome(input.home)

  if (kind === 'win32') {
    const appData =
      envValue(env, 'APPDATA') ?? join(home, 'AppData', 'Roaming')
    const localAppData =
      envValue(env, 'LOCALAPPDATA') ?? join(home, 'AppData', 'Local')
    return {
      config: join(appData, 'QuickAsk'),
      logs: join(localAppData, 'QuickAsk', 'logs'),
      crashDumps: join(localAppData, 'QuickAsk', 'Crashpad'),
      data: dataDirFromEnv(env, join(localAppData, 'QuickAsk'), null)
    }
  }

  if (kind === 'linux') {
    const configHome = envValue(env, 'XDG_CONFIG_HOME') ?? join(home, '.config')
    const stateHome =
      envValue(env, 'XDG_STATE_HOME') ?? join(home, '.local', 'state')
    const xdgDataHome = envValue(env, 'XDG_DATA_HOME')
    const config = join(configHome, 'quickask')
    return {
      config,
      logs: join(stateHome, 'quickask', 'logs'),
      crashDumps: join(config, 'Crashpad'),
      data: dataDirFromEnv(
        env,
        join(home, '.local', 'share', 'quickask'),
        xdgDataHome
      )
    }
  }

  return {
    config: join(home, '.quickask'),
    logs: join(home, '.quickask', 'logs'),
    crashDumps: join(home, '.quickask', 'Crashpad'),
    data: dataDirFromEnv(env, join(home, '.quickask', 'data'), null)
  }
}

export function resolveHostPlatformPaths(
  env: NodeJS.ProcessEnv = process.env,
  home: string = homedir()
): PlatformPaths {
  return resolvePlatformPaths(platformKindOf(process.platform), { env, home })
}

/**
 * Highest priority: explicit argument (tests) > QUICKASK_DATA_DIR > platform
 * default. Always returns an absolute path.
 */
export function resolveHostDataDir(
  explicit?: string,
  env: NodeJS.ProcessEnv = process.env
): string {
  if (explicit && explicit.length > 0) return resolve(explicit)
  return resolveHostPlatformPaths(env).data
}
