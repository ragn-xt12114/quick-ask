import { mkdirSync } from 'node:fs'
import { homedir } from 'node:os'
import { resolveHostPlatformPaths } from '../platform/paths'

export interface ResolvedAppPaths {
  config: string
  logs: string
  crashDumps: string
}

export type AppPathName = 'userData' | 'sessionData' | 'logs' | 'crashDumps'
export type SetAppPath = (name: AppPathName, path: string) => void

export function resolveAppPaths(
  env: NodeJS.ProcessEnv = process.env,
  home: string = homedir()
): ResolvedAppPaths {
  const paths = resolveHostPlatformPaths(env, home)
  return {
    config: paths.config,
    logs: paths.logs,
    crashDumps: paths.crashDumps
  }
}

export function applyAppPaths(setPath: SetAppPath, paths: ResolvedAppPaths): void {
  mkdirSync(paths.config, { recursive: true, mode: 0o700 })
  mkdirSync(paths.logs, { recursive: true, mode: 0o700 })
  mkdirSync(paths.crashDumps, { recursive: true, mode: 0o700 })

  setPath('userData', paths.config)
  setPath('sessionData', paths.config)
  setPath('logs', paths.logs)
  setPath('crashDumps', paths.crashDumps)
}
