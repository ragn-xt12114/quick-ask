#!/usr/bin/env node
/**
 * Deterministic history seeder for the 1000-session acceptance checks.
 *
 * DDL/migration code is imported from `src/main/db/schema.ts` through Node
 * 24's type stripping, so the seed DB uses the exact production v1 schema
 * instead of a duplicated copy. (Only the small open/pragma/transaction
 * orchestration is local to this tool.)
 *
 * Usage:
 *   node tools/seed-history.mjs --sessions 1000 --messages 10 --fts
 *   node tools/seed-history.mjs --sessions 1000 --messages 10 --fts --db /tmp/q.db
 *   node tools/seed-history.mjs --sessions 10 --messages 4 --fts --integrity
 *   node tools/seed-history.mjs --help
 */
import { chmodSync, existsSync, mkdirSync, rmSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { createRequire } from 'node:module'
import process from 'node:process'
import { performance } from 'node:perf_hooks'
function suppressExperimentalWarnings() {
  const original = process.emitWarning
  process.emitWarning = function (warning, ...args) {
    const text = typeof warning === 'string' ? warning : warning?.message
    if (
      typeof text === 'string' &&
      (text.includes('SQLite is an experimental feature') ||
        text.includes('MODULE_TYPELESS_PACKAGE_JSON') ||
        text.includes('Reparsing as ES module'))
    ) {
      return
    }
    return original.call(this, warning, ...args)
  }
}

suppressExperimentalWarnings()

// Node 24 type stripping: import the real schema (no duplicated DDL).
const {
  applyV1Schema,
  FTS_PROBE_CREATE_SQL,
  FTS_PROBE_DROP_SQL,
  REQUIRED_PRAGMAS,
  V1_FTS_DDL,
  V2_MIGRATION_DDL
} = await import('../src/main/db/schema.ts')
const { SCHEMA_VERSION } = await import('../src/main/db/version.ts')

const HELP = `Usage: node tools/seed-history.mjs [options]

Options:
  --sessions <n>    Number of sessions to seed (default 1000).
  --messages <n>    Messages per session (default 10).
  --fts             Create/populate the FTS5 trigram index.
  --db <path>       Database path (default $QUICKASK_DATA_DIR/quickask.db,
                    or .runtime/seed/quickask.db when the env var is unset).
  --append          Keep existing sessions instead of resetting a populated DB.
  --integrity       Run PRAGMA integrity_check after seeding.
  -h, --help        Show this help.
`

function parseArgs(argv) {
  const opts = {
    sessions: 1000,
    messages: 10,
    fts: false,
    db: join(
      process.env.QUICKASK_DATA_DIR
        ? resolve(process.env.QUICKASK_DATA_DIR)
        : join(process.cwd(), '.runtime', 'seed'),
      'quickask.db'
    ),
    append: false,
    integrity: false,
    help: false
  }
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]
    switch (arg) {
      case '-h':
      case '--help':
        opts.help = true
        break
      case '--sessions':
        i += 1
        if (i >= argv.length || !/^\d+$/.test(argv[i])) throw new Error('--sessions requires an integer')
        opts.sessions = Number(argv[i])
        break
      case '--messages':
        i += 1
        if (i >= argv.length || !/^\d+$/.test(argv[i])) throw new Error('--messages requires an integer')
        opts.messages = Number(argv[i])
        break
      case '--fts':
        opts.fts = true
        break
      case '--db':
        i += 1
        if (i >= argv.length) throw new Error('--db requires a path')
        opts.db = resolve(argv[i])
        break
      case '--append':
        opts.append = true
        break
      case '--integrity':
        opts.integrity = true
        break
      default:
        throw new Error(`unknown argument: ${arg}`)
    }
  }
  if (opts.sessions <= 0 || opts.messages <= 0) throw new Error('sessions/messages must be positive')
  return opts
}

function detectFtsSupport(db) {
  try {
    db.exec(FTS_PROBE_DROP_SQL)
    db.exec(FTS_PROBE_CREATE_SQL)
    db.exec(FTS_PROBE_DROP_SQL)
    return true
  } catch {
    try {
      db.exec(FTS_PROBE_DROP_SQL)
    } catch {
      // ignore
    }
    return false
  }
}

function tableExists(db, name) {
  const row = db
    .prepare("SELECT COUNT(*) AS count FROM sqlite_master WHERE type='table' AND name=?")
    .get(name)
  return Number(row.count) > 0
}

function countSessions(db) {
  try {
    return Number(db.prepare('SELECT COUNT(*) AS count FROM sessions').get().count)
  } catch {
    return 0
  }
}

function resetDatabaseFiles(dbPath) {
  for (const suffix of ['', '-wal', '-shm']) {
    const path = `${dbPath}${suffix}`
    if (existsSync(path)) rmSync(path)
  }
}

function applyPragmas(db) {
  for (const pragma of REQUIRED_PRAGMAS) db.exec(`PRAGMA ${pragma}`)
}

function hex(value, width) {
  return value.toString(16).padStart(width, '0').slice(-width)
}

/** Deterministic, valid UUIDv7-shaped id (fixed timestamp base + counter). */
function seedUuid(ms, counter) {
  const timestamp = hex(ms, 12)
  const low = counter & 0xfff
  const versionGroup = `7${hex((low >> 8) & 0xf, 1)}${hex(low & 0xff, 2)}`
  const randomish = hex((counter * 2654435761) >>> 0, 8) + hex((counter * 40503 + 17) >>> 0, 8)
  return `${timestamp.slice(0, 8)}-${timestamp.slice(8, 12)}-${versionGroup}-8${randomish.slice(0, 3)}-${randomish.slice(3, 15)}`
}

// Deterministic PRNG (mulberry32).
function createRandom(seed) {
  let state = seed >>> 0
  return function next() {
    state = (state + 0x6d2b79f5) >>> 0
    let t = state
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

const BASE_TS = Date.UTC(2025, 0, 1, 0, 0, 0)

const TITLE_TEMPLATES = [
  '排查 Electron 启动白屏',
  '如何优化 SQLite 查询性能',
  'React 状态更新不生效',
  'TypeScript 类型收窄技巧',
  'Linux 窗口置顶与焦点问题',
  'SQLite WAL 模式与崩溃恢复',
  'FTS5 trigram 中文搜索实践',
  'SSE 流式响应解析',
  'Electron 主进程内存占用',
  'KWin 透明窗口调试记录',
  'Keyring 凭据读取失败',
  '输入法候选框位置异常',
  '打包体积优化清单',
  '接口 429 限流与重试策略',
  'Markdown 渲染安全边界',
  '代理环境下证书校验',
  '多屏 DPI 缩放适配',
  'SQLite 事务与并发写',
  '前端列表虚拟滚动性能',
  'Electron IPC 安全校验',
  'Rust 与 Node 集成笔记',
  '国际化文案与排版',
  '缓存失效策略复盘',
  '数据库迁移回滚预案'
]

const USER_TEMPLATES = [
  '我在启动应用时遇到问题，能帮我分析一下可能原因吗？',
  '这个查询在 1000 条记录时明显变慢，应该如何优化？',
  '状态更新后界面没有重新渲染，是闭包问题还是依赖数组问题？',
  '请解释一下 TypeScript 在这个分支里的类型推断。',
  '窗口显示后输入框拿不到焦点，有哪些排查方向？',
  '数据库在异常退出后还能恢复吗？需要注意哪些配置？',
  '中文两字搜索走 FTS 还是 LIKE，为什么？',
  '流式响应里 JSON 被拆成多个块时该怎么处理？',
  '主进程长时间运行内存上涨，如何定位泄漏？',
  '透明窗口的边缘出现黑边，通常是什么原因？',
  '读取系统钥匙串失败时应该怎样降级？',
  '输入法组合期会触发搜索请求，如何避免？',
  '打包后体积比预期大很多，优先检查哪些文件？',
  '遇到 429 限流时自动重试会不会加重问题？',
  '渲染 Markdown 时如何阻止远程图片加载？',
  '公司代理需要额外证书，Electron 如何配置？',
  '多显示器切换后窗口位置错乱，怎么处理？',
  '多个写入同时发生时 SQLite 会怎样表现？',
  '长列表滚动掉帧，虚拟列表应该怎么接？',
  'IPC 调用如何确认请求来自可信页面？'
]

const ASSISTANT_TEMPLATES = [
  '可以从日志、启动参数和资源加载顺序三个方向排查，先确认渲染进程是否报错。',
  '建议给搜索字段建立索引，并避免在条件列上使用函数；再用 EXPLAIN QUERY PLAN 验证。',
  '先检查依赖数组是否遗漏，再用 useEffect 的清理函数确认订阅是否重复。',
  '这里的类型收窄依赖控制流分析，建议显式标注联合类型并避免不必要的类型断言。',
  '焦点问题通常与窗口激活顺序有关，可以在 show 之后调用 focus，并检查输入法状态。',
  'WAL 模式能提升并发读写，但退出前最好执行一次 checkpoint，并在启动时修复中断状态。',
  'trigram 适合中文子串搜索，但少于三个字符时需要回退到 LIKE，并注意转义通配符。',
  'SSE 需要按空行分隔事件，同时处理跨 chunk 的半行数据，避免把 JSON 提前解析。',
  '可以用 heap snapshot 对比两个时间点，重点关注监听器、定时器和缓存容器。',
  '黑边往往来自窗口 shape 或合成器缩放，建议记录窗口几何与合成器状态后再对比。',
  '钥匙串不可用时不要降级到明文，应该提示用户并在本次会话内仅保留内存凭据。',
  '监听 compositionstart/compositionend，在组合期暂停查询，结束后再做一次防抖查询。',
  '优先检查 source map、重复依赖和未压缩的静态资源，再考虑拆分不常用的模块。',
  '429 应该尊重 Retry-After，避免自动连续重试；由用户手动触发更安全。',
  '禁止远程图片需要在渲染层过滤 URL，同时依赖 CSP 的 img-src 作为第二道防线。',
  '代理证书问题可以通过系统证书库或显式配置 CA，不建议关闭证书校验。',
  '监听显示器变化事件，重新计算工作区边界，并限制窗口最小可见区域。',
  'SQLite 写事务是串行的，使用 BEGIN IMMEDIATE 可以尽早拿到写锁，避免升级死锁。',
  '虚拟列表只渲染可视区域，滚动时复用节点；注意测量行高并处理动态内容。',
  '在主进程校验 senderFrame 的 URL 和 webContents，拒绝任何非主窗口来源。'
]

function makeTitle(random, index) {
  const base = TITLE_TEMPLATES[index % TITLE_TEMPLATES.length]
  return `${base} #${index + 1}`
}

function makeContent(random, index, messageIndex, role) {
  const templates = role === 'user' ? USER_TEMPLATES : ASSISTANT_TEMPLATES
  const base = templates[(index * 3 + messageIndex) % templates.length]
  const tag = role === 'user' ? '问题' : '回答'
  return `${tag} ${messageIndex + 1}：${base} 参考编号 QA-${index + 1}-${messageIndex + 1}。`
}

function main() {
  const opts = parseArgs(process.argv.slice(2))
  if (opts.help) {
    process.stdout.write(HELP)
    return
  }

  const dbPath = resolve(opts.db)
  const dbDir = dirname(dbPath)
  mkdirSync(dbDir, { recursive: true, mode: 0o700 })
  try {
    chmodSync(dbDir, 0o700)
  } catch {
    // best effort
  }

  const { DatabaseSync } = requireNodeSqlite()
  const tOpen = performance.now()

  let db
  if (existsSync(dbPath)) {
    db = new DatabaseSync(dbPath)
    try {
      db.exec('PRAGMA quick_check')
    } catch {
      db.close()
      throw new Error(`existing DB is not readable; pass --append only for a valid DB: ${dbPath}`)
    }
    const existing = countSessions(db)
    if (existing > 0 && !opts.append) {
      db.close()
      process.stderr.write(`seed-history: resetting populated seed DB (${existing} sessions): ${dbPath}\n`)
      resetDatabaseFiles(dbPath)
      db = new DatabaseSync(dbPath)
    }
  } else {
    db = new DatabaseSync(dbPath)
  }

  try {
    chmodSync(dbPath, 0o600)
  } catch {
    // best effort
  }

  applyPragmas(db)

  const ftsSupported = detectFtsSupport(db)
  const ftsAvailable = opts.fts && ftsSupported

  const versionRow = db.prepare('PRAGMA user_version').get()
  const version = Number(Object.values(versionRow)[0])
  if (version > SCHEMA_VERSION) {
    throw new Error(`DB schema v${version} is newer than supported v${SCHEMA_VERSION}`)
  }
  if (version === 0) {
    if (countSessions(db) > 0) {
      throw new Error('existing unversioned DB has content; refusing to overwrite')
    }
    db.exec('BEGIN IMMEDIATE')
    try {
      applyV1Schema(db, { ftsAvailable })
      if (SCHEMA_VERSION >= 2) db.exec(V2_MIGRATION_DDL)
      db.exec(`PRAGMA user_version = ${SCHEMA_VERSION}`)
      db.exec('COMMIT')
    } catch (error) {
      db.exec('ROLLBACK')
      throw error
    }
  } else if (opts.fts && ftsSupported && !tableExists(db, 'session_search')) {
    db.exec(V1_FTS_DDL)
  }

  const ftsPresent = ftsSupported && tableExists(db, 'session_search')
  const openMs = performance.now() - tOpen

  const random = createRandom(0x51ced)
  const insertSession = db.prepare(
    `INSERT INTO sessions
       (id, title, title_auto, created_at, updated_at, last_message_at, model, system_prompt)
     VALUES (?, ?, 1, ?, ?, ?, 'mock-gpt', NULL)`
  )
  const insertMessage = db.prepare(
    `INSERT INTO messages
       (id, session_id, seq, role, content, status, error_code, error_detail, model, usage_json, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, 'complete', NULL, NULL, 'mock-gpt', NULL, ?, ?)`
  )
  const insertFts = ftsPresent
    ? db.prepare('INSERT INTO session_search (session_id, title, body) VALUES (?, ?, ?)')
    : null

  let sessionInsertMs
  let messageInsertMs
  let ftsInsertMs = 0
  let totalMessages = 0

  const tSeed = performance.now()
  db.exec('BEGIN IMMEDIATE')
  try {
    const tSessions = performance.now()
    for (let i = 0; i < opts.sessions; i += 1) {
      const sessionId = seedUuid(BASE_TS + i * 60_000, i + 1)
      const title = makeTitle(random, i)
      const createdAt = BASE_TS + i * 60_000
      const lastMessageAt = createdAt + opts.messages * 1_000
      insertSession.run(sessionId, title, createdAt, lastMessageAt, lastMessageAt)
    }
    sessionInsertMs = performance.now() - tSessions

    const tMessages = performance.now()
    const searchBodies = []
    for (let i = 0; i < opts.sessions; i += 1) {
      const sessionId = seedUuid(BASE_TS + i * 60_000, i + 1)
      const title = makeTitle(random, i)
      const createdAt = BASE_TS + i * 60_000
      const parts = []
      for (let m = 0; m < opts.messages; m += 1) {
        const role = m % 2 === 0 ? 'user' : 'assistant'
        const content = makeContent(random, i, m, role)
        const at = createdAt + m * 1_000
        insertMessage.run(
          seedUuid(at, (i + 1) * 1000 + m),
          sessionId,
          m,
          role,
          content,
          at,
          at
        )
        parts.push(content)
        totalMessages += 1
      }
      searchBodies.push({ sessionId, title, body: parts.join('\n').slice(0, 65_536) })
    }
    messageInsertMs = performance.now() - tMessages

    if (insertFts) {
      const tFts = performance.now()
      for (const row of searchBodies) {
        insertFts.run(row.sessionId, row.title, row.body)
      }
      ftsInsertMs = performance.now() - tFts
    }

    db.exec('COMMIT')
  } catch (error) {
    try {
      db.exec('ROLLBACK')
    } catch {
      // original error wins
    }
    throw error
  }
  const seedMs = performance.now() - tSeed

  const quickCheckRow = db.prepare('PRAGMA quick_check').get()
  const quickCheck = String(Object.values(quickCheckRow)[0])
  let integrity = null
  if (opts.integrity) {
    const rows = db.prepare('PRAGMA integrity_check').all()
    integrity = rows.map((row) => String(Object.values(row)[0])).join('\n')
  }

  const counts = {
    sessions: countSessions(db),
    messages: Number(db.prepare('SELECT COUNT(*) AS count FROM messages').get().count),
    ftsRows: ftsPresent
      ? Number(db.prepare('SELECT COUNT(*) AS count FROM session_search').get().count)
      : 0
  }
  const sqliteVersion = String(
    Object.values(db.prepare('SELECT sqlite_version() AS version').get())[0]
  )
  const defaultProviderCount = Number(
    db.prepare('SELECT COUNT(*) AS count FROM provider_profiles').get().count
  )

  db.close()

  const summary = {
    tool: 'seed-history',
    db: dbPath,
    requestedSessions: opts.sessions,
    requestedMessagesPerSession: opts.messages,
    insertedMessages: totalMessages,
    counts,
    defaultProviderCount,
    ftsRequested: opts.fts,
    ftsSupported,
    ftsAvailable: ftsPresent,
    schemaVersion: SCHEMA_VERSION,
    sqliteVersion,
    timingsMs: {
      openAndMigrate: Number(openMs.toFixed(2)),
      sessionInsert: Number(sessionInsertMs.toFixed(2)),
      messageInsert: Number(messageInsertMs.toFixed(2)),
      ftsInsert: Number(ftsInsertMs.toFixed(2)),
      seedTotal: Number(seedMs.toFixed(2))
    },
    quickCheck,
    integrity
  }

  process.stdout.write(`seeded ${counts.sessions} sessions / ${counts.messages} messages`)
  process.stdout.write(ftsPresent ? ` + ${counts.ftsRows} FTS rows` : ' (FTS disabled)')
  process.stdout.write(` in ${summary.timingsMs.seedTotal.toFixed(2)}ms\n`)
  process.stdout.write(`db: ${dbPath}\n`)
  process.stdout.write(`quick_check: ${quickCheck}\n`)
  if (integrity) process.stdout.write(`integrity_check: ${integrity}\n`)
  process.stdout.write(`SUMMARY ${JSON.stringify(summary)}\n`)

  if (quickCheck !== 'ok') process.exitCode = 1
  if (integrity && integrity !== 'ok') process.exitCode = 1
}

const nodeRequire = createRequire(import.meta.url)

function requireNodeSqlite() {
  // Called after the experimental warning filter is installed.
  return nodeRequire('node:sqlite')
}

main()
