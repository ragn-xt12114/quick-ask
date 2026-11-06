import { join } from 'node:path'
import { PRODUCTION_CSP } from '../shared/csp'
import { pathToFileURL } from 'node:url'
import { app, BrowserWindow, dialog, globalShortcut, nativeTheme, screen } from 'electron'
import type {
  IpcEventChannel,
  UiNewSessionEvent,
  UiNoticeEvent,
  UiOnboardingEvent
} from '../shared/channels'
import { IPC } from '../shared/channels'
import {
  DEFAULT_APPEARANCE,
  DEFAULT_BEHAVIOR,
  DEFAULT_SHORTCUT,
  computeOnboardingState,
  normalizeSettings,
  type AppearanceSettings,
  type BehaviorSettings,
  type NormalizedSettings,
  type OnboardingState,
  type SettingsBundle
} from '../shared/settings'
import { createIpcRouter, registerCoreHandlers } from './ipc/register'
import { ChatOrchestrator } from './chat/orchestrator'
import { initLogging, type Logger } from './logging'
import { assertNoRendererNetwork } from './net/guard'
import { registerAppHandlers } from './ipc/handlers/app'
import { registerChatHandlers } from './ipc/handlers/chat'
import { registerClipboardHandlers } from './ipc/handlers/clipboard'
import { registerDataHandlers } from './data/handler'
import { RetentionService } from './data/retention'
import { registerExportHandlers } from './export/handler'
import { registerDraftHandlers } from './ipc/handlers/drafts'
import { registerLinkHandlers } from './ipc/handlers/links'
import { registerProviderHandlers } from './ipc/handlers/providers'
import {
  registerSessionHandlers,
  registerSessionStateHandlers
} from './ipc/handlers/sessions'
import { registerSettingsHandlers } from './ipc/handlers/settings'
import { registerWindowHandlers } from './ipc/handlers/window'
import { defaultHotkeyStatus, HotkeyManager } from './hotkey/manager'
import { Lifecycle } from './lifecycle'
import { redactSummary } from './secrets/redact'
import { installSecurityPolicies } from './security'
import { SessionState } from './session/state'
import { CompositorMonitor } from './window/compositor'
import { createAppServices, type AppServices } from './services/app-services'
import { getPlatform } from './platform'
import type { StartupService } from './startup/types'
import { TrayController } from './tray/controller'
import { applyAppPaths, resolveAppPaths } from './window/app-paths'
import { AutoHideController } from './window/focus'
import { WindowManager } from './window/manager'

const devServerUrl = process.env['ELECTRON_RENDERER_URL'] || null
const rendererIndexPath = join(__dirname, '../renderer/index.html')
const rendererFileUrl = pathToFileURL(rendererIndexPath).href
const preloadPath = join(__dirname, '../preload/index.js')
const isDev = devServerUrl !== null

const appPaths = resolveAppPaths()
applyAppPaths((name, path) => app.setPath(name, path), appPaths)
app.setName('quickask')

const initialLogDir = (() => {
  try {
    return app.getPath('logs')
  } catch {
    return appPaths.logs
  }
})()

const logger: Logger = initLogging({
  logDir: initialLogDir,
  level: process.env['QUICKASK_LOG_LEVEL'],
  mirrorToConsole: true
})

let manager: WindowManager | null = null
let services: AppServices | null = null
let chatOrchestrator: ChatOrchestrator | null = null
let sessionState: SessionState | null = null
let hotkeyManager: HotkeyManager | null = null
let trayController: TrayController | null = null
let lifecycle: Lifecycle | null = null
let autoHide: AutoHideController | null = null
let autostart: StartupService | null = null
let retention: RetentionService | null = null
let mainWindowVisible = false
let compositorMonitor: CompositorMonitor | null = null
let animationDurationFactor = 1
let blurStatus = {
  available: false,
  reason: null as string | null,
  compositor: null as boolean | null,
  effectEnabled: null as boolean | null
}

function describeError(error: unknown): string {
  return redactSummary(error instanceof Error ? error.message : String(error), 200)
}

function resolveExportDialog(): {
  showSaveDialog(
    window: unknown,
    options: { title: string; defaultPath: string; filters: Array<{ name: string; extensions: string[] }> }
  ): Promise<{ canceled: boolean; filePath?: string }>
} {
  const stubDir = process.env['QUICKASK_EXPORT_STUB_DIR']?.trim()
  if (stubDir) {
    return {
      showSaveDialog: async (_window, options) => ({
        canceled: false,
        filePath: join(stubDir, options.defaultPath || 'export.json')
      })
    }
  }
  return {
    showSaveDialog: (window, options) =>
      dialog.showSaveDialog((window ?? undefined) as unknown as BrowserWindow, options)
  }
}

function sendUiEventToWindow(
  window: BrowserWindow | null | undefined,
  channel: IpcEventChannel,
  payload: unknown
): void {
  if (!window || window.isDestroyed()) return

  const send = (): void => {
    if (window.isDestroyed()) return
    try {
      window.webContents.send(channel, payload)
    } catch (error) {
      logger.error('ui_event_send_failed', {
        channel,
        detail: describeError(error)
      })
    }
  }

  if (window.webContents.isLoadingMainFrame()) {
    window.webContents.once('did-finish-load', send)
  } else {
    send()
  }
}

function sendUiEvent(channel: IpcEventChannel, payload: unknown): void {
  sendUiEventToWindow(manager?.getMainWindow(), channel, payload)
}

/** Appearance/onboarding changes affect both renderers (main + S4). */
function broadcastUiEvent(channel: IpcEventChannel, payload: unknown): void {
  sendUiEventToWindow(manager?.getMainWindow(), channel, payload)
  sendUiEventToWindow(manager?.getSettingsWindow(), channel, payload)
}

function applyAppearance(appearance: AppearanceSettings): void {
  void manager?.setAppearance(appearance)
}

function applyBehavior(behavior: BehaviorSettings): void {
  autoHide?.setHideOnBlur(behavior.hideOnBlur)
  autoHide?.setStreamingDelayMs(behavior.streamingHideDelayMs)
}

function onboardingDisabled(): boolean {
  return process.env['QUICKASK_DISABLE_ONBOARDING'] === '1'
}

async function getOnboardingState(): Promise<OnboardingState> {
  // E2E suites that exercise unrelated surfaces opt out of the F-08 gate.
  if (onboardingDisabled()) return { required: false, reason: null }
  const providers = services?.providers
  if (!providers) return { required: true, reason: 'no_profile' }
  try {
    const profiles = await providers.listProfiles()
    return computeOnboardingState(profiles)
  } catch {
    return { required: true, reason: 'no_profile' }
  }
}

async function broadcastOnboarding(): Promise<void> {
  const payload: UiOnboardingEvent = await getOnboardingState()
  broadcastUiEvent(IPC.EVENT_UI_ONBOARDING, payload)
}

function currentSettingsBundle(): SettingsBundle {
  const normalized = normalizeSettings(undefined)
  return {
    appearance: services?.settings?.getAppearance() ?? normalized.appearance,
    shortcut: services?.settings?.getShortcut() ?? normalized.shortcut,
    behavior: services?.settings?.getBehavior() ?? normalized.behavior,
    inference: services?.settings?.getInference() ?? normalized.inference,
    data: services?.settings?.getData() ?? normalized.data,
    window: services?.settings?.getWindow() ?? normalized.window,
    startup: services?.settings?.getStartup() ?? normalized.startup,
    schemaVersion: normalized.schemaVersion
  }
}

function currentNormalizedSettings(): NormalizedSettings {
  return services?.settings?.getNormalizedSettings() ?? normalizeSettings(undefined)
}

function broadcastSettings(): void {
  broadcastUiEvent(IPC.EVENT_UI_SETTINGS, { settings: currentNormalizedSettings() })
}

async function handleHotkey(): Promise<void> {
  if (!manager || lifecycle?.isQuitting()) return
  const hotkeyState = manager.getState()
  logger.info('hotkey_received', {
    mode: hotkeyState.mode,
    visible: hotkeyState.visible
  })
  try {
    const settings = manager.getSettingsWindow()
    if (settings && !settings.isDestroyed()) {
      manager.closeSettings()
      manager.hide()
      return
    }
    if (manager.getState().visible) {
      manager.hide()
      return
    }
    await manager.setMode('S1')
  } catch (error) {
    logger.error('hotkey_toggle_failed', { detail: describeError(error) })
  }
}

function focusFirstInstance(): void {
  if (!manager) {
    if (app.isReady()) {
      logger.warn('single_instance_window_manager_unavailable')
      return
    }
    void app.whenReady().then(() => focusFirstInstance())
    return
  }

  const settings = manager.getSettingsWindow()
  if (settings && !settings.isDestroyed()) {
    settings.show()
    settings.focus()
    return
  }

  void manager
    .show()
    .then(() => manager?.setMode('S1'))
    .catch((error) => {
      logger.error('single_instance_show_failed', { detail: describeError(error) })
    })
}

function startFirstInstance(): void {
  const platform = getPlatform()
  logger.info('app_start', {
    version: app.getVersion(),
    platform: platform.hostPlatform,
    packaged: app.isPackaged,
    dev: isDev,
    logDir: initialLogDir
  })

  platform.applyCommandLineSwitches(app)

  const HARDENING_SWITCHES = [
    'disable-background-networking',
    'disable-component-update',
    'disable-domain-reliability',
    'disable-sync',
    'no-pings',
    'disable-breakpad'
  ] as const

  for (const flag of HARDENING_SWITCHES) {
    app.commandLine.appendSwitch(flag)
  }
  app.commandLine.appendSwitch(
    'disable-features',
    'OptimizationHints,MediaRouter,Translate,AutofillServerCommunication,DnsOverHttps,DnsOverHttpsUpgrade,AsyncDns'
  )

  app.on('second-instance', () => {
    logger.info('app_second_instance')
    focusFirstInstance()
  })

  app.on('before-quit', (event) => {
    if (!lifecycle) return
    event.preventDefault()
    lifecycle.handleBeforeQuit()
  })

  app.on('window-all-closed', () => {
    // Tray-resident app: never quit because a window was hidden/closed.
  })

  app.on('child-process-gone', (_event, details) => {
    lifecycle?.logChildProcessGone(details)
  })

  void app.whenReady().then(async () => {
    logger.info('app_ready', {
      version: app.getVersion(),
      platform: platform.hostPlatform,
      electron: process.versions.electron ?? null,
      packaged: app.isPackaged,
      dev: isDev
    })

    installSecurityPolicies({
      policy: { devServerUrl, rendererFileUrl },
      isDev
    })

    // Fail closed if the renderer network boundary is ever weakened. Dev mode
    // intentionally allows the Vite HMR websocket, so only production is
    // asserted here (Task 9 e2e covers both policies).
    if (!isDev) {
      assertNoRendererNetwork({
        csp: PRODUCTION_CSP,
        contextIsolation: true,
        sandbox: true,
        nodeIntegration: false,
        webSecurity: true,
        webviewTag: false
      })
    }

    services = createAppServices()
    logger.info('services_ready', {
      db: services.db !== null,
      dbError: services.dbError !== null
    })

    const projectRoot = process.env['QUICKASK_PROJECT_ROOT']?.trim() || app.getAppPath()
    if (services.settings) {
      autostart = platform.startup.createService({
        settings: services.settings,
        projectRoot,
        packaged: app.isPackaged,
        execPath: process.execPath
      })
      const startupState = autostart.reconcile()
      logger.info('autostart_reconciled', {
        autostart: startupState.autostart,
        watchdog: startupState.watchdog,
        exists: startupState.desktopExists,
        error: startupState.error
      })
    }

    blurStatus = platform.blur.detectStatus()
    animationDurationFactor = platform.blur.animationDurationFactorSync()

    manager = new WindowManager({
      preloadPath,
      rendererIndexPath,
      rendererFileUrl,
      devServerUrl,
      platform,
      initialAppearance: services.settings?.getAppearance() ?? { ...DEFAULT_APPEARANCE },
      initialBlurStatus: blurStatus,
      initialAnimationDurationFactor: animationDurationFactor,
      positionMemory: {
        get: () => services?.settings?.getWindow().positions ?? {},
        set: (positions) => {
          services?.settings?.updateWindow({ positions })
        }
      }
    })

    services.settings?.onChange((key) => {
      if (key === 'appearance') {
        const appearance = services?.settings?.getAppearance() ?? { ...DEFAULT_APPEARANCE }
        applyAppearance(appearance)
      } else if (key === 'behavior') {
        const behavior = services?.settings?.getBehavior() ?? { ...DEFAULT_BEHAVIOR }
        applyBehavior(behavior)
      } else if (key === 'onboardingComplete') {
        void broadcastOnboarding()
      }
      broadcastSettings()
    })
    services.providers?.onProfilesChange(() => {
      void broadcastOnboarding()
    })

    manager.onStateChange((state) => {
      logger.info('window_state', {
        mode: state.mode,
        visible: state.visible,
        displayId: state.display.id,
        width: state.bounds.width,
        height: state.bounds.height
      })
      if (state.visible && !mainWindowVisible) autoHide?.onFocus()
      else if (!state.visible) autoHide?.cancel()
      mainWindowVisible = state.visible
    })

    if (services.db && services.providers) {
      chatOrchestrator = new ChatOrchestrator({
        db: services.db,
        providers: services.providers,
        client: services.providerClient,
        settings: services.settings,
        emit: (channel, payload) => {
          sendUiEvent(channel, payload)
        },
        logger: (line, fields) => {
          logger.info(line, fields)
        }
      })
      sessionState = new SessionState({
        db: services.db,
        chat: chatOrchestrator,
        getWindowMode: () => manager?.getState().mode ?? 'S1',
        setWindowMode: async (mode) => {
          if (!manager) return
          await manager.setMode(mode)
        },
        emit: (channel, payload) => {
          sendUiEvent(channel, payload)
        },
        logger: (line, fields) => {
          logger.info(line, fields)
        }
      })
    }

    lifecycle = new Lifecycle({
      hideMain: () => {
        manager?.hide()
      },
      checkpointDb: () => {
        const db = services?.db
        if (!db) return { ok: false, error: 'database unavailable' }
        return db.checkpoint()
      },
      reloadRenderer: () => {
        const window = manager?.getMainWindow()
        if (!window || window.isDestroyed()) return
        window.webContents.reload()
      },
      destroyTray: () => {
        trayController?.destroy()
        trayController = null
      },
      unregisterHotkeys: () => {
        hotkeyManager?.unregisterAll()
        hotkeyManager = null
      },
      closeServices: () => {
        retention?.stop()
        retention = null
        services?.close()
        services = null
      },
      destroyWindows: () => {
        autoHide?.dispose()
        autoHide = null
        compositorMonitor?.stop()
        compositorMonitor = null
        manager?.destroy()
        manager = null
      },
      exit: (code) => {
        app.exit(code)
      },
      logger: (line) => {
        logger.line('info', line)
      }
    })

    lifecycle.registerQuitHook(async () => {
      await chatOrchestrator?.abortAll()
    })

    const router = createIpcRouter({
      getMainWindow: () => manager?.getMainWindow() ?? null,
      getSettingsWindow: () => manager?.getSettingsWindow() ?? null,
      policy: { devServerUrl, rendererFileUrl }
    })
    registerCoreHandlers(router, {
      getHotkeyStatus: () => hotkeyManager?.getStatus() ?? defaultHotkeyStatus(),
      retryHotkey: () => hotkeyManager?.retry() ?? defaultHotkeyStatus(),
      getSession: () => sessionState?.bootstrap() ?? { currentSessionId: null, mode: 'S1' },
      getAppearance:
        () => manager?.getAppearance() ?? services?.settings?.getAppearance() ?? { ...DEFAULT_APPEARANCE },
      getSettings: () => currentSettingsBundle(),
      setHotkey: (accelerator) => {
        const requested = accelerator.trim()
        const status = hotkeyManager?.setAccelerator(requested) ?? defaultHotkeyStatus()
        if (status.registered && status.accelerator === requested) {
          services?.settings?.updateShortcut({ accelerator: requested })
        }
        return status
      },
      getOnboarding: () => getOnboardingState(),
      getBlurStatus: () => manager?.getBlurStatus() ?? blurStatus,
      getOpaqueMode: () => manager?.getOpaqueMode() ?? false,
      getAnimationDurationFactor: () =>
        manager?.getAnimationDurationFactor() ?? animationDurationFactor,
      getHostPlatform: () => platform.hostPlatform,
      getPlatformCapabilities: () => platform.info
    })
    registerChatHandlers(
      router,
      () => chatOrchestrator,
      () => sessionState,
      () => services?.dbError ?? null
    )
    registerAppHandlers(router, () => autostart, () => platform.fonts)
    registerDraftHandlers(router, () => services)
    registerClipboardHandlers(router)
    registerLinkHandlers(router)
    registerProviderHandlers(router, () => services)
    registerSessionHandlers(
      router,
      () => services,
      () => sessionState
    )
    registerSessionStateHandlers(router, () => services, sessionState)
    registerSettingsHandlers(router, () => services)
    registerExportHandlers(
      router,
      () => services,
      () => sessionState,
      { dialog: resolveExportDialog() }
    )
    registerDataHandlers(
      router,
      () => services,
      () => sessionState,
      () => retention
    )
    registerWindowHandlers(router, manager)

    if (services?.db && services.settings) {
      retention = new RetentionService(
        () => services?.db ?? null,
        () => services?.settings?.getData().retentionDays ?? null,
        () => sessionState?.getCurrentSessionId() ?? null
      )
      retention.runOnce()
      retention.startDaily()
    }

    manager.create()
    compositorMonitor = new CompositorMonitor({
      query: () => platform.blur.querySnapshot(),
      onState: (state) => {
        blurStatus = state.blurStatus
        animationDurationFactor = state.animationDurationFactor
        void manager?.setCompositorState(state)
      }
    })
    compositorMonitor.start()
    nativeTheme.on('updated', () => {
      manager?.notifySystemThemeChanged()
    })
    router.install()

    const mainWindow = manager.getMainWindow()
    if (mainWindow) {
      const initialBehavior = services.settings?.getBehavior() ?? { ...DEFAULT_BEHAVIOR }
      autoHide = new AutoHideController({
        isStreaming: () => sessionState?.getActiveRequestId() != null,
        isSettingsOpen: () => {
          const s = manager?.getSettingsWindow()
          return Boolean(s && !s.isDestroyed() && s.isVisible())
        },
        isCursorInside: () => {
          const w = manager?.getMainWindow()
          if (!w || w.isDestroyed() || !w.isVisible()) return false
          const p = screen.getCursorScreenPoint()
          const b = w.getBounds()
          return p.x >= b.x && p.x < b.x + b.width && p.y >= b.y && p.y < b.y + b.height
        },
        hideOnBlur: initialBehavior.hideOnBlur,
        streamingDelayMs: initialBehavior.streamingHideDelayMs,
        hide: (reason) => {
          manager?.hide()
          logger.info('auto_hide_fired', { reason })
        },
        logger: (event, fields) => logger.info(event, fields)
      })
      mainWindow.on('blur', () => autoHide?.onBlur())
      mainWindow.on('focus', () => autoHide?.onFocus())
      mainWindow.on('move', () => autoHide?.onMove())
      lifecycle.attachMainWindow(mainWindow)
      lifecycle.attachWebContents(mainWindow.webContents)
    }

    trayController = new TrayController({
      manager,
      emitNewSession: () => {
        const payload: UiNewSessionEvent = { source: 'tray' }
        sendUiEvent(IPC.EVENT_UI_NEW_SESSION, payload)
      },
      sessionNew: () => {
        void sessionState?.new()
      },
      sessionHistory: () => {
        void sessionState?.setMode('S3')
      },
      quit: () => {
        void lifecycle?.quit('tray')
      },
      onInteraction: () => autoHide?.suppress(1500),
      logger: (line) => {
        logger.line('info', line)
      }
    })
    try {
      trayController.create()
    } catch (error) {
      logger.line('error', `[tray] create failed: ${describeError(error)}`)
    }

    const shortcut = services.settings?.getShortcut() ?? { ...DEFAULT_SHORTCUT }
    hotkeyManager = new HotkeyManager({
      registry: globalShortcut,
      initialAccelerator: shortcut.accelerator,
      fallbacks: platform.hotkey.fallbacks,
      onTrigger: () => {
        void handleHotkey()
      },
      onNotice: (notice: UiNoticeEvent) => {
        sendUiEvent(IPC.EVENT_UI_NOTICE, notice)
      },
      logger: (line) => {
        logger.line('info', line)
      }
    })
    const hotkeyStatus = hotkeyManager.register()
    logger.info('hotkey_status', {
      registered: hotkeyStatus.registered,
      accelerator: hotkeyStatus.accelerator,
      conflict: hotkeyStatus.conflict
    })

    // F-08: an empty/unusable provider config opens S4 onboarding immediately
    // while the main S0 window stays hidden. QUICKASK_DISABLE_ONBOARDING=1 is
    // only used by e2e suites that exercise unrelated surfaces in a fresh dir.
    if (!onboardingDisabled()) {
      try {
        const onboarding = await getOnboardingState()
        if (onboarding.required) {
          await manager.openSettings({ onboarding: true })
          logger.info('onboarding_auto_opened', { reason: onboarding.reason })
        }
      } catch (error) {
        logger.error('onboarding_auto_open_failed', { detail: describeError(error) })
      }
    }

    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) {
        const recreated = manager?.create()
        if (recreated && lifecycle) {
          lifecycle.attachMainWindow(recreated)
          lifecycle.attachWebContents(recreated.webContents)
        }
      }
    })
  })
}

if (!app.requestSingleInstanceLock()) {
  app.quit()
} else {
  startFirstInstance()
}
