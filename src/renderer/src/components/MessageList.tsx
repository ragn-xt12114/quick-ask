import { memo, useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import type { ChatUiMessage } from '../hooks/useChat'
import { Markdown } from './Markdown'
import { AssistantMessage, UserMessage } from './PanelShell'

const STATUS_LABELS: Record<string, string> = {
  stopped: '已停止',
  interrupted: '已中断',
  error: '生成失败'
}

const STICK_THRESHOLD = 24

export interface MessageListProps {
  messages: ChatUiMessage[]
  streaming: boolean
  onRetry: (messageId: string) => void
  onRegenerate: (messageId: string) => void
  onContentHeight?: (height: number) => void
}

interface MessageItemProps {
  message: ChatUiMessage
  streaming: boolean
  copied: boolean
  onRetry: (messageId: string) => void
  onRegenerate: (messageId: string) => void
  onCopyFull: (messageId: string, content: string) => void
}

const MessageItem = memo(
  function MessageItem({
    message,
    copied,
    onRetry,
    onRegenerate,
    onCopyFull
  }: MessageItemProps) {
    if (message.role === 'user') {
      const images = message.images ?? []
      return (
        <UserMessage>
          {images.length > 0 ? (
            <div className="qa-msg-images" data-testid="msg-images">
              {images.map((image, index) => (
                <img
                  key={`${index}-${image.bytes}-${image.width}`}
                  className="qa-msg-image"
                  src={image.dataUrl}
                  alt={`附图 ${index + 1}`}
                  title={`${image.width}×${image.height}`}
                />
              ))}
            </div>
          ) : null}
          <span data-testid="user-text">{message.content}</span>
        </UserMessage>
      )
    }

    const statusLabel = STATUS_LABELS[message.status]
    const canRetry =
      message.status === 'error' ||
      message.status === 'stopped' ||
      message.status === 'interrupted'
    const canRegenerate = message.status === 'complete'
    const canCopy = message.content.length > 0

    return (
      <AssistantMessage>
        <div
          className="qa-msg-assistant"
          data-testid="assistant-message"
          data-message-id={message.messageId ?? ''}
          data-status={message.status}
        >
          {message.content.length > 0 ? (
            <Markdown text={message.content} streaming={message.status === 'streaming'} />
          ) : null}
          {statusLabel ? (
            <div className="qa-msg-status" data-testid="msg-status">
              {statusLabel}
            </div>
          ) : null}
          {canRetry || canRegenerate || canCopy ? (
            <div className="qa-msg-actions" data-testid="msg-actions">
              {canCopy ? (
                <button
                  type="button"
                  className="qa-msg-action"
                  data-testid="copy-full"
                  onClick={() => onCopyFull(message.id, message.content)}
                >
                  {copied ? '已复制' : '复制全文'}
                </button>
              ) : null}
              {canRetry ? (
                <button
                  type="button"
                  className="qa-msg-action"
                  data-testid="btn-retry"
                  onClick={() => onRetry(message.id)}
                >
                  重试
                </button>
              ) : null}
              {canRegenerate ? (
                <button
                  type="button"
                  className="qa-msg-action"
                  data-testid="btn-regenerate"
                  onClick={() => onRegenerate(message.id)}
                >
                  重新生成
                </button>
              ) : null}
            </div>
          ) : null}
        </div>
      </AssistantMessage>
    )
  },
  (prev, next) =>
    prev.message === next.message &&
    prev.streaming === next.streaming &&
    prev.copied === next.copied &&
    prev.onRetry === next.onRetry &&
    prev.onRegenerate === next.onRegenerate &&
    prev.onCopyFull === next.onCopyFull
)

export function MessageList({
  messages,
  streaming,
  onRetry,
  onRegenerate,
  onContentHeight
}: MessageListProps) {
  const listRef = useRef<HTMLDivElement>(null)
  const stickRef = useRef(true)
  const copyTimerRef = useRef<number | null>(null)
  const [copiedId, setCopiedId] = useState<string | null>(null)

  const copyFull = useCallback((messageId: string, content: string): void => {
    void window.quickask?.clipboard.writeText(content).then((result) => {
      if (!result?.ok || !result.data.written) return
      setCopiedId(messageId)
      if (copyTimerRef.current !== null) window.clearTimeout(copyTimerRef.current)
      copyTimerRef.current = window.setTimeout(() => {
        copyTimerRef.current = null
        setCopiedId(null)
      }, 1200)
    })
  }, [])

  useEffect(
    () => () => {
      if (copyTimerRef.current !== null) window.clearTimeout(copyTimerRef.current)
    },
    []
  )

  useEffect(() => {
    const scroller = listRef.current?.closest('.qa-panel-body') as HTMLElement | null
    if (!scroller) return
    let pointerDown = false
    const updateFades = (): void => {
      const distanceToBottom =
        scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight
      scroller.dataset['fadeTop'] = scroller.scrollTop > 1 ? 'true' : 'false'
      scroller.dataset['fadeBottom'] = distanceToBottom > 1 ? 'true' : 'false'
    }
    const handleScroll = (): void => {
      const distance = scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight
      if (pointerDown) stickRef.current = distance < STICK_THRESHOLD
      updateFades()
    }
    const handleWheel = (event: WheelEvent): void => {
      if (event.deltaY < 0) {
        stickRef.current = false
        return
      }
      const distance = scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight
      if (distance < STICK_THRESHOLD) stickRef.current = true
    }
    const handleKeyDown = (event: KeyboardEvent): void => {
      if (['ArrowUp', 'PageUp', 'Home'].includes(event.key)) {
        stickRef.current = false
        return
      }
      if (['ArrowDown', 'PageDown', 'End'].includes(event.key)) {
        const distance = scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight
        if (distance < STICK_THRESHOLD) stickRef.current = true
      }
    }
    const handlePointerDown = (): void => {
      pointerDown = true
    }
    const handlePointerUp = (): void => {
      pointerDown = false
      const distance = scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight
      stickRef.current = distance < STICK_THRESHOLD
    }

    scroller.addEventListener('scroll', handleScroll, { passive: true })
    scroller.addEventListener('wheel', handleWheel, { passive: true })
    scroller.addEventListener('keydown', handleKeyDown)
    scroller.addEventListener('pointerdown', handlePointerDown)
    window.addEventListener('pointerup', handlePointerUp)
    updateFades()
    const observer = new ResizeObserver(updateFades)
    observer.observe(scroller)
    const list = listRef.current
    if (list) observer.observe(list)
    return () => {
      scroller.removeEventListener('scroll', handleScroll)
      scroller.removeEventListener('wheel', handleWheel)
      scroller.removeEventListener('keydown', handleKeyDown)
      scroller.removeEventListener('pointerdown', handlePointerDown)
      window.removeEventListener('pointerup', handlePointerUp)
      observer.disconnect()
    }
  }, [])

  useLayoutEffect(() => {
    const scroller = listRef.current?.closest('.qa-panel-body') as HTMLElement | null
    if (!scroller || !stickRef.current) return
    if (streaming) {
      scroller.scrollTop = scroller.scrollHeight
    } else {
      scroller.scrollTo({ top: scroller.scrollHeight, behavior: 'smooth' })
    }
  }, [messages, streaming])

  useEffect(() => {
    const element = listRef.current
    if (!element || !onContentHeight) return
    const report = (): void => onContentHeight(element.scrollHeight)
    report()
    const observer = new ResizeObserver(report)
    observer.observe(element)
    return () => observer.disconnect()
  }, [messages.length, onContentHeight])

  return (
    <div className="qa-messages" data-testid="panel-content" ref={listRef}>
      {messages.map((message) => (
        <MessageItem
          key={message.id}
          message={message}
          streaming={streaming}
          copied={copiedId === message.id}
          onRetry={onRetry}
          onRegenerate={onRegenerate}
          onCopyFull={copyFull}
        />
      ))}
    </div>
  )
}
