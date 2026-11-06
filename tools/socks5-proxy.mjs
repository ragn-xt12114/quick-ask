#!/usr/bin/env node
/**
 * Dependency-free minimal SOCKS5 CONNECT server for Task 33a tests.
 *
 * Usage:
 *   node tools/socks5-proxy.mjs [--port 0] [--log <file>] [--auth user:pass]
 *
 * Prints: socks5-proxy listening on socks5://127.0.0.1:<port>
 * Logs:   SOCKS5 CONNECT <host>:<port>
 *         SOCKS5 AUTH ok
 *         SOCKS5 AUTH rejected
 *         tunnel open
 *         client closed / upstream closed
 *
 * Supports only CONNECT over IPv4, IPv6 and domain targets. No UDP, no BIND.
 */
import net from 'node:net'
import { appendFileSync, mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import process from 'node:process'

const SOCKS_VERSION = 0x05
const AUTH_NONE = 0x00
const AUTH_USERPASS = 0x02
const AUTH_UNACCEPTABLE = 0xff
const CMD_CONNECT = 0x01
const ATYP_IPV4 = 0x01
const ATYP_DOMAIN = 0x03
const ATYP_IPV6 = 0x04
const REPLY_SUCCEEDED = 0x00
const REPLY_GENERAL_FAILURE = 0x01
const REPLY_COMMAND_UNSUPPORTED = 0x07
const REPLY_ATYP_UNSUPPORTED = 0x08

function parseArgs(argv) {
  const opts = { port: 0, log: null, auth: null, help: false }
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]
    switch (arg) {
      case '-h':
      case '--help':
        opts.help = true
        break
      case '--port': {
        i += 1
        const value = Number(argv[i])
        if (!Number.isInteger(value) || value < 0) {
          process.stderr.write('socks5-proxy: --port must be an integer >= 0\n')
          process.exit(2)
        }
        opts.port = value
        break
      }
      case '--log':
        i += 1
        opts.log = argv[i]
        break
      case '--auth': {
        i += 1
        const raw = argv[i] ?? ''
        const sep = raw.indexOf(':')
        if (sep <= 0) {
          process.stderr.write('socks5-proxy: --auth must be user:pass\n')
          process.exit(2)
        }
        opts.auth = { username: raw.slice(0, sep), password: raw.slice(sep + 1) }
        break
      }
      default:
        process.stderr.write(`socks5-proxy: unknown argument: ${arg}\n`)
        process.exit(2)
    }
  }
  return opts
}

const opts = parseArgs(process.argv.slice(2))
if (opts.help) {
  process.stdout.write(
    'Usage: node tools/socks5-proxy.mjs [--port 0] [--log <file>] [--auth user:pass]\n'
  )
  process.exit(0)
}

if (opts.log) mkdirSync(dirname(opts.log), { recursive: true })
function log(line) {
  if (opts.log) appendFileSync(opts.log, `${line}\n`)
}

function reply(socket, code) {
  socket.write(Buffer.from([SOCKS_VERSION, code, 0x00, ATYP_IPV4, 0, 0, 0, 0, 0, 0]))
}

function formatHost(buffer, atyp) {
  if (atyp === ATYP_IPV4) {
    return Array.from(buffer.subarray(0, 4)).join('.')
  }
  if (atyp === ATYP_IPV6) {
    const groups = []
    for (let offset = 0; offset < 16; offset += 2) {
      groups.push(buffer.readUInt16BE(offset).toString(16))
    }
    return `[${groups.join(':')}]`
  }
  return ''
}

function handleSocket(socket) {
  let buffer = Buffer.alloc(0)
  let phase = 'greeting'
  let target = null
  let auth = null

  const fail = (code, reason) => {
    log(`SOCKS5 reject ${reason}`)
    reply(socket, code)
    socket.destroy()
  }

  const onData = (chunk) => {
    buffer = Buffer.concat([buffer, chunk])
    pump()
  }

  const pump = () => {
    for (;;) {
      if (phase === 'greeting') {
        if (buffer.length < 2) return
        if (buffer[0] !== SOCKS_VERSION) return fail(REPLY_GENERAL_FAILURE, 'version')
        const count = buffer[1]
        if (buffer.length < 2 + count) return
        const methods = buffer.subarray(2, 2 + count)
        buffer = buffer.subarray(2 + count)

        let method = AUTH_NONE
        if (opts.auth) {
          method = methods.includes(AUTH_USERPASS) ? AUTH_USERPASS : AUTH_UNACCEPTABLE
        }
        socket.write(Buffer.from([SOCKS_VERSION, method]))
        if (method === AUTH_UNACCEPTABLE) {
          log('SOCKS5 AUTH rejected: no acceptable method')
          socket.destroy()
          return
        }
        phase = method === AUTH_USERPASS ? 'auth' : 'request'
        continue
      }

      if (phase === 'auth') {
        if (buffer.length < 2) return
        if (buffer[0] !== 0x01) return fail(REPLY_GENERAL_FAILURE, 'auth-version')
        const ulen = buffer[1]
        if (buffer.length < 3 + ulen) return
        const plen = buffer[2 + ulen]
        if (buffer.length < 3 + ulen + plen) return
        const username = buffer.subarray(2, 2 + ulen).toString('utf8')
        const password = buffer.subarray(3 + ulen, 3 + ulen + plen).toString('utf8')
        buffer = buffer.subarray(3 + ulen + plen)
        if (
          username !== opts.auth.username ||
          password !== opts.auth.password
        ) {
          socket.write(Buffer.from([0x01, 0x01]))
          log('SOCKS5 AUTH rejected: bad credentials')
          socket.destroy()
          return
        }
        auth = username
        socket.write(Buffer.from([0x01, 0x00]))
        log('SOCKS5 AUTH ok')
        phase = 'request'
        continue
      }

      if (phase === 'request') {
        if (buffer.length < 4) return
        if (buffer[0] !== SOCKS_VERSION) return fail(REPLY_GENERAL_FAILURE, 'request-version')
        if (buffer[1] !== CMD_CONNECT) return fail(REPLY_COMMAND_UNSUPPORTED, 'command')
        const atyp = buffer[3]
        let host
        let portOffset
        if (atyp === ATYP_IPV4) {
          if (buffer.length < 10) return
          host = formatHost(buffer.subarray(4, 8), atyp)
          portOffset = 8
        } else if (atyp === ATYP_DOMAIN) {
          if (buffer.length < 5) return
          const length = buffer[4]
          if (buffer.length < 5 + length + 2) return
          host = buffer.subarray(5, 5 + length).toString('utf8')
          portOffset = 5 + length
        } else if (atyp === ATYP_IPV6) {
          if (buffer.length < 22) return
          host = formatHost(buffer.subarray(4, 20), atyp)
          portOffset = 20
        } else {
          return fail(REPLY_ATYP_UNSUPPORTED, 'atyp')
        }
        const port = buffer.readUInt16BE(portOffset)
        const rest = buffer.subarray(portOffset + 2)
        buffer = Buffer.alloc(0)
        phase = 'connecting'
        target = `${host}:${port}`
        log(`SOCKS5 CONNECT ${target}${auth ? ' auth=1' : ''}`)
        openTunnel(host, port, rest)
        return
      }

      return
    }
  }

  const openTunnel = (host, port, rest) => {
    socket.removeListener('data', onData)
    socket.pause()
    const startedAt = Date.now()

    const upstream = net.connect({ host, port }, () => {
      if (socket.destroyed) {
        upstream.destroy()
        return
      }
      reply(socket, REPLY_SUCCEEDED)
      log(`tunnel open at +${Date.now() - startedAt}ms`)
      if (rest.length > 0) upstream.write(rest)
      socket.pipe(upstream)
      upstream.pipe(socket)
      socket.resume()
    })

    const closeBoth = () => {
      socket.destroy()
      upstream.destroy()
    }
    socket.on('error', closeBoth)
    upstream.on('error', () => {
      log('SOCKS5 upstream error')
      if (!socket.destroyed) reply(socket, REPLY_GENERAL_FAILURE)
      closeBoth()
    })
    socket.on('close', () => {
      log('client closed')
      upstream.destroy()
    })
    upstream.on('close', () => {
      log('upstream closed')
      socket.destroy()
    })
  }

  socket.on('data', onData)
  socket.on('error', () => socket.destroy())
}

const server = net.createServer(handleSocket)
server.listen(opts.port, '127.0.0.1', () => {
  const address = server.address()
  const port = typeof address === 'object' && address ? address.port : opts.port
  process.stdout.write(`socks5-proxy listening on socks5://127.0.0.1:${port}\n`)
})

function shutdown(signal) {
  process.stdout.write(`socks5-proxy shutting down (${signal})\n`)
  server.close(() => process.exit(0))
  setTimeout(() => process.exit(0), 2000).unref()
}

process.on('SIGTERM', () => shutdown('SIGTERM'))
process.on('SIGINT', () => shutdown('SIGINT'))
