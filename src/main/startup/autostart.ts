import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import type { StartupState } from '../../shared/channels'
import { normalizeStartup, type StartupSettings } from '../../shared/settings'

export interface StartupSettingsStore {
  getStartup(): StartupSettings
  updateStartup(patch: Partial<StartupSettings>): StartupSettings
}

export interface AutostartExec {
  command: string
  args: string[]
}

export interface AutostartServiceOptions {
  settings: StartupSettingsStore
  projectRoot: string
  packaged: boolean
  execPath: string
  env?: NodeJS.ProcessEnv
  home?: string
}

export const AUTOSTART_FILE_NAME = 'quickask.desktop'
export const AUTOSTART_EXEC_ENV = 'QUICKASK_AUTOSTART_EXEC'

export function resolveAutostartDir(
  env: NodeJS.ProcessEnv = process.env,
  home: string = homedir()
): string {
  const configHome =
    env['XDG_CONFIG_HOME'] && env['XDG_CONFIG_HOME'].trim().length > 0
      ? env['XDG_CONFIG_HOME'].trim()
      : join(home, '.config')
  return join(configHome, 'autostart')
}

export function resolveAutostartPath(
  env: NodeJS.ProcessEnv = process.env,
  home: string = homedir()
): string {
  return join(resolveAutostartDir(env, home), AUTOSTART_FILE_NAME)
}

function quoteExecArg(value: string): string {
  return `"${value.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/%/g, '%%')}"`
}

export function formatAutostartExec(exec: AutostartExec): string {
  return [exec.command, ...exec.args].map(quoteExecArg).join(' ')
}

export function resolveDirectExec(
  projectRoot: string,
  packaged: boolean,
  execPath: string,
  env: NodeJS.ProcessEnv = process.env
): AutostartExec {
  const override = env[AUTOSTART_EXEC_ENV]?.trim()
  if (override) return { command: override, args: [] }
  if (packaged) return { command: execPath, args: [] }
  const releaseBinary = join(projectRoot, 'release', 'linux-unpacked', 'quickask')
  if (existsSync(releaseBinary)) return { command: releaseBinary, args: [] }
  return {
    command: join(projectRoot, 'node_modules', '.bin', 'electron'),
    args: [projectRoot]
  }
}

export function resolveSupervisorPath(projectRoot: string): string {
  return join(projectRoot, 'scripts', 'quickask-supervisor.sh')
}

export function buildAutostartDesktop(input: {
  projectRoot: string
  packaged: boolean
  execPath: string
  watchdog: boolean
  env?: NodeJS.ProcessEnv
}): string {
  const exec = input.watchdog
    ? { command: resolveSupervisorPath(input.projectRoot), args: [] }
    : resolveDirectExec(
        input.projectRoot,
        input.packaged,
        input.execPath,
        input.env ?? process.env
      )

  return [
    '[Desktop Entry]',
    'Type=Application',
    'Version=1.0',
    'Name=QuickAsk',
    'Comment=QuickAsk desktop AI assistant',
    `Exec=${formatAutostartExec(exec)}`,
    'Terminal=false',
    'StartupNotify=false',
    'X-GNOME-Autostart-enabled=true',
    ''
  ].join('\n')
}

function describeError(error: unknown): string {
  if (error instanceof Error) {
    return error.message.length > 300 ? `${error.message.slice(0, 297)}...` : error.message
  }
  return 'autostart update failed'
}

export class AutostartService {
  private readonly env: NodeJS.ProcessEnv
  private readonly home: string
  private readonly desktopPath: string

  constructor(private readonly options: AutostartServiceOptions) {
    this.env = options.env ?? process.env
    this.home = options.home ?? homedir()
    this.desktopPath = resolveAutostartPath(this.env, this.home)
  }

  getDesktopPath(): string {
    return this.desktopPath
  }

  getState(error: string | null = null): StartupState {
    const startup = normalizeStartup(this.options.settings.getStartup())
    return {
      ...startup,
      desktopPath: this.desktopPath,
      desktopExists: existsSync(this.desktopPath),
      error
    }
  }

  setState(patch: { autostart?: boolean; watchdog?: boolean }): StartupState {
    const next = this.options.settings.updateStartup({
      ...(typeof patch.autostart === 'boolean' ? { autostart: patch.autostart } : {}),
      ...(typeof patch.watchdog === 'boolean' ? { watchdog: patch.watchdog } : {})
    })
    return this.apply(next)
  }

  reconcile(): StartupState {
    return this.apply(normalizeStartup(this.options.settings.getStartup()))
  }

  private apply(startup: StartupSettings): StartupState {
    try {
      if (!startup.autostart) {
        rmSync(this.desktopPath, { force: true })
        return this.getState(null)
      }

      mkdirSync(dirname(this.desktopPath), { recursive: true, mode: 0o700 })
      const content = buildAutostartDesktop({
        projectRoot: this.options.projectRoot,
        packaged: this.options.packaged,
        execPath: this.options.execPath,
        watchdog: startup.watchdog,
        env: this.env
      })
      writeFileSync(this.desktopPath, content, { encoding: 'utf8', mode: 0o644 })
      return this.getState(null)
    } catch (error) {
      return this.getState(describeError(error))
    }
  }
}
