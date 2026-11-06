#!/usr/bin/env node
/**
 * NFR-08 — real-app fcitx5 IME evidence.
 *
 * Launches the BUILT app (Playwright `_electron`, args: ['.']) under the real
 * fcitx5 XIM stack, creates a loopback provider profile, composes Chinese with
 * xdotool through fcitx5/Rime, and records:
 *
 *   - candidate window geometry/distance via tools/ime-probe.mjs
 *   - Enter while composing must not POST (0 requests)
 *   - Space (Rime candidate commit) + Enter must POST exactly once
 *   - Esc while composing must cancel composition, keep the window visible and
 *     not POST
 *
 * Task 5 finding is carried forward honestly: on this machine Rime maps
 * Return to CommitRawInput, so Return during composition commits raw pinyin; it
 * does NOT commit Chinese. Chinese is committed with Space. No fcitx config is
 * modified: only runtime `fcitx5-remote -o/-s/-c` is used and the original
 * state/IM is restored in `finally`.
 *
 * Usage:
 *   source scripts/env.sh
 *   node tools/nfr08-real.mjs
 */

import { _electron as electron } from 'playwright'
import { execFileSync, spawn } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const EVID = path.join(ROOT, '.omo', 'evidence', 'm1')
const STAMP = new Date().toISOString().replace(/[:.]/g, '-')
const RUNTIME = path.join(ROOT, '.runtime', `nfr08-${STAMP}`)
const CACHE_HOME = path.join(ROOT, '.cache', 'xdg')
const DISPLAY = process.env.DISPLAY || ':0'
const COMPOSER = '[data-testid="composer"]'

const SERVER_LOG = path.join(EVID, 'nfr08-server.log')
const SERVER_BODY_LOG = path.join(EVID, 'nfr08-server-body.log')
const SERVER_OUT = path.join(EVID, 'nfr08-server.out')
const APP_LOG = path.join(EVID, 'nfr08-app.log')
const STATE_PATH = path.join(EVID, 'nfr08-state.json')
const CAND_JSON = path.join(EVID, 'nfr08-candidate.json')
const CAND_TXT = path.join(EVID, 'nfr08-candidate-windows.txt')
const CAND_PNG = path.join(EVID, 'nfr08-candidate.png')
const OUT_PATH = path.join(EVID, 'nfr08.json')

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
const xenv = { ...process.env, DISPLAY }

fs.mkdirSync(EVID, { recursive: true })
fs.mkdirSync(CACHE_HOME, { recursive: true })
for (const name of ['config', 'data', 'data/quickask-db', 'state']) {
  fs.mkdirSync(path.join(RUNTIME, name), { recursive: true })
}

function envFor(base) {
  return {
    ...process.env,
    DISPLAY,
    XMODIFIERS: '@im=fcitx',
    GTK_IM_MODULE: 'fcitx',
    QT_IM_MODULE: 'fcitx',
    XDG_CONFIG_HOME: path.join(base, 'config'),
    XDG_DATA_HOME: path.join(base, 'data'),
    XDG_STATE_HOME: path.join(base, 'state'),
    XDG_CACHE_HOME: CACHE_HOME,
    QUICKASK_DATA_DIR: path.join(base, 'data', 'quickask-db'),
    QUICKASK_DISABLE_ONBOARDING: '1'
  }
}

function tryRun(cmd, args, timeout = 10000) {
  try {
    return {
      ok: true,
      output: execFileSync(cmd, args, {
        encoding: 'utf8',
        env: xenv,
        timeout
      }).trim(),
      error: null
    }
  } catch (error) {
    return {
      ok: false,
      output: '',
      error: error instanceof Error ? error.message : String(error)
    }
  }
}

function run(cmd, args, timeout = 10000) {
  return tryRun(cmd, args, timeout).output
}

// ------------------------------------------------------------------- fcitx
function fcitx(args) {
  return tryRun('fcitx5-remote', args, 5000)
}

function readFcitxState() {
  return {
    state: fcitx([]).output.trim(),
    group: fcitx(['-q']).output,
    im: fcitx(['-n']).output
  }
}

const fcitxBefore = readFcitxState()

function ensureIme() {
  fcitx(['-o'])
  const current = fcitx(['-n']).output.trim()
  if (current !== 'rime') fcitx(['-s', 'rime'])
  return fcitx(['-n']).output.trim()
}

function restoreFcitx() {
  // Runtime-only switch back to the original IM, then the original active state.
  fcitx(['-o'])
  if (fcitxBefore.im) fcitx(['-s', fcitxBefore.im])
  if (fcitxBefore.state === '1' || fcitxBefore.state === '0') fcitx(['-c'])
  else if (fcitxBefore.state === '2') fcitx(['-o'])
  return readFcitxState()
}

// ------------------------------------------------------------------- server
function startServer() {
  fs.writeFileSync(SERVER_LOG, '')
  fs.writeFileSync(SERVER_BODY_LOG, '')
  fs.writeFileSync(SERVER_OUT, '')
  const outFd = fs.openSync(SERVER_OUT, 'a')
  const child = spawn(
    process.execPath,
    [
      path.join(ROOT, 'tools', 'mock-sse-server.mjs'),
      '--port',
      '0',
      '--mode',
      'normal',
      '--chunks',
      '2',
      '--delay',
      '50',
      '--log',
      SERVER_LOG,
      '--body-log',
      SERVER_BODY_LOG
    ],
    {
      cwd: ROOT,
      env: xenv,
      stdio: ['ignore', outFd, outFd]
    }
  )
  fs.closeSync(outFd)
  return child
}

function waitForServer(child, timeoutMs = 15000) {
  return new Promise((resolve, reject) => {
    const started = Date.now()
    let buffer = ''
    const finish = (error, port) => {
      clearInterval(poll)
      clearTimeout(timer)
      child.stdout?.removeListener('data', onData)
      if (error) reject(error)
      else resolve(port)
    }
    const onData = (chunk) => {
      buffer += chunk.toString()
      const match = /listening on http:\/\/[^:]+:(\d+)/.exec(buffer)
      if (match) finish(null, Number(match[1]))
    }
    child.stdout?.on('data', onData)
    const poll = setInterval(() => {
      try {
        const text = fs.readFileSync(SERVER_OUT, 'utf8')
        const match = /listening on http:\/\/[^:]+:(\d+)/.exec(text)
        if (match) finish(null, Number(match[1]))
      } catch {
        // file may not exist for a few ms
      }
      if (Date.now() - started > timeoutMs) {
        finish(new Error('mock server did not report a listening port'))
      }
    }, 100)
    const timer = setTimeout(() => {
      finish(new Error('mock server did not report a listening port'))
    }, timeoutMs)
  })
}

function countPosts() {
  try {
    const text = fs.readFileSync(SERVER_LOG, 'utf8')
    return text.split('\n').filter((line) => line.includes('POST /v1/chat/completions')).length
  } catch {
    return 0
  }
}

function readBodyLog() {
  try {
    return fs
      .readFileSync(SERVER_BODY_LOG, 'utf8')
      .split('\n')
      .filter((line) => line.trim())
      .map((line) => {
        try {
          return JSON.parse(line)
        } catch {
          return { parse_error: true, raw: line }
        }
      })
  } catch {
    return []
  }
}

// --------------------------------------------------------------- X utilities
function findQuickAskWid() {
  const search = tryRun('xdotool', ['search', '--name', '^QuickAsk$'])
  if (!search.ok || !search.output) return null
  const candidates = search.output.split('\n').filter(Boolean)
  for (const id of candidates) {
    const cls = tryRun('xprop', ['-id', id, 'WM_CLASS'])
    if (cls.ok && /"quickask"/.test(cls.output)) return id
  }
  return candidates[0] ?? null
}

function decToHex(value) {
  const n = Number(value)
  return Number.isFinite(n) && n > 0 ? `0x${n.toString(16)}` : null
}

function mapState(widHex) {
  const info = run('xwininfo', ['-id', widHex])
  const m = /Map State:\s*(\w+)/.exec(info)
  return m ? m[1] : 'unknown'
}

async function focusWindow(wid) {
  if (!wid) return
  tryRun('xdotool', ['windowraise', wid])
  tryRun('xdotool', ['windowactivate', '--sync', wid])
  tryRun('xdotool', ['windowfocus', '--sync', wid])
}

// --------------------------------------------------------------- screenshots
function captureSpectacle(target) {
  try {
    fs.rmSync(target, { force: true })
  } catch {
    // ignore
  }
  const shot = tryRun('spectacle', ['-b', '-n', '-f', '-o', target], 20000)
  // `spectacle -b` returns before the file is necessarily flushed.
  const deadline = Date.now() + 8000
  while (Date.now() < deadline) {
    try {
      const stat = fs.statSync(target)
      if (stat.size > 0) return { ok: true, size: stat.size, output: shot.output }
    } catch {
      // not written yet
    }
    // Spectacle is synchronous on this KDE build, but poll anyway.
    execFileSync('sleep', ['0.1'])
  }
  return { ok: false, size: 0, output: shot.output, error: shot.error }
}

// --------------------------------------------------------------- runtime hooks
async function installHooks(page) {
  await page.evaluate(() => {
    const w = window
    w.__nfr08 = {
      composing: false,
      compositionStarts: 0,
      compositionEnds: 0,
      keydowns: 0,
      events: [],
      startedAt: performance.now()
    }
    const value = () => {
      const el = document.querySelector('[data-testid="composer"]')
      return el instanceof HTMLTextAreaElement ? el.value : null
    }
    const push = (event, data) => {
      const state = w.__nfr08
      state.events.push({
        seq: state.events.length + 1,
        event,
        data,
        value: value(),
        composing: state.composing,
        ts: performance.now()
      })
      if (state.events.length > 1000) state.events.shift()
    }
    document.addEventListener(
      'compositionstart',
      (e) => {
        w.__nfr08.composing = true
        w.__nfr08.compositionStarts += 1
        push('compositionstart', { data: e.data })
      },
      true
    )
    document.addEventListener(
      'compositionupdate',
      (e) => push('compositionupdate', { data: e.data }),
      true
    )
    document.addEventListener(
      'compositionend',
      (e) => {
        w.__nfr08.composing = false
        w.__nfr08.compositionEnds += 1
        push('compositionend', { data: e.data })
      },
      true
    )
    document.addEventListener(
      'keydown',
      (e) =>
        push('keydown', {
          key: e.key,
          code: e.code,
          keyCode: e.keyCode,
          isComposing: e.isComposing,
          defaultPrevented: e.defaultPrevented
        }),
      true
    )
    document.addEventListener(
      'keyup',
      (e) => push('keyup', { key: e.key, keyCode: e.keyCode, isComposing: e.isComposing }),
      true
    )
    document.addEventListener(
      'input',
      (e) => {
        if (e.target instanceof HTMLTextAreaElement && e.target.matches('[data-testid="composer"]')) {
          push('input', { inputType: e.inputType, data: e.data })
        }
      },
      true
    )
  })
}

async function readRuntime(page) {
  return page.evaluate(() => {
    const el = document.querySelector('[data-testid="composer"]')
    const nfr = window.__nfr08 || null
    return {
      value: el instanceof HTMLTextAreaElement ? el.value : null,
      focused: el instanceof HTMLTextAreaElement ? document.activeElement === el : false,
      composing: nfr ? nfr.composing : null,
      compositionStarts: nfr ? nfr.compositionStarts : null,
      compositionEnds: nfr ? nfr.compositionEnds : null,
      keydowns: nfr ? nfr.keydowns : null,
      recent: nfr ? nfr.events.slice(-80) : []
    }
  })
}

async function snapshot(page) {
  return page.evaluate(async () => {
    const el = document.querySelector('[data-testid="composer"]')
    const state = await window.quickask.window.getState()
    const session = await window.quickask.sessions.state()
    return {
      value: el instanceof HTMLTextAreaElement ? el.value : null,
      focused: el instanceof HTMLTextAreaElement ? document.activeElement === el : false,
      window: state.ok ? state.data : { error: state.error },
      session: session.ok
        ? {
            currentSessionId: session.data.currentSessionId,
            mode: session.data.mode,
            activeRequestId: session.data.activeRequestId,
            messages: session.data.messages.slice(-6)
          }
        : { error: session.error }
    }
  })
}

async function composerScreenRect(page) {
  return page.evaluate(async () => {
    const el = document.querySelector('[data-testid="composer"]')
    if (!(el instanceof HTMLTextAreaElement)) throw new Error('composer textarea missing')
    const rect = el.getBoundingClientRect()
    const state = await window.quickask.window.getState()
    const bounds = state.ok ? state.data.bounds : null
    return {
      rect_css: { x: rect.x, y: rect.y, width: rect.width, height: rect.height },
      bounds,
      screen_x: window.screenX,
      screen_y: window.screenY,
      outer_width: window.outerWidth,
      outer_height: window.outerHeight,
      device_pixel_ratio: window.devicePixelRatio,
      ready_state: document.readyState,
      url: location.href
    }
  })
}

async function focusComposer(page, wid) {
  await focusWindow(wid)
  await page.locator(COMPOSER).focus()
  await page.waitForTimeout(120)
  // If X focus/activation was rejected, click the composer once (the window's
  // ShapeInput rect includes this area). This is a real mouse click, not a
  // synthetic focus bypass.
  const runtime = await readRuntime(page)
  if (!runtime.focused) {
    const geom = await composerScreenRect(page)
    if (geom.bounds) {
      const cx = Math.round(geom.bounds.x + geom.rect_css.x + geom.rect_css.width / 2)
      const cy = Math.round(geom.bounds.y + geom.rect_css.y + geom.rect_css.height / 2)
      tryRun('xdotool', ['mousemove', '--sync', String(cx), String(cy)])
      tryRun('xdotool', ['click', '1'])
      await page.waitForTimeout(150)
      await page.locator(COMPOSER).focus()
      await page.waitForTimeout(80)
    }
  }
  return readRuntime(page)
}

async function clearComposer(page, wid) {
  await focusComposer(page, wid)
  tryRun('xdotool', ['key', '--clearmodifiers', 'ctrl+a', 'BackSpace'])
  await page.waitForTimeout(250)
  return readRuntime(page)
}

async function typeThroughFcitx(page, wid, text) {
  await focusComposer(page, wid)
  ensureIme()
  tryRun('xdotool', ['type', '--delay', '80', text])
  await page.waitForTimeout(800)
  return readRuntime(page)
}

function chineseCount(text) {
  return Array.from(text || '').filter((ch) => /[\u3400-\u9fff]/.test(ch)).length
}

function isImeProcessKeydown(event) {
  return (
    event.event === 'keydown' &&
    (event.data?.keyCode === 229 || event.data?.key === 'Process')
  )
}

function selectImeProcessKeydowns(events) {
  return events.filter(isImeProcessKeydown)
}

function selectCompositionEvents(events) {
  return events.filter(
    (event) =>
      event.event === 'compositionstart' ||
      event.event === 'compositionupdate' ||
      event.event === 'compositionend'
  )
}

function keydownBeforeLastCompositionEnd(events) {
  const endIndex = events.map((event) => event.event).lastIndexOf('compositionend')
  const scope = endIndex >= 0 ? events.slice(0, endIndex) : events
  return scope.filter((event) => event.event === 'keydown').at(-1) ?? null
}

// ---------------------------------------------------------------- main driver
let app = null
let server = null
let serverPort = null
let appPid = null
let result = null
let failure = null
let wid = null
let widHex = null

try {
  server = startServer()
  serverPort = await waitForServer(server)
  const baseUrl = `http://127.0.0.1:${serverPort}/v1`

  const launchEnv = envFor(RUNTIME)
  const appLogFd = fs.openSync(APP_LOG, 'a')
  app = await electron.launch({
    args: ['.'],
    cwd: ROOT,
    env: launchEnv,
    timeout: 30000
  })
  appPid = app.process()?.pid ?? null
  app.process()?.stdout?.on('data', (chunk) => {
    try {
      fs.writeSync(appLogFd, chunk)
    } catch {
      // ignore
    }
  })
  app.process()?.stderr?.on('data', (chunk) => {
    try {
      fs.writeSync(appLogFd, chunk)
    } catch {
      // ignore
    }
  })

  const page = await app.firstWindow({ timeout: 30000 })
  await page.waitForSelector('[data-testid="app-root"]', { timeout: 30000 })
  await installHooks(page)

  const show = await page.evaluate(() => window.quickask.window.show())
  if (!show?.ok) throw new Error(`window.show failed: ${JSON.stringify(show)}`)
  await page.waitForFunction(
    () =>
      document.querySelector('[data-testid="app-root"]')?.getAttribute('data-ui-mode') === 'S1',
    undefined,
    { timeout: 5000 }
  )
  await page.waitForTimeout(800)

  wid = findQuickAskWid()
  if (!wid) throw new Error('QuickAsk X11 window not found (xdotool search --name ^QuickAsk$)')
  widHex = decToHex(wid)
  await focusWindow(wid)
  await page.waitForTimeout(300)

  // Provider profile: loopback, no API key, default/first.
  const provider = await page.evaluate(async ({ url }) => {
    const before = await window.quickask.provider.list()
    if (!before.ok) return { ok: false, stage: 'list', error: before.error }
    let created = null
    if (before.data.profiles.length === 0) {
      const res = await window.quickask.provider.create({
        name: 'NFR08 Loopback',
        baseUrl: url,
        model: 'mock',
        isDefault: true
      })
      if (!res.ok) return { ok: false, stage: 'create', error: res.error }
      created = res.data
    }
    const after = await window.quickask.provider.list()
    if (!after.ok) return { ok: false, stage: 'list-after', error: after.error }
    const chosen = after.data.profiles[0]
    if (!chosen) return { ok: false, stage: 'chosen', error: 'no provider profiles' }
    let defaulted = chosen
    if (!chosen.isDefault) {
      const updated = await window.quickask.provider.update({
        id: chosen.id,
        isDefault: true
      })
      if (!updated.ok) return { ok: false, stage: 'default', error: updated.error }
      defaulted = updated.data
    }
    return {
      ok: true,
      created,
      chosen: defaulted,
      profiles_before: before.data.profiles,
      profiles_after_direct: after.data.profiles
    }
  }, { url: baseUrl })
  if (!provider.ok) throw new Error(`provider setup failed: ${JSON.stringify(provider)}`)

  await focusComposer(page, wid)
  const initial = await readRuntime(page)
  if (!initial.focused) throw new Error('composer did not take DOM focus')

  const geom = await composerScreenRect(page)
  if (!geom.bounds) throw new Error('window bounds unavailable')
  const inputRectScreen = {
    x: Math.round(geom.bounds.x + geom.rect_css.x),
    y: Math.round(geom.bounds.y + geom.rect_css.y),
    width: Math.round(geom.rect_css.width),
    height: Math.round(geom.rect_css.height)
  }
  const windowBounds = {
    x: geom.bounds.x,
    y: geom.bounds.y,
    width: geom.bounds.width,
    height: geom.bounds.height
  }
  fs.writeFileSync(
    STATE_PATH,
    `${JSON.stringify(
      {
        generated_at: new Date().toISOString(),
        app_wid: widHex,
        app_wid_decimal: wid,
        input_rect_screen: inputRectScreen,
        window_bounds: windowBounds,
        input_rect_css: geom.rect_css,
        window_screen_x: geom.screen_x,
        window_screen_y: geom.screen_y,
        outer_width: geom.outer_width,
        outer_height: geom.outer_height,
        device_pixel_ratio: geom.device_pixel_ratio,
        composer_value: initial.value,
        source:
          'page.evaluate(getBoundingClientRect) + window.quickask.window.getState().bounds'
      },
      null,
      2
    )}\n`
  )

  // ------------------------------------------------------------ candidate
  let candidateTyping = await typeThroughFcitx(page, wid, 'nihao')
  let candidateAttempts = 1
  while (!candidateTyping.composing && candidateAttempts < 3) {
    await clearComposer(page, wid)
    candidateTyping = await typeThroughFcitx(page, wid, 'nihao')
    candidateAttempts += 1
  }
  if (!candidateTyping.composing) {
    throw new Error(
      `fcitx composition did not start after ${candidateAttempts} attempts (im=${fcitx(['-n']).output})`
    )
  }
  await page.waitForTimeout(400)
  const candidateState = await readRuntime(page)
  const screenshot = captureSpectacle(CAND_PNG)
  const probe = tryRun(
    process.execPath,
    [
      path.join(ROOT, 'tools', 'ime-probe.mjs'),
      '--state',
      STATE_PATH,
      '--app-wid',
      widHex ?? wid,
      '--out',
      CAND_JSON,
      '--text',
      CAND_TXT
    ],
    30000
  )
  let candidateJson = null
  try {
    candidateJson = JSON.parse(fs.readFileSync(CAND_JSON, 'utf8'))
  } catch {
    candidateJson = null
  }

  // ------------------------------------------------- Enter while composing
  const postsBeforeComposingEnter = countPosts()
  const runtimeBeforeComposingEnter = await readRuntime(page)
  tryRun('xdotool', ['key', 'Return'])
  await page.waitForTimeout(600)
  const postsAfterComposingEnter = countPosts()
  const afterComposingEnter = await readRuntime(page)
  const composingEnterSnapshot = await snapshot(page)
  const composingEnterEvents = selectCompositionEvents(afterComposingEnter.recent)
  const composingEnterImeKeydowns = selectImeProcessKeydowns(afterComposingEnter.recent)
  const composingEnterLastKeydown = keydownBeforeLastCompositionEnd(afterComposingEnter.recent)
  const rawPinyinCommit =
    afterComposingEnter.value.length > 0 &&
    /^[a-zA-Z ]+$/.test(afterComposingEnter.value) &&
    chineseCount(afterComposingEnter.value) === 0
  const composingEnter = {
    attempt_typing: candidateAttempts,
    composition_active_before: runtimeBeforeComposingEnter.composing,
    composition_events_seen: composingEnterEvents.length,
    ime_process_keydowns: composingEnterImeKeydowns.slice(-5),
    last_keydown_before_compositionend: composingEnterLastKeydown,
    composition_ended: !afterComposingEnter.composing,
    composition_end_data:
      [...composingEnterEvents].reverse().find((event) => event.event === 'compositionend')?.data ??
      null,
    value_before: runtimeBeforeComposingEnter.value,
    value_after: afterComposingEnter.value,
    chinese_commit: chineseCount(afterComposingEnter.value) > 0,
    raw_pinyin_commit: rawPinyinCommit,
    posts_before: postsBeforeComposingEnter,
    posts_after: postsAfterComposingEnter,
    posts_delta: postsAfterComposingEnter - postsBeforeComposingEnter,
    events_tail: afterComposingEnter.recent.slice(-16),
    snapshot: composingEnterSnapshot,
    pass:
      postsAfterComposingEnter - postsBeforeComposingEnter === 0 &&
      runtimeBeforeComposingEnter.composing === true &&
      !afterComposingEnter.composing &&
      rawPinyinCommit
  }

  // ---------------------------------------------------- Space + Enter commit
  await clearComposer(page, wid)
  let commitTyping = await typeThroughFcitx(page, wid, 'nihao')
  let commitAttempts = 1
  while (!commitTyping.composing && commitAttempts < 3) {
    await clearComposer(page, wid)
    commitTyping = await typeThroughFcitx(page, wid, 'nihao')
    commitAttempts += 1
  }
  if (!commitTyping.composing) {
    throw new Error(`commit composition did not start after ${commitAttempts} attempts`)
  }
  const postsBeforeCommit = countPosts()
  tryRun('xdotool', ['key', 'space'])
  await page.waitForTimeout(600)
  const afterSpace = await readRuntime(page)
  const chineseCommitted = chineseCount(afterSpace.value) > 0
  tryRun('xdotool', ['key', 'Return'])
  await page.waitForTimeout(1500)
  const postsAfterCommit = countPosts()
  const afterCommit = await readRuntime(page)
  const commitSnapshot = await snapshot(page)
  const bodies = readBodyLog()
  const lastBody = bodies.length > 0 ? bodies[bodies.length - 1] : null
  const sentMessages = Array.isArray(lastBody?.messages)
    ? lastBody.messages.filter((message) => message?.role === 'user').map((message) => message.content)
    : []
  const lastUserMessage =
    commitSnapshot.session?.messages
      ?.filter((message) => message.role === 'user')
      .map((message) => message.content)
      .at(-1) ?? null
  const enterCommitted = {
    attempt_typing: commitAttempts,
    composition_active_before: commitTyping.composing,
    commit_key: 'space',
    value_after_space: afterSpace.value,
    chinese_commit: chineseCommitted,
    value_after_enter: afterCommit.value,
    posts_before: postsBeforeCommit,
    posts_after: postsAfterCommit,
    posts_delta: postsAfterCommit - postsBeforeCommit,
    body_log_messages: sentMessages,
    session_last_user_message: lastUserMessage,
    session_mode: commitSnapshot.session?.mode ?? null,
    snapshot: commitSnapshot,
    pass:
      chineseCommitted &&
      postsAfterCommit - postsBeforeCommit === 1 &&
      [...sentMessages, lastUserMessage].some((content) => chineseCount(content) > 0)
  }

  // ------------------------------------------------------- Esc while composing
  await page.waitForTimeout(600)
  await clearComposer(page, wid)
  let escTyping = await typeThroughFcitx(page, wid, 'shijie')
  let escAttempts = 1
  while (!escTyping.composing && escAttempts < 3) {
    await clearComposer(page, wid)
    escTyping = await typeThroughFcitx(page, wid, 'shijie')
    escAttempts += 1
  }
  const postsBeforeEsc = countPosts()
  const composingBeforeEsc = escTyping.composing
  tryRun('xdotool', ['key', 'Escape'])
  await page.waitForTimeout(600)
  const postsAfterEsc = countPosts()
  const afterEsc = await readRuntime(page)
  const escSnapshot = await snapshot(page)
  const mapAfterEsc = widHex ? mapState(widHex) : 'unknown'
  const ESC_STATE_PATH = path.join(EVID, 'nfr08-state-after-esc.json')
  const escGeom = await composerScreenRect(page)
  if (escGeom.bounds) {
    fs.writeFileSync(
      ESC_STATE_PATH,
      `${JSON.stringify(
        {
          generated_at: new Date().toISOString(),
          app_wid: widHex,
          app_wid_decimal: wid,
          input_rect_screen: {
            x: Math.round(escGeom.bounds.x + escGeom.rect_css.x),
            y: Math.round(escGeom.bounds.y + escGeom.rect_css.y),
            width: Math.round(escGeom.rect_css.width),
            height: Math.round(escGeom.rect_css.height)
          },
          window_bounds: {
            x: escGeom.bounds.x,
            y: escGeom.bounds.y,
            width: escGeom.bounds.width,
            height: escGeom.bounds.height
          },
          input_rect_css: escGeom.rect_css,
          phase: 'after-esc-S2'
        },
        null,
        2
      )}\n`
    )
  }
  let candidateAfterEsc = null
  try {
    const probeEsc = tryRun(
      process.execPath,
      [
        path.join(ROOT, 'tools', 'ime-probe.mjs'),
        '--state',
        ESC_STATE_PATH,
        '--app-wid',
        widHex ?? wid,
        '--out',
        path.join(EVID, 'nfr08-candidate-after-esc.json'),
        '--text',
        path.join(EVID, 'nfr08-candidate-after-esc.txt')
      ],
      30000
    )
    candidateAfterEsc = {
      exit_ok: probeEsc.ok,
      output: probeEsc.output,
      error: probeEsc.error
    }
    try {
      candidateAfterEsc.result = JSON.parse(
        fs.readFileSync(path.join(EVID, 'nfr08-candidate-after-esc.json'), 'utf8')
      )
    } catch {
      // no candidate file means the popup is gone; keep the raw probe status
    }
  } catch (error) {
    candidateAfterEsc = { error: error instanceof Error ? error.message : String(error) }
  }
  const escCompositionEvents = selectCompositionEvents(afterEsc.recent)
  const escComposing = {
    attempt_typing: escAttempts,
    composition_active_before: composingBeforeEsc,
    value_before: escTyping.value,
    value_after: afterEsc.value,
    composing_after: afterEsc.composing,
    composition_events_seen: escCompositionEvents.length,
    composition_canceled:
      !afterEsc.composing &&
      escCompositionEvents.some((event) => event.event === 'compositionend') &&
      afterEsc.value === '',
    value_after_empty: afterEsc.value === '',
    window_visible:
      escSnapshot.window?.visible === true &&
      (mapAfterEsc === 'IsViewable' || mapAfterEsc === 'unknown'),
    map_state: mapAfterEsc,
    posts_before: postsBeforeEsc,
    posts_after: postsAfterEsc,
    posts_delta: postsAfterEsc - postsBeforeEsc,
    candidate_after_esc: candidateAfterEsc,
    snapshot: escSnapshot,
    pass:
      composingBeforeEsc &&
      !afterEsc.composing &&
      afterEsc.value === '' &&
      escSnapshot.window?.visible === true &&
      (mapAfterEsc === 'IsViewable' || mapAfterEsc === 'unknown') &&
      postsAfterEsc - postsBeforeEsc === 0
  }

  // ------------------------------------------------------------ verdict
  const checks = {
    candidate_found: candidateJson?.found === true,
    candidate_geometry_pass: candidateJson?.pass === true,
    candidate_screenshot: screenshot.ok && fs.existsSync(CAND_PNG),
    composing_enter_zero_posts: composingEnter.posts_delta === 0,
    composing_enter_raw_commit: composingEnter.raw_pinyin_commit === true,
    composing_enter_is_composing_before: composingEnter.composition_active_before === true,
    committed_space_chinese: enterCommitted.chinese_commit,
    committed_enter_one_post: enterCommitted.posts_delta === 1,
    committed_message_chinese: enterCommitted.pass,
    esc_composition_canceled: escComposing.composition_canceled,
    esc_window_visible: escComposing.window_visible,
    esc_zero_posts: escComposing.posts_delta === 0
  }
  const corePass =
    checks.composing_enter_zero_posts &&
    checks.composing_enter_raw_commit &&
    checks.composing_enter_is_composing_before &&
    checks.committed_enter_one_post &&
    checks.committed_space_chinese &&
    checks.committed_message_chinese &&
    checks.esc_composition_canceled &&
    checks.esc_window_visible &&
    checks.esc_zero_posts
  const evidencePass = corePass && checks.candidate_found && checks.candidate_geometry_pass && checks.candidate_screenshot
  let verdict = 'FAIL'
  if (evidencePass) verdict = 'PASS'
  else if (corePass) verdict = 'PARTIAL'

  const limitation = [
    'Task 5 finding carried forward: on this machine fcitx5 Rime maps Return to CommitRawInput.',
    'Return during composition commits raw pinyin and does NOT commit Chinese; it is prevented from sending (0 POST).',
    'Chinese is committed with Space (Rime first candidate), then Return sends (1 POST).',
    'No fcitx config file is written; only runtime -o/-s/-c switches are used and the original state/IM is restored.'
  ].join(' ')
  const metric =
    'candidate: ime-probe max(dx,dy) edge-to-edge distance to composer rect <=20px, not at origin, Map State IsViewable; ' +
    'composing Enter: POST /v1/chat/completions delta = 0; ' +
    'Space+Enter: POST delta = 1 and a Chinese user message reaches the mock server; ' +
    'composing Esc: composition ends/cancels, window stays IsViewable, POST delta = 0.'

  const fcitxAfter = readFcitxState()
  result = {
    nfr: 'NFR-08',
    generated_at: new Date().toISOString(),
    verdict,
    pass: evidencePass,
    app: {
      built: true,
      cwd: ROOT,
      argv: ['.'],
      pid: appPid,
      runtime_dir: RUNTIME,
      composer_selector: COMPOSER,
      provider: {
        id: provider.chosen?.id ?? null,
        name: provider.chosen?.name ?? null,
        baseUrl: provider.chosen?.baseUrl ?? null,
        model: provider.chosen?.model ?? null,
        isDefault: provider.chosen?.isDefault ?? null,
        hasApiKey: provider.chosen?.hasApiKey ?? null
      }
    },
    fcitx: {
      before: fcitxBefore,
      used_im: 'rime',
      after: fcitxAfter,
      restored_exact:
        fcitxAfter.im === fcitxBefore.im &&
        fcitxAfter.group === fcitxBefore.group &&
        fcitxAfter.state === fcitxBefore.state,
      config_modified: false
    },
    candidate: {
      found: candidateJson?.found ?? false,
      geometry: candidateJson?.geometry ?? null,
      distance_px: candidateJson?.distance_px ?? null,
      dx: candidateJson?.dx ?? null,
      dy: candidateJson?.dy ?? null,
      not_at_origin: candidateJson?.not_at_origin ?? null,
      selected: candidateJson?.selected ?? null,
      all: candidateJson?.all ?? null,
      probe_ok: probe.ok,
      probe_exit: probe.ok ? 0 : 2,
      screenshot: {
        path: path.relative(ROOT, CAND_PNG),
        captured: screenshot.ok,
        size: screenshot.size ?? 0,
        output: screenshot.output ?? null
      },
      typing: {
        attempts: candidateAttempts,
        composing: candidateState.composing,
        value: candidateState.value
      },
      pass: checks.candidate_found && checks.candidate_geometry_pass && checks.candidate_screenshot
    },
    enter_composing: composingEnter,
    enter_committed: enterCommitted,
    esc_composing: escComposing,
    checks,
    metric,
    limitation,
    artifacts: {
      json: path.relative(ROOT, OUT_PATH),
      candidate_json: path.relative(ROOT, CAND_JSON),
      candidate_txt: path.relative(ROOT, CAND_TXT),
      candidate_png: path.relative(ROOT, CAND_PNG),
      state_json: path.relative(ROOT, STATE_PATH),
      server_log: path.relative(ROOT, SERVER_LOG),
      server_body_log: path.relative(ROOT, SERVER_BODY_LOG),
      app_log: path.relative(ROOT, APP_LOG)
    }
  }
} catch (error) {
  failure = error instanceof Error ? { message: error.message, stack: error.stack } : { message: String(error) }
  const fcitxAfter = readFcitxState()
  result = {
    nfr: 'NFR-08',
    generated_at: new Date().toISOString(),
    verdict: 'FAIL',
    pass: false,
    error: failure,
    fcitx: {
      before: fcitxBefore,
      after: fcitxAfter,
      restored_exact:
        fcitxAfter.im === fcitxBefore.im &&
        fcitxAfter.group === fcitxBefore.group &&
        fcitxAfter.state === fcitxBefore.state,
      config_modified: false
    },
    metric: 'run aborted before the complete NFR-08 sequence finished; no PASS is claimed',
    limitation: 'FAIL recorded honestly from the real-app run; see error and artifacts.'
  }
} finally {
  try {
    if (app) {
      await Promise.race([app.close(), sleep(10000)])
    }
  } catch {
    // fall through to PID kill
  }
  if (appPid) {
    try {
      process.kill(appPid, 'SIGKILL')
    } catch {
      // already gone
    }
  }
  if (server?.pid) {
    try {
      server.kill('SIGTERM')
    } catch {
      // already gone
    }
    for (let i = 0; i < 40; i += 1) {
      try {
        process.kill(server.pid, 0)
      } catch {
        break
      }
      await sleep(100)
    }
    try {
      process.kill(server.pid, 'SIGKILL')
    } catch {
      // already gone
    }
  }
  const fcitxRestored = restoreFcitx()
  if (result) {
    result.fcitx = {
      before: fcitxBefore,
      ...(result.fcitx ?? {}),
      after: fcitxRestored,
      restored_exact:
        fcitxRestored.im === fcitxBefore.im &&
        fcitxRestored.group === fcitxBefore.group &&
        fcitxRestored.state === fcitxBefore.state,
      config_modified: false
    }
    fs.mkdirSync(EVID, { recursive: true })
    fs.writeFileSync(OUT_PATH, `${JSON.stringify(result, null, 2)}\n`)
  }
}

if (result) {
  process.stdout.write(`NFR-08 ${result.verdict}\n`)
  process.stdout.write(`evidence: ${OUT_PATH}\n`)
  process.stdout.write(`posts: ${countPosts()}\n`)
}
process.exitCode = result?.pass ? 0 : 1
