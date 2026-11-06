/**
 * Sandboxed preload: the only bridge between the renderer and main.
 *
 * Only the typed `QuickAskApi` surface is exposed. `ipcRenderer`, Node
 * built-ins, `process` and raw channel strings never reach the renderer.
 */

import { contextBridge, ipcRenderer } from 'electron'
import type { IpcRendererEvent } from 'electron'
import { IPC } from '../shared/channels'
import type {
  ActiveChat,
  AppOpenPathResult,
  AppPathsInfo,
  AppSetStartupRequest,
  BootstrapInfo,
  ChatDeltaEvent,
  ChatEndEvent,
  ChatRequestResult,
  ChatStopResult,
  ClipboardReadTextResult,
  ClipboardWriteTextResult,
  DataCleanupRequest,
  DataCleanupResult,
  DraftsGetResult,
  DraftsSetResult,
  HotkeySetRequest,
  HotkeyStatus,
  IpcEventChannel,
  IpcRequestChannel,
  LinksOpenExternalResult,
  ListFontsResult,
  ProviderDeleteResult,
  ProviderListModelsResult,
  ProviderListResult,
  ProviderProfileView,
  ProviderTestResult,
  ReadLogsRequest,
  ReadLogsResult,
  Session,
  SessionsClearAllResult,
  SessionsDeleteResult,
  SessionsExportRequest,
  SessionsExportResult,
  SessionsGetMessagesResult,
  SessionsListResult,
  SessionsNewResult,
  SessionsOpenResult,
  SessionsStateResult,
  SettingsGetAllResult,
  SettingsSetResult,
  StartupState,
  UiAppearanceEvent,
  UiNewSessionEvent,
  UiOnboardingEvent,
  UiNoticeEvent,
  UiSettingsEvent,
  UiSessionEvent,
  UiStateEvent,
  WindowOpenSettingsRequest,
  WindowSetBarWidthResult,
  WindowSetHeightRequest,
  WindowSetHeightResult,
  WindowSetModeResult,
  WindowSettingsResult,
  WindowState
} from '../shared/channels'
import type { QuickAskApi } from '../shared/api'
import type { IpcResult } from '../shared/ipc'

function invoke<T>(channel: IpcRequestChannel, payload?: unknown): Promise<IpcResult<T>> {
  return ipcRenderer.invoke(channel, payload) as Promise<IpcResult<T>>
}

function subscribe<T>(
  channel: IpcEventChannel,
  listener: (payload: T) => void
): () => void {
  const wrapped = (_event: IpcRendererEvent, payload: T): void => {
    listener(payload)
  }
  ipcRenderer.on(channel, wrapped)
  return () => {
    ipcRenderer.removeListener(channel, wrapped)
  }
}

const api: QuickAskApi = {
  app: {
    bootstrap: () => invoke<BootstrapInfo>(IPC.APP_BOOTSTRAP),
    retryHotkey: () => invoke<HotkeyStatus>(IPC.APP_RETRY_HOTKEY),
    setHotkey: (request: HotkeySetRequest) =>
      invoke<HotkeyStatus>(IPC.APP_SET_HOTKEY, request),
    paths: () => invoke<AppPathsInfo>(IPC.APP_PATHS),
    openPath: (kind) => invoke<AppOpenPathResult>(IPC.APP_OPEN_PATH, { kind }),
    listFonts: () => invoke<ListFontsResult>(IPC.APP_LIST_FONTS),
    readLogs: (request?: ReadLogsRequest) =>
      invoke<ReadLogsResult>(IPC.APP_READ_LOGS, request),
    setStartup: (request: AppSetStartupRequest) =>
      invoke<StartupState>(IPC.APP_SET_STARTUP, request),
    onNotice: (listener) => subscribe<UiNoticeEvent>(IPC.EVENT_UI_NOTICE, listener),
    onNewSession: (listener) =>
      subscribe<UiNewSessionEvent>(IPC.EVENT_UI_NEW_SESSION, listener),
    onAppearance: (listener) =>
      subscribe<UiAppearanceEvent>(IPC.EVENT_UI_APPEARANCE, listener),
    onOnboarding: (listener) =>
      subscribe<UiOnboardingEvent>(IPC.EVENT_UI_ONBOARDING, listener),
    onSettings: (listener) =>
      subscribe<UiSettingsEvent>(IPC.EVENT_UI_SETTINGS, listener)
  },

  window: {
    show: () => invoke<WindowState>(IPC.WINDOW_SHOW),
    hide: () => invoke<WindowState>(IPC.WINDOW_HIDE),
    getState: () => invoke<WindowState>(IPC.WINDOW_GET_STATE),
    setMode: (mode) => invoke<WindowSetModeResult>(IPC.WINDOW_SET_MODE, { mode }),
    setHeight: (request: WindowSetHeightRequest) =>
      invoke<WindowSetHeightResult>(IPC.WINDOW_SET_HEIGHT, request),
    setBarWidth: (width: number) =>
      invoke<WindowSetBarWidthResult>(IPC.WINDOW_SET_BAR_WIDTH, { width }),
    openSettings: (options?: WindowOpenSettingsRequest) =>
      invoke<WindowSettingsResult>(IPC.WINDOW_OPEN_SETTINGS, options),
    closeSettings: () => invoke<WindowSettingsResult>(IPC.WINDOW_CLOSE_SETTINGS),
    onState: (listener) => subscribe<UiStateEvent>(IPC.EVENT_UI_STATE, listener)
  },

  chat: {
    send: (request) => invoke<ChatRequestResult>(IPC.CHAT_SEND, request),
    stop: (request) => invoke<ChatStopResult>(IPC.CHAT_STOP, request),
    retry: (request) => invoke<ChatRequestResult>(IPC.CHAT_RETRY, request),
    regenerate: (request) => invoke<ChatRequestResult>(IPC.CHAT_REGENERATE, request),
    getActive: () => invoke<{ active: ActiveChat | null }>(IPC.CHAT_GET_ACTIVE),
    onDelta: (listener) => subscribe<ChatDeltaEvent>(IPC.EVENT_CHAT_DELTA, listener),
    onEnd: (listener) => subscribe<ChatEndEvent>(IPC.EVENT_CHAT_END, listener)
  },

  sessions: {
    list: (request = {}) => invoke<SessionsListResult>(IPC.SESSIONS_LIST, request),
    get: (request) => invoke<Session>(IPC.SESSIONS_GET, request),
    getMessages: (request) =>
      invoke<SessionsGetMessagesResult>(IPC.SESSIONS_GET_MESSAGES, request),
    create: (request = {}) => invoke<Session>(IPC.SESSIONS_CREATE, request),
    rename: (request) => invoke<Session>(IPC.SESSIONS_RENAME, request),
    delete: (request) => invoke<SessionsDeleteResult>(IPC.SESSIONS_DELETE, request),
    open: (request) => invoke<SessionsOpenResult>(IPC.SESSIONS_OPEN, request),
    new: () => invoke<SessionsNewResult>(IPC.SESSIONS_NEW, {}),
    state: () => invoke<SessionsStateResult>(IPC.SESSIONS_STATE, {}),
    clearAll: () => invoke<SessionsClearAllResult>(IPC.SESSIONS_CLEAR_ALL),
    export: (request: SessionsExportRequest) =>
      invoke<SessionsExportResult>(IPC.SESSIONS_EXPORT, request),
    onSession: (listener) => subscribe<UiSessionEvent>(IPC.EVENT_UI_SESSION, listener)
  },

  drafts: {
    get: (request) => invoke<DraftsGetResult>(IPC.DRAFTS_GET, request),
    set: (request) => invoke<DraftsSetResult>(IPC.DRAFTS_SET, request)
  },

  data: {
    cleanup: (request?: DataCleanupRequest) =>
      invoke<DataCleanupResult>(IPC.DATA_CLEANUP, request)
  },

  settings: {
    getAll: () => invoke<SettingsGetAllResult>(IPC.SETTINGS_GET_ALL),
    set: (request) => invoke<SettingsSetResult>(IPC.SETTINGS_SET, request)
  },

  provider: {
    list: () => invoke<ProviderListResult>(IPC.PROVIDER_LIST),
    get: (request) => invoke<ProviderProfileView>(IPC.PROVIDER_GET, request),
    create: (request) => invoke<ProviderProfileView>(IPC.PROVIDER_CREATE, request),
    update: (request) => invoke<ProviderProfileView>(IPC.PROVIDER_UPDATE, request),
    delete: (request) => invoke<ProviderDeleteResult>(IPC.PROVIDER_DELETE, request),
    test: (request) => invoke<ProviderTestResult>(IPC.PROVIDER_TEST, request),
    listModels: (request) =>
      invoke<ProviderListModelsResult>(IPC.PROVIDER_LIST_MODELS, request)
  },

  clipboard: {
    readText: () => invoke<ClipboardReadTextResult>(IPC.CLIPBOARD_READ_TEXT),
    writeText: (text) =>
      invoke<ClipboardWriteTextResult>(IPC.CLIPBOARD_WRITE_TEXT, { text })
  },

  links: {
    openExternal: (url) => invoke<LinksOpenExternalResult>(IPC.LINKS_OPEN_EXTERNAL, { url })
  }
}

contextBridge.exposeInMainWorld('quickask', api)
