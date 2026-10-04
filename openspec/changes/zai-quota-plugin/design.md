# Design: zai-quota-plugin

## Context

OpenCode TUI plugin displaying the two Z.AI coding-plan quota limits (5-hour
window + weekly plan allowance), pulled from the Z.AI monitoring API on a timer.
Redesigned around a **runway** concept: the headline is not static consumption
but the derived answer to "will my quota last until reset?". All 15 findings from
the adversarial design review (doubt-driven cycle 1, verified against
`@opencode-ai/plugin@1.18.34` and `@opentui/keymap@0.5.14` types) are folded in.

## Verified API facts (type-checked, not assumed)

- Module contract: `TuiPluginModule = { id?: string; tui: TuiPlugin; server?: never }`
  — the plugin file MUST export a `tui` key or the loader silently skips it.
- `TuiPlugin = (api: TuiPluginApi, options: PluginOptions | undefined, meta) => Promise<void>`
  — options arrive as the 2nd argument when configured via `plugin: [[spec, options]]`.
- Theme: `TuiThemeCurrent` has `primary, secondary, accent, error, warning, success,
  info, text, textMuted, border, ...` — tokens `warn/crit/ok` do NOT exist.
- `api.keymap.registerLayer(layer: Layer): () => void` — modern command API; returns
  a disposer. `Command` base = `{ name, run(ctx), [key: string]: unknown }`; palette
  conventions (PR #1 mapping): `title, desc, slashName, slashAliases,
  namespace: "palette"`.
- `api.slots.register({ order, slots })` (no id — lifetime managed by host);
  slot names used: `sidebar_content`, `session_prompt_right`.
- `api.event.on(type, handler)` returns unsubscribe; `api.lifecycle.onDispose(fn)`.
- Deprecation warning source is `api.command.*` — never used here.

## Module layout

```
package.json              deps: @opencode-ai/plugin, solid-js; devDeps: @opentui/*, typescript, @types/bun
tsconfig.json             strict, jsx react-jsx, jsxImportSource @opentui/solid
.opencode/plugins/zai-quota.ts   thin re-export shim: export { id, tui } from "../../src/index"
src/index.ts              entry: export const id, export const tui (glue <= 10 lines)
src/config.ts             resolveConfig(env, options) -> Config (pure)
src/token.ts              resolveToken(readFile, homedir, env, config) -> string | undefined (injectable fs)
src/api.ts                fetchQuota(fetchImpl, token, config) -> FetchResult; parseQuota(payload) -> ParsedQuota (pure parse)
src/runway.ts             pushSample(), computeRunway() (pure state transforms)
src/render.ts             gauge(), chipSegments(), panelModel() (pure; emits semantic color ROLES)
src/roles.ts              ROLE_TO_THEME: { crit:"error", warn:"warning", ok:"success",
                          muted:"textMuted", accent:"primary", info:"info" } — the ONLY translation point
src/format.ts             fmtDuration, fmtCount (pure)
src/tui.tsx               wiring: signals, slots, keymap, refresh engine, dispose
*.test.ts (co-located)    bun:test
README.md                 install + full config table
```

## D1 — Entry shape & dependencies

`src/index.ts` exports `id = "zai-quota"` and `tui: TuiPlugin`. No build step —
OpenCode loads TS/TSX directly and resolves `@opentui/*` + `solid-js` in its host;
the repo still ships package.json so `bun install` provides the same modules for
tsc and tests (review finding 3).

## D2 — Theme roles (no hardcoded colors)

`src/render.ts` emits role names; `src/roles.ts` maps them to `api.theme.current.*`
keys. Mapping: crit→`error`, warn→`warning`, ok→`success`, muted→`textMuted`,
accent→`primary`, info→`info` (review finding 2). No hex/ANSI literals anywhere in
render paths (CONSTRAINTS.md grep gate).

## D3 — API parsing

`GET {endpoint}` with `Authorization: Bearer <token>` (token re-read each refresh —
cheap sync read, picks up re-login; finding 13). Response
`{ data: { limits: [{ type, unit, number, usage, currentValue, remaining,
percentage, nextResetTime }], level } }`:

- label: `unit === 3 → "5h"`, `unit === 6 → "wk"`, else `String(type ?? "quota")`.
- usage: `currentValue` (in-window) preferred, else `usage`, else null — `typeof`
  guarded.
- limit: `usage != null && typeof remaining === "number" ? usage + remaining : null`.
- percent: `clamp(typeof percentage === "number" ? percentage : NaN, 0, 100)`; if
  NaN, fallback `usage != null && limit > 0 ? usage/limit*100 : null` (finding 9).
- resetAt: `typeof nextResetTime === "number" ? nextResetTime : null` (finding 10).
- limits missing/not an array/empty → generic object scan → still empty → `[]`
  (plugin shows "no data", never crashes).
- `level` → plan-level string (typeof-guarded).

Rows are selected BY LABEL (`5h`, `wk`), never by array index — chip and panel
degrade to `?` when a label is absent (finding 6).

## D4 — Runway model (the redesign headline)

Per-label history `[{ t, usage }]`, capped at `maxHistory`.

- Window boundary: `resetAt` value change → history reset. A usage DECREASE with
  unchanged resetAt also resets history — but negative deltas between consecutive
  samples are clamped to 0 in burn computation, so a rolling window (where usage
  decays without reset) cannot poison the rate (finding 5: both semantics safe).
- burnRate (units/s) = `(uLast - uFirst) / (tLast - tFirst)`, first→last span,
  only positive deltas summed... computed from window's first and last samples;
  requires span ≥ 1 s.
- runway = `remaining / burnRate` where `remaining = limit - usage`.
- States (explicit, exhaustive — finding 4):
  `no-limit` (limit null) · `no-reset` (resetAt null; risk undecidable) ·
  `no-data` (< 2 samples or span < 1 s) · `no-burn` (rate ≤ 0; runway infinite) ·
  `ok` (runway ≥ time-to-reset) · `warn` (runway < time-to-reset → projected
  exhaustion before reset).
- Weekly window uses the same machinery; both rows render runway.

## D5 — Refresh engine (pull by timer)

Single `scheduleRefresh(force?)` guarded by:
1. **In-flight dedupe**: if a fetch is pending, return the same promise (timer +
   idle + error-event overlap → exactly one request).
2. **Idle throttle**: non-forced refresh skipped if last fetch started <
   `intervalMs / 2` ago (finding 8).

Triggers: `setInterval(intervalMs)` · `session.idle` (throttled) · `session.error`
(forced — quota jump is most interesting exactly then; finding 11) · manual
`/zai-quota` command (forced). Fetch: `AbortController` with `timeoutMs`
(clamped 1000..60000 — finding 7e); non-JSON or HTML body → `bad-json` error.

Error taxonomy (distinguishable in UI — finding 15):
`no-token` · `network` · `http-N` · `bad-json` · `empty`. On error, previous rows
stay visible with a `stale` marker (warning role) once `now - updatedAt > 2 ×
intervalMs`; chip shows ` zai:? `.

Dispose (hot-reload safe — finding 12): `clearInterval`, event unsubscribes,
keymap layer disposer — all wired into `onCleanup` + `api.lifecycle.onDispose`.

## D6 — Config contract (review finding 7, fully specified)

Resolution: defaults < `ZAI_QUOTA_*` env < plugin options (2nd arg). Invalid
value at any layer → default for that key + warning string (surfaced once via
toast, kept in state). Never throws.

| Key | Env | Default | Validation |
|-----|-----|---------|------------|
| intervalMs | ZAI_QUOTA_INTERVAL_MS | 60000 | finite, clamp ≥ 10000 |
| endpoint | ZAI_QUOTA_ENDPOINT | https://api.z.ai/api/monitor/usage/quota/limit | non-empty string |
| timeoutMs | ZAI_QUOTA_TIMEOUT_MS | 8000 | finite, clamp 1000..60000 |
| gaugeWidth | ZAI_QUOTA_GAUGE_WIDTH | 12 | int, clamp 4..40 |
| warnThreshold | ZAI_QUOTA_WARN | 0.70 | 0 < warn < crit ≤ 1, finite |
| critThreshold | ZAI_QUOTA_CRIT | 0.90 | same cross-check |
| panel | ZAI_QUOTA_PANEL | true | "1"/"true"/"yes" |
| chip | ZAI_QUOTA_CHIP | true | same |
| showRunway | ZAI_QUOTA_RUNWAY | true | same |
| maxHistory | ZAI_QUOTA_MAX_HISTORY | 120 | int, clamp 2..1000 |
| tokenEnv | — (options only) | ["ZAI_TOKEN","Z_AI_TOKEN"] | string[] |
| authKeys | — (options only) | ["zai-coding-plan","zai"] | string[] |

All env numbers parsed with `Number.isFinite` gate (NaN never reaches
`setInterval`). Token: `auth.json` keys in `authKeys` order → env names in
`tokenEnv` order → undefined (`no-token` error state; never logged).

Options delivery: `opencode.json` → `"plugin": [["./.opencode/plugins/zai-quota.ts", { ...options }]]`
(tuple form); plain string form loads with defaults; env always available.

## D7 — Rendering

- **Panel** (`sidebar_content`, order 100): header `ZAI RUNWAY` (accent, bold) +
  plan level + updated-time or `stale`; per row: `5h ▕████████░░░▏ 62% · 312/500`
  (partial-block glyphs for sub-cell precision) + second line `resets in 1h 12m ·
  runway ~2h 05m !` (runway line only when `showRunway` and state ≠ no-data).
- **Chip** (`session_prompt_right`): segment ARRAY (each segment carries its own
  role → two-color capable, finding 14): `[ zai ] muted [ 62 ] ok [ · ] muted [ 41 ] warn`.
  Rows by label; missing label → `?`. Error → ` zai:? ` muted/error.
- Command: `/zai-quota` (alias `/zq`) via `keymap.registerLayer` —
  `{ name: "zai-quota.refresh", title: "Z.AI quota: refresh now", desc,
  slashName: "zai-quota", slashAliases: ["zq"], namespace: "palette", run }`
  → forced refresh + toast with one-line summary or error.

## D8 — Testing strategy

- bun:test, co-located `*.test.ts`; every pure module: typical case + boundaries
  (0 %, 100 %, >100 %, NaN, null limit, null resetAt, missing/empty token,
  malformed auth.json, empty limits, unknown unit, resetAt-in-past, MAX_SAFE_INTEGER
  values, empty strings, unicode labels) + concurrency (dedupe under parallel
  scheduleRefresh; dispose leaves no timers — fake timers).
- `tui.tsx` covered by a wiring smoke test with a fake `api` capturing slots,
  keymap, events; slot render fns called directly, assert no-throw + role usage.
- `tsc --noEmit` clean = type gate; `grep` gates from CONSTRAINTS.md.

## Risks / trade-offs

| Risk | Position |
|------|----------|
| 5 h window semantics (fixed vs rolling) unverified live | Boundary detector uses resetAt only as primary signal; negative deltas clamped — safe under both; documented in D4 |
| Z.AI payload shape change | typeof-guarded parse + generic scan fallback → degraded "no data" instead of crash |
| `@opentui/*` resolution inside host | Proven pattern (inspiration ships the same imports); repo devDeps mirror it for tests |
| Burn-rate linearity assumption | Span-based (first→last) rate is a first-order projection; runway is advisory, labeled with `~` |
