import { useRef, type CSSProperties, type KeyboardEvent as ReactKeyboardEvent } from 'react'
import type { ChatImage } from '../../../shared/channels'
import { Card } from './Card'
import { Composer, type ComposerNotice } from './Composer'
import { IconButton } from './IconButton'
import { SendButton } from './SendButton'
import { IconChevronDown, IconHistory, IconPlus, IconSend } from './Icons'

export interface BarProps {
  /** Absolute rect from `ui:state` layout (positioning stays in App). */
  style?: CSSProperties
  value: string
  onChange: (value: string) => void
  onSend?: () => void
  onHistory?: () => void
  onExpand?: () => void
  onNew?: () => void
  /** §3.4: ⌄ is disabled while the current session has no messages. */
  hasMessages?: boolean
  /** Rotates the expand glyph 180° when the panel is open. */
  expanded?: boolean
  disabled?: boolean
  /** F-08: composer/send stay disabled until a provider is usable. */
  inputDisabled?: boolean
  placeholder?: string
  clipboardHint?: string | null
  onConsumeClipboard?: () => void
  notice?: ComposerNotice | null
  onNotice?: (notice: ComposerNotice) => void
  /** Pasted clipboard images (owned by App, converted by Composer). */
  images?: ChatImage[]
  onImagesChange?: (images: ChatImage[]) => void
}

/**
 * S1 capsule — §3.4.
 *
 * Exact order (and the only buttons): history → expand → new → divider →
 * composer → send. The clipboard chip is an inline, transient sibling and
 * never adds a row or changes the button order.
 */
export function Bar({
  style,
  value,
  onChange,
  onSend,
  onHistory,
  onExpand,
  onNew,
  hasMessages = false,
  expanded = false,
  disabled = false,
  inputDisabled = false,
  placeholder = '问点什么…',
  clipboardHint = null,
  onConsumeClipboard,
  notice = null,
  onNotice,
  images = [],
  onImagesChange
}: BarProps) {
  const historyRef = useRef<HTMLButtonElement>(null)
  const expandRef = useRef<HTMLButtonElement>(null)
  const newRef = useRef<HTMLButtonElement>(null)
  const composerRef = useRef<HTMLTextAreaElement>(null)
  const sendRef = useRef<HTMLButtonElement>(null)
  const temporarilyEnabledRef = useRef<HTMLButtonElement[]>([])

  // An image-only turn is valid: the main process fills in a neutral prompt.
  const canSend = (value.trim().length > 0 || images.length > 0) && !disabled && !inputDisabled
  const canExpand = hasMessages && !disabled

  /**
   * §3.11 requires the explicit cycle to include disabled controls (expand
   * before the first exchange, send for an empty composer). Native disabled
   * buttons cannot receive focus, so they are enabled only for the duration
   * of keyboard focus and re-disabled on blur. The data attribute keeps the
   * 35% disabled appearance and click handlers stay guarded.
   */
  const focusInCycle = (element: HTMLButtonElement | HTMLTextAreaElement): void => {
    if (element instanceof HTMLButtonElement && element.disabled) {
      element.disabled = false
      temporarilyEnabledRef.current.push(element)
    }
    element.focus()
  }

  const restoreTemporaryDisabled = (element: HTMLButtonElement): void => {
    const index = temporarilyEnabledRef.current.indexOf(element)
    if (index === -1) return
    temporarilyEnabledRef.current.splice(index, 1)
    element.disabled = true
  }

  const handleTabKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>): void => {
    if (event.key !== 'Tab') return
    event.preventDefault()
    event.stopPropagation()

    const order = [
      historyRef.current,
      expandRef.current,
      newRef.current,
      composerRef.current,
      sendRef.current
    ]
    const currentIndex = order.findIndex((element) => element === document.activeElement)
    const direction = event.shiftKey ? -1 : 1

    let index = currentIndex
    for (let attempt = 0; attempt < order.length; attempt += 1) {
      index =
        index === -1
          ? direction === 1
            ? 0
            : order.length - 1
          : (index + direction + order.length) % order.length
      const candidate = order[index]
      if (!candidate) continue
      // Disabled controls still participate in the explicit §3.11 cycle.
      focusInCycle(candidate)
      return
    }
  }

  return (
    <Card
      variant="bar"
      className="qa-bar"
      data-testid="bar"
      style={style}
      aria-label="QuickAsk 输入条"
      onKeyDownCapture={handleTabKeyDown}
    >
      <IconButton
        ref={historyRef}
        label="历史"
        tooltip="历史 (Ctrl+H)"
        data-testid="btn-history"
        disabled={disabled}
        onClick={onHistory}
      >
        <IconHistory />
      </IconButton>

      <IconButton
        ref={expandRef}
        label="展开对话"
        tooltip="展开对话"
        data-testid="btn-expand"
        disabled={!canExpand}
        data-disabled={canExpand ? undefined : 'true'}
        aria-disabled={!canExpand}
        aria-expanded={expanded}
        onClick={canExpand ? onExpand : undefined}
        onBlur={(event) => restoreTemporaryDisabled(event.currentTarget)}
      >
        <IconChevronDown className={expanded ? 'qa-icon-rotated' : undefined} />
      </IconButton>

      <IconButton
        ref={newRef}
        label="新建会话"
        tooltip="新建会话 (Ctrl+N)"
        data-testid="btn-new"
        disabled={disabled}
        onClick={onNew}
      >
        <IconPlus />
      </IconButton>

      <span className="qa-bar-divider" data-testid="bar-divider" aria-hidden="true" />

      <Composer
        value={value}
        onChange={onChange}
        onSend={onSend}
        disabled={disabled || inputDisabled}
        placeholder={placeholder}
        textareaRef={composerRef}
        clipboardHint={clipboardHint}
        onConsumeClipboard={onConsumeClipboard}
        onNotice={onNotice}
        notice={notice}
        images={images}
        onImagesChange={onImagesChange}
      />

      <SendButton
        ref={sendRef}
        data-testid="btn-send"
        disabled={!canSend}
        data-disabled={canSend ? undefined : 'true'}
        aria-disabled={!canSend}
        onClick={canSend ? onSend : undefined}
        onBlur={(event) => restoreTemporaryDisabled(event.currentTarget)}
      >
        <IconSend size={16} />
      </SendButton>
    </Card>
  )
}
