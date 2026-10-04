# zai-quota Specification

## Purpose

Displays the Z.AI coding-plan quota (5-hour window and weekly allowance) inside
OpenCode with timer-based pull, derived runway projection, theme-native
rendering, and layered configuration.

## Requirements

### Requirement: Quota pull

The system SHALL fetch the Z.AI coding-plan quota (5-hour window and weekly
plan allowance) from the configured monitoring endpoint on a timer, on
session-idle (throttled), on session-error (forced), and on explicit user
command, using a bearer token resolved from opencode credentials or environment.

#### Scenario: timer pull

- **WHEN** the plugin is loaded and a token resolves
- **THEN** a fetch is scheduled immediately and repeated every `intervalMs`
  (clamped to at least 10 s), with in-flight dedupe so overlapping triggers
  produce exactly one request

#### Scenario: missing token

- **WHEN** no token resolves from auth.json or configured environment variables
- **THEN** the plugin enters the `no-token` error state, renders `zai:?` in the
  chip, and never throws or logs the token value

### Requirement: Runway projection

The system SHALL derive, per limit, a burn-rate-based runway (projected
time-to-quota-exhaustion from in-window usage samples) and distinguish the
states no-limit, no-reset, no-data, no-burn, ok, and warn, where warn means
projected exhaustion before the window reset time.

#### Scenario: projected exhaustion before reset

- **WHEN** two or more samples exist in the current 5-hour window, the derived
  burn rate is positive, and runway is shorter than time-to-reset
- **THEN** the row is marked warn and the panel shows the runway estimate

#### Scenario: window boundary

- **WHEN** the reset timestamp changes between samples or in-window usage
  decreases
- **THEN** the sample history resets so burn rate is never computed across
  windows

### Requirement: Theme-native rendering

The system SHALL render a borderless sidebar panel (per-limit gauges with
reset countdowns, runway lines and status verdicts) and a prompt chip, where
every rendered text element carries an explicit foreground color drawn from
the five universal semantic theme tokens (`text`, `textMuted`, `success`,
`warning`, `error`) — the renderer SHALL NOT rely on terminal or theme
default foreground for any text. Status SHALL be readable without color via
distinct glyphs, and an ASCII glyph fallback mode SHALL preserve the same
semantics.

#### Scenario: theme purity

- **WHEN** any rendered element picks a color
- **THEN** the value comes from `api.theme.current` via the single role-mapping
  module, and every text element carries an explicit fg — no text relies on
  the terminal or theme default foreground (verified by a render-tree test)

#### Scenario: readable on light themes

- **WHEN** the active theme has a light background (e.g. solarized-light)
- **THEN** all text remains visible because every element uses its theme's
  semantic foreground, never the renderer default

### Requirement: Configuration

The system SHALL accept configuration at three layers (built-in defaults,
`ZAI_QUOTA_*` environment variables, plugin options object), where later
layers override earlier ones and any invalid value falls back to that key's
default with a recorded warning instead of throwing. Keys SHALL include
`tightFactor` (finite, >= 1, default 1.5), `glyphs` ("unicode" | "ascii",
default "unicode"), `detail` ("always" | "auto", default "always"), and
`gaugeWidth` (int clamp 4..40, default 16), in addition to the v1 keys.

#### Scenario: invalid override

- **WHEN** `ZAI_QUOTA_INTERVAL_MS=abc` is set
- **THEN** the default 60000 ms is used and a warning is recorded

#### Scenario: tight factor validation

- **WHEN** `tightFactor` is 0.5 or NaN at any layer
- **THEN** the default 1.5 is used and a warning is recorded

### Requirement: Status verdict

The system SHALL classify each quota window into exactly one verdict with
precedence `blocked > short > tight > ok`: blocked when usage >= limit
(independent of runway); short when runway < reset; tight when
reset <= runway < reset × tightFactor; ok otherwise. A young-window guard
(sample span < 60 s) and stale data SHALL degrade the verdict to unknown
(`?`) while retaining cached displayed values; no-burn SHALL classify as ok
with infinite runway. The chip SHALL show the worst verdict across windows.

#### Scenario: exhaustion before reset

- **WHEN** runway is 35m and reset is 1h 10m
- **THEN** the verdict is `!!` (short) and the row shows the shortfall

#### Scenario: blocked independent of runway

- **WHEN** usage >= limit and the sample span is under 60 s
- **THEN** the verdict is `✗` (blocked)

#### Scenario: stale invalidates verdict only

- **WHEN** cached rows exist but data is stale
- **THEN** verdicts render as `?` while the cached gauge, usage and runway
  texts remain displayed

### Requirement: Pace marker

The system SHALL draw an elapsed-time marker on each gauge at
`clamp(floor(elapsed / windowDuration × gaugeWidth), 0, gaugeWidth - 1)`,
where windowDuration derives from the structural API unit field (unit 3 →
5h, unit 6 → 7d) and never from display labels; the marker SHALL be absent
when the unit is unknown. The marker represents the elapsed-time position,
not the usage position, and SHALL use a glyph distinct from fill and empty
glyphs with supplemental (non-semantic) color.

#### Scenario: burning faster than time

- **WHEN** usage fill extends to the right of the marker
- **THEN** the user can see consumption outpacing elapsed time without
  reading any numbers

#### Scenario: unknown window duration

- **WHEN** a row carries no recognized unit
- **THEN** no marker is drawn and no error is raised

### Requirement: Interactive refresh

The system SHALL refresh quota on click anywhere in the panel (including the
error state) via mouseup without a preceding drag; a forced click refresh
SHALL bypass the idle throttle but respect in-flight deduplication and a
1-second click-force cooldown; the panel SHALL show an updating indicator
while a refresh is in flight, and the header SHALL NOT show a misleading
fresh timestamp: during failures it ages from the last attempt and marks
staleness after 2× the refresh interval, while healthy data ages from the
last successful refresh. The chip SHALL NOT be clickable.

#### Scenario: click during in-flight refresh

- **WHEN** the user clicks while a refresh is already in flight
- **THEN** no second request is started and the pending result is awaited

#### Scenario: text selection does not refresh

- **WHEN** the user drags across panel text and releases
- **THEN** no refresh is triggered

### Requirement: Modern TUI API only

The system SHALL register its command via `api.keymap.registerLayer` and slots
via `api.slots.register`, using no deprecated `api.command.*` APIs, and SHALL
dispose all timers, event subscriptions, and the keymap layer on plugin dispose.

#### Scenario: clean load and dispose

- **WHEN** the plugin loads in opencode ≥ 1.18
- **THEN** no deprecation warning is emitted; on dispose no timer or handler
  survives
