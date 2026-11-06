#!/usr/bin/env node
/**
 * Minimal dependency-free HTTP CONNECT proxy for the Task 7 abort/proxy probe.
 *
 * Usage:
 *   node tools/connect-proxy.mjs [--port 0] [--log <file>]
 *
 * Prints: connect-proxy listening on http://127.0.0.1:<port>
 * Logs:   CONNECT <host>:<port>
 *         tunnel open
 *         client closed at +<ms>ms
 *         upstream closed at +<ms>ms
 *
 * It only supports CONNECT (what HTTPS/HTTP fetches through a proxy use).
 * No auth, no caching, no TLS termination.
 */
import http from 'node:http'
import net from 'node:net'
import { appendFileSync, mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import process from 'node:process'

function parseArgs(argv) {
  const opts = { port: 0, log: null, help: false }
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]
    switch (arg) {
      case '-h':
      case '--help':
        opts.help = true
        break
      case '--port': {
        i += 1
        const n = Number(argv[i])
        if (!Number.isInteger(n) || n < 0) {
          process.stderr.write('connect-proxy: --port must be an integer >= 0\n')
          process.exit(2)
        }
        opts.port = n
        break
      }
      case '--log':
        i += 1
        opts.log = argv[i]
        break
      default:
        process.stderr.write(`connect-proxy: unknown argument: ${arg}\n`)
        process.exit(2)
    }
  }
  return opts
}

const opts = parseArgs(process.argv.slice(2))
if (opts.help) {
  process.stdout.write('Usage: node tools/connect-proxy.mjs [--port 0] [--log <file>]\n')
  process.exit(0)
}

const logPath = opts.log
if (logPath) mkdirSync(dirname(logPath), { recursive: true })
function log(line) {
  if (logPath) appendFileSync(logPath, `${line}\n`)
}

const server = http.createServer((req, res) => {
  // HTTP (not HTTPS) through an HTTP proxy uses absolute-form requests, not
  // CONNECT. Support both so the plain-HTTP mock can be observed end-to-end.
  let target
  try {
    target = new URL(req.url)
  } catch {
    res.writeHead(400, { 'Content-Type': 'text/plain' })
    res.end('connect-proxy: absolute URL required\n')
    return
  }
  if (target.protocol !== 'http:') {
    res.writeHead(400, { 'Content-Type': 'text/plain' })
    res.end('connect-proxy: forward mode is http only\n')
    return
  }
  const startedAt = Date.now()
  log(`FORWARD ${req.method} ${target.href}`)

  const upstream = http.request(
    {
      host: target.hostname,
      port: target.port || 80,
      method: req.method,
      path: `${target.pathname}${target.search}`,
      headers: req.headers
    },
    (upstreamRes) => {
      res.writeHead(upstreamRes.statusCode || 502, upstreamRes.headers)
      upstreamRes.pipe(res)
    }
  )

  let clientClosed = false
  let upstreamClosed = false
  const markClient = (which) => {
    if (clientClosed) return
    clientClosed = true
    const early = !res.writableEnded
    log(`${which} at +${Date.now() - startedAt}ms early=${early}`)
    if (!res.writableEnded) res.destroy()
    upstream.destroy()
  }
  const markUpstream = (which) => {
    if (upstreamClosed) return
    upstreamClosed = true
    log(`${which} at +${Date.now() - startedAt}ms`)
    if (!res.writableEnded) res.destroy()
  }

  req.on('error', () => markClient('client request error'))
  req.on('aborted', () => markClient('client aborted'))
  upstream.on('error', () => markUpstream('upstream request error'))
  res.on('close', () => markClient('client closed'))
  upstream.on('close', () => markUpstream('upstream closed'))
  req.pipe(upstream)
})

server.on('connect', (req, clientSocket, head) => {
  const target = req.url || ''
  const startedAt = Date.now()
  log(`CONNECT ${target}`)

  const sep = target.lastIndexOf(':')
  if (sep <= 0) {
    clientSocket.end('HTTP/1.1 400 Bad Request\r\n\r\n')
    return
  }
  const host = target.slice(0, sep)
  const port = Number(target.slice(sep + 1))
  if (!Number.isInteger(port) || port <= 0) {
    clientSocket.end('HTTP/1.1 400 Bad Request\r\n\r\n')
    return
  }

  const upstream = net.connect(port, host, () => {
    clientSocket.write('HTTP/1.1 200 Connection Established\r\n\r\n')
    log(`tunnel open at +${Date.now() - startedAt}ms`)
    if (head && head.length > 0) upstream.write(head)
    clientSocket.pipe(upstream)
    upstream.pipe(clientSocket)
  })

  let clientClosed = false
  let upstreamClosed = false
  const markClient = (which) => {
    if (clientClosed) return
    clientClosed = true
    const early = !clientSocket.destroyed
    log(`${which} at +${Date.now() - startedAt}ms early=${early}`)
    clientSocket.destroy()
    upstream.destroy()
  }
  const markUpstream = (which) => {
    if (upstreamClosed) return
    upstreamClosed = true
    log(`${which} at +${Date.now() - startedAt}ms`)
    clientSocket.destroy()
  }

  clientSocket.on('error', () => markClient('client socket error'))
  upstream.on('error', () => markUpstream('upstream socket error'))
  clientSocket.on('close', () => markClient('client closed'))
  upstream.on('close', () => markUpstream('upstream closed'))
})

server.listen(opts.port, '127.0.0.1', () => {
  const address = server.address()
  const port = typeof address === 'object' && address ? address.port : opts.port
  process.stdout.write(`connect-proxy listening on http://127.0.0.1:${port}\n`)
})

function shutdown(signal) {
  process.stdout.write(`connect-proxy shutting down (${signal})\n`)
  server.close(() => process.exit(0))
  setTimeout(() => process.exit(0), 2000).unref()
}

process.on('SIGTERM', () => shutdown('SIGTERM'))
process.on('SIGINT', () => shutdown('SIGINT'))
