/**
 * IPC channel names and wire types shared by main, preload and renderer.
 *
 * This module MUST stay dependency-free (no zod): the sandboxed preload
 * imports it at runtime, and the preload bundle should stay tiny.
 * Validation schemas live in `ipc.ts`.
 */

import type { WindowLayout } from './geometry'
import type { PlatformCapabilities } from './platform'
import type {
  AppearanceSettings,
  NormalizedSettings,
  OnboardingReason,
  SettingsBundle
} from './settings'

export type { BarAnchor, LayoutMode, Rect, WindowLayout } from './geometry'

export const IPC = {
  APP_BOOTSTRAP: 'app:bootstrap',
  APP_RETRY_HOTKEY: 'app:retry-hotkey',
  APP_SET_HOTKEY: 'app:set-hotkey',
  APP_PATHS: 'app:paths',
  APP_OPEN_PATH: 'app:open-path',
  APP_SET_STARTUP: 'app:set-startup',
  APP_LIST_FONTS: 'app:list-fonts',
  APP_READ_LOGS: 'app:read-logs',

  WINDOW_SHOW: 'window:show',
  WINDOW_HIDE: 'window:hide',
  WINDOW_GET_STATE: 'window:get-state',
  WINDOW_SET_MODE: 'window:set-mode',
  WINDOW_SET_HEIGHT: 'window:set-height',
  WINDOW_SET_BAR_WIDTH: 'window:set-bar-width',
  WINDOW_OPEN_SETTINGS: 'window:open-settings',
  WINDOW_CLOSE_SETTINGS: 'window:close-settings',

  CHAT_SEND: 'chat:send',
  CHAT_STOP: 'chat:stop',
  CHAT_RETRY: 'chat:retry',
  CHAT_REGENERATE: 'chat:regenerate',
  CHAT_GET_ACTIVE: 'chat:get-active',

  SESSIONS_LIST: 'sessions:list',
  SESSIONS_GET: 'sessions:get',
  SESSIONS_GET_MESSAGES: 'sessions:get-messages',
  SESSIONS_CREATE: 'sessions:create',
  SESSIONS_RENAME: 'sessions:rename',
  SESSIONS_DELETE: 'sessions:delete',
  SESSIONS_OPEN: 'sessions:open',
  SESSIONS_NEW: 'sessions:new',
  SESSIONS_STATE: 'sessions:state',
  SESSIONS_CLEAR_ALL: 'sessions:clear-all',
  SESSIONS_EXPORT: 'sessions:export',
  DATA_CLEANUP: 'data:cleanup',

  DRAFTS_GET: 'drafts:get',
  DRAFTS_SET: 'drafts:set',

  SETTINGS_GET_ALL: 'settings:get-all',
  SETTINGS_SET: 'settings:set',

  PROVIDER_LIST: 'provider:list',
  PROVIDER_GET: 'provider:get',
  PROVIDER_CREATE: 'provider:create',
  PROVIDER_UPDATE: 'provider:update',
  PROVIDER_DELETE: 'provider:delete',
  PROVIDER_TEST: 'provider:test',
  PROVIDER_LIST_MODELS: 'provider:list-models',

  CLIPBOARD_READ_TEXT: 'clipboard:read-text',
  CLIPBOARD_WRITE_TEXT: 'clipboard:write-text',
  LINKS_OPEN_EXTERNAL: 'links:open-external',

  // main -> renderer events
  EVENT_CHAT_DELTA: 'chat:delta',
  EVENT_CHAT_END: 'chat:end',
  EVENT_UI_STATE: 'ui:state',
  EVENT_UI_NOTICE: 'ui:notice',
  EVENT_UI_NEW_SESSION: 'ui:new-session',
  EVENT_UI_SESSION: 'ui:session',
  EVENT_UI_APPEARANCE: 'ui:appearance',
  EVENT_UI_ONBOARDING: 'ui:onboarding',
  EVENT_UI_SETTINGS: 'ui:settings'
} as const

export type IpcChannel = (typeof IPC)[keyof typeof IPC]

export const IPC_REQUEST_CHANNELS = [
  IPC.APP_BOOTSTRAP,
  IPC.APP_RETRY_HOTKEY,
  IPC.APP_SET_HOTKEY,
  IPC.APP_PATHS,
  IPC.APP_OPEN_PATH,
  IPC.APP_SET_STARTUP,
  IPC.APP_LIST_FONTS,
  IPC.APP_READ_LOGS,
  IPC.WINDOW_SHOW,
  IPC.WINDOW_HIDE,
  IPC.WINDOW_GET_STATE,
  IPC.WINDOW_SET_MODE,
  IPC.WINDOW_SET_HEIGHT,
  IPC.WINDOW_SET_BAR_WIDTH,
  IPC.WINDOW_OPEN_SETTINGS,
  IPC.WINDOW_CLOSE_SETTINGS,
  IPC.CHAT_SEND,
  IPC.CHAT_STOP,
  IPC.CHAT_RETRY,
  IPC.CHAT_REGENERATE,
  IPC.CHAT_GET_ACTIVE,
  IPC.SESSIONS_LIST,
  IPC.SESSIONS_GET,
  IPC.SESSIONS_GET_MESSAGES,
  IPC.SESSIONS_CREATE,
  IPC.SESSIONS_RENAME,
  IPC.SESSIONS_DELETE,
  IPC.SESSIONS_OPEN,
  IPC.SESSIONS_NEW,
  IPC.SESSIONS_STATE,
  IPC.SESSIONS_CLEAR_ALL,
  IPC.SESSIONS_EXPORT,
  IPC.DATA_CLEANUP,
  IPC.DRAFTS_GET,
  IPC.DRAFTS_SET,
  IPC.SETTINGS_GET_ALL,
  IPC.SETTINGS_SET,
  IPC.PROVIDER_LIST,
  IPC.PROVIDER_GET,
  IPC.PROVIDER_CREATE,
  IPC.PROVIDER_UPDATE,
  IPC.PROVIDER_DELETE,
  IPC.PROVIDER_TEST,
  IPC.PROVIDER_LIST_MODELS,
  IPC.CLIPBOARD_READ_TEXT,
  IPC.CLIPBOARD_WRITE_TEXT,
  IPC.LINKS_OPEN_EXTERNAL
] as const

export type IpcRequestChannel = (typeof IPC_REQUEST_CHANNELS)[number]

export const IPC_EVENT_CHANNELS = [
  IPC.EVENT_CHAT_DELTA,
  IPC.EVENT_CHAT_END,
  IPC.EVENT_UI_STATE,
  IPC.EVENT_UI_NOTICE,
  IPC.EVENT_UI_NEW_SESSION,
  IPC.EVENT_UI_SESSION,
  IPC.EVENT_UI_APPEARANCE,
  IPC.EVENT_UI_ONBOARDING,
  IPC.EVENT_UI_SETTINGS
] as const

export type IpcEventChannel = (typeof IPC_EVENT_CHANNELS)[number]

export const ALL_IPC_CHANNELS = [...IPC_REQUEST_CHANNELS, ...IPC_EVENT_CHANNELS] as const

// ---------------------------------------------------------------------------
// Generic JSON values (settings payloads, error details)
// ---------------------------------------------------------------------------

export type JsonValue =
  | string
  | number
  | boolean
  | null
  | JsonValue[]
  | { [key: string]: JsonValue }

// ---------------------------------------------------------------------------
// app / hotkey
// ---------------------------------------------------------------------------

export interface HotkeyAttempt {
  accelerator: string
  ok: boolean
  error?: string
}

/**
 * Hotkey registration state. Always exposed through `app:bootstrap` and
 * `app:retry-hotkey` so a silent Electron registration failure is impossible.
 */
export interface HotkeyStatus {
  registered: boolean
  accelerator: string | null
  primary: string
  conflict: boolean
  tried: HotkeyAttempt[]
  alternatives: string[]
  error?: string
}

export interface HotkeySetRequest {
  accelerator: string
}

/** Read-only local paths surfaced in Settings → Data/About (never secrets). */
export interface AppPathsInfo {
  version: string
  dataDir: string
  configDir: string
  logsDir: string
  dbPath: string
  /** Settings schema version consumed by the UI (Task 32a v2). */
  schemaVersion: number
}

export type AppPathKind = 'data' | 'config' | 'logs'

export interface AppOpenPathRequest {
  kind: AppPathKind
}

export interface AppOpenPathResult {
  opened: boolean
}

export interface AppSetStartupRequest {
  autostart?: boolean
  watchdog?: boolean
}

export interface StartupState {
  autostart: boolean
  watchdog: boolean
  desktopPath: string
  desktopExists: boolean
  error: string | null
}

export type UiNoticeLevel = 'error' | 'warning' | 'info'

export interface UiNoticeEvent {
  level: UiNoticeLevel
  code: string
  message: string
}

export interface UiNewSessionEvent {
  source: 'tray' | 'hotkey'
}

export interface SessionBootstrapState {
  currentSessionId: string | null
  mode: MainWindowMode
}

/**
 * Honest KWin/compositor blur availability (Task 23 owns the state machine).
 * The UI must never present a blur intensity that the compositor cannot honor.
 */
export interface BlurStatus {
  available: boolean
  reason: string | null
  compositor: boolean | null
  effectEnabled: boolean | null
}

/**
 * Runtime appearance state that is not persisted: compositor/blur
 * availability, the opaque fallback and the KDE animation multiplier.
 */
export interface AppearanceRuntimeState {
  blurStatus: BlurStatus
  opaqueMode: boolean
  animationDurationFactor: number
}

export interface OnboardingState {
  required: boolean
  reason: OnboardingReason | null
}

export interface BootstrapInfo {
  version: string
  platform: string
  dataDir: string
  logsDir: string
  firstRun: boolean
  hotkey: HotkeyStatus
  session: SessionBootstrapState
  appearance: AppearanceSettings
  settings: SettingsBundle
  onboarding: OnboardingState
  blurStatus: BlurStatus
  platformCapabilities: PlatformCapabilities
  opaqueMode: boolean
  animationDurationFactor: number
}

// ---------------------------------------------------------------------------
// window (S1/S2/S3/S4)
// ---------------------------------------------------------------------------

export type MainWindowMode = 'S0' | 'S1' | 'S2' | 'S3'
export type WindowMode = MainWindowMode | 'S4'

export interface WindowBounds {
  x: number
  y: number
  width: number
  height: number
}

export interface WindowDisplayInfo {
  id: number
  workArea: WindowBounds
  scaleFactor: number
}

export interface WindowState {
  mode: MainWindowMode
  visible: boolean
  bounds: WindowBounds
  display: WindowDisplayInfo
  layout: WindowLayout | null
}

export interface WindowSetModeRequest {
  mode: WindowMode
}

export interface WindowSetModeResult {
  mode: WindowMode
}

export interface WindowSetHeightRequest {
  /** Window height in DIP; converted to a panel height by the manager. */
  height?: number
  panelHeight?: number
  barLines?: number
}

export interface WindowSetHeightResult {
  height: number
  barLines: number
  panelHeight: number
}

export interface WindowSetBarWidthRequest {
  /** Desired bar width in DIP; the main process clamps to 560–900. */
  width: number
}

export interface WindowSetBarWidthResult {
  width: number
}

export interface WindowOpenSettingsRequest {
  /** Auto-opens the F-08 wizard (`?settings=1&onboarding=1`). */
  onboarding?: boolean
}

export interface WindowSettingsResult {
  open: boolean
}

export interface UiStateEvent {
  mode: MainWindowMode
  visible: boolean
  layout: WindowLayout | null
  barLines: number
  panelHeight: number
  scaleFactor: number
}

// ---------------------------------------------------------------------------
// sessions / messages
// ---------------------------------------------------------------------------

export type MessageRole = 'user' | 'assistant' | 'system'

export type MessageStatus = 'streaming' | 'complete' | 'stopped' | 'interrupted' | 'error'

export interface SessionSummary {
  id: string
  title: string
  updatedAt: number
  lastMessageAt: number | null
  model: string | null
}

export interface Session extends SessionSummary {
  titleAuto: boolean
  createdAt: number
  systemPrompt: string | null
}

export type ChatImageMime = 'image/jpeg' | 'image/png' | 'image/webp'

/**
 * An image attached to a user message. The renderer downscales/re-encodes
 * every pasted image before it crosses IPC, so `dataUrl` is always a compact
 * JPEG/PNG/WebP payload that fits in a single message row.
 */
export interface ChatImage {
  /** Self-contained `data:<mime>;base64,<payload>` URL. */
  dataUrl: string
  mime: ChatImageMime
  width: number
  height: number
  /** Decoded payload size in bytes (limits + logs, never the pixel size). */
  bytes: number
}

/** OpenAI-compatible multimodal content parts. */
export type ChatContentPart =
  | { type: 'text'; text: string }
  | { type: 'image_url'; image_url: { url: string } }

/** Limits shared by the renderer, IPC validation and the orchestrator. */
export const MAX_CHAT_IMAGES = 4
export const MAX_CHAT_IMAGE_BYTES = 5 * 1024 * 1024
export const MAX_CHAT_IMAGE_BYTES_TOTAL = 12 * 1024 * 1024
/** Prompt used when the user pastes images without typing anything. */
export const IMAGE_ONLY_PROMPT = '请描述这张图片'

export interface ChatMessage {
  id: string
  sessionId: string
  seq: number
  role: MessageRole
  content: string
  /** Attachments for user rows; omitted/empty for assistant rows. */
  images?: ChatImage[]
  status: MessageStatus
  errorCode: string | null
  errorDetail: string | null
  model: string | null
  createdAt: number
  updatedAt: number
}

export interface SessionsListRequest {
  query?: string
  limit?: number
  offset?: number
}

export interface SessionsListResult {
  sessions: SessionSummary[]
}

export interface SessionsGetRequest {
  id: string
}

export interface SessionsGetMessagesRequest {
  sessionId: string
}

export interface SessionsGetMessagesResult {
  messages: ChatMessage[]
}

export interface SessionsCreateRequest {
  title?: string
}

export interface SessionsRenameRequest {
  id: string
  title: string
}

export interface SessionsDeleteRequest {
  id: string
}

export interface SessionsDeleteResult {
  deleted: boolean
}

export interface SessionsClearAllResult {
  /** Number of sessions removed; their messages/drafts/search rows cascade. */
  cleared: number
}

export type SessionsExportFormat = 'json' | 'markdown'
export type SessionsExportScope = 'current' | 'all'

export interface SessionsExportRequest {
  format: SessionsExportFormat
  scope: SessionsExportScope
}

export interface SessionsExportResult {
  path: string
  count: number
  bytes: number
}

export interface DataCleanupRequest {
  /** When true, count only; no rows are deleted. */
  dryRun?: boolean
}

export interface DataCleanupResult {
  cleaned: number
  retentionDays: number | null
  lastCleanupAt: number | null
}

export interface ListFontsResult {
  fonts: string[]
  default: string
}

export interface ReadLogsRequest {
  /** Max bytes from the tail of the active log file (default/cap 65536). */
  maxBytes?: number
}

export interface ReadLogsResult {
  path: string
  content: string
  bytes: number
  truncated: boolean
}

export interface SessionsOpenRequest {
  id: string
}

export interface SessionsOpenResult {
  session: Session
  messages: ChatMessage[]
}

export interface SessionsNewRequest {
  [key: string]: never
}

export interface SessionsNewResult {
  currentSessionId: string | null
  mode: 'S1'
}

export interface SessionsStateRequest {
  [key: string]: never
}

export interface SessionsStateResult {
  currentSessionId: string | null
  mode: MainWindowMode
  activeRequestId: string | null
  /** Persisted rows for the current session (empty when no session is open). */
  messages: ChatMessage[]
}

/**
 * Main-process session state change (open/new/delete/mode/send/end).
 * The event never carries message bodies; renderers hydrate through
 * `sessions:state` or the `sessions:open` response.
 */
export interface UiSessionEvent {
  currentSessionId: string | null
  mode: MainWindowMode
  activeRequestId: string | null
}

/** Main -> main/settings renderers after any appearance/runtime change. */
export type UiAppearanceEvent = AppearanceSettings & AppearanceRuntimeState

/** Main -> both renderers after any non-secret settings change. */
export interface UiSettingsEvent {
  settings: NormalizedSettings
}

/** Main -> main renderer after provider/settings changes. */
export type UiOnboardingEvent = OnboardingState

/**
 * The settings window is a second, less-trusted renderer. It may only use the
 * channels below; chat/session/window-visibility actions stay main-only.
 */
export const SETTINGS_WINDOW_CHANNELS = [
  IPC.APP_BOOTSTRAP,
  IPC.APP_SET_HOTKEY,
  IPC.APP_PATHS,
  IPC.APP_OPEN_PATH,
  IPC.APP_SET_STARTUP,
  IPC.APP_LIST_FONTS,
  IPC.APP_READ_LOGS,
  IPC.WINDOW_OPEN_SETTINGS,
  IPC.WINDOW_CLOSE_SETTINGS,
  IPC.WINDOW_SET_BAR_WIDTH,
  IPC.SESSIONS_CLEAR_ALL,
  IPC.SESSIONS_EXPORT,
  IPC.DATA_CLEANUP,
  IPC.SETTINGS_GET_ALL,
  IPC.SETTINGS_SET,
  IPC.PROVIDER_LIST,
  IPC.PROVIDER_GET,
  IPC.PROVIDER_CREATE,
  IPC.PROVIDER_UPDATE,
  IPC.PROVIDER_DELETE,
  IPC.PROVIDER_TEST,
  IPC.PROVIDER_LIST_MODELS
] as const

export type SettingsWindowChannel = (typeof SETTINGS_WINDOW_CHANNELS)[number]

// ---------------------------------------------------------------------------
// chat
// ---------------------------------------------------------------------------

export interface ChatSendRequest {
  /** `null` means "create a new session on send". */
  sessionId: string | null
  text: string
  /** Pasted clipboard images (max 4, already downscaled by the renderer). */
  images?: ChatImage[]
}

export interface ChatStopRequest {
  requestId: string
}

export interface ChatRetryRequest {
  sessionId: string
  messageId: string
}

export interface ChatRegenerateRequest {
  sessionId: string
  /** `null` regenerates the latest assistant message. */
  messageId: string | null
}

export interface ChatRequestResult {
  requestId: string
  sessionId: string
}

export interface ChatStopResult {
  stopped: boolean
}

export type ActiveChatStatus = 'streaming'

export interface ActiveChat {
  requestId: string
  sessionId: string
  messageId: string
  startedAt: number
  /** In-memory accumulated text (may be slightly ahead of the DB). */
  content: string
  status: ActiveChatStatus
}

export interface ChatGetActiveResult {
  active: ActiveChat | null
}

export type ChatEndStatus = 'complete' | 'stopped' | 'interrupted' | 'error'

export interface ChatDeltaEvent {
  requestId: string
  sessionId: string
  messageId: string
  delta: string
}

export interface ChatEndEvent {
  requestId: string
  sessionId: string
  messageId: string
  status: ChatEndStatus
  errorCode: string | null
  errorDetail: string | null
}

// ---------------------------------------------------------------------------
// drafts
// ---------------------------------------------------------------------------

export interface DraftsGetRequest {
  /** Session id, or the literal `new` for the composer of a fresh session. */
  sessionId: string
}

export interface DraftsGetResult {
  text: string
}

export interface DraftsSetRequest {
  sessionId: string
  text: string
}

export interface DraftsSetResult {
  saved: boolean
}

// ---------------------------------------------------------------------------
// settings / provider
// ---------------------------------------------------------------------------

export interface SettingsGetAllResult {
  settings: Record<string, JsonValue>
}

export interface SettingsSetRequest {
  key: string
  value: JsonValue
}

export interface SettingsSetResult {
  saved: boolean
}

export interface ProviderHeaderInput {
  name: string
  /** Omitted on update to keep the stored value. */
  value?: string
  secret?: boolean
}

export interface ProviderHeaderView {
  name: string
  secret: boolean
  hasValue: boolean
}

/**
 * Renderer-safe provider profile. `hasApiKey`/`hasValue` are the only
 * credential indicators; values and `key_ref` never cross the bridge.
 */
export type ProviderProxyMode = 'direct' | 'system' | 'custom'

export interface ProviderProxyAuthInput {
  username: string
  /** Omitted/empty keeps the stored password; `null` proxyAuth clears it. */
  password?: string
}

export interface ProviderProfileView {
  id: string
  name: string
  baseUrl: string
  model: string
  hasApiKey: boolean
  headers: ProviderHeaderView[]
  proxyMode: ProviderProxyMode
  proxyUrl: string | null
  hasProxyAuth: boolean
  proxyUsernameMasked?: string
  temperature: number | null
  maxTokens: number | null
  timeoutMs: number
  isDefault: boolean
  createdAt: number
  updatedAt: number
}

export interface ProviderListResult {
  profiles: ProviderProfileView[]
}

export interface ProviderGetRequest {
  id: string
}

export interface ProviderCreateRequest {
  name: string
  baseUrl: string
  model: string
  apiKey?: string
  headers?: ProviderHeaderInput[]
  proxyMode?: string
  proxyUrl?: string | null
  proxyAuth?: ProviderProxyAuthInput | null
  temperature?: number | null
  maxTokens?: number | null
  timeoutMs?: number
  isDefault?: boolean
}

export interface ProviderUpdateRequest {
  id: string
  name?: string
  baseUrl?: string
  model?: string
  /** `null` clears the stored key; omitted keeps it. */
  apiKey?: string | null
  headers?: ProviderHeaderInput[]
  proxyMode?: string
  proxyUrl?: string | null
  proxyAuth?: ProviderProxyAuthInput | null
  temperature?: number | null
  maxTokens?: number | null
  timeoutMs?: number
  isDefault?: boolean
}

export interface ProviderDeleteRequest {
  id: string
}

export interface ProviderDeleteResult {
  deleted: boolean
  /** True when keyring entries were removed (or absent). False = manual cleanup needed. */
  keyringCleanup: boolean
}

export interface ProviderTestRequest {
  profileId: string
}

export interface ProviderTestResult {
  ok: boolean
  latencyMs: number
  status?: number
  models?: string[]
  error?: {
    code: string
    message: string
  }
}

export interface ProviderListModelsRequest {
  profileId: string
}

export interface ProviderListModelsResult {
  models: string[]
}

// ---------------------------------------------------------------------------
// clipboard / links
// ---------------------------------------------------------------------------

export interface ClipboardReadTextResult {
  text: string
}

export interface ClipboardWriteTextRequest {
  text: string
}

export interface ClipboardWriteTextResult {
  written: boolean
}

export interface LinksOpenExternalRequest {
  url: string
}

export interface LinksOpenExternalResult {
  opened: boolean
}
