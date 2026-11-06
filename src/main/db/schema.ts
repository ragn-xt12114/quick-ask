/**
 * Authoritative v1 schema (plan C.2).
 *
 * This module intentionally has no runtime imports so `tools/seed-history.mjs`
 * can import it directly through Node 24 type stripping (`schema.ts`). The
 * DDL is therefore shared by the app, the migration runner and the seed tool.
 */

/** Schema version lives in `version.ts` so the seed tool can import it directly. */

export const REQUIRED_PRAGMAS = [
  'journal_mode = WAL',
  'synchronous = NORMAL',
  'foreign_keys = ON',
  'busy_timeout = 5000',
  'wal_autocheckpoint = 1000'
] as const

export const FTS_TABLE_NAME = 'session_search'

export const FTS_PROBE_CREATE_SQL =
  "CREATE VIRTUAL TABLE temp.__quickask_fts_probe USING fts5(x, tokenize='trigram')"

export const FTS_PROBE_DROP_SQL = 'DROP TABLE IF EXISTS temp.__quickask_fts_probe'

export const V1_CORE_DDL = `
CREATE TABLE sessions (
  id              TEXT PRIMARY KEY,
  title           TEXT NOT NULL DEFAULT '',
  title_auto      INTEGER NOT NULL DEFAULT 1,
  created_at      INTEGER NOT NULL,
  updated_at      INTEGER NOT NULL,
  last_message_at INTEGER,
  model           TEXT,
  system_prompt   TEXT
);

CREATE TABLE messages (
  id           TEXT PRIMARY KEY,
  session_id   TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  seq          INTEGER NOT NULL,
  role         TEXT NOT NULL CHECK (role IN ('user','assistant','system')),
  content      TEXT NOT NULL DEFAULT '',
  status       TEXT NOT NULL DEFAULT 'complete'
                 CHECK (status IN ('streaming','complete','stopped','interrupted','error')),
  error_code   TEXT,
  error_detail TEXT,
  model        TEXT,
  usage_json   TEXT,
  created_at   INTEGER NOT NULL,
  updated_at   INTEGER NOT NULL,
  UNIQUE (session_id, seq)
);

CREATE INDEX idx_sessions_updated ON sessions(updated_at DESC);
CREATE INDEX idx_messages_session_seq ON messages(session_id, seq);

CREATE TABLE drafts (
  id         TEXT PRIMARY KEY,
  session_id TEXT REFERENCES sessions(id) ON DELETE CASCADE,
  text       TEXT NOT NULL DEFAULT '',
  updated_at INTEGER NOT NULL
);

CREATE TABLE provider_profiles (
  id                TEXT PRIMARY KEY,
  name              TEXT NOT NULL,
  base_url          TEXT NOT NULL,
  model             TEXT NOT NULL DEFAULT '',
  key_ref           TEXT,
  header_names_json TEXT NOT NULL DEFAULT '[]',
  proxy_mode        TEXT NOT NULL DEFAULT 'system',
  proxy_url         TEXT,
  temperature       REAL,
  max_tokens        INTEGER,
  timeout_ms        INTEGER NOT NULL DEFAULT 30000,
  is_default        INTEGER NOT NULL DEFAULT 0,
  created_at        INTEGER NOT NULL,
  updated_at        INTEGER NOT NULL
);

CREATE TABLE settings (
  key        TEXT PRIMARY KEY,
  value_json TEXT NOT NULL,
  updated_at INTEGER NOT NULL
);
`

export const V2_MIGRATION_DDL =
  "ALTER TABLE messages ADD COLUMN images_json TEXT NOT NULL DEFAULT '[]'"

export const V1_FTS_DDL = `
CREATE VIRTUAL TABLE session_search USING fts5(
  session_id UNINDEXED,
  title,
  body,
  tokenize = 'trigram'
);
`

export interface SchemaDatabase {
  exec(sql: string): void
}

/** Apply the exact v1 DDL. FTS is skipped when trigram/FTS5 is unavailable. */
export function applyV1Schema(db: SchemaDatabase, options: { ftsAvailable: boolean }): void {
  db.exec(V1_CORE_DDL)
  if (options.ftsAvailable) {
    db.exec(V1_FTS_DDL)
  }
}
