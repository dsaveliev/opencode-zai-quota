# Tasks: zai-quota-plugin

<!-- 07:12 → coder wave1 tasks 1-3 (config/token/api) -->
<!-- 07:31 → tester wave1 tasks 1-3 -->
<!-- 07:44 → reviewer wave1 tasks 1-3 (boundaries+security) -->

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
- [ ] Defaults exactly match design.md D6 table (intervalMs 60000, endpoint
      https://api.z.ai/api/monitor/usage/quota/limit, timeoutMs 8000, gaugeWidth 12,
      warn 0.70, crit 0.90, panel/chip/showRunway true, maxHistory 120,
      tokenEnv ["ZAI_TOKEN","Z_AI_TOKEN"], authKeys ["zai-coding-plan","zai"]).
- [ ] Layer precedence proven by test: option beats env beats default.
- [ ] intervalMs: NaN/non-finite env → default; finite values clamp to ≥ 10000
      (0, -1, 9999 → 10000; 60000 → 60000; 10_000_000 stays).
- [ ] timeoutMs clamps to 1000..60000 (0 → 1000, MAX_SAFE_INTEGER → 60000).
- [ ] gaugeWidth int-clamps 4..40 (0, 3.9, -1 → 4; 40.9 → 40; 12.6 → 12 floor).
- [ ] warn/crit cross-validation: 0 < warn < crit ≤ 1, finite; invalid pair
      (0.9/0.8, NaN, 0, 1.5/2, warn==crit) → both revert to defaults.
- [ ] Booleans accept "1"/"true"/"yes"/"TRUE"; "0"/"false"/""/garbage → default.
- [ ] Empty-string endpoint in env/options → default endpoint.
- [ ] tokenEnv/authKeys from options must be non-empty string arrays; anything
      else → defaults (entry "" filtered).
- [ ] Every fallback appends a human-readable warning to `warnings: string[]`
      (deduped); function NEVER throws (options = garbage object does not throw).
- [ ] Pure function: no fs, no process access — env passed as argument.

Verification: `bun test src/config.test.ts` exit 0; `tsc --noEmit` at checkpoint.
Dependencies: None. Files: src/config.ts, src/config.test.ts, tsconfig.json
(strict, jsx react-jsx, jsxImportSource @opentui/solid, include src). Scope: S.

## Task 2: Token resolution module

Description: `src/token.ts` — `resolveToken(readFile, homeDir, env, config)` →
`string | undefined`. Read-only credentials access, never throws, never logs.

Acceptance criteria:
- [ ] Reads `<homeDir>/.local/share/opencode/auth.json` as JSON; tries
      `auth[key].key` for each key in config.authKeys order; first non-empty
      string wins.
- [ ] Env fallback in config.tokenEnv order after auth.json yields nothing.
- [ ] Missing file (readFile throws ENOENT) → undefined, no throw.
- [ ] Malformed JSON → undefined, no throw.
- [ ] Empty-string key `""` and whitespace-only key skipped, next candidate tried.
- [ ] auth.json with `{"zai-coding-plan":{"key":""},"zai":{"key":"k"}}` → "k".
- [ ] Non-string `.key` (number/object/null) skipped safely.
- [ ] `readFile` and `homeDir` are injected — module has zero direct node imports.
- [ ] Token value never appears in any warning/message the module produces.

Verification: `bun test src/token.test.ts` exit 0. Dependencies: Task 1 (Config
type only). Files: src/token.ts, src/token.test.ts. Scope: S.

## Task 3: API client + payload parser

Description: `src/api.ts` — `fetchQuota(fetchImpl, token, config)` with abort
timeout and error taxonomy; `parseQuota(payload)` pure parser per design.md D3.

Acceptance criteria:
- fetchQuota:
  - [ ] Success (200, JSON) → `{ ok: true, payload }`.
  - [ ] HTTP error status → `{ ok: false, error: "http-429" }` etc. (status code
        in message, body not included).
  - [ ] Body not JSON (HTML/text/empty) → `bad-json` error.
  - [ ] fetchImpl rejection (network) → `network` error; token never in message.
  - [ ] Timeout: fetchImpl ignores signal longer than timeoutMs → aborted,
        `timeout` error (test with fake timers or resolved-promise race).
  - [ ] Authorization header set: `Bearer <token>` asserted via captured request.
  - [ ] GET only; endpoint from config.
- parseQuota:
  - [ ] unit 3 → label "5h"; unit 6 → "wk"; other/missing unit → String(type);
        missing type → "quota".
  - [ ] usage prefers currentValue, falls back usage, else null.
  - [ ] limit = usage + remaining when both numbers, else null.
  - [ ] percentage 150 → 100; -5 → 0; NaN/absent → fallback usage/limit*100 only
        when usage != null && limit > 0, else null.
  - [ ] nextResetTime "2026-01-01" (string) → resetAt null (typeof guard).
  - [ ] limits: [], undefined, non-array, entries null → [] or generic-scan rows;
        never throws on `{}`, `null`, `"string"`, deeply weird payloads.
  - [ ] level: non-string → null.
  - [ ] Duplicate labels (two unit-3 rows) — both kept, chip picks first.

Verification: `bun test src/api.test.ts` exit 0. Dependencies: Task 1 (Config).
Files: src/api.ts, src/api.test.ts. Scope: M.

---

## Task 4: Runway model

Description: `src/runway.ts` — pure state transforms: `pushSample(history, t,
usage, resetAt, maxHistory)` and `computeRunway(history, row, now)` per design.md D4.

Acceptance criteria:
- [ ] resetAt change between consecutive samples → history reset to single sample.
- [ ] usage decrease with unchanged resetAt → history reset (rolling-window safety).
- [ ] States: no-limit (limit null) / no-reset (resetAt null) / no-data (<2 samples
      or span < 1 s) / no-burn (rate ≤ 0) / ok / warn — all covered by tests.
- [ ] burnRate from first→last in window; runway = remaining / rate; warn iff
      runway < time-to-reset (now < resetAt); boundary equality → ok.
- [ ] resetAt in past → time-to-reset 0 → any finite runway is warn; no-burn stays
        no-burn.
- [ ] maxHistory cap: pushing 2× maxHistory samples keeps last maxHistory.
- [ ] remaining = limit - usage; usage > limit (overquota) → remaining negative →
      runway negative → warn with 0-ish display handled by format layer.
- [ ] MAX_SAFE_INTEGER usage values do not produce Infinity runway (rate huge or
      remaining/rate saturates) — no NaN in output for finite inputs.
- [ ] Pure: returns new arrays, never mutates inputs.

Verification: `bun test src/runway.test.ts` exit 0. Dependencies: Task 3 (Row type).
Files: src/runway.ts, src/runway.test.ts. Scope: S.

## Task 5: Format + roles + render view-models

Description: `src/format.ts` (fmtDuration, fmtCount), `src/roles.ts` (role→theme
key map, the only translation point), `src/render.ts` (gauge, chipSegments,
panelModel) — pure, theme-role-emitting per design.md D2/D7/D8.

Acceptance criteria:
- fmtDuration: 0 → "0m"; negative → "0m"; 45_000 → "45s"; 4_320_000 → "1h 12m";
  172_800_000 → "48h"; MAX_SAFE_INTEGER → finite h value (no "Infinity").
- fmtCount: 0, 999, 1000 → "1.0k", 1_500_000 → "1.5M", MAX_SAFE_INTEGER finite.
- gauge: percent null → placeholder cells only; 0 → empty; 100 → full;
  >100 clamped; width from config; partial glyph used at boundary cell; output
  length exactly width cells; no hex/ANSI escapes in output (assert).
- colorRole(percent): null → muted; < 70 → ok; 70..89.99 → warn; ≥ 90 → crit
  (thresholds from config, not literals).
- chipSegments: rows selected by label "5h"/"wk" (never index); missing label →
  "?" segment; error input → `zai:?` segments; each segment {text, role}.
- panelModel: header with level/updated/stale flag (stale iff now-updatedAt >
  2×intervalMs); per-row lines with usage/limit via fmtCount (limit null → "?");
  runway line states map to distinct text per design D4; showRunway=false → no
  runway lines.
- Unicode label row (e.g. type "配給" — decode-safe pass-through, no crash, byte
  length not used for layout).
- All exports pure; no imports from tui/api/runway internals beyond types.

Verification: `bun test src/format.test.ts src/render.test.ts` exit 0.
Dependencies: Task 4 (RunwayResult type). Files: src/format.ts, src/format.test.ts,
src/roles.ts, src/render.ts, src/render.test.ts. Scope: M.

---

## Task 6: TUI wiring + entry + plugin shim

Description: `src/tui.tsx` (signals, slots, keymap, refresh engine, dispose),
`src/index.ts` (≤ 10 lines: `export const id`, `export const tui`),
`.opencode/plugins/zai-quota.ts` (re-export shim) per design.md D1/D5/D7.

Acceptance criteria:
- [ ] index.ts exports `id: string` and `tui` (TuiPlugin) — module contract
      satisfied; entry ≤ 10 lines; no logic in entry.
- [ ] Slots registered once: `sidebar_content` (panel when config.panel) and
      `session_prompt_right` (chip when config.chip); disabled flag → slot not
      rendered (returns null).
- [ ] Slot render functions use ONLY roles→api.theme.current mapping from
      roles.ts; a fake-theme capture test asserts every fg value comes from the
      theme object (no literals).
- [ ] Command layer: `keymap.registerLayer` with commands [{ name
      "zai-quota.refresh", title "Z.AI quota: refresh now", desc, slashName
      "zai-quota", slashAliases ["zq"], namespace "palette", run }], bindings [];
      run → forced refresh + toast (success summary or error text). NO
      api.command usage anywhere (grep gate).
- [ ] Refresh engine: in-flight dedupe — two immediate scheduleRefresh() calls →
      exactly one fetchImpl invocation (await both).
- [ ] Idle throttle: session.idle event within intervalMs/2 of last fetch start
      → no fetch; after → fetch.
- [ ] session.error event → forced refresh (bypasses throttle).
- [ ] Initial refresh scheduled on plugin start.
- [ ] Errors set signal state with taxonomy (no-token/network/http-N/bad-json/
      empty/timeout); chip renders zai:? on error; stale marker path exercised.
- [ ] Dispose: onCleanup + lifecycle.onDispose → clearInterval, event
      unsubscribes, keymap layer disposer — fake api counts calls; no timer
      survives (fake timers: advance after dispose → fetchImpl count unchanged).
- [ ] Config resolved once at startup from (env, options arg); token re-read per
      refresh (fake fs swap between refreshes is picked up).
- [ ] Wiring smoke test with fake api: slots/keymap/event captures; slot fns
      called with populated state → return renderable structures, no throw.

Verification: `bun test src/tui.test.tsx` exit 0; full suite green.
Dependencies: Tasks 1-5. Files: src/tui.tsx, src/tui.test.tsx, src/index.ts,
.opencode/plugins/zai-quota.ts, tsconfig.json (if not from task 1). Scope: M.

## Task 7: README — install + configuration reference

Description: `README.md` at repo root: what it shows (screenshot-free ASCII
mock), install (npm package, local file, options tuple), full config table.

Acceptance criteria:
- [ ] Every key from design.md D6 documented: name, env var, default, validation.
- [ ] Install paths: (a) `"plugin": ["opencode-zai-quota"]` after `bun install`,
      (b) local file shim, (c) tuple form with options object — all three shown.
- [ ] Token sources and precedence documented; explicit "token is never sent
      anywhere except api.z.ai" note.
- [ ] PR #1 note: modern keymap API, no deprecation warnings.
- [ ] ASCII mock of panel + chip matching render output shape.

Verification: manual read + `bun run check:all` still green. Dependencies: Task 6.
Files: README.md. Scope: S.

---

## Checkpoints

- W1 (tasks 1-3): `bun test` + `tsc --noEmit` + grep gates — pure core proven.
- W2 (tasks 4-5): same gates — derived logic proven.
- W3 (tasks 6-7): full suite + wiring smoke + README accuracy — plugin loadable.
- Final: reviewer 5 axes + security hardening; `openspec validate`; archive.
