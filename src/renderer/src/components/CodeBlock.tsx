import { memo, useEffect, useRef, useState } from 'react'
import hljs from 'highlight.js/lib/common'
import { IconCopy } from './Icons'

export interface HighlightedCode {
  html: string
  language: string
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}

export function highlightCode(code: string, language?: string): HighlightedCode {
  const name = (language ?? '').trim().toLowerCase()
  if (name.length > 0 && hljs.getLanguage(name)) {
    try {
      return {
        html: hljs.highlight(code, { language: name, ignoreIllegals: true }).value,
        language: name
      }
    } catch {
      return { html: escapeHtml(code), language: name }
    }
  }
  return { html: escapeHtml(code), language: name }
}

export function escapeCodeAttribute(value: string): string {
  return escapeHtml(value)
}

async function writeClipboard(text: string): Promise<boolean> {
  const result = await window.quickask?.clipboard.writeText(text)
  return result?.ok === true && result.data.written === true
}

export interface CodeBlockProps {
  code: string
  language?: string
  copyLabel?: string
  onCopy?: () => void
}

export const CodeBlock = memo(function CodeBlock({
  code,
  language,
  copyLabel = '复制',
  onCopy
}: CodeBlockProps) {
  const [copied, setCopied] = useState(false)
  const timerRef = useRef<number | null>(null)
  const highlighted = highlightCode(code, language)

  useEffect(
    () => () => {
      if (timerRef.current !== null) window.clearTimeout(timerRef.current)
    },
    []
  )

  const copy = (): void => {
    void writeClipboard(code).then((written) => {
      if (!written) return
      setCopied(true)
      onCopy?.()
      if (timerRef.current !== null) window.clearTimeout(timerRef.current)
      timerRef.current = window.setTimeout(() => {
        timerRef.current = null
        setCopied(false)
      }, 1200)
    })
  }

  return (
    <div className="qa-code-block" data-testid="code-block" data-language={highlighted.language}>
      <button
        type="button"
        className="qa-code-copy"
        data-testid="code-copy"
        aria-label="复制代码"
        onClick={copy}
      >
        <IconCopy size={12} />
        <span>{copied ? '已复制' : copyLabel}</span>
      </button>
      <pre className="qa-code-pre">
        <code
          className={`hljs${highlighted.language ? ` language-${highlighted.language}` : ''}`}
          dangerouslySetInnerHTML={{ __html: highlighted.html }}
        />
      </pre>
    </div>
  )
})
