import { afterEach, describe, expect, it } from 'vitest'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { IPC } from '../../src/shared/channels'
import { openDbService, type DbService } from '../../src/main/db'
import { SettingsService } from '../../src/main/settings/service'
import { collectExportSessions, registerExportHandlers } from '../../src/main/export/handler'

const dirs: string[] = []
afterEach(() => {
  for (const dir of dirs.splice(0)) {
    try {
      rmSync(dir, { recursive: true, force: true })
    } catch {
      return
    }
  }
})

function makeServices(): { db: DbService; settings: SettingsService; dir: string } {
  const dir = mkdtempSync(join(tmpdir(), 'quickask-export-'))
  dirs.push(dir)
  const db = openDbService({ dataDir: dir, recover: false })
  const settings = new SettingsService(db)
  return { db, settings, dir }
}

function seed(db: DbService, id: string, title: string, updatedAt: number): void {
  db.sessions.create({
    id,
    title,
    titleAuto: false,
    createdAt: updatedAt,
    updatedAt,
    lastMessageAt: updatedAt,
    model: 'm'
  })
  db.messages.insert({
    id: `msg-${id}`,
    sessionId: id,
    seq: 0,
    role: 'user',
    content: `content of ${title}`,
    status: 'complete',
    createdAt: updatedAt,
    updatedAt
  })
  db.search.rebuild(id)
}

describe('sessions:export handler integration', () => {
  it('exports current scope to a temp path via injected dialog (no secrets)', async () => {
    const { db, settings, dir } = makeServices()
    const now = 1_700_000_000_000
    seed(db, 's-current', 'Current Title', now)
    seed(db, 's-other', 'Other', now)
    const services = { db, settings } as unknown as Parameters<
      typeof collectExportSessions
    >[0]
    const state = { getCurrentSessionId: () => 's-current' } as unknown as Parameters<
      typeof collectExportSessions
    >[1]
    const current = collectExportSessions(services, state, 'current')
    expect(current).toHaveLength(1)
    expect(current[0]!.session.id).toBe('s-current')
    const all = collectExportSessions(services, state, 'all')
    expect(all).toHaveLength(2)

    const captured = new Map<string, (...args: never[]) => unknown>()
    const router = {
      handle: (channel: string, _schema: unknown, handler: (...args: never[]) => unknown) => {
        captured.set(channel, handler)
      }
    } as unknown as Parameters<typeof registerExportHandlers>[0]
    const outDir = mkdtempSync(join(tmpdir(), 'quickask-export-out-'))
    dirs.push(outDir)
    const target = join(outDir, 'out.json')
    registerExportHandlers(
      router,
      () => ({ db, settings }) as never,
      () => state as never,
      {
        dialog: {
          showSaveDialog: async () => ({ canceled: false, filePath: target })
        }
      }
    )
    const handler = captured.get(IPC.SESSIONS_EXPORT) as unknown as (
      payload: { format: 'json'; scope: 'all' },
      context: { window: unknown }
    ) => Promise<{ ok: boolean; data?: { path: string; count: number; bytes: number } }>
    expect(handler).toBeDefined()
    const result = await handler({ format: 'json', scope: 'all' }, { window: {} })
    expect(result.ok).toBe(true)
    expect(result.data?.path).toBe(target)
    expect(result.data?.count).toBe(2)
    const body = readFileSync(target, 'utf8')
    expect(body).toContain('Current Title')
    expect(body).not.toMatch(/api[_-]?key|key_ref|secret/i)
    expect(settings.getData().lastExportPath).toBe(target)
    void dir
  })

  it('returns ABORTED when the save dialog is cancelled', async () => {
    const { db, settings } = makeServices()
    seed(db, 's1', 'T', 1_700_000_000_000)
    const captured = new Map<string, (...args: never[]) => unknown>()
    const router = {
      handle: (channel: string, _schema: unknown, handler: (...args: never[]) => unknown) => {
        captured.set(channel, handler)
      }
    } as unknown as Parameters<typeof registerExportHandlers>[0]
    registerExportHandlers(
      router,
      () => ({ db, settings }) as never,
      () => null,
      { dialog: { showSaveDialog: async () => ({ canceled: true }) } }
    )
    const handler = captured.get(IPC.SESSIONS_EXPORT) as unknown as (
      payload: { format: 'markdown'; scope: 'all' },
      context: { window: unknown }
    ) => Promise<{ ok: boolean; error?: { code: string } }>
    const result = await handler({ format: 'markdown', scope: 'all' }, { window: {} })
    expect(result.ok).toBe(false)
    expect(result.error?.code).toBe('ABORTED')
  })
})
