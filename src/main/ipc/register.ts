/**
 * Typed IPC router.
 *
 * Every handler validates the sender frame, then the payload, and returns an
 * `IpcResult` envelope. Raw exceptions never cross the bridge.
 *
 * Downstream tasks register their handlers on the same router before
 * `install()` is called (see `registerHandler`).
 */

import { app, ipcMain } from 'electron'
import type { BrowserWindow, IpcMainInvokeEvent } from 'electron'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import type { ZodType } from 'zod'
import {
  IPC,
  IPC_REQUEST_CHANNELS,
  SETTINGS_WINDOW_CHANNELS,
  type BlurStatus,
  type BootstrapInfo,
  type HotkeyStatus,
  type IpcRequestChannel,
  type OnboardingState,
  type SessionBootstrapState
} from '../../shared/channels'
import type { PlatformCapabilities } from '../../shared/platform'
import { getPlatform } from '../platform'
import {
  DEFAULT_APPEARANCE,
  isValidAccelerator,
  normalizeSettings,
  type AppearanceSettings,
  type SettingsBundle
} from '../../shared/settings'
import { defaultHotkeyStatus } from '../hotkey/manager'
import { resolveDataDir } from '../db'
import { getLogger } from '../logging'
import {
  fail,
  formatZodError,
  isIpcFailure,
  isIpcSuccess,
  ok,
  requestSchemas,
  responseSchemas,
  toIpcFailure,
  type IpcResult
} from '../../shared/ipc'
import { isAllowedRendererUrl, type SenderPolicy } from './sender'

export interface HandlerContext {
  event: IpcMainInvokeEvent
  window: BrowserWindow
}

export type IpcHandler<TReq, TRes> = (
  payload: TReq,
  context: HandlerContext
) => IpcResult<TRes> | Promise<IpcResult<TRes>>

interface RegisteredHandler {
  schema: ZodType
  handler: IpcHandler<unknown, unknown>
}

export interface IpcRouterOptions {
  getMainWindow: () => BrowserWindow | null
  /** The S4 settings renderer (second allow-listed sender). */
  getSettingsWindow?: () => BrowserWindow | null
  policy: SenderPolicy
}

const SETTINGS_ALLOWED: ReadonlySet<string> = new Set<string>(SETTINGS_WINDOW_CHANNELS)

export class IpcRouter {
  private readonly handlers = new Map<IpcRequestChannel, RegisteredHandler>()
  private installed = false

  constructor(private readonly options: IpcRouterOptions) {}

  /**
   * Register a handler. Must be called before `install()`.
   * `schema` validates the request payload; the response is checked against
   * the shared `responseSchemas` entry for the channel.
   */
  handle<TReq, TRes>(
    channel: IpcRequestChannel,
    schema: ZodType<TReq>,
    handler: IpcHandler<TReq, TRes>
  ): this {
    if (this.handlers.has(channel)) {
      throw new Error(`Duplicate IPC handler: ${channel}`)
    }
    this.handlers.set(channel, {
      schema,
      handler: handler as unknown as IpcHandler<unknown, unknown>
    })
    return this
  }

  install(): void {
    if (this.installed) {
      throw new Error('IPC router is already installed')
    }
    this.assertComplete()
    this.installed = true

    for (const [channel, entry] of this.handlers) {
      ipcMain.handle(channel, async (event, payload) => {
        try {
          const mainWindow = this.options.getMainWindow()
          const settingsWindow = this.options.getSettingsWindow?.() ?? null
          const senderFrameUrl = event.senderFrame?.url ?? null

          const isMain =
            Boolean(mainWindow && !mainWindow.isDestroyed()) &&
            event.sender === mainWindow?.webContents
          const isSettings =
            Boolean(settingsWindow && !settingsWindow.isDestroyed()) &&
            event.sender === settingsWindow?.webContents

          if (!isMain && !isSettings) {
            return fail('FORBIDDEN', 'Sender is not allowed')
          }
          if (!senderFrameUrl || !isAllowedRendererUrl(senderFrameUrl, this.options.policy)) {
            return fail('FORBIDDEN', 'Sender is not allowed')
          }
          // The settings renderer is second-class: it may manage settings and
          // providers but never chat, session state or main-window visibility.
          if (isSettings && !SETTINGS_ALLOWED.has(channel)) {
            return fail('FORBIDDEN', 'Channel is not allowed for the settings window')
          }

          const window = isMain ? mainWindow : settingsWindow
          if (!window) return fail('FORBIDDEN', 'Sender is not allowed')

          const parsed = entry.schema.safeParse(payload)
          if (!parsed.success) {
            return fail('INVALID_ARGUMENT', formatZodError(parsed.error))
          }

          const result = await entry.handler(parsed.data, { event, window })
          if (isIpcFailure(result)) return result
          if (!isIpcSuccess(result)) {
            return fail('INTERNAL', 'Handler returned an invalid result')
          }

          const response = responseSchemas[channel].safeParse(result.data)
          if (!response.success) {
            getLogger().error('ipc_invalid_response', {
              channel,
              detail: formatZodError(response.error)
            })
            return fail('INTERNAL', 'Handler returned an invalid response')
          }

          return ok(response.data)
        } catch (error) {
          const failure = toIpcFailure(error)
          // Never log payloads or raw Error messages: they may contain secrets.
          const detail =
            failure.error.code === 'INTERNAL'
              ? 'unhandled handler error'
              : failure.error.message
          getLogger().error('ipc_error', {
            channel,
            code: failure.error.code,
            detail
          })
          return failure
        }
      })
    }
  }

  assertComplete(): void {
    const missing = IPC_REQUEST_CHANNELS.filter((channel) => !this.handlers.has(channel))
    if (missing.length > 0) {
      throw new Error(`Missing IPC handlers: ${missing.join(', ')}`)
    }
  }
}

export function createIpcRouter(options: IpcRouterOptions): IpcRouter {
  return new IpcRouter(options)
}

/**
 * Convenience wrapper for downstream modules that add handlers to the router
 * created in `src/main/index.ts`.
 */
export function registerHandler<TReq, TRes>(
  router: IpcRouter,
  channel: IpcRequestChannel,
  schema: ZodType<TReq>,
  handler: IpcHandler<TReq, TRes>
): void {
  router.handle(channel, schema, handler)
}

function bootstrapInfo(
  hotkey: HotkeyStatus,
  session: SessionBootstrapState,
  appearance: AppearanceSettings,
  settings: SettingsBundle,
  onboarding: OnboardingState,
  blurStatus: BlurStatus,
  platformCapabilities: PlatformCapabilities,
  hostPlatform: string,
  opaqueMode: boolean,
  animationDurationFactor: number
): BootstrapInfo {
  const configDir = app.getPath('userData')
  return {
    version: app.getVersion(),
    platform: hostPlatform,
    dataDir: resolveDataDir(),
    logsDir: app.getPath('logs'),
    firstRun: !existsSync(join(configDir, 'settings.json')),
    hotkey,
    session,
    appearance,
    settings,
    onboarding,
    blurStatus,
    platformCapabilities,
    opaqueMode,
    animationDurationFactor
  }
}

export interface CoreHandlerOptions {
  getHotkeyStatus?: () => HotkeyStatus
  retryHotkey?: () => HotkeyStatus | Promise<HotkeyStatus>
  getSession?: () => SessionBootstrapState
  getAppearance?: () => AppearanceSettings
  getSettings?: () => SettingsBundle
  setHotkey?: (accelerator: string) => HotkeyStatus | Promise<HotkeyStatus>
  getOnboarding?: () => OnboardingState | Promise<OnboardingState>
  getBlurStatus?: () => BlurStatus
  getOpaqueMode?: () => boolean
  getAnimationDurationFactor?: () => number
  getHostPlatform?: () => string
  getPlatformCapabilities?: () => PlatformCapabilities
}

/**
 * Register the core surface (bootstrap, hotkey retry). Feature handlers
 * (window/chat/sessions/drafts/settings/provider/...) are registered by their
 * owning modules before `router.install()`.
 */
export function registerCoreHandlers(
  router: IpcRouter,
  options: CoreHandlerOptions = {}
): void {
  router.handle(IPC.APP_BOOTSTRAP, requestSchemas[IPC.APP_BOOTSTRAP], async () => {
    const onboarding = options.getOnboarding
      ? await options.getOnboarding()
      : { required: false, reason: null }
    const platform = getPlatform()
    return ok(
      bootstrapInfo(
        (options.getHotkeyStatus ?? defaultHotkeyStatus)(),
        options.getSession?.() ?? { currentSessionId: null, mode: 'S1' },
        options.getAppearance?.() ?? DEFAULT_APPEARANCE,
        options.getSettings?.() ?? normalizeSettings(undefined),
        onboarding,
        options.getBlurStatus?.() ?? {
          available: false,
          reason: null,
          compositor: null,
          effectEnabled: null
        },
        options.getPlatformCapabilities?.() ?? platform.info,
        options.getHostPlatform?.() ?? platform.hostPlatform,
        options.getOpaqueMode?.() ?? false,
        options.getAnimationDurationFactor?.() ?? 1
      )
    )
  })

  router.handle(IPC.APP_RETRY_HOTKEY, requestSchemas[IPC.APP_RETRY_HOTKEY], async () =>
    ok(await (options.retryHotkey?.() ?? defaultHotkeyStatus()))
  )

  router.handle(IPC.APP_SET_HOTKEY, requestSchemas[IPC.APP_SET_HOTKEY], async (payload) => {
    if (!isValidAccelerator(payload.accelerator)) {
      return fail('INVALID_ARGUMENT', 'invalid accelerator')
    }
    if (!options.setHotkey) {
      return fail('NOT_IMPLEMENTED', 'hotkey recording is unavailable')
    }
    return ok(await options.setHotkey(payload.accelerator))
  })
}
