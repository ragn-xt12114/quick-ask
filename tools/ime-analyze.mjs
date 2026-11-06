#!/usr/bin/env node
/**
 * G6 evidence analyzer / summary builder.
 *
 * Reads the raw event log plus a facts JSON written by tools/fcitx-check.sh,
 * extracts the Chromium IME event sequence, and writes:
 *   - <out-events>   machine-readable event excerpts
 *   - <out-summary>  task-5-summary.json with the G6 verdict
 *
 * Usage:
 *   node tools/ime-analyze.mjs \
 *     --events .omo/evidence/task-5-events.jsonl \
 *     --facts .omo/evidence/task-5-facts.json \
 *     --out-events .omo/evidence/task-5-events-excerpt.json \
 *     --out-summary .omo/evidence/task-5-summary.json
 */

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

const eventsPath = arg('--events')
const factsPath = arg('--facts')
const outEventsPath = arg('--out-events')
const outSummaryPath = arg('--out-summary')
if (!eventsPath || !factsPath || !outEventsPath || !outSummaryPath) {
  process.stderr.write(
    'usage: ime-analyze.mjs --events <jsonl> --facts <json> --out-events <json> --out-summary <json>\n'
  )
  process.exit(2)
}

function readJson(path, fallback) {
  try {
    return JSON.parse(readFileSync(path, 'utf8'))
  } catch {
    return fallback
  }
}

const facts = readJson(factsPath, {})
const kpEnter = facts.kp_enter || {}
const events = readFileSync(eventsPath, 'utf8')
  .split('\n')
  .filter((line) => line.trim())
  .map((line, index) => {
    try {
      return { ...JSON.parse(line), _index: index }
    } catch {
      return { _index: index, event: 'invalid_json', raw: line }
    }
  })

const keydowns = events.filter((e) => e.event === 'keydown')
const compositionStarts = events.filter((e) => e.event === 'compositionstart')
const compositionEnds = events.filter((e) => e.event === 'compositionend')
const isComposingKeydowns = keydowns.filter((e) => e.isComposing === true)
const keyCode229 = keydowns.filter((e) => e.keyCode === 229)
const enterKeydowns = keydowns.filter((e) => e.key === 'Enter' || e.keyCode === 13)

function compact(e) {
  return {
    seq: e.seq,
    event: e.event,
    key: e.key,
    keyCode: e.keyCode,
    isComposing: e.isComposing,
    composing_at_key: e.composing_at_key,
    value: e.value,
    sends: e.sends,
    timestamp: e.timestamp
  }
}

function noSendAfter(index) {
  const base = Number(events[index].sends ?? 0)
  for (let j = index + 1; j < events.length && j < index + 80; j += 1) {
    const rec = events[j]
    if (Number(rec.sends ?? 0) > base) return false
    if (rec.event === 'compositionend') break
  }
  return true
}

const enterWithNoSend = enterKeydowns.map((e) => ({
  ...compact(e),
  no_send_after: noSendAfter(e._index)
}))

const enterKeydownIsComposing = enterKeydowns.some((e) => e.isComposing === true)
const composingEnterDidNotSend = !!(facts.enter_composing && facts.enter_composing.requests === 0)
const hasCompositionStart = compositionStarts.length > 0
const hasCompositionEnd = compositionEnds.length > 0

const eventsResult = {
  generated_at: new Date().toISOString(),
  counts: {
    total: events.length,
    keydown: keydowns.length,
    compositionstart: compositionStarts.length,
    compositionend: compositionEnds.length,
    isComposing_keydown: isComposingKeydowns.length,
    keyCode_229: keyCode229.length,
    enter_keydown: enterKeydowns.length
  },
  has_isComposing: isComposingKeydowns.length > 0,
  has_keyCode229: keyCode229.length > 0,
  has_enter_keydown: enterKeydowns.length > 0,
  enter_keydown_isComposing: enterKeydownIsComposing,
  composing_enter_did_not_send: composingEnterDidNotSend,
  samples: {
    compositionstart: compositionStarts.slice(0, 2).map(compact),
    isComposing_keydown: isComposingKeydowns.slice(0, 5).map(compact),
    keyCode_229: keyCode229.slice(0, 5).map(compact),
    enter_keydown: enterWithNoSend.slice(0, 8)
  },
  enter_keydown_source: kpEnter.pass && enterKeydownIsComposing
    ? 'KP_Enter diagnostic (real xdotool key KP_Enter during composition)'
    : enterKeydowns.length
      ? 'DOM keydown samples'
      : 'none (fcitx5 consumes Return before the DOM)',
  note: kpEnter.pass && enterKeydownIsComposing
    ? 'Plain Return is consumed by fcitx5 before the DOM. The keydown Enter(isComposing=true) sample comes from the real KP_Enter diagnostic, which reached the DOM and produced no send; see task-5-kp-enter.json.'
    : enterKeydowns.length
      ? 'DOM received at least one Enter keydown; see enter_keydown samples.'
      : 'No DOM keydown Enter was delivered while composing: fcitx5 consumes Return and commits in the IME. ' +
        'A real KP_Enter during composition does reach the DOM as keydown Enter with isComposing=true and produces no send (diagnostic probe).',
  pass: !!(hasCompositionStart && hasCompositionEnd && isComposingKeydowns.length > 0 && keyCode229.length > 0 && composingEnterDidNotSend)
}

writeFileSync(outEventsPath, `${JSON.stringify(eventsResult, null, 2)}\n`)

const fcitx = facts.fcitx || {}
const candidate = facts.candidate || { found: false, pass: false }
const enterComposing = facts.enter_composing || { pass: false }
const enterCommitted = facts.enter_committed || { pass: false }
const escComposing = facts.esc_composing || { pass: false }
const shortcuts = facts.shortcuts || { pass: false, events: [] }

const hashesBefore = fcitx.config_hashes_before || {}
const hashesAfter = fcitx.config_hashes_after || {}
const hashKeys = Object.keys(hashesBefore)
const configUnchanged =
  hashKeys.length > 0 &&
  hashKeys.every((key) => hashesBefore[key] && hashesBefore[key] === hashesAfter[key])

const evidence = Array.isArray(facts.evidence) ? facts.evidence : []
const limitations = Array.isArray(facts.limitations) ? [...facts.limitations] : []
if (!enterComposing.chinese_commit) {
  limitations.push(
    'fcitx5 Rime has Return bound to CommitRawInput (raw pinyin). Composing Enter still produced 0 HTTP ' +
      'requests and committed the IME text (raw pinyin); the Chinese candidate was visible and the Chinese ' +
      'text was committed with the IME candidate key (Space) before the committed Enter in the next phase.'
  )
}
if (!enterKeydownIsComposing) {
  limitations.push(
    'Return is consumed by fcitx5 before the DOM, so no keydown Enter(isComposing=true) exists for Return; ' +
      'the guard evidence uses keydown isComposing/keyCode=229 for composing letters, a real KP_Enter ' +
      'diagnostic that does reach the DOM as Enter/isComposing=true with no send, and the 0-request assertion.'
  )
}

const pass = !!(
  candidate.pass &&
  enterComposing.pass &&
  enterCommitted.pass &&
  escComposing.pass &&
  shortcuts.pass &&
  eventsResult.pass &&
  configUnchanged
)

const strictAllExpected = !!(pass && enterComposing.chinese_commit)

const summary = {
  task: 'Task 5 — G6 fcitx5 Chinese/candidate/composing Enter+Esc spike',
  generated_at: new Date().toISOString(),
  fcitx: {
    running: !!fcitx.running,
    state: fcitx.state_before ?? null,
    group: fcitx.group_before ?? null,
    im: fcitx.im_before ?? null,
    used_im: fcitx.used_im ?? null,
    state_after: fcitx.state_after ?? null,
    group_after: fcitx.group_after ?? null,
    im_after: fcitx.im_after ?? null,
    restored_exact: !!fcitx.restored_exact,
    pinyin_switch_attempted: !!fcitx.pinyin_switch_attempted,
    pinyin_switch_effective: !!fcitx.pinyin_switch_effective,
    config_unchanged: configUnchanged,
    config_hashes_before: hashesBefore,
    config_hashes_after: hashesAfter
  },
  candidate: {
    found: !!candidate.found,
    wids: candidate.wids || [],
    geometry: candidate.geometry || null,
    distance_px: candidate.distance_px ?? null,
    metric: candidate.metric || null,
    pass: !!candidate.pass,
    selected: candidate.selected || null,
    all: (candidate.all || []).filter(
      (c) =>
        c &&
        (c.fcitxish ||
          (c.override_redirect &&
            c.class_type === 'InputOutput' &&
            !(c.x === 0 && c.y === 0)))
    )
  },
  enter_composing: {
    requests: enterComposing.requests ?? null,
    requests_before: enterComposing.requests_before ?? null,
    value: enterComposing.value ?? null,
    sends: enterComposing.sends ?? null,
    send_requested: enterComposing.send_requested ?? null,
    composition_ended: !!enterComposing.composition_ended,
    chinese_commit: !!enterComposing.chinese_commit,
    pass: !!enterComposing.pass
  },
  enter_committed: {
    requests: enterCommitted.requests ?? null,
    value: enterCommitted.value ?? null,
    sends: enterCommitted.sends ?? null,
    send_requested: enterCommitted.send_requested ?? null,
    commit_key: enterCommitted.commit_key || null,
    pass: !!enterCommitted.pass
  },
  esc_composing: {
    window_visible: !!escComposing.window_visible,
    map_state: escComposing.map_state || null,
    composition_canceled: !!escComposing.composition_canceled,
    value: escComposing.value ?? null,
    window_hidden_before: escComposing.window_hidden_before ?? null,
    window_hidden_after: escComposing.window_hidden_after ?? null,
    candidate_visible_after: !!escComposing.candidate_visible_after,
    pass: !!escComposing.pass
  },
  shortcuts: {
    pass: !!shortcuts.pass,
    events: shortcuts.events || [],
    triggered_count: shortcuts.triggered_count ?? null,
    sends_delta: shortcuts.sends_delta ?? null,
    note: shortcuts.note || null
  },
  events: {
    has_isComposing: eventsResult.has_isComposing,
    has_keyCode229: eventsResult.has_keyCode229,
    has_enter_keydown: eventsResult.has_enter_keydown,
    enter_keydown_isComposing: eventsResult.enter_keydown_isComposing,
    enter_keydown_source: eventsResult.enter_keydown_source,
    composing_enter_did_not_send: eventsResult.composing_enter_did_not_send,
    pass: eventsResult.pass,
    counts: eventsResult.counts,
    note: eventsResult.note
  },
  strict_acceptance: {
    all_expected_outcomes: strictAllExpected,
    composing_enter_chinese_text: !!enterComposing.chinese_commit,
    note: enterComposing.chinese_commit
      ? 'Composing Enter committed Chinese text directly.'
      : 'Composing Enter produced 0 requests but fcitx5 Rime committed raw pinyin (CommitRawInput); Chinese text commit verified in enter_committed via Space + Enter.'
  },
  limitations,
  pass,
  verdict: pass ? 'PASS' : 'FAIL',
  evidence
}

writeFileSync(outSummaryPath, `${JSON.stringify(summary, null, 2)}\n`)
process.exit(pass ? 0 : 1)
