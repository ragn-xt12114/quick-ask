/**
 * Typed, non-secret settings contract shared by main and renderer.
 *
 * Persistence layout (SQLite `settings` table):
 *   appearance          -> AppearanceSettings (this file normalizes every read)
 *   model               -> ModelSettingsRef
 *   onboardingComplete  -> boolean
 *   shortcut            -> ShortcutSettings
 *   behavior            -> BehaviorSettings
 *   inference           -> InferenceSettings
 *   data                -> DataSettings
 *   window              -> WindowSettings (per-display bar anchors)
 *   startup             -> StartupSettings (XDG autostart + watchdog)
 *
 * This module is dependency-free so the sandboxed preload and the Node/Vitest
 * suites can import it. Secret-looking keys never reach this module: API keys
 * and header values live in SecretStore only.
 */

import {
  DEFAULT_WINDOW_SETTINGS,
  normalizeWindowSettings,
  type WindowSettings
} from './window-position'

export const SETTINGS_KEYS = {
  appearance: 'appearance',
  model: 'model',
  onboardingComplete: 'onboardingComplete',
  shortcut: 'shortcut',
  behavior: 'behavior',
  inference: 'inference',
  data: 'data',
  window: 'window',
  startup: 'startup'
} as const

export const SETTINGS_SCHEMA_VERSION = 2

export type ThemeSetting = 'dark' | 'light' | 'system'

export const PRIMARY_PRESETS = [
  'everforest',
  'nord',
  'kanagawa',
  'gruvbox',
  'solarized',
  'catppuccin'
] as const

export type PrimaryPreset = (typeof PRIMARY_PRESETS)[number]

export const PRIMARY_COLORS: Readonly<Record<PrimaryPreset, string>> = Object.freeze({
  everforest: '#7fbbb3',
  nord: '#88c0d0',
  kanagawa: '#7e9cd8',
  gruvbox: '#b8bb26',
  solarized: '#268bd2',
  catppuccin: '#c6a0f6'
})

export const PRIMARY_LABELS: Readonly<Record<PrimaryPreset, string>> = Object.freeze({
  everforest: 'Everforest',
  nord: 'Nord',
  kanagawa: 'Kanagawa',
  gruvbox: 'Gruvbox',
  solarized: 'Solarized',
  catppuccin: 'Catppuccin'
})

export interface AppearanceSettings {
  theme: ThemeSetting
  primary: PrimaryPreset
  /** Card background alpha in percent (40–100). Text/icons are unaffected. */
  opacity: number
  blurEnabled: boolean
  /** Bar width in DIP (560–900, step 20). */
  barWidth: number
  /** Locally installed family only; remote fonts are never fetched. */
  fontFamily: string
  /** Base body font size in px (12–18). */
  fontSize: number
}

export const OPACITY_MIN = 40
export const OPACITY_MAX = 100
export const BAR_WIDTH_MIN = 560
export const BAR_WIDTH_MAX = 900
export const BAR_WIDTH_STEP = 20
export const FONT_SIZE_MIN = 12
export const FONT_SIZE_MAX = 18
export const FONT_FAMILY_MAX_LENGTH = 120
export const DEFAULT_FONT_FAMILY = 'Noto Sans CJK SC'
export const DEFAULT_FONT_SIZE = 14

export const ALLOWED_FONT_FAMILIES = [
  'Noto Sans CJK SC',
  'Noto Serif CJK SC',
  'Noto Sans SC',
  'Noto Sans',
  'Noto Serif',
  'Source Han Sans SC',
  'Source Han Serif SC',
  'LXGW WenKai',
  'LXGW WenKai Mono',
  'WenQuanYi Micro Hei',
  'WenQuanYi Zen Hei',
  'DejaVu Sans',
  'Liberation Sans',
  'Ubuntu',
  'Cantarell',
  'Fira Sans',
  'Fira Code',
  'JetBrains Mono',
  'Microsoft YaHei UI',
  'Segoe UI',
  'Consolas',
  'Cascadia Mono',
  'system-ui',
  'sans-serif',
  'serif',
  'monospace'
] as const

export const DEFAULT_APPEARANCE: Readonly<AppearanceSettings> = Object.freeze({
  theme: 'dark',
  primary: 'everforest',
  opacity: 72,
  blurEnabled: true,
  barWidth: 680,
  fontFamily: DEFAULT_FONT_FAMILY,
  fontSize: DEFAULT_FONT_SIZE
})

export const DEFAULT_MODEL_SETTINGS: Readonly<ModelSettingsRef> = Object.freeze({
  profileId: null
})

export interface ModelSettingsRef {
  profileId: string | null
}

export interface ShortcutSettings {
  accelerator: string
}

export const DEFAULT_SHORTCUT: Readonly<ShortcutSettings> = Object.freeze({
  accelerator: 'Control+Alt+Space'
})

export const ACCELERATOR_MIN_LENGTH = 3
export const ACCELERATOR_MAX_LENGTH = 64

export interface BehaviorSettings {
  escDirectHide: boolean
  hideOnBlur: boolean
  streamingHideDelayMs: number
  contextRounds: number
}

export const STREAMING_HIDE_DELAY_MIN = 500
export const STREAMING_HIDE_DELAY_MAX = 10_000
export const CONTEXT_ROUNDS_MIN = 1
export const CONTEXT_ROUNDS_MAX = 50

export const DEFAULT_BEHAVIOR: Readonly<BehaviorSettings> = Object.freeze({
  escDirectHide: false,
  hideOnBlur: true,
  streamingHideDelayMs: 3000,
  contextRounds: 12
})

export interface InferenceSettings {
  systemPrompt: string
  temperature: number | null
  maxTokens: number | null
  timeoutMs: number
}

export const SYSTEM_PROMPT_MAX_LENGTH = 8000
export const TEMPERATURE_MIN = 0
export const TEMPERATURE_MAX = 2
export const MAX_TOKENS_MIN = 1
export const MAX_TOKENS_MAX = 32_768
export const INFERENCE_TIMEOUT_MIN = 5000
export const INFERENCE_TIMEOUT_MAX = 300_000

export const DEFAULT_INFERENCE: Readonly<InferenceSettings> = Object.freeze({
  systemPrompt: '',
  temperature: null,
  maxTokens: null,
  timeoutMs: 30_000
})

export interface DataSettings {
  /** null = keep history forever. */
  retentionDays: number | null
  lastExportPath: string | null
}

export const RETENTION_DAYS_MIN = 1
export const RETENTION_DAYS_MAX = 3650
export const LAST_EXPORT_PATH_MAX_LENGTH = 4096

export const DEFAULT_DATA: Readonly<DataSettings> = Object.freeze({
  retentionDays: null,
  lastExportPath: null
})

export interface StartupSettings {
  autostart: boolean
  watchdog: boolean
}

export const DEFAULT_STARTUP: Readonly<StartupSettings> = Object.freeze({
  autostart: false,
  watchdog: false
})

export type { WindowSettings }
export { DEFAULT_WINDOW_SETTINGS, normalizeWindowSettings }

export interface SettingsBundle {
  appearance: AppearanceSettings
  shortcut: ShortcutSettings
  behavior: BehaviorSettings
  inference: InferenceSettings
  data: DataSettings
  window: WindowSettings
  startup: StartupSettings
  schemaVersion: number
}

export interface NormalizedSettings extends SettingsBundle {
  model: ModelSettingsRef
  onboardingComplete: boolean
}

export function clampNumber(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return min
  return Math.min(Math.max(value, min), max)
}

function clamp(value: number, min: number, max: number): number {
  return clampNumber(value, min, max)
}

function normalizeInteger(
  value: unknown,
  min: number,
  max: number,
  fallback: number
): number {
  const numeric = typeof value === 'number' ? value : Number(value)
  if (!Number.isFinite(numeric)) return fallback
  return Math.round(clamp(numeric, min, max))
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

export function isThemeSetting(value: unknown): value is ThemeSetting {
  return value === 'dark' || value === 'light' || value === 'system'
}

export function isPrimaryPreset(value: unknown): value is PrimaryPreset {
  return typeof value === 'string' && (PRIMARY_PRESETS as readonly string[]).includes(value)
}

export function isAllowedFontFamily(value: unknown): value is string {
  if (typeof value !== 'string') return false
  const trimmed = value.trim()
  return (
    trimmed.length > 0 &&
    trimmed.length <= FONT_FAMILY_MAX_LENGTH &&
    (ALLOWED_FONT_FAMILIES as readonly string[]).includes(trimmed)
  )
}

export function normalizeFontFamily(value: unknown): string {
  return isAllowedFontFamily(value) ? value.trim() : DEFAULT_FONT_FAMILY
}

export function clampFontSize(value: unknown): number {
  return normalizeInteger(value, FONT_SIZE_MIN, FONT_SIZE_MAX, DEFAULT_FONT_SIZE)
}

/** Base --fs-* values at fontSize=14; the UI shifts every token by the delta. */
export const FONT_SIZE_TOKEN_BASE: Readonly<Record<string, number>> = Object.freeze({
  '--fs-body': 14,
  '--fs-input': 15,
  '--fs-title': 13,
  '--fs-title-lg': 14,
  '--fs-secondary': 12,
  '--fs-time': 11,
  '--fs-code': 13
})

export function fontSizeVariables(fontSize: unknown): Record<string, string> {
  const size = clampFontSize(fontSize)
  const delta = size - DEFAULT_FONT_SIZE
  const result: Record<string, string> = {}
  for (const [token, base] of Object.entries(FONT_SIZE_TOKEN_BASE)) {
    result[token] = `${base + delta}px`
  }
  return result
}

export function clampOpacity(value: unknown): number {
  const numeric = typeof value === 'number' ? value : Number(value)
  return Math.round(clamp(numeric, OPACITY_MIN, OPACITY_MAX))
}

/**
 * Snap to the 20px UI step while keeping an exact 560/900 edge. Unknown or
 * non-finite input falls back to the default width.
 */
export function normalizeBarWidth(value: unknown): number {
  const numeric = typeof value === 'number' ? value : Number(value)
  if (!Number.isFinite(numeric)) return DEFAULT_APPEARANCE.barWidth
  const clamped = clamp(numeric, BAR_WIDTH_MIN, BAR_WIDTH_MAX)
  const stepped =
    BAR_WIDTH_MIN + Math.round((clamped - BAR_WIDTH_MIN) / BAR_WIDTH_STEP) * BAR_WIDTH_STEP
  return Math.round(clamp(stepped, BAR_WIDTH_MIN, BAR_WIDTH_MAX))
}

export function normalizeAppearance(raw: unknown): AppearanceSettings {
  const record = isRecord(raw) ? raw : {}
  return {
    theme: isThemeSetting(record.theme) ? record.theme : DEFAULT_APPEARANCE.theme,
    primary: isPrimaryPreset(record.primary) ? record.primary : DEFAULT_APPEARANCE.primary,
    opacity:
      record.opacity === undefined ? DEFAULT_APPEARANCE.opacity : clampOpacity(record.opacity),
    blurEnabled:
      typeof record.blurEnabled === 'boolean'
        ? record.blurEnabled
        : DEFAULT_APPEARANCE.blurEnabled,
    barWidth:
      record.barWidth === undefined
        ? DEFAULT_APPEARANCE.barWidth
        : normalizeBarWidth(record.barWidth),
    fontFamily:
      record.fontFamily === undefined
        ? DEFAULT_APPEARANCE.fontFamily
        : normalizeFontFamily(record.fontFamily),
    fontSize:
      record.fontSize === undefined
        ? DEFAULT_APPEARANCE.fontSize
        : clampFontSize(record.fontSize)
  }
}

export function normalizeModelSettings(raw: unknown): ModelSettingsRef {
  if (!isRecord(raw)) return { ...DEFAULT_MODEL_SETTINGS }
  const profileId = raw.profileId
  return {
    profileId: typeof profileId === 'string' && profileId.trim().length > 0 ? profileId : null
  }
}

const MODIFIER_TOKENS: ReadonlySet<string> = new Set([
  'control',
  'ctrl',
  'alt',
  'shift',
  'super',
  'meta',
  'command',
  'cmd',
  'commandorcontrol',
  'altgr'
])

function hasControlCharacter(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index)
    if (code <= 0x1f || code === 0x7f) return true
  }
  return false
}

export function isValidAccelerator(value: unknown): value is string {
  if (typeof value !== 'string') return false
  if (hasControlCharacter(value)) return false
  const trimmed = value.trim()
  if (trimmed.length < ACCELERATOR_MIN_LENGTH) return false
  if (trimmed.length > ACCELERATOR_MAX_LENGTH) return false

  const tokens = trimmed.split('+').map((token) => token.trim())
  if (tokens.length < 2) return false

  let hasModifier = false
  let keyCount = 0
  for (const token of tokens) {
    if (token.length === 0) return false
    if (MODIFIER_TOKENS.has(token.toLowerCase())) {
      hasModifier = true
      continue
    }
    if (token.length > 24) return false
    keyCount += 1
  }
  return hasModifier && keyCount >= 1
}

export function normalizeShortcut(raw: unknown): ShortcutSettings {
  const record = isRecord(raw) ? raw : {}
  const accelerator = record.accelerator
  return {
    accelerator: isValidAccelerator(accelerator)
      ? accelerator.trim()
      : DEFAULT_SHORTCUT.accelerator
  }
}

export function normalizeBehavior(raw: unknown): BehaviorSettings {
  const record = isRecord(raw) ? raw : {}
  return {
    escDirectHide:
      typeof record.escDirectHide === 'boolean'
        ? record.escDirectHide
        : DEFAULT_BEHAVIOR.escDirectHide,
    hideOnBlur:
      typeof record.hideOnBlur === 'boolean' ? record.hideOnBlur : DEFAULT_BEHAVIOR.hideOnBlur,
    streamingHideDelayMs:
      record.streamingHideDelayMs === undefined
        ? DEFAULT_BEHAVIOR.streamingHideDelayMs
        : normalizeInteger(
            record.streamingHideDelayMs,
            STREAMING_HIDE_DELAY_MIN,
            STREAMING_HIDE_DELAY_MAX,
            DEFAULT_BEHAVIOR.streamingHideDelayMs
          ),
    contextRounds:
      record.contextRounds === undefined
        ? DEFAULT_BEHAVIOR.contextRounds
        : normalizeInteger(
            record.contextRounds,
            CONTEXT_ROUNDS_MIN,
            CONTEXT_ROUNDS_MAX,
            DEFAULT_BEHAVIOR.contextRounds
          )
  }
}

export function clampTemperature(value: unknown): number | null {
  if (typeof value !== 'number' || !Number.isFinite(value)) return null
  return clamp(value, TEMPERATURE_MIN, TEMPERATURE_MAX)
}

export function clampMaxTokens(value: unknown): number | null {
  if (typeof value !== 'number' || !Number.isFinite(value)) return null
  return Math.floor(clamp(value, MAX_TOKENS_MIN, MAX_TOKENS_MAX))
}

export function clampInferenceTimeoutMs(value: unknown): number {
  return normalizeInteger(
    value,
    INFERENCE_TIMEOUT_MIN,
    INFERENCE_TIMEOUT_MAX,
    DEFAULT_INFERENCE.timeoutMs
  )
}

export function normalizeInference(raw: unknown): InferenceSettings {
  const record = isRecord(raw) ? raw : {}
  const rawPrompt = record.systemPrompt
  const prompt =
    typeof rawPrompt === 'string'
      ? Array.from(rawPrompt).slice(0, SYSTEM_PROMPT_MAX_LENGTH).join('')
      : DEFAULT_INFERENCE.systemPrompt

  return {
    systemPrompt: prompt,
    temperature:
      record.temperature === undefined ? null : clampTemperature(record.temperature),
    maxTokens: record.maxTokens === undefined ? null : clampMaxTokens(record.maxTokens),
    timeoutMs:
      record.timeoutMs === undefined
        ? DEFAULT_INFERENCE.timeoutMs
        : clampInferenceTimeoutMs(record.timeoutMs)
  }
}

export function clampRetentionDays(value: unknown): number | null {
  if (value === null) return null
  if (typeof value !== 'number' || !Number.isFinite(value)) return null
  return Math.floor(clamp(value, RETENTION_DAYS_MIN, RETENTION_DAYS_MAX))
}

export function normalizeData(raw: unknown): DataSettings {
  const record = isRecord(raw) ? raw : {}
  const rawPath = record.lastExportPath
  const path =
    typeof rawPath === 'string' && rawPath.trim().length > 0
      ? rawPath.trim().slice(0, LAST_EXPORT_PATH_MAX_LENGTH)
      : null
  return {
    retentionDays:
      record.retentionDays === undefined
        ? DEFAULT_DATA.retentionDays
        : clampRetentionDays(record.retentionDays),
    lastExportPath: path
  }
}

export function normalizeStartup(raw: unknown): StartupSettings {
  const record = isRecord(raw) ? raw : {}
  return {
    autostart:
      typeof record.autostart === 'boolean' ? record.autostart : DEFAULT_STARTUP.autostart,
    watchdog:
      typeof record.watchdog === 'boolean' ? record.watchdog : DEFAULT_STARTUP.watchdog
  }
}

export function normalizeSettings(raw: unknown): NormalizedSettings {
  const record = isRecord(raw) ? raw : {}
  return {
    appearance: normalizeAppearance(record[SETTINGS_KEYS.appearance]),
    model: normalizeModelSettings(record[SETTINGS_KEYS.model]),
    onboardingComplete: record[SETTINGS_KEYS.onboardingComplete] === true,
    shortcut: normalizeShortcut(record[SETTINGS_KEYS.shortcut]),
    behavior: normalizeBehavior(record[SETTINGS_KEYS.behavior]),
    inference: normalizeInference(record[SETTINGS_KEYS.inference]),
    data: normalizeData(record[SETTINGS_KEYS.data]),
    window: normalizeWindowSettings(record[SETTINGS_KEYS.window]),
    startup: normalizeStartup(record[SETTINGS_KEYS.startup]),
    schemaVersion: SETTINGS_SCHEMA_VERSION
  }
}

// ---------------------------------------------------------------------------
// Onboarding (F-08)
// ---------------------------------------------------------------------------

export type OnboardingReason = 'no_profile' | 'no_key' | 'incomplete'

export interface OnboardingState {
  required: boolean
  reason: OnboardingReason | null
}

export interface OnboardingProfileInfo {
  baseUrl: string
  hasApiKey: boolean
  isDefault: boolean
}

export function isLoopbackBaseUrl(raw: string): boolean {
  try {
    const hostname = new URL(raw).hostname.toLowerCase()
    return (
      hostname === 'localhost' ||
      hostname === '127.0.0.1' ||
      hostname === '::1' ||
      hostname === '[::1]'
    )
  } catch {
    return false
  }
}

const PROFILE_NAME_PRESETS: ReadonlyArray<{ host: string; port?: string; name: string }> = [
  { host: 'api.deepseek.com', name: 'DeepSeek' },
  { host: 'api.openai.com', name: 'OpenAI' },
  { host: '127.0.0.1', port: '11434', name: 'Ollama 本地' }
]

/**
 * F-08 onboarding only asks for `base_url`, so a profile name must be derived
 * when the user did not type one: known provider preset → hostname → `自定义`.
 */
export function deriveProfileName(baseUrl: string): string {
  const trimmed = baseUrl.trim()
  if (trimmed.length === 0) return '自定义'
  let hostname: string
  let port: string
  try {
    const parsed = new URL(trimmed)
    hostname = parsed.hostname.toLowerCase()
    port = parsed.port
  } catch {
    return '自定义'
  }
  for (const preset of PROFILE_NAME_PRESETS) {
    if (preset.host === hostname && (preset.port === undefined || preset.port === port)) {
      return preset.name
    }
  }
  return hostname.length > 0 ? hostname : '自定义'
}

/**
 * F-08: onboarding is required when there is no provider profile, no default
 * profile, or the default profile needs a key but has none. Loopback providers
 * may use an empty key (D.2).
 *
 * `onboardingComplete` is intentionally not an override: if the configuration
 * later becomes unusable (profile/key removed), the composer must be disabled
 * again instead of sending a request that is guaranteed to fail.
 */
export function computeOnboardingState(
  profiles: readonly OnboardingProfileInfo[]
): OnboardingState {
  if (profiles.length === 0) return { required: true, reason: 'no_profile' }
  const preferred = profiles.find((profile) => profile.isDefault) ?? null
  if (!preferred) return { required: true, reason: 'incomplete' }
  if (isLoopbackBaseUrl(preferred.baseUrl)) return { required: false, reason: null }
  if (!preferred.hasApiKey) return { required: true, reason: 'no_key' }
  return { required: false, reason: null }
}
