/**
 * S1 composer — REQUIREMENTS.md §3.4 / F-02 / F-09 / §3.11.
 *
 * The textarea grows from 1 to 6 lines (24px per line). Window geometry is
 * owned by the main process; this component only reports the line count via
 * `window:set-height`. Enter sends, Shift+Enter inserts a newline, and any
 * keydown during IME composition is ignored (`isComposing || keyCode === 229`).
 */

import {
  useLayoutEffect,
  useRef,
  useState,
  type ClipboardEvent as ReactClipboardEvent,
  type KeyboardEvent as ReactKeyboardEvent,
  type RefObject
} from 'react'
import { MAX_CHAT_IMAGES, type ChatImage } from '../../../shared/channels'
import { collectClipboardImages, fileToChatImage } from '../lib/imageAttachment'

export type ComposerNoticeLevel = 'error' | 'warning' | 'info'

export interface ComposerNotice {
  level: ComposerNoticeLevel
  message: string
}

export interface ComposerProps {
  value: string
  onChange: (value: string) => void
  onSend?: () => void
  disabled?: boolean
  placeholder?: string
  textareaRef: RefObject<HTMLTextAreaElement | null>
  clipboardHint?: string | null
  onConsumeClipboard?: () => void
  onNotice?: (notice: ComposerNotice) => void
  notice?: ComposerNotice | null
  /** Pasted clipboard images waiting to be sent. */
  images?: ChatImage[]
  onImagesChange?: (images: ChatImage[]) => void
}

const MAX_LINES = 6
const MIN_LINES = 1
const MAX_PASTE_CHARS = 50_000
const TRUNCATE_NOTICE = '已截断至 50,000 字符'
const FILE_NOTICE = '暂不支持文件'
const IMAGE_LIMIT_NOTICE = `最多只能附带 ${MAX_CHAT_IMAGES} 张图片`
const IMAGE_FAILED_NOTICE = '有图片处理失败，其余已加入'

function clampLines(lines: number): number {
  return Math.min(MAX_LINES, Math.max(MIN_LINES, lines))
}

interface LineMetrics {
  lines: number
  overscroll: boolean
}

/**
 * Measure the *content* height instead of the current textarea height:
 * `scrollHeight` can never be smaller than `clientHeight`, so measuring while
 * the box is still 6 lines tall would keep reporting 6 after deleting text.
 */
function measureLines(el: HTMLTextAreaElement): LineMetrics {
  const style = getComputedStyle(el)
  const lineHeight = Number.parseFloat(style.lineHeight)
  const paddingY =
    Number.parseFloat(style.paddingTop) + Number.parseFloat(style.paddingBottom)
  const previousHeight = el.style.height
  el.style.height = 'auto'
  const scrollHeight = el.scrollHeight
  el.style.height = previousHeight

  const raw = lineHeight > 0 ? (scrollHeight - paddingY) / lineHeight : MIN_LINES
  return {
    lines: clampLines(Math.round(raw)),
    overscroll: raw > MAX_LINES
  }
}

function isShortcutKey(event: ReactKeyboardEvent<HTMLTextAreaElement>): boolean {
  if (!(event.ctrlKey || event.metaKey)) return false
  const key = event.key.toLowerCase()
  return key === 'n' || key === 'h' || key === ',' || (key === 'v' && event.shiftKey)
}

export function Composer({
  value,
  onChange,
  onSend,
  disabled = false,
  placeholder = '问点什么…',
  textareaRef,
  clipboardHint = null,
  onConsumeClipboard,
  onNotice,
  notice = null,
  images: imagesProp = [],
  onImagesChange
}: ComposerProps) {
  const composingRef = useRef(false)
  const lastLinesRef = useRef(MIN_LINES)
  const caretRef = useRef<number | null>(null)
  const imagesRef = useRef<ChatImage[]>(imagesProp)
  const [converting, setConverting] = useState(false)

  useLayoutEffect(() => {
    imagesRef.current = imagesProp
  }, [imagesProp])

  useLayoutEffect(() => {
    const el = textareaRef.current
    if (!el) return

    const { lines, overscroll } = measureLines(el)
    el.style.overflowY = overscroll ? 'auto' : 'hidden'
    if (value.length === 0) el.scrollTop = 0

    if (lines !== lastLinesRef.current) {
      lastLinesRef.current = lines
      void window.quickask?.window.setHeight({ barLines: lines })
    }
  }, [value, textareaRef])

  useLayoutEffect(() => {
    const el = textareaRef.current
    if (!el || caretRef.current === null) return
    const caret = caretRef.current
    caretRef.current = null
    el.setSelectionRange(caret, caret)
    el.focus()
  }, [value, textareaRef])

  const insertClipboardHint = (): void => {
    const hint = clipboardHint?.trim()
    if (!hint) return
    const el = textareaRef.current
    const start = el?.selectionStart ?? value.length
    const end = el?.selectionEnd ?? start
    const next = `${value.slice(0, start)}${hint}${value.slice(end)}`
    caretRef.current = start + hint.length
    onChange(next)
    onConsumeClipboard?.()
    el?.focus()
  }

  const addImages = async (files: File[]): Promise<void> => {
    const slots = MAX_CHAT_IMAGES - imagesRef.current.length
    if (slots <= 0) {
      onNotice?.({ level: 'warning', message: IMAGE_LIMIT_NOTICE })
      return
    }

    const selected = files.slice(0, slots)
    if (files.length > slots) {
      onNotice?.({ level: 'info', message: `${IMAGE_LIMIT_NOTICE}，只保留前 ${slots} 张` })
    }

    setConverting(true)
    let next = imagesRef.current
    let failed = 0
    try {
      for (const file of selected) {
        try {
          const image = await fileToChatImage(file)
          next = [...next, image]
          imagesRef.current = next
          // Publish after each image so a slow paste still shows progress.
          onImagesChange?.(next)
        } catch {
          failed += 1
        }
      }
    } finally {
      setConverting(false)
    }

    if (failed > 0) onNotice?.({ level: 'error', message: IMAGE_FAILED_NOTICE })
  }

  const removeImage = (index: number): void => {
    const next = imagesRef.current.filter((_, position) => position !== index)
    imagesRef.current = next
    onImagesChange?.(next)
  }

  const handleKeyDown = (event: ReactKeyboardEvent<HTMLTextAreaElement>): void => {
    const composing =
      composingRef.current || event.nativeEvent.isComposing || event.keyCode === 229

    if (composing) {
      // Enter must not send; shortcuts must not run. Esc is deliberately NOT
      // prevented so the IME can cancel the composition itself.
      if (event.key === 'Enter' || isShortcutKey(event)) event.preventDefault()
      return
    }

    if (event.key === 'Tab') {
      // Bar's capture handler owns the explicit focus cycle. This is only a
      // fallback: a Tab must never be inserted into the textarea.
      event.preventDefault()
      return
    }

    if (event.key === 'Enter' && !event.shiftKey) {
      event.preventDefault()
      onSend?.()
      return
    }

    if ((event.ctrlKey || event.metaKey) && event.shiftKey && event.key.toLowerCase() === 'v') {
      // F-09: the chip action wins when there is a text hint. With no hint the
      // native paste must run, otherwise a clipboard image could never arrive.
      if (clipboardHint) {
        event.preventDefault()
        insertClipboardHint()
      }
      return
    }

    if (
      (event.ctrlKey || event.metaKey) &&
      isShortcutKey(event) &&
      event.key.toLowerCase() !== 'v'
    ) {
      // Ctrl+N / Ctrl+H / Ctrl+, are owned by App's window-level handler.
      // preventDefault only suppresses native textarea/browser behavior; it
      // deliberately does not stop propagation, so the App handler still runs.
      event.preventDefault()
    }
  }

  const handlePaste = (event: ReactClipboardEvent<HTMLTextAreaElement>): void => {
    const data = event.clipboardData
    const pastedImages = collectClipboardImages(data)
    if (pastedImages.length > 0) {
      // Screenshots arrive as `image/png` files; never let the browser paste a
      // file name into the textarea instead.
      event.preventDefault()
      void addImages(pastedImages)
      return
    }

    const files = Array.from(data.files ?? [])
    const items = Array.from(data.items ?? [])
    const hasFile =
      files.length > 0 || items.some((item: DataTransferItem) => item.kind === 'file')

    if (hasFile) {
      event.preventDefault()
      onNotice?.({ level: 'warning', message: FILE_NOTICE })
      return
    }

    const text = data.getData('text/plain')
    if (text.length <= MAX_PASTE_CHARS) return

    event.preventDefault()
    const truncated = text.slice(0, MAX_PASTE_CHARS)
    const el = event.currentTarget
    const start = el.selectionStart ?? value.length
    const end = el.selectionEnd ?? start
    const next = `${value.slice(0, start)}${truncated}${value.slice(end)}`
    caretRef.current = start + truncated.length
    onChange(next)
    onNotice?.({ level: 'warning', message: TRUNCATE_NOTICE })
  }

  return (
    <>
      {clipboardHint ? (
        <button
          type="button"
          className="qa-clipboard-chip"
          data-testid="clipboard-chip"
          tabIndex={-1}
          aria-label="带入剪贴板内容"
          title={`带入剪贴板内容：${clipboardHint}`}
          onClick={insertClipboardHint}
        >
          <span className="qa-clipboard-chip-label">带入剪贴板</span>
          <span className="qa-clipboard-chip-preview">{clipboardHint}</span>
        </button>
      ) : null}

      {converting || imagesProp.length > 0 ? (
        <div className="qa-image-strip" data-testid="image-strip">
          {imagesProp.map((image, index) => (
            <div className="qa-image-chip" key={`${index}-${image.bytes}-${image.width}`}>
              <img
                className="qa-image-chip-thumb"
                src={image.dataUrl}
                alt={`待发送图片 ${index + 1}`}
                title={`${image.width}×${image.height}`}
              />
              <button
                type="button"
                className="qa-image-chip-remove"
                data-testid="image-remove"
                aria-label={`移除图片 ${index + 1}`}
                tabIndex={-1}
                onClick={() => removeImage(index)}
              >
                ×
              </button>
            </div>
          ))}
          {converting ? (
            <span className="qa-image-chip-status" role="status">
              处理中…
            </span>
          ) : null}
        </div>
      ) : null}

      <textarea
        ref={textareaRef}
        className="qa-composer"
        data-testid="composer"
        value={value}
        rows={1}
        placeholder={placeholder}
        aria-label="输入问题"
        autoComplete="off"
        spellCheck={false}
        disabled={disabled}
        onChange={(event) => onChange(event.target.value)}
        onKeyDown={handleKeyDown}
        onPaste={handlePaste}
        onCompositionStart={() => {
          composingRef.current = true
        }}
        onCompositionEnd={() => {
          composingRef.current = false
        }}
      />

      {notice ? (
        <div
          className={`qa-composer-notice qa-composer-notice--${notice.level}`}
          data-testid="composer-notice"
          role="alert"
        >
          {notice.message}
        </div>
      ) : null}
    </>
  )
}
