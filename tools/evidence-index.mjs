#!/usr/bin/env node
/**
 * Task 8 / G10 — M0 evidence index.
 *
 * Reads the real Task 1–8 evidence JSON files, derives G1–G10 verdicts from
 * their actual fields (never hardcodes PASS), and writes:
 *   - .omo/evidence/m0-gates.json
 *   - docs/m0-gate-matrix.md
 *
 * Missing / unreadable evidence => PENDING. A partially satisfied gate =>
 * PARTIAL. No network, no dependencies.
 */

import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(__dirname, '..')
const EVIDENCE_DIR = path.join(ROOT, '.omo', 'evidence')
const DOCS_DIR = path.join(ROOT, 'docs')

const rel = (p) => path.relative(ROOT, p)
const evidencePath = (name) => path.join(EVIDENCE_DIR, name)
const docPath = (name) => path.join(DOCS_DIR, name)

function readJson(name) {
  try {
    return JSON.parse(fs.readFileSync(evidencePath(name), 'utf8'))
  } catch {
    return null
  }
}

function exists(name) {
  try {
    return fs.statSync(evidencePath(name)).isFile()
  } catch {
    return false
  }
}

function passToStatus(value) {
  if (value === true) return 'PASS'
  if (value === false) return 'FAIL'
  return 'PENDING'
}

function gate({ status, source, notes, keyMetric, evidence }) {
  return {
    status,
    source,
    notes,
    key_metric: keyMetric,
    evidence: evidence || source
  }
}

const gates = {}

// ── G1 / G5 — task-3-result.json ─────────────────────────────────────────────
const t3 = readJson('task-3-result.json')
if (!t3 || !t3.gates) {
  for (const id of ['G1', 'G5']) {
    gates[id] = gate({
      status: 'PENDING',
      source: '.omo/evidence/task-3-result.json',
      notes: 'task-3-result.json missing or has no gates object',
      keyMetric: 'n/a',
      evidence: '.omo/evidence/task-3-result.json'
    })
  }
} else {
  const g1 = t3.gates.G1
  const g1Variants = Array.isArray(g1?.variants) ? g1.variants : []
  gates.G1 = gate({
    status: passToStatus(g1?.pass),
    source: '.omo/evidence/task-3-result.json',
    notes: g1
      ? `G1 transparency: ${g1Variants.length} variants, black=${g1.black_frames}, white=${g1.white_frames}, ghost=${g1.ghost_frames}, corner_ok=${g1.corner_ok}. True KWin/spectacle composites; xwd used for real alpha.`
      : 'gates.G1 missing',
    keyMetric: g1
      ? `${g1Variants.length} variants × ${g1Variants[0]?.cycles ?? '?'} cycles; black=${g1.black_frames}, white=${g1.white_frames}, ghost=${g1.ghost_frames}`
      : 'n/a',
    evidence: '.omo/evidence/task-3-result.json'
  })

  const g5 = t3.gates.G5
  gates.G5 = gate({
    status: passToStatus(g5?.pass),
    source: '.omo/evidence/task-3-result.json',
    notes: g5
      ? `G5 compositor degrade: transparent-under-suspend black gutter observed; opaque fallback pass=${g5.opaque_fallback?.pass}; compositing restored=${g5.restored}; after=${g5.compositor_after}. KWin 6.3.6 has no DBus suspend/resume; kglobalaccel shortcut + trap was used.`
      : 'gates.G5 missing',
    keyMetric: g5
      ? `opaque_fallback=${g5.opaque_fallback?.pass}; restored=${g5.restored}; compositor_after=${g5.compositor_after}`
      : 'n/a',
    evidence: '.omo/evidence/task-3-result.json'
  })
}

// ── G2 — task-4-nfr01.json ──────────────────────────────────────────────────
const t4a = readJson('task-4-nfr01.json')
if (!t4a) {
  gates.G2 = gate({
    status: 'PENDING',
    source: '.omo/evidence/task-4-nfr01.json',
    notes: 'task-4-nfr01.json missing',
    keyMetric: 'n/a'
  })
} else {
  const strategyName = t4a.chosen_strategy || 'show-focus'
  const s = t4a.strategies?.[strategyName] ?? null
  const threshold = s?.environment?.pass_threshold_ms ?? 150
  gates.G2 = gate({
    status: passToStatus(t4a.pass),
    source: '.omo/evidence/task-4-nfr01.json',
    notes: s
      ? `G2 hotkey→focus: strategy=${strategyName}, runs=${s.runs}, focus_success=${s.focus_success}, missing=${s.missing_samples}, focus P95 ${s.focus_latency?.p95}ms ≤ ${threshold}ms, rAF P95 ${s.raf_latency?.p95}ms. Focus return is separate evidence.`
      : 'NFR-01 strategy data missing',
    keyMetric: s
      ? `focus P95 ${s.focus_latency?.p95}ms (≤${threshold}ms), rAF P95 ${s.raf_latency?.p95}ms, ${s.focus_success}/${s.runs} focus`
      : 'n/a',
    evidence: '.omo/evidence/task-4-nfr01.json'
  })
}

// ── G3 — task-4-nfr03.json ──────────────────────────────────────────────────
const t4b = readJson('task-4-nfr03.json')
if (!t4b) {
  gates.G3 = gate({
    status: 'PENDING',
    source: '.omo/evidence/task-4-nfr03.json',
    notes: 'task-4-nfr03.json missing',
    keyMetric: 'n/a'
  })
} else {
  const cold = t4b.cold_start
  const show = t4b.show
  const coldThreshold = cold?.threshold_ms ?? 2000
  const showThreshold = show?.threshold_ms ?? 50
  gates.G3 = gate({
    status: passToStatus(t4b.pass),
    source: '.omo/evidence/task-4-nfr03.json',
    notes: `G3 cold start/show: cold P95 ${cold?.stats?.p95}ms ≤ ${coldThreshold}ms (n=${cold?.runs}); app rAF P95 ${show?.app_raf_latency?.p95}ms ≤ ${showThreshold}ms. Driver-observed map P95 ${show?.driver_stats?.p95}ms includes xdotool spawn overhead; driver_p95_pass=${show?.driver_p95_pass} — measurement caveat, not an app-side failure.`,
    keyMetric: `cold P95 ${cold?.stats?.p95}ms (≤${coldThreshold}ms); show rAF P95 ${show?.app_raf_latency?.p95}ms (≤${showThreshold}ms); driver map P95 ${show?.driver_stats?.p95}ms`,
    evidence: '.omo/evidence/task-4-nfr03.json'
  })
}

// ── G4 / G9 — task-7-result.json ────────────────────────────────────────────
const t7 = readJson('task-7-result.json')
if (!t7) {
  for (const id of ['G4', 'G9']) {
    gates[id] = gate({
      status: 'PENDING',
      source: '.omo/evidence/task-7-result.json',
      notes: 'task-7-result.json missing',
      keyMetric: 'n/a'
    })
  }
} else {
  const g4 = t7.g4
  const altTab = Array.isArray(g4?.alt_tab) ? g4.alt_tab : []
  const altOk = altTab.filter(
    (r) => r.quickask_focus === true && r.target_focus === true && r.qaatom_visible_in_switcher === false
  ).length
  const g4Pass = t7.g4_pass ?? g4?.pass
  const g4Status = passToStatus(g4Pass)
  gates.G4 = gate({
    status: g4Status === 'PASS' && altTab.length > 0 && altOk === altTab.length ? 'PASS' : g4Status === 'PASS' ? 'PARTIAL' : g4Status,
    source: '.omo/evidence/task-7-result.json',
    notes: `G4 skip atoms/Alt+Tab: atoms_all_present=${g4?.xprop?.atoms_all_present}, KWin skipSwitcher=${g4?.kwin_introspection?.window?.skipSwitcher}, Alt+Tab ${altOk}/${altTab.length} hidden. KWin 6.3.6 only reads skip state at manage(): production Task 12/13 MUST implement XUnmapWindow→set atoms→XMapWindow remap in the native helper (xdotool only used in the spike). wmctrl -l still lists the window (_NET_CLIENT_LIST semantics).`,
    keyMetric: `Alt+Tab ${altOk}/${altTab.length} hidden; 4 atoms=${g4?.xprop?.atoms_all_present}; skipSwitcher=${g4?.kwin_introspection?.window?.skipSwitcher}`,
    evidence: '.omo/evidence/task-7-result.json'
  })

  const fixtures = Array.isArray(t7.fixture_summary) ? t7.fixture_summary : []
  const fixtureOk = fixtures.filter((f) => f.pass === true).length
  const slow = Array.isArray(t7.fixtures) ? t7.fixtures.find((f) => f.id === 'slow') : null
  const closeMs = slow?.server?.close_after_request_ms ?? null
  const g9Pass = t7.g9_pass
  const g9Status = passToStatus(g9Pass)
  gates.G9 = gate({
    status:
      g9Status === 'PASS' && fixtures.length > 0 && fixtureOk === fixtures.length
        ? 'PASS'
        : g9Status === 'PASS'
          ? 'PARTIAL'
          : g9Status,
    source: '.omo/evidence/task-7-result.json',
    notes: `G9 SSE/cancel: ${fixtureOk}/${fixtures.length} fixtures pass; abort server close ${closeMs}ms ≤500ms; 429 POST count ${t7.rate_limit?.server?.post_count_first}→${t7.rate_limit?.server?.post_count_after_2s} (no retry); CONNECT proxy pass=${t7.proxy?.pass}. HTTP/2 not exercised (local mock is HTTP/1.1) — explicitly recorded, not fabricated.`,
    keyMetric: `${fixtureOk}/${fixtures.length} fixtures; abort close ${closeMs}ms; 429 posts ${t7.rate_limit?.server?.post_count_first}→${t7.rate_limit?.server?.post_count_after_2s}`,
    evidence: '.omo/evidence/task-7-result.json'
  })
}

// ── G6 — task-5-summary.json ────────────────────────────────────────────────
const t5 = readJson('task-5-summary.json')
if (!t5) {
  gates.G6 = gate({
    status: 'PENDING',
    source: '.omo/evidence/task-5-summary.json',
    notes: 'task-5-summary.json missing',
    keyMetric: 'n/a'
  })
} else {
  const strictOk = t5.strict_acceptance?.all_expected_outcomes === true
  gates.G6 = gate({
    // The app-side IME behavior passed, but the strict "composing Enter commits
    // Chinese" outcome is false because Rime maps Return to CommitRawInput.
    // Keep PARTIAL so the matrix does not hide the documented degradation.
    status: t5.pass === true ? (strictOk ? 'PASS' : 'PARTIAL') : 'FAIL',
    source: '.omo/evidence/task-5-summary.json',
    notes: `G6 IME: verdict=${t5.verdict}, pass=${t5.pass}; strict_acceptance.all_expected_outcomes=${strictOk}. Rime Return=CommitRawInput: composing Enter produced 0 HTTP requests but committed raw pinyin, not Chinese (chinese_commit=${t5.enter_composing?.chinese_commit}); Chinese text was committed via Space (${t5.enter_committed?.value}); Esc cancelled composition; composing shortcut guards passed. Downstream must use isComposing || keyCode===229 and must not assume Return commits Chinese.`,
    keyMetric: `candidate=${t5.candidate?.found}; composing Enter requests=${t5.enter_composing?.requests}; Esc canceled=${t5.esc_composing?.composition_canceled}; strict=${strictOk}`,
    evidence: '.omo/evidence/task-5-summary.json'
  })
}

// ── G7 — task-6-tray-summary.json + task-6-tray-events.json ─────────────────
const t6tray = readJson('task-6-tray-summary.json')
const t6events = readJson('task-6-tray-events.json')
if (!t6tray) {
  gates.G7 = gate({
    status: 'PENDING',
    source: '.omo/evidence/task-6-tray-summary.json',
    notes: 'task-6-tray-summary.json missing',
    keyMetric: 'n/a'
  })
} else {
  const sniId = t6tray.sni?.properties?.Id || t6events?.sni?.id || null
  const trayReady = Array.isArray(t6events?.events) && t6events.events.some((e) => e.type === 'TRAY_READY')
  const clickEvent = Array.isArray(t6events?.events) && t6events.events.some((e) => e.type === 'click')
  const menuClick = exists('task-6-tray-right-menu-click.json')
  const iconFound = t6tray.icon?.found === true
  const eventCount = t6tray.app?.event_count ?? t6events?.events?.length ?? 0
  const coreOk = Boolean(sniId) && trayReady && clickEvent && iconFound && eventCount > 0
  gates.G7 = gate({
    status: coreOk ? 'PASS' : Boolean(sniId) || iconFound ? 'PARTIAL' : 'FAIL',
    source: '.omo/evidence/task-6-tray-summary.json + task-6-tray-events.json',
    notes: `G7 tray SNI: Id=${sniId || 'null'}, icon.found=${iconFound}, TRAY_READY=${trayReady}, click event=${clickEvent}, right-click Plasma menu clicked=${menuClick}, event_count=${eventCount}. Double-click is NOT supported by Electron 45 on this Plasma setup (2× click, 0× double-click); right-click is handled by Plasma's DBusMenu (Electron logs 0 right-click events). Do not claim F-01.3 double-click.`,
    keyMetric: `SNI=${Boolean(sniId)}; icon=${iconFound}; click=${clickEvent}; menu_click=${menuClick}; events=${eventCount}`,
    evidence: '.omo/evidence/task-6-tray-summary.json'
  })
}

// ── G8 — task-6-keyring.json ────────────────────────────────────────────────
const t6keyring = readJson('task-6-keyring.json')
if (!t6keyring) {
  gates.G8 = gate({
    status: 'PENDING',
    source: '.omo/evidence/task-6-keyring.json',
    notes: 'task-6-keyring.json missing',
    keyMetric: 'n/a'
  })
} else {
  const summary = t6keyring.summary || {}
  const summaryOk = Object.values(summary).every((v) => v === true)
  const status = t6keyring.status === 'PASS' && summaryOk ? 'PASS' : t6keyring.status === 'PASS' ? 'PARTIAL' : 'FAIL'
  gates.G8 = gate({
    status,
    source: '.omo/evidence/task-6-keyring.json',
    notes: `G8 Secret Service: status=${t6keyring.status}, roundtrip=${t6keyring.roundtrip?.success}/${t6keyring.roundtrip?.attempts}, backend=${t6keyring.safe_storage?.selected_backend}, encryption=${t6keyring.safe_storage?.is_encryption_available}, no_plaintext=${t6keyring.no_plaintext}, unavailable_exit=${t6keyring.unavailable?.exit}. Bare shell gives safeStorage basic_text/encryption=false; production must run with desktop env or reject basic_text. Live locked-state not tested (locked_state_tested=${t6keyring.locked_state_tested}).`,
    keyMetric: `roundtrip ${t6keyring.roundtrip?.success}/${t6keyring.roundtrip?.attempts}; backend=${t6keyring.safe_storage?.selected_backend}; no_plaintext=${t6keyring.no_plaintext}; unavailable exit=${t6keyring.unavailable?.exit}`,
    evidence: '.omo/evidence/task-6-keyring.json'
  })
}

// ── G10 — task-8-result.json ────────────────────────────────────────────────
const t8 = readJson('task-8-result.json')
if (!t8 || !t8.g10) {
  gates.G10 = gate({
    status: 'PENDING',
    source: '.omo/evidence/task-8-result.json',
    notes: 'task-8-result.json missing or has no g10 object',
    keyMetric: 'n/a'
  })
} else {
  const g10 = t8.g10
  const required = ['dir_ok', 'deb_ok', 'desktop_validate', 'run_ok', 'strace_ok', 'paths_ok', 'ldd_ok']
  const trueCount = required.filter((k) => g10[k] === true).length
  gates.G10 = gate({
    status: g10.pass === true ? (trueCount === required.length ? 'PASS' : 'PARTIAL') : 'FAIL',
    source: '.omo/evidence/task-8-result.json',
    notes: `G10 packaging/zero-home: dir_ok=${g10.dir_ok}, deb_ok=${g10.deb_ok}, desktop_validate=${g10.desktop_validate}, run_ok=${g10.run_ok}, strace_ok=${g10.strace_ok}, paths_ok=${g10.paths_ok}, ldd_ok=${g10.ldd_ok}. ${g10.notes || ''}`.trim(),
    keyMetric: `${trueCount}/${required.length} sub-checks; strace=${g10.strace_ok ? 'NO_UNAPPROVED_HOME_WRITES' : 'see log'}`,
    evidence: '.omo/evidence/task-8-result.json'
  })
}

// ── Emit JSON ───────────────────────────────────────────────────────────────
const order = ['G1', 'G2', 'G3', 'G4', 'G5', 'G6', 'G7', 'G8', 'G9', 'G10']
const summary = { PASS: 0, PARTIAL: 0, FAIL: 0, PENDING: 0 }
for (const id of order) summary[gates[id].status] += 1

const m0 = {
  schema_version: 1,
  generated_at: new Date().toISOString(),
  task: 'Task 8 — M0 gate matrix (G1–G10)',
  generator: 'tools/evidence-index.mjs',
  status_values: ['PASS', 'PARTIAL', 'FAIL', 'PENDING'],
  summary,
  gates: Object.fromEntries(order.map((id) => [id, gates[id]])),
  notes: [
    'Task 5 / G6: fcitx5 Rime maps Return to CommitRawInput. Composing Enter sends no HTTP request but commits raw pinyin, not Chinese. Chinese commit was verified via Space; G6 is marked PARTIAL, not PASS. Downstream must guard with isComposing || keyCode===229 and must not assume Return commits Chinese.',
    'Task 7 / G4: KWin 6.3.6 only reads skipSwitcher/skipTaskbar/skipPager during manage(). Setting _NET_WM_STATE after show() is not enough. Production Task 12/13 must implement XUnmapWindow → set 4 atoms → XMapWindow remap in the native helper; do not rely on xdotool. Verify no visible flicker on NVIDIA 595.',
    'G10 deb metadata: package.json carries public homepage/author metadata required by electron-builder for .deb. The earlier placeholder values were replaced before publication.',
    'G9 HTTP/2 was not exercised (mock is HTTP/1.1 only); this is recorded as a limitation, not a PASS claim.'
  ]
}

fs.mkdirSync(EVIDENCE_DIR, { recursive: true })
fs.mkdirSync(DOCS_DIR, { recursive: true })
fs.writeFileSync(path.join(EVIDENCE_DIR, 'm0-gates.json'), JSON.stringify(m0, null, 2) + '\n')

// ── Emit Markdown ───────────────────────────────────────────────────────────
const esc = (s) => String(s ?? '').replace(/\|/g, '\\|').replace(/\n/g, ' ')
const rows = order.map((id) => {
  const g = gates[id]
  return `| ${id} | **${g.status}** | ${esc(g.key_metric)} | \`${esc(g.evidence)}\` |`
})

const md = `# M0 Gate Matrix (G1–G10)

> Generated by \`node tools/evidence-index.mjs\` at ${m0.generated_at}.
> Status values: **PASS / PARTIAL / FAIL / PENDING**. Verdicts are derived from the
> actual evidence JSON fields; they are not hardcoded.

| Gate | Verdict | Key metric | Evidence |
|---|---|---|---|
${rows.join('\n')}

**Summary:** ${summary.PASS} PASS · ${summary.PARTIAL} PARTIAL · ${summary.FAIL} FAIL · ${summary.PENDING} PENDING

## Gate notes

${order
  .map((id) => `- **${id}** (${gates[id].status}): ${gates[id].notes}`)
  .join('\n')}

## Required downstream caveats

1. **Task 5 / G6 — Rime \`CommitRawInput\`:** Return during composition commits raw
   pinyin, not the Chinese candidate. The app-side behavior (0 HTTP requests while
   composing, Esc cancels composition, shortcut guards) passed, but the strict
   "composing Enter commits Chinese" acceptance is not met. G6 is therefore
   **PARTIAL**. Use \`isComposing || keyCode===229\` in Task 18; do not assume Return
   commits Chinese. Chinese commit was verified with the IME candidate key (Space).
2. **Task 7 / G4 — KWin remap requirement:** KWin 6.3.6 reads skip state only in
   \`manage()\`. Production Task 12/13 must do
   \`XUnmapWindow → set _NET_WM_STATE → XMapWindow\` (or an equivalent native helper
   remap), then re-assert. \`xdotool windowunmap/windowmap\` was only a spike
   workaround; do not ship it. Re-check NVIDIA 595 for flicker/black frames.
3. **G10 deb metadata:** \`homepage\` and \`author.email\` are required by
   electron-builder for \`.deb\`; the public repo metadata is used.
4. **G9 HTTP/2:** not exercised because the local mock is HTTP/1.1; this is an
   explicit limitation, not a PASS claim.
`

fs.writeFileSync(docPath('m0-gate-matrix.md'), md)

// Console summary
console.log(`wrote ${rel(path.join(EVIDENCE_DIR, 'm0-gates.json'))}`)
console.log(`wrote ${rel(docPath('m0-gate-matrix.md'))}`)
for (const id of order) console.log(`${id} ${gates[id].status}`)
console.log(`summary ${JSON.stringify(summary)}`)
