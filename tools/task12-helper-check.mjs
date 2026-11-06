import { execFileSync, spawn } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = fileURLToPath(new URL('..', import.meta.url))
const EVIDENCE = join(ROOT, '.omo', 'evidence')
const READY = join(EVIDENCE, 'task-12-helper-window.json')
const HELPER = join(ROOT, 'native', 'quickask-x11')
const FIXTURE = join(ROOT, 'tools', 'task12-window.cjs')
const DISPLAY = process.env.DISPLAY || ':0'

mkdirSync(EVIDENCE, { recursive: true })
rmSync(READY, { force: true })

function run(command, args) {
  return execFileSync(command, args, {
    encoding: 'utf8',
    env: { ...process.env, DISPLAY }
  })
}

function parseFields(stdout) {
  const fields = new Map()
  for (const line of stdout.split('\n')) {
    const index = line.indexOf('=')
    if (index > 0) fields.set(line.slice(0, index), line.slice(index + 1))
  }
  return fields
}

function parseRects(stdout) {
  const fields = parseFields(stdout)
  const rects = []
  for (const chunk of (fields.get('RECTS') || '').split(';')) {
    if (!chunk) continue
    const [x, y, width, height] = chunk.split(',').map(Number)
    rects.push({ x, y, width, height })
  }
  return { count: Number(fields.get('INPUT_SHAPE') || 0), rects }
}

function sameRects(actual, expected) {
  const key = (rect) => `${rect.x},${rect.y},${rect.width},${rect.height}`
  const left = actual.map(key).sort()
  const right = expected.map(key).sort()
  return JSON.stringify(left) === JSON.stringify(right)
}

async function waitForReady(child) {
  let output = ''
  child.stdout?.on('data', (data) => {
    output += data.toString()
  })
  child.stderr?.on('data', (data) => {
    output += data.toString()
  })

  const deadline = Date.now() + 15000
  while (Date.now() < deadline) {
    if (existsSync(READY)) {
      const info = JSON.parse(readFileSync(READY, 'utf8'))
      if (info.widHex) return { info, output }
    }
    await new Promise((resolve) => setTimeout(resolve, 100))
  }
  throw new Error(`fixture did not become ready\n${output}`)
}

async function stop(child) {
  if (!child.pid) return
  try {
    process.kill(-child.pid, 'SIGTERM')
  } catch {
    child.kill('SIGTERM')
  }
  await new Promise((resolve) => setTimeout(resolve, 500))
  try {
    process.kill(-child.pid, 'SIGKILL')
  } catch {
    try {
      child.kill('SIGKILL')
    } catch {
      // already gone
    }
  }
}

let child
try {
  child = spawn(join(ROOT, 'node_modules', '.bin', 'electron'), [FIXTURE], {
    cwd: ROOT,
    env: { ...process.env, DISPLAY },
    detached: true,
    stdio: ['ignore', 'pipe', 'pipe']
  })

  const { info } = await waitForReady(child)
  const wid = info.widHex
  const expectedRects = [
    { x: 40, y: 28, width: 680, height: 48 },
    { x: 40, y: 88, width: 680, height: 120 }
  ]

  const wmClass = run(HELPER, ['set-wm-class', wid, 'quickask', 'quickask']).trim()
  const setShape = run(HELPER, [
    'set-input-shape',
    wid,
    '40,28,680,48,40,88,680,120'
  ]).trim()
  const queryShape = run(HELPER, ['query-input-shape', wid]).trim()
  const shape = parseRects(queryShape)

  const setStates = run(HELPER, ['set-states', wid]).trim()
  const remap = run(HELPER, ['remap-states', wid]).trim()
  await new Promise((resolve) => setTimeout(resolve, 150))
  const reassert = run(HELPER, ['set-states', wid]).trim()
  await new Promise((resolve) => setTimeout(resolve, 150))
  const xprop = run('xprop', ['-id', wid, '_NET_WM_STATE']).trim()
  const atoms = [
    '_NET_WM_STATE_SKIP_TASKBAR',
    '_NET_WM_STATE_SKIP_PAGER',
    '_KDE_NET_WM_STATE_SKIP_SWITCHER',
    '_NET_WM_STATE_ABOVE'
  ]
  const atomsPresent = atoms.every((atom) => xprop.includes(atom))

  const result = {
    wid,
    pid: info.pid,
    wmClass,
    setShape,
    queryShape,
    shapeMatches: sameRects(shape.rects, expectedRects),
    setStates,
    remap,
    reassert,
    xprop,
    atomsPresent,
    atoms
  }

  writeFileSync(
    join(EVIDENCE, 'task-12-helper-check.json'),
    `${JSON.stringify(result, null, 2)}\n`
  )
  writeFileSync(
    join(EVIDENCE, 'task-12-helper-check.log'),
    [
      `WID=${wid}`,
      wmClass,
      setShape,
      queryShape,
      `shape_matches=${result.shapeMatches}`,
      setStates,
      remap,
      reassert,
      `xprop=${xprop}`,
      `atoms_present=${atomsPresent}`,
      ''
    ].join('\n')
  )

  if (!result.shapeMatches) throw new Error('query-input-shape does not match set-input-shape')
  if (!atomsPresent) throw new Error('remap-states did not leave all four atoms')
  console.log(JSON.stringify(result, null, 2))
} finally {
  if (child) await stop(child)
}
