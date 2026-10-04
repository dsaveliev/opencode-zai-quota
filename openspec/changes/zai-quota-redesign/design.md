# Design: zai-quota-redesign

## Context

Spec v1.1 negotiated with the user after two external design reviews
(Claude + ChatGPT analyses) and one user review pass that closed all
"before W1" findings. Decisions #19-#24 in DECISIONS.md record the
negotiated rationale. Golden strings are generated from code, never
hand-drawn (v1 spec examples drifted from their own formula — lesson
recorded).

## Verified API facts (new, from this round)

- `@opentui/core/Renderable.d.ts:74-81`: `onMouseDown/onMouseUp/onMouseDrag`
  exist on all renderables — click wiring is feasible; drag-guard via
  onMouseDrag flag.
- User theme `solarized-light.json`: background=base3 `#fdf6e3`, semantic
  tokens correctly dark (text=base00, success=green, warning=orange,
  error=red) — the white-percent bug was renderer-default fg, not the theme.
- `TuiThemeCurrent` guarantees the 5 universal tokens used by the new palette.

## Module layout (waves)

```
W1 (pure core, no render changes except format-migration):
  src/format.ts      MODIFIED  exact/approx duration rules, backAt
  src/status.ts      NEW       classification + severity + worst-of-windows
  src/marker.ts      NEW       windowMs map by API unit, elapsed, clamped index
  src/model.ts       NEW       V2 view-model (header/windows/chip) + state
                              matrix resolution; consumes format+status+marker;
                              emits texts + verdicts + indices, NO glyphs
  *.test.ts          golden model tests generated from code

W2 (render):
  src/render.ts      REWRITE   consumes model; unicode/ascii glyph sets;
                              fg roles for every segment; width-40
                              degradation ladder; chip strings
  contrast fixtures + fg-invariant render-tree test

W3 (wiring):
  src/tui.tsx        MODIFIED  no border, title text+bold, click
                              (mouseup-no-drag, cooldown 1s, updating
                              indicator, freshness-on-success), 10s tick
                              signal, panel always clickable incl. error
  src/config.ts      MODIFIED  +tightFactor (>=1 finite), glyphs
                              (unicode|ascii), detail (always|auto,
                              default always); gaugeWidth default 16
  src/api.ts         ADDITIVE  QuotaRow.unit?: number
  src/runway.ts      ADDITIVE  RunwayResult.spanMs: number | null
```

## D1 — Status rule (precedence, guards)

```
blocked = usage >= limit                    (independent of runway)
stale   -> unknown
spanMs != null && spanMs < 60_000 -> unknown   (young-window anti-noise)
runway state no-burn -> ok (display "runway ∞")
runway state no-data / no-limit / no-reset -> unknown
short   = runwayMs <  resetInMs
tight   = resetInMs <= runwayMs < resetInMs * tightFactor
ok      = runwayMs >= resetInMs * tightFactor
Severity (chip worst-of-windows): blocked > short > tight > ok; unknown
participates only when all windows unknown.
Stale invalidates the verdict, never the cached displayed values.
```

## D2 — Pace marker

```
WINDOW_MS: unit 3 -> 300 min, unit 6 -> 10_080 min; else no marker
elapsedMs = now - (resetAt - windowMs)
markerIndex = clamp(floor(elapsedMs / windowMs * gaugeWidth), 0, gaugeWidth-1)
```
Semantics (verbatim in spec): marker shows the elapsed-time position within
the quota window, never the usage position. Glyph distinct from fill/empty;
color `text` (neutral reference line; `warning` would collide with
tight-fill and read as alert in ok rows). Tests: usage < pace, ==, >,
tight-marker-on-fill.

## D3 — Time formats

```
exact:   <60m "42m" | <48h "1h 12m" | >=48h "3d 4h"   (floor parts, omit 0)
approx:  <48h "~2h 5m" | >=48h "~10d"                  (N = round(hours/24))
backAt:  reset <24h "back at 15:20" (local, 24h) | else "back in 3d 4h"
shortfall suffix: "(1h 35m short)" = resetIn - runway
```

## D4 — Click contract

mouseup without preceding drag on the panel; force bypasses idle-throttle
only — in-flight dedupe joins the pending promise, force starts have a 1s
cooldown; response = "updating" indicator in header while in-flight,
freshness updates only on success; panel clickable in every state including
error; chip never clickable.

## D5 — State matrix (source of truth for goldens)

| state | condition | panel | chip |
|---|---|---|---|
| loading | rows empty, no verdict | header + "loading…" | ` zai …` |
| ok/tight/short/blocked | per-window verdict | V2 rows + glyphs | ` zai 62·41 <worst>` |
| stale | rows cached, age>2×interval or attempts failing | header `stale · Xm`, verdicts `?`, rows kept | ` zai 62·41 ?` |
| error | no rows + fetch error | header `· error` + taxonomy line | ` zai:?` |
| no-burn | burn <= 0 | `runway ∞` + ok | worst-of |
| no-data | <2 samples or span<60s | `runway …` + ? | worst-of |

Short line shows scale: `runway ~35m  !!  (1h 35m short)`.
Blocked: `500 / 500 · reset 42m` + `limit reached · back at 15:20  ✗`.

## D6 — Geometry, degradation, glyphs

Target width 40 columns. Degradation ladder: drop ` · back at/in …` first,
then reset segment; verdict glyphs never dropped. Longest golden line
(`runway ~35m  !!  (1h 35m short)` = 37) must fit. Unicode: `█ ▏…▉ ░ │ ✓ ! ✗
? ∞`; ASCII mode: `# - | ok ! !! xx ? inf`.

## D7 — Contrast

Invariant: every `<text>` explicit fg from {text, textMuted, success,
warning, error}; renderer never relies on default fg. Render-tree test
(red-on-current-bug anchor) + fixture WCAG>=3 test (solarized-light + dark
fixture pairs; documented limitation: fixtures, not all themes). Manual TUI
check on both themes remains in the W3 checklist.

## Risks / trade-offs

| Risk | Position |
|---|---|
| Breaking format change ripples into v1 goldens | Affected assertions migrated deliberately in W1/W2, diffs reviewed by eye |
| unit field absent in payloads | typeof-guarded additive optional; marker silently absent (documented) |
| 10s freshness tick re-renders | Header-only signal; frozen fill/runway by design (marker advances, cached estimate does not) |
| Unknown-verdict ambiguity (? = stale vs no-data) | Documented: ? means "verdict not currently valid"; header distinguishes the reason |
