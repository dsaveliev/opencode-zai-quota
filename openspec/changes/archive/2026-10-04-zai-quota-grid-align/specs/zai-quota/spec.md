# Spec Delta

## MODIFIED Requirements

### Requirement: Theme-native rendering

The system SHALL render a borderless sidebar panel aligned with the native
sidebar sections (zero box padding, first section position) on a fixed
38-column grid: label column at 0, gauge at columns 4-19, right-aligned
percent at 21-24, right-aligned usage pair at 26-34, right-aligned verdict
glyph in a two-character slot at 36-37, detail line flush at column 0, and
header suffix (level/freshness) right-aligned ending at column 37. Every
rendered line SHALL stay within the panel width in every state and glyph
mode via explicit boundary rules: freshness capped at 8 characters with
tiered units, percent display clamped to 0..999, over-wide usage pairs
dropped, detail lines degraded by a fixed ladder (recovery time, then
shortfall, then reset) never exceeding the width, and error messages
pre-sized to fit. Every text element SHALL carry an explicit foreground
color from the five universal semantic theme tokens; an ASCII fallback mode
SHALL preserve the same grid and semantics.

#### Scenario: theme purity

- **WHEN** any rendered element picks a color
- **THEN** the value comes from `api.theme.current` via the single role-mapping
  module, and every text element carries an explicit fg — no text relies on
  the terminal or theme default foreground (verified by a render-tree test)

#### Scenario: readable on light themes

- **WHEN** the active theme has a light background (e.g. solarized-light)
- **THEN** all text remains visible because every element uses its theme's
  semantic foreground, never the renderer default

#### Scenario: grid alignment

- **WHEN** the panel renders next to the native Context/MCP/LSP sections
- **THEN** its left edge, section title, and detail lines align with theirs,
  and no element crosses the fixed grid columns in any state

#### Scenario: worst-case values never overflow

- **WHEN** a 24-character plan level, 999% percent, 9-character usage pair,
  two-character verdict, and 8-character freshness render simultaneously
- **THEN** every line remains within the panel width after applying the
  documented degradation ladders
