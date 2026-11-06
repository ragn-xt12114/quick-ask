import { useMemo, useRef, type MouseEvent } from 'react'
import MarkdownIt from 'markdown-it'
import DOMPurify from 'dompurify'
import { escapeCodeAttribute, highlightCode } from './CodeBlock'

const markdown = new MarkdownIt({
  html: false,
  linkify: false,
  breaks: true,
  typographer: false
})

function isHttpUrl(value: string): boolean {
  return /^https?:\/\//i.test(value)
}

markdown.validateLink = (url: string): boolean => isHttpUrl(url)

markdown.renderer.rules.image = (tokens, index): string => {
  const token = tokens[index]
  const alt = String(token?.content || token?.attrGet('alt') || '图片')
  return `<span class="qa-md-image" data-testid="markdown-image-placeholder">[图片: ${markdown.utils.escapeHtml(alt)}]</span>`
}

markdown.renderer.rules.link_open = (tokens, index, options, _env, self): string => {
  const token = tokens[index]
  const href = String(token?.attrGet('href') ?? '')
  if (!token || !isHttpUrl(href)) {
    token?.attrSet('href', '')
    token?.attrSet('data-blocked', '1')
    token?.attrSet('class', 'qa-md-link qa-md-link--blocked')
  } else {
    token.attrSet('class', 'qa-md-link')
    token.attrSet('target', '_blank')
    token.attrSet('rel', 'noopener noreferrer')
  }
  return self.renderToken(tokens, index, options)
}

markdown.renderer.rules.table_open = (): string =>
  '<div class="qa-table-wrap"><table class="qa-table">'

markdown.renderer.rules.table_close = (): string => '</table></div>'

markdown.renderer.rules.fence = (tokens, index): string => {
  const token = tokens[index]
  if (!token) return ''
  const info = token.info.trim().split(/\s+/)[0] ?? ''
  const highlighted = highlightCode(token.content, info)
  const languageClass = highlighted.language
    ? ` language-${escapeCodeAttribute(highlighted.language)}`
    : ''
  return (
    `<div class="qa-code-block" data-testid="code-block" data-language="${escapeCodeAttribute(highlighted.language)}">` +
    '<button type="button" class="qa-code-copy" data-testid="code-copy" data-qacopy="1" aria-label="复制代码"><span>复制</span></button>' +
    `<pre class="qa-code-pre"><code class="hljs${languageClass}">${highlighted.html}</code></pre>` +
    '</div>'
  )
}

const SANITIZE_CONFIG = {
  USE_PROFILES: { html: true },
  FORBID_TAGS: [
    'img',
    'script',
    'style',
    'iframe',
    'object',
    'embed',
    'form',
    'input',
    'textarea',
    'select',
    'option',
    'link',
    'meta',
    'video',
    'audio',
    'source',
    'track',
    'svg',
    'math'
  ],
  FORBID_ATTR: [
    'src',
    'srcset',
    'loading',
    'onerror',
    'onload',
    'onclick',
    'style',
    'id',
    'name'
  ],
  ALLOWED_URI_REGEXP: /^https?:/i,
  ADD_ATTR: ['target', 'rel', 'data-blocked', 'data-qacopy', 'data-testid', 'aria-label']
}

DOMPurify.addHook('afterSanitizeAttributes', (node) => {
  if (node.tagName === 'A') {
    const href = node.getAttribute('href') ?? ''
    if (!isHttpUrl(href)) {
      node.removeAttribute('href')
      node.setAttribute('data-blocked', '1')
    } else {
      node.setAttribute('target', '_blank')
      node.setAttribute('rel', 'noopener noreferrer')
    }
  }
  if (node.tagName === 'IMG') {
    node.parentNode?.removeChild(node)
  }
})

export function renderMarkdown(text: string): string {
  return DOMPurify.sanitize(markdown.render(text), SANITIZE_CONFIG)
}

function copyCodeFromButton(button: HTMLElement): void {
  const block = button.closest('.qa-code-block')
  const code = block?.querySelector('.qa-code-pre code')?.textContent ?? ''
  if (code.length === 0) return
  void window.quickask?.clipboard.writeText(code).then((result) => {
    if (!result?.ok || !result.data.written) return
    const label = button.querySelector('span')
    if (!label) return
    const previous = label.textContent
    label.textContent = '已复制'
    window.setTimeout(() => {
      if (label.isConnected) label.textContent = previous ?? '复制'
    }, 1200)
  })
}

export interface MarkdownProps {
  text: string
  streaming?: boolean
  className?: string
}

export function Markdown({ text, streaming = false, className = '' }: MarkdownProps) {
  const html = useMemo(() => renderMarkdown(text), [text])
  const renderCountRef = useRef(0)
  renderCountRef.current += 1

  const handleClick = (event: MouseEvent<HTMLDivElement>): void => {
    const target = event.target as HTMLElement | null
    if (!target) return

    const copyButton = target.closest<HTMLElement>('[data-qacopy="1"]')
    if (copyButton) {
      event.preventDefault()
      copyCodeFromButton(copyButton)
      return
    }

    const anchor = target.closest('a')
    if (!anchor) return
    event.preventDefault()
    const href = anchor.getAttribute('href') ?? ''
    if (isHttpUrl(href)) void window.quickask?.links.openExternal(href)
  }

  return (
    <div
      className={`qa-md${className ? ` ${className}` : ''}`}
      data-testid="markdown"
      data-streaming={streaming ? 'true' : undefined}
      data-render-count={renderCountRef.current}
      onClick={handleClick}
      onAuxClick={handleClick}
      dangerouslySetInnerHTML={{ __html: html }}
    />
  )
}
