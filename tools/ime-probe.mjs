#!/usr/bin/env node
/**
 * G6 candidate-window probe.
 *
 * Enumerates X11 windows while an IME composition is active, identifies the
 * fcitx candidate popup (and any small override-redirect windows near the
 * composer), and computes its distance to the composer input rect.
 *
 * Usage:
 *   node tools/ime-probe.mjs \
 *     --state .omo/evidence/task-5-ime-state.json \
 *     --app-wid 0x1780003 \
 *     --out .omo/evidence/task-5-candidate.json \
 *     --text .omo/evidence/task-5-candidate-windows.txt
 *
 * Exit codes: 0 ran (JSON written), 2 no candidate found / bad input.
 *
 * Candidate metric (documented in the output):
 *   dx = max(input.left - cand.x, 0, cand.x - input.right)
 *   dy = max(input.top - cand.y, 0, cand.y - input.bottom)
 *   distance_px = max(dx, dy)      # edge-to-edge Chebyshev distance
 * PASS when distance_px <= 20, the candidate is not at the screen origin,
 * and its map state is IsViewable.
 */

import { execFileSync } from 'node:child_process'
import { readFileSync, writeFileSync } from 'node:fs'

const argv = process.argv.slice(2)
function arg(name, fallback = undefined) {
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i]
    if (a === name) return argv[i + 1]
    if (a.startsWith(`${name}=`)) return a.slice(name.length + 1)
  }
  return fallback
}

const statePath = arg('--state')
const appWid = String(arg('--app-wid', '')).toLowerCase()
const outPath = arg('--out')
const textPath = arg('--text')
if (!statePath || !outPath) {
  process.stderr.write('usage: ime-probe.mjs --state <json> --app-wid <0x...> --out <json> [--text <txt>]\n')
  process.exit(2)
}

const env = { ...process.env, DISPLAY: process.env.DISPLAY || ':0' }

function run(cmd, args, timeout = 5000) {
  try {
    return execFileSync(cmd, args.map(String), {
      encoding: 'utf8',
      env,
      timeout,
      stdio: ['ignore', 'pipe', 'pipe']
    })
  } catch (error) {
    // Keep stdout/stderr for diagnostics; many X queries exit non-zero when
    // the window vanished between enumeration and inspection.
    return `${error.stdout || ''}${error.stderr || ''}`
  }
}

function readState() {
  try {
    return JSON.parse(readFileSync(statePath, 'utf8'))
  } catch (error) {
    process.stderr.write(`ime-probe: cannot read state ${statePath}: ${error.message}\n`)
    process.exit(2)
  }
}

const state = readState()
const input = state.input_rect_screen
if (!input || !Number.isFinite(input.x) || !Number.isFinite(input.y)) {
  process.stderr.write('ime-probe: state has no input_rect_screen\n')
  process.exit(2)
}
const windowBounds = state.window_bounds || null

function decToHex(value) {
  const n = Number(value)
  if (!Number.isFinite(n)) return null
  return `0x${n.toString(16)}`
}

function parseSearch(cmd, args) {
  const text = run(cmd, args)
  return text
    .split(/\s+/)
    .map((s) => Number(s))
    .filter((n) => Number.isFinite(n) && n > 0)
    .map(decToHex)
    .filter(Boolean)
}

const searchWids = new Set()
for (const [cmd, args] of [
  ['xdotool', ['search', '--class', 'fcitx']],
  ['xdotool', ['search', '--class', 'fcitx5']],
  ['xdotool', ['search', '--name', 'Fcitx']],
  ['xdotool', ['search', '--name', 'fcitx']]
]) {
  for (const wid of parseSearch(cmd, args)) searchWids.add(wid.toLowerCase())
}

const treeText = run('xwininfo', ['-root', '-tree'])
const rootMatch = /Root window id:\s*(0x[0-9a-f]+)/i.exec(treeText)
const rootWid = rootMatch ? rootMatch[1].toLowerCase() : '0x0'

const margin = 320
const region = {
  left: input.x - margin,
  top: input.y - margin,
  right: input.x + input.width + margin,
  bottom: input.y + input.height + margin
}

function intersects(a, b) {
  return a.x < b.right && a.x + a.width > b.left && a.y < b.bottom && a.y + a.height > b.top
}

const treeWindows = []
for (const line of treeText.split('\n')) {
  const m = /^\s+(0x[0-9a-f]+)\s+(.*)$/i.exec(line)
  if (!m) continue
  const wid = m[1].toLowerCase()
  const rest = m[2]
  const geom = /(\d+)x(\d+)\+(-?\d+)\+(-?\d+)/.exec(rest)
  if (!geom) continue
  const quoted = [...rest.matchAll(/"([^"]*)"/g)].map((x) => x[1])
  const name = quoted[0] || ''
  const klass = quoted[1] || ''
  const win = {
    wid,
    name,
    klass,
    x: Number(geom[3]),
    y: Number(geom[4]),
    width: Number(geom[1]),
    height: Number(geom[2])
  }
  treeWindows.push(win)
}

const candidateSet = new Set(searchWids)
for (const win of treeWindows) {
  const fcitxish = /fcitx/i.test(win.name) || /fcitx/i.test(win.klass)
  if (fcitxish) candidateSet.add(win.wid)
  // Small popup-ish windows close to the composer: inspect them too so an
  // override-redirect candidate window without a fcitx class is not missed.
  if (win.width >= 10 && win.height >= 10 && win.width <= 900 && win.height <= 500) {
    if (intersects(win, region)) candidateSet.add(win.wid)
  }
}

function field(text, re) {
  const m = re.exec(text)
  return m ? m[1] : null
}

function inspect(wid) {
  const info = run('xwininfo', ['-id', wid])
  const props = run('xprop', ['-id', wid, 'WM_CLASS', 'WM_NAME', '_NET_WM_WINDOW_TYPE'])
  const mapState = field(info, /Map State:\s*(\w+)/)
  const override = /Override Redirect State:\s*yes/i.test(info)
  const classType = field(info, /\n\s*Class:\s*(\w+)/) || 'unknown'
  const ax = Number(field(info, /Absolute upper-left X:\s*(-?\d+)/) ?? NaN)
  const ay = Number(field(info, /Absolute upper-left Y:\s*(-?\d+)/) ?? NaN)
  const width = Number(field(info, /Width:\s*(\d+)/) ?? NaN)
  const height = Number(field(info, /Height:\s*(\d+)/) ?? NaN)
  const wmClass = field(props, /WM_CLASS\(STRING\)\s*=\s*"([^"]*)"/) || ''
  const wmName = field(props, /WM_NAME\((?:STRING|UTF8_STRING)\)\s*=\s*"([^"]*)"/) || ''
  const winType = field(props, /_NET_WM_WINDOW_TYPE\(ATOM\)\s*=\s*([^\n]*)/) || ''
  return {
    wid,
    map_state: mapState || 'unknown',
    override_redirect: override,
    class_type: classType,
    x: ax,
    y: ay,
    width,
    height,
    wm_class: wmClass,
    wm_name: wmName,
    window_type: winType.trim(),
    raw: info.trim()
  }
}

function distance(cand) {
  const candRight = cand.x + cand.width
  const candBottom = cand.y + cand.height
  const inputRight = input.x + input.width
  const inputBottom = input.y + input.height
  const dx = Math.max(input.x - cand.x, 0, cand.x - inputRight)
  const dy = Math.max(input.y - cand.y, 0, cand.y - inputBottom)
  const euclidean = Math.hypot(dx, dy)
  return {
    dx,
    dy,
    distance_px: Math.max(dx, dy),
    euclidean_px: Number(euclidean.toFixed(2)),
    horizontal_overlap: cand.x < inputRight && candRight > input.x,
    vertical_overlap: cand.y < inputBottom && candBottom > input.y,
    intersects_input: cand.x < inputRight && candRight > input.x && cand.y < inputBottom && candBottom > input.y
  }
}

const inspected = []
for (const wid of candidateSet) {
  if (wid === appWid || wid === rootWid) continue
  const cand = inspect(wid)
  if (!Number.isFinite(cand.x) || !Number.isFinite(cand.y)) continue
  if (!Number.isFinite(cand.width) || !Number.isFinite(cand.height)) continue
  if (cand.width < 10 || cand.height < 10) continue
  if (cand.width * cand.height < 100) continue
  if (cand.map_state !== 'IsViewable') continue
  const fcitxish = /fcitx/i.test(cand.wm_class) || /fcitx/i.test(cand.wm_name)
  const d = distance(cand)
  inspected.push({
    ...cand,
    fcitxish,
    near_input: d.distance_px <= margin,
    ...d
  })
}

// Prefer a real fcitx window; otherwise fall back to any small mapped
// override-redirect window close to the input.
inspected.sort((a, b) => {
  if (a.fcitxish !== b.fcitxish) return a.fcitxish ? -1 : 1
  if (a.distance_px !== b.distance_px) return a.distance_px - b.distance_px
  return (a.width * a.height) - (b.width * b.height)
})

const plausible = inspected.filter(
  (c) =>
    c.fcitxish ||
    (c.override_redirect &&
      c.class_type === 'InputOutput' &&
      !(c.x === 0 && c.y === 0) &&
      c.distance_px <= 200)
)
const selected = plausible[0] || null
const found = !!selected
const notAtOrigin = selected ? !(selected.x === 0 && selected.y === 0) : false
const pass = !!(
  selected &&
  selected.distance_px <= 20 &&
  notAtOrigin &&
  selected.map_state === 'IsViewable'
)

const metric =
  'max(dx,dy) edge-to-edge distance from candidate rect to input_rect_screen ' +
  '(dx=0 when horizontally overlapping, dy=0 when vertically overlapping); ' +
  'PASS if <=20px, not at origin (0,0), Map State IsViewable'

const result = {
  generated_at: new Date().toISOString(),
  app_wid: appWid,
  input_rect_screen: input,
  window_bounds: windowBounds,
  found,
  wids: plausible.map((c) => c.wid),
  geometry: selected
    ? { x: selected.x, y: selected.y, width: selected.width, height: selected.height }
    : null,
  distance_px: selected ? selected.distance_px : null,
  dx: selected ? selected.dx : null,
  dy: selected ? selected.dy : null,
  euclidean_px: selected ? selected.euclidean_px : null,
  metric,
  pass,
  not_at_origin: notAtOrigin,
  selected: selected
    ? {
        wid: selected.wid,
        map_state: selected.map_state,
        override_redirect: selected.override_redirect,
        fcitxish: selected.fcitxish,
        wm_class: selected.wm_class,
        wm_name: selected.wm_name,
        window_type: selected.window_type
      }
    : null,
  all: inspected
}

writeFileSync(outPath, `${JSON.stringify(result, null, 2)}\n`)

if (textPath) {
  const lines = []
  lines.push(`generated_at=${result.generated_at}`)
  lines.push(`app_wid=${appWid}`)
  lines.push(`input_rect_screen=${JSON.stringify(input)}`)
  lines.push(`window_bounds=${JSON.stringify(windowBounds)}`)
  lines.push(`xdotool_search_class_fcitx=${[...searchWids].join(',') || '(none)'}`)
  lines.push(`root_wid=${rootWid}`)
  lines.push('')
  lines.push('== xwininfo -root -tree (raw) ==')
  lines.push(treeText.trim())
  lines.push('')
  lines.push('== inspected mapped windows (small/near input or fcitx-ish) ==')
  if (inspected.length === 0) lines.push('(none)')
  for (const c of inspected) {
    lines.push(
      `wid=${c.wid} name=${JSON.stringify(c.wm_name)} class=${JSON.stringify(c.wm_class)}` +
        ` map=${c.map_state} override=${c.override_redirect ? 'yes' : 'no'} class_type=${c.class_type}` +
        ` geometry=${c.x},${c.y},${c.width},${c.height}` +
        ` fcitxish=${c.fcitxish} dx=${c.dx} dy=${c.dy}` +
        ` distance_px=${c.distance_px} euclidean=${c.euclidean_px}` +
        ` intersects_input=${c.intersects_input} window_type=${JSON.stringify(c.window_type)}`
    )
  }
  lines.push('')
  lines.push('== selected candidate ==')
  lines.push(selected ? JSON.stringify(result.selected, null, 2) : '(none)')
  lines.push('')
  lines.push('== metric ==')
  lines.push(metric)
  lines.push('')
  lines.push(`distance_px=${result.distance_px} not_at_origin=${notAtOrigin} pass=${pass}`)
  if (selected) {
    lines.push('')
    lines.push('== selected xwininfo raw ==')
    lines.push(selected.raw)
  }
  writeFileSync(textPath, `${lines.join('\n')}\n`)
}

process.exit(found ? 0 : 2)
