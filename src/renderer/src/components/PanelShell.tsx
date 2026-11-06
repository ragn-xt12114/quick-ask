import { useEffect, useRef, useState, type CSSProperties, type ReactNode } from 'react'
import { Card } from './Card'
import { IconButton } from './IconButton'
import { IconAlert, IconStop } from './Icons'

export interface PanelError {
  message: string
  retryLabel?: string
  onRetry?: () => void
}

export interface ModelOption {
  id: string
  name: string
  model: string
  isDefault?: boolean
}

export interface PanelShellProps {
  /** Absolute rect from `ui:state` layout (positioning stays in App). */
  style?: CSSProperties
  title?: string
  model?: string | null
  /** Profiles offered by the quick-switch menu (`model-switch`). */
  modelOptions?: readonly ModelOption[]
  selectedProfileId?: string | null
  onSelectModel?: (id: string) => void
  /** Shows the stop button in the 28px info row and the blinking cursor. */
  streaming?: boolean
  /** New-session empty state: `Enter 发送 · Shift+Enter 换行`. */
  empty?: boolean
  error?: PanelError | null
  onStop?: () => void
  className?: string
  children?: ReactNode
}

/**
 * S2 conversation panel — §3.5.
 *
 * Deliberately contains NO input: the composer always lives in the bar.
 * Content is passed as children so Task 19 can slot Markdown rendering in
 * without changing the shell.
 */
export function PanelShell({
  style,
  title = '新会话',
  model = null,
  modelOptions = [],
  selectedProfileId = null,
  onSelectModel,
  streaming = false,
  empty = false,
  error = null,
  onStop,
  className = '',
  children
}: PanelShellProps) {
  const [menuOpen, setMenuOpen] = useState(false)
  const switchRef = useRef<HTMLSpanElement | null>(null)

  useEffect(() => {
    if (!menuOpen) return
    const onPointerDown = (event: PointerEvent): void => {
      if (!switchRef.current?.contains(event.target as Node)) setMenuOpen(false)
    }
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') setMenuOpen(false)
    }
    document.addEventListener('pointerdown', onPointerDown, true)
    window.addEventListener('keydown', onKeyDown, true)
    return () => {
      document.removeEventListener('pointerdown', onPointerDown, true)
      window.removeEventListener('keydown', onKeyDown, true)
    }
  }, [menuOpen])

  const canSwitch = modelOptions.length > 0 && typeof onSelectModel === 'function'

  return (
    <Card
      className={`qa-panel${className ? ` ${className}` : ''}`}
      data-testid="panel"
      style={style}
    >
      <div className="qa-panel-info">
        <span className="qa-panel-title" data-testid="panel-title">
          {title}
        </span>
        <span className="qa-panel-meta">
          {canSwitch ? (
            <span className="qa-model-switch-wrap" ref={switchRef}>
              <button
                type="button"
                className="qa-model-switch"
                data-testid="model-switch"
                aria-haspopup="listbox"
                aria-expanded={menuOpen}
                onClick={() => setMenuOpen((value) => !value)}
              >
                <span className="qa-panel-model" data-testid="panel-model">
                  {model ?? ''}
                </span>
                <span className="qa-model-switch-caret" aria-hidden="true">
                  ▾
                </span>
              </button>
              {menuOpen ? (
                <div className="qa-model-menu" role="listbox" data-testid="model-menu">
                  {modelOptions.map((option) => (
                    <button
                      key={option.id}
                      type="button"
                      role="option"
                      aria-selected={option.id === selectedProfileId}
                      className={`qa-model-option${
                        option.id === selectedProfileId ? ' qa-model-option--active' : ''
                      }`}
                      data-testid={`model-option-${option.id}`}
                      onClick={() => {
                        setMenuOpen(false)
                        onSelectModel?.(option.id)
                      }}
                    >
                      <span className="qa-model-option-name">{option.name}</span>
                      <span className="qa-model-option-model">{option.model}</span>
                      {option.isDefault ? (
                        <span className="qa-model-option-default">默认</span>
                      ) : null}
                    </button>
                  ))}
                </div>
              ) : null}
            </span>
          ) : model ? (
            <span className="qa-panel-model" data-testid="panel-model">
              {model}
            </span>
          ) : null}
          {streaming ? (
            <IconButton
              compact
              label="停止生成"
              tooltip="停止生成"
              data-testid="btn-stop"
              onClick={onStop}
            >
              <IconStop size={14} />
            </IconButton>
          ) : null}
        </span>
      </div>

      {empty ? (
        <EmptyState />
      ) : (
        <div className="qa-panel-body" data-testid="panel-body">
          {children}
          {streaming ? <span className="qa-stream-cursor" aria-hidden="true" /> : null}
        </div>
      )}

      {error ? (
        <ErrorBar
          message={error.message}
          retryLabel={error.retryLabel}
          onRetry={error.onRetry}
        />
      ) : null}
    </Card>
  )
}

export interface MessageProps {
  className?: string
  children: ReactNode
}

/** Right-aligned user bubble — max 78%, primary 12%, 12/12/4/12 radius. */
export function UserMessage({ className = '', children }: MessageProps) {
  return (
    <div data-role="user" className={`qa-msg qa-msg--user${className ? ` ${className}` : ''}`}>
      {children}
    </div>
  )
}

/** Left-aligned assistant text — no bubble, no avatar, 14px/1.7. */
export function AssistantMessage({ className = '', children }: MessageProps) {
  return (
    <div
      data-role="assistant"
      className={`qa-msg qa-msg--assistant${className ? ` ${className}` : ''}`}
    >
      {children}
    </div>
  )
}

export interface DataTableProps {
  headers: string[]
  rows: string[][]
}

/** Table placeholder — 1px border, tinted header, radius 8. */
export function DataTable({ headers, rows }: DataTableProps) {
  return (
    <div className="qa-table-wrap">
      <table className="qa-table">
        <thead>
          <tr>
            {headers.map((header) => (
              <th key={header} scope="col">
                {header}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((row, rowIndex) => (
            <tr key={`${rowIndex}-${row.join('|')}`}>
              {row.map((cell, cellIndex) => (
                <td key={`${cellIndex}-${cell}`}>{cell}</td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}

export interface ErrorBarProps {
  message: string
  retryLabel?: string
  onRetry?: () => void
}

/** Bottom error bar — red 12% background, alert icon, text and retry. */
export function ErrorBar({ message, retryLabel = '重试', onRetry }: ErrorBarProps) {
  return (
    <div className="qa-error" data-testid="panel-error" role="alert">
      <IconAlert size={14} className="qa-error-icon" />
      <span className="qa-error-text" title={message}>
        {message}
      </span>
      <button
        type="button"
        className="qa-error-retry"
        data-testid="error-retry"
        onClick={onRetry}
      >
        {retryLabel}
      </button>
    </div>
  )
}

/** New-session empty state — centered 12px/40% hint, no illustration. */
export function EmptyState() {
  return (
    <div className="qa-empty" data-testid="panel-empty">
      <span>Enter 发送 · Shift+Enter 换行</span>
    </div>
  )
}
