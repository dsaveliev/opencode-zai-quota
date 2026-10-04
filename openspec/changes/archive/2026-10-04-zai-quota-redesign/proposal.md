# Proposal: zai-quota-redesign

## Why

The v1 panel answers "how much is spent" but leaves the headline question —
"will the quota last until reset?" — to mental arithmetic: the user compares
`reset 1h 12m` vs `runway ~2h 5m` in their head. Review of the v1 design
(two external design analyses + user requirements) additionally found: glued
columns (`62%312/500`), floating percent width, mixed time formats (`76h` vs
`~250h`), ambiguous header clock, a border that costs 2 rows/2 columns, a
real contrast bug on light themes (percent rendered without explicit fg →
default white → invisible on solarized-light), and no interaction beyond a
slash command.

## What Changes

Presentation-layer redesign only; the data layer (config/token/api/runway
mechanics) is untouched except two approved additive fields (`QuotaRow.unit`,
`RunwayResult.spanMs`).

1. **Status verdicts** replace mental comparison: `✓ ok · ! tight · !! short ·
   ✗ blocked · ? unknown`, with precedence `blocked > short > tight > ok`;
   `tight = reset <= runway < reset × tightFactor` (1.5 default).
2. **Pace marker** `│` on the bar: elapsed-time position within the window
   (clamped, unit-derived window duration), fill right of marker = burning
   faster than time passes. Marker glyph semantically distinct; color
   (`text`) supplemental only.
3. **V2 Classic layout**, always-visible details, no border, 16-cell bar,
   labels `5h`/`7d`, title `text`+bold, fixed right-aligned columns, header
   freshness (`30s ago` / `stale · 2m ago`) instead of clock.
4. **Deterministic time formats**: exact `<60m → 42m · <48h → 1h 12m ·
   ≥48h → 3d 4h`; approx (runway) `<48h → ~2h 5m · ≥48h → ~10d`
   (N = round(hours/24)).
5. **Click refresh** on the whole panel: mouseup without drag; force bypasses
   idle-throttle only (in-flight dedupe respected, 1s cooldown); "updating"
   indicator; freshness updates only on success. Chip is not clickable.
6. **Contrast invariant**: every `<text>` gets explicit fg from the 5
   universal semantic tokens (`text, textMuted, success, warning, error`) —
   renderer never relies on default foreground. Closes the white-percent bug
   class on any theme. ASCII glyph fallback mode (`# - | ok ! !! xx ?`).

## Capabilities affected

MODIFIED: Theme-native rendering (explicit-fg invariant + 5-token palette),
Configuration (new keys). ADDED: Status verdict, Pace marker, Interactive
refresh. Unchanged: Quota pull, Runway projection (additive fields only).

## Non-goals

- No changes to quota fetch/parse/burn mechanics (additive fields only).
- No resetAt-delta window-duration learning (label parsing also rejected).
- No chip click, no per-window click targets.
- No numeric contrast guarantee beyond explicit-fg + fixture tests.

## Success Criteria

1. State matrix (loading/ok/tight/short/blocked/stale/error × panel+chip ×
   unicode/ascii) fully covered by golden tests generated FROM code.
2. fg-invariant test over the render tree (red on the current white-percent
   bug, green after); fixture contrast test (WCAG >= 3) on light+dark pairs.
3. Click wiring: exactly one forced refresh, dedupe/cooldown respected.
4. `bun test` green (migrated goldens reviewed by eye, not bulk-updated),
   `tsc --noEmit` clean, CONSTRAINTS.md gates pass.
5. Manual TUI check on light and dark themes (glyph widths included).
