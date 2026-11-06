import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type {
  ChatDeltaEvent,
  ChatEndEvent,
  ChatImage,
  ChatMessage,
  MainWindowMode,
  MessageStatus,
  SessionsStateResult,
  UiSessionEvent
} from '../../../shared/channels'
import {
  interruptedMessage,
  stoppedMessage,
  uiErrorMessage
} from '../lib/errorText'

export interface ChatUiMessage {
  id: string
  messageId: string | null
  role: 'user' | 'assistant'
  content: string
  /** Clipboard images attached to a user turn (empty for assistant rows). */
  images?: ChatImage[]
  status: MessageStatus
  errorCode: string | null
  errorDetail: string | null
  model: string | null
  requestId: string | null
  seq: number | null
  createdAt: number
}

export interface ChatSendOutcome {
  ok: boolean
  sessionId?: string
  message?: string
}

export interface ChatPanelError {
  message: string
  retry: (() => void) | null
}

export interface UseChatResult {
  messages: ChatUiMessage[]
  sessionId: string | null
  sessionMode: MainWindowMode
  title: string
  model: string | null
  streaming: boolean
  activeRequestId: string | null
  panelError: ChatPanelError | null
  send(text: string, images?: ChatImage[]): Promise<ChatSendOutcome>
  stop(): Promise<void>
  retry(messageId: string): Promise<void>
  regenerate(messageId: string): Promise<void>
  loadSession(sessionId: string): Promise<void>
  clearSession(): Promise<void>
  syncSessionState(): Promise<void>
  reset(): void
  clearError(): void
}

const FLUSH_INTERVAL_MS = 34
const RETRYABLE: ReadonlySet<MessageStatus> = new Set(['error', 'stopped', 'interrupted'])

let localCounter = 0
function newLocalId(role: string): string {
  localCounter += 1
  return `local-${role}-${Date.now()}-${localCounter}`
}

function deriveTitle(text: string): string {
  const stripped = text
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/[`*_~>#]+/g, '')
    .replace(/\s+/g, ' ')
    .trim()
  const title = Array.from(stripped).slice(0, 20).join('').trim()
  return title.length > 0 ? title : '新会话'
}

function fromDbMessage(message: ChatMessage): ChatUiMessage | null {
  if (message.role === 'system') return null
  return {
    id: message.id,
    messageId: message.id,
    role: message.role,
    content: message.content,
    images: message.images ?? [],
    status: message.status,
    errorCode: message.errorCode,
    errorDetail: message.errorDetail,
    model: message.model,
    requestId: null,
    seq: message.seq,
    createdAt: message.createdAt
  }
}

export function useChat(enabled = true): UseChatResult {
  const [messages, setMessages] = useState<ChatUiMessage[]>([])
  const [sessionId, setSessionIdState] = useState<string | null>(null)
  const [sessionMode, setSessionMode] = useState<MainWindowMode>('S1')
  const [model, setModel] = useState<string | null>(null)
  const [actionError, setActionError] = useState<string | null>(null)

  const messagesRef = useRef<ChatUiMessage[]>([])
  const sessionIdRef = useRef<string | null>(null)
  const modelRef = useRef<string | null>(null)
  const pendingSendRef = useRef<string | null>(null)
  const pendingStopRef = useRef<string | null>(null)
  const deltaBufferRef = useRef<Map<string, string>>(new Map())
  const flushHandleRef = useRef<number | null>(null)
  const lastFlushRef = useRef(0)
  const sendInFlightRef = useRef(false)
  const stoppingRef = useRef(false)
  const sessionTokenRef = useRef(0)
  const expectedSessionRef = useRef<string | null | undefined>(undefined)

  const commitMessages = useCallback((next: ChatUiMessage[]): void => {
    messagesRef.current = next
    setMessages(next)
  }, [])

  const setSession = useCallback((id: string | null): void => {
    sessionIdRef.current = id
    setSessionIdState(id)
  }, [])

  const patchMessage = useCallback(
    (localId: string, patch: Partial<ChatUiMessage>): void => {
      const next = messagesRef.current.map((message) =>
        message.id === localId ? { ...message, ...patch } : message
      )
      commitMessages(next)
    },
    [commitMessages]
  )

  const resetTransient = useCallback((): void => {
    pendingSendRef.current = null
    pendingStopRef.current = null
    deltaBufferRef.current.clear()
    if (flushHandleRef.current !== null) {
      window.cancelAnimationFrame(flushHandleRef.current)
      flushHandleRef.current = null
    }
    setActionError(null)
  }, [])

  const applySnapshot = useCallback(
    (snapshot: SessionsStateResult): void => {
      sessionTokenRef.current += 1
      resetTransient()
      setSession(snapshot.currentSessionId)
      setSessionMode(snapshot.mode)
      commitMessages(
        snapshot.messages
          .map(fromDbMessage)
          .filter((message): message is ChatUiMessage => message !== null)
      )
    },
    [commitMessages, resetTransient, setSession]
  )

  const flushDeltas = useCallback((): void => {
    if (deltaBufferRef.current.size === 0) return
    const pending = deltaBufferRef.current
    deltaBufferRef.current = new Map()
    let changed = false
    const next = messagesRef.current.map((message) => {
      const delta = pending.get(message.id)
      if (!delta) return message
      changed = true
      return { ...message, content: message.content + delta }
    })
    if (changed) commitMessages(next)
  }, [commitMessages])

  const flushPendingFor = useCallback((localId: string): void => {
    const buffered = deltaBufferRef.current.get(localId)
    if (!buffered) return
    deltaBufferRef.current.delete(localId)
    const message = messagesRef.current.find((item) => item.id === localId)
    if (!message) return
    patchMessage(localId, { content: message.content + buffered })
  }, [patchMessage])

  const scheduleFlush = useCallback((): void => {
    if (flushHandleRef.current !== null) return
    flushHandleRef.current = window.requestAnimationFrame(() => {
      flushHandleRef.current = null
      const now = performance.now()
      const elapsed = now - lastFlushRef.current
      if (elapsed < FLUSH_INTERVAL_MS) {
        scheduleFlush()
        return
      }
      lastFlushRef.current = now
      flushDeltas()
    })
  }, [flushDeltas])

  const stopRequest = useCallback(
    async (requestId: string, localId: string): Promise<void> => {
      if (stoppingRef.current) return
      const api = window.quickask
      if (!api) return
      stoppingRef.current = true
      try {
        const result = await api.chat.stop({ requestId })
        if (!result.ok || !result.data.stopped) return
        flushPendingFor(localId)
        const current = messagesRef.current.find((message) => message.id === localId)
        if (current?.status === 'streaming') {
          patchMessage(localId, { status: 'stopped' })
        }
      } catch {
        // A failed stop leaves the stream untouched; the end event still wins.
      } finally {
        stoppingRef.current = false
      }
    },
    [flushPendingFor, patchMessage]
  )

  const ensureAssistant = useCallback(
    (event: { requestId: string; sessionId: string; messageId: string }): ChatUiMessage | null => {
      let message =
        messagesRef.current.find(
          (item) => item.role === 'assistant' && item.requestId === event.requestId
        ) ?? null
      if (!message) {
        message =
          messagesRef.current.find(
            (item) => item.role === 'assistant' && item.messageId === event.messageId
          ) ?? null
      }
      if (!message && pendingSendRef.current) {
        message =
          messagesRef.current.find(
            (item) => item.id === pendingSendRef.current && item.role === 'assistant'
          ) ?? null
      }

      if (!message) {
        if (sessionIdRef.current === null) {
          setSession(event.sessionId)
        } else if (sessionIdRef.current !== event.sessionId) {
          return null
        }
        const created: ChatUiMessage = {
          id: newLocalId('assistant'),
          messageId: event.messageId,
          role: 'assistant',
          content: '',
          status: 'streaming',
          errorCode: null,
          errorDetail: null,
          model: modelRef.current,
          requestId: event.requestId,
          seq: null,
          createdAt: Date.now()
        }
        commitMessages([...messagesRef.current, created])
        message = created
      } else {
        if (sessionIdRef.current === null) setSession(event.sessionId)
        if (message.messageId !== event.messageId || message.requestId !== event.requestId) {
          patchMessage(message.id, {
            messageId: event.messageId,
            requestId: event.requestId
          })
          message = {
            ...message,
            messageId: event.messageId,
            requestId: event.requestId
          }
        }
      }

      if (pendingStopRef.current === message.id) {
        pendingStopRef.current = null
        void stopRequest(event.requestId, message.id)
      }
      return message
    },
    [commitMessages, patchMessage, setSession, stopRequest]
  )

  const handleDelta = useCallback(
    (event: ChatDeltaEvent): void => {
      if (event.delta.length === 0) return
      // Events belong to the session currently displayed. A cleared/new
      // session (`null`) only accepts events while its send is still in
      // flight; late deltas from a stopped request must not resurrect it.
      if (sessionIdRef.current === null) {
        if (!sendInFlightRef.current) return
      } else if (sessionIdRef.current !== event.sessionId) {
        return
      }
      const streaming = messagesRef.current.find(
        (item) =>
          item.role === 'assistant' &&
          item.status === 'streaming' &&
          item.requestId !== null
      )
      if (streaming?.requestId && streaming.requestId !== event.requestId) return
      const message = ensureAssistant(event)
      if (!message) return
      const pending = deltaBufferRef.current.get(message.id) ?? ''
      deltaBufferRef.current.set(message.id, pending + event.delta)
      scheduleFlush()
    },
    [ensureAssistant, scheduleFlush]
  )

  const handleEnd = useCallback(
    (event: ChatEndEvent): void => {
      if (sessionIdRef.current === null) {
        if (!sendInFlightRef.current) return
      } else if (sessionIdRef.current !== event.sessionId) {
        return
      }
      const streaming = messagesRef.current.find(
        (item) =>
          item.role === 'assistant' &&
          item.status === 'streaming' &&
          item.requestId !== null
      )
      if (streaming?.requestId && streaming.requestId !== event.requestId) return
      const message = ensureAssistant(event)
      if (!message) return
      const buffered = deltaBufferRef.current.get(message.id) ?? ''
      deltaBufferRef.current.delete(message.id)
      const current = messagesRef.current.find((item) => item.id === message.id)
      if (!current) return
      const status = event.status
      patchMessage(message.id, {
        content: current.content + buffered,
        status,
        errorCode: status === 'error' ? event.errorCode : null,
        errorDetail: status === 'error' ? event.errorDetail : null
      })
      if (pendingStopRef.current === message.id) pendingStopRef.current = null
    },
    [ensureAssistant, patchMessage]
  )

  const stopActive = useCallback(async (): Promise<void> => {
    const streaming = messagesRef.current.find(
      (message) => message.role === 'assistant' && message.status === 'streaming'
    )
    if (!streaming) return
    if (!streaming.requestId) {
      // The send IPC has not returned a request id yet; the pending marker
      // makes `send()` stop it as soon as the id arrives.
      pendingStopRef.current = streaming.id
      return
    }
    await stopRequest(streaming.requestId, streaming.id)
  }, [stopRequest])

  const stop = useCallback(async (): Promise<void> => {
    await stopActive()
  }, [stopActive])

  const retry = useCallback(
    async (messageId: string): Promise<void> => {
      const target = messagesRef.current.find(
        (message) => message.id === messageId && message.role === 'assistant'
      )
      const currentSession = sessionIdRef.current
      const api = window.quickask
      if (!target || !currentSession || !api) return
      if (target.status === 'streaming' || !RETRYABLE.has(target.status)) return
      if (!target.messageId) {
        setActionError('消息尚未保存，无法重试')
        return
      }

      const snapshot = {
        content: target.content,
        status: target.status,
        errorCode: target.errorCode,
        errorDetail: target.errorDetail
      }
      setActionError(null)
      flushPendingFor(target.id)
      patchMessage(target.id, {
        content: '',
        status: 'streaming',
        errorCode: null,
        errorDetail: null,
        requestId: null
      })

      try {
        const result = await api.chat.retry({
          sessionId: currentSession,
          messageId: target.messageId
        })
        if (!result.ok) {
          patchMessage(target.id, snapshot)
          setActionError(result.error.message)
          return
        }
        if (result.data.sessionId !== currentSession) setSession(result.data.sessionId)
        const live = messagesRef.current.find((message) => message.id === target.id)
        if (live) patchMessage(target.id, { requestId: result.data.requestId })
        if (pendingStopRef.current === target.id) {
          pendingStopRef.current = null
          void stopRequest(result.data.requestId, target.id)
        }
      } catch {
        patchMessage(target.id, snapshot)
        setActionError('重试失败，请稍后再试')
      }
    },
    [flushPendingFor, patchMessage, setSession, stopRequest]
  )

  const regenerate = useCallback(
    async (messageId: string): Promise<void> => {
      const target = messagesRef.current.find(
        (message) => message.id === messageId && message.role === 'assistant'
      )
      const currentSession = sessionIdRef.current
      const api = window.quickask
      if (!target || !currentSession || !api) return
      if (target.status !== 'complete' || !target.messageId) return

      const snapshot = {
        content: target.content,
        status: target.status,
        errorCode: target.errorCode,
        errorDetail: target.errorDetail
      }
      setActionError(null)
      patchMessage(target.id, {
        content: '',
        status: 'streaming',
        errorCode: null,
        errorDetail: null,
        requestId: null
      })

      try {
        const result = await api.chat.regenerate({
          sessionId: currentSession,
          messageId: target.messageId
        })
        if (!result.ok) {
          patchMessage(target.id, snapshot)
          setActionError(result.error.message)
          return
        }
        if (result.data.sessionId !== currentSession) setSession(result.data.sessionId)
        const live = messagesRef.current.find((message) => message.id === target.id)
        if (live) patchMessage(target.id, { requestId: result.data.requestId })
        if (pendingStopRef.current === target.id) {
          pendingStopRef.current = null
          void stopRequest(result.data.requestId, target.id)
        }
      } catch {
        patchMessage(target.id, snapshot)
        setActionError('重新生成失败，请稍后再试')
      }
    },
    [patchMessage, setSession, stopRequest]
  )

  const send = useCallback(
    async (text: string, images: ChatImage[] = []): Promise<ChatSendOutcome> => {
      const api = window.quickask
      if (!api) return { ok: false, message: 'preload API unavailable' }
      if (text.trim().length === 0 && images.length === 0) {
        return { ok: false, message: '消息不能为空' }
      }
      if (sendInFlightRef.current) return { ok: false, message: '正在发送，请稍候' }

      sendInFlightRef.current = true
      const sendToken = sessionTokenRef.current
      setActionError(null)
      const now = Date.now()
      const userMessage: ChatUiMessage = {
        id: newLocalId('user'),
        messageId: null,
        role: 'user',
        content: text,
        images: images.length > 0 ? images : undefined,
        status: 'complete',
        errorCode: null,
        errorDetail: null,
        model: null,
        requestId: null,
        seq: null,
        createdAt: now
      }
      const assistantMessage: ChatUiMessage = {
        id: newLocalId('assistant'),
        messageId: null,
        role: 'assistant',
        content: '',
        status: 'streaming',
        errorCode: null,
        errorDetail: null,
        model: modelRef.current,
        requestId: null,
        seq: null,
        createdAt: now + 1
      }
      pendingSendRef.current = assistantMessage.id
      commitMessages([...messagesRef.current, userMessage, assistantMessage])

      try {
        const result = await api.chat.send({
          sessionId: sessionIdRef.current,
          text,
          images: images.length > 0 ? images : undefined
        })
        if (!result.ok) {
          pendingSendRef.current = null
          const live = messagesRef.current.find(
            (message) => message.id === assistantMessage.id
          )
          if (!live || (live.messageId === null && live.content.length === 0)) {
            commitMessages(
              messagesRef.current.filter(
                (message) =>
                  message.id !== userMessage.id && message.id !== assistantMessage.id
              )
            )
          }
          return { ok: false, message: result.error.message }
        }

        if (sendToken !== sessionTokenRef.current) {
          // The user switched/new/deleted while the send IPC was in flight.
          // Stop the just-created request instead of leaking it into the new
          // session's message list.
          pendingSendRef.current = null
          void api.chat.stop({ requestId: result.data.requestId })
          return { ok: false, message: '会话已切换' }
        }

        pendingSendRef.current = null
        if (sessionIdRef.current !== result.data.sessionId) {
          setSession(result.data.sessionId)
        }
        setSessionMode('S2')
        const live = messagesRef.current.find(
          (message) => message.id === assistantMessage.id
        )
        if (live) {
          patchMessage(assistantMessage.id, {
            requestId: result.data.requestId,
            model: live.model ?? modelRef.current
          })
        }
        if (pendingStopRef.current === assistantMessage.id) {
          pendingStopRef.current = null
          void stopRequest(result.data.requestId, assistantMessage.id)
        }
        return { ok: true, sessionId: result.data.sessionId }
      } catch {
        pendingSendRef.current = null
        commitMessages(
          messagesRef.current.filter(
            (message) =>
              message.id !== userMessage.id && message.id !== assistantMessage.id
          )
        )
        return { ok: false, message: '发送失败，请稍后重试' }
      } finally {
        sendInFlightRef.current = false
      }
    },
    [commitMessages, patchMessage, setSession, stopRequest]
  )

  const clearLocalState = useCallback((): void => {
    pendingSendRef.current = null
    pendingStopRef.current = null
    deltaBufferRef.current.clear()
    if (flushHandleRef.current !== null) {
      window.cancelAnimationFrame(flushHandleRef.current)
      flushHandleRef.current = null
    }
    sessionTokenRef.current += 1
    setActionError(null)
    commitMessages([])
    setSession(null)
  }, [commitMessages, setSession])

  /** Fire-and-forget reset kept for callers that cannot await (Task 19 API). */
  const reset = useCallback((): void => {
    void stopActive()
    clearLocalState()
  }, [clearLocalState, stopActive])

  /** New-session path: main aborts+persists, clears its state and emits S1. */
  const clearSession = useCallback(async (): Promise<void> => {
    const api = window.quickask
    expectedSessionRef.current = null
    clearLocalState()
    setSessionMode('S1')
    if (!api) return
    const result = await api.sessions.new()
    if (!result.ok) setActionError(result.error.message)
  }, [clearLocalState])

  const loadSession = useCallback(
    async (id: string): Promise<void> => {
      const api = window.quickask
      expectedSessionRef.current = id
      const token = sessionTokenRef.current + 1
      sessionTokenRef.current = token
      resetTransient()
      commitMessages([])
      if (!api) {
        setSession(id)
        return
      }

      const result = await api.sessions.open({ id })
      if (token !== sessionTokenRef.current) return
      expectedSessionRef.current = undefined
      if (!result.ok) {
        setActionError(result.error.message)
        return
      }
      setSession(id)
      setSessionMode('S2')
      commitMessages(
        result.data.messages
          .map(fromDbMessage)
          .filter((message): message is ChatUiMessage => message !== null)
      )

      const active = await api.chat.getActive()
      if (token !== sessionTokenRef.current || sessionIdRef.current !== id) return
      if (!active.ok || !active.data.active || active.data.active.sessionId !== id) return
      const current = active.data.active
      const existing = messagesRef.current.find(
        (message) => message.messageId === current.messageId
      )
      if (existing) {
        patchMessage(existing.id, {
          content: current.content,
          status: 'streaming',
          requestId: current.requestId,
          errorCode: null,
          errorDetail: null
        })
      } else {
        commitMessages([
          ...messagesRef.current,
          {
            id: newLocalId('assistant'),
            messageId: current.messageId,
            role: 'assistant',
            content: current.content,
            status: 'streaming',
            errorCode: null,
            errorDetail: null,
            model: modelRef.current,
            requestId: current.requestId,
            seq: null,
            createdAt: current.startedAt
          }
        ])
      }
    },
    [commitMessages, patchMessage, resetTransient, setSession]
  )

  const syncSessionState = useCallback(async (): Promise<void> => {
    const api = window.quickask
    if (!api) return
    const result = await api.sessions.state()
    if (!result.ok) {
      setActionError(result.error.message)
      return
    }
    applySnapshot(result.data)
  }, [applySnapshot])

  const handleSessionEvent = useCallback(
    (event: UiSessionEvent): void => {
      setSessionMode(event.mode)
      const expected = expectedSessionRef.current
      if (expected !== undefined) {
        expectedSessionRef.current = undefined
        if (expected === event.currentSessionId) {
          if (expected === null) {
            clearLocalState()
            setSessionMode(event.mode)
          } else {
            resetTransient()
            commitMessages([])
            setSession(expected)
          }
          return
        }
      }

      if (event.currentSessionId === sessionIdRef.current) return
      if (sendInFlightRef.current) {
        setSession(event.currentSessionId)
        return
      }
      void syncSessionState()
    },
    [clearLocalState, commitMessages, resetTransient, setSession, syncSessionState]
  )

  const clearError = useCallback((): void => setActionError(null), [])

  const retryLast = useCallback((): void => {
    const last = [...messagesRef.current]
      .reverse()
      .find(
        (message) =>
          message.role === 'assistant' &&
          RETRYABLE.has(message.status) &&
          message.messageId !== null
      )
    if (last) void retry(last.id)
  }, [retry])

  const panelError = useMemo<ChatPanelError | null>(() => {
    if (actionError) return { message: actionError, retry: retryLast }
    const last = [...messages].reverse().find((message) => message.role === 'assistant')
    if (!last) return null
    if (last.status === 'error') {
      return {
        message: uiErrorMessage(last.errorCode, last.errorDetail),
        retry: retryLast
      }
    }
    if (last.status === 'stopped') {
      return { message: stoppedMessage(), retry: retryLast }
    }
    if (last.status === 'interrupted') {
      return { message: interruptedMessage(), retry: retryLast }
    }
    return null
  }, [actionError, messages, retryLast])

  const title = useMemo(() => {
    const firstUser = messages.find((message) => message.role === 'user')
    return firstUser ? deriveTitle(firstUser.content) : '新会话'
  }, [messages])

  const streamingMessage =
    messages.find(
      (message) => message.role === 'assistant' && message.status === 'streaming'
    ) ?? null
  const streaming = streamingMessage !== null
  const activeRequestId = streamingMessage?.requestId ?? null

  useEffect(() => {
    if (!enabled) return
    const api = window.quickask
    if (!api) return
    let active = true

    void api.provider
      .list()
      .then((result) => {
        if (!active || !result.ok) return
        const profiles = result.data.profiles
        const chosen = profiles.find((profile) => profile.isDefault) ?? profiles[0]
        const chosenModel = chosen?.model?.trim() ?? ''
        if (chosenModel.length === 0) return
        modelRef.current = chosenModel
        setModel(chosenModel)
        const next = messagesRef.current.map((message) =>
          message.role === 'assistant' && !message.model
            ? { ...message, model: chosenModel }
            : message
        )
        commitMessages(next)
      })
      .catch(() => undefined)

    return () => {
      active = false
    }
  }, [commitMessages, enabled, sessionId])

  useEffect(() => {
    if (!enabled) return
    const api = window.quickask
    if (!api) return
    let active = true

    void api.chat
      .getActive()
      .then((result) => {
        if (!active || !result.ok || !result.data.active) return
        const current = result.data.active
        if (sessionIdRef.current !== null && sessionIdRef.current !== current.sessionId) {
          return
        }
        setSession(current.sessionId)
        const existing = messagesRef.current.find(
          (message) => message.messageId === current.messageId
        )
        if (existing) {
          patchMessage(existing.id, {
            content: current.content,
            status: 'streaming',
            requestId: current.requestId,
            errorCode: null,
            errorDetail: null
          })
          return
        }
        commitMessages([
          ...messagesRef.current,
          {
            id: newLocalId('assistant'),
            messageId: current.messageId,
            role: 'assistant',
            content: current.content,
            status: 'streaming',
            errorCode: null,
            errorDetail: null,
            model: modelRef.current,
            requestId: current.requestId,
            seq: null,
            createdAt: current.startedAt
          }
        ])
      })
      .catch(() => undefined)

    return () => {
      active = false
    }
  }, [commitMessages, enabled, patchMessage, setSession])

  useEffect(() => {
    if (!enabled) return
    const api = window.quickask
    if (!api) return
    const unsubscribeDelta = api.chat.onDelta(handleDelta)
    const unsubscribeEnd = api.chat.onEnd(handleEnd)
    return () => {
      unsubscribeDelta()
      unsubscribeEnd()
    }
  }, [enabled, handleDelta, handleEnd])

  useEffect(() => {
    if (!enabled) return
    const api = window.quickask
    if (!api) return
    return api.sessions.onSession(handleSessionEvent)
  }, [enabled, handleSessionEvent])

  useEffect(() => {
    if (!enabled) return
    void syncSessionState()
  }, [enabled, syncSessionState])

  useEffect(
    () => () => {
      if (flushHandleRef.current !== null) {
        window.cancelAnimationFrame(flushHandleRef.current)
        flushHandleRef.current = null
      }
    },
    []
  )

  return {
    messages,
    sessionId,
    sessionMode,
    title,
    model,
    streaming,
    activeRequestId,
    panelError,
    send,
    stop,
    retry,
    regenerate,
    loadSession,
    clearSession,
    syncSessionState,
    reset,
    clearError
  }
}
