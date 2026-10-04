# Proposal: zai-quota-plugin

## Why

Users of the Z.AI coding plan (`zai-coding-plan` provider) inside OpenCode have no
visibility into their two quota windows — the rolling 5-hour window and the weekly
(plan-level) allowance — until a request fails. The existing community plugin
(josvaal/opencode-zai-quota) proves the need, but it (a) relies on the deprecated
`api.command.register` TUI API (deprecation warning at every launch, removal
scheduled for OpenCode v2 — see PR #1 against that repo), (b) hardcodes all
parameters (60 s refresh, 26-cell bar, fixed thresholds), and (c) shows static
consumption gauges only.

## What Changes

A new OpenCode TUI plugin, redesigned around a **runway** concept instead of static
gauges:

1. **Pull loop** — quota is fetched from `GET https://api.z.ai/api/monitor/usage/quota/limit`
   on a configurable timer (default 60 s, clamped ≥ 10 s), on `session.idle`, and
   on demand via `/zai-quota` (alias `/zq`). In-flight dedupe guarantees a timer
   tick and an idle event never double-fetch.
2. **Runway projection** — the plugin samples `(time, in-window usage)` and derives
   a burn rate; for the 5-hour window it projects time-to-exhaustion and warns when
   projected exhaustion falls before the window reset. Static percentage gauges
   remain, but the derived "will it last?" answer is the headline.
3. **Native theme rendering** — every color comes from `api.theme.current.*`; smooth
   sub-cell gauges (partial block glyphs); two surfaces: a sidebar panel
   (`sidebar_content` slot) and a compact prompt chip (`session_prompt_right` slot).
4. **Modern API only** — commands registered via `api.keymap.registerLayer`
   (PR #1 migration applied from day one); zero deprecated calls.
5. **Everything configurable** — interval, endpoint, timeout, gauge width, warn/crit
   thresholds, chip/panel enable flags, token env names, auth keys (see design).

## Capabilities affected

- New capability; no existing specs are modified (`skip_specs: true` is expected —
  this change adds a self-contained plugin, no delta to existing capability specs).

## Non-goals

- No push/websocket streaming — pull-only by explicit task requirement.
- No quota data persistence across restarts (in-memory history only).
- No writing to auth.json or any credentials management — read-only token access.
- No support for providers other than Z.AI (`zai-coding-plan`, `zai`).
- No OpenCode v1 legacy API compatibility shims (`api.command.*` is not used).

## Success Criteria

1. `bun test` green: pure modules (config/token/api/runway/render/format) covered —
   typical cases + boundaries (0 %, 100 %, >100 %, NaN, missing/empty token,
   malformed auth.json, empty limits, unknown unit, reset-in-past) + concurrency
   (dedupe, overlapping timer/idle, dispose clears timers).
2. `tsc --noEmit` clean; no `@ts-ignore`/suppressions (CONSTRAINTS.md floor).
3. Plugin loads in OpenCode ≥ 1.18 with **zero deprecation warnings**.
4. All visual output uses only `api.theme.current` colors.
5. README documents install + every configuration parameter with its default.

## Assumptions (headless run — recorded in DECISIONS.md)

- Design sign-off requested by TASK.md is impossible headless; redesign rationale
  is documented here and in design.md for post-hoc human review.
- English chosen for all repo artifacts (open-source convention).
- Target: OpenCode stable TUI plugin API as of 1.18.x with the v2-safe keymap layer.
