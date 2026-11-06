#!/usr/bin/env node
/**
 * Parser for tools/idle-net-check.sh.
 *
 * Inputs:
 *   --strace FILE   raw `strace -f -e trace=connect` output
 *   --ss FILE       periodic `ss -tnp` snapshots (headers start with "===")
 *   --json FILE     summary JSON output
 *   --text FILE     human summary output
 *   --minutes N     run duration (evidence)
 *
 * Verdict is PASS only when every IPv4/IPv6 connect target is loopback (or a
 * unix/netlink socket) and every sampled TCP peer is loopback.
 */

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'

const args = process.argv.slice(2)
function arg(name, fallback = null) {
  const index = args.indexOf(name)
  return index >= 0 && args[index + 1] !== undefined ? args[index + 1] : fallback
}

const stracePath = arg('--strace')
const ssPath = arg('--ss')
const jsonPath = arg('--json')
const textPath = arg('--text')
const minutes = Number(arg('--minutes', '5'))

if (!stracePath || !ssPath) {
  process.stderr.write('usage: idle-net-parse.mjs --strace FILE --ss FILE [--json FILE] [--text FILE]\n')
  process.exit(2)
}

function normalizeHost(host) {
  return host.toLowerCase().replace(/^\[|\]$/g, '')
}

function isLoopbackHost(host) {
  const h = normalizeHost(host)
  if (h === 'localhost' || h === '::1' || h === '0:0:0:0:0:0:0:1' || h === '::') return true
  if (h.startsWith('::ffff:127.')) return true
  return /^127\./.test(h)
}

function classifyStraceLine(line) {
  if (line.includes('sa_family=AF_UNIX')) {
    return { allowed: true, kind: 'unix', host: null }
  }
  if (line.includes('sa_family=AF_NETLINK')) {
    return { allowed: true, kind: 'netlink', host: null }
  }
  if (line.includes('sa_family=AF_INET6')) {
    const match = /inet_pton\(AF_INET6,\s*"([^"]+)"/.exec(line)
    const host = match ? match[1] : null
    if (host !== null && isLoopbackHost(host)) return { allowed: true, kind: 'ipv6_loopback', host }
    return { allowed: false, kind: 'ipv6', host: host ?? 'unknown' }
  }
  if (line.includes('sa_family=AF_INET')) {
    const match = /inet_addr\("([^"]+)"\)/.exec(line)
    const host = match ? match[1] : null
    if (host !== null && isLoopbackHost(host)) return { allowed: true, kind: 'ipv4_loopback', host }
    return { allowed: false, kind: 'ipv4', host: host ?? 'unknown' }
  }
  if (line.includes('sa_family=AF_UNSPEC')) {
    return { allowed: true, kind: 'unspec', host: null }
  }
  return { allowed: false, kind: 'other', host: null }
}

function splitSsAddress(value) {
  if (value.startsWith('[')) {
    const close = value.indexOf(']')
    if (close === -1) return { host: value, port: '' }
    return { host: value.slice(1, close), port: value.slice(close + 1).replace(/^:/, '') }
  }
  const index = value.lastIndexOf(':')
  if (index <= 0) return { host: value, port: '' }
  return { host: value.slice(0, index), port: value.slice(index + 1) }
}

const straceRaw = readFileSync(stracePath, 'utf8')
const straceLines = straceRaw.split('\n').filter((line) => line.includes('connect('))
const allowed = []
const externalStrace = []

for (const line of straceLines) {
  const result = classifyStraceLine(line)
  if (result.allowed) allowed.push({ kind: result.kind, host: result.host })
  else externalStrace.push({ kind: result.kind, host: result.host, line: line.slice(0, 300) })
}

let snapshots = 0
let ssLines = 0
const externalSs = []
const ssStates = {}
const ssRaw = readFileSync(ssPath, 'utf8')
for (const line of ssRaw.split('\n')) {
  if (line.startsWith('===')) {
    if (line.includes('snapshot')) snapshots += 1
    continue
  }
  if (line.trim().length === 0) continue
  if (line.startsWith('(')) continue
  ssLines += 1
  const fields = line.trim().split(/\s+/)
  if (fields.length < 5) continue
  const state = fields[0]
  ssStates[state] = (ssStates[state] ?? 0) + 1
  const local = splitSsAddress(fields[3])
  const peer = splitSsAddress(fields[4])
  const peerHost = peer.host
  if (!peerHost || peerHost === '*' || peer.port === '*' || peerHost === '0.0.0.0') continue
  if (!isLoopbackHost(peerHost)) {
    externalSs.push({ state, local, peer })
  }
}

const external = externalStrace.length + externalSs.length
const summary = {
  task: '17',
  tool: 'idle-net-check',
  generated_at: new Date().toISOString(),
  requested_minutes: minutes,
  strace: {
    connect_lines: straceLines.length,
    allowed_loopback_or_unix: allowed.length,
    allowed_kinds: allowed.reduce((acc, entry) => {
      acc[entry.kind] = (acc[entry.kind] ?? 0) + 1
      return acc
    }, {}),
    external
  },
  ss: {
    snapshots,
    lines: ssLines,
    states: ssStates,
    external: externalSs.length
  },
  external_connections: externalStrace.length + externalSs.length,
  external_details: { strace: externalStrace.slice(0, 50), ss: externalSs.slice(0, 50) },
  verdict: external === 0 ? 'PASS' : 'FAIL',
  code: external === 0 ? null : 'IDLE_NET_EXTERNAL_CONNECTIONS'
}

if (jsonPath) {
  mkdirSync(dirname(jsonPath), { recursive: true })
  writeFileSync(jsonPath, `${JSON.stringify(summary, null, 2)}\n`)
}

const text = [
  'TASK 17 IDLE NETWORK CHECK',
  `generated_at: ${summary.generated_at}`,
  `requested_minutes: ${minutes}`,
  `strace_connect_lines: ${straceLines.length}`,
  `strace_allowed_loopback_unix: ${allowed.length}`,
  `strace_external: ${externalStrace.length}`,
  `ss_snapshots: ${snapshots}`,
  `ss_lines: ${ssLines}`,
  `ss_external: ${externalSs.length}`,
  `external_connections: ${summary.external_connections}`,
  `verdict: ${summary.verdict}`,
  summary.verdict === 'PASS' ? 'IDLE_NET_PASS' : 'IDLE_NET_FAIL',
  ''
]
if (externalStrace.length > 0) {
  text.push('--- external strace connects ---')
  for (const entry of externalStrace.slice(0, 50)) text.push(`${entry.kind} ${entry.host}: ${entry.line}`)
  text.push('')
}
if (externalSs.length > 0) {
  text.push('--- external ss peers ---')
  for (const entry of externalSs.slice(0, 50)) {
    text.push(`${entry.state} ${entry.local.host}:${entry.local.port} -> ${entry.peer.host}:${entry.peer.port}`)
  }
  text.push('')
}
if (textPath) {
  mkdirSync(dirname(textPath), { recursive: true })
  writeFileSync(textPath, text.join('\n'))
}
process.stdout.write(text.join('\n'))
if (summary.verdict !== 'PASS') process.exitCode = 1
