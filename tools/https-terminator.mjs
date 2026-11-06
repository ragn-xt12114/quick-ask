#!/usr/bin/env node
/**
 * Tiny HTTPS terminator used by the Task 7 CONNECT-proxy abort probe.
 *
 * The mock provider is plain HTTP/1.1. To exercise a real HTTP CONNECT proxy
 * we put this local TLS endpoint in front of it:
 *
 *   client --HTTPS(CONNECT proxy)--> terminator --HTTP--> mock-sse-server
 *
 * Usage:
 *   node tools/https-terminator.mjs --target http://127.0.0.1:<port> \
 *        --cert <pem> --key <pem> [--port 0] [--log <file>]
 *
 * Prints: https-terminator listening on https://127.0.0.1:<port>
 * Logs:   TLS <method> <path>, client close/early, upstream close.
 */
import https from 'node:https'
import http from 'node:http'
import { readFileSync, appendFileSync, mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import process from 'node:process'

function parseArgs(argv) {
  const opts = { port: 0, target: null, cert: null, key: null, log: null, help: false }
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]
    switch (arg) {
      case '-h':
      case '--help':
        opts.help = true
        break
      case '--port':
        i += 1
        opts.port = Number(argv[i])
        break
      case '--target':
        i += 1
        opts.target = argv[i]
        break
      case '--cert':
        i += 1
        opts.cert = argv[i]
        break
      case '--key':
        i += 1
        opts.key = argv[i]
        break
      case '--log':
        i += 1
        opts.log = argv[i]
        break
      default:
        process.stderr.write(`https-terminator: unknown argument: ${arg}\n`)
        process.exit(2)
    }
  }
  if (!opts.target || !opts.cert || !opts.key) {
    process.stderr.write('https-terminator: --target, --cert and --key are required\n')
    process.exit(2)
  }
  return opts
}

const opts = parseArgs(process.argv.slice(2))
if (opts.help) {
  process.stdout.write('Usage: node tools/https-terminator.mjs --target <url> --cert <pem> --key <pem> [--port 0] [--log <file>]\n')
  process.exit(0)
}

const targetUrl = new URL(opts.target)
if (opts.log) mkdirSync(dirname(opts.log), { recursive: true })
function log(line) {
  if (opts.log) appendFileSync(opts.log, `${line}\n`)
}

const server = https.createServer(
  { cert: readFileSync(opts.cert), key: readFileSync(opts.key) },
  (req, res) => {
    const startedAt = Date.now()
    log(`TLS ${req.method} ${req.url}`)

    const upstream = http.request(
      {
        host: targetUrl.hostname,
        port: targetUrl.port || 80,
        method: req.method,
        path: req.url,
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

    req.on('error', () => markClient('tls client request error'))
    req.on('aborted', () => markClient('tls client aborted'))
    res.on('close', () => markClient('tls client closed'))
    upstream.on('error', () => markUpstream('http upstream error'))
    upstream.on('close', () => markUpstream('http upstream closed'))
    req.pipe(upstream)
  }
)

server.listen(opts.port, '127.0.0.1', () => {
  const address = server.address()
  const port = typeof address === 'object' && address ? address.port : opts.port
  process.stdout.write(`https-terminator listening on https://127.0.0.1:${port}\n`)
})

function shutdown(signal) {
  process.stdout.write(`https-terminator shutting down (${signal})\n`)
  server.close(() => process.exit(0))
  setTimeout(() => process.exit(0), 2000).unref()
}

process.on('SIGTERM', () => shutdown('SIGTERM'))
process.on('SIGINT', () => shutdown('SIGINT'))
