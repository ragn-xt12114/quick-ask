#!/usr/bin/env node
/**
 * Task 7 G9 driver — SSE fixtures, abort, 429 and proxy/HTTP2 notes.
 *
 * Dependency-free. Starts a fresh mock-sse-server per fixture, runs the
 * Electron-main client (spike/sse.cjs) once, asserts the result, keeps the raw
 * server log and writes .omo/evidence/task-7-result.json.
 *
 *   source scripts/env.sh
 *   node tools/sse-check.mjs
 */
import fs from 'node:fs'
import path from 'node:path'
import { spawn, spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import process from 'node:process'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const EVID = path.join(ROOT, '.omo', 'evidence')
const ELECTRON = path.join(ROOT, 'node_modules', '.bin', 'electron')
const SSE = path.join(ROOT, 'spike', 'sse.cjs')
const SERVER = path.join(ROOT, 'tools', 'mock-sse-server.mjs')
const PROXY = path.join(ROOT, 'tools', 'connect-proxy.mjs')
const TERMINATOR = path.join(ROOT, 'tools', 'https-terminator.mjs')
const TLS_DIR = path.join(ROOT, '.cache', 'task-7-tls')
const DISPLAY = process.env.DISPLAY || ':0'

const SERVER_READY = /listening on http:\/\/127\.0\.0\.1:(\d+)/
const PROXY_READY = /connect-proxy listening on http:\/\/127\.0\.0\.1:(\d+)/
const TERMINATOR_READY = /https-terminator listening on https:\/\/127\.0\.0\.1:(\d+)/

fs.mkdirSync(EVID, { recursive: true })

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
const readText = (file) => {
  try {
    return fs.readFileSync(file, 'utf8')
  } catch {
    return ''
  }
}
const readJson = (file) => {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'))
  } catch {
    return null
  }
}
const countPosts = (log) => (log.match(/^POST \/v1\/chat\/completions/gm) || []).length

function parseJsonl(text) {
  const out = []
  for (const line of String(text).split('\n')) {
    if (!line.trim().startsWith('{')) continue
    try {
      out.push(JSON.parse(line))
    } catch {
      /* ignore */
    }
  }
  return out
}

function ssEstablished(port) {
  const r = spawnSync('ss', ['-tnp'], { encoding: 'utf8' })
  return String(r.stdout || '')
    .split('\n')
    .filter((line) => line.includes(`:${port}`) && line.includes('ESTAB'))
}

async function runProcess(command, args, { timeoutMs = 25000, env = process.env } = {}) {
  const startedAt = Date.now()
  return await new Promise((resolve) => {
    const child = spawn(command, args, {
      cwd: ROOT,
      env,
      detached: true,
      stdio: ['ignore', 'pipe', 'pipe']
    })
    let stdout = ''
    let stderr = ''
    let settled = false
    let timedOut = false
    const timer = setTimeout(() => {
      timedOut = true
      try {
        process.kill(-child.pid, 'SIGTERM')
      } catch {
        try {
          child.kill('SIGTERM')
        } catch {
          /* ignore */
        }
      }
      setTimeout(() => {
        try {
          process.kill(-child.pid, 'SIGKILL')
        } catch {
          /* ignore */
        }
      }, 1500).unref()
    }, timeoutMs)
    child.stdout.on('data', (chunk) => {
      stdout += chunk
    })
    child.stderr.on('data', (chunk) => {
      stderr += chunk
    })
    const finish = (code, signal) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolve({
        code: code === null ? -1 : code,
        signal,
        stdout,
        stderr,
        timedOut,
        durationMs: Date.now() - startedAt
      })
    }
    child.on('close', finish)
    child.on('error', (error) => {
      stderr += `\nspawn error: ${error.message}\n`
      finish(-1, null)
    })
  })
}

async function stopService(child) {
  if (!child || child.exitCode !== null) return
  const closed = new Promise((resolve) => child.once('close', resolve))
  try {
    process.kill(-child.pid, 'SIGTERM')
  } catch {
    try {
      child.kill('SIGTERM')
    } catch {
      /* ignore */
    }
  }
  await Promise.race([closed, sleep(2500)])
  if (child.exitCode === null) {
    try {
      process.kill(-child.pid, 'SIGKILL')
    } catch {
      /* ignore */
    }
    await Promise.race([closed, sleep(1000)])
  }
}

async function startService(command, args, readyRegex, { timeoutMs = 8000 } = {}) {
  const child = spawn(command, args, {
    cwd: ROOT,
    env: { ...process.env, DISPLAY },
    detached: true,
    stdio: ['ignore', 'pipe', 'pipe']
  })
  let stdout = ''
  let stderr = ''
  let settled = false

  return await new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      if (settled) return
      settled = true
      void stopService(child)
      reject(new Error(`timeout waiting for ${path.basename(args[0] || command)}; stdout=${stdout} stderr=${stderr}`))
    }, timeoutMs)
    const check = () => {
      const match = readyRegex.exec(stdout)
      if (!match || settled) return
      settled = true
      clearTimeout(timer)
      resolve({
        child,
        port: Number(match[1]),
        match,
        stdout: () => stdout,
        stderr: () => stderr
      })
    }
    child.stdout.on('data', (chunk) => {
      stdout += chunk
      check()
    })
    child.stderr.on('data', (chunk) => {
      stderr += chunk
    })
    child.on('error', (error) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      reject(error)
    })
    child.on('close', (code) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      reject(new Error(`service exited early code=${code}; stdout=${stdout} stderr=${stderr}`))
    })
  })
}

function runElectron({ url, out, abortAfter = 0, proxy = null, impl = null, label, ignoreCert = false, timeoutMs = 25000 }) {
  const args = [SSE, '--url', url, '--out', out, '--label', label]
  if (abortAfter > 0) args.push('--abort-after-chunks', String(abortAfter))
  if (proxy) args.push('--proxy', proxy)
  if (impl) args.push('--impl', impl)
  if (ignoreCert) args.push('--ignore-cert')
  return runProcess(ELECTRON, args, {
    timeoutMs,
    env: { ...process.env, DISPLAY }
  })
}

function check(result, condition, message, detail = '') {
  if (!condition) result.errors.push(detail ? `${message}: ${detail}` : message)
}

function clientEventSummary(stdout) {
  const events = parseJsonl(stdout)
  return {
    events,
    abortIndex: events.findIndex((event) => event.ev === 'abort_requested'),
    chunkAfterAbort: (() => {
      const abortIndex = events.findIndex((event) => event.ev === 'abort_requested')
      if (abortIndex < 0) return 0
      return events.slice(abortIndex + 1).filter((event) => event.ev === 'chunk').length
    })()
  }
}

async function executeFixture(id, query, { abortAfter = 0, timeoutMs = 25000, validate } = {}) {
  const serverLog = path.join(EVID, `task-7-${id}-server.log`)
  const clientOut = path.join(EVID, `task-7-${id}-client.json`)
  const result = {
    id,
    pass: false,
    errors: [],
    query,
    abort_after_chunks: abortAfter || null,
    client_exit: null,
    client_duration_ms: null,
    server: {},
    metrics: null,
    evidence: { server_log: serverLog, client_json: clientOut }
  }
  fs.rmSync(serverLog, { force: true })
  let server = null
  try {
    server = await startService(
      process.execPath,
      [SERVER, '--port', '0', '--mode', 'normal', '--log', serverLog],
      SERVER_READY
    )
    const url = `http://127.0.0.1:${server.port}/v1/chat/completions?${query}`
    const client = await runElectron({ url, out: clientOut, abortAfter, label: id, timeoutMs })
    result.client_exit = client.code
    result.client_duration_ms = client.durationMs
    result.client_timed_out = client.timedOut
    result.client_stdout = client.stdout
    result.client_stderr_tail = client.stderr.split('\n').slice(-4).join('\n')

    let ssLines = null
    if (id === 'slow') {
      await sleep(1200)
      ssLines = ssEstablished(server.port)
    }

    await sleep(200)
    const log = readText(serverLog)
    const metrics = readJson(clientOut)
    result.metrics = metrics
    result.server = {
      log,
      post_count: countPosts(log),
      close_match: /client closed after (\d+) chunks at \+(\d+)ms/.exec(log),
      completed_match: /response completed after (\d+) chunks at \+(\d+)ms/.exec(log)
    }
    if (ssLines !== null) result.server.ss_established_after_1s = ssLines
    if (result.server.close_match) {
      result.server.close_chunks = Number(result.server.close_match[1])
      result.server.close_after_request_ms = Number(result.server.close_match[2])
    }
    if (result.server.completed_match) {
      result.server.completed_chunks = Number(result.server.completed_match[1])
      result.server.completed_after_request_ms = Number(result.server.completed_match[2])
    }

    if (validate) validate(result, metrics, log, client)
  } catch (error) {
    result.errors.push(`exception: ${error.message}`)
  } finally {
    if (server) await stopService(server.child)
  }
  result.pass = result.errors.length === 0
  return result
}

const expectedNormal = 'chunk 1chunk 2chunk 3chunk 4chunk 5'

async function runAllFixtures() {
  const fixtures = []

  fixtures.push(
    await executeFixture('normal', 'mode=normal&chunks=5&delay=10', {
      validate: (result, metrics) => {
        check(result, result.client_exit === 0, 'exit 0', String(result.client_exit))
        check(result, metrics && metrics.http_status === 200, 'http 200')
        check(result, metrics && metrics.content === expectedNormal, 'content complete', metrics && metrics.content)
        check(result, metrics && metrics.content_chunks === 5, '5 content chunks', String(metrics && metrics.content_chunks))
        check(result, metrics && metrics.saw_done === true, 'saw [DONE]')
        check(result, metrics && metrics.protocol_error === null, 'no protocol error', JSON.stringify(metrics && metrics.protocol_error))
        check(result, result.server.post_count === 1, 'exactly 1 request', String(result.server.post_count))
      }
    })
  )

  fixtures.push(
    await executeFixture('slow', 'mode=slow&chunks=100&delay=100', {
      abortAfter: 5,
      validate: (result, metrics, _log, client) => {
        const events = clientEventSummary(client.stdout)
        check(result, result.client_exit === 0, 'exit 0', String(result.client_exit))
        check(result, metrics && metrics.aborted === true, 'client reports aborted')
        check(result, metrics && metrics.content_chunks === 5, 'received exactly 5 chunks', String(metrics && metrics.content_chunks))
        check(result, metrics && metrics.chunks_after_abort === 0, 'no chunks after abort', String(metrics && metrics.chunks_after_abort))
        check(result, events.chunkAfterAbort === 0, 'no chunk JSONL event after abort', String(events.chunkAfterAbort))
        check(result, metrics && metrics.protocol_error === null, 'no protocol error', JSON.stringify(metrics && metrics.protocol_error))
        check(result, result.server.post_count === 1, 'exactly 1 request', String(result.server.post_count))
        const close = result.server.close_match
        check(result, !!close, 'server logged client closed')
        if (close) {
          check(result, Number(close[1]) === 5, 'server saw 5 chunks before close', close[1])
          check(result, Number(close[2]) <= 500, 'server close <=500ms since request start', `${close[2]}ms`)
        }
        check(
          result,
          result.server.ss_established_after_1s && result.server.ss_established_after_1s.length === 0,
          'no ESTABLISHED socket after 1s',
          JSON.stringify(result.server.ss_established_after_1s)
        )
      }
    })
  )

  fixtures.push(
    await executeFixture('error', 'mode=error&chunks=3&delay=10', {
      validate: (result, metrics) => {
        check(result, result.client_exit === 2, 'exit 2 (protocol)', String(result.client_exit))
        check(result, metrics && metrics.protocol_error && metrics.protocol_error.reason === 'sse_error_object', 'SSE error object -> protocol error')
        check(result, result.server.post_count === 1, 'exactly 1 request (no retry)', String(result.server.post_count))
      }
    })
  )

  fixtures.push(
    await executeFixture('utf8-split', 'mode=utf8-split&delay=10', {
      validate: (result, metrics) => {
        check(result, result.client_exit === 0, 'exit 0', String(result.client_exit))
        check(result, metrics && metrics.content === '你好，世界', 'content exactly 你好，世界', JSON.stringify(metrics && metrics.content))
        check(result, metrics && metrics.content_utf8_replacement_count === 0, 'no U+FFFD replacement', String(metrics && metrics.content_utf8_replacement_count))
        check(result, metrics && metrics.protocol_error === null, 'no protocol error')
        check(result, result.server.post_count === 1, 'exactly 1 request', String(result.server.post_count))
      }
    })
  )

  fixtures.push(
    await executeFixture('multiline', 'mode=multiline&delay=10', {
      validate: (result, metrics) => {
        check(result, result.client_exit === 0, 'exit 0', String(result.client_exit))
        check(result, metrics && metrics.content === 'multiline', 'multi-line data concatenated', JSON.stringify(metrics && metrics.content))
        check(result, metrics && metrics.saw_done === true, 'saw [DONE]')
        check(result, metrics && metrics.protocol_error === null, 'no protocol error')
      }
    })
  )

  fixtures.push(
    await executeFixture('no-done', 'mode=no-done&chunks=5&delay=10', {
      validate: (result, metrics) => {
        check(result, result.client_exit === 0, 'exit 0', String(result.client_exit))
        check(result, metrics && metrics.content === expectedNormal, 'content complete', metrics && metrics.content)
        check(result, metrics && metrics.saw_done === false, 'no [DONE] marker')
        check(result, metrics && metrics.clean_close === true, 'clean close treated as complete')
        check(result, metrics && metrics.protocol_error === null, 'no protocol error', JSON.stringify(metrics && metrics.protocol_error))
        check(result, result.server.post_count === 1, 'exactly 1 request', String(result.server.post_count))
      }
    })
  )

  fixtures.push(
    await executeFixture('malformed', 'mode=malformed&delay=10', {
      validate: (result, metrics) => {
        check(result, result.client_exit === 2, 'exit 2 (protocol)', String(result.client_exit))
        check(result, metrics && metrics.protocol_error && metrics.protocol_error.reason === 'malformed_json', 'malformed JSON -> protocol error')
        check(result, result.server.post_count === 1, 'exactly 1 request (no retry)', String(result.server.post_count))
      }
    })
  )

  fixtures.push(
    await executeFixture('json-200', 'mode=json-200', {
      validate: (result, metrics) => {
        check(result, result.client_exit === 2, 'exit 2 (protocol)', String(result.client_exit))
        check(result, metrics && metrics.http_status === 200, 'http 200')
        check(result, metrics && metrics.protocol_error && metrics.protocol_error.reason === 'non_sse_2xx', '2xx JSON -> protocol error')
        check(result, metrics && metrics.protocol_error && metrics.protocol_error.summary.length > 0 && metrics.protocol_error.summary.length <= 300, 'summary <=300 chars', String(metrics && metrics.protocol_error && metrics.protocol_error.summary.length))
        check(result, metrics && metrics.content_chunks === 0, 'no content treated as success', String(metrics && metrics.content_chunks))
        check(result, result.server.post_count === 1, 'exactly 1 request', String(result.server.post_count))
      }
    })
  )

  fixtures.push(
    await executeFixture('usage', 'mode=usage&delay=10', {
      validate: (result, metrics) => {
        check(result, result.client_exit === 0, 'exit 0', String(result.client_exit))
        check(result, metrics && metrics.content === 'hello', 'content hello', metrics && metrics.content)
        check(result, metrics && metrics.finish_reason === 'stop', 'finish_reason captured', String(metrics && metrics.finish_reason))
        check(result, metrics && metrics.usage && metrics.usage.total_tokens === 6, 'usage captured', JSON.stringify(metrics && metrics.usage))
        check(result, metrics && metrics.protocol_error === null, 'no protocol error')
      }
    })
  )

  fixtures.push(
    await executeFixture('reasoning', 'mode=reasoning&delay=10', {
      validate: (result, metrics) => {
        check(result, result.client_exit === 0, 'exit 0', String(result.client_exit))
        check(result, metrics && metrics.content === 'answer', 'content answer', metrics && metrics.content)
        check(result, metrics && metrics.reasoning_chunks === 3, 'reasoning chunks counted', String(metrics && metrics.reasoning_chunks))
        check(result, metrics && !String(metrics.content).includes('think'), 'reasoning content ignored', metrics && metrics.content)
        check(result, metrics && metrics.protocol_error === null, 'no protocol error')
      }
    })
  )

  fixtures.push(
    await executeFixture('comment', 'mode=comment&delay=10', {
      validate: (result, metrics) => {
        check(result, result.client_exit === 0, 'exit 0', String(result.client_exit))
        check(result, metrics && metrics.content === 'comment safe', 'comments skipped', metrics && metrics.content)
        check(result, metrics && metrics.comments >= 3, 'comment lines counted', String(metrics && metrics.comments))
        check(result, metrics && metrics.saw_done === true, 'saw [DONE]')
        check(result, metrics && metrics.protocol_error === null, 'no protocol error')
      }
    })
  )

  return fixtures
}

async function runRateLimit() {
  const logPath = path.join(EVID, 'task-7-429.log')
  const outPath = path.join(EVID, 'task-7-429-client.json')
  const result = {
    id: '429',
    pass: false,
    errors: [],
    evidence: { server_log: logPath, client_json: outPath }
  }
  fs.rmSync(logPath, { force: true })
  let server = null
  try {
    server = await startService(process.execPath, [SERVER, '--port', '0', '--mode', '429', '--log', logPath], SERVER_READY)
    const url = `http://127.0.0.1:${server.port}/v1/chat/completions`
    const client = await runElectron({ url, out: outPath, label: '429', timeoutMs: 20000 })
    const firstCount = countPosts(readText(logPath))
    const firstMetrics = readJson(outPath)
    await sleep(2200)
    const secondCount = countPosts(readText(logPath))
    const secondMetrics = readJson(outPath)
    result.client_exit = client.code
    result.client_duration_ms = client.durationMs
    result.client_stderr_tail = client.stderr.split('\n').slice(-4).join('\n')
    result.server = { log: readText(logPath), post_count_first: firstCount, post_count_after_2s: secondCount }
    result.metrics = secondMetrics

    check(result, client.code === 3, 'exit 3 (rate_limit)', String(client.code))
    check(result, firstMetrics && firstMetrics.http_status === 429, 'http 429')
    check(result, firstMetrics && firstMetrics.protocol_error && firstMetrics.protocol_error.code === 'rate_limit', 'rate_limit error code')
    check(result, firstCount === 1, 'exactly 1 request', String(firstCount))
    check(result, secondCount === 1, 'still 1 request after 2s (no auto retry)', String(secondCount))

    await sleep(1200)
    result.server.ss_established_after_1s = ssEstablished(server.port)
    check(result, result.server.ss_established_after_1s.length === 0, 'no ESTABLISHED socket', JSON.stringify(result.server.ss_established_after_1s))
  } catch (error) {
    result.errors.push(`exception: ${error.message}`)
  } finally {
    if (server) await stopService(server.child)
  }
  result.pass = result.errors.length === 0
  return result
}

function ensureCertificate() {
  fs.mkdirSync(TLS_DIR, { recursive: true })
  const key = path.join(TLS_DIR, 'key.pem')
  const cert = path.join(TLS_DIR, 'cert.pem')
  if (fs.existsSync(key) && fs.existsSync(cert)) return { key, cert }
  const r = spawnSync(
    'openssl',
    [
      'req',
      '-x509',
      '-newkey',
      'rsa:2048',
      '-nodes',
      '-keyout',
      key,
      '-out',
      cert,
      '-days',
      '1',
      '-subj',
      '/CN=127.0.0.1',
      '-addext',
      'subjectAltName=IP:127.0.0.1'
    ],
    { encoding: 'utf8' }
  )
  if (r.status !== 0) {
    throw new Error(`openssl failed: ${r.stderr || r.stdout}`)
  }
  return { key, cert }
}

async function runProxy() {
  const result = {
    id: 'proxy-connect-abort',
    pass: false,
    errors: [],
    evidence: {
      proxy_log: path.join(EVID, 'task-7-proxy.log'),
      terminator_log: path.join(EVID, 'task-7-tls-terminator.log'),
      server_log: path.join(EVID, 'task-7-proxy-server.log'),
      client_json: path.join(EVID, 'task-7-proxy-client.json')
    }
  }
  const { key, cert } = ensureCertificate()
  const serverLog = result.evidence.server_log
  const proxyLog = result.evidence.proxy_log
  const termLog = result.evidence.terminator_log
  for (const file of [serverLog, proxyLog, termLog]) fs.rmSync(file, { force: true })

  let server = null
  let proxy = null
  let terminator = null
  try {
    server = await startService(
      process.execPath,
      [SERVER, '--port', '0', '--mode', 'slow', '--chunks', '100', '--delay', '100', '--log', serverLog],
      SERVER_READY
    )
    terminator = await startService(
      process.execPath,
      [TERMINATOR, '--target', `http://127.0.0.1:${server.port}`, '--cert', cert, '--key', key, '--port', '0', '--log', termLog],
      TERMINATOR_READY
    )
    proxy = await startService(process.execPath, [PROXY, '--port', '0', '--log', proxyLog], PROXY_READY)

    const url = `https://127.0.0.1:${terminator.port}/v1/chat/completions?mode=slow`
    const client = await runElectron({
      url,
      out: result.evidence.client_json,
      abortAfter: 5,
      proxy: `http://127.0.0.1:${proxy.port}`,
      impl: 'net',
      ignoreCert: true,
      label: 'proxy-connect-abort',
      timeoutMs: 30000
    })
    await sleep(1200)
    const serverLogText = readText(serverLog)
    const proxyLogText = readText(proxyLog)
    const termLogText = readText(termLog)
    const metrics = readJson(result.evidence.client_json)
    const closeMatch = /client closed after (\d+) chunks at \+(\d+)ms/.exec(serverLogText)

    result.client_exit = client.code
    result.client_duration_ms = client.durationMs
    result.client_stderr_tail = client.stderr.split('\n').slice(-4).join('\n')
    result.metrics = metrics
    result.proxy = {
      log: proxyLogText,
      connect_observed: /CONNECT 127\.0\.0\.1:\d+/.test(proxyLogText),
      tunnel_open: /tunnel open at/.test(proxyLogText),
      client_close_observed: /client closed at \+/.test(proxyLogText),
      upstream_close_observed: /upstream closed at \+/.test(proxyLogText)
    }
    result.terminator = { log: termLogText, request_observed: /TLS POST \/v1\/chat\/completions/.test(termLogText) }
    result.server = {
      log: serverLogText,
      post_count: countPosts(serverLogText),
      close_chunks: closeMatch ? Number(closeMatch[1]) : null,
      close_after_request_ms: closeMatch ? Number(closeMatch[2]) : null,
      ss_established_after_1s: ssEstablished(server.port)
    }

    check(result, client.code === 0, 'exit 0', String(client.code))
    check(result, metrics && metrics.aborted === true, 'client reports aborted')
    check(result, metrics && metrics.content_chunks === 5, 'received exactly 5 chunks', String(metrics && metrics.content_chunks))
    check(result, metrics && metrics.chunks_after_abort === 0, 'no chunks after abort', String(metrics && metrics.chunks_after_abort))
    check(result, result.proxy.connect_observed, 'CONNECT observed by proxy')
    check(result, result.proxy.client_close_observed, 'client close observed by proxy')
    check(result, result.proxy.upstream_close_observed, 'upstream close observed by proxy')
    check(result, result.server.post_count === 1, 'exactly 1 upstream request', String(result.server.post_count))
    check(result, !!closeMatch, 'mock server saw client close')
    if (closeMatch) {
      check(result, Number(closeMatch[1]) === 5, 'server saw 5 chunks before close', closeMatch[1])
      check(result, Number(closeMatch[2]) <= 500, 'server close <=500ms since request start', `${closeMatch[2]}ms`)
    }
    check(result, result.server.ss_established_after_1s.length === 0, 'no ESTABLISHED socket', JSON.stringify(result.server.ss_established_after_1s))
  } catch (error) {
    result.errors.push(`exception: ${error.message}`)
  } finally {
    if (proxy) await stopService(proxy.child)
    if (terminator) await stopService(terminator.child)
    if (server) await stopService(server.child)
  }
  result.pass = result.errors.length === 0
  return result
}

function http2Note() {
  return {
    available: false,
    reason: 'mock-sse-server.mjs is node:http (HTTP/1.1) only; no h2 server/ALPN was used locally.',
    h2_abort_scenario: 'not exercised (would require an HTTP/2 server; production undici sends RST_STREAM in that case).'
  }
}

async function main() {
  const startedAt = new Date().toISOString()
  process.stdout.write(`[sse-check] electron=${ELECTRON}\n`)
  const fixtures = await runAllFixtures()
  const rateLimit = await runRateLimit()
  const proxy = await runProxy()

  // The task lists 429 as one of the 12 fixtures. Keep the detailed top-level
  // rate_limit object and also expose it in the per-fixture array.
  const rateLimitFixture = {
    id: '429',
    pass: rateLimit.pass,
    errors: rateLimit.errors,
    query: '',
    abort_after_chunks: null,
    client_exit: rateLimit.client_exit,
    client_duration_ms: rateLimit.client_duration_ms,
    server: rateLimit.server,
    metrics: rateLimit.metrics,
    evidence: rateLimit.evidence
  }
  const allFixtures = [...fixtures, rateLimitFixture]

  // Consolidated server log for the required grep in the Definition of Done.
  const parts = []
  for (const fixture of allFixtures) {
    const log = readText(fixture.evidence.server_log)
    parts.push(`===== fixture=${fixture.id} pass=${fixture.pass} =====\n${log}`)
  }
  const slowFixture = allFixtures.find((fixture) => fixture.id === 'slow')
  if (slowFixture) {
    parts.push(`===== abort-evidence (slow) =====\n${readText(slowFixture.evidence.server_log)}`)
  }
  fs.writeFileSync(path.join(EVID, 'task-7-server.log'), parts.join('\n'))

  // Copy the 429 log to a stable name (it is already written there).
  if (!fs.existsSync(path.join(EVID, 'task-7-429.log'))) {
    fs.writeFileSync(path.join(EVID, 'task-7-429.log'), readText(rateLimit.evidence.server_log))
  }

  const g4 = readJson(path.join(EVID, 'task-7-alt-tab-summary.json'))
  const g9Pass = allFixtures.every((f) => f.pass) && proxy.pass
  const result = {
    task: 7,
    title: 'G4/G9 skip atoms + Alt+Tab + SSE cancel/429 spike',
    generated_at: startedAt,
    finished_at: new Date().toISOString(),
    environment: {
      display: DISPLAY,
      electron: '45.2.2',
      node: process.version,
      mock_server: 'tools/mock-sse-server.mjs',
      client: 'spike/sse.cjs',
      http2: http2Note()
    },
    g4,
    g4_pass: g4 ? g4.pass === true : null,
    fixtures: allFixtures,
    fixture_summary: allFixtures.map((f) => ({ id: f.id, pass: f.pass, errors: f.errors })),
    rate_limit: rateLimit,
    proxy: proxy,
    g9_pass: g9Pass,
    pass: g9Pass && (!g4 || g4.pass === true)
  }
  const outPath = path.join(EVID, 'task-7-result.json')
  fs.writeFileSync(outPath, `${JSON.stringify(result, null, 2)}\n`)

  process.stdout.write(`[sse-check] fixtures: ${allFixtures.map((f) => `${f.id}=${f.pass ? 'PASS' : 'FAIL'}`).join(' ')}\n`)
  process.stdout.write(`[sse-check] rate_limit=${rateLimit.pass ? 'PASS' : 'FAIL'} proxy=${proxy.pass ? 'PASS' : 'FAIL'} g9=${g9Pass ? 'PASS' : 'FAIL'}\n`)
  process.stdout.write(`[sse-check] wrote ${outPath}\n`)

  const cleanup = spawnSync('pgrep', ['-x', 'electron'], { encoding: 'utf8' })
  if (String(cleanup.stdout || '').trim()) {
    process.stdout.write(`[sse-check] WARNING leftover electron pids: ${cleanup.stdout.trim()}\n`)
  }
}

main().catch((error) => {
  process.stderr.write(`[sse-check] FATAL ${error && error.stack ? error.stack : error}\n`)
  process.exit(1)
})
