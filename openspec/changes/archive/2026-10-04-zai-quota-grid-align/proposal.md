# Proposal: zai-quota-grid-align

## Why

The panel is shifted right relative to the native sidebar sections (Context/
MCP/LSP render with zero padding; ours uses paddingLeft=1 paddingRight=1),
elements float without a fixed grid, and several elements can overflow the
panel width in worst cases (the user caught `ago` spilling past the boundary;
audit confirmed detail lines at 39/41 chars, verdict `!!` breaking a 1-col
slot, unbounded freshness `4320m ago`, percent `1250%`, usage pairs 33 chars).

## What Changes

Visual alignment + fixed grid + boundary contract. No data-layer changes; no
model semantics beyond display-level clamps.

1. **Alignment**: panel box padding 0/0 (matches native sections' `<box>`
   without padding — verified in opencode source feature-plugins/sidebar/*);
   slot order 100 → 50 (first section, resolves tie with Context).
2. **Grid W=38** (cols 0-37): label 0-2 (slice(0,3), padEnd 3) · gap · bar
   4-19 · gap · percent 21-24 (padStart 4, display clamp 0..999) · gap ·
   usage pair 26-34 (padStart 9; pair > 9 chars dropped) · gap · verdict
   36-37 (padStart 2 — two-char slot for `!!`/`ok`/`xx`). Detail line @0,
   flush with header title.
3. **Header**: title @0, suffix `level · freshness` right-aligned ending at
   col 37; degradation ladder drop-level → drop-`stale · `-prefix (title and
   age never dropped). Updating indicator right-flush.
4. **Freshness tiers** (max 8 chars): `just now` · `Ns ago` · `Nm ago` ·
   `Nh ago` (cap `99h ago`) · `Xd ago`.
5. **Detail degradation ladder**: `back at/in` → `(N short)` → `reset …`;
   final floor `runway …` (≤ 15). Detail never exceeds W.
6. **Error taxonomy messages compacted to <= 36 chars** (e.g. `no token (zai
   login or ZAI_TOKEN)`) — no runtime truncation.
7. Percent display clamp 0..999 (pinned `125%` unchanged; `-5%` → `0%` —
   deliberate migration).

## Capabilities affected

MODIFIED: Theme-native rendering (grid + alignment are rendering concerns).
No new requirements; boundary contract folds into it.

## Non-goals

- No changes to fetch/parse/burn logic, statuses, marker math, click/tick.
- No chip layout changes (prompt slot is not 38-bound).

## Success Criteria

1. Line-width property test: every rendered line (all states × both glyph
   modes × worst-case values: level 24ch, pct 999, usage 9ch, verdict 2ch,
   freshness 8ch, every detail ladder rung) is <= 38.
2. Column invariants pinned: label@0, bar@4, pct end@24, usage end@34,
   verdict end@37, detail@0, header suffix end@37.
3. Existing suite green after deliberate migrations (percent clamp, error
   texts, freshness tiers); `tsc` clean; CONSTRAINTS gates pass.
