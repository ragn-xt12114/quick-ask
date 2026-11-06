import { afterEach, describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { openDbService, type DbService } from '../../src/main/db'
import {
  cutoffForRetention,
  pruneOldSessions,
  RetentionService
} from '../../src/main/data/retention'

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

function makeDb(): { db: DbService; dir: string } {
  const dir = mkdtempSync(join(tmpdir(), 'quickask-retention-'))
  dirs.push(dir)
  const db = openDbService({ dataDir: dir, recover: false })
  return { db, dir }
}

const DAY = 86_400_000

function seedSession(db: DbService, id: string, updatedAt: number, withDraft = false): void {
  db.sessions.create({
    id,
    title: `title-${id}`,
    titleAuto: false,
    createdAt: updatedAt,
    updatedAt,
    lastMessageAt: updatedAt,
    model: null
  })
  db.messages.insert({
    id: `m-${id}`,
    sessionId: id,
    seq: 0,
    role: 'user',
    content: `hello ${id}`,
    status: 'complete',
    createdAt: updatedAt,
    updatedAt
  })
  db.search.rebuild(id)
  if (withDraft) db.setDraft(id, `draft ${id}`)
}

describe('retention cleanup', () => {
  it('returns null cutoff and deletes nothing when retention is null', () => {
    const { db } = makeDb()
    const now = 1_700_000_000_000
    seedSession(db, 's-old', now - 400 * DAY)
    expect(cutoffForRetention(null, now)).toBeNull()
    const result = pruneOldSessions(db, { retentionDays: null, now })
    expect(result.cleaned).toBe(0)
    expect(db.sessions.count()).toBe(1)
  })

  it('deletes old sessions and keeps recent ones', () => {
    const { db } = makeDb()
    const now = 1_700_000_000_000
    seedSession(db, 's-old', now - 40 * DAY)
    seedSession(db, 's-recent', now - 2 * DAY)
    const result = pruneOldSessions(db, { retentionDays: 30, now })
    expect(result.cleaned).toBe(1)
    expect(db.getSession('s-old')).toBeNull()
    expect(db.getSession('s-recent')).not.toBeNull()
  })

  it('keeps the current session even when it is old', () => {
    const { db } = makeDb()
    const now = 1_700_000_000_000
    seedSession(db, 's-current', now - 90 * DAY)
    seedSession(db, 's-other-old', now - 90 * DAY)
    const result = pruneOldSessions(db, {
      retentionDays: 30,
      now,
      excludeSessionIds: ['s-current']
    })
    expect(result.cleaned).toBe(1)
    expect(db.getSession('s-current')).not.toBeNull()
    expect(db.getSession('s-other-old')).toBeNull()
  })

  it('cleans FTS rows, messages and drafts for deleted sessions', () => {
    const { db } = makeDb()
    const now = 1_700_000_000_000
    seedSession(db, 's-old', now - 60 * DAY, true)
    expect(db.search.count()).toBe(1)
    expect(db.getDraft('s-old')).toBe('draft s-old')
    pruneOldSessions(db, { retentionDays: 30, now })
    expect(db.getMessages('s-old')).toEqual([])
    expect(db.getDraft('s-old')).toBe('')
    expect(db.search.search('hello', 10)).toEqual([])
  })

  it('RetentionService never deletes without an explicit setting and logs counts', () => {
    const { db } = makeDb()
    const now = 1_700_000_000_000
    seedSession(db, 's-old', now - 60 * DAY)
    let retentionDays: number | null = null
    const service = new RetentionService(() => db, () => retentionDays, () => null)
    const idle = service.runOnce(now)
    expect(idle.cleaned).toBe(0)
    expect(db.sessions.count()).toBe(1)
    retentionDays = 30
    const cleaned = service.runOnce(now)
    expect(cleaned.cleaned).toBe(1)
    expect(cleaned.lastCleanupAt).toBe(now)
    expect(service.status().lastCleaned).toBe(1)
    service.stop()
  })
})
