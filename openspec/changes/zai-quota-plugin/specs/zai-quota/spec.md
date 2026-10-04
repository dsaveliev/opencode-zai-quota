# Z.AI Quota Display Capability

## ADDED Requirements

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

The system SHALL render a sidebar panel (per-limit gauges with reset countdowns
and runway lines) and a prompt chip, using ONLY color roles mapped to the active
opencode theme — no hardcoded colors anywhere.

#### Scenario: theme purity

- **WHEN** any rendered element picks a color
- **THEN** the value comes from `api.theme.current` via the single role-mapping
  module

### Requirement: Configuration

The system SHALL accept configuration at three layers (built-in defaults,
`ZAI_QUOTA_*` environment variables, plugin options object), where later layers
override earlier ones and any invalid value falls back to that key's default
with a recorded warning instead of throwing.

#### Scenario: invalid override

- **WHEN** `ZAI_QUOTA_INTERVAL_MS=abc` is set
- **THEN** the default 60000 ms is used and a warning is recorded

### Requirement: Modern TUI API only

The system SHALL register its command via `api.keymap.registerLayer` and slots
via `api.slots.register`, using no deprecated `api.command.*` APIs, and SHALL
dispose all timers, event subscriptions, and the keymap layer on plugin dispose.

#### Scenario: clean load and dispose

- **WHEN** the plugin loads in opencode ≥ 1.18
- **THEN** no deprecation warning is emitted; on dispose no timer or handler
  survives
