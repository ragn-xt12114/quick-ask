#!/usr/bin/env node
/**
 * Task 17 network audit.
 *
 * Scans `src/main/**` for direct outbound-network primitives outside the two
 * approved directories:
 *   - src/main/provider/**  (ProviderClient, SSE, provider test requests)
 *   - src/main/net/**       (outbound guard)
 *
 * Exit 1 with code UNAPPROVED_NETWORK_CODE on any hit. Tests/tools are not
 * scanned because they are excluded by construction (we only walk src/main).
 */

import { mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { dirname, join, relative, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = resolve(fileURLToPath(new URL('..', import.meta.url)))
const SCAN_ROOT = join(ROOT, 'src', 'main')
const EXCLUDED_DIRS = [join(SCAN_ROOT, 'provider'), join(SCAN_ROOT, 'net')]

const PATTERNS = [
  { name: 'direct_fetch', re: /\b(?:globalThis\.)?fetch\s*\(/ },
  { name: 'undici_import', re: /\bfrom\s+['"]undici['"]/ },
  { name: 'undici_require', re: /\brequire\s*\(\s*['"]undici['"]\s*\)/ },
  { name: 'http_request', re: /\b(?:http|https)\.(?:request|get)\s*\(/ },
  { name: 'net_connect', re: /\bnet\.connect\s*\(/ },
  { name: 'node_http_import', re: /\bfrom\s+['"](?:node:)?(?:http|https|net)['"]/ },
  { name: 'node_http_dynamic_import', re: /\bimport\s*\(\s*['"](?:node:)?(?:http|https|net)['"]\s*\)/ },
  { name: 'node_http_require', re: /\brequire\s*\(\s*['"](?:node:)?(?:http|https|net)['"]\s*\)/ },
  { name: 'axios', re: /\baxios\b/ },
  { name: 'xhr', re: /\bXMLHttpRequest\b/ },
  { name: 'websocket', re: /\bWebSocket\b/ }
]

function walk(dir, output) {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry)
    const stat = statSync(full)
    if (stat.isDirectory()) {
      if (EXCLUDED_DIRS.includes(full)) continue
      walk(full, output)
    } else if (/\.(?:ts|tsx|mts|cts|js|mjs|cjs)$/.test(entry)) {
      output.push(full)
    }
  }
}

/** Remove comments while preserving strings, newlines and line numbers. */
function stripComments(source) {
  let out = ''
  let inBlock = false
  let inLine = false
  let quote = null
  let escaped = false

  for (let i = 0; i < source.length; i += 1) {
    const char = source[i]
    const next = source[i + 1]

    if (inBlock) {
      if (char === '*' && next === '/') {
        inBlock = false
        i += 1
      } else if (char === '\n') {
        out += '\n'
      }
      continue
    }

    if (inLine) {
      if (char === '\n') {
        inLine = false
        out += '\n'
      }
      continue
    }

    if (quote) {
      out += char
      if (escaped) {
        escaped = false
      } else if (char === '\\') {
        escaped = true
      } else if (char === quote) {
        quote = null
      }
      continue
    }

    if (char === '/' && next === '*') {
      inBlock = true
      i += 1
      continue
    }
    if (char === '/' && next === '/') {
      inLine = true
      i += 1
      continue
    }
    if (char === '"' || char === "'" || char === '`') {
      quote = char
      out += char
      continue
    }
    out += char
  }
  return out
}

function lineNumberAt(text, index) {
  let line = 1
  for (let i = 0; i < index; i += 1) {
    if (text[i] === '\n') line += 1
  }
  return line
}

function main() {
  const args = process.argv.slice(2)
  const outIndex = args.indexOf('--out')
  const outPath = outIndex >= 0 ? args[outIndex + 1] : null

  const files = []
  walk(SCAN_ROOT, files)
  files.sort()

  const violations = []
  for (const file of files) {
    const source = readFileSync(file, 'utf8')
    const cleaned = stripComments(source)
    for (const pattern of PATTERNS) {
      const global = new RegExp(pattern.re.source, 'g')
      for (let match = global.exec(cleaned); match; match = global.exec(cleaned)) {
        const line = lineNumberAt(cleaned, match.index)
        const excerpt = source.split('\n')[line - 1]?.trim().slice(0, 200) ?? ''
        violations.push({
          file: relative(ROOT, file).split(sep).join('/'),
          line,
          pattern: pattern.name,
          excerpt
        })
      }
    }
  }

  const report = {
    task: '17',
    tool: 'check-network-usage',
    generated_at: new Date().toISOString(),
    scanned_root: 'src/main',
    excluded: ['src/main/provider/**', 'src/main/net/**'],
    files_scanned: files.length,
    violations,
    verdict: violations.length === 0 ? 'PASS' : 'FAIL',
    code: violations.length === 0 ? null : 'UNAPPROVED_NETWORK_CODE'
  }

  const json = `${JSON.stringify(report, null, 2)}\n`
  if (outPath) {
    mkdirSync(dirname(resolve(outPath)), { recursive: true })
    writeFileSync(resolve(outPath), json)
  }
  process.stdout.write(json)
  if (violations.length > 0) process.exitCode = 1
}

main()
