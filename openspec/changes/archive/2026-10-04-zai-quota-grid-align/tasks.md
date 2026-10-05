# Tasks: zai-quota-grid-align

One wave: tasks 1-2 (independent files) → task 3 wiring+docs → tester →
reviewer → commits → archive.

## Task 1: model display clamps + freshness tiers

`src/model.ts` + tests.

- [x] Freshness tiers: <10s `just now` · <60s `Ns ago` · <60m `Nm ago` ·
      <99h `Nh ago` · else `Xd ago` (floor days); max 8 chars pinned
      (`99h ago`, `2d ago`); boundaries 9_999/10_000, 59_999/60_000,
      3_599_999/3_600_000, 356_399_999/356_400_000 (99h).
- [x] percentText: `Math.min(Math.round(percent), 999)`; negative → `0%`;
      null → `?`; migrate pinned tests (`-5%` → `0%`; `125%` stays).
- [x] Chip values use the same clamp.

## Task 2: render grid + boundary contract

`src/render.ts` + tests.

- [x] GRID consts; renderWindowLine: label slice(0,3) padEnd(3), bar@4,
      pct padStart(4)@21-24, usage padStart(9)@26-34 (pair > 9 → dropped),
      verdict padStart(2)@36-37.
- [x] renderHeader(header, mode, targetWidth=38): suffix right-aligned ends
      37; ladder drop-level → drop-`stale · `-prefix; `updating ...` slot.
- [x] renderDetailLine auto-fit: parts reset · runway · [shortfall] ·
      [back]; ladder back → shortfall → reset; floor runway-only.
- [x] ERROR_TEXT compact (all <= 36 chars; `no token (zai login or
      ZAI_TOKEN)`).
- [x] Column invariants + width property (worst-case matrix) tests; golden
      grid mock (matches design.md canonical block).

## Task 3: wiring + docs

- [x] `src/tui.tsx`: padding 0/0; order 50; W=38 targetWidth passthrough.
- [x] tui tests: order/padding wiring; migrated slot goldens.
- [x] README: regenerate mock from code; boundary contract table row update.

PROOF placeholders per task: `bun test <file>` exit 0; wave checkpoint full
suite + tsc + gates.

<!-- delegation log -->
<!-- 19:02 → coder tasks 1+2 parallel — OK 355 pass; boundary fix 98h; short-detail 26ch -->
<!-- 19:24 → coder task 3 (wiring + README) — OK 356 pass, mock byte-identical -->
<!-- 19:41 → tester wave — 367 pass; ladder rungs pinned; inner-box padding mutant killed -->
<!-- 19:58 → reviewer wave (boundaries+security) -->

## Proof log

- PROOF: `bun test` → exit 0, 370 pass / 0 fail; `tsc --noEmit` exit 0.
  Boundary math proven exhaustively by reviewer (sweeps over modes ×
  verdicts × pct × pair lengths × labels × markers: 0 column violations);
  canonical mock byte-identical model→render→README. Tester: ladder rungs
  pinned exactly, inner-box padding mutant killed, day-cap analyzed.
  Reviewer approve-with-notes → applied: wide-char fold in sanitize
  (display-width policy for server label/level), header suffix hard-floor
  truncation, days tier capped "999d+" (pins migrated deliberately);
  gaugeWidth>16 degradation rung left as documented tradeoff.
