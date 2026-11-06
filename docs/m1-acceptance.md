# M1 Acceptance — scope, Gherkin and NFR evidence

> 历史设计/验收笔记：部分证据链接指向私有开发存档 `.omo/`，该目录不在本仓库中。


Generated 2026-11-05 from the real app (`node_modules/.bin/electron .` /
`out/main/index.js`), not the M0 spike. Most drivers set
`QUICKASK_DISABLE_ONBOARDING=1` (G06 intentionally does not, to test first-run onboarding) and use fresh XDG directories under
`.runtime/<tool>-<timestamp>/`. Evidence lives in `.omo/evidence/m1/`.

## M1 scope (Q5)

Q5 defaults confirmed with the product owner on 2026-11-04: XDG runtime paths,
M1 = unpacked dir + `.desktop` + screenshots, `.deb` deferred to M2, gutter /
shadows / inline clipboard chip / S4 onboarding / fixed panel height, tray
left-click toggle + right-click menu, and F-05 search included in M1.

**Included and accepted in M1:**

| Area | Included |
|---|---|
| F-01 | Global hotkey toggle (default `Ctrl+Alt+Space`, conflict fallback + retry), tray single-click toggle / menu, single instance, Alt+F4 hides instead of quitting, tray-only quit |
| F-02 | 1–6 line composer, Enter send / Shift+Enter newline, fcitx5 composing guard, disabled empty send, per-session drafts, >50k paste truncation notice, image-paste rejection notice |
| F-03 | SSE streaming, Markdown/code/table/link rendering, code + full copy, stop preserving content + "已停止", regenerate, typed errors (401/429/5xx/network/timeout) with manual retry and redaction |
| F-04 | Multi-turn history in the request body, token-budget trimming (recent 12-turn policy), new send interrupts active stream |
| F-05 | SQLite persistence, auto-title, S3 list, full-text search (FTS5 trigram + LIKE fallback), rename, delete with confirm, 1000-session scroll/search budgets |
| F-06 | New session via `＋` / `Ctrl+N`, no empty rows, aborts active stream; `Ctrl+H` toggles history (S3); IME-composition guard on both — all covered by `tests/e2e/shortcuts.spec.ts` (3 tests) |
| F-07 | **Only the model and appearance groups, minimal viable**: base_url / key / model / test connection / headers; theme / primary / opacity / bar width / blur toggle + honest status |
| F-08 | First-run onboarding wizard, main composer disabled until configured, zero startup requests |
| F-09 | Clipboard chip on show, never auto-fills, click or `Ctrl+Shift+V` inserts |
| NFR-01–11 | Measured on the real build; see the NFR verdict table below |
| NFR-12 | M1 packaging = `release/linux-unpacked` + valid `release/quickask.desktop`; **`.deb` is M2** |

**Explicitly deferred (not claimed in M1):**

- F-01.7 autostart, F-01.8 watchdog/auto-restart → M2.
- F-04.4 quick model switching (P1) → M2.
- F-07 remaining groups (shortcut recording, behavior, data, about, proxy,
  fonts/retention) → M2.
- F-05 JSON/Markdown export → M2.
- Proxy UI (direct/system/custom HTTP/SOCKS5) → M2; environment proxy still works.
- Window position memory per output, autostart, systemd watchdog → M2.
- `.deb` / AppImage / system install, 24 h soak, physical 100%/125% mixed-DPI
  monitor test → M2.
- LaTeX (P2), image input (P2), selection-to-ask (P2), multi-model quick
  switcher (P1) → M2/M3.

**Added after the M1 sign-off (2026-11-06, delivered by Hermes directly):**

- **opencode-go auto header** — endpoints under `opencode.ai/zen/go` now receive
  a stable `x-opencode-session` derived from the provider id, because the
  gateway answers `400 MissingSessionID` without it (verified against the live
  gateway: 400 without the header, 200 with it). Covered by
  `tests/unit/provider-headers.test.ts` (12 cases) plus a `OpenCode Go` preset in
  the model tab. No schema, keyring or IPC change.
- **Clipboard image input (supersedes the F-02 "image-paste rejection notice")** —
  pasting a screenshot now attaches it instead of refusing. Up to 4 images per
  message (5 MB each, 12 MB total), normalized in the renderer (long edge 1568 px,
  re-encoded JPEG, transparency flattened) before crossing IPC; stored in a new
  `messages.images_json` column (migration v2, old rows default to `[]`) so history
  and 重新生成 keep the pictures. Only the newest image-bearing user turn is sent
  as `image_url` parts — older turns degrade to text so base64 does not accumulate
  in every round; each image is budgeted at a flat 1100 tokens, not its base64
  length. `SCHEMA_VERSION` now derives from the migration list instead of a second
  hard-coded constant. Covered by `tests/unit/chat-images.test.ts` (11 cases) plus a
  live-gateway check: `deepseek-v4.1-flash` answered "红色，蓝色" for a two-color
  probe image over HTTP 200. Note the model id must be the bare
  `deepseek-v4.1-flash` — the canonical `deepseek/deepseek-v4.1-flash` makes the
  gateway answer `400 Model is unavailable`.

## Gherkin G01–G10 (REQUIREMENTS §6)

Every row is backed by an automated test and/or raw OS evidence in
`.omo/evidence/m1/`. **G02 and G08 are PARTIAL**; no untested row is marked
PASS. The 10 real-app wrappers live in `tests/e2e/gherkin.spec.ts`; the full
suite (101 tests) ran with an HTML report at
`.omo/evidence/m1/gherkin/index.html` and raw log
`.omo/evidence/m1/gherkin/run.log`. The 101 = 10 Gherkin wrappers
(`tests/e2e/gherkin.spec.ts`) + 3 shortcut tests
(`tests/e2e/shortcuts.spec.ts`: Ctrl+N new session, Ctrl+H history toggle,
IME-composition guard) + 88 baseline.

| ID | Scenario | Verdict | Automated test / OS evidence | Evidence files |
|---|---|---|---|---|
| G01 | 热键唤起且不污染任务栏 | **PASS** | `tests/e2e/gherkin.spec.ts` G01: xdotool `Ctrl+Alt+Space`, X focus = main WID, composer focused, live `xprop` SKIP_TASKBAR / SKIP_PAGER / SKIP_SWITCHER / ABOVE; existing `tests/e2e/lifecycle.spec.ts` hotkey cycle; NFR-04 5/5 Alt+Tab screenshots | `gherkin/G01.json`, `nfr04-summary.json`, `xprop.txt`, `alt-tab-1..5.png`, `nfr01.json` |
| G02 | 中文输入不误发 | **PARTIAL** (known limitation) | `tests/e2e/gherkin.spec.ts` G02 + real fcitx5/Rime run `tools/nfr08-real.mjs`: composing Enter **0 POST**; Space commits `你好`, Enter sends **1 POST**; real candidate window at `1025,164` (666×52), edge distance 0 px. Strict "Enter commits Chinese" is blocked by this host's Rime `CommitRawInput` (see limitations) | `gherkin/G02.json`, `nfr08.json`, `nfr08-candidate.png`, `nfr08-candidate.json`, `nfr08-server-body.log` |
| G03 | 流式生成与停止 | **PASS** | `tests/e2e/gherkin.spec.ts` G03 + `tests/e2e/panel.spec.ts:729`: slow SSE, click stop, status `已停止`, text preserved, no new tokens 700 ms later, server logs `client closed after` | `gherkin/G03.json`, `task-19-summary.json`, `task-19-stop.json` |
| G04 | 多轮上下文 | **PASS** | `tests/e2e/gherkin.spec.ts` G04: second request body contains first user + assistant + second user; DB roles user/assistant/user/assistant. Integration `tests/integration/chat-orchestrator.test.ts`; Task 16 evidence | `gherkin/G04.json`, `task-16-summary.json` |
| G05 | 历史持久化 | **PASS** | `tests/e2e/gherkin.spec.ts` G05: send, quit (exit 0), relaunch same data dir, session found in history list, open returns identical messages, sidebar shows title. Existing kill -9 / restart tests | `gherkin/G05.json`, `task-26-kill9.json`, `tests/e2e/session.spec.ts:676` |
| G06 | 未配置 key 的首次启动 | **PASS** | `tests/e2e/gherkin.spec.ts` G06 + `tests/e2e/settings.spec.ts:406`: fresh data dir auto-opens S4 onboarding, main S0/hidden, composer disabled with "请先配置模型", send disabled, **0 HTTP requests** | `gherkin/G06.json`, `task-22-onboarding.json`, `onboarding.png` |
| G07 | 毛玻璃降级 | **PASS (degraded)** | `tests/e2e/gherkin.spec.ts` G07 live: blur status unavailable, compositor active, KWin Blur effect off, no `_KDE_NET_WM_BLUR_BEHIND_REGION`. NFR-07: compositor OFF → opaque + 2-rect ShapeBounding; ON → transparent gutter restored. Blur itself is **not** claimed | `gherkin/G07.json`, `nfr07-summary.json`, `nfr07-compositor-off.*`, `nfr07-compositor-on.*` |
| G08 | 多屏唤起 | **PARTIAL** (single-display host) | `tests/e2e/gherkin.spec.ts` G08: pure geometry gives cursor-display default anchor 620,130 on the real 1920×1080 and 2860,173 on a simulated 2560×1440 secondary; NFR-06 confirms only one physical output. Physical second-monitor assertion is not possible here | `gherkin/G08.json`, `nfr06-summary.json`, `nfr06-display.json`, `tests/unit/geometry.test.ts` |
| G09 | 单实例 | **PASS** | `tests/e2e/gherkin.spec.ts` G09 + `tests/e2e/lifecycle.spec.ts:462`: second `electron .` exits 0, first window shows S1, hotkey status unchanged, no duplicate registration | `gherkin/G09.json`, `task-13-single-instance.log`, `task-13-summary.json` |
| G10 | Esc 逐层退出 | **PASS** | `tests/e2e/gherkin.spec.ts` G10 + `tests/e2e/focus-esc.spec.ts:823`: S3 → S2 → S1 → S0 via Playwright + XTEST Escape, process alive, hotkey re-shows S1, tray remains | `gherkin/G10.json`, `task-24-esc.json`, `task-24-summary.json` |

Run the Gherkin wrappers alone:

```bash
source scripts/env.sh
npx playwright test tests/e2e/gherkin.spec.ts --reporter=list   # 10/10
```

The machine-readable matrix is `.omo/evidence/m1/gherkin/summary.json`;
the final acceptance JSON is `.omo/evidence/m1/m1-acceptance.json`.

## Verdict table

| NFR | Verdict | Raw metric | Evidence |
|---|---|---|---|
| NFR-01 hotkey → composer focus | **PASS** | 20/20 focus; app-side P95 **32 ms** (≤150 ms), rAF P95 34 ms, driver P95 51 ms | `nfr01.json`, `nfr01-samples.jsonl`, `nfr01-app.log` |
| NFR-02 panel/sidebar animation | **PASS** | S2 panel 160 ms CSS: P50 **158.4 ms**, P95 **158.8 ms**; first-change→stable P50 145.1 / P95 145.5 ms. S3 sidebar P50 158.2 / P95 158.8 ms; first-change P95 150.0 ms. Bar drift **0 px**; 10/10 typed chars landed; reduced-motion effective duration **0 ms** | `nfr02.json`, `nfr02-frames.json`, `nfr02-s2-mid/final.png`, `nfr02-s3-mid/final.png`, `nfr02-reduced-motion.png` |
| NFR-03 cold start → tray ready | **PASS** | 10/10; P95 **372 ms** (≤2000 ms); ready P95 374 ms | `nfr03.json`, `nfr03-cold-samples.jsonl`, `nfr03-cold-*-app.log` |
| NFR-03 hidden → show | **PASS** | app-side P95 **42 ms** (≤50 ms), P50 26 ms, max 44 ms; rAF P95 51 ms; driver P95 76 ms | `nfr03.json`, `nfr03-show-samples.jsonl`, `nfr03-show-app.log` |
| NFR-04 not in taskbar / Alt+Tab | **PASS** | 4/4 atoms: `SKIP_TASKBAR`, `SKIP_PAGER`, `_KDE_NET_WM_STATE_SKIP_SWITCHER`, `ABOVE`; `WM_CLASS="quickask"`; KWin introspection `skipSwitcher/skipTaskbar/skipPager=true` on first show **and** after hide/show; 5/5 Alt+Tab screenshots show no QuickAsk tile | `xprop.json`, `xprop.txt`, `nfr04-kwin-introspection.json`, `nfr04-wmctrl.txt`, `alt-tab-1..5.png`, `alt-tab-*.ocr.txt` |
| NFR-05 visual contract | **PASS** | Bar screen anchor **620,130** in S1/S2/S3; gutter 40/28/40/52 px; 24 px bar / 16 px card corners and shadow verified by PIL; opacity peaks 102/184/255 match 40/72/100%; bar 560/680/900 keeps anchor, composer min 240, send 36, history 32 | `nfr05-summary.json`, `nfr05-s1/s2/s3.png`, `nfr05-anchor.json`, `nfr05-appearance.*`, `nfr05-opacity.*`, `nfr05-barwidth.*`, `nfr05-pixels.json` |
| NFR-06 multi-screen / mixed DPI | **PASS** (single-display limitation) | One 1920×1080@100% output; default anchor follows the cursor display; pure geometry tests cover 100%/125%, two work areas, S3 overlay, bottom clamp, display removal | `nfr06-summary.json`, `nfr06-display.json`, `tests/unit/geometry.test.ts` |
| NFR-07 desktop blur | **PASS (degraded)** | KWin Blur effect **OFF** on this machine (`effectEnabled=false`, `_KDE_NET_WM_BLUR_BEHIND_REGION` not found). Honest fallback verified: compositor OFF → opaque window + ShapeBounding; compositor ON → transparent gutter restored. Blur itself is **not** working and is not claimed | `nfr07-summary.json`, `nfr07-compositor-off.*`, `nfr07-compositor-on.*`, `nfr07-spike-g5-*` |
| NFR-08 fcitx5 IME | **PASS** | Real built app under fcitx5/Rime: candidate window found at **1025,164** (666×52), edge distance **0 px**, Map State `IsViewable`; Return while composing **0 POST** (Rime `CommitRawInput` commits raw `nihao`, no send); Space→`你好` + Return **1 POST** (mock body user message `你好`); Esc while composing canceled to `""`, window still `IsViewable`, **0 POST**. fcitx restored exactly (state 1, group 默认, IM keyboard-us), config unchanged | `nfr08.json`, `nfr08-candidate.png`, `nfr08-candidate.json`, `nfr08-candidate-windows.txt`, `nfr08-server.log`, `nfr08-server-body.log` |
| NFR-09 no plaintext secrets | **PASS** | DB/renderer/logs: 0 plaintext hits; keyRef only; keyring round-trip **5/5**; `grep-key.sh` on the fake-key data dir → **NO_PLAINTEXT_FOUND** (0/2 files) | `nfr09-summary.json`, `nfr09-key-store.json`, `nfr09-keyring.json`, `nfr09-grep-key-fake.txt`, `nfr09-grep-key-app.txt` |
| NFR-10 idle zero outbound | **PASS** | 5 min idle: 19 connects, all unix-domain; 0 external; `ss` 11 snapshots / 0 external | `nfr10-summary.json`, `nfr10-idle-net.json`, `nfr10-network-audit.json` |
| NFR-11 crash / quit recovery | **PASS** | kill -9 restart **543 ms**, status `interrupted`, FTS match after recovery, no duplicate; renderer crash reload **1609 ms**, main kept streaming, final `complete`, 1 provider POST; quit **55 ms**, exit 0, status `stopped`, 0 streaming rows | `nfr11-summary.json`, `nfr11-kill9.*`, `nfr11-renderer-crash.*`, `nfr11-quit.json` |
| NFR-12 packaging | **PASS (dir) / deb M2** | `release/linux-unpacked/quickask` starts, `ldd` clean, `.desktop` valid, 60 s strace `NO_UNAPPROVED_HOME_WRITES`; the unpacked dir was rebuilt after the Task 28 native fix (helper matches source); `.deb` is an M2 deliverable | `nfr12-summary.json`, `nfr12-packaging.json`, `nfr12-desktop.txt`, `nfr12-run.png` |

## 1000 sessions / search / scroll

Final Task 29 evidence (2026-11-05), measured on the real Electron build with
Playwright. The seed DB and the E2E DB are both 1000 sessions × 10 messages
(10,000 messages) plus 1000 FTS5 trigram rows; no smaller substitute was used.

### Seed and integrity

| Check | Actual | Verdict | Evidence |
|---|---|---|---|
| Seed 1000 × 10 + FTS | 1000 sessions / 10,000 messages / 1000 FTS rows | PASS | `history-1000-seed.log`, `history-1000-data/quickask.db` |
| Seed timings | open+migrate 12.77 ms, sessions 4.43 ms, messages 79.33 ms, FTS 36.35 ms, total **147.84 ms** | PASS | same log (`SUMMARY`) |
| `PRAGMA quick_check` / `integrity_check` | `ok` / `ok` | PASS | `history-1000-seed.log` |
| Schema / FTS | `user_version=1`; `{"fts5":true,"trigram":true,"table":true,"tableTokenize":"trigram"}` | PASS | `db-query --schema-version/--fts-check` in the seed log |

### UI budgets (Playwright, 7/7 tests passed in 11.8 s)

| Metric | Budget | Actual | Verdict | Evidence |
|---|---|---|---|---|
| Open S3 with 1000 sessions → first rendered row | <150 ms | **35.6 ms** | PASS | `history-1000.json`, `history-1000-open.png` |
| DOM item count | <80 items | **17** DOM / 17 rendered (`data-result-count=1000`) | PASS | `history-1000.json` |
| 5 s continuous scroll rAF | p95 <16.7 ms (or ≤32 ms with device note) | **p50 4.2 / p95 4.2 / p99 4.3 / max 4.3 ms**, 1202 frames, DOM 17–28, **0 blank rows** | PASS | `history-scroll.json`, `history-1000-scroll.png` |
| Scroll device note | — | X11/Electron, `DISPLAY=:0`, DPR 1; ~240 rAF/s measured, so the 16.7 ms target is met without the ≤32 ms device-band exception | PASS | `history-scroll.json.device` |
| S3 anchor | — | bar screen anchor **620,130** (680×48); sidebar **260×480 at 40,28** | PASS | `history-1000.json`, `history-1000-open.png` |

### Search budgets (SQL timing is the C.8 criterion)

The plan defines the search budgets as **SQL timing** (`C.8`: 2-char <150 ms,
3+ <100 ms). `history-1000-sql.json` measures the real
`SessionsRepository`/`SearchRepository` through `openDbService` on the seeded
DB: 3 warmups + 30 iterations each, `process.hrtime.bigint()`, raw arrays kept.

| Query | Budget | Repository SQL | Renderer IPC `dbMs` | UI (incl. 120 ms debounce) | Verdict |
|---|---|---|---|---|---|
| 2-char `报错` (LIKE + ESCAPE) | <150 ms | p50 0.8747 / **p95 0.9172** / max 0.9705 ms, 50 rows | 6.9 ms | **129.8 ms**, 250 results | PASS (SQL) |
| 4-char `虚拟列表` (FTS5 trigram) | <100 ms | p50 0.8840 / **p95 0.9029** / max 0.9041 ms, 50 rows | 4.1 ms | 128.0 ms, 500 results | PASS (SQL) |
| List 50 sessions (supplemental) | <150 ms | p50 0.1282 / **p95 0.1652** / max 0.1771 ms, 50 rows | — | — | PASS |
| 2-char `报错`, limit 1000 | <150 ms | p50 4.4956 / **p95 4.6384** / max 4.6646 ms, 250 rows | — | — | PASS |
| 4-char `虚拟列表`, limit 1000 | <100 ms | p50 1.6668 / **p95 1.8330** / max 1.9642 ms, 500 rows | — | — | PASS |

The UI column includes the intentional 120 ms input debounce plus IPC and
render; it is reported for transparency and is **not** compared with the
<100 ms SQL budget. The 3+ UI figure (128.0 ms) therefore does not mean the
FTS budget failed: the SQL path is 0.9029 ms p95. Query plans in
`history-1000-sql.json` show `SCAN f VIRTUAL TABLE INDEX 0:M3` for MATCH,
`idx_sessions_updated` + `idx_messages_session_seq` for LIKE, and
`idx_sessions_updated` for list-50.

### Search edge cases

| Case | Actual | Verdict |
|---|---|---|
| Special chars `"*()-` | 0 results, 0 errors, `data-applied-query` set, empty state shown; 0.4 ms | PASS |
| `%_` wildcard-looking input | escaped, 0 results, no error; 3.4 ms | PASS |
| Empty result `nowhere-xyz` | `data-result-count=0`, 0 rows, text **“没有匹配的会话”**, 0 errors | PASS |
| Empty query | 1000 sessions restored | PASS |
| IME guard | during composition: applied query stays `''`, count 1000; after `compositionend`: `报错` / 250 in **9.3 ms** | PASS |

### Trace and logs

- `history-1000-trace.zip` — Playwright trace for the S3-open test from the
  `--trace on` run (`test.trace` + source snapshot; zip integrity checked).
- `history-1000-e2e.log` — full `npx playwright test tests/e2e/history.spec.ts
  --trace on --reporter=line` output: 7/7 passed.
- `history-1000-seed.log`, `history-1000-e2e-seed.log`,
  `history-1000-sql.log`, `history-1000-sql.json`.
- `history-1000-open.png`, `history-1000-search.png`,
  `history-1000-scroll.png`.
- Final gates: `npm run typecheck && npm run build && npm run test` → 31 test
  files / **289 tests passed** (`history-1000-typecheck-build-test.log`).

No budget failed. Nothing in this section is extrapolated from Task 20: all
numbers above are from the Task 29 seed and Playwright/SQL runs.

Reproduction:

```bash
cd $PROJECT_ROOT
source scripts/env.sh
QUICKASK_DATA_DIR="$PWD/.omo/evidence/m1/history-1000-data" \
  node tools/seed-history.mjs --sessions 1000 --messages 10 --fts
node tools/measure-history-1000.mjs
npx playwright test tests/e2e/history.spec.ts --trace on --reporter=line
```

## NFR-02 — why Playwright rAF, not ffmpeg

`ffmpeg -f x11grab` cannot capture KWin-composited windows on this machine
(Task 3: the captured frames show the un-composited backing store). The
primary evidence is therefore:

- `getBoundingClientRect()` height (S2 panel) / width (S3 sidebar) sampled on
  every `requestAnimationFrame` while `window.quickask.window.setMode(...)`
  runs;
- `animationstart`/`animationend` events for the effective CSS duration;
- `window.screenX/screenY + bar.getBoundingClientRect()` for bar drift;
- Playwright screenshots (`nfr02-*-mid.png`, `nfr02-*-final.png`) at mid and
  rest, measured with PIL in `nfr02-frames.json`.

The app previously had no panel/sidebar transition (measured jump). Task 28
added the missing `qa-panel-expand` / `qa-sidebar-expand` keyframes
(height 0 → inline height, width 0 → 260, opacity 0 → 1, 160 ms
`cubic-bezier(0.2, 0, 0, 1)`). The bar itself has no animation. Reduced motion
turns the keyframes off via `html[data-reduced-motion="1"]` and
`prefers-reduced-motion`, yielding an effective 0 ms duration.

## NFR-04 — why `wmctrl -l` is not the verdict

`wmctrl -l` lists every managed window in `_NET_CLIENT_LIST`; KWin keeps
QuickAsk there even with `SKIP_TASKBAR`. The recorded line is therefore noted,
not counted. The authoritative checks are:

1. `xprop` atoms on the live Window (`SKIP_TASKBAR`, `SKIP_PAGER`,
   `_KDE_NET_WM_STATE_SKIP_SWITCHER`, `ABOVE`);
2. KWin `workspace.windowList()` introspection of the real window
   (`skipSwitcher/skipTaskbar/skipPager = true`, both on first show and after
   hide/show);
3. five held-Alt+Tab screenshots with no QuickAsk tile in the switcher.

There is no WM_HINTS property on this Electron window (`WM_HINTS: not found`),
and blur is not set (`_KDE_NET_WM_BLUR_BEHIND_REGION: not found`); both are
recorded verbatim.

## NFR-08 — real-app fcitx5/Rime

`tools/nfr08-real.mjs` launches the built app (`playwright` `_electron`,
`args: ['.']`) with a fresh XDG/`QUICKASK_DATA_DIR`, `QUICKASK_DISABLE_ONBOARDING=1`
and the real fcitx environment (`XMODIFIERS=@im=fcitx`,
`GTK_IM_MODULE=fcitx`, `QT_IM_MODULE=fcitx`, `DISPLAY=:0`). It creates a
loopback provider with `window.quickask.provider.create` (no API key), shows
S1, focuses `[data-testid="composer"]`, and types real XTEST keystrokes with
`xdotool type`; nothing is injected through the clipboard, DOM value or a
synthetic IME.

Measured sequence:

1. `nihao` → `spectacle` candidate screenshot + `tools/ime-probe.mjs`:
   `Fcitx5 Input Window`, `1025,164 666×52`, `IsViewable`, edge distance
   **0 px** (`nfr08-candidate.json`).
2. Return while composing → **0 POST**. On this machine Rime maps Return to
   `CommitRawInput`, so the composition ends with raw `nihao`; the DOM receives
   it as `key: "Process"`, `code: "Enter"`, `keyCode: 229`, `isComposing: true`,
   which the Composer guard ignores. This is explicitly **not** claimed as a
   Chinese commit.
3. Clear, type `nihao`, press **Space** (Rime commits the first candidate
   `你好`), then Return → **1 POST**; mock body log and the persisted session
   both contain the user message `你好` (`nfr08-server.log`,
   `nfr08-server-body.log`).
4. Clear, type `shijie`, press Escape → composition canceled to `""`, the
   window remains `IsViewable` (`window.visible=true`), candidate window gone,
   and POST count unchanged.

fcitx state was captured before the run and restored in `finally`
(`state/group/IM = 1/默认/keyboard-us` before and after). Only runtime
`fcitx5-remote -o/-s/-c` switches were used; no fcitx config file was written
(`config_modified=false`).

## Real-app defects found and fixed in Task 28

1. **Missing animation.** `src/renderer/src/styles/components.css` had no
   panel/sidebar expansion; S1→S2 measured a single-frame jump. Added the
   160 ms keyframes above.
2. **KWin skip state was cached false.** `xprop` showed all skip atoms but
   KWin's internal `skipSwitcher` stayed false, so QuickAsk appeared in
   Alt+Tab. Root cause: KWin 6.3.6 reads skip state only at manage time, and
   `remap-states` unmapped the window before KWin had processed the current
   map. The native helper now waits for the window to appear in
   `_NET_CLIENT_LIST` (KWin managed it), unmaps, waits for it to leave the
   list (KWin released it), then rewrites the atoms and maps. 15/15
   hide/show cycles kept `skipSwitcher=true`. NFR-03 show P95 moved from 37 to
   42 ms (still ≤50 ms), and NFR-01 remains 32 ms.

## Method notes

- NFR-01/03 use the built app and real `xdotool key --clearmodifiers
  ctrl+alt+space`; app-side timestamps come from the JSONL log
  (`hotkey_received` → `window_state visible`) with driver and rAF metrics
  reported separately. Raw JSONL is kept for every sample, including failures
  (none were retried or discarded).
- NFR-04 uses a real xterm target so the Alt+Tab switcher is populated; the
  cursor is parked inside the QuickAsk bar so auto-hide cancels while the
  target window has focus.
- NFR-05 pixels are PIL alpha crops from the real-app screenshots, not
  synthetic images. `task-12-*` are the Task 12 Playwright captures;
  `task-23-*` are the Task 23 appearance regressions.
- NFR-07 is explicitly **not** a blur PASS: KWin Blur is off and the app
  reports that reason. Only the fallback paths are verified.
- NFR-09 records hit counts and fingerprints only; no key material is copied
  into the evidence directory.
- NFR-10 ran for 5 minutes (short) and inspected `connect()` syscalls and `ss`
  snapshots; zero external connections.
- NFR-11 uses real `SIGKILL`, renderer crash/reload and app quit paths; no
  synthetic status strings.
- `npm run test:e2e` passes `101/101` (88 baseline + 10 Gherkin + 3 shortcuts
  in `tests/e2e/shortcuts.spec.ts`: Ctrl+N new session, Ctrl+H history toggle,
  IME-composition guard) after the
  final-geometry assertions wait for the 160 ms animation. Task 28 logs
  `task28-typecheck-build-test.log`, `task28-e2e.log`; Task 31 final logs
  `final-unit.log`, `final-e2e.log`.

## Reproduction

```bash
cd $PROJECT_ROOT
source scripts/env.sh
node tools/nfr02.mjs
node tools/nfr04.mjs          # xprop + 5 Alt+Tab screenshots
node tools/nfr08-real.mjs     # real-app fcitx5/Rime; restores original fcitx state
node tools/nfr-m1.mjs         # NFR-01/03 regression after the X11 fix
npm run typecheck && npm run build && npm run test
npm run test:e2e
```

`docs/m1-acceptance.md` covers NFR-01..NFR-12. All verdicts are backed by
files in `.omo/evidence/m1/`; NFR-08 no longer relies on the Task 5 spike.

## Known limitations and approved deviations

1. **G02 PARTIAL — fcitx5/Rime Return=CommitRawInput.** The app-side guard is
   correct: `keydown` with `isComposing === true` / `keyCode === 229` never
   sends (0 POST), and composing Escape never hides the window. But on this
   machine Rime maps Return to `CommitRawInput`, so Return while composing
   commits the raw pinyin `nihao`, not the Chinese `你好`. Chinese is committed
   with Space (first candidate), and the next Return sends exactly 1 POST with
   `你好`. Strict "Enter commits Chinese" therefore needs product-owner
   acceptance; it is a host IME keymap behavior, not an app regression.
2. **NFR-07 degraded — blur is not available.** KWin Blur effect is OFF on
   this host and `_KDE_NET_WM_BLUR_BEHIND_REGION` is absent. The app honestly
   reports the reason and does not fake `backdrop-filter`. Verified fallback:
   compositor OFF → opaque window with `ShapeBounding` cuts (cards visible, no
   black/white blocks, input works); compositor ON → transparent gutter
   restored. NFR-07 is **PASS (degraded)**, never "blur works".
3. **NFR-06 single display only.** One 1920×1080@100% output exists on this
   machine. The cursor-display default anchor is verified on that output;
   two-work-area, 100%/125% device rounding, S3 overlay, bottom clamp and
   display-removal migration are pure unit tests. A physical second monitor
   and mixed-DPI panel were **not** available, so they are not claimed as
   physically tested.
4. **KWin remap requirement is implemented in the native helper.** KWin 6.3.6
   reads skip state at manage time; `native/quickask-x11` waits for
   `_NET_CLIENT_LIST` membership, unmaps, waits for release, rewrites
   `SKIP_TASKBAR`/`SKIP_PAGER`/`_KDE_NET_WM_STATE_SKIP_SWITCHER`/`ABOVE`, then
   maps again. 15/15 hide/show cycles kept `skipSwitcher=true`; NFR-03 show
   P95 is 42 ms (≤50 ms).
5. **`.deb` is M2; M1 ships the unpacked dir + `.desktop`.** There is no
   system-wide install, no `/opt`, no root requirement, and no autostart entry.
   `release/linux-unpacked/quickask` is the artifact; `release/quickask.desktop`
   is generated for this checkout.
6. **Lint is PASS: 0 errors / 0 warnings (2026-11-05).** The earlier
    "107 errors" baseline is resolved, not suppressed: `eslint.config.mjs`
    scopes browser globals to `tools/**/*.mjs` and relaxes the
    non-production rules `no-useless-assignment` / `no-redeclare` for
    `tools/`, `spike/` and `tests/fixtures/` only. `src/**` keeps the
    strict recommended rule set unchanged, so production code is held to
    the same bar as before. `npm run lint` exits 0; evidence
    `final-lint.log` / `final-lint-summary.json`.
7. **NFR-10 is a 5-minute idle audit, not 24 h.** 0 external connections in 5
   min (`connect()` syscalls + `ss`). Memory soak / R6 is M2.
8. **M1 settings are minimal.** Only the model and appearance groups are
    implemented; the other four groups show "coming in M2". Proxy UI,
    autostart, watchdog and per-output position memory are M2. The model
    group exposes a **single editable model config** (base_url / key /
    model / test connection / headers): the saved-profile list, default
    switching and delete UI were removed from `SettingsWindow.tsx` to avoid
    implying M2 model-profile switching; provider backend support for
    multiple profiles remains internal only.

## Final build, launch, data and log paths

Final Task 31 build was produced after the Task 28 native fix; the packaged
helper is byte-identical to `native/quickask-x11`
(md5 `6247a048862a38a3cc6e20f95d8bacc1`).

| Item | Path / command |
|---|---|
| Build | `source scripts/env.sh && npm run build && npm run dist:dir` |
| Native helper | `native/quickask-x11` (source `native/quickask-x11.c`) |
| Unpacked app | `release/linux-unpacked/quickask` (234,499,400 bytes) |
| Desktop entry | `release/quickask.desktop` (`Exec=…/release/linux-unpacked/quickask %U`) |
| Launch | `./release/linux-unpacked/quickask` |
| Hotkey | `Ctrl+Alt+Space` (configurable via settings; conflict fallback + retry) |
| Tray | left click toggles main window; right click menu: 显示/隐藏, 新建会话, 历史, 设置, 退出 |
| Database / history | `~/.local/share/quickask/quickask.db` (+ `-wal`/`-shm`); override `XDG_DATA_HOME` or `QUICKASK_DATA_DIR` |
| Config / Chromium state | `~/.config/quickask`; override `XDG_CONFIG_HOME` |
| Logs | `~/.local/state/quickask/logs/quickask.log`; override `XDG_STATE_HOME` |
| Crash dumps | `~/.config/quickask/Crashpad` |
| Encrypted fallback | `<data dir>/secrets.enc` (0600, only if keyring unavailable and safeStorage works) |
| Desktop install | `install -Dm644 release/quickask.desktop ~/.local/share/applications/quickask.desktop` |
| Uninstall | see `INSTALL.md` §6 (delete unpacked dir + user `.desktop`, revoke keyring entries, optionally remove data/config/logs) |

`INSTALL.md` is the authoritative operational guide. M1 never writes to
system directories or creates autostart entries.

## Final verification (Task 31)

All commands were run in
`$PROJECT_ROOT` with
`source scripts/env.sh`:

| Gate | Result | Log |
|---|---|---|
| `npm run typecheck` | **PASS** (tsc node + web, exit 0) | `final-build.log` |
| `npm run build` | **PASS** (electron-vite main/preload/renderer) | `final-build.log` |
| `npm run dist:dir` | **PASS** (native rebuild + electron-builder dir) | `final-build.log` |
| `desktop-file-validate build/quickask.desktop release/quickask.desktop` | **PASS** (`DESKTOP_VALID`) | `final-build.log` |
| `ldd release/linux-unpacked/quickask \| grep 'not found' \|\| echo LDD_OK` | **PASS** (`LDD_OK`) | `final-build.log` |
| `npm test` | **PASS** — 31 files / **289 tests** | `final-unit.log` |
| `npm run test:e2e` | **PASS** — **101 tests** (88 baseline + 10 Gherkin + 3 shortcuts), 0 failed | `final-e2e.log` |
| `npx playwright test --reporter=html` | **PASS** — HTML report at `gherkin/index.html`, raw `gherkin/run.log` | `.omo/evidence/m1/gherkin/` |
| `npm run lint` | **PASS** — 0 errors / 0 warnings (config scoped 2026-11-05; `src/**` strict, see limitation #6) | `final-lint.log`, `final-lint-summary.json` |

Packaged artifact checks: `release/linux-unpacked/quickask` starts; the
packaged `resources/native/quickask-x11` md5 equals the source helper; the
generated `release/quickask.desktop` points at the current checkout. No
Electron process is left after the suite (`pgrep -x electron` → no output).

## Next steps (M2)

M1 completion still requires the plan's Final Verification Wave **F1–F4**
(plan compliance, code/security review, real-desktop QA, context mining) and
product-owner sign-off. Do not mark M1 complete before those pass.

After sign-off, M2 tasks 32–36:

1. **Task 32** — all six settings groups + hotkey recording (trial register /
   rollback), Esc behavior, system prompt, temperature, max_tokens, timeout.
2. **Task 33** — proxy direct/system/custom HTTP/HTTPS/SOCKS5 + saved model
   profiles / quick switching.
3. **Task 34** — per-output position memory, autostart, watchdog restart.
4. **Task 35** — JSON/Markdown export, retention policy, font switching,
   log viewer.
5. **Task 36** — `.deb` / AppImage + install/uninstall, 24 h memory soak,
   physical 100%/125% mixed-DPI test, R6/R7 re-check.
