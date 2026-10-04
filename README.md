# opencode-zai-quota

OpenCode TUI plugin that shows your Z.AI coding-plan quota — the 5-hour window and the
weekly allowance — as a sidebar panel plus a status-line chip, and derives a **RUNWAY**
projection from your burn rate: at the current pace, will the quota last until the window
resets? Pulled on a timer, theme-native, fully configurable.

This is a redesign of the [josvaal/opencode-zai-quota](https://github.com/josvaal/opencode-zai-quota)
concept, rebuilt on the modern keymap API — no deprecated `api.command`, so no deprecation
warnings at startup (cf. [PR #1](https://github.com/josvaal/opencode-zai-quota/pull/1)
against the original).

## What it looks like

```
+--------------------------------------------------+
| ZAI RUNWAY                            Pro 14:32  |
|                                                  |
| 5h   ███████▌░░░░ 62% 312/500                   |
|      reset 1h 12m · runway ~2h 5m !              |
|                                                  |
| wk   ████▉░░░░░░░ 41% 820/2k                     |
|      reset 76h · runway ~214h                    |
+--------------------------------------------------+

  > prompt                            zai 62·41
```

- Sidebar panel (slot `sidebar_content`): block gauges with partial-cell fill,
  usage/limit counters, reset countdown, and a runway line per row. The header
  marks data older than two refresh intervals as `stale`; in an error state the
  marker tracks the last refresh *attempt* instead, so a live but failing
  endpoint is not flagged while refreshes keep landing.
- Status chip (slot `session_prompt_right`): ` zai <5h>%·<wk>%`, each percent
  colored by the warn/crit thresholds.

## Install

### a) As a package

```bash
bun add opencode-zai-quota   # or: npm install opencode-zai-quota
```

```json
{ "plugin": ["opencode-zai-quota"] }
```

Install in the plugin dir or globally as a package — the OpenCode host resolves it.

### b) From a local copy

Copy or symlink this repo, then point `plugin` at the shim file:

```json
{ "plugin": ["./path/to/opencode-zai-quota/.opencode/plugins/zai-quota.ts"] }
```

The shim `.opencode/plugins/zai-quota.ts` just re-exports the source entrypoint:
`export { id, tui } from "../../src/index"`. Run `bun install` in the repo so
`solid-js` / `@opentui` resolve for the test suite; the OpenCode host provides them
at runtime.

### c) With options

```json
{
  "plugin": [["./.opencode/plugins/zai-quota.ts", { "intervalMs": 300000, "gaugeWidth": 16 }]]
}
```

## Configuration

Precedence: defaults < environment variables < options tuple. Invalid values never
crash the plugin — the key falls back and one warning toast lists everything rejected
or clamped.

| Key | Env var | Default | Validation |
| --- | --- | --- | --- |
| `intervalMs` | `ZAI_QUOTA_INTERVAL_MS` | `60000` | number, clamped to 10000–2147483647 |
| `endpoint` | `ZAI_QUOTA_ENDPOINT` | `https://api.z.ai/api/monitor/usage/quota/limit` | non-empty string; non-https triggers a warning toast |
| `timeoutMs` | `ZAI_QUOTA_TIMEOUT_MS` | `8000` | number, clamped to 1000–60000 |
| `gaugeWidth` | `ZAI_QUOTA_GAUGE_WIDTH` | `12` | number, floored to int, clamped to 4–40 |
| `warnThreshold` | `ZAI_QUOTA_WARN` | `0.7` | pair rule `0 < warn < crit <= 1`; violated → both revert to defaults |
| `critThreshold` | `ZAI_QUOTA_CRIT` | `0.9` | same pair rule as `warnThreshold` |
| `panel` | `ZAI_QUOTA_PANEL` | `true` | env `1`/`true`/`yes` (off: `0`/`false`/`no`); option must be a boolean |
| `chip` | `ZAI_QUOTA_CHIP` | `true` | same boolean rules |
| `showRunway` | `ZAI_QUOTA_RUNWAY` | `true` | same boolean rules |
| `maxHistory` | `ZAI_QUOTA_MAX_HISTORY` | `120` | number, floored to int, clamped to 2–1000 |
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
| `runway ~2h 5m !` | warn | at the current pace the quota runs out before the reset |

History restarts on a window boundary: a changed `resetAt` or a decreasing `usage`
(new window, counter rolled over) resets that row's samples.

## Development

```bash
bun install          # deps for tests; the host provides them at runtime
bun test             # 200 tests
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
- `src/index.ts` — entrypoint: exports plugin `id` and `tui`

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
