# Tasks: zai-quota-plugin

<!-- 07:12 → coder wave1 tasks 1-3 (config/token/api) -->
<!-- 07:31 → tester wave1 tasks 1-3 -->
<!-- 07:44 → reviewer wave1 tasks 1-3 (boundaries+security) -->
<!-- 07:58 → coder wave2 tasks 4-5 (runway/render) — EMPTY RESULT, no files created, retrying split -->
<!-- 08:14 → coder wave2 task 4 (runway) retry -->
<!-- 08:26 → coder wave2 task 5 (format/roles/render) — EMPTY RESULT again, no files; splitting briefs -->
<!-- 08:38 → coder wave2 task 5a (format+roles) retry, smaller brief — OK, 95 pass -->
<!-- 08:47 → coder wave2 task 5b (render) — OK -->
<!-- 09:02 → coder spotfix gauge cfg passthrough — OK, 136 pass -->
<!-- 09:06 → tester wave2 tasks 4-5 — 151 pass, purity frozen -->
<!-- 09:18 → reviewer wave2 tasks 4-5 (boundaries+security) — approve-with-notes, F5/F6 to fix -->
<!-- 09:31 → coder wave2 hardening F1-F6 — OK, 170 pass, committed 18c54cf/0d82141/8f90ade -->
<!-- 09:40 → coder wave3 task 6 (tui wiring + entry + shim) — OK, 183 pass -->
<!-- 10:02 → coder wave3 task 7 (README) — OK, 175 lines, env names verified -->
<!-- 10:14 → tester wave3 tasks 6-7 — 192 pass; README 'empty' mismatch found -->
<!-- 10:27 → coder wave3 fix: implement empty error state per design D5 — OK, 195 pass -->
<!-- 10:36 → reviewer wave3 tasks 6-7 (boundaries+security) — approve-with-notes: B1/A1/A2 -->
<!-- 10:48 → coder wave3 hardening B1/A1/A2 — OK, 197 pass, committed 59592e0/d9d5b51 -->
<!-- 11:00 → reviewer final: 5 axes — approve-with-notes (ship-ready; 1 Required repo-state) -->
<!-- 11:12 → coder final fixes: findings 2+3 (history pruning, stale tick) -->

Vertical slices, dependency-ordered. Edge cases are embedded in each task's
acceptance criteria (numeric: 0, -1, MAX_SAFE_INTEGER, NaN; strings: empty,
unicode, malformed; concurrency: overlap, dispose). Verification per task:
`bun test` (focused file) + `tsc --noEmit` at wave checkpoint.

Waves: W1 = tasks 1-3 (independent files) · W2 = tasks 4-5 (independent files) ·
W3 = task 6 (integration) → task 7 (docs). Checkpoint after each wave: full
`bun test` + `tsc --noEmit` + CONSTRAINTS.md grep gates.

---

## Task 1: Config resolution module

Description: `src/config.ts` — `resolveConfig(env, options?)` implementing the
three-layer contract (defaults < `ZAI_QUOTA_*` env < options), per design.md D6.

Acceptance criteria:
- [x] Defaults exactly match design.md D6 table (intervalMs 60000, endpoint
      https://api.z.ai/api/monitor/usage/quota/limit, timeoutMs 8000, gaugeWidth 12,
      warn 0.70, crit 0.90, panel/chip/showRunway true, maxHistory 120,
      tokenEnv ["ZAI_TOKEN","Z_AI_TOKEN"], authKeys ["zai-coding-plan","zai"]).
- [x] Layer precedence proven by test: option beats env beats default.
- [x] intervalMs: NaN/non-finite env → default; finite values clamp to ≥ 10000
      (0, -1, 9999 → 10000; 60000 → 60000; 10_000_000 stays; 2^31-1 ceiling per
      review fix A1-5).
- [x] timeoutMs clamps to 1000..60000 (0 → 1000, MAX_SAFE_INTEGER → 60000).
- [x] gaugeWidth int-clamps 4..40 (0, 3.9, -1 → 4; 40.9 → 40; 12.6 → 12 floor).
- [x] warn/crit cross-validation: 0 < warn < crit ≤ 1, finite; invalid pair
      (0.9/0.8, NaN, 0, 1.5/2, warn==crit) → both revert to defaults.
- [x] Booleans accept "1"/"true"/"yes"/"TRUE"; "0"/"false"/""/garbage → default
      (non-string env never throws — review fix A1-2).
- [x] Empty-string endpoint in env/options → default endpoint; non-https scheme
      accepted with warning (review fix S-1).
- [x] tokenEnv/authKeys from options must be non-empty string arrays; anything
      else → defaults (entry "" filtered).
- [x] Every fallback appends a human-readable warning to `warnings: string[]`
      (deduped); function NEVER throws (options = garbage object does not throw;
      non-string/number types rejected not coerced — review fix A1-1).
- [x] Pure function: no fs, no process access — env passed as argument.

PROOF: `bun test src/config.test.ts` → exit 0, 31 pass. `bunx tsc --noEmit` →
exit 0. Reviewer: approve-with-notes; notes A1-1/A1-2/A1-5/S-1 fixed and
re-tested (66 pass wave total).

Verification: `bun test src/config.test.ts` exit 0; `tsc --noEmit` at checkpoint.
Dependencies: None. Files: src/config.ts, src/config.test.ts, tsconfig.json
(strict, jsx react-jsx, jsxImportSource @opentui/solid, include src). Scope: S.

## Task 2: Token resolution module

Description: `src/token.ts` — `resolveToken(readFile, homeDir, env, config)` →
`string | undefined`. Read-only credentials access, never throws, never logs.

Acceptance criteria:
- [x] Reads `<homeDir>/.local/share/opencode/auth.json` as JSON; tries
      `auth[key].key` for each key in config.authKeys order; first non-empty
      string wins.
- [x] Env fallback in config.tokenEnv order after auth.json yields nothing.
- [x] Missing file (readFile throws ENOENT) → undefined, no throw.
- [x] Malformed JSON → undefined, no throw.
- [x] Empty-string key `""` and whitespace-only key skipped, next candidate tried.
- [x] auth.json with `{"zai-coding-plan":{"key":""},"zai":{"key":"k"}}` → "k".
- [x] Non-string `.key` (number/object/null) skipped safely.
- [x] `readFile` and `homeDir` are injected — module has zero direct node imports.
- [x] Token value never appears in any warning/message the module produces.

PROOF: `bun test src/token.test.ts` → exit 0, 14 pass. Reviewer approve-with-notes
(A1-3 diagnostics deferred — DECISIONS.md #13).

Verification: `bun test src/token.test.ts` exit 0. Dependencies: Task 1 (Config
type only). Files: src/token.ts, src/token.test.ts. Scope: S.

## Task 3: API client + payload parser

Description: `src/api.ts` — `fetchQuota(fetchImpl, token, config)` with abort
timeout and error taxonomy; `parseQuota(payload)` pure parser per design.md D3.

Acceptance criteria:
- fetchQuota:
  - [x] Success (200, JSON) → `{ ok: true, payload }`.
  - [x] HTTP error status → `{ ok: false, error: "http-429" }` etc. (status code
        in message, body not included).
  - [x] Body not JSON (HTML/text/empty) → `bad-json` error.
  - [x] fetchImpl rejection (network) → `network` error; token never in message.
  - [x] Timeout: fetchImpl ignores signal longer than timeoutMs → aborted,
        `timeout` error (test with fake timers or resolved-promise race).
  - [x] Authorization header set: `Bearer <token>` asserted via captured request.
  - [x] GET only; endpoint from config.
- parseQuota:
  - [x] unit 3 → label "5h"; unit 6 → "wk"; other/missing unit → String(type);
        missing type → "quota".
  - [x] usage prefers currentValue, falls back usage, else null.
  - [x] limit = usage + remaining when both numbers, else null (sum finite-checked
        — review fix A1-4).
  - [x] percentage 150 → 100; -5 → 0; NaN/absent → fallback usage/limit*100 only
        when usage != null && limit > 0, else null.
  - [x] nextResetTime "2026-01-01" (string) → resetAt null (typeof guard).
  - [x] limits: [], undefined, non-array, entries null → [] or generic-scan rows;
        never throws on `{}`, `null`, `"string"`, deeply weird payloads.
  - [x] level: non-string → null.
  - [x] Duplicate labels (two unit-3 rows) — both kept, chip picks first.

PROOF: `bun test src/api.test.ts` → exit 0, 21 pass. Wave-1 totals: 66 pass,
`tsc --noEmit` exit 0, committed d7201e1/2ab8777/6326154.

Verification: `bun test src/api.test.ts` exit 0. Dependencies: Task 1 (Config).
Files: src/api.ts, src/api.test.ts. Scope: M.

---

## Task 4: Runway model

Description: `src/runway.ts` — pure state transforms: `pushSample(history, t,
usage, resetAt, maxHistory)` and `computeRunway(history, row, now)` per design.md D4.

Acceptance criteria:
- [x] resetAt change between consecutive samples → history reset to single sample.
      (resetAt-change detection lives in wiring; pushSample covers usage-decrease
      boundary — design D4 split verified in review.)
- [x] usage decrease with unchanged resetAt → history reset (rolling-window safety).
- [x] States: no-limit (limit null) / no-reset (resetAt null or non-finite —
      review F1) / no-data (<2 samples, null usage, or span < 1 s) / no-burn
      (rate ≤ 0) / ok / warn — all covered by tests.
- [x] burnRate from first→last in window; runway = remaining / rate; warn iff
      runway < time-to-reset (now < resetAt); boundary equality → ok.
- [x] resetAt in past → time-to-reset 0; finite positive runway → ok (quota
      survives to reset — correct semantics; negative/overquota runway → warn).
- [x] maxHistory cap: pushing 2× maxHistory samples keeps last maxHistory
      (degenerate maxHistory ≤ 0 clamps to 1 — review F4).
- [x] remaining = limit - usage; usage > limit (overquota) → remaining negative →
      runway negative → warn with 0-ish display handled by format layer.
- [x] MAX_SAFE_INTEGER usage values do not produce Infinity runway (rate huge or
      remaining/rate saturates) — no NaN in output for finite inputs.
- [x] Pure: returns new arrays, never mutates inputs (deep-freeze tests).

PROOF: `bun test src/runway.test.ts` → exit 0 (26 tests incl. review F1/F4).
Committed 18c54cf.

Verification: `bun test src/runway.test.ts` exit 0. Dependencies: Task 3 (Row type).
Files: src/runway.ts, src/runway.test.ts. Scope: S.

## Task 5: Format + roles + render view-models

Description: `src/format.ts` (fmtDuration, fmtCount), `src/roles.ts` (role→theme
key map, the only translation point), `src/render.ts` (gauge, chipSegments,
panelModel) — pure, theme-role-emitting per design.md D2/D7/D8.

Acceptance criteria:
- [x] fmtDuration: 0 → "0m"; negative → "0m"; 45_000 → "45s"; 4_320_000 → "1h 12m";
  172_800_000 → "48h"; MAX_SAFE_INTEGER → finite h value (no "Infinity";
  non-finite input → "0m" — review F2).
- [x] fmtCount: 0, 999, 1000 → "1k", 1_500_000 → "1.5M", MAX_SAFE_INTEGER finite
  (non-finite input → "?" — review F2).
- [x] gauge: percent null → placeholder cells only; 0 → empty; 100 → full;
  >100 clamped; width from config; partial glyph at boundary cell; output
  length exactly width cells; no hex/ANSI escapes in output (assert).
  Width invariant proven by reviewer across 818k adversarial cases.
- [x] colorRole(percent): null → muted; < 70 → ok; 70..89.99 → warn; ≥ 90 → crit
  (thresholds from config, not literals; cfg passthrough through gauge fixed).
- [x] chipSegments: rows selected by label "5h"/"wk" (never index); missing label →
  "?" segment; error input → `zai:?` segments; each segment {text, role}.
- [x] panelModel: header with level/updated/stale flag (stale iff now-updatedAt >
  2×intervalMs); per-row lines with usage/limit via fmtCount (limit null → "?");
  runway line states map to distinct text per design D4; showRunway=false → no
  runway lines; label/level sanitized against control chars/bidi + capped 24
  (review F5); duplicate 5h/wk rows dropped, first wins (documented — review F3).
- [x] Unicode label row passes through (printable Unicode intact), no crash.
- [x] All exports pure; no imports from tui/api/runway internals beyond types.

PROOF: `bun test src/format.test.ts src/render.test.ts` → exit 0 (17 + 49).
Committed 0d82141. Wave-2 totals: 170 pass, `tsc --noEmit` exit 0.

Verification: `bun test src/format.test.ts src/render.test.ts` exit 0.
Dependencies: Task 4 (RunwayResult type). Files: src/format.ts, src/format.test.ts,
src/roles.ts, src/render.ts, src/render.test.ts. Scope: M.

---

## Task 6: TUI wiring + entry + plugin shim

Description: `src/tui.tsx` (signals, slots, keymap, refresh engine, dispose),
`src/index.ts` (≤ 10 lines: `export const id`, `export const tui`),
`.opencode/plugins/zai-quota.ts` (re-export shim) per design.md D1/D5/D7.

Acceptance criteria:
- [x] index.ts exports `id: string` and `tui` (TuiPlugin) — module contract
      satisfied; entry ≤ 10 lines (3 lines, pinned by test); no logic in entry.
- [x] Slots registered once: `sidebar_content` (panel when config.panel) and
      `session_prompt_right` (chip when config.chip); disabled flag → slot not
      rendered; both disabled → register skipped entirely (review A1).
- [x] Slot render functions use ONLY roles→api.theme.current mapping from
      roles.ts; fake-theme capture test asserts every fg value comes from the
      theme object (no literals).
- [x] Command layer: `keymap.registerLayer` with commands [{ name
      "zai-quota.refresh", title "Z.AI quota: refresh now", desc, slashName
      "zai-quota", slashAliases ["zq"], namespace "palette", run }], bindings [];
      run → forced refresh + toast (success summary or error text; labels
      sanitized — review B1). NO api.command usage anywhere (grep gate).
- [x] Refresh engine: in-flight dedupe — two immediate scheduleRefresh() calls →
      exactly one fetchImpl invocation (await both); three concurrent triggers
      pinned by tester.
- [x] Idle throttle: session.idle event within intervalMs/2 of last fetch start
      → no fetch; after → fetch (equality boundary pinned).
- [x] session.error event → forced refresh (bypasses throttle).
- [x] Initial refresh scheduled on plugin start.
- [x] Errors set signal state with taxonomy (no-token/network/http-N/bad-json/
      empty/timeout); chip renders zai:? on error; stale marker path exercised;
      empty rows → "empty" state per design D5.
- [x] Dispose: onDispose → clearInterval, event unsubscribes, keymap layer
      disposer — no timer survives (dispose mid-flight: no throw, no unhandled
      rejection — test-pinned).
- [x] Config resolved once at startup from (env, options arg); token re-read per
      refresh (fake fs swap between refreshes is picked up).
- [x] Wiring smoke test with fake api: slots/keymap/event captures; slot fns
      called with populated state → return renderable structures, no throw.
      Fire-and-forget refreshes carry rejection sinks (review A2).

PROOF: `bun test src/tui.test.tsx` → exit 0 (24 tests incl. empty-state and
hardening). Committed 59592e0.

Verification: `bun test src/tui.test.tsx` exit 0; full suite green.
Dependencies: Tasks 1-5. Files: src/tui.tsx, src/tui.test.tsx, src/index.ts,
.opencode/plugins/zai-quota.ts, tsconfig.json (if not from task 1). Scope: M.

## Task 7: README — install + configuration reference

Description: `README.md` at repo root: what it shows (screenshot-free ASCII
mock), install (npm package, local file, options tuple), full config table.

Acceptance criteria:
- [x] Every key from design.md D6 documented: name, env var, default, validation
      (12 keys — verified programmatically against DEFAULT_CONFIG and ENV_TO_KEY).
- [x] Install paths: (a) `"plugin": ["opencode-zai-quota"]` after `bun install`,
      (b) local file shim, (c) tuple form with options object — all three shown.
- [x] Token sources and precedence documented; explicit "token is never sent
      anywhere except api.z.ai" note.
- [x] PR #1 note: modern keymap API, no deprecation warnings.
- [x] ASCII mock of panel + chip matching render output shape (format verified
      against fmtDuration behavior).

PROOF: manual read + `bun run check:all` green. README accuracy re-verified by
wave-3 reviewer (defaults/env/commands/slots/errors all match source) and tester
(5 random claims). Committed d9d5b51.

Verification: manual read + `bun run check:all` still green. Dependencies: Task 6.
Files: README.md. Scope: S.

---

## Checkpoints

- W1 (tasks 1-3): `bun test` + `tsc --noEmit` + grep gates — pure core proven.
- W2 (tasks 4-5): same gates — derived logic proven.
- W3 (tasks 6-7): full suite + wiring smoke + README accuracy — plugin loadable.
- Final: reviewer 5 axes + security hardening; `openspec validate`; archive.
