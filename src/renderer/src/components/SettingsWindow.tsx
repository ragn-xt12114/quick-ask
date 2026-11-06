/**
 * S4 settings window (F-07 model + appearance, F-08 onboarding).
 *
 * Everything applies immediately: there is no save/cancel pair, only a close
 * button. API keys and secret header values are write-only — the renderer only
 * ever receives `hasApiKey` / `hasValue` booleans.
 */

import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react'
import type {
  AppPathKind,
  AppPathsInfo,
  AppearanceRuntimeState,
  BlurStatus,
  BootstrapInfo,
  HotkeyStatus,
  JsonValue,
  ListFontsResult,
  ProviderCreateRequest,
  ProviderHeaderView,
  ProviderProfileView,
  ProviderProxyMode,
  ProviderUpdateRequest,
  ReadLogsResult,
  StartupState
} from '../../../shared/channels'
import type { CapabilityStatus } from '../../../shared/platform'
import {
  BAR_WIDTH_MAX,
  BAR_WIDTH_MIN,
  BAR_WIDTH_STEP,
  CONTEXT_ROUNDS_MAX,
  CONTEXT_ROUNDS_MIN,
  DEFAULT_APPEARANCE,
  DEFAULT_BEHAVIOR,
  DEFAULT_DATA,
  DEFAULT_INFERENCE,
  DEFAULT_SHORTCUT,
  DEFAULT_STARTUP,
  FONT_SIZE_MAX,
  FONT_SIZE_MIN,
  OPACITY_MAX,
  OPACITY_MIN,
  PRIMARY_COLORS,
  PRIMARY_LABELS,
  PRIMARY_PRESETS,
  RETENTION_DAYS_MAX,
  RETENTION_DAYS_MIN,
  SETTINGS_KEYS,
  STREAMING_HIDE_DELAY_MAX,
  STREAMING_HIDE_DELAY_MIN,
  SYSTEM_PROMPT_MAX_LENGTH,
  deriveProfileName,
  isAllowedFontFamily,
  isLoopbackBaseUrl,
  isValidAccelerator,
  normalizeAppearance,
  normalizeSettings,
  type AppearanceSettings,
  type BehaviorSettings,
  type InferenceSettings,
  type NormalizedSettings,
  type ShortcutSettings,
  type StartupSettings,
  type ThemeSetting
} from '../../../shared/settings'
import {
  acceleratorFromKeyInput,
  isModifierOnlyKey
} from '../../../shared/accelerator'
import { applyAppearance, runtimeFromSignals } from '../lib/appearance'

type Tab = 'model' | 'appearance' | 'shortcut' | 'behavior' | 'data' | 'about'
type OnboardingStep = 1 | 2 | 3

interface SettingsWindowProps {
  /** `?onboarding=1` — F-08 three-step wizard. */
  onboarding: boolean
}

interface HeaderRow {
  name: string
  value: string
  secret: boolean
  hasValue: boolean
}

interface ModelForm {
  name: string
  baseUrl: string
  model: string
  apiKey: string
  proxyMode: ProviderProxyMode
  proxyUrl: string
  proxyUser: string
  proxyPassword: string
  clearProxyAuth: boolean
  temperature: string
  maxTokens: string
  timeoutSec: string
  headers: HeaderRow[]
}

interface TestOutcome {
  ok: boolean
  message: string
  latencyMs?: number
  models?: string[]
}

interface ProviderPreset {
  id: string
  label: string
  name: string
  baseUrl: string
  model: string
}

const PRESETS: readonly ProviderPreset[] = [
  {
    id: 'deepseek',
    label: 'DeepSeek',
    name: 'DeepSeek',
    baseUrl: 'https://api.deepseek.com',
    model: 'deepseek-chat'
  },
  {
    id: 'openai',
    label: 'OpenAI',
    name: 'OpenAI',
    baseUrl: 'https://api.openai.com/v1',
    model: 'gpt-4o-mini'
  },
  {
    id: 'ollama',
    label: 'Ollama',
    name: 'Ollama 本地',
    baseUrl: 'http://127.0.0.1:11434/v1',
    model: 'llama3.2'
  },
  {
    id: 'opencode-go',
    label: 'OpenCode Go',
    name: 'OpenCode Go',
    baseUrl: 'https://opencode.ai/zen/go/v1',
    model: 'deepseek-v4.1-flash'
  },
  {
    id: 'custom',
    label: '自定义',
    name: '自定义配置',
    baseUrl: '',
    model: ''
  }
]

const THEME_LABELS: Record<ThemeSetting, string> = {
  dark: '深色',
  light: '浅色',
  system: '跟随系统'
}

const EMPTY_HEADERS: HeaderRow[] = []

function emptyForm(): ModelForm {
  return {
    name: '新配置',
    baseUrl: '',
    model: '',
    apiKey: '',
    proxyMode: 'system',
    proxyUrl: '',
    proxyUser: '',
    proxyPassword: '',
    clearProxyAuth: false,
    temperature: '',
    maxTokens: '',
    timeoutSec: '30',
    headers: [...EMPTY_HEADERS]
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : '操作失败'
}

function rowsFromViews(
  views: readonly ProviderHeaderView[],
  previous: readonly HeaderRow[] = []
): HeaderRow[] {
  return views.map((view) => {
    const old = previous.find(
      (row) => row.name.toLowerCase() === view.name.toLowerCase()
    )
    return {
      name: view.name,
      value: old?.value ?? '',
      secret: view.secret,
      hasValue: view.hasValue
    }
  })
}

function formFromView(view: ProviderProfileView, previous?: ModelForm): ModelForm {
  return {
    name: view.name,
    baseUrl: view.baseUrl,
    model: view.model,
    apiKey: '',
    proxyMode: view.proxyMode,
    proxyUrl: view.proxyUrl ?? '',
    proxyUser: '',
    proxyPassword: '',
    clearProxyAuth: false,
    temperature: view.temperature === null ? '' : String(view.temperature),
    maxTokens: view.maxTokens === null ? '' : String(view.maxTokens),
    timeoutSec: String(Math.min(300, Math.max(5, Math.round(view.timeoutMs / 1000)))),
    headers: rowsFromViews(view.headers, previous?.headers)
  }
}

function parseOptionalNumber(value: string): number | null {
  const trimmed = value.trim()
  if (trimmed.length === 0) return null
  const numeric = Number(trimmed)
  return Number.isFinite(numeric) ? numeric : null
}

function validateBaseUrl(value: string): string | null {
  try {
    const url = new URL(value)
    if (url.protocol !== 'http:' && url.protocol !== 'https:') {
      return 'base_url 必须是 http(s) 地址'
    }
    return null
  } catch {
    return 'base_url 不是合法 URL'
  }
}

function validateProxyUrl(value: string): string | null {
  if (value.length === 0) return null
  let url: URL
  try {
    url = new URL(value)
  } catch {
    return '代理 URL 不是合法地址'
  }
  const protocol = url.protocol.toLowerCase()
  if (!['http:', 'https:', 'socks5:', 'socks5h:'].includes(protocol)) {
    return '代理 URL 必须是 http/https/socks5/socks5h'
  }
  if (url.username.length > 0 || url.password.length > 0) {
    return '代理 URL 不能包含用户名或密码'
  }
  if (url.search.length > 0 || url.hash.length > 0) {
    return '代理 URL 不能包含查询串或片段'
  }
  return null
}

function validateForm(form: ModelForm): string | null {
  if (form.name.trim().length === 0) return '配置名称不能为空'
  const urlError = validateBaseUrl(form.baseUrl.trim())
  if (urlError) return urlError
  if (form.model.trim().length === 0) return '模型名称不能为空'
  if (form.proxyMode === 'custom') {
    const proxyError = validateProxyUrl(form.proxyUrl.trim())
    if (proxyError) return proxyError
  }
  if (form.proxyPassword.length > 0 && form.proxyUser.trim().length === 0) {
    return '代理用户名不能为空'
  }
  const timeout = Number(form.timeoutSec)
  if (!Number.isFinite(timeout) || timeout < 5 || timeout > 300) {
    return '请求超时需为 5–300 秒'
  }
  if (form.temperature.trim().length > 0) {
    const temperature = Number(form.temperature)
    if (!Number.isFinite(temperature) || temperature < 0 || temperature > 2) {
      return 'temperature 需为 0–2，留空表示不发送'
    }
  }
  if (form.maxTokens.trim().length > 0) {
    const maxTokens = Number(form.maxTokens)
    if (!Number.isInteger(maxTokens) || maxTokens < 1 || maxTokens > 32_768) {
      return 'max_tokens 需为 1–32768 的整数，留空表示不发送'
    }
  }

  const seen = new Set<string>()
  for (const row of form.headers) {
    const name = row.name.trim()
    if (name.length === 0 && row.value.length === 0) continue
    if (name.length === 0) return '请求头名称不能为空'
    if (!/^[A-Za-z0-9!#$%&'*+.^_`|~-]+$/.test(name)) return `请求头名称不合法：${name}`
    if (seen.has(name.toLowerCase())) return `请求头重复：${name}`
    seen.add(name.toLowerCase())
    if (row.value.length === 0 && !row.hasValue) return `请求头 ${name} 需要值`
  }
  return null
}

function buildHeaders(form: ModelForm): Array<{ name: string; value?: string; secret: boolean }> {
  const headers: Array<{ name: string; value?: string; secret: boolean }> = []
  for (const row of form.headers) {
    const name = row.name.trim()
    if (name.length === 0 && row.value.length === 0) continue
    headers.push({
      name,
      secret: row.secret,
      ...(row.value.length > 0 ? { value: row.value } : {})
    })
  }
  return headers
}

export function SettingsWindow({ onboarding }: SettingsWindowProps) {
  const api = window.quickask
  const [tab, setTab] = useState<Tab>('model')
  const [info, setInfo] = useState<BootstrapInfo | null>(null)
  const [blurStatus, setBlurStatus] = useState<BlurStatus | null>(null)
  const [appearance, setAppearance] = useState<AppearanceSettings>({
    ...DEFAULT_APPEARANCE
  })
  const [appearanceRuntime, setAppearanceRuntime] = useState<AppearanceRuntimeState>(
    runtimeFromSignals(null, null, null)
  )
  const [profiles, setProfiles] = useState<ProviderProfileView[]>([])
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [form, setForm] = useState<ModelForm>(emptyForm)
  const [systemPrompt, setSystemPrompt] = useState('')
  const [systemPromptNote, setSystemPromptNote] = useState<string | null>(null)
  const [behavior, setBehavior] = useState<BehaviorSettings>({ ...DEFAULT_BEHAVIOR })
  const [behaviorDraft, setBehaviorDraft] = useState({
    streamingHideDelayMs: String(DEFAULT_BEHAVIOR.streamingHideDelayMs),
    contextRounds: String(DEFAULT_BEHAVIOR.contextRounds)
  })
  const [shortcut, setShortcut] = useState<ShortcutSettings>({ ...DEFAULT_SHORTCUT })
  const [startup, setStartupSettings] = useState<StartupSettings>({ ...DEFAULT_STARTUP })
  const [startupStatus, setStartupStatus] = useState<StartupState | null>(null)
  const [startupError, setStartupError] = useState<string | null>(null)
  const [startupSaving, setStartupSaving] = useState(false)
  const [hotkeyStatus, setHotkeyStatus] = useState<HotkeyStatus | null>(null)
  const [hotkeyRecording, setHotkeyRecording] = useState(false)
  const [hotkeySaving, setHotkeySaving] = useState(false)
  const [hotkeyError, setHotkeyError] = useState<string | null>(null)
  const [hotkeyConflict, setHotkeyConflict] = useState(false)
  const [hotkeyNote, setHotkeyNote] = useState<string | null>(null)
  const [paths, setPaths] = useState<AppPathsInfo | null>(null)
  const [pathNote, setPathNote] = useState<string | null>(null)
  const [pathError, setPathError] = useState<string | null>(null)
  const [clearConfirm, setClearConfirm] = useState(false)
  const [clearResult, setClearResult] = useState<number | null>(null)
  const [clearError, setClearError] = useState<string | null>(null)
  const [clearing, setClearing] = useState(false)
  const [fonts, setFonts] = useState<string[]>([])
  const [fontNote, setFontNote] = useState<string | null>(null)
  const [exportStatus, setExportStatus] = useState<string | null>(null)
  const [exportError, setExportError] = useState<string | null>(null)
  const [exporting, setExporting] = useState(false)
  const [retentionDraft, setRetentionDraft] = useState('')
  const [retentionStatus, setRetentionStatus] = useState<string | null>(null)
  const [retentionError, setRetentionError] = useState<string | null>(null)
  const [retentionSaving, setRetentionSaving] = useState(false)
  const [logContent, setLogContent] = useState('')
  const [logTruncated, setLogTruncated] = useState(false)
  const [logBytes, setLogBytes] = useState(0)
  const [logError, setLogError] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [testing, setTesting] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [formError, setFormError] = useState<string | null>(null)
  const [saveNote, setSaveNote] = useState<string | null>(null)
  const [deleteConfirm, setDeleteConfirm] = useState(false)
  const [testOutcome, setTestOutcome] = useState<TestOutcome | null>(null)
  const [onboardingStep, setOnboardingStep] = useState<OnboardingStep>(1)
  const [onboardingDone, setOnboardingDone] = useState(false)

  const appearanceRef = useRef(appearance)
  const appearanceRuntimeRef = useRef(appearanceRuntime)
  const formRef = useRef(form)
  const selectedIdRef = useRef(selectedId)
  const profilesRef = useRef(profiles)
  const userEditingRef = useRef(false)
  const saveTimerRef = useRef<number | null>(null)
  const saveNoteTimerRef = useRef<number | null>(null)
  const saveInFlightRef = useRef<Promise<ProviderProfileView | null> | null>(null)
  const formRevisionRef = useRef(0)
  const saveStartedRevisionRef = useRef(0)
  const inferenceRef = useRef<InferenceSettings>({ ...DEFAULT_INFERENCE })
  const systemPromptTimerRef = useRef<number | null>(null)
  const recordingRef = useRef(false)
  const hotkeySavingRef = useRef(false)
  const behaviorRef = useRef<BehaviorSettings>(behavior)
  const startupRef = useRef<StartupSettings>(startup)
  const saveProfileRef = useRef<
    (options: { createIfMissing: boolean; silent: boolean }) => Promise<ProviderProfileView | null>
  >(async () => null)

  appearanceRef.current = appearance
  appearanceRuntimeRef.current = appearanceRuntime
  formRef.current = form
  selectedIdRef.current = selectedId
  profilesRef.current = profiles
  behaviorRef.current = behavior
  startupRef.current = startup

  const applyLocal = useCallback(
    (next: AppearanceSettings, runtime: AppearanceRuntimeState = appearanceRuntimeRef.current) => {
      appearanceRef.current = next
      appearanceRuntimeRef.current = runtime
      setAppearance(next)
      setAppearanceRuntime(runtime)
      applyAppearance(next, runtime)
    },
    []
  )

  const scheduleSave = useCallback(() => {
    if (onboarding) return
    if (saveTimerRef.current !== null) window.clearTimeout(saveTimerRef.current)
    saveTimerRef.current = window.setTimeout(() => {
      saveTimerRef.current = null
      void saveProfileRef.current({ createIfMissing: true, silent: true })
    }, 300)
  }, [onboarding])

  const setFormState = useCallback((next: ModelForm) => {
    formRef.current = next
    setForm(next)
  }, [])

  const applyNormalizedSettings = useCallback((next: NormalizedSettings) => {
    inferenceRef.current = next.inference
    const activeTestId =
      document.activeElement instanceof HTMLElement
        ? (document.activeElement.dataset['testid'] ?? '')
        : ''
    if (activeTestId !== 'inference-system-prompt') {
      setSystemPrompt(next.inference.systemPrompt)
    }
    behaviorRef.current = next.behavior
    setBehavior(next.behavior)
    if (
      activeTestId !== 'behavior-streaming-delay' &&
      activeTestId !== 'behavior-context-rounds'
    ) {
      setBehaviorDraft({
        streamingHideDelayMs: String(next.behavior.streamingHideDelayMs),
        contextRounds: String(next.behavior.contextRounds)
      })
    }
    setShortcut(next.shortcut)
    startupRef.current = next.startup
    setStartupSettings(next.startup)
    if (activeTestId !== 'retention-days') {
      setRetentionDraft(
        next.data.retentionDays === null ? '' : String(next.data.retentionDays)
      )
    }
  }, [])

  const hydrateProfiles = useCallback(
    async (preferredId?: string | null): Promise<void> => {
      if (!api) return
      const result = await api.provider.list()
      if (!result.ok) {
        setError(`${result.error.code}: ${result.error.message}`)
        return
      }
      const list = result.data.profiles
      setProfiles(list)
      profilesRef.current = list
      const targetId =
        preferredId ??
        selectedIdRef.current ??
        list.find((profile) => profile.isDefault)?.id ??
        list[0]?.id ??
        null
      const target = list.find((profile) => profile.id === targetId) ?? null
      setSelectedId(target?.id ?? null)
      selectedIdRef.current = target?.id ?? null
      setFormState(
        target
          ? formFromView(target, formRef.current)
          : { ...emptyForm(), name: onboarding ? '' : '新配置' }
      )
    },
    [api, onboarding, setFormState]
  )

  useEffect(() => {
    if (!api) {
      setError('preload API unavailable')
      setLoading(false)
      return
    }

    let active = true
    void (async () => {
      const boot = await api.app.bootstrap()
      if (!active) return
      if (!boot.ok) {
        setError(`${boot.error.code}: ${boot.error.message}`)
      } else {
        setInfo(boot.data)
        setBlurStatus(boot.data.blurStatus)
        setHotkeyStatus(boot.data.hotkey)
        if (boot.data.hotkey.error) {
          setHotkeyError(boot.data.hotkey.error)
          setHotkeyConflict(boot.data.hotkey.conflict)
        }
        applyNormalizedSettings(normalizeSettings(boot.data.settings))
        const next = normalizeAppearance(boot.data.appearance)
        applyLocal(
          next,
          runtimeFromSignals(
            boot.data.blurStatus,
            boot.data.opaqueMode,
            boot.data.animationDurationFactor
          )
        )
      }

      let preferredProfileId: string | null = null
      const allSettings = await api.settings.getAll()
      if (active && allSettings.ok) {
        const normalized = normalizeSettings(allSettings.data.settings)
        preferredProfileId = normalized.model.profileId
        applyNormalizedSettings(normalized)
      }

      const pathInfo = await api.app.paths()
      if (active) {
        if (pathInfo.ok) setPaths(pathInfo.data)
        else setPathError(`${pathInfo.error.code}: ${pathInfo.error.message}`)
      }

      const startupInfo = await api.app.setStartup({})
      if (active) {
        if (startupInfo.ok) {
          setStartupStatus(startupInfo.data)
          setStartupError(startupInfo.data.error)
          startupRef.current = {
            autostart: startupInfo.data.autostart,
            watchdog: startupInfo.data.watchdog
          }
          setStartupSettings(startupRef.current)
        } else {
          setStartupError(`${startupInfo.error.code}: ${startupInfo.error.message}`)
        }
      }

      await hydrateProfiles(preferredProfileId)

      try {
        const fontsResult = await api.app.listFonts()
        if (active && fontsResult.ok) {
          const payload: ListFontsResult = fontsResult.data
          setFonts(payload.fonts)
          if (!payload.fonts.includes('LXGW WenKai')) {
            setFontNote('未检测到 LXGW WenKai，已回退到本地可用字体；无网络下载。')
          } else {
            setFontNote(null)
          }
        }
      } catch {
        setFonts([])
      }

      try {
        const logsResult = await api.app.readLogs()
        if (active && logsResult.ok) {
          const payload: ReadLogsResult = logsResult.data
          setLogContent(payload.content)
          setLogTruncated(payload.truncated)
          setLogBytes(payload.bytes)
        }
      } catch {
        if (active) setLogError('日志读取失败')
      }

      if (active) setLoading(false)
    })()

    const offSettings = api.app.onSettings((event) => {
      if (!active) return
      applyNormalizedSettings(event.settings)
    })

    const offAppearance = api.app.onAppearance((event) => {
      if (!active) return
      const runtime = runtimeFromSignals(
        event.blurStatus,
        event.opaqueMode,
        event.animationDurationFactor
      )
      setBlurStatus(runtime.blurStatus)
      applyLocal(normalizeAppearance(event), runtime)
    })

    return () => {
      active = false
      offAppearance()
      offSettings()
      if (saveTimerRef.current !== null) window.clearTimeout(saveTimerRef.current)
      if (saveNoteTimerRef.current !== null) window.clearTimeout(saveNoteTimerRef.current)
      if (systemPromptTimerRef.current !== null) {
        window.clearTimeout(systemPromptTimerRef.current)
      }
    }
  }, [api, applyLocal, applyNormalizedSettings, hydrateProfiles])

  useEffect(() => {
    const light = window.matchMedia('(prefers-color-scheme: light)')
    const reduced = window.matchMedia('(prefers-reduced-motion: reduce)')
    const onChange = (): void =>
      applyAppearance(appearanceRef.current, appearanceRuntimeRef.current)
    light.addEventListener('change', onChange)
    reduced.addEventListener('change', onChange)
    return () => {
      light.removeEventListener('change', onChange)
      reduced.removeEventListener('change', onChange)
    }
  }, [])

  const markSaved = useCallback((text = '已保存') => {
    setSaveNote(text)
    if (saveNoteTimerRef.current !== null) window.clearTimeout(saveNoteTimerRef.current)
    saveNoteTimerRef.current = window.setTimeout(() => {
      setSaveNote(null)
      saveNoteTimerRef.current = null
    }, 1800)
  }, [])

  const syncModelRef = useCallback(
    (profileId: string) => {
      if (!api) return
      void api.settings.set({ key: SETTINGS_KEYS.model, value: { profileId } })
    },
    [api]
  )

  const saveProfileNow = useCallback(
    async (options: { createIfMissing: boolean; silent: boolean }): Promise<ProviderProfileView | null> => {
      if (!api) return null
      while (true) {
        if (saveInFlightRef.current) {
          const inFlightRevision = saveStartedRevisionRef.current
          const view = await saveInFlightRef.current
          if (formRevisionRef.current === inFlightRevision) return view
          continue
        }

        const startedRevision = formRevisionRef.current
        const run = async (): Promise<ProviderProfileView | null> => {
          let current = formRef.current
          if (onboarding && current.name.trim().length === 0) {
            current = { ...current, name: deriveProfileName(current.baseUrl) }
            setFormState(current)
          }
          const validation = validateForm(current)
          if (validation) {
            if (!options.silent) setFormError(validation)
            return null
          }

          setSaving(true)
          try {
            const headers = buildHeaders(current)
            const timeoutMs = Math.round(Number(current.timeoutSec) * 1000)
            const temperature = parseOptionalNumber(current.temperature)
            const maxTokens = parseOptionalNumber(current.maxTokens)
            const proxyUrl = current.proxyUrl.trim()
            const proxyAuth =
              current.clearProxyAuth
                ? null
                : current.proxyUser.trim().length > 0 || current.proxyPassword.length > 0
                  ? {
                      username: current.proxyUser.trim(),
                      password: current.proxyPassword
                    }
                  : undefined
            const id = selectedIdRef.current
            let result
            if (id) {
              const patch: ProviderUpdateRequest = {
                id,
                name: current.name.trim(),
                baseUrl: current.baseUrl.trim(),
                model: current.model.trim(),
                headers,
                proxyMode: current.proxyMode,
                proxyUrl: proxyUrl.length > 0 ? proxyUrl : null,
                temperature,
                maxTokens,
                timeoutMs
              }
              if (current.apiKey.length > 0) patch.apiKey = current.apiKey
              if (proxyAuth !== undefined) patch.proxyAuth = proxyAuth
              result = await api.provider.update(patch)
            } else if (options.createIfMissing) {
              const payload: ProviderCreateRequest = {
                name: current.name.trim(),
                baseUrl: current.baseUrl.trim(),
                model: current.model.trim(),
                headers,
                proxyMode: current.proxyMode,
                proxyUrl: proxyUrl.length > 0 ? proxyUrl : null,
                temperature,
                maxTokens,
                timeoutMs,
                isDefault: profilesRef.current.length === 0
              }
              if (current.apiKey.length > 0) payload.apiKey = current.apiKey
              if (proxyAuth !== undefined) payload.proxyAuth = proxyAuth
              result = await api.provider.create(payload)
            } else {
              return null
            }

            if (!result.ok) {
              if (!options.silent) setFormError(`${result.error.code}: ${result.error.message}`)
              return null
            }

            const view = result.data
            setProfiles((previous) => {
              const next = previous.some((profile) => profile.id === view.id)
                ? previous.map((profile) => (profile.id === view.id ? view : profile))
                : [...previous, view]
              profilesRef.current = next
              return next
            })
            setSelectedId(view.id)
            selectedIdRef.current = view.id
            if (formRevisionRef.current === startedRevision) {
              setFormState(formFromView(view, formRef.current))
            }
            setFormError(null)
            if (!options.silent) markSaved('已保存')
            syncModelRef(view.id)
            return view
          } catch (caught) {
            if (!options.silent) setFormError(errorMessage(caught))
            return null
          } finally {
            setSaving(false)
          }
        }

        saveStartedRevisionRef.current = startedRevision
        const promise = run()
        saveInFlightRef.current = promise
        void promise.finally(() => {
          if (saveInFlightRef.current === promise) saveInFlightRef.current = null
        })
        return promise
      }
    },
    [api, markSaved, onboarding, setFormState, syncModelRef]
  )
  saveProfileRef.current = saveProfileNow

  const flushPendingSave = useCallback(async (): Promise<void> => {
    if (saveTimerRef.current !== null) {
      window.clearTimeout(saveTimerRef.current)
      saveTimerRef.current = null
    }
    await saveProfileNow({ createIfMissing: true, silent: true })
  }, [saveProfileNow])

  const loadProfile = useCallback(
    (target: ProviderProfileView | null): void => {
      setDeleteConfirm(false)
      setFormError(null)
      setTestOutcome(null)
      setSelectedId(target?.id ?? null)
      selectedIdRef.current = target?.id ?? null
      setFormState(
        target
          ? formFromView(target, formRef.current)
          : { ...emptyForm(), name: onboarding ? '' : '新配置' }
      )
    },
    [onboarding, setFormState]
  )

  const selectProfile = useCallback(
    async (id: string): Promise<void> => {
      if (selectedIdRef.current === id) {
        setDeleteConfirm(false)
        return
      }
      await flushPendingSave()
      const target = profilesRef.current.find((profile) => profile.id === id) ?? null
      if (!target) return
      loadProfile(target)
      syncModelRef(target.id)
    },
    [flushPendingSave, loadProfile, syncModelRef]
  )

  const startNewProfile = useCallback(async (): Promise<void> => {
    await flushPendingSave()
    loadProfile(null)
  }, [flushPendingSave, loadProfile])

  const makeDefaultProfile = useCallback(async (): Promise<void> => {
    const id = selectedIdRef.current
    if (!api || !id) return
    setFormError(null)
    try {
      const result = await api.provider.update({ id, isDefault: true })
      if (!result.ok) {
        setFormError(`${result.error.code}: ${result.error.message}`)
        return
      }
      const view = result.data
      setProfiles((previous) => {
        const next = previous.map((profile) =>
          profile.id === view.id
            ? view
            : profile.isDefault
              ? { ...profile, isDefault: false }
              : profile
        )
        profilesRef.current = next
        return next
      })
      markSaved('已设为默认')
    } catch (caught) {
      setFormError(errorMessage(caught))
    }
  }, [api, markSaved])

  const deleteSelectedProfile = useCallback(async (): Promise<void> => {
    const id = selectedIdRef.current
    if (!api || !id) return
    setFormError(null)
    try {
      const result = await api.provider.delete({ id })
      if (!result.ok || !result.data.deleted) {
        if (!result.ok) setFormError(`${result.error.code}: ${result.error.message}`)
        return
      }
      const remaining = profilesRef.current.filter((profile) => profile.id !== id)
      setProfiles(remaining)
      profilesRef.current = remaining
      const fallback = remaining.find((profile) => profile.isDefault) ?? remaining[0] ?? null
      loadProfile(fallback)
      if (fallback) syncModelRef(fallback.id)
      else void api.settings.set({ key: SETTINGS_KEYS.model, value: { profileId: null } })
      markSaved('已删除')
    } catch (caught) {
      setFormError(errorMessage(caught))
    }
  }, [api, loadProfile, markSaved, syncModelRef])

  const updateForm = useCallback(
    (patch: Partial<ModelForm>) => {
      userEditingRef.current = true
      formRevisionRef.current += 1
      setFormState({ ...formRef.current, ...patch })
      scheduleSave()
    },
    [scheduleSave, setFormState]
  )

  const updateHeader = useCallback(
    (index: number, patch: Partial<HeaderRow>) => {
      userEditingRef.current = true
      formRevisionRef.current += 1
      const current = formRef.current
      const headers = current.headers.map((row, rowIndex) =>
        rowIndex === index ? { ...row, ...patch } : row
      )
      setFormState({ ...current, headers })
      scheduleSave()
    },
    [scheduleSave, setFormState]
  )

  const applyPreset = useCallback(
    (preset: ProviderPreset) => {
      userEditingRef.current = true
      formRevisionRef.current += 1
      setFormState({
        ...formRef.current,
        name: preset.name,
        baseUrl: preset.baseUrl,
        model: preset.model
      })
      setFormError(null)
      scheduleSave()
    },
    [scheduleSave, setFormState]
  )

  const testConnection = useCallback(async (): Promise<void> => {
    if (!api) return
    setTesting(true)
    setTestOutcome(null)
    setFormError(null)
    try {
      const view = await saveProfileNow({ createIfMissing: true, silent: false })
      if (!view) return
      const result = await api.provider.test({ profileId: view.id })
      if (!result.ok) {
        setTestOutcome({
          ok: false,
          message: `${result.error.code}: ${result.error.message}`
        })
        return
      }
      if (!result.data.ok) {
        setTestOutcome({
          ok: false,
          message: `${result.data.error?.code ?? 'ERROR'}: ${
            result.data.error?.message ?? '测试失败'
          }`
        })
        return
      }
      setTestOutcome({
        ok: true,
        message: '连接成功',
        latencyMs: result.data.latencyMs,
        models: result.data.models
      })
      const marked = await api.settings.set({
        key: SETTINGS_KEYS.onboardingComplete,
        value: true
      })
      if (marked.ok) setOnboardingDone(true)
      markSaved('测试通过')
    } finally {
      setTesting(false)
    }
  }, [api, markSaved, saveProfileNow])

  const changeAppearance = useCallback(
    (patch: Partial<AppearanceSettings>) => {
      const next = normalizeAppearance({ ...appearanceRef.current, ...patch })
      applyLocal(next)
      if (patch.barWidth !== undefined) {
        void api?.window.setBarWidth(next.barWidth)
      }
      if (api) {
        void api.settings
          .set({ key: SETTINGS_KEYS.appearance, value: next as unknown as JsonValue })
          .then((result) => {
            if (!result.ok) {
              setError(`${result.error.code}: ${result.error.message}`)
            }
          })
      }
    },
    [api, applyLocal]
  )

  const changeFontFamily = useCallback(
    (family: string) => {
      if (!isAllowedFontFamily(family)) {
        setFontNote(`不支持的字体：${family}，已回退到默认字体。`)
        changeAppearance({ fontFamily: DEFAULT_APPEARANCE.fontFamily })
        return
      }
      if (fonts.length > 0 && !fonts.includes(family)) {
        setFontNote(`未检测到 ${family}，已回退到本地可用字体；无网络下载。`)
        return
      }
      setFontNote(
        fonts.length > 0 && !fonts.includes('LXGW WenKai')
          ? '未检测到 LXGW WenKai，已回退到本地可用字体；无网络下载。'
          : null
      )
      changeAppearance({ fontFamily: family })
    },
    [changeAppearance, fonts]
  )

  const runExport = useCallback(
    (scope: 'current' | 'all', format: 'json' | 'markdown') => {
      if (!api || exporting) return
      setExporting(true)
      setExportError(null)
      setExportStatus(null)
      void api.sessions
        .export({ scope, format })
        .then((result) => {
          if (!result.ok) {
            if (result.error.code === 'ABORTED') {
              setExportStatus('已取消导出')
              return
            }
            setExportError(`${result.error.code}: ${result.error.message}`)
            return
          }
          setExportStatus(`已导出 ${result.data.count} 条会话 → ${result.data.path}`)
        })
        .catch((caught: unknown) =>
          setExportError(caught instanceof Error ? caught.message : '导出失败')
        )
        .finally(() => setExporting(false))
    },
    [api, exporting]
  )

  const applyRetention = useCallback(() => {
    if (!api || retentionSaving) return
    setRetentionSaving(true)
    setRetentionError(null)
    setRetentionStatus(null)
    const trimmed = retentionDraft.trim()
    const run = async (): Promise<void> => {
      if (trimmed.length === 0) {
        const saved = await api.settings.set({
          key: SETTINGS_KEYS.data,
          value: { retentionDays: null, lastExportPath: null } as unknown as JsonValue
        })
        if (!saved.ok) {
          setRetentionError(`${saved.error.code}: ${saved.error.message}`)
          return
        }
        setRetentionStatus('已关闭自动清理（保留全部历史）')
        return
      }
      const days = Number(trimmed)
      if (!Number.isInteger(days) || days < RETENTION_DAYS_MIN || days > RETENTION_DAYS_MAX) {
        setRetentionError(`保留天数需为 ${RETENTION_DAYS_MIN}–${RETENTION_DAYS_MAX} 的整数，留空表示永不删除`)
        return
      }
      const saved = await api.settings.set({
        key: SETTINGS_KEYS.data,
        value: { retentionDays: days, lastExportPath: null } as unknown as JsonValue
      })
      if (!saved.ok) {
        setRetentionError(`${saved.error.code}: ${saved.error.message}`)
        return
      }
      const cleaned = await api.data.cleanup({})
      if (!cleaned.ok) {
        setRetentionError(`${cleaned.error.code}: ${cleaned.error.message}`)
        return
      }
      const when =
        cleaned.data.lastCleanupAt !== null
          ? new Date(cleaned.data.lastCleanupAt).toISOString()
          : '—'
      setRetentionStatus(`已清理 ${cleaned.data.cleaned} 条会话（保留 ${days} 天）· ${when}`)
    }
    void run().finally(() => setRetentionSaving(false))
  }, [api, retentionDraft, retentionSaving])

  const refreshLogs = useCallback(() => {
    if (!api) return
    setLogError(null)
    void api.app.readLogs().then((result) => {
      if (!result.ok) {
        setLogError(`${result.error.code}: ${result.error.message}`)
        return
      }
      setLogContent(result.data.content)
      setLogTruncated(result.data.truncated)
      setLogBytes(result.data.bytes)
    })
  }, [api])

  const saveInference = useCallback(
    (prompt: string, immediate: boolean) => {
      if (!api) return
      const commit = (): void => {
        const next: InferenceSettings = {
          ...inferenceRef.current,
          systemPrompt: Array.from(prompt)
            .slice(0, SYSTEM_PROMPT_MAX_LENGTH)
            .join('')
        }
        inferenceRef.current = next
        void api.settings
          .set({ key: SETTINGS_KEYS.inference, value: next as unknown as JsonValue })
          .then((result) => {
            if (result.ok) {
              setSystemPromptNote('已保存')
            } else {
              setSystemPromptNote(null)
              setError(`${result.error.code}: ${result.error.message}`)
            }
          })
      }
      if (systemPromptTimerRef.current !== null) {
        window.clearTimeout(systemPromptTimerRef.current)
        systemPromptTimerRef.current = null
      }
      if (immediate) {
        commit()
        return
      }
      systemPromptTimerRef.current = window.setTimeout(() => {
        systemPromptTimerRef.current = null
        commit()
      }, 500)
    },
    [api]
  )

  const changeBehavior = useCallback(
    (patch: Partial<BehaviorSettings>) => {
      if (!api) return
      const next: BehaviorSettings = { ...behaviorRef.current, ...patch }
      behaviorRef.current = next
      setBehavior(next)
      void api.settings
        .set({ key: SETTINGS_KEYS.behavior, value: next as unknown as JsonValue })
        .then((result) => {
          if (!result.ok) setError(`${result.error.code}: ${result.error.message}`)
        })
    },
    [api]
  )

  const changeStartup = useCallback(
    (patch: Partial<StartupSettings>) => {
      if (!api || startupSaving) return
      const next = { ...startupRef.current, ...patch }
      startupRef.current = next
      setStartupSettings(next)
      setStartupSaving(true)
      setStartupError(null)
      void api.app
        .setStartup(patch)
        .then((result) => {
          if (!result.ok) {
            setStartupError(`${result.error.code}: ${result.error.message}`)
            return
          }
          const state = result.data
          const confirmed = { autostart: state.autostart, watchdog: state.watchdog }
          startupRef.current = confirmed
          setStartupSettings(confirmed)
          setStartupStatus(state)
          setStartupError(state.error)
        })
        .catch((caught: unknown) => setStartupError(errorMessage(caught)))
        .finally(() => setStartupSaving(false))
    },
    [api, startupSaving]
  )

  const changeBehaviorNumber = useCallback(
    (field: 'streamingHideDelayMs' | 'contextRounds', raw: string) => {
      setBehaviorDraft((current) => ({ ...current, [field]: raw }))
      const numeric = Number(raw)
      const min = field === 'streamingHideDelayMs' ? STREAMING_HIDE_DELAY_MIN : CONTEXT_ROUNDS_MIN
      const max = field === 'streamingHideDelayMs' ? STREAMING_HIDE_DELAY_MAX : CONTEXT_ROUNDS_MAX
      if (Number.isInteger(numeric) && numeric >= min && numeric <= max) {
        if (field === 'streamingHideDelayMs') {
          changeBehavior({ streamingHideDelayMs: numeric })
        } else {
          changeBehavior({ contextRounds: numeric })
        }
      }
    },
    [changeBehavior]
  )

  const openLocalPath = useCallback(
    (kind: AppPathKind, label: string) => {
      if (!api) return
      setPathError(null)
      setPathNote(null)
      void api.app.openPath(kind).then((result) => {
        if (!result.ok) {
          setPathError(`${result.error.code}: ${result.error.message}`)
        } else if (!result.data.opened) {
          setPathError(`无法打开${label}目录`)
        } else {
          setPathNote(`已请求打开${label}目录`)
        }
      })
    },
    [api]
  )

  const clearHistory = useCallback(() => {
    if (!api || clearing) return
    setClearing(true)
    setClearError(null)
    void api.sessions
      .clearAll()
      .then((result) => {
        if (!result.ok) {
          setClearError(`${result.error.code}: ${result.error.message}`)
          return
        }
        setClearResult(result.data.cleared)
        setClearConfirm(false)
      })
      .finally(() => setClearing(false))
  }, [api, clearing])

  const cancelRecording = useCallback((note: string | null = null) => {
    recordingRef.current = false
    setHotkeyRecording(false)
    if (note !== null) setHotkeyNote(note)
  }, [])

  const startRecording = useCallback(() => {
    if (!document.hasFocus()) {
      setHotkeyError('设置窗口未获得焦点，无法录制快捷键')
      setHotkeyNote(null)
      return
    }
    setHotkeyError(null)
    setHotkeyConflict(false)
    setHotkeyNote('请按下新的组合键（Esc 取消）')
    recordingRef.current = true
    setHotkeyRecording(true)
  }, [])

  const applyHotkey = useCallback(
    async (accelerator: string): Promise<void> => {
      if (!api || hotkeySavingRef.current) return
      hotkeySavingRef.current = true
      setHotkeySaving(true)
      setHotkeyError(null)
      setHotkeyConflict(false)
      try {
        const result = await api.app.setHotkey({ accelerator })
        if (!result.ok) {
          setHotkeyError(`${result.error.code}: ${result.error.message}`)
          setHotkeyNote(null)
          return
        }
        const status = result.data
        setHotkeyStatus(status)
        if (status.registered && status.accelerator === accelerator) {
          setShortcut({ accelerator })
          setHotkeyError(null)
          setHotkeyConflict(false)
          setHotkeyNote(`已保存：${status.accelerator}`)
          return
        }
        setHotkeyError(status.error ?? `快捷键 ${accelerator} 注册失败`)
        setHotkeyConflict(status.conflict)
        setHotkeyNote(
          status.accelerator ? `已保留原快捷键：${status.accelerator}` : '当前没有可用的全局快捷键'
        )
        if (status.accelerator) setShortcut({ accelerator: status.accelerator })
      } catch (caught) {
        setHotkeyError(errorMessage(caught))
        setHotkeyNote(null)
      } finally {
        hotkeySavingRef.current = false
        setHotkeySaving(false)
      }
    },
    [api]
  )

  useEffect(() => {
    if (!api) return
    const onKeyDown = (event: KeyboardEvent): void => {
      if (recordingRef.current) {
        if (!document.hasFocus()) return
        if (event.isComposing || event.keyCode === 229) return
        if (isModifierOnlyKey(event.key)) {
          event.preventDefault()
          return
        }
        event.preventDefault()
        event.stopPropagation()
        if (event.key === 'Escape') {
          cancelRecording('已取消录制')
          return
        }
        const accelerator = acceleratorFromKeyInput(event)
        if (accelerator === null || !isValidAccelerator(accelerator)) {
          const hasModifier = event.ctrlKey || event.altKey || event.shiftKey || event.metaKey
          setHotkeyError(
            hasModifier
              ? `无法识别按键：${event.key}`
              : '快捷键需包含 Ctrl/Alt/Shift/Super 至少一个修饰键'
          )
          setHotkeyNote('请继续按键，Esc 取消')
          return
        }
        recordingRef.current = false
        setHotkeyRecording(false)
        setHotkeyNote('正在注册…')
        void applyHotkey(accelerator)
        return
      }
      if (event.key !== 'Escape') return
      event.preventDefault()
      void api.window.closeSettings()
    }
    const onBlur = (): void => {
      if (recordingRef.current) cancelRecording('窗口失去焦点，录制已取消')
    }
    window.addEventListener('keydown', onKeyDown, true)
    window.addEventListener('blur', onBlur)
    return () => {
      window.removeEventListener('keydown', onKeyDown, true)
      window.removeEventListener('blur', onBlur)
    }
  }, [api, applyHotkey, cancelRecording])

  const nextStep = useCallback((): void => {
    if (onboardingStep === 1) {
      const current = formRef.current
      const baseUrl = current.baseUrl.trim()
      const urlError = validateBaseUrl(baseUrl)
      if (urlError) {
        setFormError(urlError)
        return
      }
      if (current.name.trim().length === 0) {
        setFormState({ ...current, name: deriveProfileName(baseUrl) })
      }
      setFormError(null)
      setOnboardingStep(2)
      return
    }
    if (onboardingStep === 2) {
      setFormError(null)
      setOnboardingStep(3)
    }
  }, [onboardingStep, setFormState])

  const backStep = useCallback((): void => {
    setFormError(null)
    setOnboardingStep((step) => (step === 3 ? 2 : step === 2 ? 1 : 1))
  }, [])

  const loopback = isLoopbackBaseUrl(form.baseUrl.trim())
  const activeProfile = profiles.find((profile) => profile.id === selectedId) ?? null
  const canTest = !saving && !testing

  const navItems: Array<{ id: Tab; label: string; testId: string }> = [
    { id: 'model', label: '模型', testId: 'settings-tab-model' },
    { id: 'appearance', label: '外观', testId: 'settings-tab-appearance' },
    { id: 'shortcut', label: '快捷键', testId: 'settings-tab-shortcut' },
    { id: 'behavior', label: '行为', testId: 'settings-tab-behavior' },
    { id: 'data', label: '数据', testId: 'settings-tab-data' },
    { id: 'about', label: '关于', testId: 'settings-tab-about' }
  ]

  const renderModelFields = (onboardingStepView: boolean): ReactNode => (
    <>
      <div className="settings-presets" data-testid="model-presets">
        {PRESETS.map((preset) => (
          <button
            key={preset.id}
            type="button"
            className="settings-chip"
            data-testid={`preset-${preset.id}`}
            onClick={() => applyPreset(preset)}
          >
            {preset.label}
          </button>
        ))}
      </div>

      {!onboardingStepView ? (
        <label className="settings-field">
          <span className="settings-label">名称</span>
          <input
            className="settings-input"
            data-testid="model-name"
            value={form.name}
            onChange={(event) => updateForm({ name: event.target.value })}
            onBlur={() => {
              if (!onboarding && userEditingRef.current) {
                void saveProfileNow({ createIfMissing: true, silent: false })
              }
            }}
          />
        </label>
      ) : null}

      <label className="settings-field">
        <span className="settings-label">base_url</span>
        <input
          className="settings-input"
          data-testid={onboardingStepView ? 'onboarding-base-url' : 'model-base-url'}
          value={form.baseUrl}
          placeholder="https://api.example.com/v1"
          spellCheck={false}
          onChange={(event) => updateForm({ baseUrl: event.target.value })}
          onBlur={() => {
            if (!onboarding && userEditingRef.current) {
              void saveProfileNow({ createIfMissing: true, silent: false })
            }
          }}
        />
      </label>

      {!onboardingStepView || onboardingStep >= 2 ? (
        <label className="settings-field">
          <span className="settings-label">api_key</span>
          <input
            className="settings-input"
            data-testid="model-api-key"
            type="password"
            autoComplete="off"
            spellCheck={false}
            value={form.apiKey}
            placeholder={
              activeProfile?.hasApiKey
                ? '已配置（留空保持不变）'
                : loopback
                  ? '本地服务可留空'
                  : '输入 API key'
            }
            onChange={(event) => updateForm({ apiKey: event.target.value })}
            onBlur={() => {
              if (!onboarding && formRef.current.apiKey.length > 0) {
                void saveProfileNow({ createIfMissing: true, silent: false })
              }
            }}
          />
          <span className="settings-help" data-testid="model-key-state">
            {activeProfile?.hasApiKey
              ? '已配置（只写不读）'
              : loopback
                ? '本地回环地址允许空 key'
                : '密钥只写入系统钥匙串，不会回传渲染进程'}
          </span>
        </label>
      ) : null}

      {!onboardingStepView || onboardingStep >= 3 ? (
        <label className="settings-field">
          <span className="settings-label">模型</span>
          <input
            className="settings-input"
            data-testid="model-model"
            value={form.model}
            placeholder="deepseek-chat / llama3.2"
            spellCheck={false}
            onChange={(event) => updateForm({ model: event.target.value })}
            onBlur={() => {
              if (!onboarding && userEditingRef.current) {
                void saveProfileNow({ createIfMissing: true, silent: false })
              }
            }}
          />
        </label>
      ) : null}

      {!onboardingStepView ? (
        <>
          <div className="settings-group" data-testid="inference-fields">
            <div className="settings-group-head">
              <span className="settings-group-title">推理参数</span>
            </div>

            <label className="settings-field settings-field--stack">
              <span className="settings-label">系统提示词</span>
              <textarea
                className="settings-textarea"
                data-testid="inference-system-prompt"
                maxLength={SYSTEM_PROMPT_MAX_LENGTH}
                value={systemPrompt}
                placeholder="留空使用会话默认提示词"
                spellCheck={false}
                onChange={(event) => {
                  setSystemPrompt(event.target.value)
                  setSystemPromptNote(null)
                  saveInference(event.target.value, false)
                }}
                onBlur={() => saveInference(systemPrompt, true)}
              />
              <span className="settings-help" data-testid="inference-system-prompt-note">
                {systemPromptNote ?? `最多 ${SYSTEM_PROMPT_MAX_LENGTH} 字；保存后下一次请求生效。`}
              </span>
            </label>

            <label className="settings-field">
              <span className="settings-label">temperature</span>
              <input
                className="settings-input settings-input--narrow"
                data-testid="model-temperature"
                type="number"
                min={0}
                max={2}
                step={0.1}
                value={form.temperature}
                placeholder="默认"
                onChange={(event) => updateForm({ temperature: event.target.value })}
                onBlur={() => {
                  if (userEditingRef.current) {
                    void saveProfileNow({ createIfMissing: true, silent: false })
                  }
                }}
              />
              <span className="settings-help">留空不发送</span>
            </label>

            <label className="settings-field">
              <span className="settings-label">max_tokens</span>
              <input
                className="settings-input settings-input--narrow"
                data-testid="model-max-tokens"
                type="number"
                min={1}
                max={32_768}
                step={1}
                value={form.maxTokens}
                placeholder="默认"
                onChange={(event) => updateForm({ maxTokens: event.target.value })}
                onBlur={() => {
                  if (userEditingRef.current) {
                    void saveProfileNow({ createIfMissing: true, silent: false })
                  }
                }}
              />
              <span className="settings-help">留空不发送</span>
            </label>

            <label className="settings-field">
              <span className="settings-label">请求超时（秒）</span>
              <input
                className="settings-input settings-input--narrow"
                data-testid="model-timeout"
                type="number"
                min={5}
                max={300}
                value={form.timeoutSec}
                onChange={(event) => updateForm({ timeoutSec: event.target.value })}
                onBlur={() => {
                  if (userEditingRef.current) {
                    void saveProfileNow({ createIfMissing: true, silent: false })
                  }
                }}
              />
              <span className="settings-help">5–300 秒</span>
            </label>
          </div>

          <div className="settings-group">
            <div className="settings-group-head">
              <span className="settings-group-title">额外请求头</span>
              <button
                type="button"
                className="settings-link"
                data-testid="model-header-add"
                onClick={() => {
                  userEditingRef.current = true
                  formRevisionRef.current += 1
                  const current = formRef.current
                  setFormState({
                    ...current,
                    headers: [...current.headers, { name: '', value: '', secret: false, hasValue: false }]
                  })
                  scheduleSave()
                }}
              >
                + 添加
              </button>
            </div>
            {form.headers.length === 0 ? (
              <p className="settings-empty">未配置额外请求头</p>
            ) : (
              form.headers.map((header, index) => (
                <div className="settings-header-row" key={`${header.name}-${index}`}>
                  <input
                    className="settings-input"
                    data-testid={`model-header-name-${index}`}
                    placeholder="Header 名称"
                    value={header.name}
                    spellCheck={false}
                    onChange={(event) => updateHeader(index, { name: event.target.value })}
                  />
                  <input
                    className="settings-input"
                    data-testid={`model-header-value-${index}`}
                    placeholder={header.hasValue ? '已配置（留空保持不变）' : 'Header 值'}
                    type={header.secret ? 'password' : 'text'}
                    value={header.value}
                    spellCheck={false}
                    onChange={(event) => updateHeader(index, { value: event.target.value })}
                  />
                  <label className="settings-check settings-check--inline">
                    <input
                      type="checkbox"
                      data-testid={`model-header-secret-${index}`}
                      checked={header.secret}
                      onChange={(event) => updateHeader(index, { secret: event.target.checked })}
                    />
                    <span>secret</span>
                  </label>
                  <button
                    type="button"
                    className="settings-link settings-link--danger"
                    data-testid={`model-header-remove-${index}`}
                    onClick={() => {
                      userEditingRef.current = true
                      formRevisionRef.current += 1
                      const current = formRef.current
                      setFormState({
                        ...current,
                        headers: current.headers.filter((_, rowIndex) => rowIndex !== index)
                      })
                      scheduleSave()
                    }}
                  >
                    删除
                  </button>
                </div>
              ))
            )}
          </div>

          <div className="settings-group" data-testid="model-proxy-group">
            <div className="settings-group-head">
              <span className="settings-group-title">代理</span>
            </div>

            <label className="settings-field">
              <span className="settings-label">代理模式</span>
              <select
                className="settings-input"
                data-testid="model-proxy-mode"
                value={form.proxyMode}
                onChange={(event) =>
                  updateForm({ proxyMode: event.target.value as ProviderProxyMode })
                }
              >
                <option value="system">跟随系统环境变量</option>
                <option value="direct">直连（不使用代理）</option>
                <option value="custom">自定义代理</option>
              </select>
              <span className="settings-help">
                {form.proxyMode === 'system'
                  ? '读取 HTTP_PROXY/HTTPS_PROXY/ALL_PROXY/NO_PROXY；localhost 始终绕过。'
                  : form.proxyMode === 'direct'
                    ? '所有请求直连，忽略环境变量。'
                    : '支持 http/https/socks5/socks5h；URL 中不能包含用户名或密码。'}
              </span>
            </label>

            {form.proxyMode === 'custom' ? (
              <>
                <label className="settings-field">
                  <span className="settings-label">代理 URL</span>
                  <input
                    className="settings-input"
                    data-testid="model-proxy-url"
                    value={form.proxyUrl}
                    placeholder="http://127.0.0.1:7890 或 socks5://127.0.0.1:1080"
                    spellCheck={false}
                    onChange={(event) => updateForm({ proxyUrl: event.target.value })}
                  />
                </label>

                <label className="settings-field">
                  <span className="settings-label">代理用户名</span>
                  <input
                    className="settings-input"
                    data-testid="model-proxy-username"
                    autoComplete="off"
                    spellCheck={false}
                    value={form.proxyUser}
                    placeholder={
                      activeProfile?.hasProxyAuth
                        ? '已配置（留空保持不变）'
                        : '可选'
                    }
                    onChange={(event) =>
                      updateForm({
                        proxyUser: event.target.value,
                        clearProxyAuth: false
                      })
                    }
                  />
                </label>

                <label className="settings-field">
                  <span className="settings-label">代理密码</span>
                  <input
                    className="settings-input"
                    data-testid="model-proxy-password"
                    type="password"
                    autoComplete="off"
                    spellCheck={false}
                    value={form.proxyPassword}
                    placeholder={
                      activeProfile?.hasProxyAuth
                        ? '已配置（留空保持不变）'
                        : '可选'
                    }
                    onChange={(event) =>
                      updateForm({
                        proxyPassword: event.target.value,
                        clearProxyAuth: false
                      })
                    }
                  />
                  <span className="settings-help" data-testid="model-proxy-auth-state">
                    {activeProfile?.hasProxyAuth
                      ? `已配置（只写不读）${
                          activeProfile.proxyUsernameMasked
                            ? ` · ${activeProfile.proxyUsernameMasked}`
                            : ''
                        }`
                      : '未配置代理认证；密码只写入系统钥匙串'}
                  </span>
                </label>

                {activeProfile?.hasProxyAuth || form.clearProxyAuth ? (
                  <div className="settings-actions">
                    <button
                      type="button"
                      className="settings-link settings-link--danger"
                      data-testid="model-proxy-clear"
                      onClick={() =>
                        updateForm({
                          proxyUser: '',
                          proxyPassword: '',
                          clearProxyAuth: true
                        })
                      }
                    >
                      清除代理认证
                    </button>
                  </div>
                ) : null}
              </>
            ) : null}
          </div>
        </>
      ) : null}
    </>
  )

  const platformCapabilities = info?.platformCapabilities ?? null
  const autostartMechanism = platformCapabilities?.autostart.mechanism ?? 'xdg-desktop'
  const watchdogCapability = platformCapabilities?.watchdog ?? null
  const capabilityRows: Array<{
    key: string
    label: string
    status: CapabilityStatus
  }> = platformCapabilities
    ? [
        { key: 'hotkey', label: '全局热键', status: platformCapabilities.hotkey },
        {
          key: 'click-through',
          label: '点击穿透',
          status: platformCapabilities.clickThrough
        },
        { key: 'blur', label: '毛玻璃', status: platformCapabilities.blur },
        { key: 'fonts', label: '字体', status: platformCapabilities.fonts },
        { key: 'autostart', label: '登录自启', status: platformCapabilities.autostart },
        { key: 'watchdog', label: '看门狗', status: platformCapabilities.watchdog },
        {
          key: 'native-helper',
          label: 'X11 helper',
          status: platformCapabilities.nativeHelper
        }
      ]
    : []

  return (
    <main
      className="settings"
      data-testid="settings"
      data-onboarding={onboarding ? '1' : undefined}
    >
      <aside className="settings-nav" data-testid="settings-nav">
        <h1 className="settings-brand">QuickAsk 设置</h1>
        {navItems.map((item) => {
          const active = tab === item.id
          return (
            <button
              key={item.id}
              type="button"
              className={`settings-item${active ? ' settings-item-active' : ''}`}
              data-testid={item.testId}
              aria-current={active ? 'page' : undefined}
              onClick={() => setTab(item.id)}
            >
              {item.label}
            </button>
          )
        })}
      </aside>

      <div className="settings-main">
        <div className="settings-content" data-testid="settings-content">
          {error ? (
            <div className="settings-banner settings-banner--error" role="alert" data-testid="settings-error">
              {error}
            </div>
          ) : null}

          {loading ? (
            <p className="settings-empty">加载中…</p>
          ) : tab === 'appearance' ? (
            <section className="settings-section" data-testid="appearance-panel">
              <h2 className="settings-title">外观</h2>
              <p className="settings-subtitle">改动即时生效，无需保存。</p>

              <fieldset className="settings-fieldset">
                <legend className="settings-label">主题</legend>
                <div className="settings-radio-row">
                  {(['dark', 'light', 'system'] as const).map((theme) => (
                    <label className="settings-radio" key={theme}>
                      <input
                        type="radio"
                        name="theme"
                        data-testid={`appearance-theme-${theme}`}
                        checked={appearance.theme === theme}
                        onChange={() => changeAppearance({ theme })}
                      />
                      <span>{THEME_LABELS[theme]}</span>
                    </label>
                  ))}
                </div>
              </fieldset>

              <fieldset className="settings-fieldset">
                <legend className="settings-label">主色</legend>
                <div className="settings-swatches">
                  {PRIMARY_PRESETS.map((preset) => (
                    <button
                      key={preset}
                      type="button"
                      className={`settings-swatch${
                        appearance.primary === preset ? ' settings-swatch--active' : ''
                      }`}
                      data-testid={`primary-${preset}`}
                      data-primary-value={preset}
                      aria-pressed={appearance.primary === preset}
                      onClick={() => changeAppearance({ primary: preset })}
                    >
                      <span
                        className="settings-swatch-dot"
                        style={{ background: PRIMARY_COLORS[preset] }}
                        aria-hidden="true"
                      />
                      <span>{PRIMARY_LABELS[preset]}</span>
                    </button>
                  ))}
                </div>
              </fieldset>

              <label className="settings-field settings-field--slider">
                <span className="settings-label">不透明度</span>
                <input
                  className="settings-range"
                  data-testid="opacity-range"
                  type="range"
                  min={OPACITY_MIN}
                  max={OPACITY_MAX}
                  step={1}
                  value={appearance.opacity}
                  onChange={(event) =>
                    changeAppearance({ opacity: Number(event.target.value) })
                  }
                />
                <span className="settings-value" data-testid="opacity-value">
                  {appearance.opacity}%
                </span>
              </label>

              <div className="settings-field">
                <span className="settings-label">毛玻璃</span>
                <div className="settings-inline">
                  <label className="settings-check">
                    <input
                      type="checkbox"
                      data-testid="blur-toggle"
                      checked={appearance.blurEnabled}
                      disabled={!blurStatus?.available}
                      onChange={(event) =>
                        changeAppearance({ blurEnabled: event.target.checked })
                      }
                    />
                    <span>{appearance.blurEnabled ? '已开启' : '已关闭'}</span>
                  </label>
                  <span
                    className={`settings-status${
                      blurStatus?.available ? ' settings-status--ok' : ' settings-status--warn'
                    }`}
                    data-testid="blur-status"
                  >
                    {blurStatus?.available
                      ? 'KWin 模糊效果可用'
                      : (blurStatus?.reason ?? '无法检测 KWin 模糊效果，当前不会伪造模糊')}
                  </span>
                </div>
              </div>

              <label className="settings-field settings-field--slider">
                <span className="settings-label">条宽</span>
                <input
                  className="settings-range"
                  data-testid="barwidth-range"
                  type="range"
                  min={BAR_WIDTH_MIN}
                  max={BAR_WIDTH_MAX}
                  step={BAR_WIDTH_STEP}
                  value={appearance.barWidth}
                  onChange={(event) =>
                    changeAppearance({ barWidth: Number(event.target.value) })
                  }
                />
                <span className="settings-value" data-testid="barwidth-value">
                  {appearance.barWidth}px
                </span>
              </label>

              <label className="settings-field settings-field--slider">
                <span className="settings-label">字号</span>
                <input
                  className="settings-range"
                  data-testid="fontsize-range"
                  type="range"
                  min={FONT_SIZE_MIN}
                  max={FONT_SIZE_MAX}
                  step={1}
                  value={appearance.fontSize}
                  onChange={(event) =>
                    changeAppearance({ fontSize: Number(event.target.value) })
                  }
                />
                <span className="settings-value" data-testid="fontsize-value">
                  {appearance.fontSize}px
                </span>
              </label>

              <label className="settings-field">
                <span className="settings-label">界面字体</span>
                <select
                  className="settings-input"
                  data-testid="fontfamily-select"
                  value={appearance.fontFamily}
                  onChange={(event) => changeFontFamily(event.target.value)}
                >
                  {(fonts.length > 0
                    ? fonts.includes(appearance.fontFamily)
                      ? fonts
                      : [appearance.fontFamily, ...fonts]
                    : [appearance.fontFamily]
                  ).map((family) => (
                    <option key={family} value={family}>
                      {family}
                    </option>
                  ))}
                </select>
                <span className="settings-help" data-testid="fontfamily-current">
                  当前：{appearance.fontFamily} · 仅限本机已安装字体，无网络下载
                </span>
              </label>
              {fontNote ? (
                <p className="settings-help" data-testid="font-hint">
                  {fontNote}
                </p>
              ) : null}

              <div className="settings-preview" data-testid="appearance-preview">
                <span className="settings-preview-title">预览</span>
                <span className="settings-preview-text">卡片背景透明度和主色会立即应用。</span>
              </div>
            </section>
          ) : tab === 'shortcut' ? (
            <section className="settings-section" data-testid="shortcut-panel">
              <h2 className="settings-title">快捷键</h2>
              <p className="settings-subtitle">
                录制后立即注册为全局快捷键；冲突时会自动恢复原快捷键。
              </p>

              <div className="settings-field">
                <span className="settings-label">当前快捷键</span>
                <span className="settings-value settings-value--wide" data-testid="hotkey-current">
                  {hotkeyStatus?.accelerator ?? shortcut.accelerator}
                </span>
              </div>

              <div className="settings-actions">
                <button
                  type="button"
                  className="settings-button settings-button--primary"
                  data-testid="hotkey-recorder"
                  disabled={hotkeyRecording || hotkeySaving}
                  onClick={startRecording}
                >
                  {hotkeyRecording ? '等待按键…' : hotkeySaving ? '注册中…' : '录制快捷键'}
                </button>
                {hotkeyRecording ? (
                  <button
                    type="button"
                    className="settings-button"
                    data-testid="hotkey-cancel"
                    onClick={() => cancelRecording('已取消录制')}
                  >
                    取消
                  </button>
                ) : null}
              </div>

              {hotkeyNote ? (
                <p className="settings-help" data-testid="hotkey-note">
                  {hotkeyNote}
                </p>
              ) : null}
              {hotkeyStatus?.registered && hotkeyError === null ? (
                <p className="settings-status settings-status--ok" data-testid="hotkey-saved">
                  已注册：{hotkeyStatus.accelerator}
                </p>
              ) : null}
              {hotkeyError ? (
                <p className="settings-error" data-testid="hotkey-error">
                  {hotkeyError}
                </p>
              ) : null}
              {hotkeyConflict ? (
                <p className="settings-error" data-testid="hotkey-conflict">
                  该组合已被占用，已按事务回滚保留原快捷键。
                </p>
              ) : null}

              <details className="settings-details">
                <summary>录制说明</summary>
                <p>
                  按下包含 Ctrl / Alt / Shift / Super 的组合键；字母会转为大写，支持
                  Space、Tab、方向键与 F1–F24。Esc 取消录制，设置窗口失焦时不会录制。
                </p>
              </details>
            </section>
          ) : tab === 'behavior' ? (
            <section className="settings-section" data-testid="behavior-panel">
              <h2 className="settings-title">行为</h2>
              <p className="settings-subtitle">改动即时生效，并同步到主窗口。</p>

              <label className="settings-check">
                <input
                  type="checkbox"
                  data-testid="behavior-esc-direct"
                  checked={behavior.escDirectHide}
                  onChange={(event) =>
                    changeBehavior({ escDirectHide: event.target.checked })
                  }
                />
                <span>Esc 直接隐藏（跳过逐层收起）</span>
              </label>

              <label className="settings-check">
                <input
                  type="checkbox"
                  data-testid="behavior-hide-on-blur"
                  checked={behavior.hideOnBlur}
                  onChange={(event) => changeBehavior({ hideOnBlur: event.target.checked })}
                />
                <span>失焦自动隐藏</span>
              </label>

              <label className="settings-field">
                <span className="settings-label">流式隐藏延迟（ms）</span>
                <input
                  className="settings-input settings-input--narrow"
                  data-testid="behavior-streaming-delay"
                  type="number"
                  min={STREAMING_HIDE_DELAY_MIN}
                  max={STREAMING_HIDE_DELAY_MAX}
                  step={100}
                  value={behaviorDraft.streamingHideDelayMs}
                  onChange={(event) =>
                    changeBehaviorNumber('streamingHideDelayMs', event.target.value)
                  }
                  onBlur={() =>
                    setBehaviorDraft((current) => ({
                      ...current,
                      streamingHideDelayMs: String(behavior.streamingHideDelayMs)
                    }))
                  }
                />
                <span className="settings-help">500–10000，流式生成中失焦后的等待</span>
              </label>

              <label className="settings-field">
                <span className="settings-label">上下文轮数</span>
                <input
                  className="settings-input settings-input--narrow"
                  data-testid="behavior-context-rounds"
                  type="number"
                  min={CONTEXT_ROUNDS_MIN}
                  max={CONTEXT_ROUNDS_MAX}
                  step={1}
                  value={behaviorDraft.contextRounds}
                  onChange={(event) =>
                    changeBehaviorNumber('contextRounds', event.target.value)
                  }
                  onBlur={() =>
                    setBehaviorDraft((current) => ({
                      ...current,
                      contextRounds: String(behavior.contextRounds)
                    }))
                  }
                />
                <span className="settings-help">1–50，下一次请求生效</span>
              </label>

              <div className="settings-group" data-testid="startup-group">
                <div className="settings-group-head">
                  <span className="settings-group-title">登录与守护</span>
                </div>

                <label className="settings-check">
                  <input
                    type="checkbox"
                    data-testid="startup-autostart"
                    checked={startup.autostart}
                    disabled={startupSaving}
                    onChange={(event) =>
                      changeStartup({ autostart: event.target.checked })
                    }
                  />
                  <span>
                    {autostartMechanism === 'login-item'
                      ? '登录时自启动（Windows 登录项）'
                      : autostartMechanism === 'none'
                        ? '登录时自启动（当前平台不支持）'
                        : '登录时自启动（XDG autostart）'}
                  </span>
                </label>

                <label className="settings-check">
                  <input
                    type="checkbox"
                    data-testid="startup-watchdog"
                    checked={startup.watchdog}
                    disabled={
                      startupSaving ||
                      !startup.autostart ||
                      (watchdogCapability !== null &&
                        watchdogCapability.state !== 'available')
                    }
                    onChange={(event) =>
                      changeStartup({ watchdog: event.target.checked })
                    }
                  />
                  <span>看门狗守护（异常退出后自动重启）</span>
                  {watchdogCapability !== null &&
                  watchdogCapability.state !== 'available' ? (
                    <span className="settings-help" data-testid="startup-watchdog-reason">
                      {watchdogCapability.reason}
                    </span>
                  ) : null}
                </label>

                <div className="settings-field">
                  <span className="settings-label">
                    {autostartMechanism === 'login-item' ? '登录项位置' : '自启动文件'}
                  </span>
                  <code className="settings-path" data-testid="startup-desktop-path">
                    {startupStatus?.desktopPath ?? '读取中…'}
                  </code>
                </div>

                <p className="settings-help" data-testid="startup-state">
                  {startupStatus?.autostart
                    ? startupStatus.desktopExists
                      ? '已启用：登录后在托盘后台启动，不自动显示主窗口。'
                      : '已启用但文件尚未写入。'
                    : '未启用：不会写入任何登录项。'}
                </p>

                {startupError ? (
                  <p className="settings-error" data-testid="startup-error">
                    {startupError}
                  </p>
                ) : null}
              </div>
            </section>
          ) : tab === 'data' ? (
            <section className="settings-section" data-testid="data-panel">
              <h2 className="settings-title">数据</h2>
              <p className="settings-subtitle">只读展示本机路径；不会上传任何内容。</p>

              {pathError ? (
                <p className="settings-error" data-testid="data-path-error">
                  {pathError}
                </p>
              ) : null}

              <div className="settings-field">
                <span className="settings-label">数据目录</span>
                <code className="settings-path" data-testid="data-path-data">
                  {paths?.dataDir ?? '读取中…'}
                </code>
              </div>
              <div className="settings-field">
                <span className="settings-label">日志目录</span>
                <code className="settings-path" data-testid="data-path-logs">
                  {paths?.logsDir ?? '读取中…'}
                </code>
              </div>
              <div className="settings-field">
                <span className="settings-label">配置目录</span>
                <code className="settings-path" data-testid="data-path-config">
                  {paths?.configDir ?? '读取中…'}
                </code>
              </div>
              <div className="settings-field">
                <span className="settings-label">数据库</span>
                <code className="settings-path" data-testid="data-path-db">
                  {paths?.dbPath ?? '读取中…'}
                </code>
              </div>

              <div className="settings-actions">
                <button
                  type="button"
                  className="settings-button"
                  data-testid="open-data-dir"
                  onClick={() => openLocalPath('data', '数据')}
                >
                  打开数据目录
                </button>
                <button
                  type="button"
                  className="settings-button"
                  data-testid="open-logs-dir"
                  onClick={() => openLocalPath('logs', '日志')}
                >
                  打开日志目录
                </button>
              </div>
              {pathNote ? (
                <p className="settings-help" data-testid="data-path-note">
                  {pathNote}
                </p>
              ) : null}

              <div className="settings-group settings-group--danger">
                <div className="settings-group-head">
                  <span className="settings-group-title">清空历史</span>
                </div>
                {clearConfirm ? (
                  <div className="settings-confirm" data-testid="clear-confirm">
                    <p className="settings-error">此操作会删除全部会话、消息与搜索索引，且不可撤销。</p>
                    <div className="settings-actions">
                      <button
                        type="button"
                        className="settings-button"
                        data-testid="clear-cancel"
                        disabled={clearing}
                        onClick={() => {
                          setClearConfirm(false)
                          setClearError(null)
                        }}
                      >
                        取消
                      </button>
                      <button
                        type="button"
                        className="settings-button settings-button--danger"
                        data-testid="clear-confirm-button"
                        disabled={clearing}
                        onClick={clearHistory}
                      >
                        {clearing ? '清空中…' : '确认清空'}
                      </button>
                    </div>
                  </div>
                ) : (
                  <button
                    type="button"
                    className="settings-button settings-button--danger"
                    data-testid="data-clear-history"
                    onClick={() => {
                      setClearResult(null)
                      setClearError(null)
                      setClearConfirm(true)
                    }}
                  >
                    清空历史
                  </button>
                )}
                {clearResult !== null ? (
                  <p
                    className="settings-status settings-status--ok"
                    data-testid="clear-result"
                  >
                    已清空 {clearResult} 条会话
                  </p>
                ) : null}
                {clearError ? (
                  <p className="settings-error" data-testid="clear-error">
                    {clearError}
                  </p>
                ) : null}
              </div>

              <div className="settings-group">
                <div className="settings-group-head">
                  <span className="settings-group-title">导出历史</span>
                </div>
                <p className="settings-help">导出当前或全部会话为 JSON/Markdown；不含任何密钥。</p>
                <div className="settings-actions">
                  <button
                    type="button"
                    className="settings-button"
                    data-testid="export-current-json"
                    disabled={exporting}
                    onClick={() => runExport('current', 'json')}
                  >
                    导出当前 JSON
                  </button>
                  <button
                    type="button"
                    className="settings-button"
                    data-testid="export-current-markdown"
                    disabled={exporting}
                    onClick={() => runExport('current', 'markdown')}
                  >
                    导出当前 MD
                  </button>
                  <button
                    type="button"
                    className="settings-button"
                    data-testid="export-all-json"
                    disabled={exporting}
                    onClick={() => runExport('all', 'json')}
                  >
                    导出全部 JSON
                  </button>
                  <button
                    type="button"
                    className="settings-button"
                    data-testid="export-all-markdown"
                    disabled={exporting}
                    onClick={() => runExport('all', 'markdown')}
                  >
                    导出全部 MD
                  </button>
                </div>
                {exportStatus ? (
                  <p className="settings-status settings-status--ok" data-testid="export-status">
                    {exportStatus}
                  </p>
                ) : null}
                {exportError ? (
                  <p className="settings-error" data-testid="export-error">
                    {exportError}
                  </p>
                ) : null}
              </div>

              <div className="settings-group">
                <div className="settings-group-head">
                  <span className="settings-group-title">自动清理</span>
                </div>
                <p className="settings-help">
                  留空表示永不自动删除；设置天数后启动时与每日清理一次早于阈值的会话。
                </p>
                <label className="settings-field">
                  <span className="settings-label">保留天数</span>
                  <input
                    className="settings-input settings-input--narrow"
                    data-testid="retention-days"
                    type="number"
                    min={RETENTION_DAYS_MIN}
                    max={RETENTION_DAYS_MAX}
                    step={1}
                    value={retentionDraft}
                    placeholder={String(DEFAULT_DATA.retentionDays ?? '永不')}
                    onChange={(event) => setRetentionDraft(event.target.value)}
                  />
                  <button
                    type="button"
                    className="settings-button"
                    data-testid="retention-apply"
                    disabled={retentionSaving}
                    onClick={applyRetention}
                  >
                    {retentionSaving ? '应用中…' : '应用'}
                  </button>
                </label>
                {retentionStatus ? (
                  <p className="settings-status settings-status--ok" data-testid="retention-status">
                    {retentionStatus}
                  </p>
                ) : null}
                {retentionError ? (
                  <p className="settings-error" data-testid="retention-error">
                    {retentionError}
                  </p>
                ) : null}
              </div>

              <div className="settings-group">
                <div className="settings-group-head">
                  <span className="settings-group-title">最近日志（只读）</span>
                  <button
                    type="button"
                    className="settings-link"
                    data-testid="data-log-refresh"
                    onClick={refreshLogs}
                  >
                    刷新
                  </button>
                </div>
                <div className="settings-field">
                  <span className="settings-label">日志文件</span>
                  <code className="settings-path" data-testid="data-log-path">
                    {paths ? `${paths.logsDir}/quickask.log` : '读取中…'}
                  </code>
                </div>
                {logError ? (
                  <p className="settings-error" data-testid="data-log-error">
                    {logError}
                  </p>
                ) : null}
                <pre
                  className="settings-log"
                  data-testid="data-log-content"
                  data-truncated={logTruncated ? '1' : '0'}
                  data-bytes={logBytes}
                >
                  {logContent || '（暂无日志）'}
                </pre>
                {logTruncated ? (
                  <p className="settings-help" data-testid="data-log-truncated">
                    仅显示末尾 {logBytes} 字节（上限 64KB），已脱敏。
                  </p>
                ) : null}
              </div>
            </section>
          ) : tab === 'about' ? (
            <section className="settings-section" data-testid="about-panel">
              <h2 className="settings-title">关于</h2>
              <p className="settings-subtitle">本地构建，无 CDN、无遥测。</p>

              <div className="settings-field">
                <span className="settings-label">版本</span>
                <span className="settings-value settings-value--wide" data-testid="about-version">
                  {info?.version ?? paths?.version ?? '—'}
                </span>
              </div>
              <div className="settings-field">
                <span className="settings-label">设置 schema</span>
                <span className="settings-value settings-value--wide" data-testid="about-schema">
                  v{paths?.schemaVersion ?? '—'}
                </span>
              </div>
              <div className="settings-field">
                <span className="settings-label">构建</span>
                <span className="settings-value settings-value--wide" data-testid="about-build">
                  Electron · {platformCapabilities?.label ?? info?.platform ?? 'linux'} · MIT
                </span>
              </div>

              {platformCapabilities ? (
                <div className="settings-group" data-testid="about-platform-capabilities">
                  <div className="settings-group-head">
                    <span className="settings-group-title">平台能力</span>
                  </div>
                  <div className="settings-field">
                    <span className="settings-label">平台</span>
                    <span
                      className="settings-value settings-value--wide"
                      data-testid="about-platform-label"
                    >
                      {platformCapabilities.label}
                    </span>
                  </div>
                  {capabilityRows.map((row) => (
                    <div className="settings-field" key={row.key}>
                      <span className="settings-label">{row.label}</span>
                      <span
                        className={`settings-status ${
                          row.status.state === 'available'
                            ? 'settings-status--ok'
                            : 'settings-status--warn'
                        }`}
                        data-testid={`about-capability-${row.key}`}
                      >
                        {row.status.state === 'available'
                          ? '可用'
                          : row.status.state === 'degraded'
                            ? '受限'
                            : '不支持'}
                        {row.status.reason ? ` · ${row.status.reason}` : ''}
                      </span>
                    </div>
                  ))}
                </div>
              ) : null}
              <div className="settings-field">
                <span className="settings-label">日志目录</span>
                <code className="settings-path" data-testid="about-log-path">
                  {paths?.logsDir ?? '—'}
                </code>
              </div>
              <div className="settings-field">
                <span className="settings-label">数据目录</span>
                <code className="settings-path" data-testid="about-data-path">
                  {paths?.dataDir ?? '—'}
                </code>
              </div>

              <div className="settings-actions">
                <button
                  type="button"
                  className="settings-button"
                  data-testid="about-open-logs"
                  onClick={() => openLocalPath('logs', '日志')}
                >
                  打开日志
                </button>
                <button
                  type="button"
                  className="settings-button"
                  data-testid="about-open-data"
                  onClick={() => openLocalPath('data', '数据')}
                >
                  打开数据目录
                </button>
              </div>
              {pathNote ? (
                <p className="settings-help" data-testid="about-path-note">
                  {pathNote}
                </p>
              ) : null}

              <div className="settings-group">
                <div className="settings-group-head">
                  <span className="settings-group-title">最近日志（只读）</span>
                  <button
                    type="button"
                    className="settings-link"
                    data-testid="about-log-refresh"
                    onClick={refreshLogs}
                  >
                    刷新
                  </button>
                </div>
                {logError ? (
                  <p className="settings-error" data-testid="about-log-error">
                    {logError}
                  </p>
                ) : null}
                <pre
                  className="settings-log"
                  data-testid="about-log-content"
                  data-truncated={logTruncated ? '1' : '0'}
                  data-bytes={logBytes}
                >
                  {logContent || '（暂无日志）'}
                </pre>
                {logTruncated ? (
                  <p className="settings-help" data-testid="about-log-truncated">
                    仅显示末尾 {logBytes} 字节（上限 64KB），已脱敏。
                  </p>
                ) : null}
              </div>
            </section>
          ) : onboarding ? (
            <section className="settings-section" data-testid="onboarding-wizard">
              <h2 className="settings-title">首次设置</h2>
              <p className="settings-subtitle">
                完成连接、密钥与模型测试后即可开始使用。测试前不会发起任何请求。
              </p>

              <div className="settings-steps" data-testid="onboarding-steps">
                {([1, 2, 3] as const).map((step) => (
                  <span
                    key={step}
                    className={`settings-step${
                      onboardingStep === step ? ' settings-step--active' : ''
                    }${onboardingStep > step ? ' settings-step--done' : ''}`}
                  >
                    {step === 1 ? '连接' : step === 2 ? '密钥' : '模型/测试'}
                  </span>
                ))}
              </div>

              {onboardingDone ? (
                <div className="settings-success" data-testid="onboarding-done">
                  <p>配置完成，可以开始提问了。</p>
                  {testOutcome ? (
                    <p
                      className="settings-test-result settings-test-result--ok"
                      data-testid="model-test-result"
                    >
                      {testOutcome.message}
                      {testOutcome.latencyMs !== undefined
                        ? ` · ${testOutcome.latencyMs}ms`
                        : ''}
                    </p>
                  ) : null}
                  <button
                    type="button"
                    className="settings-button settings-button--primary"
                    onClick={() => void api?.window.closeSettings()}
                  >
                    关闭设置
                  </button>
                </div>
              ) : (
                <>
                  {renderModelFields(true)}
                  {formError ? (
                    <p className="settings-error" data-testid="onboarding-error">
                      {formError}
                    </p>
                  ) : null}
                  {testOutcome ? (
                    <div
                      className={`settings-test-result${
                        testOutcome.ok
                          ? ' settings-test-result--ok'
                          : ' settings-test-result--error'
                      }`}
                      data-testid="model-test-result"
                    >
                      <strong>{testOutcome.message}</strong>
                      {testOutcome.latencyMs !== undefined ? (
                        <span> · {testOutcome.latencyMs}ms</span>
                      ) : null}
                      {testOutcome.models && testOutcome.models.length > 0 ? (
                        <div className="settings-models" data-testid="model-list">
                          {testOutcome.models.slice(0, 20).join('、')}
                        </div>
                      ) : null}
                    </div>
                  ) : null}

                  <div className="settings-actions">
                    {onboardingStep > 1 ? (
                      <button
                        type="button"
                        className="settings-button"
                        data-testid="onboarding-back"
                        onClick={backStep}
                      >
                        上一步
                      </button>
                    ) : null}
                    {onboardingStep < 3 ? (
                      <button
                        type="button"
                        className="settings-button settings-button--primary"
                        data-testid="onboarding-next"
                        onClick={nextStep}
                      >
                        下一步
                      </button>
                    ) : (
                      <button
                        type="button"
                        className="settings-button settings-button--primary"
                        data-testid="onboarding-test"
                        disabled={!canTest}
                        onClick={() => void testConnection()}
                      >
                        {testing ? '测试中…' : '测试连接'}
                      </button>
                    )}
                  </div>
                </>
              )}
            </section>
          ) : (
            <section className="settings-section settings-section--model" data-testid="model-panel">
              <div className="settings-model-layout">
                <aside className="settings-profile-list" data-testid="model-profile-list">
                  <div className="settings-group-head">
                    <span className="settings-group-title">模型配置</span>
                    <button
                      type="button"
                      className="settings-link"
                      data-testid="model-new"
                      onClick={() => void startNewProfile()}
                    >
                      + 新建
                    </button>
                  </div>
                  {profiles.length === 0 ? (
                    <p className="settings-empty">尚无配置</p>
                  ) : (
                    profiles.map((profile) => {
                      const active = profile.id === selectedId
                      return (
                        <button
                          key={profile.id}
                          type="button"
                          className={`settings-profile${
                            active ? ' settings-profile--active' : ''
                          }`}
                          data-testid={`model-profile-${profile.id}`}
                          aria-current={active ? 'true' : undefined}
                          onClick={() => void selectProfile(profile.id)}
                        >
                          <span className="settings-profile-name">{profile.name}</span>
                          <span className="settings-profile-model">{profile.model}</span>
                          {profile.isDefault ? (
                            <span
                              className="settings-profile-default"
                              data-testid={`model-default-marker-${profile.id}`}
                            >
                              默认
                            </span>
                          ) : null}
                        </button>
                      )
                    })
                  )}
                </aside>

                <div className="settings-form" data-testid="model-form">
                  <h2 className="settings-title">模型</h2>
                  <p className="settings-subtitle">改动即时生效；密钥只写不读。</p>
                  {renderModelFields(false)}

                  {formError ? (
                    <p className="settings-error" data-testid="model-error">
                      {formError}
                    </p>
                  ) : null}

                  {testOutcome ? (
                    <div
                      className={`settings-test-result${
                        testOutcome.ok
                          ? ' settings-test-result--ok'
                          : ' settings-test-result--error'
                      }`}
                      data-testid="model-test-result"
                    >
                      <strong>{testOutcome.message}</strong>
                      {testOutcome.latencyMs !== undefined ? (
                        <span> · {testOutcome.latencyMs}ms</span>
                      ) : null}
                      {testOutcome.models && testOutcome.models.length > 0 ? (
                        <div className="settings-models" data-testid="model-list">
                          {testOutcome.models.slice(0, 20).join('、')}
                        </div>
                      ) : null}
                    </div>
                  ) : null}

                  <div className="settings-actions">
                    <button
                      type="button"
                      className="settings-button settings-button--primary"
                      data-testid="model-test"
                      disabled={!canTest}
                      onClick={() => void testConnection()}
                    >
                      {testing ? '测试中…' : '测试连接'}
                    </button>
                    <button
                      type="button"
                      className="settings-button"
                      data-testid="model-default"
                      disabled={selectedId === null}
                      onClick={() => void makeDefaultProfile()}
                    >
                      设为默认
                    </button>
                    <button
                      type="button"
                      className="settings-button settings-button--danger"
                      data-testid="model-delete"
                      disabled={selectedId === null}
                      onClick={() => setDeleteConfirm(true)}
                    >
                      删除
                    </button>
                    <span className="settings-save-state" data-testid="model-save-state">
                      {saving ? '保存中…' : (saveNote ?? '')}
                    </span>
                  </div>

                  {deleteConfirm ? (
                    <div className="settings-confirm" data-testid="model-delete-confirm-panel">
                      <p className="settings-error">
                        删除后无法恢复，密钥也会从系统钥匙串移除。
                      </p>
                      <div className="settings-actions">
                        <button
                          type="button"
                          className="settings-button"
                          data-testid="model-delete-cancel"
                          onClick={() => setDeleteConfirm(false)}
                        >
                          取消
                        </button>
                        <button
                          type="button"
                          className="settings-button settings-button--danger"
                          data-testid="model-delete-confirm"
                          onClick={() => void deleteSelectedProfile()}
                        >
                          确认删除
                        </button>
                      </div>
                    </div>
                  ) : null}

                  <details className="settings-details">
                    <summary>当前状态</summary>
                    <p>
                      凭据：{activeProfile?.hasApiKey ? '已配置' : '未配置'} · 默认：
                      {activeProfile?.isDefault ? '是' : '否'} · keyring：
                      {info ? '已连接' : '未知'}
                    </p>
                  </details>
                </div>
              </div>
            </section>
          )}
        </div>

        <footer className="settings-footer">
          <button
            type="button"
            className="settings-button"
            data-testid="settings-close"
            onClick={() => void api?.window.closeSettings()}
          >
            关闭
          </button>
        </footer>
      </div>
    </main>
  )
}
