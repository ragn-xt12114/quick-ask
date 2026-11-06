/**
 * Typed surface exposed to the renderer as `window.quickask`.
 *
 * Preload implements this interface with `ipcRenderer.invoke` and
 * `ipcRenderer.on`; the renderer only ever sees these functions.
 */

import type {
  ActiveChat,
  AppOpenPathRequest,
  AppOpenPathResult,
  AppPathsInfo,
  AppSetStartupRequest,
  BootstrapInfo,
  ChatDeltaEvent,
  ChatEndEvent,
  ChatRegenerateRequest,
  ChatRequestResult,
  ChatRetryRequest,
  ChatSendRequest,
  ChatStopRequest,
  ChatStopResult,
  ClipboardReadTextResult,
  ClipboardWriteTextResult,
  DataCleanupRequest,
  DataCleanupResult,
  DraftsGetRequest,
  DraftsGetResult,
  DraftsSetRequest,
  DraftsSetResult,
  HotkeySetRequest,
  HotkeyStatus,
  LinksOpenExternalResult,
  ListFontsResult,
  ProviderCreateRequest,
  ProviderDeleteRequest,
  ProviderDeleteResult,
  ProviderGetRequest,
  ProviderListModelsRequest,
  ProviderListModelsResult,
  ProviderListResult,
  ProviderProfileView,
  ProviderTestRequest,
  ProviderTestResult,
  ProviderUpdateRequest,
  ReadLogsRequest,
  ReadLogsResult,
  Session,
  SessionsClearAllResult,
  SessionsCreateRequest,
  SessionsDeleteRequest,
  SessionsDeleteResult,
  SessionsExportRequest,
  SessionsExportResult,
  SessionsGetMessagesRequest,
  SessionsGetMessagesResult,
  SessionsGetRequest,
  SessionsListRequest,
  SessionsListResult,
  SessionsNewResult,
  SessionsOpenRequest,
  SessionsOpenResult,
  SessionsRenameRequest,
  SessionsStateResult,
  SettingsGetAllResult,
  SettingsSetRequest,
  SettingsSetResult,
  StartupState,
  UiAppearanceEvent,
  UiNewSessionEvent,
  UiOnboardingEvent,
  UiNoticeEvent,
  UiSettingsEvent,
  UiSessionEvent,
  UiStateEvent,
  WindowMode,
  WindowOpenSettingsRequest,
  WindowSetBarWidthResult,
  WindowSetHeightRequest,
  WindowSetHeightResult,
  WindowSetModeResult,
  WindowSettingsResult,
  WindowState
} from './channels'
import type { IpcResult } from './ipc'

export interface QuickAskApi {
  app: {
    bootstrap(): Promise<IpcResult<BootstrapInfo>>
    /** Unregister all hotkeys and retry the primary accelerator first. */
    retryHotkey(): Promise<IpcResult<HotkeyStatus>>
    /** Transactionally record a new global shortcut; conflicts restore the old one. */
    setHotkey(request: HotkeySetRequest): Promise<IpcResult<HotkeyStatus>>
    /** Read-only data/config/log/db paths for Settings → Data/About. */
    paths(): Promise<IpcResult<AppPathsInfo>>
    /** Open a resolved local directory only (`data` / `config` / `logs`). */
    openPath(kind: AppOpenPathRequest['kind']): Promise<IpcResult<AppOpenPathResult>>
    listFonts(): Promise<IpcResult<ListFontsResult>>
    readLogs(request?: ReadLogsRequest): Promise<IpcResult<ReadLogsResult>>
    /** Persist login/watchdog flags and synchronize the XDG autostart file. */
    setStartup(request: AppSetStartupRequest): Promise<IpcResult<StartupState>>
    /** Subscribe to visible UI notices; returns an unsubscribe fn. */
    onNotice(listener: (event: UiNoticeEvent) => void): () => void
    /** Subscribe to "new session" requests from the tray; returns an unsubscribe fn. */
    onNewSession(listener: (event: UiNewSessionEvent) => void): () => void
    /** Theme/primary/opacity/bar-width changes from main; returns an unsubscribe fn. */
    onAppearance(listener: (event: UiAppearanceEvent) => void): () => void
    /** Onboarding requirement changes after provider CRUD; returns an unsubscribe fn. */
    onOnboarding(listener: (event: UiOnboardingEvent) => void): () => void
    /** Any non-secret settings/bundle change from main; returns an unsubscribe fn. */
    onSettings(listener: (event: UiSettingsEvent) => void): () => void
  }

  window: {
    show(): Promise<IpcResult<WindowState>>
    hide(): Promise<IpcResult<WindowState>>
    getState(): Promise<IpcResult<WindowState>>
    setMode(mode: WindowMode): Promise<IpcResult<WindowSetModeResult>>
    setHeight(request: WindowSetHeightRequest): Promise<IpcResult<WindowSetHeightResult>>
    /** F-07 bar width; clamped/snapped by main. */
    setBarWidth(width: number): Promise<IpcResult<WindowSetBarWidthResult>>
    openSettings(
      options?: WindowOpenSettingsRequest
    ): Promise<IpcResult<WindowSettingsResult>>
    closeSettings(): Promise<IpcResult<WindowSettingsResult>>
    /** Subscribe to main-process UI state changes; returns an unsubscribe fn. */
    onState(listener: (event: UiStateEvent) => void): () => void
  }

  chat: {
    send(request: ChatSendRequest): Promise<IpcResult<ChatRequestResult>>
    stop(request: ChatStopRequest): Promise<IpcResult<ChatStopResult>>
    retry(request: ChatRetryRequest): Promise<IpcResult<ChatRequestResult>>
    regenerate(request: ChatRegenerateRequest): Promise<IpcResult<ChatRequestResult>>
    getActive(): Promise<IpcResult<{ active: ActiveChat | null }>>
    /** Subscribe to streamed deltas; returns an unsubscribe fn. */
    onDelta(listener: (event: ChatDeltaEvent) => void): () => void
    /** Subscribe to stream completion; returns an unsubscribe fn. */
    onEnd(listener: (event: ChatEndEvent) => void): () => void
  }

  sessions: {
    list(request?: SessionsListRequest): Promise<IpcResult<SessionsListResult>>
    get(request: SessionsGetRequest): Promise<IpcResult<Session>>
    getMessages(
      request: SessionsGetMessagesRequest
    ): Promise<IpcResult<SessionsGetMessagesResult>>
    create(request?: SessionsCreateRequest): Promise<IpcResult<Session>>
    rename(request: SessionsRenameRequest): Promise<IpcResult<Session>>
    delete(request: SessionsDeleteRequest): Promise<IpcResult<SessionsDeleteResult>>
    /** Main state: abort+persist the active stream, then load a session (S2). */
    open(request: SessionsOpenRequest): Promise<IpcResult<SessionsOpenResult>>
    /** Main state: abort+persist, clear the current session, enter S1. Never creates a row. */
    new: () => Promise<IpcResult<SessionsNewResult>>
    /** Current main session state plus persisted messages for hydration. */
    state(): Promise<IpcResult<SessionsStateResult>>
    /** Delete every session (cascade messages/drafts/search); resets state to null/S1. */
    clearAll(): Promise<IpcResult<SessionsClearAllResult>>
    export(request: SessionsExportRequest): Promise<IpcResult<SessionsExportResult>>
    /** Subscribe to main session state changes; returns an unsubscribe fn. */
    onSession(listener: (event: UiSessionEvent) => void): () => void
  }

  drafts: {
    get(request: DraftsGetRequest): Promise<IpcResult<DraftsGetResult>>
    set(request: DraftsSetRequest): Promise<IpcResult<DraftsSetResult>>
  }

  data: {
    cleanup(request?: DataCleanupRequest): Promise<IpcResult<DataCleanupResult>>
  }

  settings: {
    getAll(): Promise<IpcResult<SettingsGetAllResult>>
    set(request: SettingsSetRequest): Promise<IpcResult<SettingsSetResult>>
  }

  provider: {
    list(): Promise<IpcResult<ProviderListResult>>
    get(request: ProviderGetRequest): Promise<IpcResult<ProviderProfileView>>
    create(request: ProviderCreateRequest): Promise<IpcResult<ProviderProfileView>>
    update(request: ProviderUpdateRequest): Promise<IpcResult<ProviderProfileView>>
    delete(request: ProviderDeleteRequest): Promise<IpcResult<ProviderDeleteResult>>
    test(request: ProviderTestRequest): Promise<IpcResult<ProviderTestResult>>
    listModels(
      request: ProviderListModelsRequest
    ): Promise<IpcResult<ProviderListModelsResult>>
  }

  clipboard: {
    readText(): Promise<IpcResult<ClipboardReadTextResult>>
    /** Write plain text through the main-process clipboard (no size bypass). */
    writeText(text: string): Promise<IpcResult<ClipboardWriteTextResult>>
  }

  links: {
    openExternal(url: string): Promise<IpcResult<LinksOpenExternalResult>>
  }
}
