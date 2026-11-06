#!/usr/bin/env node
/**
 * Dependency-free mock OpenAI-compatible SSE server for QuickAsk tests.
 *
 * Usage:
 *   node tools/mock-sse-server.mjs [--port 18080] [--chunks 5] [--delay 200]
 *                                  [--mode normal|...]
 *                                  [--content-file <path>]
 *                                  [--log <file>] [--body-log <file>]
 *   node tools/mock-sse-server.mjs --help
 *
 * Modes (Task 5 subset stays CLI-compatible):
 *   normal       N content chunks then data: [DONE]
 *   429          HTTP 429 JSON rate-limit error (no SSE body)
 *   500          HTTP 500 JSON server error (no SSE body)
 *   error        one content chunk then an SSE {"error":...} event
 *   utf8-split   one event whose raw UTF-8 bytes are split every 5 bytes
 *   no-done      N content chunks then a clean close (no [DONE])
 *   malformed    invalid JSON in a data: line (client must stop)
 *   slow         defaults to 100 chunks / 100 ms (abort test)
 *   multiline    JSON payload split across multiple data: lines
 *   json-200     HTTP 200 application/json error body instead of SSE
 *   usage        final chunk carries finish_reason + usage
 *   reasoning    delta.reasoning_content chunks (ignored) + content
 *   comment      SSE comment lines (":") and blank lines around content
 *   markdown     streams the Markdown safety fixture (or --content-file)
 *                in 24 chunks with 15 ms between chunks.
 *
 * Per-request override:
 *   POST /v1/chat/completions?mode=slow&chunks=100&delay=100
 *
 * Routes:
 *   POST /v1/chat/completions   SSE stream (or an HTTP/JSON error per mode)
 *   GET  /health                {"status":"ok"}
 *   *                          404 JSON
 *
 * Logging (--log):
 *   POST /v1/chat/completions mode=<mode> chunks=<n> delay=<ms>
 *   served <n> chunks at +<ms>ms
 *   client closed after <n> chunks at +<ms>ms   (client went away early)
 *   response completed after <n> chunks at +<ms>ms
 */
import http from 'node:http'
import { appendFileSync, mkdirSync, readFileSync } from 'node:fs'
import { dirname } from 'node:path'
import process from 'node:process'

const MODES = new Set([
  'normal',
  'slow',
  '429',
  '500',
  'error',
  'utf8-split',
  'multiline',
  'no-done',
  'malformed',
  'json-200',
  'usage',
  'reasoning',
  'comment',
  'markdown'
])

const MARKDOWN_FIXTURE = [
  '# Markdown 安全夹具',
  '',
  '第一段包含原始 HTML：<img src=x onerror="window.__xss=1"> 与 <script>window.__xss=1</script>。',
  '',
  '危险链接 [bad](javascript:alert(1))，安全链接 [ok](https://example.com)。',
  '',
  '远程图片：![tracker](https://tracker.example/x.png)',
  '',
  '| 列A | 列B |',
  '| --- | --- |',
  '| 1 | 2 |',
  '| 三 | 四 |',
  '',
  '> 引用段落',
  '',
  '- 列表一',
  '- 列表二',
  '',
  '行内代码 `npm run build` 与数学文本 $x^2$。',
  '',
  '```js',
  'const order = ["history", "expand", "new"]',
  'console.log(order.length)',
  '```',
  '',
  '结尾段落用于确认流式内容完整。'
].join('\n')

let markdownContent = MARKDOWN_FIXTURE

function splitIntoChunks(text, count) {
  const parts = Math.max(1, count)
  if (parts === 1 || text.length === 0) return [text]
  const size = Math.max(1, Math.ceil(text.length / parts))
  const chunks = []
  for (let offset = 0; offset < text.length; offset += size) {
    chunks.push(text.slice(offset, offset + size))
  }
  return chunks
}

const HELP = `Usage: node tools/mock-sse-server.mjs [options]

Options:
  --host <h>     Listening host (default: 127.0.0.1).
  --port <n>     Listening port (default: 18080; 0 = ephemeral).
  --chunks <n>   Number of content chunks to emit (default: 5; slow: 100).
  --delay <ms>   Delay between chunks in milliseconds (default: 200; slow: 100).
  --mode <mode>  ${[...MODES].join(' | ')}
                 (default: normal).
  --log <file>   Append one line per request ("POST /v1/chat/completions"),
                 chunk counts and close timing ("client closed after N chunks
                 at +Xms") to a file.
  --body-log <file>  Append each raw JSON request body on its own line
                 (test-only capture for multi-turn context assertions).
  --content-file <path>  Stream this file instead of the built-in markdown
                 fixture when --mode markdown (split into --chunks pieces).
  -h, --help     Show this help and exit.

Per-request mode selection:
  POST /v1/chat/completions?mode=slow&chunks=100&delay=100
  (query values override --mode/--chunks/--delay for that request)

Routes:
  POST /v1/chat/completions   OpenAI-compatible SSE stream.
  GET  /health                {"status":"ok"}
`

function fail(message) {
  process.stderr.write(`mock-sse-server: ${message}\n`)
  process.exit(2)
}

function parseArgs(argv) {
  const opts = {
    host: '127.0.0.1',
    port: 18080,
    chunks: 5,
    delay: 200,
    mode: 'normal',
    log: null,
    bodyLog: null,
    contentFile: null,
    help: false,
    chunksExplicit: false,
    delayExplicit: false
  }

  const readInt = (raw, name, min) => {
    const value = Number(raw)
    if (!Number.isInteger(value) || value < min) {
      fail(`${name} must be an integer >= ${min}, got: ${raw}`)
    }
    return value
  }

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]
    switch (arg) {
      case '-h':
      case '--help':
        opts.help = true
        break
      case '--host':
        i += 1
        if (i >= argv.length) fail('--host requires a value')
        opts.host = argv[i]
        break
      case '--port':
        i += 1
        opts.port = readInt(argv[i], '--port', 0)
        break
      case '--chunks':
        i += 1
        opts.chunks = readInt(argv[i], '--chunks', 0)
        opts.chunksExplicit = true
        break
      case '--delay':
        i += 1
        opts.delay = readInt(argv[i], '--delay', 0)
        opts.delayExplicit = true
        break
      case '--mode':
        i += 1
        if (!MODES.has(argv[i])) fail(`--mode must be one of: ${[...MODES].join(', ')}`)
        opts.mode = argv[i]
        break
      case '--log':
        i += 1
        if (i >= argv.length) fail('--log requires a path')
        opts.log = argv[i]
        break
      case '--body-log':
        i += 1
        if (i >= argv.length) fail('--body-log requires a path')
        opts.bodyLog = argv[i]
        break
      case '--content-file':
        i += 1
        if (i >= argv.length) fail('--content-file requires a path')
        opts.contentFile = argv[i]
        break
      default:
        fail(`unknown argument: ${arg}`)
    }
  }

  applySlowDefaults(opts, opts.mode)
  applyMarkdownDefaults(opts, opts.mode)
  return opts
}

function applySlowDefaults(target, mode) {
  if (mode !== 'slow') return target
  if (!target.chunksExplicit) target.chunks = 100
  if (!target.delayExplicit) target.delay = 100
  return target
}

function applyMarkdownDefaults(target, mode) {
  if (mode !== 'markdown') return target
  if (!target.chunksExplicit) target.chunks = 24
  if (!target.delayExplicit) target.delay = 15
  return target
}

function resolveRequestOptions(base, url) {
  const parsed = new URL(url, 'http://127.0.0.1')
  const q = parsed.searchParams
  const mode = q.get('mode') || base.mode
  if (!MODES.has(mode)) fail(`request mode must be one of: ${[...MODES].join(', ')}`)

  const resolved = {
    mode,
    chunks: base.chunks,
    delay: base.delay,
    chunksExplicit: base.chunksExplicit,
    delayExplicit: base.delayExplicit
  }

  const qChunks = q.get('chunks')
  if (qChunks !== null) {
    const n = Number(qChunks)
    if (!Number.isInteger(n) || n < 0) fail(`request chunks must be an integer >= 0, got: ${qChunks}`)
    resolved.chunks = n
    resolved.chunksExplicit = true
  }
  const qDelay = q.get('delay')
  if (qDelay !== null) {
    const n = Number(qDelay)
    if (!Number.isInteger(n) || n < 0) fail(`request delay must be an integer >= 0, got: ${qDelay}`)
    resolved.delay = n
    resolved.delayExplicit = true
  }

  // A per-request switch to slow gets slow defaults unless that request overrode them.
  if (mode === 'slow' && base.mode !== 'slow') applySlowDefaults(resolved, mode)
  if (mode === 'markdown' && base.mode !== 'markdown') applyMarkdownDefaults(resolved, mode)
  return resolved
}

function createLogger(logPath) {
  if (!logPath) return () => {}
  mkdirSync(dirname(logPath), { recursive: true })
  return (line) => {
    try {
      appendFileSync(logPath, `${line}\n`)
    } catch (error) {
      process.stderr.write(`mock-sse-server: log write failed: ${error.message}\n`)
    }
  }
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

function sseHeaders(extra = {}) {
  return {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
    ...extra
  }
}

function contentEvent(text, extra = {}) {
  return `data: ${JSON.stringify({
    choices: [{ index: 0, delta: { content: text }, ...extra }]
  })}\n\n`
}

function reasoningEvent(text) {
  return `data: ${JSON.stringify({
    choices: [{ index: 0, delta: { reasoning_content: text } }]
  })}\n\n`
}

async function handleCompletions(req, res, url, body, baseOpts, log, bodyLog) {
  const opts = resolveRequestOptions(baseOpts, url)
  const startedAt = Date.now()
  const elapsed = () => Date.now() - startedAt
  const state = { chunksSent: 0, closed: false, ended: false }

  if (body.length > 0) bodyLog(body)
  log(
    `POST /v1/chat/completions mode=${opts.mode} chunks=${opts.chunks} delay=${opts.delay}`
  )

  req.on('aborted', () => {
    state.closed = true
  })

  res.on('close', () => {
    state.closed = true
    const ms = elapsed()
    if (!res.writableEnded) {
      log(`client closed after ${state.chunksSent} chunks at +${ms}ms`)
    } else {
      log(`response completed after ${state.chunksSent} chunks at +${ms}ms`)
    }
  })

  if (opts.mode === '429') {
    res.writeHead(429, { 'Content-Type': 'application/json', 'Retry-After': '1' })
    res.end(JSON.stringify({ error: { message: 'mock rate limit', type: 'rate_limit_error' } }))
    return
  }

  if (opts.mode === '500') {
    res.writeHead(500, { 'Content-Type': 'application/json' })
    res.end(
      JSON.stringify({
        error: {
          message:
            'mock server exploded at https://provider.example/v1/chat/completions?api_key=leak-secret Authorization: Bearer sk-mock1234567890 and then a very long stack trace follows to exceed the display cap. '.repeat(
              4
            ),
          type: 'server_error'
        }
      })
    )
    return
  }

  if (opts.mode === 'json-200') {
    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' })
    res.end(
      JSON.stringify({
        error: {
          message: 'mock upstream returned JSON on a streaming request',
          type: 'invalid_request_error',
          code: 'stream_not_supported'
        }
      })
    )
    return
  }

  res.writeHead(200, sseHeaders())
  if (typeof res.flushHeaders === 'function') res.flushHeaders()

  const send = (text) => {
    if (state.closed || state.ended) return false
    state.chunksSent += 1
    return res.write(text)
  }

  const finish = () => {
    if (state.closed || state.ended) return
    state.ended = true
    log(`served ${state.chunksSent} chunks at +${elapsed()}ms`)
    res.end()
  }

  try {
    if (opts.mode === 'utf8-split') {
      const event = contentEvent('你好，世界')
      const bytes = Buffer.from(event, 'utf8')
      const sliceSize = 5
      for (let offset = 0; offset < bytes.length && !state.closed; offset += sliceSize) {
        res.write(bytes.subarray(offset, offset + sliceSize))
        await sleep(opts.delay)
      }
      state.chunksSent += 1
      if (!state.closed) res.write('data: [DONE]\n\n')
      finish()
      return
    }

    if (opts.mode === 'multiline') {
      // Two data: lines per event; the SSE parser must join them with "\n".
      if (!state.closed) {
        res.write('data: {"choices":[{"index":0,\n')
        res.write('data: "delta":{"content":"multi"}}]}\n\n')
        state.chunksSent += 1
      }
      await sleep(opts.delay)
      if (!state.closed) {
        res.write('data: {"choices":[{"index":0,\n')
        res.write('data: "delta":{"content":"line"}}]}\n\n')
        state.chunksSent += 1
      }
      await sleep(opts.delay)
      if (!state.closed) res.write('data: [DONE]\n\n')
      finish()
      return
    }

    if (opts.mode === 'malformed') {
      res.write('data: {"choices": [THIS IS NOT JSON]\n\n')
      await sleep(opts.delay)
      if (!state.closed) res.write('data: [DONE]\n\n')
      finish()
      return
    }

    if (opts.mode === 'comment') {
      res.write(': keep-alive\n\n')
      await sleep(opts.delay)
      send(contentEvent('comment '))
      res.write(':\n\n')
      await sleep(opts.delay)
      send(contentEvent('safe'))
      res.write(': trailing comment without newline payload\n\n')
      await sleep(opts.delay)
      if (!state.closed) res.write('data: [DONE]\n\n')
      finish()
      return
    }

    if (opts.mode === 'reasoning') {
      for (let i = 0; i < 3 && !state.closed; i += 1) {
        res.write(reasoningEvent(`think-${i + 1}`))
        state.chunksSent += 1
        await sleep(opts.delay)
      }
      if (!state.closed) send(contentEvent('answer'))
      await sleep(opts.delay)
      if (!state.closed) res.write('data: [DONE]\n\n')
      finish()
      return
    }

    if (opts.mode === 'markdown') {
      const parts = splitIntoChunks(markdownContent, opts.chunks)
      for (let i = 0; i < parts.length && !state.closed; i += 1) {
        send(contentEvent(parts[i]))
        if (i + 1 < parts.length) await sleep(opts.delay)
      }
      if (!state.closed) res.write('data: [DONE]\n\n')
      finish()
      return
    }

    if (opts.mode === 'usage') {
      send(contentEvent('hello'))
      await sleep(opts.delay)
      if (!state.closed) {
        res.write(
          `data: ${JSON.stringify({
            choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
            usage: { prompt_tokens: 5, completion_tokens: 1, total_tokens: 6 }
          })}\n\n`
        )
        state.chunksSent += 1
      }
      await sleep(opts.delay)
      if (!state.closed) res.write('data: [DONE]\n\n')
      finish()
      return
    }

    const chunkLimit = opts.mode === 'error' ? Math.min(1, opts.chunks) : opts.chunks
    for (let i = 0; i < chunkLimit && !state.closed; i += 1) {
      // First chunk immediately, then delay between chunks. This keeps the
      // 100x100ms slow stream's 5th chunk well inside the abort budget.
      send(contentEvent(`chunk ${i + 1}`))
      if (i + 1 < chunkLimit) await sleep(opts.delay)
    }

    if (state.closed) {
      finish()
      return
    }

    if (opts.mode === 'error') {
      res.write('data: {"error":{"message":"mock error","type":"mock_error"}}\n\n')
      finish()
      return
    }

    if (opts.mode === 'no-done') {
      finish()
      return
    }

    if (!state.closed) res.write('data: [DONE]\n\n')
    finish()
  } catch (error) {
    log(`stream error: ${error.message}`)
    if (!res.writableEnded) res.end()
  }
}

const opts = parseArgs(process.argv.slice(2))

if (opts.help) {
  process.stdout.write(HELP)
  process.exit(0)
}

if (opts.contentFile) {
  try {
    markdownContent = readFileSync(opts.contentFile, 'utf8')
  } catch (error) {
    fail(`cannot read --content-file: ${error.message}`)
  }
}

const log = createLogger(opts.log)
const bodyLog = createLogger(opts.bodyLog)

const server = http.createServer((req, res) => {
  const url = req.url ?? '/'

  if (req.method === 'GET' && url === '/health') {
    res.writeHead(200, { 'Content-Type': 'application/json' })
    res.end('{"status":"ok"}')
    return
  }

  const pathname = url.split('?')[0]
  if (req.method === 'POST' && pathname === '/v1/chat/completions') {
    let body = ''
    req.setEncoding('utf8')
    req.on('data', (chunk) => {
      body += chunk
    })
    req.on('end', () => {
      void handleCompletions(req, res, url, body, opts, log, bodyLog)
    })
    return
  }

  res.writeHead(404, { 'Content-Type': 'application/json' })
  res.end(JSON.stringify({ error: { message: `not found: ${req.method} ${url}` } }))
})

server.listen(opts.port, opts.host, () => {
  const address = server.address()
  const port = typeof address === 'object' && address ? address.port : opts.port
  const host = typeof address === 'object' && address ? address.address : opts.host
  process.stdout.write(
    `mock-sse-server listening on http://${host}:${port} (mode=${opts.mode}, chunks=${opts.chunks}, delay=${opts.delay}ms)\n`
  )
})

function shutdown(signal) {
  process.stdout.write(`mock-sse-server shutting down (${signal})\n`)
  server.close(() => process.exit(0))
  setTimeout(() => process.exit(0), 2000).unref()
}

process.on('SIGTERM', () => shutdown('SIGTERM'))
process.on('SIGINT', () => shutdown('SIGINT'))
