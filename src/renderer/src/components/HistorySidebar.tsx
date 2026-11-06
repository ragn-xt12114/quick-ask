/**
 * S3 history sidebar — REQUIREMENTS.md §3.6 / F-05 / F-06 (Task 20).
 *
 * Real sessions come from `sessions:list` (DB handles LIKE for 1–2 CJK
 * characters and quoted FTS MATCH for 3+). The list is manually windowed:
 * only visible rows plus 10-row overscan exist in the DOM, so 1000 sessions
 * never produce 1000 nodes.
 *
 * `?visual=1` keeps the Task 14 static sample markup byte-compatible with the
 * screenshot baseline; real user data never renders in visual mode.
 */

import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type KeyboardEvent as ReactKeyboardEvent,
  type MouseEvent as ReactMouseEvent
} from 'react'
import type { SessionSummary } from '../../../shared/channels'
import {
  HISTORY_ITEM_HEIGHT,
  buildHistoryRows,
  computeVirtualWindow,
  formatRelativeTime,
  historyTotalHeight,
  normalizeHistoryTitle,
  type HistoryRow
} from '../lib/history'
import { Card } from './Card'
import { IconButton } from './IconButton'
import { IconMore, IconPlus, IconSettings } from './Icons'
import { SAMPLE_SIDEBAR_GROUPS } from './SidebarShell'

export interface HistorySidebarProps {
  /** Absolute rect from `ui:state` layout (positioning stays in App). */
  style?: CSSProperties
  currentSessionId?: string | null
  version?: string
  visual?: boolean
  onNew?: () => void
  onSelect?: (id: string) => void
  /** App owns the stop→delete→reset ordering for the current session. */
  onDeleteCurrent?: (id: string) => Promise<boolean>
  onOpenSettings?: () => void
}

const SEARCH_DEBOUNCE_MS = 120
const SELECT_DELAY_MS = 180
const HISTORY_LIMIT = 1000

interface MenuState {
  id: string
  top: number
}

interface ConfirmState {
  id: string
  title: string
  top: number
}

function isComposingKey(event: ReactKeyboardEvent<HTMLElement>): boolean {
  return event.nativeEvent.isComposing || event.keyCode === 229
}

export function HistorySidebar({
  style,
  currentSessionId = null,
  version = 'v0.1',
  visual = false,
  onNew,
  onSelect,
  onDeleteCurrent,
  onOpenSettings
}: HistorySidebarProps) {
  const [sessions, setSessions] = useState<SessionSummary[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [query, setQuery] = useState('')
  const [appliedQuery, setAppliedQuery] = useState('')
  const [pending, setPending] = useState(false)
  const [refreshSeq, setRefreshSeq] = useState(0)
  const [viewportHeight, setViewportHeight] = useState(0)
  const [scrollTop, setScrollTop] = useState(0)
  const [menu, setMenu] = useState<MenuState | null>(null)
  const [confirm, setConfirm] = useState<ConfirmState | null>(null)
  const [editingId, setEditingId] = useState<string | null>(null)
  const [renameValue, setRenameValue] = useState('')
  const [busy, setBusy] = useState(false)

  const scrollRef = useRef<HTMLDivElement>(null)
  const searchTimerRef = useRef<number | null>(null)
  const searchComposingRef = useRef(false)
  const appliedQueryRef = useRef('')
  const renameComposingRef = useRef(false)
  const selectTimerRef = useRef<number | null>(null)
  const renameInputRef = useRef<HTMLInputElement>(null)

  const clearSearchTimer = useCallback((): void => {
    if (searchTimerRef.current !== null) {
      window.clearTimeout(searchTimerRef.current)
      searchTimerRef.current = null
    }
  }, [])

  const clearSelectTimer = useCallback((): void => {
    if (selectTimerRef.current !== null) {
      window.clearTimeout(selectTimerRef.current)
      selectTimerRef.current = null
    }
  }, [])

  // ------------------------------------------------------------------
  // Data: debounced search (120ms) with IME composition guard
  // ------------------------------------------------------------------
  useEffect(() => {
    if (visual) return
    const api = window.quickask
    if (!api) {
      setSessions([])
      setError('preload API unavailable')
      return
    }

    let cancelled = false
    setPending(true)
    setError(null)
    api.sessions
      .list({ query: appliedQuery.length > 0 ? appliedQuery : undefined, limit: HISTORY_LIMIT })
      .then((result) => {
        if (cancelled) return
        if (result.ok) {
          setSessions(result.data.sessions)
        } else {
          setSessions([])
          setError('历史加载失败')
        }
      })
      .catch(() => {
        if (cancelled) return
        setSessions([])
        setError('历史加载失败')
      })
      .finally(() => {
        if (!cancelled) setPending(false)
      })

    return () => {
      cancelled = true
    }
  }, [appliedQuery, refreshSeq, visual])

  useEffect(() => clearSearchTimer, [clearSearchTimer])
  useEffect(() => clearSelectTimer, [clearSelectTimer])

  useEffect(() => {
    if (visual) return
    const el = scrollRef.current
    if (!el) return
    el.scrollTop = 0
    setScrollTop(0)
    setMenu(null)
    setConfirm(null)
  }, [appliedQuery, refreshSeq, visual])

  useLayoutEffect(() => {
    if (visual) return
    const el = scrollRef.current
    if (!el) return
    const measure = (): void => {
      setViewportHeight((current) => (current === el.clientHeight ? current : el.clientHeight))
    }
    measure()
    const observer = new ResizeObserver(measure)
    observer.observe(el)
    return () => observer.disconnect()
  }, [visual])

  const applyQuery = useCallback((value: string): void => {
    if (appliedQueryRef.current === value) return
    appliedQueryRef.current = value
    // Mark pending before the applied-query attribute changes so observers
    // never mistake the pre-debounce result count for the new query's result.
    setPending(true)
    setAppliedQuery(value)
  }, [])

  const handleSearchChange = useCallback(
    (value: string): void => {
      setQuery(value)
      clearSearchTimer()
      if (searchComposingRef.current) return
      searchTimerRef.current = window.setTimeout(() => {
        searchTimerRef.current = null
        applyQuery(value)
      }, SEARCH_DEBOUNCE_MS)
    },
    [applyQuery, clearSearchTimer]
  )

  const handleSearchCompositionStart = useCallback((): void => {
    searchComposingRef.current = true
    clearSearchTimer()
  }, [clearSearchTimer])

  const handleSearchCompositionEnd = useCallback(
    (value: string): void => {
      searchComposingRef.current = false
      clearSearchTimer()
      applyQuery(value)
    },
    [applyQuery, clearSearchTimer]
  )

  // ------------------------------------------------------------------
  // Rows / virtual window
  // ------------------------------------------------------------------
  const rows = useMemo<HistoryRow[]>(
    () => (sessions ? buildHistoryRows(sessions, Date.now()) : []),
    [sessions]
  )
  const totalHeight = useMemo(() => historyTotalHeight(rows), [rows])
  const windowRange = useMemo(
    () => computeVirtualWindow(rows, scrollTop, viewportHeight),
    [rows, scrollTop, viewportHeight]
  )
  const visibleRows = rows.slice(windowRange.start, windowRange.end)
  const renderedItemCount = visibleRows.reduce(
    (count, row) => (row.kind === 'item' ? count + 1 : count),
    0
  )

  const closePopovers = useCallback((): void => {
    setMenu(null)
    setConfirm(null)
  }, [])

  const handleScroll = useCallback((): void => {
    const el = scrollRef.current
    if (!el) return
    setScrollTop(el.scrollTop)
    if (menu || confirm) closePopovers()
  }, [closePopovers, confirm, menu])

  const popoverTop = useCallback((target: HTMLElement): number => {
    const card = target.closest('.qa-sidebar') as HTMLElement | null
    const row = target.closest('.qa-history-row, .qa-session-item') as HTMLElement | null
    if (!card || !row) return 0
    const cardRect = card.getBoundingClientRect()
    const rowRect = row.getBoundingClientRect()
    return Math.max(0, Math.round(rowRect.bottom - cardRect.top - 4))
  }, [])

  const handleMoreClick = useCallback(
    (event: ReactMouseEvent<HTMLElement>, session: SessionSummary): void => {
      event.stopPropagation()
      setConfirm(null)
      setMenu({ id: session.id, top: popoverTop(event.currentTarget) })
    },
    [popoverTop]
  )

  const beginRename = useCallback(
    (session: SessionSummary): void => {
      closePopovers()
      setEditingId(session.id)
      setRenameValue(session.title)
      renameComposingRef.current = false
      window.requestAnimationFrame(() => {
        renameInputRef.current?.focus()
        renameInputRef.current?.select()
      })
    },
    [closePopovers]
  )

  const cancelRename = useCallback((): void => {
    setEditingId(null)
    setRenameValue('')
  }, [])

  const commitRename = useCallback(async (): Promise<void> => {
    const id = editingId
    if (!id || busy) return
    const api = window.quickask
    if (!api) return
    const title = normalizeHistoryTitle(renameValue)
    const current = sessions?.find((session) => session.id === id)
    if (title.length === 0) {
      cancelRename()
      return
    }
    if (current && title === current.title) {
      cancelRename()
      return
    }

    setBusy(true)
    try {
      const result = await api.sessions.rename({ id, title })
      if (result.ok) {
        setSessions((list) =>
          list
            ? list.map((session) =>
                session.id === id
                  ? {
                      ...session,
                      title: result.data.title,
                      updatedAt: result.data.updatedAt
                    }
                  : session
              )
            : list
        )
        setRefreshSeq((value) => value + 1)
      } else {
        setError('重命名失败')
      }
    } finally {
      setBusy(false)
      cancelRename()
    }
  }, [busy, cancelRename, editingId, renameValue, sessions])

  const handleRenameKeyDown = useCallback(
    (event: ReactKeyboardEvent<HTMLInputElement>): void => {
      if (renameComposingRef.current || isComposingKey(event)) {
        // Composition Enter must never commit; Esc belongs to the IME too.
        if (event.key === 'Enter' || event.key === 'Escape') event.preventDefault()
        return
      }
      if (event.key === 'Enter') {
        event.preventDefault()
        void commitRename()
        return
      }
      if (event.key === 'Escape') {
        event.preventDefault()
        cancelRename()
      }
    },
    [cancelRename, commitRename]
  )

  const openDeleteConfirm = useCallback(
    (session: SessionSummary): void => {
      const top = menu?.top ?? 0
      setMenu(null)
      setConfirm({ id: session.id, title: session.title, top })
    },
    [menu]
  )

  const removeLocal = useCallback((id: string): void => {
    setSessions((list) => (list ? list.filter((session) => session.id !== id) : list))
  }, [])

  const confirmDelete = useCallback(async (): Promise<void> => {
    if (!confirm || busy) return
    const target = confirm
    const api = window.quickask
    setBusy(true)
    try {
      if (currentSessionId === target.id) {
        if (onDeleteCurrent) {
          const ok = await onDeleteCurrent(target.id)
          if (ok) removeLocal(target.id)
          else setError('删除失败')
        }
      } else if (api) {
        const result = await api.sessions.delete({ id: target.id })
        if (result.ok && result.data.deleted) removeLocal(target.id)
        else if (!result.ok || !result.data.deleted) setError('删除失败')
      }
    } finally {
      setBusy(false)
      setConfirm(null)
    }
  }, [busy, confirm, currentSessionId, onDeleteCurrent, removeLocal])

  // Single click selects after a short delay so a double-click can rename
  // without first closing the sidebar.
  const handleItemClick = useCallback(
    (session: SessionSummary): void => {
      if (editingId === session.id) return
      if (selectTimerRef.current !== null) {
        clearSelectTimer()
        return
      }
      selectTimerRef.current = window.setTimeout(() => {
        selectTimerRef.current = null
        onSelect?.(session.id)
      }, SELECT_DELAY_MS)
    },
    [clearSelectTimer, editingId, onSelect]
  )

  const handleItemDoubleClick = useCallback(
    (event: ReactMouseEvent<HTMLElement>, session: SessionSummary): void => {
      event.preventDefault()
      event.stopPropagation()
      clearSelectTimer()
      beginRename(session)
    },
    [beginRename, clearSelectTimer]
  )

  useEffect(() => {
    if (!menu && !confirm) return
    const onPointerDown = (event: PointerEvent): void => {
      const target = event.target as HTMLElement | null
      if (!target) return
      if (target.closest('[data-testid="history-menu"]')) return
      if (target.closest('[data-testid="delete-confirm"]')) return
      if (target.closest('.qa-session-more')) return
      closePopovers()
    }
    document.addEventListener('pointerdown', onPointerDown, true)
    return () => document.removeEventListener('pointerdown', onPointerDown, true)
  }, [closePopovers, confirm, menu])

  const activeSession = menu
    ? sessions?.find((session) => session.id === menu.id) ?? null
    : null
  const emptyText =
    appliedQuery.length > 0 ? '没有匹配的会话' : '暂无历史'

  return (
    <Card className="qa-sidebar" data-testid="sidebar" style={style}>
      <div className="qa-sidebar-title-row">
        <span className="qa-sidebar-title">历史</span>
        <IconButton
          compact
          label="新建会话"
          tooltip="新建会话 (Ctrl+N)"
          data-testid="sidebar-btn-new"
          onClick={onNew}
        >
          <IconPlus size={16} />
        </IconButton>
      </div>

      <div className="qa-sidebar-search-wrap" data-testid="history-search">
        <input
          className="qa-sidebar-search"
          data-testid="sidebar-search"
          type="search"
          placeholder="搜索会话…"
          aria-label="搜索会话"
          autoComplete="off"
          spellCheck={false}
          value={visual ? undefined : query}
          onChange={visual ? undefined : (event) => handleSearchChange(event.target.value)}
          onCompositionStart={visual ? undefined : handleSearchCompositionStart}
          onCompositionEnd={
            visual ? undefined : (event) => handleSearchCompositionEnd(event.currentTarget.value)
          }
        />
      </div>

      {visual ? (
        <div className="qa-sidebar-scroll" data-testid="sidebar-scroll">
          {SAMPLE_SIDEBAR_GROUPS.map((group) => (
            <section className="qa-sidebar-group" key={group.label}>
              <div className="qa-sidebar-group-label">{group.label}</div>
              <div className="qa-sidebar-list">
                {group.items.map((item) => (
                  <div
                    className={`qa-session-item${
                      item.current ? ' qa-session-item--current' : ''
                    }`}
                    key={item.id}
                    data-session-id={item.id}
                    data-testid="history-item"
                    data-current={item.current ? 'true' : undefined}
                  >
                    <button type="button" className="qa-session-main">
                      <span className="qa-session-title">{item.title}</span>
                      <span className="qa-session-time">{item.time}</span>
                    </button>
                    <IconButton
                      compact
                      className="qa-session-more"
                      label={`${item.title} 菜单`}
                      tooltip="会话菜单"
                    >
                      <IconMore size={16} />
                    </IconButton>
                  </div>
                ))}
              </div>
            </section>
          ))}
        </div>
      ) : (
        <div
          className="qa-sidebar-scroll"
          data-testid="sidebar-scroll"
          data-applied-query={appliedQuery}
          data-result-count={sessions?.length ?? 0}
          data-rendered-items={renderedItemCount}
          data-pending={pending ? 'true' : 'false'}
          ref={scrollRef}
          onScroll={handleScroll}
        >
          {sessions === null ? null : rows.length === 0 ? (
            <div className="qa-history-empty" data-testid="history-empty">
              {emptyText}
            </div>
          ) : (
            <div className="qa-history-vlist" style={{ height: `${totalHeight}px` }}>
              {visibleRows.map((row) =>
                row.kind === 'group' ? (
                  <div
                    className="qa-history-row"
                    key={row.key}
                    style={{ top: `${row.top}px`, height: `${row.height}px` }}
                  >
                    <div className="qa-sidebar-group-label" data-testid="history-group">
                      {row.label}
                    </div>
                  </div>
                ) : (
                  <div
                    className="qa-history-row"
                    key={row.key}
                    style={{ top: `${row.top}px`, height: `${row.height}px` }}
                  >
                    <div
                      className={`qa-session-item${
                        row.session.id === currentSessionId
                          ? ' qa-session-item--current'
                          : ''
                      }`}
                      style={{ height: `${HISTORY_ITEM_HEIGHT}px` }}
                      data-session-id={row.session.id}
                      data-testid="history-item"
                      data-current={
                        row.session.id === currentSessionId ? 'true' : undefined
                      }
                    >
                      {editingId === row.session.id ? (
                        <div className="qa-session-main qa-session-main--editing">
                          <input
                            ref={renameInputRef}
                            className="qa-session-title-input"
                            data-testid="rename-input"
                            value={renameValue}
                            maxLength={80}
                            aria-label="重命名会话"
                            onChange={(event) => setRenameValue(event.target.value)}
                            onKeyDown={handleRenameKeyDown}
                            onCompositionStart={() => {
                              renameComposingRef.current = true
                            }}
                            onCompositionEnd={() => {
                              renameComposingRef.current = false
                            }}
                            onClick={(event) => event.stopPropagation()}
                            onDoubleClick={(event) => event.stopPropagation()}
                          />
                        </div>
                      ) : (
                        <button
                          type="button"
                          className="qa-session-main"
                          onClick={() => handleItemClick(row.session)}
                          onDoubleClick={(event) => handleItemDoubleClick(event, row.session)}
                        >
                          <span className="qa-session-title">{row.session.title}</span>
                          <span className="qa-session-time">
                            {formatRelativeTime(row.session.updatedAt)}
                          </span>
                        </button>
                      )}
                      <IconButton
                        compact
                        className="qa-session-more"
                        label={`${row.session.title} 菜单`}
                        tooltip="会话菜单"
                        onClick={(event) => handleMoreClick(event, row.session)}
                      >
                        <IconMore size={16} />
                      </IconButton>
                    </div>
                  </div>
                )
              )}
            </div>
          )}
        </div>
      )}

      {error ? (
        <div className="qa-history-error" data-testid="history-error" role="status">
          {error}
        </div>
      ) : null}

      <div className="qa-sidebar-footer">
        <button
          type="button"
          className="qa-footer-settings"
          data-testid="sidebar-settings"
          onClick={onOpenSettings}
        >
          <IconSettings size={14} />
          <span>设置</span>
        </button>
        <span className="qa-sidebar-version" data-testid="sidebar-version">
          {version}
        </span>
      </div>

      {!visual && menu && activeSession ? (
        <div
          className="qa-history-menu"
          data-testid="history-menu"
          style={{ top: `${menu.top}px` }}
          role="menu"
        >
          <button
            type="button"
            className="qa-history-menu-item"
            onClick={() => beginRename(activeSession)}
          >
            重命名
          </button>
          <button
            type="button"
            className="qa-history-menu-item qa-history-menu-item--danger"
            onClick={() => openDeleteConfirm(activeSession)}
          >
            删除
          </button>
        </div>
      ) : null}

      {!visual && confirm ? (
        <div
          className="qa-history-confirm"
          data-testid="delete-confirm"
          style={{ top: `${confirm.top}px` }}
          role="dialog"
          aria-modal="false"
          aria-label="删除会话确认"
        >
          <p className="qa-history-confirm-text">删除「{confirm.title}」？</p>
          <div className="qa-history-confirm-actions">
            <button
              type="button"
              className="qa-history-confirm-btn"
              data-testid="delete-cancel"
              onClick={() => setConfirm(null)}
            >
              取消
            </button>
            <button
              type="button"
              className="qa-history-confirm-btn qa-history-confirm-btn--danger"
              data-testid="delete-confirm-button"
              disabled={busy}
              onClick={() => void confirmDelete()}
            >
              删除
            </button>
          </div>
        </div>
      ) : null}
    </Card>
  )
}
