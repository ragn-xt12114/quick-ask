import { afterEach, describe, expect, it } from 'vitest'
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  AUTOSTART_EXEC_ENV,
  AUTOSTART_FILE_NAME,
  AutostartService,
  buildAutostartDesktop,
  resolveAutostartDir,
  resolveAutostartPath
} from '../../src/main/startup/autostart'
import { DEFAULT_STARTUP, normalizeStartup, type StartupSettings } from '../../src/shared/settings'

const tempDirs: string[] = []

afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

function tempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix))
  tempDirs.push(dir)
  return dir
}

class FakeSettingsStore {
  private startup: StartupSettings = { ...DEFAULT_STARTUP }

  getStartup(): StartupSettings {
    return { ...this.startup }
  }

  updateStartup(patch: Partial<StartupSettings>): StartupSettings {
    this.startup = normalizeStartup({ ...this.startup, ...patch })
    return { ...this.startup }
  }
}

function service(
  root: string,
  options: {
    store?: FakeSettingsStore
    projectRoot?: string
    packaged?: boolean
    execOverride?: string
  } = {}
): { service: AutostartService; store: FakeSettingsStore; env: NodeJS.ProcessEnv } {
  const store = options.store ?? new FakeSettingsStore()
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    XDG_CONFIG_HOME: join(root, 'xdg-config'),
    ...(options.execOverride ? { [AUTOSTART_EXEC_ENV]: options.execOverride } : {})
  }
  delete env['QUICKASK_HOME']
  const instance = new AutostartService({
    settings: store,
    projectRoot: options.projectRoot ?? '/opt/quickask',
    packaged: options.packaged ?? false,
    execPath: '/opt/quickask/quickask',
    env,
    home: join(root, 'home')
  })
  return { service: instance, store, env }
}

describe('XDG autostart paths', () => {
  it('honours XDG_CONFIG_HOME and falls back to ~/.config/autostart', () => {
    expect(resolveAutostartDir({ XDG_CONFIG_HOME: '/tmp/xdg' }, '/home/u')).toBe(
      '/tmp/xdg/autostart'
    )
    expect(resolveAutostartDir({}, '/home/u')).toBe('/home/u/.config/autostart')
    expect(resolveAutostartPath({}, '/home/u')).toBe(
      `/home/u/.config/autostart/${AUTOSTART_FILE_NAME}`
    )
  })
})

describe('autostart desktop content', () => {
  it('uses the supervisor when watchdog is enabled', () => {
    const content = buildAutostartDesktop({
      projectRoot: '/opt/quickask',
      packaged: false,
      execPath: '/opt/quickask/release/linux-unpacked/quickask',
      watchdog: true,
      env: {}
    })
    expect(content).toContain('Type=Application')
    expect(content).toContain('Name=QuickAsk')
    expect(content).toContain('Exec="/opt/quickask/scripts/quickask-supervisor.sh"')
    expect(content).toContain('X-GNOME-Autostart-enabled=true')
    expect(content).toContain('Terminal=false')
    expect(content).not.toMatch(/api[_-]?key|token|secret/i)
  })

  it('uses a direct dev exec by default and honours the env override', () => {
    const dev = buildAutostartDesktop({
      projectRoot: '/opt/quickask',
      packaged: false,
      execPath: '/opt/quickask/release/linux-unpacked/quickask',
      watchdog: false,
      env: {}
    })
    expect(dev).toContain(
      'Exec="/opt/quickask/node_modules/.bin/electron" "/opt/quickask"'
    )

    const overridden = buildAutostartDesktop({
      projectRoot: '/opt/quickask',
      packaged: false,
      execPath: '/opt/quickask/release/linux-unpacked/quickask',
      watchdog: false,
      env: { [AUTOSTART_EXEC_ENV]: '/tmp/fake app' }
    })
    expect(overridden).toContain('Exec="/tmp/fake app"')
  })

  it('prefers an existing unpacked release binary in dev', () => {
    const projectRoot = tempDir('quickask-autostart-project-')
    mkdirSync(join(projectRoot, 'release', 'linux-unpacked'), { recursive: true })
    writeFileSync(join(projectRoot, 'release', 'linux-unpacked', 'quickask'), '')
    const content = buildAutostartDesktop({
      projectRoot,
      packaged: false,
      execPath: '/opt/quickask/release/linux-unpacked/quickask',
      watchdog: false,
      env: {}
    })
    expect(content).toContain(
      `Exec="${join(projectRoot, 'release', 'linux-unpacked', 'quickask')}"`
    )
  })

  it('quotes packaged exec paths and escapes desktop placeholders', () => {
    const content = buildAutostartDesktop({
      projectRoot: '/opt/quickask',
      packaged: true,
      execPath: '/opt/quick ask/100%/quickask',
      watchdog: false,
      env: {}
    })
    expect(content).toContain('Exec="/opt/quick ask/100%%/quickask"')
  })
})

describe('AutostartService file lifecycle', () => {
  it('defaults to off and never creates a desktop file', () => {
    const root = tempDir('quickask-autostart-')
    const { service: instance, env } = service(root)
    const state = instance.reconcile()
    expect(state).toMatchObject({ autostart: false, watchdog: false, desktopExists: false })
    expect(existsSync(resolveAutostartPath(env, join(root, 'home')))).toBe(false)
  })

  it('creates, rewrites and removes only inside the XDG autostart directory', () => {
    const root = tempDir('quickask-autostart-')
    const { service: instance, env } = service(root)
    const path = resolveAutostartPath(env, join(root, 'home'))

    const created = instance.setState({ autostart: true })
    expect(created.error).toBeNull()
    expect(created.desktopExists).toBe(true)
    const direct = readFileSync(path, 'utf8')
    expect(direct).toContain(
      'Exec="/opt/quickask/node_modules/.bin/electron" "/opt/quickask"'
    )

    const watchdog = instance.setState({ watchdog: true })
    expect(watchdog.watchdog).toBe(true)
    const guarded = readFileSync(path, 'utf8')
    expect(guarded).toContain('Exec="/opt/quickask/scripts/quickask-supervisor.sh"')

    const directAgain = instance.setState({ watchdog: false })
    expect(directAgain.watchdog).toBe(false)
    expect(readFileSync(path, 'utf8')).toContain(
      'Exec="/opt/quickask/node_modules/.bin/electron" "/opt/quickask"'
    )

    const removed = instance.setState({ autostart: false })
    expect(removed.desktopExists).toBe(false)
    expect(existsSync(path)).toBe(false)
    expect(existsSync(join(root, 'xdg-config', 'autostart'))).toBe(true)
  })

  it('persists flags across service instances and rewrites on reconcile', () => {
    const root = tempDir('quickask-autostart-')
    const store = new FakeSettingsStore()
    const first = service(root, { store })
    first.service.setState({ autostart: true, watchdog: true })

    const second = service(root, { store })
    const state = second.service.reconcile()
    expect(state.autostart).toBe(true)
    expect(state.watchdog).toBe(true)
    expect(state.desktopExists).toBe(true)
    expect(readFileSync(state.desktopPath, 'utf8')).toContain(
      'Exec="/opt/quickask/scripts/quickask-supervisor.sh"'
    )
  })
})
