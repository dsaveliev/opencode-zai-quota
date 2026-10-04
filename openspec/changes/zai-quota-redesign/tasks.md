# Tasks: zai-quota-redesign

Waves W1/W2/W3 per design.md; coder → tester → reviewer per wave; golden
strings generated from code. Edge cases embedded in acceptance criteria.

---

## Task 1: Deterministic time formats (W1)

`src/format.ts` MODIFIED + tests migrated.

- [x] exact `fmtDuration`: <60m → "42m"; <48h → "1h 12m"; ≥48h → "3d 4h"
      (floor components; zero component omitted: 7200000 → "2h", 172800000 →
      "2d"); ≤0/non-finite → "0m" (current guards preserved).
- [x] NEW `fmtApproxDuration`: <48h → "~2h 5m" (same parts, "~" prefix);
      ≥48h → "~10d" with N = round(totalHours/24) (243h → ~10d; 254.4h →
      ~11d); ≤0/non-finite → "~0m".
- [x] NEW `fmtBackAt(resetInMs, formatDate)`: <24h → "back at HH:MM"
      (formatDate injected); ≥24h → "back in 3d 4h" (exact parts).
- [x] fmtCount unchanged. All boundaries pinned: 59m59s/1h, 23h59m/24h,
      47h59m/48h, MAX_SAFE_INTEGER finite, -0, rounding half-up on days.
- [x] Existing fmtDuration assertions in render/tui tests that encode the
      old ≥24h-hours behavior ("48h", "76h", "~250h") migrated to the new
      contract (list every migrated assertion in the report).

PROOF placeholder: `bun test src/format.test.ts` exit 0 + full suite green.

## Task 2: Status classification + severity (W1)

`src/status.ts` NEW.

- [x] `type Verdict = "ok" | "tight" | "short" | "blocked" | "unknown"`.
- [x] `classifyWindow(input: { usage, limit, runwayMs, runwayState, resetInMs,
      spanMs, stale, tightFactor }): Verdict` implementing design D1 order
      EXACTLY: blocked (usage>=limit) first; stale→unknown;
      spanMs!=null && spanMs<60000→unknown; runwayState "no-burn"→ok;
      runwayState no-data/no-limit/no-reset→unknown; short runway<reset;
      tight reset<=runway<reset×tightFactor; ok otherwise. Boundary
      equality: runway==reset→tight; runway==reset×tightFactor→ok.
- [x] `worstVerdict(verdicts): Verdict` — blocked>short>tight>ok; unknown
      only when ALL unknown (mixed → worst of known).
- [x] Tests: every branch; multiple-match precedence (usage>=limit AND
      span<60s → blocked — blocked independent of runway); tightFactor 1.5
      and 2.0; null limit (blocked impossible → downstream unknown unless
      runwayState says otherwise); stale flag beats span-guard order.
- [x] Pure module, zero imports.

## Task 3: Pace marker geometry (W1)

`src/marker.ts` NEW.

- [x] `WINDOW_MS: Record<number, number>` = { 3: 18_000_000, 6: 604_800_000 }.
- [x] `elapsedMs(now, resetAt, windowMs)` = now − (resetAt − windowMs).
- [x] `markerIndex(elapsedMs, windowMs, width): number | null` — null when
      windowMs null/<=0 or width<2; else
      clamp(floor(elapsedMs/windowMs × width), 0, width−1).
- [x] Tests: elapsed 0 → 0; elapsed=window → width−1; elapsed>window →
      width−1 (clamped); negative elapsed → 0; width 16 boundaries at
      elapsed fractions 76% → 12 and 54.76% → 8 (v1 spec example numbers —
      the ones the review corrected); unknown unit → null.
- [x] Pure module, zero imports.

## Task 4: V2 view-model + state matrix + goldens (W1)

`src/model.ts` NEW (consumes format/status/marker; emits texts+verdicts+
indices; NO glyph strings).

- [x] Types: `PanelModel { header: { title, level, freshness: string,
      stale: boolean, updating: boolean }, error: string | null, windows:
      WindowModel[] }`; `WindowModel { label, fillPercent, markerIndex,
      verdict, percentText, usageText, limitText, resetText, runwayText,
      backText, shortfallText }`; `ChipModel { values: string[],
      verdict }`.
- [x] Header freshness: "just now" (<10s), "Xs ago", "Xm ago" (10s
      granularity, injectable now); stale flag at >2×interval (error state
      ages from lastAttempt — v1 semantics preserved).
- [x] Window rows per design D5/D6: percent right-aligned padStart(4);
      runway text uses fmtApproxDuration except no-burn "runway ∞" and
      no-data "runway …"; short adds shortfallText "(1h 35m short)";
      blocked row: resetText exact + backText via fmtBackAt, runwayText
      "limit reached".
- [x] Chip model: percent values by label 5h/7d ("?" when null) + worst
      verdict; error chip verdict "error".
- [x] Golden tests GENERATED FROM the model functions covering the full
      state matrix (loading/ok/tight/short/blocked/stale/error × both
      windows × missing-label/missing-limit/unknown-unit edges) — golden
      literals produced by running the code, then frozen as toEqual
      assertions.
- [x] Pure module; imports only ./format ./status ./marker + types.

---

## Task 5: Render rewrite + fg invariant + contrast (W2)

`src/render.ts` REWRITE + render tests.

- [x] Consumes PanelModel/ChipModel; glyph sets unicode/ascii per cfg
      (design D6 table); gauge fill algorithm preserved symbolically
      (floor + partial eighths clamp 1..7).
- [x] EVERY text segment carries a role from {text, textMuted, success,
      warning, error}; roles.ts reduced to these 5 (accent/info dropped);
      fg-invariant test walks the render tree asserting explicit fg on
      every text node — written FIRST so it fails on current tui.tsx
      white-percent line (red anchor), passes after.
- [x] Width-40 degradation ladder per D6; test: longest line (short with
      shortfall = 37, blocked with back-at) fits 40; degradation drops
      back-text then reset segment.
- [x] Golden string tests both glyph modes from Task-4 matrix inputs.
- [x] Contrast fixture test: WCAG ratio >= 3 for role fg vs background on
      fixture pairs (solarized-light + a dark fixture); documented as
      fixture-scope.
- [x] Old render exports removed only when tui.tsx migrated (W3) — until
      then keep legacy chipSegments/panelModel coexisting; delete in W3.

## Task 6: Wiring — click, tick, config, additive fields (W3)

- [ ] `src/api.ts`: QuotaRow + `unit?: number` (typeof-guarded parse); `entryLabel`
      unit 6 → "7d" (review W1 F2: label seam — model hoists "7d", parser
      currently emits "wk").
- [ ] `src/runway.ts`: RunwayResult + `spanMs: number | null` (additive;
      existing states populate it; no algorithm change).
- [ ] `src/tui.tsx`: border removed; title text+bold; panel onMouseUp
      refresh (drag-guard via onMouseDrag flag; force semantics per D4:
      bypass idle-throttle, join in-flight, 1s force cooldown; "updating"
      header indicator; freshness only on success); 10s tick signal
      (header/marker advance; frozen fill/runway); error state panel stays
      clickable; chip not clickable; legacy render exports deleted; V2
      slots render from model+render; config wiring (tightFactor, glyphs,
      detail, gaugeWidth default 16).
- [ ] `src/config.ts`: +tightFactor (finite, >=1, clamp warning), +glyphs
      ("unicode"|"ascii"), +detail ("always"|"auto", default "always" —
      auto hides runway lines in ok when panel would otherwise be quiet);
      gaugeWidth default 12→16 (env name unchanged).
- [ ] Tests: click wiring (mouseup triggers exactly one forced refresh;
      drag-then-mouseup does not; cooldown blocks second force within 1s;
      in-flight dedupe joins); tick updates header without refetch; config
      validation; tui suite migrated to model-based assertions.
- [ ] Manual checklist (documented in README dev section): light + dark
      theme TUI check, glyph widths `✓ ✗ │ ∞` in user font.

## Task 7: README + archive prep

- [ ] README: new ASCII mock (code-generated), config table updated
      (tightFactor/glyphs/detail/gaugeWidth 16), click + `/zq`, state
      matrix table, npm-collision note preserved.

---

## Checkpoints

- W1: full `bun test` + `tsc --noEmit` + gates — pure core proven, goldens frozen.
- W2: fg-invariant red→green, contrast fixtures, both glyph modes golden.
- W3: click/tick wiring tests, config validation, manual TUI checklist
  executed, reviewer 5 axes, archive.

<!-- delegation log -->
<!-- 15:04 → coder w1 task 1 (format) + tasks 2-3 (status/marker) parallel — OK 238 pass -->
<!-- 15:21 → coder w1 task 4 (model + goldens) — OK 252 pass -->
<!-- 15:39 → tester w1 tasks 1-4 — 283 pass, golden≡formula cross-check OK -->
<!-- 15:52 → reviewer w1 tasks 1-4 (boundaries+security) — request-changes: F1 proto-key crash, F3/F4 nits, F2 seam→W3 -->
<!-- 16:04 → coder w1 fixes F1/F3/F4 — OK 292 pass, committed 9cf21e0/54876d3 -->
<!-- 16:18 → coder w2 task 5 (render rewrite) — OK 348 pass; contrast finding: success 2.970<3.0 on light -->
<!-- 16:41 → tester w2 task 5 — 355 pass; NaN barCells gap found, fixed → 357 -->
<!-- 17:02 → reviewer w2 task 5 — request-changes: A2-1 sanitize blocker, A1-1 ascii marker, A2-2 ascii leakage -->
<!-- 17:15 → coder w2 fixes A2-1/A1-1/A2-2 -->

## Proof log

- W1 PROOF: `bun test` → exit 0, 292 pass / 0 fail; `bunx tsc --noEmit` →
  exit 0. Golden-vs-formula independent cross-check (tester harness) — 0
  mismatches. Reviewer: request-changes → F1 (proto-key crash) + F3/F4
  fixed, re-tested; F2 (wk→7d seam) recorded in task 6.
- W2 PROOF: `bun test` → exit 0, 372 pass / 0 fail; `tsc --noEmit` exit 0.
  FG-invariant matrix (7 scenarios × 2 modes × degradation) green; golden
  strings independently re-derived by tester; contrast tripwire armed
  (success 2.970 < 3.0 on solarized-light — THEME-level finding, user
  owns the palette; glyphs carry meaning without color). Reviewer:
  request-changes → A2-1 (V2 sanitize, moved to format.ts + model
  construction), A1-1 (ascii null-fill marker), A2-2 (ascii 7-bit purity)
  fixed, re-tested.
