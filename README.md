# opencode-zai-quota

[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
[![Tests](https://github.com/dsaveliev/opencode-zai-quota/actions/workflows/ci.yml/badge.svg)](https://github.com/dsaveliev/opencode-zai-quota/actions/workflows/ci.yml)
[![Bun](https://img.shields.io/badge/runtime-bun-F9F1CC.svg?logo=bun)](https://bun.sh)
[![opencode plugin](https://img.shields.io/badge/opencode-plugin-8A2BE2.svg)](https://opencode.ai/docs/plugins)


OpenCode TUI plugin that shows your Z.AI coding-plan quota — the 5-hour window and the
weekly allowance — as a sidebar panel plus a status-line chip, and derives a **RUNWAY**
projection from your burn rate: at the current pace, will the quota last until the window
resets? Pulled on a timer, theme-native, fully configurable.

This is a redesign of the [josvaal/opencode-zai-quota](https://github.com/josvaal/opencode-zai-quota)
concept, rebuilt on the modern keymap API — no deprecated `api.command`, so no deprecation
warnings at startup (cf. [PR #1](https://github.com/josvaal/opencode-zai-quota/pull/1)
against the original).

## What it looks like

Generated from code — `bun tmp/gen-mock.ts` prints this exact block via
`buildPanel` + `renderPanelLines` (unicode glyphs, `gaugeWidth` 16, the
render layer's own `GRID.width`) from the same inputs as the `model.test.ts`
ok-scenario; the README embed is byte-identical to the script output:

```
Z.ai Runway · plan: Lite       30s ago
5h  █████████▉░░│░░░  62%   312/500  ✓
reset 1h 12m   runway ~2h 5m
7d  ██████▌░│░░░░░░░  41%  4.1M/10M  ✓
reset 3d 4h    runway ~10d
```

Every line targets one fixed 38-column grid (`GRID` in `src/render.ts`):

| Field | Columns | Align |
| --- | --- | --- |
| window label | 0-2 | left |
| gauge bar | 4-19 | — |
| percent | 21-24 | right |
| usage/limit | 26-34 | right |
| verdict glyph | 36-37 | right |
| detail line | 0 | left |
| header suffix (`level · age`) | ends at 37 | right |

The panel registers as the FIRST sidebar section (slot `sidebar_content`,
order 50 — above Context) and renders its box without padding, so the grid
sits flush with the native Context/MCP/LSP sections.

Status chip in the prompt line (same scenario): ` zai 62%·41% ✓`

When a window is running short, the verdict glyph flips to `!!` and the
detail line annotates the projected shortfall (`bun tmp/gen-mock.ts short`;
under width pressure the ladder drops fields in order back → shortfall →
reset):

```
5h  ████████████│██▍  96%   480/500 !!
reset 57m · runway ~5s  (56m short)
```

- Sidebar panel (slot `sidebar_content`): block gauges with partial-cell fill,
  usage/limit counters, reset countdown, and a runway line per row.
- Status chip (slot `session_prompt_right`): ` zai <5h>%·<wk>% <glyph>`, the
  glyph colored by the worst verdict across windows.

## Features

**Status verdicts.** Each window gets one of five verdicts; the glyph and the
bar/percent coloring follow it, not raw percentages:

| Glyph | Verdict | Meaning |
| --- | --- | --- |
| `✓` | ok | runway comfortably outlasts the reset |
| `!` | tight | runway lands within `tightFactor` × the reset distance |
| `!!` | short | at the current pace the quota runs dry before the reset |
| `✗` | blocked | usage is at (or over) the limit |
| `?` | unknown | stale sample, or not enough runway data yet |

**Pace marker.** The `│` pipe inside each gauge marks NOW within the window —
elapsed time since the window start, projected onto the bar. Fill left of the
marker is quota consumed so far; the distance from marker to the right edge is
how much window is left.

**Click-to-refresh.** Clicking the panel (mouseup; a drag/selection never
counts — the drag flag is consumed by the mouseup that saw it) forces a
refresh, with a 1 s cooldown between click-forced refreshes. Timer, session
and command triggers bypass the cooldown, and a click is never cooled down
while data is missing.

**Freshness header.** The panel header shows data age (`30s ago`); data older
than two refresh intervals is flagged `stale` and warning-colored. In an error
state the freshness tracks the last refresh *attempt* instead, so a live but
failing endpoint is not flagged while refreshes keep landing.

**ASCII mode.** `glyphs: "ascii"` renders 7-bit-only surfaces: `#`/`-` fill
(no partial blocks), `|` marker, and ascii substitutions for `·`, `∞`, `…`, `—`.

**State matrix.** What each state shows (short text form):

| State | Panel | Chip |
| --- | --- | --- |
| ok | gauges + `✓` | ` zai 62%·41% ✓` |
| tight | gauges + `!` | ` zai 62%·41% !` |
| short | `!!` + `(37m short)` note | ` zai 62%·41% !!` |
| blocked | `✗` + `back <local time>` | ` zai 62%·41% ✗` |
| unknown | muted gauges + `?` | ` zai 62%·41% ?` |
| error | error text replaces gauges | ` zai:? ` |
| loading | `loading…` | ` zai …` |

## Install

> **Module contract** (OpenCode ≥ 1.18): the runtime entry detector reads
> `mod.default` — the entrypoint must `export default { id, tui }` (as
> `src/index.ts` does). Named exports are NOT detected.

### a) From a local copy — global, every project (TUI config)

Register in `~/.config/opencode/tui.json` with a `file://` URL:

```json
{ "plugin": ["file:///absolute/path/to/opencode-zai-quota/src/index.ts"] }
```

### b) From a local copy — per-project (opencode.json)

```json
{ "plugin": ["./path/to/opencode-zai-quota/src/index.ts"] }
```

Run `bun install` in the repo so `solid-js` / `@opentui` resolve for the test
suite; the OpenCode host provides them at runtime.

### c) With options

```json
{
  "plugin": [
    ["file:///abs/path/to/opencode-zai-quota/src/index.ts", { "intervalMs": 300000, "gaugeWidth": 16 }]
  ]
}
```

> **npm name collision**: `opencode-zai-quota` on npm is the upstream
> inspiration (josvaal/opencode-zai-quota), not this plugin. This plugin is not
> published to npm — install from source as shown above; `bun add
> opencode-zai-quota` would fetch the ORIGINAL plugin.

## Configuration

Precedence: defaults < environment variables < options tuple. Invalid values never
crash the plugin — the key falls back and one warning toast lists everything rejected
or clamped.

| Key | Env var | Default | Validation |
| --- | --- | --- | --- |
| `intervalMs` | `ZAI_QUOTA_INTERVAL_MS` | `60000` | number, clamped to 10000–2147483647 |
| `endpoint` | `ZAI_QUOTA_ENDPOINT` | `https://api.z.ai/api/monitor/usage/quota/limit` | non-empty string; non-https triggers a warning toast |
| `timeoutMs` | `ZAI_QUOTA_TIMEOUT_MS` | `8000` | number, clamped to 1000–60000 |
| `gaugeWidth` | `ZAI_QUOTA_GAUGE_WIDTH` | `16` | number, floored to int, clamped to 4–40 |
| `panel` | `ZAI_QUOTA_PANEL` | `true` | env `1`/`true`/`yes` (off: `0`/`false`/`no`); option must be a boolean |
| `chip` | `ZAI_QUOTA_CHIP` | `true` | same boolean rules |
| `maxHistory` | `ZAI_QUOTA_MAX_HISTORY` | `120` | number, floored to int, clamped to 2–1000 |
| `tightFactor` | `ZAI_QUOTA_TIGHT_FACTOR` | `1.5` | number, must be finite and >= 1; violated → default + warning |
| `glyphs` | `ZAI_QUOTA_GLYPHS` | `unicode` | exact `unicode`/`ascii` (case-insensitive); anything else → default + warning |
| `detail` | `ZAI_QUOTA_DETAIL` | `always` | exact `always`/`auto` (case-insensitive); anything else → default + warning |
| `tokenEnv` | — options only | `["ZAI_TOKEN", "Z_AI_TOKEN"]` | non-empty string array (min 1 item) |
| `authKeys` | — options only | `["zai-coding-plan", "zai"]` | non-empty string array (min 1 item) |

When both `panel` and `chip` are disabled the plugin keeps polling so the `/zai-quota` command toast stays live.

## Token & privacy

The token is resolved at runtime on every refresh, first hit wins:

1. `~/.local/share/opencode/auth.json` — entry `zai-coding-plan`, then `zai` (its `key` field)
2. env `ZAI_TOKEN`
3. env `Z_AI_TOKEN`

The order is configurable: `authKeys` controls the auth.json entries, `tokenEnv` the
env-var names.

- The token is sent only to the configured `endpoint`, in the `Authorization: Bearer`
  header (default `https://api.z.ai`).
- It is never logged and never included in error messages or toasts.
- A non-https `endpoint` emits a warning toast: the token would travel over an insecure
  connection.

## Refresh behavior

| Trigger | Behavior |
| --- | --- |
| startup | immediate forced fetch |
| timer | every `intervalMs` (default 60 s) |
| `session.idle` | throttled — skipped if the last fetch started less than `intervalMs / 2` ago |
| `session.error` | forced refresh |
| `/zai-quota` or `/zq` | forced refresh + toast summary (`label: usage/limit` per row, or the error); also in the command palette (ctrl+p) as "Z.AI quota: refresh now" |

Overlapping triggers are deduplicated: while a request is in flight, later triggers join
that request — one fetch, not a storm.

## Runway

Runway is a burn-rate projection. The plugin keeps a per-row usage history (capped at
`maxHistory` samples), derives how fast `usage` grows, and projects the time until
`usage` reaches `limit` — compared against the time until the window resets.

| Shown | State | Meaning |
| --- | --- | --- |
| `runway ∞` | no burn | usage is not growing across observed samples |
| `runway …` | no data | fewer than 2 samples, or under 1 s of history |
| `runway —` | no limit | the row carries no limit to project against |
| *(line hidden)* | no reset | no reset timestamp known for the row |
| `runway ~2h 5m` | ok | projected exhaustion lands after the reset |
| `runway ~35m !!  (37m short)` | short | at the current pace the quota runs out before the reset |

History restarts on a window boundary: a changed `resetAt` or a decreasing `usage`
(new window, counter rolled over) resets that row's samples.

## Development

```bash
bun install          # deps for tests; the host provides them at runtime
bun test             # 356 tests
bunx tsc --noEmit    # type check
```

Module map:

- `src/config.ts` — config type, defaults, env/options resolver with clamps and warnings
- `src/token.ts` — token precedence: auth.json keys, then env names
- `src/api.ts` — quota fetch (bearer auth, abort-timeout, error codes) and tolerant parsing
- `src/runway.ts` — per-row usage sampling and burn-rate projection
- `src/render.ts` — pure render model: block gauges, chip segments, panel view model
- `src/roles.ts` — semantic color roles mapped to theme tokens
- `src/format.ts` — duration and counter formatting
- `src/tui.tsx` — wiring edge: config, timer and session events, slots, keymap layer, JSX
- `src/index.ts` — entrypoint: default-exports the TUI plugin module `{ id, tui }`

## Error states

| Code | Panel text | Cause |
| --- | --- | --- |
| `no-token` | `no token (login via zai or set ZAI_TOKEN)` | nothing found via auth.json or env |
| `network` | `network error` | request failed to connect |
| `http-N` | `HTTP N` | endpoint returned status >= 400 |
| `bad-json` | `bad response` | body is not valid JSON |
| `timeout` | `timeout` | no response within `timeoutMs` |
| `empty` | `no data` | response parsed but yielded no rows |

While an error is active the chip collapses to a single muted ` zai:?` segment and the
panel shows the error text in place of the gauges; the next successful refresh clears it.

## License

MIT
