/**
 * Runtime validation for the IPC surface.
 *
 * `channels.ts` holds the dependency-free wire types; this module adds the
 * zod schemas used by the main-process router. The sandboxed preload must
 * never import this file at runtime (type-only imports are fine).
 */

import { z } from 'zod'
import {
  ALL_IPC_CHANNELS,
  IPC,
  MAX_CHAT_IMAGE_BYTES,
  MAX_CHAT_IMAGE_BYTES_TOTAL,
  MAX_CHAT_IMAGES,
  type IpcChannel,
  type IpcRequestChannel,
  type JsonValue
} from './channels'
import { isValidAccelerator } from './settings'

// ---------------------------------------------------------------------------
// Result envelope / error taxonomy
// ---------------------------------------------------------------------------

export const IPC_ERROR_CODES = [
  'INVALID_ARGUMENT',
  'FORBIDDEN',
  'NOT_FOUND',
  'NOT_IMPLEMENTED',
  'INTERNAL',
  'DB_WRITE',
  'KEYRING_UNAVAILABLE',
  'KEYRING_LOCKED',
  'KEYRING_TIMEOUT',
  'KEYRING_DENIED',
  'KEYRING_NOT_FOUND',
  'SESSION_ONLY',
  'CONFIG_REQUIRED',
  'AUTH',
  'TIMEOUT',
  'BAD_REQUEST',
  'SERVER',
  'RATE_LIMIT',
  'REDIRECT',
  'NETWORK',
  'PROTOCOL',
  'ABORTED'
] as const

export type IpcErrorCode = (typeof IPC_ERROR_CODES)[number]

export interface IpcErrorPayload {
  code: IpcErrorCode
  message: string
  details?: JsonValue
}

export interface IpcFailure {
  ok: false
  error: IpcErrorPayload
}

export type IpcResult<T> = { ok: true; data: T } | IpcFailure

export function ok<T>(data: T): IpcResult<T> {
  return { ok: true, data }
}

export function fail(code: IpcErrorCode, message: string, details?: JsonValue): IpcFailure {
  const error: IpcErrorPayload = { code, message }
  if (details !== undefined) error.details = details
  return { ok: false, error }
}

export class IpcError extends Error {
  readonly code: IpcErrorCode
  readonly details?: JsonValue

  constructor(code: IpcErrorCode, message: string, details?: JsonValue) {
    super(message)
    this.name = 'IpcError'
    this.code = code
    this.details = details
  }
}

export function isIpcFailure(value: unknown): value is IpcFailure {
  return (
    typeof value === 'object' &&
    value !== null &&
    (value as { ok?: unknown }).ok === false
  )
}

export function isIpcSuccess(value: unknown): value is { ok: true; data: unknown } {
  return (
    typeof value === 'object' &&
    value !== null &&
    (value as { ok?: unknown }).ok === true &&
    'data' in value
  )
}

/**
 * Convert a thrown value into a typed result. Unknown errors never leak
 * their message (it may contain URLs, headers or credentials).
 */
export function toIpcFailure(error: unknown): IpcFailure {
  if (error instanceof IpcError) {
    return fail(error.code, error.message, error.details)
  }
  if (error instanceof Error && error.name === 'AbortError') {
    return fail('ABORTED', 'Operation aborted')
  }
  return fail('INTERNAL', 'Internal error')
}

// ---------------------------------------------------------------------------
// JSON value schema (settings payloads, error details)
// ---------------------------------------------------------------------------

export const jsonValueSchema: z.ZodType<JsonValue> = z.lazy(() =>
  z.union([
    z.string(),
    z.number(),
    z.boolean(),
    z.null(),
    z.array(jsonValueSchema),
    z.record(z.string(), jsonValueSchema)
  ])
)

// ---------------------------------------------------------------------------
// Shared field schemas
// ---------------------------------------------------------------------------

const idSchema = z.string().min(1).max(64)
const titleSchema = z.string().trim().min(1).max(200)
const chatTextSchema = z.string().trim().min(1).max(50_000)
const draftTextSchema = z.string().max(50_000)
const windowModeSchema = z.enum(['S0', 'S1', 'S2', 'S3', 'S4'])
const mainWindowModeSchema = z.enum(['S0', 'S1', 'S2', 'S3'])

const windowBoundsSchema = z
  .object({
    x: z.number().int(),
    y: z.number().int(),
    width: z.number().int().positive(),
    height: z.number().int().positive()
  })
  .strict()

const layoutRectSchema = z
  .object({
    x: z.number().int(),
    y: z.number().int(),
    width: z.number().int().nonnegative(),
    height: z.number().int().nonnegative()
  })
  .strict()

const windowLayoutSchema = z
  .object({
    mode: z.enum(['S1', 'S2', 'S3']),
    windowBounds: windowBoundsSchema,
    windowBoundsDevice: layoutRectSchema,
    barRect: layoutRectSchema,
    panelRect: layoutRectSchema.optional(),
    sidebarRect: layoutRectSchema.optional(),
    visualBounds: layoutRectSchema,
    overlay: z.boolean(),
    scaleFactor: z.number().positive(),
    anchor: z
      .object({ x: z.number().int(), y: z.number().int() })
      .strict()
  })
  .strict()

const windowDisplaySchema = z
  .object({
    id: z.number().int(),
    workArea: windowBoundsSchema,
    scaleFactor: z.number().positive()
  })
  .strict()

const windowStateSchema = z
  .object({
    mode: mainWindowModeSchema,
    visible: z.boolean(),
    bounds: windowBoundsSchema,
    display: windowDisplaySchema,
    layout: windowLayoutSchema.nullable()
  })
  .strict()

const sessionSummarySchema = z
  .object({
    id: z.string().min(1),
    title: z.string(),
    updatedAt: z.number().int(),
    lastMessageAt: z.number().int().nullable(),
    model: z.string().nullable()
  })
  .strict()

const sessionSchema = sessionSummarySchema
  .extend({
    titleAuto: z.boolean(),
    createdAt: z.number().int(),
    systemPrompt: z.string().nullable()
  })
  .strict()

const chatImageDataUrlSchema = z
  .string()
  .min(32)
  .max(8_000_000)
  .regex(/^data:image\/(?:jpeg|png|webp);base64,[A-Za-z0-9+/]+={0,2}$/, 'invalid image data URL')

const chatImageSchema = z
  .object({
    dataUrl: chatImageDataUrlSchema,
    mime: z.enum(['image/jpeg', 'image/png', 'image/webp']),
    width: z.number().int().positive().max(20_000),
    height: z.number().int().positive().max(20_000),
    bytes: z.number().int().nonnegative().max(MAX_CHAT_IMAGE_BYTES)
  })
  .strict()

/** Max 4 images per message, at most 12 MiB decoded in total. */
const chatImagesSchema = z
  .array(chatImageSchema)
  .max(MAX_CHAT_IMAGES)
  .refine(
    (images) => images.reduce((sum, image) => sum + image.bytes, 0) <= MAX_CHAT_IMAGE_BYTES_TOTAL,
    'images exceed the total size limit'
  )

const chatMessageSchema = z
  .object({
    id: z.string().min(1),
    sessionId: z.string().min(1),
    seq: z.number().int().nonnegative(),
    role: z.enum(['user', 'assistant', 'system']),
    content: z.string(),
    images: chatImagesSchema.optional(),
    status: z.enum(['streaming', 'complete', 'stopped', 'interrupted', 'error']),
    errorCode: z.string().nullable(),
    errorDetail: z.string().nullable(),
    model: z.string().nullable(),
    createdAt: z.number().int(),
    updatedAt: z.number().int()
  })
  .strict()

const activeChatSchema = z
  .object({
    requestId: z.string().min(1),
    sessionId: z.string().min(1),
    messageId: z.string().min(1),
    startedAt: z.number().int(),
    /** In-memory accumulated text (may be slightly ahead of the DB). */
    content: z.string(),
    status: z.enum(['streaming'])
  })
  .strict()

const chatRequestResultSchema = z
  .object({
    requestId: z.string().min(1),
    sessionId: z.string().min(1)
  })
  .strict()

const httpUrlSchema = z
  .string()
  .max(2048)
  .refine((value) => {
    try {
      const url = new URL(value)
      return url.protocol === 'http:' || url.protocol === 'https:'
    } catch {
      return false
    }
  }, 'must be an http(s) URL')

const appearanceSchema = z
  .object({
    theme: z.enum(['dark', 'light', 'system']),
    primary: z.enum(['everforest', 'nord', 'kanagawa', 'gruvbox', 'solarized', 'catppuccin']),
    opacity: z.number().int().min(40).max(100),
    blurEnabled: z.boolean(),
    barWidth: z.number().int().min(560).max(900),
    fontFamily: z.string().min(1).max(120),
    fontSize: z.number().int().min(12).max(18)
  })
  .strict()

const shortcutSchema = z
  .object({
    accelerator: z.string().min(3).max(64)
  })
  .strict()

const behaviorSchema = z
  .object({
    escDirectHide: z.boolean(),
    hideOnBlur: z.boolean(),
    streamingHideDelayMs: z.number().int().min(500).max(10000),
    contextRounds: z.number().int().min(1).max(50)
  })
  .strict()

const inferenceSchema = z
  .object({
    systemPrompt: z.string().max(8000),
    temperature: z.number().min(0).max(2).nullable(),
    maxTokens: z.number().int().min(1).max(32768).nullable(),
    timeoutMs: z.number().int().min(5000).max(300000)
  })
  .strict()

const dataSchema = z
  .object({
    retentionDays: z.number().int().min(1).max(3650).nullable(),
    lastExportPath: z.string().nullable()
  })
  .strict()

const windowSettingsSchema = z
  .object({
    positions: z.record(
      z.string().min(1).max(200),
      z.object({ x: z.number().int(), y: z.number().int() }).strict()
    )
  })
  .strict()

const startupSettingsSchema = z
  .object({
    autostart: z.boolean(),
    watchdog: z.boolean()
  })
  .strict()

const settingsBundleSchema = z
  .object({
    appearance: appearanceSchema,
    shortcut: shortcutSchema,
    behavior: behaviorSchema,
    inference: inferenceSchema,
    data: dataSchema,
    window: windowSettingsSchema,
    startup: startupSettingsSchema,
    schemaVersion: z.literal(2)
  })
  .strict()

const startupStateSchema = z
  .object({
    autostart: z.boolean(),
    watchdog: z.boolean(),
    desktopPath: z.string().min(1),
    desktopExists: z.boolean(),
    error: z.string().nullable()
  })
  .strict()

const onboardingStateSchema = z
  .object({
    required: z.boolean(),
    reason: z.enum(['no_profile', 'no_key', 'incomplete']).nullable()
  })
  .strict()

const blurStatusSchema = z
  .object({
    available: z.boolean(),
    reason: z.string().nullable(),
    compositor: z.boolean().nullable(),
    effectEnabled: z.boolean().nullable()
  })
  .strict()

const capabilityStatusSchema = z
  .object({
    state: z.enum(['available', 'degraded', 'unsupported']),
    reason: z.string().max(300).nullable()
  })
  .strict()

const platformCapabilitiesSchema = z
  .object({
    platform: z.enum(['linux', 'win32', 'other']),
    label: z.string().min(1).max(80),
    hotkey: capabilityStatusSchema,
    clickThrough: capabilityStatusSchema
      .extend({ precision: z.enum(['shape', 'whole-window', 'none']) })
      .strict(),
    blur: capabilityStatusSchema,
    fonts: capabilityStatusSchema
      .extend({ source: z.enum(['fc-list', 'static', 'none']) })
      .strict(),
    autostart: capabilityStatusSchema
      .extend({ mechanism: z.enum(['xdg-desktop', 'login-item', 'none']) })
      .strict(),
    watchdog: capabilityStatusSchema,
    nativeHelper: capabilityStatusSchema
  })
  .strict()

const noPayloadSchema = z.undefined()

const hotkeyAttemptSchema = z
  .object({
    accelerator: z.string().min(1),
    ok: z.boolean(),
    error: z.string().optional()
  })
  .strict()

export const hotkeyStatusSchema = z
  .object({
    registered: z.boolean(),
    accelerator: z.string().min(1).nullable(),
    primary: z.string().min(1),
    conflict: z.boolean(),
    tried: z.array(hotkeyAttemptSchema),
    alternatives: z.array(z.string().min(1)),
    error: z.string().optional()
  })
  .strict()

const providerHeaderInputSchema = z
  .object({
    name: z.string().min(1).max(128),
    value: z.string().max(8192).optional(),
    secret: z.boolean().optional()
  })
  .strict()

const providerHeaderViewSchema = z
  .object({
    name: z.string().min(1),
    secret: z.boolean(),
    hasValue: z.boolean()
  })
  .strict()

const providerProxyAuthInputSchema = z
  .object({
    username: z.string().max(256),
    password: z.string().max(2048).optional()
  })
  .strict()

const providerProfileViewSchema = z
  .object({
    id: z.string().min(1),
    name: z.string().min(1),
    baseUrl: z.string().min(1),
    model: z.string(),
    hasApiKey: z.boolean(),
    headers: z.array(providerHeaderViewSchema),
    proxyMode: z.enum(['direct', 'system', 'custom']),
    proxyUrl: z.string().nullable(),
    hasProxyAuth: z.boolean(),
    proxyUsernameMasked: z.string().optional(),
    temperature: z.number().nullable(),
    maxTokens: z.number().int().nullable(),
    timeoutMs: z.number().int(),
    isDefault: z.boolean(),
    createdAt: z.number().int(),
    updatedAt: z.number().int()
  })
  .strict()

const providerProfileFields = {
  name: z.string().trim().min(1).max(100),
  baseUrl: httpUrlSchema,
  model: z.string().max(200),
  headers: z.array(providerHeaderInputSchema).max(32).optional(),
  proxyMode: z.string().max(32).optional(),
  proxyUrl: z.string().max(2048).nullable().optional(),
  proxyAuth: providerProxyAuthInputSchema.nullable().optional(),
  temperature: z.number().min(0).max(2).nullable().optional(),
  maxTokens: z.number().int().min(1).max(1_000_000).nullable().optional(),
  timeoutMs: z.number().int().min(1000).max(600_000).optional(),
  isDefault: z.boolean().optional()
}

const providerCreateSchema = z
  .object({
    ...providerProfileFields,
    apiKey: z.string().max(8192).optional()
  })
  .strict()

const providerUpdateSchema = z
  .object({
    id: idSchema,
    name: providerProfileFields.name.optional(),
    baseUrl: httpUrlSchema.optional(),
    model: providerProfileFields.model.optional(),
    apiKey: z.string().max(8192).nullable().optional(),
    headers: providerProfileFields.headers,
    proxyMode: providerProfileFields.proxyMode,
    proxyUrl: providerProfileFields.proxyUrl,
    proxyAuth: providerProfileFields.proxyAuth,
    temperature: providerProfileFields.temperature,
    maxTokens: providerProfileFields.maxTokens,
    timeoutMs: providerProfileFields.timeoutMs,
    isDefault: providerProfileFields.isDefault
  })
  .strict()

// ---------------------------------------------------------------------------
// Request schemas
// ---------------------------------------------------------------------------

export const requestSchemas = {
  [IPC.APP_BOOTSTRAP]: noPayloadSchema,
  [IPC.APP_RETRY_HOTKEY]: noPayloadSchema,
  [IPC.APP_SET_HOTKEY]: z
    .object({
      accelerator: z
        .string()
        .min(3)
        .max(64)
        .refine(isValidAccelerator, 'must be an Electron accelerator with a modifier and a key')
    })
    .strict(),
  [IPC.APP_PATHS]: noPayloadSchema,
  [IPC.APP_OPEN_PATH]: z
    .object({ kind: z.enum(['data', 'config', 'logs']) })
    .strict(),
  [IPC.APP_SET_STARTUP]: z
    .object({
      autostart: z.boolean().optional(),
      watchdog: z.boolean().optional()
    })
    .strict(),
  [IPC.APP_LIST_FONTS]: noPayloadSchema,
  [IPC.APP_READ_LOGS]: z
    .object({ maxBytes: z.number().int().min(1).max(65536).optional() })
    .strict()
    .optional(),

  [IPC.WINDOW_SHOW]: noPayloadSchema,
  [IPC.WINDOW_HIDE]: noPayloadSchema,
  [IPC.WINDOW_GET_STATE]: noPayloadSchema,
  [IPC.WINDOW_SET_MODE]: z.object({ mode: windowModeSchema }).strict(),
  [IPC.WINDOW_SET_HEIGHT]: z
    .object({
      height: z.number().int().min(48).max(2160).optional(),
      panelHeight: z.number().int().min(0).max(2160).optional(),
      barLines: z.number().int().min(1).max(6).optional()
    })
    .strict()
    .refine(
      (value) =>
        value.height !== undefined ||
        value.panelHeight !== undefined ||
        value.barLines !== undefined,
      { message: 'at least one of height, panelHeight or barLines is required' }
    ),
  [IPC.WINDOW_SET_BAR_WIDTH]: z
    .object({ width: z.number().int().min(560).max(900) })
    .strict(),
  [IPC.WINDOW_OPEN_SETTINGS]: z
    .object({ onboarding: z.boolean().optional() })
    .strict()
    .optional(),
  [IPC.WINDOW_CLOSE_SETTINGS]: noPayloadSchema,

  [IPC.CHAT_SEND]: z
    .object({
      sessionId: idSchema.nullable(),
      text: chatTextSchema,
      images: chatImagesSchema.optional()
    })
    .strict(),
  [IPC.CHAT_STOP]: z.object({ requestId: idSchema }).strict(),
  [IPC.CHAT_RETRY]: z.object({ sessionId: idSchema, messageId: idSchema }).strict(),
  [IPC.CHAT_REGENERATE]: z
    .object({ sessionId: idSchema, messageId: idSchema.nullable() })
    .strict(),
  [IPC.CHAT_GET_ACTIVE]: noPayloadSchema,

  [IPC.SESSIONS_LIST]: z
    .object({
      query: z.string().max(200).optional(),
      limit: z.number().int().min(1).max(1000).optional(),
      offset: z.number().int().min(0).max(1_000_000).optional()
    })
    .strict(),
  [IPC.SESSIONS_GET]: z.object({ id: idSchema }).strict(),
  [IPC.SESSIONS_GET_MESSAGES]: z.object({ sessionId: idSchema }).strict(),
  [IPC.SESSIONS_CREATE]: z.object({ title: titleSchema.optional() }).strict(),
  [IPC.SESSIONS_RENAME]: z.object({ id: idSchema, title: titleSchema }).strict(),
  [IPC.SESSIONS_DELETE]: z.object({ id: idSchema }).strict(),
  [IPC.SESSIONS_OPEN]: z.object({ id: idSchema }).strict(),
  [IPC.SESSIONS_NEW]: z.object({}).strict(),
  [IPC.SESSIONS_STATE]: z.object({}).strict(),
  [IPC.SESSIONS_CLEAR_ALL]: noPayloadSchema,
  [IPC.SESSIONS_EXPORT]: z
    .object({
      format: z.enum(['json', 'markdown']),
      scope: z.enum(['current', 'all'])
    })
    .strict(),
  [IPC.DATA_CLEANUP]: z
    .object({ dryRun: z.boolean().optional() })
    .strict()
    .optional(),

  [IPC.DRAFTS_GET]: z.object({ sessionId: idSchema }).strict(),
  [IPC.DRAFTS_SET]: z.object({ sessionId: idSchema, text: draftTextSchema }).strict(),

  [IPC.SETTINGS_GET_ALL]: noPayloadSchema,
  [IPC.SETTINGS_SET]: z
    .object({
      key: z.string().min(1).max(128),
      value: jsonValueSchema
    })
    .strict(),

  [IPC.PROVIDER_LIST]: noPayloadSchema,
  [IPC.PROVIDER_GET]: z.object({ id: idSchema }).strict(),
  [IPC.PROVIDER_CREATE]: providerCreateSchema,
  [IPC.PROVIDER_UPDATE]: providerUpdateSchema,
  [IPC.PROVIDER_DELETE]: z.object({ id: idSchema }).strict(),
  [IPC.PROVIDER_TEST]: z.object({ profileId: idSchema }).strict(),
  [IPC.PROVIDER_LIST_MODELS]: z.object({ profileId: idSchema }).strict(),

  [IPC.CLIPBOARD_READ_TEXT]: noPayloadSchema,
  [IPC.CLIPBOARD_WRITE_TEXT]: z
    .object({ text: z.string().max(1_000_000) })
    .strict(),
  [IPC.LINKS_OPEN_EXTERNAL]: z.object({ url: httpUrlSchema }).strict()
} satisfies Record<IpcRequestChannel, z.ZodType>

// ---------------------------------------------------------------------------
// Response schemas (validate handler output before it crosses the bridge)
// ---------------------------------------------------------------------------

export const responseSchemas = {
  [IPC.APP_BOOTSTRAP]: z
    .object({
      version: z.string().min(1),
      platform: z.string().min(1),
      dataDir: z.string().min(1),
      logsDir: z.string().min(1),
      firstRun: z.boolean(),
      hotkey: hotkeyStatusSchema,
      session: z
        .object({
          currentSessionId: z.string().min(1).nullable(),
          mode: mainWindowModeSchema
        })
        .strict(),
      appearance: appearanceSchema,
      settings: settingsBundleSchema,
      onboarding: onboardingStateSchema,
      blurStatus: blurStatusSchema,
      platformCapabilities: platformCapabilitiesSchema,
      opaqueMode: z.boolean(),
      animationDurationFactor: z.number().min(0).max(10)
    })
    .strict(),

  [IPC.APP_RETRY_HOTKEY]: hotkeyStatusSchema,
  [IPC.APP_SET_HOTKEY]: hotkeyStatusSchema,
  [IPC.APP_PATHS]: z
    .object({
      version: z.string().min(1),
      dataDir: z.string().min(1),
      configDir: z.string().min(1),
      logsDir: z.string().min(1),
      dbPath: z.string().min(1),
      schemaVersion: z.number().int().nonnegative()
    })
    .strict(),
  [IPC.APP_OPEN_PATH]: z.object({ opened: z.boolean() }).strict(),
  [IPC.APP_SET_STARTUP]: startupStateSchema,
  [IPC.APP_LIST_FONTS]: z
    .object({ fonts: z.array(z.string().min(1).max(120)), default: z.string().min(1) })
    .strict(),
  [IPC.APP_READ_LOGS]: z
    .object({
      path: z.string().min(1),
      content: z.string(),
      bytes: z.number().int().nonnegative(),
      truncated: z.boolean()
    })
    .strict(),

  [IPC.WINDOW_SHOW]: windowStateSchema,
  [IPC.WINDOW_HIDE]: windowStateSchema,
  [IPC.WINDOW_GET_STATE]: windowStateSchema,
  [IPC.WINDOW_SET_MODE]: z.object({ mode: windowModeSchema }).strict(),
  [IPC.WINDOW_SET_HEIGHT]: z
    .object({
      height: z.number().int().nonnegative(),
      barLines: z.number().int().min(1).max(6),
      panelHeight: z.number().int().nonnegative()
    })
    .strict(),
  [IPC.WINDOW_SET_BAR_WIDTH]: z.object({ width: z.number().int() }).strict(),
  [IPC.WINDOW_OPEN_SETTINGS]: z.object({ open: z.boolean() }).strict(),
  [IPC.WINDOW_CLOSE_SETTINGS]: z.object({ open: z.boolean() }).strict(),

  [IPC.CHAT_SEND]: chatRequestResultSchema,
  [IPC.CHAT_STOP]: z.object({ stopped: z.boolean() }).strict(),
  [IPC.CHAT_RETRY]: chatRequestResultSchema,
  [IPC.CHAT_REGENERATE]: chatRequestResultSchema,
  [IPC.CHAT_GET_ACTIVE]: z.object({ active: activeChatSchema.nullable() }).strict(),

  [IPC.SESSIONS_LIST]: z
    .object({ sessions: z.array(sessionSummarySchema) })
    .strict(),
  [IPC.SESSIONS_GET]: sessionSchema,
  [IPC.SESSIONS_GET_MESSAGES]: z
    .object({ messages: z.array(chatMessageSchema) })
    .strict(),
  [IPC.SESSIONS_CREATE]: sessionSchema,
  [IPC.SESSIONS_RENAME]: sessionSchema,
  [IPC.SESSIONS_DELETE]: z.object({ deleted: z.boolean() }).strict(),
  [IPC.SESSIONS_OPEN]: z
    .object({ session: sessionSchema, messages: z.array(chatMessageSchema) })
    .strict(),
  [IPC.SESSIONS_NEW]: z
    .object({
      currentSessionId: z.string().min(1).nullable(),
      mode: z.literal('S1')
    })
    .strict(),
  [IPC.SESSIONS_STATE]: z
    .object({
      currentSessionId: z.string().min(1).nullable(),
      mode: mainWindowModeSchema,
      activeRequestId: z.string().min(1).nullable(),
      messages: z.array(chatMessageSchema)
    })
    .strict(),
  [IPC.SESSIONS_CLEAR_ALL]: z
    .object({ cleared: z.number().int().nonnegative() })
    .strict(),
  [IPC.SESSIONS_EXPORT]: z
    .object({
      path: z.string().min(1),
      count: z.number().int().nonnegative(),
      bytes: z.number().int().nonnegative()
    })
    .strict(),
  [IPC.DATA_CLEANUP]: z
    .object({
      cleaned: z.number().int().nonnegative(),
      retentionDays: z.number().int().min(1).max(3650).nullable(),
      lastCleanupAt: z.number().int().nullable()
    })
    .strict(),

  [IPC.DRAFTS_GET]: z.object({ text: z.string() }).strict(),
  [IPC.DRAFTS_SET]: z.object({ saved: z.boolean() }).strict(),

  [IPC.SETTINGS_GET_ALL]: z
    .object({ settings: z.record(z.string(), jsonValueSchema) })
    .strict(),
  [IPC.SETTINGS_SET]: z.object({ saved: z.boolean() }).strict(),

  [IPC.PROVIDER_LIST]: z.object({ profiles: z.array(providerProfileViewSchema) }).strict(),
  [IPC.PROVIDER_GET]: providerProfileViewSchema,
  [IPC.PROVIDER_CREATE]: providerProfileViewSchema,
  [IPC.PROVIDER_UPDATE]: providerProfileViewSchema,
  [IPC.PROVIDER_DELETE]: z
    .object({ deleted: z.boolean(), keyringCleanup: z.boolean() })
    .strict(),
  [IPC.PROVIDER_TEST]: z
    .object({
      ok: z.boolean(),
      latencyMs: z.number().int().nonnegative(),
      status: z.number().int().optional(),
      models: z.array(z.string()).optional(),
      error: z.object({ code: z.string(), message: z.string() }).strict().optional()
    })
    .strict(),
  [IPC.PROVIDER_LIST_MODELS]: z.object({ models: z.array(z.string()) }).strict(),

  [IPC.CLIPBOARD_READ_TEXT]: z.object({ text: z.string() }).strict(),
  [IPC.CLIPBOARD_WRITE_TEXT]: z.object({ written: z.boolean() }).strict(),
  [IPC.LINKS_OPEN_EXTERNAL]: z.object({ opened: z.boolean() }).strict()
} satisfies Record<IpcRequestChannel, z.ZodType>

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const KNOWN_CHANNELS: ReadonlySet<string> = new Set<string>(ALL_IPC_CHANNELS)

export function isKnownChannel(channel: string): channel is IpcChannel {
  return KNOWN_CHANNELS.has(channel)
}

export function requestSchemaFor(channel: IpcRequestChannel): z.ZodType {
  return requestSchemas[channel]
}

export function responseSchemaFor(channel: IpcRequestChannel): z.ZodType {
  return responseSchemas[channel]
}

/**
 * Concise, human-readable validation message (path + expectation).
 * Never dump the raw ZodError object across IPC.
 */
export function formatZodError(error: z.ZodError): string {
  const issues = error.issues.slice(0, 3).map((issue) => {
    const path = issue.path.length > 0 ? issue.path.map(String).join('.') : '(root)'
    return `${path}: ${issue.message}`
  })
  const message = issues.join('; ')
  return message.length > 500 ? `${message.slice(0, 497)}...` : message
}
