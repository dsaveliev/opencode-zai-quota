# Design: zai-quota-grid-align

## Context

User-driven visual polish round. Alignment facts verified in opencode source
(packages/tui/src/feature-plugins/sidebar/{context,mcp,lsp}.tsx): native
sections render root `<box>` with NO padding; titles `<b>` + fg=text; item
rows `gap={1}`. Slot orders: Context=100, MCP=200, LSP=300.

## GRID (canonical)

```
01234567890123456789012345678901234567
ZAI RUNWAY              Lite · 30s ago
5h  █████████▉░░│░░░  62%   312/500  ✓
reset 1h 12m · runway ~2h 5m
```

| cols | element | rule |
|---|---|---|
| 0-2 | label | `slice(0,3)` padEnd(3); empty-after-sanitize → parser fallback `quo` |
| 3 | gap | |
| 4-19 | bar 16 | existing barCells invariant |
| 20 | gap | |
| 21-24 | percent | padStart(4); display clamp 0..999; `?` |
| 25 | gap | |
| 26-34 | usage pair | padStart(9); pair > 9 chars → dropped (rung) |
| 35 | gap | |
| 36-37 | verdict | padStart(2): ` ✓` ` !` `!!` ` ✗` ` ?` / ascii `ok ! !! xx ?` |
| 0 | detail | flush with title |

Header: title @0 (bold, fg text); suffix `level · freshness` right-aligned,
ends col 37; ladder: suffix-budget = 38-10-1 = 27 → if over: drop level; if
still over: drop `stale · ` prefix; never drop title/age. `updating ...`
right-flush in the same slot.

## Boundary contract (all elements)

- freshness tiers (model): <10s `just now` · <60s `Ns ago` · <60m `Nm ago` ·
  <99h `Nh ago` · else `Xd ago` — max 8 chars.
- percentText (model): `Math.min(Math.round(pct), 999)`, negative → 0 → `0%`.
- usage pair (render): `fmtCount(usage)+"/"+fmtCount(limit)`; > 9 → omit.
- detail (render): parts reset · runway · [shortfall] · [back]; ladder drops
  back → shortfall → reset; floor `runway ~N` (<= 15).
- error taxonomy (render ERROR_TEXT): each message <= 36 chars: `no token
  (zai login or ZAI_TOKEN)` / `network error` / `bad response` / `timeout` /
  `no data` / `HTTP N`.
- label display slice(0,3) in render only (model keeps full sanitized label;
  runways lookup stays keyed on it).

## Files

- src/model.ts: freshness tiers; percent clamp (+tests migrate `-5%`→`0%`).
- src/render.ts: GRID consts; renderWindowLine (label slice, pads, 2-slot
  verdict, usage-9 drop); renderHeader (suffix right-align + ladder +
  targetWidth param); renderDetailLine auto-fit ladder to 38; ERROR_TEXT
  compact; renderPanelLines passes W.
- src/tui.tsx: padding 0/0; order 50.
- README: regenerate mock from code (grid version).

## Testing

- Column invariants (label@0, bar@4, pct end@24, usage end@34, verdict
  end@37, detail@0, header suffix end@37) across state matrix × modes.
- Width property: worst-case inputs → every line <= 38.
- Header ladder rungs; detail ladder rungs; freshness tier boundaries
  (9_999/10_000, 59_999/60_000, 59m59s/60m, 99h/100h); percent clamp
  (999, 1000, -5); usage 9/10 chars; errorText lengths; label slice.
- Wiring: order=50 captured; padding 0 (box props).

## Risks

| Risk | Position |
|---|---|
| Golden churn (grid shift) | deliberate, diffs reviewed by eye |
| Header ladder vs long level | pinned by tests at exact rungs |
| ascii verdict 2ch (`ok`) | same 2-slot, right-aligned |
