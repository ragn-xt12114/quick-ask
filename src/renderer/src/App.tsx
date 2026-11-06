import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type CSSProperties
} from 'react'
import type {
  AppearanceRuntimeState,
  BootstrapInfo,
  ChatImage,
  HotkeyStatus,
  MainWindowMode,
  ProviderProfileView,
  UiAppearanceEvent,
  UiNoticeEvent,
  UiStateEvent,
  WindowLayout
} from '../../shared/channels'
import {
  DEFAULT_APPEARANCE,
  DEFAULT_BEHAVIOR,
  SETTINGS_KEYS,
  normalizeAppearance,
  normalizeSettings,
  type AppearanceSettings,
  type BehaviorSettings
} from '../../shared/settings'
import { Bar } from './components/Bar'
import { CodeBlock } from './components/CodeBlock'
import type { ComposerNotice } from './components/Composer'
import { MessageList } from './components/MessageList'
import {
  AssistantMessage,
  DataTable,
  PanelShell,
  UserMessage
} from './components/PanelShell'
import { HistorySidebar } from './components/HistorySidebar'
import { SettingsWindow } from './components/SettingsWindow'
import { useChat } from './hooks/useChat'
import { applyAppearance, runtimeFromSignals } from './lib/appearance'

const visualMode = new URLSearchParams(window.location.search).get('visual') === '1'
const settingsMode = new URLSearchParams(window.location.search).get('settings') === '1'
const onboardingMode =
  settingsMode && new URLSearchParams(window.location.search).get('onboarding') === '1'
if (settingsMode) document.title = 'QuickAsk 设置'
if (visualMode) document.documentElement.dataset['visual'] = '1'

const DRAFT_DEBOUNCE_MS = 300
const CLIPBOARD_TIMEOUT_MS = 800
const CLIPBOARD_MIN_CHARS = 1
const CLIPBOARD_MAX_CHARS = 2000
const NOTICE_DISMISS_MS = 4000
const PANEL_EMPTY_HEIGHT = 120
const PANEL_HEIGHT_LIMIT = 420

function rectStyle(rect: { x: number; y: number; width: number; height: number }): CSSProperties {
  return {
    left: `${rect.x}px`,
    top: `${rect.y}px`,
    width: `${rect.width}px`,
    height: `${rect.height}px`
  }
}

interface ClickScope {
  __quickaskClickCount?: number
}

function noticeFromHotkey(status: HotkeyStatus | undefined): UiNoticeEvent | null {
  if (!status) return null
  if (!status.registered) {
    return {
      level: 'error',
      code: 'HOTKEY_REGISTER_FAILED',
      message: `${status.primary} 及备选（${status.alternatives.join('、')}）均注册失败。可从托盘菜单使用，或释放快捷键后重试。`
    }
  }
  if (status.accelerator && status.accelerator !== status.primary) {
    return {
      level: 'warning',
      code: 'HOTKEY_FALLBACK_REGISTERED',
      message: `主快捷键 ${status.primary} 被占用，已改用 ${status.accelerator}。`
    }
  }
  return null
}

const SAMPLE_CODE = `const order = ['history', 'expand', 'new']
const bar = { height: 48, radius: 24, gap: 12 }`

const SAMPLE_TABLE_HEADERS = ['区域', '尺寸', '状态']
const SAMPLE_TABLE_ROWS = [
  ['胶囊条', '680 × 48', '已定稿'],
  ['历史栏', '260 × 480', '静态占位']
]

function StaticConversation({ style }: { style?: CSSProperties }) {
  return (
    <PanelShell
      style={style}
      title="示例会话 · 设计讨论"
      model="deepseek-chat"
      empty={false}
    >
      <UserMessage>帮我确认一下顶部胶囊条的按钮顺序和尺寸。</UserMessage>
      <AssistantMessage>
        <p>
          顺序固定为：历史 → 展开对话 → 新建，最右侧是 36px 圆形发送按钮。条高 48，
          圆角 24，卡片之间留 12px 间隙。
        </p>
        <CodeBlock code={SAMPLE_CODE} language="ts" />
        <p>面板内不设输入框，输入永远只在顶部胶囊条里。</p>
        <DataTable headers={SAMPLE_TABLE_HEADERS} rows={SAMPLE_TABLE_ROWS} />
      </AssistantMessage>
    </PanelShell>
  )
}

export default function App() {
  const [mode, setMode] = useState<MainWindowMode>('S0')
  const [layout, setLayout] = useState<WindowLayout | null>(null)
  const [barLines, setBarLines] = useState(1)
  const [panelHeight, setPanelHeight] = useState(PANEL_EMPTY_HEIGHT)
  const [scaleFactor, setScaleFactor] = useState(1)
  const [info, setInfo] = useState<BootstrapInfo | null>(null)
  const [appearance, setAppearance] = useState<AppearanceSettings>({
    ...DEFAULT_APPEARANCE
  })
  const [appearanceRuntime, setAppearanceRuntime] = useState<AppearanceRuntimeState>(
    runtimeFromSignals(null, null, null)
  )
  const [behavior, setBehavior] = useState<BehaviorSettings>({ ...DEFAULT_BEHAVIOR })
  const [onboardingRequired, setOnboardingRequired] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [text, setText] = useState('')
  const [composerNotice, setComposerNotice] = useState<ComposerNotice | null>(null)
  const [clipboardHint, setClipboardHint] = useState<string | null>(null)
  /** Clipboard images waiting in the composer; cleared on send/new session. */
  const [images, setImages] = useState<ChatImage[]>([])
  const [clicks, setClicks] = useState(0)
  const [notice, setNotice] = useState<UiNoticeEvent | null>(null)
  const [panelContentHeight, setPanelContentHeight] = useState(0)
  const [profiles, setProfiles] = useState<ProviderProfileView[]>([])
  const [selectedProfileId, setSelectedProfileId] = useState<string | null>(null)

  const chat = useChat(!visualMode && !settingsMode)
  const sessionId = chat.sessionId
  const {
    retry: retryChat,
    regenerate: regenerateChat,
    clearSession: clearChatSession,
    loadSession: loadChatSession
  } = chat

  const textRef = useRef(text)
  const imagesRef = useRef<ChatImage[]>([])
  const handleImagesChange = useCallback((next: ChatImage[]): void => {
    imagesRef.current = next
    setImages(next)
  }, [])
  const sessionIdRef = useRef<string | null>(sessionId)
  const visibleRef = useRef(false)
  const previousVisibleRef = useRef(false)
  const draftKeyRef = useRef<string | null>(null)
  const suppressDraftWriteRef = useRef(false)
  const clipboardDismissedRef = useRef<string | null>(null)
  const clipboardTokenRef = useRef(0)
  const sendingRef = useRef(false)
  const lastPanelRequestRef = useRef<number | null>(null)
  const startNewSessionRef = useRef<() => void>(() => undefined)
  const behaviorRef = useRef(behavior)
  const selectedProfileIdRef = useRef<string | null>(selectedProfileId)

  textRef.current = text
  sessionIdRef.current = sessionId
  behaviorRef.current = behavior
  selectedProfileIdRef.current = selectedProfileId

  const visible = mode !== 'S0' && layout !== null

  const loadProfiles = useCallback(async (): Promise<void> => {
    const api = window.quickask
    if (!api) return
    const result = await api.provider.list()
    if (!result.ok) return
    const list = result.data.profiles
    setProfiles(list)
    const current = selectedProfileIdRef.current
    if (current !== null && list.some((profile) => profile.id === current)) return
    const fallback = list.find((profile) => profile.isDefault) ?? list[0] ?? null
    selectedProfileIdRef.current = fallback?.id ?? null
    setSelectedProfileId(fallback?.id ?? null)
  }, [])

  const selectModelProfile = useCallback((id: string): void => {
    selectedProfileIdRef.current = id
    setSelectedProfileId(id)
    const api = window.quickask
    if (api) {
      void api.settings.set({ key: SETTINGS_KEYS.model, value: { profileId: id } })
    }
  }, [])

  const refreshClipboard = useCallback(() => {
    if (visualMode || settingsMode) return
    const api = window.quickask
    if (!api) return

    const token = clipboardTokenRef.current + 1
    clipboardTokenRef.current = token
    let settled = false
    const timer = window.setTimeout(() => {
      if (settled) return
      settled = true
      if (clipboardTokenRef.current === token) {
        clipboardTokenRef.current += 1
        setClipboardHint(null)
      }
    }, CLIPBOARD_TIMEOUT_MS)

    void api.clipboard
      .readText()
      .then((result) => {
        if (settled) return
        settled = true
        window.clearTimeout(timer)
        if (clipboardTokenRef.current !== token) return
        if (!result.ok) {
          setClipboardHint(null)
          return
        }

        const hint = result.data.text.trim()
        if (
          hint.length < CLIPBOARD_MIN_CHARS ||
          hint.length > CLIPBOARD_MAX_CHARS ||
          hint === clipboardDismissedRef.current ||
          hint === textRef.current.trim()
        ) {
          setClipboardHint(null)
          return
        }

        setClipboardHint((current) => (current === hint ? current : hint))
      })
      .catch(() => {
        if (settled) return
        settled = true
        window.clearTimeout(timer)
        if (clipboardTokenRef.current === token) setClipboardHint(null)
      })
  }, [])

  useEffect(() => {
    const scope = window as unknown as ClickScope
    const onClick = (): void => {
      scope.__quickaskClickCount = (scope.__quickaskClickCount ?? 0) + 1
      setClicks((value) => value + 1)
    }
    document.addEventListener('pointerdown', onClick, true)
    return () => document.removeEventListener('pointerdown', onClick, true)
  }, [])

  useEffect(() => {
    if (settingsMode) return
    applyAppearance(appearance, appearanceRuntime)
    const light = window.matchMedia('(prefers-color-scheme: light)')
    const reduced = window.matchMedia('(prefers-reduced-motion: reduce)')
    const onChange = (): void => applyAppearance(appearance, appearanceRuntime)
    light.addEventListener('change', onChange)
    reduced.addEventListener('change', onChange)
    return () => {
      light.removeEventListener('change', onChange)
      reduced.removeEventListener('change', onChange)
    }
  }, [appearance, appearanceRuntime])

  useEffect(() => {
    if (settingsMode) return
    const onEscape = (event: KeyboardEvent): void => {
      if (event.key !== 'Escape') return
      if (event.isComposing || event.keyCode === 229) return
      if (behaviorRef.current.escDirectHide) {
        event.preventDefault()
        event.stopPropagation()
        void window.quickask?.window.hide()
      } else if (mode === 'S3') {
        event.preventDefault()
        event.stopPropagation()
        void window.quickask?.window.setMode('S2')
      } else if (mode === 'S2') {
        event.preventDefault()
        event.stopPropagation()
        void window.quickask?.window.setMode('S1')
      } else if (mode === 'S1') {
        event.preventDefault()
        event.stopPropagation()
        void window.quickask?.window.hide()
      }
    }
    window.addEventListener('keydown', onEscape, true)
    return () => window.removeEventListener('keydown', onEscape, true)
  }, [mode])

  useEffect(() => {
    if (settingsMode || visualMode) return
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.isComposing || event.keyCode === 229) return
      if (!(event.ctrlKey || event.metaKey)) return
      const key = event.key.toLowerCase()

      if (key === 'n') {
        event.preventDefault()
        event.stopPropagation()
        startNewSessionRef.current()
        return
      }
      if (key === 'h') {
        event.preventDefault()
        event.stopPropagation()
        void window.quickask?.window.setMode(mode === 'S3' ? 'S2' : 'S3')
        return
      }
      if (event.key === ',') {
        event.preventDefault()
        void window.quickask?.window.openSettings()
      }
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [mode])

  useEffect(() => {
    if (settingsMode) return
    const api = window.quickask
    if (!api) return

    const key = sessionId ?? 'new'
    const startedText = textRef.current
    let cancelled = false
    draftKeyRef.current = null

    void api.drafts.get({ sessionId: key }).then((result) => {
      if (cancelled) return
      const loaded = result.ok ? result.data.text : ''
      draftKeyRef.current = key
      if (textRef.current !== startedText) return
      if (loaded !== textRef.current) {
        suppressDraftWriteRef.current = true
        setText(loaded)
      }
    })

    return () => {
      cancelled = true
    }
  }, [sessionId])

  useEffect(() => {
    if (settingsMode) return
    const api = window.quickask
    if (!api) return
    const key = sessionId ?? 'new'
    if (draftKeyRef.current !== key) return
    if (suppressDraftWriteRef.current) {
      suppressDraftWriteRef.current = false
      return
    }

    const timer = window.setTimeout(() => {
      void api.drafts.set({ sessionId: key, text })
    }, DRAFT_DEBOUNCE_MS)

    return () => window.clearTimeout(timer)
  }, [text, sessionId])

  useEffect(() => {
    const wasVisible = previousVisibleRef.current
    previousVisibleRef.current = visible
    visibleRef.current = visible
    if (settingsMode) return
    const api = window.quickask
    if (!api) return

    const key = sessionId ?? 'new'
    if (!visible) {
      if (wasVisible && draftKeyRef.current === key) {
        void api.drafts.set({ sessionId: key, text: textRef.current })
      }
      return
    }

    refreshClipboard()
    if (draftKeyRef.current === key && textRef.current.length === 0) {
      void api.drafts.get({ sessionId: key }).then((result) => {
        if (!result.ok || result.data.text.length === 0) return
        if (textRef.current.length > 0) return
        suppressDraftWriteRef.current = true
        setText(result.data.text)
      })
    }
  }, [visible, sessionId, refreshClipboard])

  useEffect(() => {
    if (settingsMode) return
    const onFocus = (): void => {
      if (visibleRef.current) refreshClipboard()
    }
    window.addEventListener('focus', onFocus)
    return () => window.removeEventListener('focus', onFocus)
  }, [refreshClipboard])

  useEffect(() => {
    if (!composerNotice) return
    const timer = window.setTimeout(() => setComposerNotice(null), NOTICE_DISMISS_MS)
    return () => window.clearTimeout(timer)
  }, [composerNotice])

  const send = useCallback((): void => {
    const api = window.quickask
    if (!api || sendingRef.current || onboardingRequired) return
    const currentText = textRef.current
    const currentImages = imagesRef.current
    if (currentText.trim().length === 0 && currentImages.length === 0) return

    const previousKey = sessionIdRef.current ?? 'new'
    sendingRef.current = true

    void (async () => {
      try {
        const outcome = await chat.send(currentText, currentImages)
        if (!outcome.ok) {
          setComposerNotice({
            level: 'error',
            message: outcome.message ?? '发送失败，请稍后重试'
          })
          return
        }

        void api.drafts.set({ sessionId: previousKey, text: '' })
        setText('')
        setClipboardHint(null)
        imagesRef.current = []
        setImages([])
        setComposerNotice(null)

        try {
          await api.window.setHeight({ barLines: 1 })
        } catch {
          // geometry is best-effort; the composer effect also reports line 1
        }
      } catch {
        setComposerNotice({ level: 'error', message: '发送失败，请稍后重试' })
      } finally {
        sendingRef.current = false
      }
    })()
  }, [chat, onboardingRequired])

  const handleChange = useCallback(
    (next: string): void => {
      setText(next)
      if (clipboardHint && next.trim() === clipboardHint) {
        clipboardDismissedRef.current = clipboardHint
        setClipboardHint(null)
      }
    },
    [clipboardHint]
  )

  const consumeClipboard = useCallback((): void => {
    setClipboardHint((current) => {
      if (current) clipboardDismissedRef.current = current
      return null
    })
  }, [])

  const flushDraftNow = useCallback((): void => {
    const api = window.quickask
    if (!api) return
    if (draftKeyRef.current === null) return
    const key = sessionIdRef.current ?? 'new'
    void api.drafts.set({ sessionId: key, text: textRef.current })
  }, [])

  const focusComposer = useCallback((): void => {
    window.requestAnimationFrame(() => {
      const composer = document.querySelector(
        '[data-testid="composer"]'
      ) as HTMLTextAreaElement | null
      composer?.focus()
    })
  }, [])

  /**
   * F-06: clear context/draft, abort+finalize an active stream first, return
   * to S1 and focus the composer. Never creates a DB session — the first
   * message does that on send (no empty records).
   */
  const startNewSession = useCallback((): void => {
    const api = window.quickask
    if (sessionIdRef.current !== null) flushDraftNow()
    textRef.current = ''
    setText('')
    setClipboardHint(null)
    imagesRef.current = []
    setImages([])
    void (async () => {
      // Clear the `new` draft before sessionId flips to null so the draft
      // hydration effect cannot resurrect the previous empty-session draft.
      if (api) await api.drafts.set({ sessionId: 'new', text: '' })
      await clearChatSession()
      focusComposer()
    })()
  }, [clearChatSession, flushDraftNow, focusComposer])
  startNewSessionRef.current = startNewSession

  const openHistorySession = useCallback(
    (id: string): void => {
      const api = window.quickask
      void (async () => {
        if (sessionId === id) {
          if (api) await api.window.setMode('S2')
          focusComposer()
          return
        }
        flushDraftNow()
        await loadChatSession(id)
        focusComposer()
      })()
    },
    [flushDraftNow, focusComposer, loadChatSession, sessionId]
  )

  const deleteCurrentSession = useCallback(
    async (id: string): Promise<boolean> => {
      const api = window.quickask
      if (!api) return false
      if (sessionIdRef.current !== null) flushDraftNow()
      // Main aborts+persists the active stream, removes the current session
      // (cascade) and resets its state to null/S1 before this resolves.
      const result = await api.sessions.delete({ id })
      if (!result.ok || !result.data.deleted) return false
      textRef.current = ''
      setText('')
      setClipboardHint(null)
      await api.drafts.set({ sessionId: 'new', text: '' })
      await clearChatSession()
      focusComposer()
      return true
    },
    [clearChatSession, flushDraftNow, focusComposer]
  )

  useEffect(() => {
    if (!visible || visualMode || settingsMode) return
    if (mode !== 'S1' && mode !== 'S2') return
    focusComposer()
  }, [focusComposer, mode, visible])

  const handleContentHeight = useCallback((height: number): void => {
    setPanelContentHeight((current) => (current === height ? current : height))
  }, [])

  const handleRetryMessage = useCallback(
    (messageId: string): void => {
      void retryChat(messageId)
    },
    [retryChat]
  )

  const handleRegenerateMessage = useCallback(
    (messageId: string): void => {
      void regenerateChat(messageId)
    },
    [regenerateChat]
  )

  useLayoutEffect(() => {
    if (!visible || !layout?.panelRect || visualMode || settingsMode) return
    const api = window.quickask
    if (!api) return

    const panel = document.querySelector('[data-testid="panel"]') as HTMLElement | null
    if (!panel) return
    if (panel.querySelector('[data-testid="panel-empty"]')) {
      if (lastPanelRequestRef.current !== PANEL_EMPTY_HEIGHT) {
        lastPanelRequestRef.current = PANEL_EMPTY_HEIGHT
        void api.window.setHeight({ panelHeight: PANEL_EMPTY_HEIGHT }).catch(() => undefined)
      }
      return
    }

    const panelStyle = getComputedStyle(panel)
    const padding =
      Number.parseFloat(panelStyle.paddingTop) +
      Number.parseFloat(panelStyle.paddingBottom)
    const infoRow = panel.querySelector('.qa-panel-info') as HTMLElement | null
    const body = panel.querySelector('.qa-panel-body') as HTMLElement | null
    const content = panel.querySelector('[data-testid="panel-content"]') as HTMLElement | null
    const errorBar = panel.querySelector('[data-testid="panel-error"]') as HTMLElement | null
    const bodyMargin = body ? Number.parseFloat(getComputedStyle(body).marginTop) : 0
    const contentHeight = content?.scrollHeight ?? panelContentHeight
    const errorHeight = errorBar
      ? errorBar.offsetHeight + Number.parseFloat(getComputedStyle(errorBar).marginTop)
      : 0
    const target = Math.min(
      PANEL_HEIGHT_LIMIT,
      Math.max(
        PANEL_EMPTY_HEIGHT,
        Math.round(
          padding + (infoRow?.offsetHeight ?? 0) + bodyMargin + contentHeight + errorHeight
        )
      )
    )
    if (lastPanelRequestRef.current === target) return
    lastPanelRequestRef.current = target
    void api.window.setHeight({ panelHeight: target }).catch(() => undefined)
  }, [
    visible,
    layout,
    panelContentHeight,
    chat.messages.length,
    chat.panelError,
    chat.streaming
  ])

  useEffect(() => {
    if (settingsMode) return
    const api = window.quickask
    if (!api) {
      setError('preload API unavailable')
      return
    }

    let active = true
    const applyState = (event: UiStateEvent): void => {
      setMode(event.mode)
      setLayout(event.layout)
      setBarLines(event.barLines)
      setPanelHeight(event.panelHeight)
      setScaleFactor(event.scaleFactor)
    }

    const unsubscribe = api.window.onState((event) => {
      if (active) applyState(event)
    })

    const unsubscribeNotice = api.app.onNotice((event) => {
      if (active) setNotice(event)
    })

    const unsubscribeNewSession = api.app.onNewSession(() => {
      if (!active) return
      startNewSession()
    })

    const unsubscribeAppearance = api.app.onAppearance((event: UiAppearanceEvent) => {
      if (!active) return
      setAppearance(normalizeAppearance(event))
      setAppearanceRuntime(
        runtimeFromSignals(
          event.blurStatus,
          event.opaqueMode,
          event.animationDurationFactor
        )
      )
    })

    const unsubscribeOnboarding = api.app.onOnboarding((event) => {
      if (active) setOnboardingRequired(event.required)
    })

    const unsubscribeSettings = api.app.onSettings((event) => {
      if (!active) return
      setBehavior({ ...event.settings.behavior })
      const profileId = event.settings.model.profileId
      selectedProfileIdRef.current = profileId
      setSelectedProfileId(profileId)
      void loadProfiles()
    })

    void loadProfiles()
    void api.settings.getAll().then((result) => {
      if (!active || !result.ok) return
      const profileId = normalizeSettings(result.data.settings).model.profileId
      if (profileId === null) return
      selectedProfileIdRef.current = profileId
      setSelectedProfileId(profileId)
    })

    void api.window.getState().then((result) => {
      if (!active) return
      if (result.ok) {
        setMode(result.data.mode)
        setLayout(result.data.layout)
        setScaleFactor(result.data.display.scaleFactor)
        if (result.data.layout?.panelRect) {
          setPanelHeight(result.data.layout.panelRect.height)
        }
      } else {
        setError(`${result.error.code}: ${result.error.message}`)
      }
    })

    void api.app.bootstrap().then((result) => {
      if (!active) return
      if (result.ok) {
        setInfo(result.data)
        setAppearance(normalizeAppearance(result.data.appearance))
        setAppearanceRuntime(
          runtimeFromSignals(
            result.data.blurStatus,
            result.data.opaqueMode,
            result.data.animationDurationFactor
          )
        )
        setOnboardingRequired(result.data.onboarding.required)
        setBehavior({ ...result.data.settings.behavior })
        const derived = noticeFromHotkey(result.data.hotkey)
        if (derived) setNotice((current) => current ?? derived)
      } else {
        setError(`${result.error.code}: ${result.error.message}`)
      }
    })

    return () => {
      active = false
      unsubscribe()
      unsubscribeNotice()
      unsubscribeNewSession()
      unsubscribeAppearance()
      unsubscribeOnboarding()
      unsubscribeSettings()
    }
  }, [loadProfiles, startNewSession])

  if (settingsMode) {
    return <SettingsWindow onboarding={onboardingMode} />
  }

  const api = window.quickask
  const hasMessages = mode === 'S2' || mode === 'S3'
  const displayedProfile =
    profiles.find((profile) => profile.id === selectedProfileId) ??
    profiles.find((profile) => profile.isDefault) ??
    profiles[0] ??
    null
  const displayedModel = displayedProfile?.model ?? chat.model
  const panelError = chat.panelError
    ? {
        message: chat.panelError.message,
        retryLabel: '重试',
        onRetry: chat.panelError.retry ?? undefined
      }
    : null

  return (
    <div
      className="app-root"
      data-testid="app-root"
      data-ui-mode={mode}
      data-scale-factor={scaleFactor}
      data-opaque={appearanceRuntime.opaqueMode ? '1' : '0'}
      data-reduced-motion={appearanceRuntime.animationDurationFactor <= 0 ? '1' : '0'}
      data-visual={visualMode ? '1' : undefined}
    >
      {notice ? (
        <div
          className={`notice notice-${notice.level}`}
          data-testid="notice"
          data-notice-code={notice.code}
          role="alert"
        >
          <span className="notice-text">{notice.message}</span>
          <button
            type="button"
            className="notice-dismiss no-drag"
            data-testid="notice-dismiss"
            aria-label="关闭提示"
            onClick={() => setNotice(null)}
          >
            ×
          </button>
        </div>
      ) : null}

      {visible ? (
        <>
          {layout.sidebarRect ? (
            <HistorySidebar
              style={rectStyle(layout.sidebarRect)}
              currentSessionId={sessionId}
              visual={visualMode}
              onNew={startNewSession}
              onSelect={openHistorySession}
              onDeleteCurrent={deleteCurrentSession}
              onOpenSettings={() => void api.window.openSettings()}
            />
          ) : null}

          {layout.panelRect ? (
            visualMode ? (
              <StaticConversation style={rectStyle(layout.panelRect)} />
            ) : (
              <PanelShell
                style={rectStyle(layout.panelRect)}
                title={chat.messages.length > 0 ? chat.title : '新会话'}
                model={displayedModel}
                modelOptions={profiles}
                selectedProfileId={displayedProfile?.id ?? selectedProfileId}
                onSelectModel={selectModelProfile}
                streaming={chat.streaming}
                empty={chat.messages.length === 0 && !chat.streaming}
                error={panelError}
                onStop={() => void chat.stop()}
              >
                {chat.messages.length > 0 || chat.streaming ? (
                  <MessageList
                    messages={chat.messages}
                    streaming={chat.streaming}
                    onRetry={handleRetryMessage}
                    onRegenerate={handleRegenerateMessage}
                    onContentHeight={handleContentHeight}
                  />
                ) : null}
              </PanelShell>
            )
          ) : null}

          <Bar
            style={rectStyle(layout.barRect)}
            value={text}
            onChange={handleChange}
            onSend={send}
            onHistory={() => void api.window.setMode('S3')}
            onExpand={() => void api.window.setMode('S2')}
            onNew={startNewSession}
            hasMessages={hasMessages}
            expanded={mode === 'S2' || mode === 'S3'}
            clipboardHint={visualMode ? null : clipboardHint}
            onConsumeClipboard={consumeClipboard}
            notice={composerNotice}
            onNotice={setComposerNotice}
            images={images}
            onImagesChange={handleImagesChange}
            inputDisabled={onboardingRequired}
            placeholder={onboardingRequired ? '请先配置模型' : '问点什么…'}
          />
        </>
      ) : null}

      <div className="click-counter" data-testid="click-counter">
        {clicks}
      </div>
      <div className="debug-meta" data-testid="debug-meta" hidden>
        {info ? `${info.version}/${barLines}/${panelHeight}` : (error ?? '')}
      </div>
    </div>
  )
}
