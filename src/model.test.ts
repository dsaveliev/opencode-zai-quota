import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import type { QuotaRow } from "./api";
import { buildChip, buildPanel, type ChipModel, type ModelInput, type ModelRow, type PanelModel, type WindowModel } from "./model";
import type { RunwayResult } from "./runway";
import type { RunwayState, Verdict } from "./status";

const NOW = 1_000_000_000_000;
const MIN = 60_000;
const HOUR = 3_600_000;

const formatTime = (ms: number) => "T" + ms;

function makeRow(label: string, opts: Partial<QuotaRow> & { unit?: number } = {}): ModelRow {
  const row: ModelRow = {
    label,
    usage: opts.usage ?? null,
    limit: opts.limit ?? null,
    percent: opts.percent ?? null,
    resetAt: opts.resetAt ?? null,
  };
  if (opts.unit !== undefined) row.unit = opts.unit;
  return row;
}

function makeRunway(state: RunwayState, runwayMs: number | null, resetInMs: number | null, spanMs: number | null = 600_000) {
  return { result: { state, runwayMs, resetInMs, spanMs } satisfies RunwayResult, spanMs };
}

function makeInput(overrides: Partial<ModelInput> = {}): ModelInput {
  return {
    rows: [],
    runways: {},
    level: null,
    updatedAt: null,
    lastAttemptAt: null,
    error: null,
    updating: false,
    now: NOW,
    intervalMs: MIN,
    tightFactor: 1.5,
    gaugeWidth: 16,
    formatTime,
    ...overrides,
  };
}

const row5h = () =>
  makeRow("5h", { usage: 312, limit: 500, percent: 62.4, resetAt: NOW + 72 * MIN, unit: 3 });
const row7d = () =>
  makeRow("7d", { usage: 4_100_000, limit: 10_000_000, percent: 41, resetAt: NOW + 273_600_000, unit: 6 });

const okRunways = () => ({
  "5h": makeRunway("ok", 7_500_000, 72 * MIN),
  "7d": makeRunway("ok", 900_000_000, 273_600_000),
});

describe("buildPanel", () => {
  test("1. ok scenario: full golden", () => {
    const input = makeInput({
      rows: [row5h(), row7d()],
      runways: okRunways(),
      level: "max",
      updatedAt: NOW - 30_000,
    });

    expect(buildPanel(input)).toEqual({
      header: {
        title: "ZAI RUNWAY",
        level: "max",
        freshness: "30s ago",
        stale: false,
        updating: false,
      },
      error: null,
      windows: [
        {
          label: "5h",
          fillPercent: 62.4,
          markerIndex: 12,
          verdict: "ok",
          percentText: "62%",
          usageText: "312",
          limitText: "500",
          resetText: "reset 1h 12m",
          runwayText: "runway ~2h 5m",
          backText: null,
          shortfallText: null,
        },
        {
          label: "7d",
          fillPercent: 41,
          markerIndex: 8,
          verdict: "ok",
          percentText: "41%",
          usageText: "4.1M",
          limitText: "10M",
          resetText: "reset 3d 4h",
          runwayText: "runway ~10d",
          backText: null,
          shortfallText: null,
        },
      ],
    } satisfies ReturnType<typeof buildPanel>);

    expect(buildChip(input)).toEqual({ values: ["62%", "41%"], verdict: "ok" });
  });

  test("2. short: shortfall is resetIn minus runway", () => {
    const input = makeInput({
      rows: [row5h(), row7d()],
      runways: { ...okRunways(), "5h": makeRunway("ok", 2_100_000, 72 * MIN) },
      updatedAt: NOW - 30_000,
    });
    const w = buildPanel(input).windows[0];
    expect(w?.verdict).toBe("short");
    expect(w?.runwayText).toBe("runway ~35m");
    // 4_320_000 - 2_100_000 = 2_220_000 ms = 37m (brief's "1h 5m" literal was wrong).
    expect(w?.shortfallText).toBe("(37m short)");
    expect(buildChip(input).verdict).toBe("short");
  });

  test("3. tight: runway in reset..reset*K band, no shortfall", () => {
    const input = makeInput({
      rows: [row5h(), row7d()],
      runways: { ...okRunways(), "5h": makeRunway("ok", 5_400_000, 72 * MIN) },
      updatedAt: NOW - 30_000,
    });
    const w = buildPanel(input).windows[0];
    expect(w?.verdict).toBe("tight");
    expect(w?.runwayText).toBe("runway ~1h 30m");
    expect(w?.shortfallText).toBeNull();
  });

  test("4. blocked: limit reached + back-at; resetAt null drops back-at", () => {
    const blockedRow = () =>
      makeRow("5h", { usage: 500, limit: 500, percent: 100, resetAt: NOW + 42 * MIN, unit: 3 });
    const base = {
      rows: [blockedRow()],
      runways: {},
      updatedAt: NOW - 30_000,
    };
    const panel = buildPanel(makeInput(base));
    const w = panel.windows[0];
    expect(w?.verdict).toBe("blocked");
    expect(w?.runwayText).toBe("limit reached");
    expect(w?.backText).toBe("back at T1000002520000");
    expect(w?.resetText).toBe("reset 42m");
    expect(w?.percentText).toBe("100%");
    expect(w?.shortfallText).toBeNull();

    const chip = buildChip(makeInput(base));
    expect(chip.values[0]).toBe("100%");
    expect(chip.verdict).toBe("blocked");

    const noReset = buildPanel(
      makeInput({ ...base, rows: [makeRow("5h", { usage: 500, limit: 500, percent: 100, resetAt: null })] }),
    ).windows[0];
    expect(noReset?.verdict).toBe("blocked");
    expect(noReset?.backText).toBeNull();
    expect(noReset?.resetText).toBe("reset ?");
  });

  test("5. span guard: span < 60s makes verdict unknown, cached runway text kept", () => {
    const input = makeInput({
      rows: [row5h(), row7d()],
      runways: {
        "5h": makeRunway("ok", 7_500_000, 72 * MIN, 59_999),
        "7d": makeRunway("ok", 900_000_000, 273_600_000, 59_999),
      },
      updatedAt: NOW - 30_000,
    });
    const panel = buildPanel(input);
    expect(panel.windows[0]?.verdict).toBe("unknown");
    expect(panel.windows[0]?.runwayText).toBe("runway ~2h 5m");
    expect(panel.windows[1]?.verdict).toBe("unknown");
    expect(buildChip(input).verdict).toBe("unknown");
  });

  test("6. stale: freshness prefixed, verdicts unknown, texts retained", () => {
    const input = makeInput({
      rows: [row5h(), row7d()],
      runways: okRunways(),
      updatedAt: NOW - 3 * MIN,
    });
    const panel = buildPanel(input);
    expect(panel.header.stale).toBe(true);
    expect(panel.header.freshness).toBe("stale · 3m ago");
    const w = panel.windows[0];
    expect(w?.verdict).toBe("unknown");
    expect(w?.runwayText).toBe("runway ~2h 5m");
    expect(w?.resetText).toBe("reset 1h 12m");
    expect(w?.percentText).toBe("62%");
    expect(buildChip(input)).toEqual({ values: ["62%", "41%"], verdict: "unknown" });
  });

  test("7. error with no rows: error code surfaced, empty windows", () => {
    const input = makeInput({ rows: [], error: "no-token" });
    const panel = buildPanel(input);
    expect(panel.error).toBe("no-token");
    expect(panel.windows).toEqual([]);
    expect(panel.header.freshness).toBe("—");
    expect(panel.header.stale).toBe(false);
    expect(buildChip(input)).toEqual({ values: [], verdict: "error" });
  });

  test("8. error with cached rows: fresh attempts keep stale false, error hidden", () => {
    const input = makeInput({
      rows: [row5h(), row7d()],
      runways: okRunways(),
      updatedAt: NOW - 30_000,
      lastAttemptAt: NOW - 30_000,
      error: "http-429",
    });
    const panel = buildPanel(input);
    expect(panel.header.stale).toBe(false);
    expect(panel.header.freshness).toBe("30s ago");
    expect(panel.error).toBeNull();
    expect(panel.windows[0]?.verdict).toBe("ok");
  });

  test("9. loading: empty rows, updating flag passthrough, no error", () => {
    const input = makeInput({ rows: [], error: null, updating: true });
    const panel = buildPanel(input);
    expect(panel.header.freshness).toBe("—");
    expect(panel.header.updating).toBe(true);
    expect(panel.windows).toEqual([]);
    expect(panel.error).toBeNull();
    expect(buildChip(input)).toEqual({ values: [], verdict: "unknown" });
  });

  test("10. no-burn: verdict ok, infinite runway glyph", () => {
    const input = makeInput({
      rows: [row5h()],
      runways: { "5h": makeRunway("no-burn", null, null) },
      updatedAt: NOW - 30_000,
    });
    const w = buildPanel(input).windows[0];
    expect(w?.verdict).toBe("ok");
    expect(w?.runwayText).toBe("runway ∞");
  });

  test("11. row without unit: markerIndex null, rest intact", () => {
    const input = makeInput({
      rows: [makeRow("5h", { usage: 312, limit: 500, percent: 62.4, resetAt: NOW + 72 * MIN })],
      runways: { "5h": makeRunway("ok", 7_500_000, 72 * MIN) },
      updatedAt: NOW - 30_000,
    });
    const w = buildPanel(input).windows[0];
    expect(w?.markerIndex).toBeNull();
    expect(w?.verdict).toBe("ok");
    expect(w?.runwayText).toBe("runway ~2h 5m");
  });

  test("12. missing 5h row: 7d alone, chip shows ? for 5h", () => {
    const input = makeInput({
      rows: [row7d()],
      runways: { "7d": makeRunway("ok", 900_000_000, 273_600_000) },
      updatedAt: NOW - 30_000,
    });
    const panel = buildPanel(input);
    expect(panel.windows).toHaveLength(1);
    expect(panel.windows[0]?.label).toBe("7d");
    expect(buildChip(input)).toEqual({ values: ["?", "41%"], verdict: "ok" });
  });

  test("13. freshness tiers: s/m/h/d ladder boundaries, tier text <= 8 chars", () => {
    const at = (age: number) =>
      buildPanel(
        makeInput({ rows: [row5h()], runways: okRunways(), updatedAt: NOW - age, intervalMs: age }),
      ).header.freshness;
    // intervalMs = age keeps every case non-stale (stale needs age > 2*intervalMs),
    // so each case pins the bare tier string; the stale prefix is pinned below.
    const cases: Array<[number, string]> = [
      [9_999, "just now"],
      [10_000, "10s ago"],
      [59_999, "59s ago"],
      [60_000, "1m ago"],
      [125_000, "2m ago"],
      [3_599_999, "59m ago"],
      [3_600_000, "1h ago"],
      [7_200_000, "2h ago"],
      [86_400_000, "24h ago"],
      // Grid-align brief pinned "99h ago" here, but floor(356_399_999 / 3_600_000) = 98
      // (98h 59m 59.999s elapsed) — same last-ms pattern as 59_999 -> "59s ago" and
      // 3_599_999 -> "59m ago". Corrected to 98h; flagged in the task report.
      [356_399_999, "98h ago"],
      [356_400_000, "4d ago"],
      [400 * 86_400_000 + 3_600_000, "400d ago"],
    ];
    for (const [age, expected] of cases) {
      const text = at(age);
      expect(text).toBe(expected);
      expect(text.length).toBeLessThanOrEqual(8);
    }
  });

  test("13b. stale prefix composes with the hour tier (prefix logic unchanged)", () => {
    const input = makeInput({
      rows: [row5h()],
      runways: okRunways(),
      updatedAt: NOW - 3_600_000,
      intervalMs: MIN,
    });
    const header = buildPanel(input).header;
    expect(header.stale).toBe(true);
    expect(header.freshness).toBe("stale · 1h ago");
  });

  test("14. ordering: 5h hoisted before 7d, duplicates dropped", () => {
    const dup = makeRow("5h", { usage: 400, limit: 500, percent: 80, resetAt: NOW + MIN, unit: 3 });
    const input = makeInput({
      rows: [row7d(), row5h(), dup],
      runways: okRunways(),
      updatedAt: NOW - 30_000,
    });
    const labels = buildPanel(input).windows.map((w) => w.label);
    expect(labels).toEqual(["5h", "7d"]);
  });
});

// ---------------------------------------------------------------------------
// W1 tester audit additions (appended only; no source files touched).
// ---------------------------------------------------------------------------

describe("W1 audit: percent text clamp boundaries", () => {
  test("percent 125 stays 125% (above 100, under the 999 ceiling)", () => {
    const input = makeInput({
      rows: [makeRow("5h", { usage: 312, limit: 500, percent: 125, resetAt: NOW + 72 * MIN, unit: 3 })],
      runways: { "5h": makeRunway("ok", 7_500_000, 72 * MIN) },
      updatedAt: NOW - 30_000,
    });
    const w = buildPanel(input).windows[0];
    expect(w?.fillPercent).toBe(125);
    expect(w?.percentText).toBe("125%");
    expect(w?.verdict).toBe("ok");
    expect(buildChip(input).values[0]).toBe("125%");
  });

  test("negative percent: fillPercent stays raw, text clamps to 0% (panel + chip)", () => {
    const input = makeInput({
      rows: [makeRow("5h", { usage: 312, limit: 500, percent: -5.4, resetAt: NOW + 72 * MIN, unit: 3 })],
      runways: { "5h": makeRunway("ok", 7_500_000, 72 * MIN) },
      updatedAt: NOW - 30_000,
    });
    const w = buildPanel(input).windows[0];
    expect(w?.fillPercent).toBe(-5.4);
    expect(w?.percentText).toBe("0%");
    expect(buildChip(input).values[0]).toBe("0%");
  });

  test("percent 999 renders 999% at the clamp ceiling", () => {
    const input = makeInput({
      rows: [makeRow("5h", { usage: 312, limit: 500, percent: 999, resetAt: NOW + 72 * MIN, unit: 3 })],
      runways: { "5h": makeRunway("ok", 7_500_000, 72 * MIN) },
      updatedAt: NOW - 30_000,
    });
    const w = buildPanel(input).windows[0];
    expect(w?.percentText).toBe("999%");
    expect(buildChip(input).values[0]).toBe("999%");
  });

  test("percent 1500 clamps to 999% (panel and chip share the clamp)", () => {
    const input = makeInput({
      rows: [makeRow("5h", { usage: 312, limit: 500, percent: 1500, resetAt: NOW + 72 * MIN, unit: 3 })],
      runways: { "5h": makeRunway("ok", 7_500_000, 72 * MIN) },
      updatedAt: NOW - 30_000,
    });
    const w = buildPanel(input).windows[0];
    expect(w?.fillPercent).toBe(1500);
    expect(w?.percentText).toBe("999%");
    expect(buildChip(input).values[0]).toBe("999%");
  });

  test("usage >= limit blocks even when the percent figure is small (percent text independent)", () => {
    const input = makeInput({
      rows: [makeRow("5h", { usage: 500, limit: 500, percent: 10, resetAt: NOW + 42 * MIN, unit: 3 })],
      runways: {},
      updatedAt: NOW - 30_000,
    });
    const w = buildPanel(input).windows[0];
    expect(w?.verdict).toBe("blocked");
    expect(w?.percentText).toBe("10%");
    expect(w?.backText).toBe("back at T" + (NOW + 42 * MIN));
    const chip = buildChip(input);
    expect(chip.values[0]).toBe("10%");
    expect(chip.verdict).toBe("blocked");
  });
});

describe("W1 audit: stale boundary (exactly 2*intervalMs vs +1)", () => {
  test("error path: governing timestamp is lastAttemptAt", () => {
    const rows = [row5h(), row7d()];
    const runways = okRunways();

    const exact = makeInput({
      rows,
      runways,
      error: "http-429",
      updatedAt: null,
      lastAttemptAt: NOW - 2 * MIN,
    });
    const panelExact = buildPanel(exact);
    expect(panelExact.header.stale).toBe(false);
    expect(panelExact.header.freshness).toBe("2m ago");
    expect(panelExact.error).toBeNull();
    expect(panelExact.windows[0]?.verdict).toBe("ok");
    expect(buildChip(exact).verdict).toBe("ok");

    const past = makeInput({
      rows,
      runways,
      error: "http-429",
      updatedAt: null,
      lastAttemptAt: NOW - 2 * MIN - 1,
    });
    const panelPast = buildPanel(past);
    expect(panelPast.header.stale).toBe(true);
    expect(panelPast.header.freshness).toBe("stale · 2m ago");
    expect(panelPast.windows[0]?.verdict).toBe("unknown");
    expect(buildChip(past).verdict).toBe("unknown");
  });

  test("no-error path: governing timestamp is updatedAt (same boundary)", () => {
    const rows = [row5h(), row7d()];
    const runways = okRunways();
    expect(buildPanel(makeInput({ rows, runways, updatedAt: NOW - 2 * MIN })).header.stale).toBe(false);
    expect(buildPanel(makeInput({ rows, runways, updatedAt: NOW - 2 * MIN - 1 })).header.stale).toBe(true);
  });
});

describe("W1 audit: input immutability", () => {
  function deepFreeze<T>(value: T): T {
    if (value != null && typeof value === "object") {
      for (const key of Object.getOwnPropertyNames(value)) {
        deepFreeze((value as Record<string, unknown>)[key]);
      }
      Object.freeze(value);
    }
    return value;
  }

  test("buildPanel/buildChip never mutate deep-frozen inputs", () => {
    const input = deepFreeze(
      makeInput({
        rows: [row5h(), row7d()],
        runways: okRunways(),
        level: "max",
        updatedAt: NOW - 30_000,
        lastAttemptAt: NOW - 30_000,
        error: "http-429",
      }),
    );
    const snapshot = JSON.stringify(input);
    expect(buildPanel(input).windows).toHaveLength(2);
    expect(buildChip(input)).toEqual({ values: ["62%", "41%"], verdict: "ok" });
    expect(JSON.stringify(input)).toBe(snapshot);
    expect(Object.isFrozen(input)).toBe(true);
    expect(Object.isFrozen(input.rows)).toBe(true);
    for (const row of input.rows) expect(Object.isFrozen(row)).toBe(true);
    for (const entry of Object.values(input.runways)) {
      expect(Object.isFrozen(entry)).toBe(true);
      expect(Object.isFrozen(entry.result)).toBe(true);
    }
  });
});

describe("W1 audit: purity (static scan)", () => {
  test("model/status/marker/format carry no clock, console, global, fs, require or timer tokens", () => {
    // Pure sync modules: no clock reads, no IO, no console, no globals, no timers.
    // Absence of timers/background work here doubles as the leak check: there is
    // no goroutine/thread/task analogue anywhere in the W1 surface to leak.
    const forbidden = /Date\.now|new Date|console\.|globalThis|setTimeout|setInterval|setImmediate|\bfs\.|require\(/;
    for (const file of ["model.ts", "status.ts", "marker.ts", "format.ts"]) {
      const source = readFileSync(new URL(`./${file}`, import.meta.url), "utf8");
      expect(source.match(forbidden)?.join(",") ?? null).toBeNull();
    }
  });
});

// ---------------------------------------------------------------------------
// W1 audit: golden integrity — independent formula recomputation.
// Every toEqual golden above is re-derived here from the raw documented rules
// WITHOUT calling the source helpers (classifyWindow / fmt* / markerIndex /
// orderRows are re-implemented below from the spec). `model == recomputed`
// guards the model against rule drift; `recomputed == frozen literal` fails
// loudly on purpose if a golden literal ever stops matching the formulas.
// ---------------------------------------------------------------------------

const HOUR_MS = 3_600_000;
const DAY_MS = 86_400_000;

/** Window lengths by plan-unit, restated from the tier spec (5h = 300min, 7d = 7*24h). */
const UNIT_WINDOW_MS: Record<number, number> = { 3: 300 * 60_000, 6: 7 * 24 * 60 * 60_000 };

const NO_RUNWAY_RE: { result: RunwayResult; spanMs: number | null } = {
  result: { state: "no-reset", runwayMs: null, resetInMs: null, spanMs: null },
  spanMs: null,
};

function reFmtDuration(ms: number): string {
  if (!Number.isFinite(ms) || ms <= 0) return "0m";
  if (ms < 60_000) return `${Math.floor(ms / 1000)}s`;
  if (ms < HOUR_MS) return `${Math.floor(ms / 60_000)}m`;
  if (ms < 48 * HOUR_MS) {
    const h = Math.floor(ms / HOUR_MS);
    const m = Math.floor((ms % HOUR_MS) / 60_000);
    return m > 0 ? `${h}h ${m}m` : `${h}h`;
  }
  const d = Math.floor(ms / DAY_MS);
  const h = Math.floor((ms % DAY_MS) / HOUR_MS);
  return h > 0 ? `${d}d ${h}h` : `${d}d`;
}

function reFmtApprox(ms: number): string {
  if (!Number.isFinite(ms) || ms <= 0) return "~0m";
  const totalHours = ms / HOUR_MS;
  if (totalHours < 48) return `~${reFmtDuration(ms)}`;
  return `~${Math.round(totalHours / 24)}d`;
}

function reFmtCount(n: number): string {
  if (!Number.isFinite(n)) return "?";
  const abs = Math.abs(n);
  const sign = n < 0 ? "-" : "";
  const tiers: ReadonlyArray<readonly [number, string]> = [
    [1e9, "B"],
    [1e6, "M"],
    [1e3, "k"],
  ];
  for (const [scale, tier] of tiers) {
    if (abs >= scale) {
      const value = abs / scale;
      if (Number.isInteger(value)) return `${sign}${value}${tier}`;
      const fixed = value.toFixed(1);
      return `${sign}${fixed.endsWith(".0") ? fixed.slice(0, -2) : fixed}${tier}`;
    }
  }
  return sign + String(abs);
}

function reClassify(s: {
  usage: number | null;
  limit: number | null;
  runwayMs: number | null;
  runwayState: RunwayState;
  resetInMs: number | null;
  spanMs: number | null;
  stale: boolean;
  tightFactor: number;
}): Verdict {
  // Rules 1..9 in documented order.
  if (s.usage != null && s.limit != null && s.usage >= s.limit) return "blocked";
  if (s.stale) return "unknown";
  if (s.spanMs != null && s.spanMs < 60_000) return "unknown";
  if (s.runwayState === "no-burn") return "ok";
  if (s.runwayState === "no-data" || s.runwayState === "no-limit" || s.runwayState === "no-reset") return "unknown";
  if (s.runwayMs == null || s.resetInMs == null) return "unknown";
  if (s.runwayMs < s.resetInMs) return "short";
  if (s.runwayMs < s.resetInMs * s.tightFactor) return "tight";
  return "ok";
}

function reMarkerIndex(elapsed: number, windowMs: number, width: number): number {
  return Math.min(Math.max(Math.floor((elapsed / windowMs) * width), 0), width - 1);
}

function reStale(input: ModelInput): boolean {
  if (input.rows.length === 0) return false;
  const ts = input.error != null ? input.lastAttemptAt : input.updatedAt;
  return ts != null && input.now - ts > 2 * input.intervalMs;
}

function reFreshness(ts: number | null, now: number, stale: boolean): string {
  if (ts == null) return "—";
  const age = Math.max(0, now - ts);
  let text: string;
  if (age < 10_000) text = "just now";
  else if (age < 60_000) text = `${Math.floor(age / 1000)}s ago`;
  else if (age < HOUR_MS) text = `${Math.floor(age / 60_000)}m ago`;
  else if (age < 99 * HOUR_MS) text = `${Math.floor(age / HOUR_MS)}h ago`;
  else text = `${Math.floor(age / DAY_MS)}d ago`;
  return stale ? `stale · ${text}` : text;
}

/** Percent text restated from the grid-align spec: null -> "?", negatives -> 0%, ceiling 999%. */
function rePctText(percent: number | null): string {
  if (percent == null) return "?";
  const clamped = Math.max(0, Math.round(percent));
  return clamped > 999 ? "999%" : `${clamped}%`;
}

function reRunwayText(verdict: Verdict, result: RunwayResult): string {
  if (verdict === "blocked") return "limit reached";
  if (result.state === "no-burn") return "runway ∞";
  if (result.state === "no-data" || result.state === "no-limit" || result.state === "no-reset") return "runway …";
  return result.runwayMs != null ? `runway ${reFmtApprox(result.runwayMs)}` : "runway …";
}

function reWindowModel(
  row: ModelRow,
  runway: { result: RunwayResult; spanMs: number | null },
  stale: boolean,
  input: ModelInput,
): WindowModel {
  const resetIn = row.resetAt != null ? Math.max(0, row.resetAt - input.now) : null;
  const verdict = reClassify({
    usage: row.usage,
    limit: row.limit,
    runwayMs: runway.result.runwayMs,
    runwayState: runway.result.state,
    resetInMs: resetIn,
    spanMs: runway.spanMs,
    stale,
    tightFactor: input.tightFactor,
  });
  const windowMs = row.unit != null ? UNIT_WINDOW_MS[row.unit] : undefined;
  const idx =
    windowMs != null && row.resetAt != null
      ? reMarkerIndex(input.now - (row.resetAt - windowMs), windowMs, input.gaugeWidth)
      : null;
  let backText: string | null = null;
  if (verdict === "blocked" && row.resetAt != null && resetIn != null) {
    if (resetIn <= 0) backText = "back at " + input.formatTime(input.now);
    else if (resetIn < DAY_MS) backText = "back at " + input.formatTime(input.now + resetIn);
    else backText = "back in " + reFmtDuration(resetIn);
  }
  const shortfall =
    verdict === "short" && runway.result.runwayMs != null && resetIn != null
      ? `(${reFmtDuration(Math.max(0, resetIn - runway.result.runwayMs))} short)`
      : null;
  return {
    label: row.label,
    fillPercent: row.percent,
    markerIndex: idx,
    verdict,
    percentText: rePctText(row.percent),
    usageText: row.usage != null ? reFmtCount(row.usage) : "?",
    limitText: row.limit != null ? reFmtCount(row.limit) : "?",
    resetText: resetIn != null ? `reset ${reFmtDuration(resetIn)}` : "reset ?",
    runwayText: reRunwayText(verdict, runway.result),
    backText,
    shortfallText: shortfall,
  };
}

function reOrderRows(rows: readonly ModelRow[]): ModelRow[] {
  const out: ModelRow[] = [];
  const seen = new Set<string>();
  for (const label of ["5h", "7d"]) {
    const row = rows.find((r) => r.label === label);
    if (row) {
      out.push(row);
      seen.add(label);
    }
  }
  for (const row of rows) {
    if (!seen.has(row.label)) {
      out.push(row);
      seen.add(row.label);
    }
  }
  return out;
}

function rePanel(input: ModelInput): PanelModel {
  const stale = reStale(input);
  const ts = input.error != null ? input.lastAttemptAt : input.updatedAt;
  return {
    header: {
      title: "ZAI RUNWAY" as const,
      level: input.level,
      freshness: reFreshness(ts, input.now, stale),
      stale,
      updating: input.updating,
    },
    error: input.rows.length === 0 ? input.error : null,
    windows: reOrderRows(input.rows).map((row) =>
      reWindowModel(row, input.runways[row.label] ?? NO_RUNWAY_RE, stale, input),
    ),
  };
}

function reChip(input: ModelInput): ChipModel {
  if (input.error != null && input.rows.length === 0) return { values: [] as string[], verdict: "error" };
  if (input.rows.length === 0) return { values: [] as string[], verdict: "unknown" };
  const pct = (label: string): string => {
    const row = input.rows.find((r) => r.label === label);
    return row ? rePctText(row.percent) : "?";
  };
  const stale = reStale(input);
  const SEVERITY: Record<string, number> = { ok: 0, tight: 1, short: 2, blocked: 3 };
  const verdicts = reOrderRows(input.rows).map((row) =>
    reWindowModel(row, input.runways[row.label] ?? NO_RUNWAY_RE, stale, input).verdict,
  );
  const known = verdicts.filter((v) => v !== "unknown");
  const worst =
    known.length === 0 ? "unknown" : known.reduce((worst, v) => (SEVERITY[v] > SEVERITY[worst] ? v : worst));
  return { values: [pct("5h"), pct("7d")], verdict: stale ? "unknown" : worst };
}

describe("W1 audit: golden integrity (independent recomputation)", () => {
  const okInput = () =>
    makeInput({ rows: [row5h(), row7d()], runways: okRunways(), level: "max", updatedAt: NOW - 30_000 });

  test("golden 1 markers: floor+clamp arithmetic reproduces the frozen 12 and 8", () => {
    // 5h: elapsed = 18_000_000 - 4_320_000 = 13_680_000 -> floor(0.76 * 16) = 12
    expect(reMarkerIndex(13_680_000, UNIT_WINDOW_MS[3], 16)).toBe(12);
    // 7d: elapsed = 604_800_000 - 273_600_000 = 331_200_000 -> floor((331_200_000/604_800_000) * 16) = 8
    expect(reMarkerIndex(331_200_000, UNIT_WINDOW_MS[6], 16)).toBe(8);
  });

  test("golden 1 (ok scenario): model equals independent recomputation", () => {
    expect(buildPanel(okInput())).toEqual(rePanel(okInput()));
    expect(buildChip(okInput())).toEqual(reChip(okInput()));
  });

  test("golden 1 (ok scenario): recomputation agrees with the frozen golden literal", () => {
    expect(rePanel(okInput())).toEqual({
      header: { title: "ZAI RUNWAY", level: "max", freshness: "30s ago", stale: false, updating: false },
      error: null,
      windows: [
        {
          label: "5h",
          fillPercent: 62.4,
          markerIndex: 12,
          verdict: "ok",
          percentText: "62%",
          usageText: "312",
          limitText: "500",
          resetText: "reset 1h 12m",
          runwayText: "runway ~2h 5m",
          backText: null,
          shortfallText: null,
        },
        {
          label: "7d",
          fillPercent: 41,
          markerIndex: 8,
          verdict: "ok",
          percentText: "41%",
          usageText: "4.1M",
          limitText: "10M",
          resetText: "reset 3d 4h",
          runwayText: "runway ~10d",
          backText: null,
          shortfallText: null,
        },
      ],
    });
    expect(reChip(okInput())).toEqual({ values: ["62%", "41%"], verdict: "ok" });
  });

  test("golden 6 (stale chip): model equals recomputation; literal matches formula", () => {
    const staleInput = () => makeInput({ rows: [row5h(), row7d()], runways: okRunways(), updatedAt: NOW - 3 * MIN });
    expect(buildChip(staleInput())).toEqual(reChip(staleInput()));
    expect(reChip(staleInput())).toEqual({ values: ["62%", "41%"], verdict: "unknown" });
    expect(buildPanel(staleInput())).toEqual(rePanel(staleInput()));
  });

  test("golden 7 (error, no rows): model equals recomputation; literal matches formula", () => {
    const errInput = () => makeInput({ rows: [], error: "no-token" });
    expect(buildChip(errInput())).toEqual(reChip(errInput()));
    expect(reChip(errInput())).toEqual({ values: [], verdict: "error" });
    expect(buildPanel(errInput())).toEqual(rePanel(errInput()));
  });

  test("golden 9 (loading): model equals recomputation; literal matches formula", () => {
    const loadInput = () => makeInput({ rows: [], error: null, updating: true });
    expect(buildChip(loadInput())).toEqual(reChip(loadInput()));
    expect(reChip(loadInput())).toEqual({ values: [], verdict: "unknown" });
    expect(buildPanel(loadInput())).toEqual(rePanel(loadInput()));
  });

  test("golden 12 (7d alone): model equals recomputation; literal matches formula", () => {
    const only7d = () =>
      makeInput({
        rows: [row7d()],
        runways: { "7d": makeRunway("ok", 900_000_000, 273_600_000) },
        updatedAt: NOW - 30_000,
      });
    expect(buildChip(only7d())).toEqual(reChip(only7d()));
    expect(reChip(only7d())).toEqual({ values: ["?", "41%"], verdict: "ok" });
    expect(buildPanel(only7d())).toEqual(rePanel(only7d()));
  });

  test("scenario 2 (short): runway/shortfall strings match formulas and the frozen literals", () => {
    const shortRunway = makeRunway("ok", 2_100_000, 72 * MIN);
    const input = makeInput({
      rows: [row5h(), row7d()],
      runways: { ...okRunways(), "5h": shortRunway },
      updatedAt: NOW - 30_000,
    });
    const w = buildPanel(input).windows[0];
    const recomputed = reWindowModel(row5h(), shortRunway, false, input);
    expect(w?.verdict).toBe(recomputed.verdict);
    expect(w?.runwayText).toBe(recomputed.runwayText);
    expect(w?.shortfallText).toBe(recomputed.shortfallText);
    expect(w?.runwayText).toBe("runway ~35m");
    expect(w?.shortfallText).toBe("(37m short)");
  });

  test("scenario 3 (tight): runway text matches formula and the frozen literal", () => {
    const tightRunway = makeRunway("ok", 5_400_000, 72 * MIN);
    const input = makeInput({
      rows: [row5h(), row7d()],
      runways: { ...okRunways(), "5h": tightRunway },
      updatedAt: NOW - 30_000,
    });
    const w = buildPanel(input).windows[0];
    const recomputed = reWindowModel(row5h(), tightRunway, false, input);
    expect(w?.verdict).toBe(recomputed.verdict);
    expect(w?.runwayText).toBe(recomputed.runwayText);
    expect(w?.runwayText).toBe("runway ~1h 30m");
    expect(w?.shortfallText).toBeNull();
  });

  test("scenario 4 (blocked): back-at and reset texts match formulas and the frozen literal", () => {
    const blockedRow = makeRow("5h", { usage: 500, limit: 500, percent: 100, resetAt: NOW + 42 * MIN, unit: 3 });
    const input = makeInput({ rows: [blockedRow], runways: {}, updatedAt: NOW - 30_000 });
    const w = buildPanel(input).windows[0];
    const recomputed = reWindowModel(blockedRow, NO_RUNWAY_RE, false, input);
    expect(w?.verdict).toBe(recomputed.verdict);
    expect(w?.backText).toBe(recomputed.backText);
    expect(w?.backText).toBe("back at T1000002520000");
    expect(w?.resetText).toBe(recomputed.resetText);
    expect(w?.resetText).toBe("reset 42m");
  });
});

// ---------------------------------------------------------------------------
// Review fix F1: prototype-key labels ("__proto__", "toString") must resolve
// to NO_RUNWAY via an own-property lookup, never to the inherited
// Object.prototype members (whose `.result` is undefined -> TypeError).
// ---------------------------------------------------------------------------

describe("review fix F1: prototype-key labels", () => {
  test('label "__proto__" without a runway entry: no throw, window built with NO_RUNWAY defaults', () => {
    const input = makeInput({
      rows: [makeRow("__proto__", { usage: 312, limit: 500, percent: 62.4, resetAt: NOW + 72 * MIN })],
      runways: {},
      updatedAt: NOW - 30_000,
    });
    const w = buildPanel(input).windows[0];
    expect(w?.label).toBe("__proto__");
    // NO_RUNWAY.result.state is "no-reset" -> rule 5 -> unknown.
    expect(w?.verdict).toBe("unknown");
    expect(w?.runwayText).toBe("runway …");
    expect(buildChip(input).verdict).toBe("unknown");
  });

  test('label "toString" without a runway entry: no throw, same NO_RUNWAY defaults', () => {
    const input = makeInput({
      rows: [makeRow("toString", { usage: 312, limit: 500, percent: 62.4, resetAt: NOW + 72 * MIN })],
      runways: {},
      updatedAt: NOW - 30_000,
    });
    const w = buildPanel(input).windows[0];
    expect(w?.label).toBe("toString");
    expect(w?.verdict).toBe("unknown");
    expect(w?.runwayText).toBe("runway …");
    expect(buildChip(input).verdict).toBe("unknown");
  });

  test("legitimate labels still resolve their own runway (regression)", () => {
    const input = makeInput({
      rows: [row5h()],
      runways: { "5h": makeRunway("ok", 7_500_000, 72 * MIN) },
      updatedAt: NOW - 30_000,
    });
    const w = buildPanel(input).windows[0];
    expect(w?.verdict).toBe("ok");
    expect(w?.runwayText).toBe("runway ~2h 5m");
    expect(buildChip(input).verdict).toBe("ok");
  });
});

describe("review fix A2-1: V2 emission paths sanitized at construction", () => {
  const hostileLabel = "\u001b[31mevil\u001b[0m";

  test("row label with CSI color escape: WindowModel.label carries only the visible text", () => {
    const panel = buildPanel(
      makeInput({ rows: [makeRow(hostileLabel, { usage: 312, limit: 500, percent: 62.4 })], updatedAt: NOW - 30_000 }),
    );
    expect(panel.windows[0]?.label).toBe("evil");
  });

  test("header level with OSC title escape: whole sequence stripped (payload is terminal command, not text); null stays null", () => {
    const withOsc = buildPanel(makeInput({ level: "\u001b]0;pwn\u0007", rows: [row5h()], runways: okRunways() }));
    expect(withOsc.header.level).toBe("");
    expect(buildPanel(makeInput({ level: null })).header.level).toBeNull();
  });

  test("hostile raw label still resolves its runway record (lookup keyed by RAW label, display sanitized)", () => {
    const runways = { [hostileLabel]: makeRunway("no-burn", null, 72 * MIN) };
    const panel = buildPanel(
      makeInput({ rows: [makeRow(hostileLabel, { usage: 0, limit: 500, percent: 0 })], runways, updatedAt: NOW - 30_000 }),
    );
    const w = panel.windows[0];
    expect(w?.label).toBe("evil");
    // The runway was found via the hostile RAW string as the key; a lookup by
    // the sanitized "evil" would have missed and produced "runway …".
    expect(w?.runwayText).toBe("runway ∞");
  });

  test("ordering decisions key on the RAW label: escaped 5h look-alike is not hoisted, yet displays sanitized", () => {
    const escaped5h = "\u001b[31m5h\u001b[0m";
    const panel = buildPanel(
      makeInput({ rows: [makeRow(escaped5h, { percent: 10 }), row7d()], runways: {}, updatedAt: NOW - 30_000 }),
    );
    // No raw "5h" row exists, so nothing is hoisted: 7d keeps first position.
    expect(panel.windows[0]?.label).toBe("7d");
    // The escaped clone renders as plain "5h" in second position.
    expect(panel.windows[1]?.label).toBe("5h");
  });
});

// ---------------------------------------------------------------------------
// Tester audit additions (zai-quota-grid-align): appended only, no source
// files touched.
// ---------------------------------------------------------------------------
describe("tester audit: freshness day-tier digit growth", () => {
  test("999d is the last 8-char tier value; 1000d documents the uncapped digits (accepted)", () => {
    const at = (age: number) =>
      buildPanel(
        makeInput({ rows: [row5h()], runways: okRunways(), updatedAt: NOW - age, intervalMs: age }),
      ).header.freshness;
    expect(at(999 * 86_400_000)).toBe("999d ago");
    expect(at(999 * 86_400_000)).toHaveLength(8);
    // Tester verdict: the days tier does not clamp digits — age > 999d emits
    // capped at "99d+" (4 chars) — the 8-char tier cap now holds in the days tier too (review nit fix)
    // for a session-scoped plugin (needs a clock jump past ~2.7 years) and
    // grid-safe (the 38-col header ladder still fits the worst epoch-ms-bound
    // text; pinned render-side in render.test.ts "day cap" test).
    expect(at(1000 * 86_400_000)).toBe("999d+");
    expect(at(100 * 86_400_000)).toBe("100d ago");
    expect(at(99 * 86_400_000)).toBe("99d ago");
    expect(at(1000 * 86_400_000)).toHaveLength(5); // "999d+"
  });

  test("stale prefix composes with a beyond-cap day count (mirrors test 13b at 1000d)", () => {
    const panel = buildPanel(
      makeInput({ rows: [row5h()], runways: okRunways(), updatedAt: NOW - 1000 * 86_400_000, intervalMs: MIN }),
    );
    expect(panel.header.stale).toBe(true);
    expect(panel.header.freshness).toBe("stale · 999d+");
  });
});
