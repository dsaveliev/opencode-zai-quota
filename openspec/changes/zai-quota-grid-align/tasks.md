# Tasks: zai-quota-grid-align

One wave: tasks 1-2 (independent files) → task 3 wiring+docs → tester →
reviewer → commits → archive.

## Task 1: model display clamps + freshness tiers

`src/model.ts` + tests.

- [ ] Freshness tiers: <10s `just now` · <60s `Ns ago` · <60m `Nm ago` ·
      <99h `Nh ago` · else `Xd ago` (floor days); max 8 chars pinned
      (`99h ago`, `2d ago`); boundaries 9_999/10_000, 59_999/60_000,
      3_599_999/3_600_000, 356_399_999/356_400_000 (99h).
- [ ] percentText: `Math.min(Math.round(percent), 999)`; negative → `0%`;
      null → `?`; migrate pinned tests (`-5%` → `0%`; `125%` stays).
- [ ] Chip values use the same clamp.

## Task 2: render grid + boundary contract

`src/render.ts` + tests.

- [ ] GRID consts; renderWindowLine: label slice(0,3) padEnd(3), bar@4,
      pct padStart(4)@21-24, usage padStart(9)@26-34 (pair > 9 → dropped),
      verdict padStart(2)@36-37.
- [ ] renderHeader(header, mode, targetWidth=38): suffix right-aligned ends
      37; ladder drop-level → drop-`stale · `-prefix; `updating ...` slot.
- [ ] renderDetailLine auto-fit: parts reset · runway · [shortfall] ·
      [back]; ladder back → shortfall → reset; floor runway-only.
- [ ] ERROR_TEXT compact (all <= 36 chars; `no token (zai login or
      ZAI_TOKEN)`).
- [ ] Column invariants + width property (worst-case matrix) tests; golden
      grid mock (matches design.md canonical block).

## Task 3: wiring + docs

- [ ] `src/tui.tsx`: padding 0/0; order 50; W=38 targetWidth passthrough.
- [ ] tui tests: order/padding wiring; migrated slot goldens.
- [ ] README: regenerate mock from code; boundary contract table row update.

PROOF placeholders per task: `bun test <file>` exit 0; wave checkpoint full
suite + tsc + gates.

<!-- delegation log -->
