import type { CSSProperties } from 'react'
import { Card } from './Card'
import { IconButton } from './IconButton'
import { IconMore, IconPlus, IconSettings } from './Icons'

export interface SidebarSession {
  id: string
  title: string
  time: string
  current?: boolean
}

export interface SidebarGroup {
  label: string
  items: SidebarSession[]
}

export interface SidebarShellProps {
  /** Absolute rect from `ui:state` layout (positioning stays in App). */
  style?: CSSProperties
  groups?: SidebarGroup[]
  version?: string
  onNew?: () => void
  onSelect?: (id: string) => void
  onOpenSettings?: () => void
}

/**
 * Static sample data — deliberately prefixed with "示例" so nobody mistakes
 * these rows for real sessions. Task 20 replaces them with the virtual list.
 */
export const SAMPLE_SIDEBAR_GROUPS: SidebarGroup[] = [
  {
    label: '今天',
    items: [
      { id: 'sample-design', title: '示例会话 · 设计讨论', time: '3 分钟', current: true },
      { id: 'sample-hotkey', title: '示例会话 · 快捷键方案', time: '1 小时' }
    ]
  },
  {
    label: '昨天',
    items: [{ id: 'sample-db', title: '示例会话 · 数据库迁移', time: '10-30' }]
  },
  {
    label: '更早',
    items: [
      { id: 'sample-pack', title: '示例会话 · 打包与发布', time: '10-28' },
      { id: 'sample-icons', title: '示例会话 · 图标草稿', time: '10-25' }
    ]
  }
]

/**
 * S3 history sidebar — §3.6. Width 260, padding 12, 48px session rows,
 * 32px title/footer rows, 36px search field. Static placeholders only.
 */
export function SidebarShell({
  style,
  groups = SAMPLE_SIDEBAR_GROUPS,
  version = 'v0.1',
  onNew,
  onSelect,
  onOpenSettings
}: SidebarShellProps) {
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

      <input
        className="qa-sidebar-search"
        data-testid="sidebar-search"
        type="search"
        placeholder="搜索会话…"
        aria-label="搜索会话"
        autoComplete="off"
        spellCheck={false}
      />

      <div className="qa-sidebar-scroll" data-testid="sidebar-scroll">
        {groups.map((group) => (
          <section className="qa-sidebar-group" key={group.label}>
            <div className="qa-sidebar-group-label">{group.label}</div>
            <div className="qa-sidebar-list">
              {group.items.map((item) => (
                <div
                  className={`qa-session-item${item.current ? ' qa-session-item--current' : ''}`}
                  key={item.id}
                  data-session-id={item.id}
                  data-current={item.current ? 'true' : undefined}
                >
                  <button
                    type="button"
                    className="qa-session-main"
                    onClick={() => onSelect?.(item.id)}
                  >
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

      <div className="qa-sidebar-footer">
        <button type="button" className="qa-footer-settings" onClick={onOpenSettings}>
          <IconSettings size={14} />
          <span>设置</span>
        </button>
        <span className="qa-sidebar-version" data-testid="sidebar-version">
          {version}
        </span>
      </div>
    </Card>
  )
}
