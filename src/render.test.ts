import { describe, expect, test } from "bun:test";
import { sanitize } from "./format";
import type { QuotaRow } from "./api";
import type { RunwayResult } from "./runway";

// ===========================================================================
// sanitize: the shared control-char stripper (src/format.ts) — the render
// layer re-export was retired; model and wiring import from format directly.
// ===========================================================================
describe("sanitize", () => {
  test("passes labels through unchanged after control-char stripping", () => {
    expect(sanitize("5h")).toBe("5h");
    expect(sanitize("7d")).toBe("7d");
    expect(sanitize("\u001b[31mevil\u001b[0m")).toBe("evil");
  });
});

// ===========================================================================
// V2 renderer (grid-align task 2): fixed 38-column grid over the W1
// view-model (src/model.ts). Every Segment carries exactly one of the five
// universal SegmentRole tokens.
// ===========================================================================

import {
  GRID,
  VERDICT_GLYPH,
  VERDICT_ROLE,
  barCells,
  renderChipSegments,
  renderDetailLine,
  renderHeader,
  renderPanelLines,
  renderWindowLine,
  type GlyphMode,
  type Segment,
} from "./render";
import {
  buildChip,
  buildPanel,
  type ChipModel,
  type ModelInput,
  type ModelRow,
  type PanelModel as V2PanelModel,
  type WindowModel,
} from "./model";
import type { RunwayState } from "./status";
import type { SegmentRole } from "./roles";

const V2_NOW = 1_000_000_000_000;
const V2_MIN = 60_000;

const v2FormatTime = (ms: number) => "T" + ms;

function makeRow(label: string, opts: Partial<QuotaRow> & { unit?: number } = {}): ModelRow {
  const r: ModelRow = {
    label,
    usage: opts.usage ?? null,
    limit: opts.limit ?? null,
    percent: opts.percent ?? null,
    resetAt: opts.resetAt ?? null,
  };
  if (opts.unit !== undefined) r.unit = opts.unit;
  return r;
}

function makeRunway(
  state: RunwayState,
  runwayMs: number | null,
  resetInMs: number | null,
  spanMs: number | null = 600_000,
): { result: RunwayResult; spanMs: number | null } {
  return { result: { state, runwayMs, resetInMs, spanMs }, spanMs };
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
    now: V2_NOW,
    intervalMs: V2_MIN,
    tightFactor: 1.5,
    gaugeWidth: 16,
    formatTime: v2FormatTime,
    ...overrides,
  };
}

const v2Row5h = () =>
  makeRow("5h", { usage: 312, limit: 500, percent: 62.4, resetAt: V2_NOW + 72 * V2_MIN, unit: 3 });
const v2Row7d = () =>
  makeRow("7d", { usage: 4_100_000, limit: 10_000_000, percent: 41, resetAt: V2_NOW + 273_600_000, unit: 6 });
const v2OkRunways = () => ({
  "5h": makeRunway("ok", 7_500_000, 72 * V2_MIN),
  "7d": makeRunway("ok", 900_000_000, 273_600_000),
});

function build(name: string, input: ModelInput): { name: string; panel: V2PanelModel; chip: ChipModel } {
  return { name, panel: buildPanel(input), chip: buildChip(input) };
}

/** Scenario matrix mirroring model.test.ts goldens, rebuilt inline (no cross-test imports). */
function v2Scenarios(): { name: string; panel: V2PanelModel; chip: ChipModel }[] {
  return [
    build("ok", makeInput({ rows: [v2Row5h(), v2Row7d()], runways: v2OkRunways(), level: "max", updatedAt: V2_NOW - 30_000 })),
    build(
      "tight",
      makeInput({ rows: [v2Row5h(), v2Row7d()], runways: { ...v2OkRunways(), "5h": makeRunway("ok", 5_400_000, 72 * V2_MIN) }, updatedAt: V2_NOW - 30_000 }),
    ),
    build(
      "short",
      makeInput({ rows: [v2Row5h(), v2Row7d()], runways: { ...v2OkRunways(), "5h": makeRunway("ok", 2_100_000, 72 * V2_MIN) }, updatedAt: V2_NOW - 30_000 }),
    ),
    build(
      "blocked",
      makeInput({
        rows: [makeRow("5h", { usage: 500, limit: 500, percent: 100, resetAt: V2_NOW + 42 * V2_MIN, unit: 3 })],
        runways: {},
        updatedAt: V2_NOW - 30_000,
      }),
    ),
    build("stale", makeInput({ rows: [v2Row5h(), v2Row7d()], runways: v2OkRunways(), updatedAt: V2_NOW - 3 * V2_MIN })),
    build("error", makeInput({ rows: [], error: "no-token" })),
    build("loading", makeInput({ rows: [], updating: true })),
  ];
}

// Hand-built grid fixtures (independent of model.ts — grid layout is a
// render concern; model strings are frozen inputs here).

const w5h = (): WindowModel => ({
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
});

const w7d = (): WindowModel => ({
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
});

const hdr = (over: Partial<V2PanelModel["header"]> = {}): V2PanelModel["header"] => ({
  title: "ZAI RUNWAY",
  level: null,
  freshness: "30s ago",
  stale: false,
  updating: false,
  ...over,
});

const panelOf = (windows: WindowModel[], header: V2PanelModel["header"] = hdr()): V2PanelModel => ({
  header,
  error: null,
  windows,
});

const ERROR_CODE_CASES: Record<string, string> = {
  "no-token": "no token (zai login or ZAI_TOKEN)",
  network: "network error",
  "bad-json": "bad response",
  timeout: "timeout",
  empty: "no data",
  "http-429": "HTTP 429",
  "http-503": "HTTP 503",
  "mystery-code": "mystery-code",
};

const join = (segs: readonly Segment[]): string => segs.map((s) => s.text).join("");

const TOKENS: readonly SegmentRole[] = ["text", "textMuted", "success", "warning", "error"];

function assertSegmentsValid(segs: readonly Segment[], ctx: string): void {
  if (segs.length === 0) throw new Error(`${ctx}: expected at least one segment`);
  for (const s of segs) {
    if (typeof s.text !== "string") throw new Error(`${ctx}: segment.text is not a string: ${JSON.stringify(s)}`);
    if (!TOKENS.includes(s.role)) throw new Error(`${ctx}: segment.role "${String(s.role)}" not in the 5 tokens`);
  }
}

describe("V2 VERDICT_GLYPH", () => {
  test("unicode map is exact", () => {
    expect(VERDICT_GLYPH.unicode).toEqual({ ok: "✓", tight: "!", short: "!!", blocked: "✗", unknown: "?", error: "?" });
  });

  test("ascii map is exact", () => {
    expect(VERDICT_GLYPH.ascii).toEqual({ ok: "ok", tight: "!", short: "!!", blocked: "xx", unknown: "?", error: "?" });
  });
});

describe("V2 barCells", () => {
  const PCTS = [null, 0, 5, 50, 62.4, 99.9, 100, 150, -10];
  const WIDTHS = [1, 4, 16, 40];

  test("unicode: cells length === width for every pct/width combination", () => {
    for (const width of WIDTHS) {
      for (const pct of PCTS) {
        const { cells } = barCells(pct, null, width, "unicode");
        if (cells.length !== width) throw new Error(`unicode pct=${String(pct)} width=${width}: got ${cells.length}`);
      }
    }
  });

  test("ascii: cells length === width for every pct/width combination", () => {
    for (const width of WIDTHS) {
      for (const pct of PCTS) {
        const { cells } = barCells(pct, null, width, "ascii");
        if (cells.length !== width) throw new Error(`ascii pct=${String(pct)} width=${width}: got ${cells.length}`);
      }
    }
  });

  test("unicode charset is only fill/partial/empty glyphs", () => {
    for (const pct of PCTS) {
      expect(barCells(pct, null, 16, "unicode").cells).toMatch(/^[█░▏▎▍▌▋▊▉]*$/);
    }
  });

  test("ascii charset is only # and - (plus embedded | marker): no partial glyphs", () => {
    for (const pct of PCTS) {
      expect(barCells(pct, null, 16, "ascii").cells).toMatch(/^[#-]*$/);
    }
  });

  test("clamping: 150 renders identically to 100, -10 to 0 (both modes)", () => {
    for (const mode of ["unicode", "ascii"] as GlyphMode[]) {
      expect(barCells(150, null, 16, mode).cells).toBe(barCells(100, null, 16, mode).cells);
      expect(barCells(-10, null, 16, mode).cells).toBe(barCells(0, null, 16, mode).cells);
    }
  });

  test("null fill: all empty cells in both modes", () => {
    expect(barCells(null, null, 12, "unicode").cells).toBe("░".repeat(12));
    expect(barCells(null, null, 12, "ascii").cells).toBe("-".repeat(12));
  });

  test("unicode: markerCell is a passthrough, NOT embedded in cells", () => {
    const { cells, markerCell } = barCells(50, 7, 16, "unicode");
    expect(markerCell).toBe(7);
    expect(cells).not.toContain("|");
    expect(cells[7]).toBe("█"); // 50% of 16 = 8 full cells, index 7 is filled
  });

  test("ascii: marker IS embedded as | at the index", () => {
    const { cells, markerCell } = barCells(50, 7, 16, "ascii");
    expect(markerCell).toBe(7);
    expect(cells[7]).toBe("|");
    // 50% of 16 = exactly 8 full cells (indices 0..7): the marker overwrites a '#'.
    expect(cells).toBe("#######" + "|" + "--------");
    expect(cells.length).toBe(16);
  });

  test("out-of-bounds marker in ascii is not embedded (no crash, width kept)", () => {
    const { cells } = barCells(50, 99, 16, "ascii");
    expect(cells).toMatch(/^[#-]*$/);
    expect(cells.length).toBe(16);
  });

  test("62.4% at width 16: 9 full + heaviest partial + 6 empty (matches legacy gauge math)", () => {
    expect(barCells(62.4, null, 16, "unicode").cells).toBe("█████████▉" + "░".repeat(6));
    expect(barCells(62.4, null, 16, "ascii").cells).toBe("#########" + "-".repeat(7));
  });
});

// ===========================================================================
// GRID geometry + canonical golden block
// ===========================================================================

describe("V2 GRID", () => {
  test("geometry is pinned: 38 cols, label 0, bar 4(+16), pct 21(+4), usage 26(+9), verdict 36(+2)", () => {
    expect(GRID).toEqual({
      width: 38,
      label: 0,
      bar: 4,
      barWidth: 16,
      pct: 21,
      pctWidth: 4,
      usage: 26,
      usageWidth: 9,
      verdict: 36,
      verdictWidth: 2,
    });
  });

  test("fixed columns tile the width exactly: 4 + 16 + 1+4 + 1+9 + 1+2 === 38", () => {
    expect(GRID.label + 3 + 1).toBe(GRID.bar);
    expect(GRID.bar + GRID.barWidth).toBe(20);
    expect(GRID.pct + GRID.pctWidth).toBe(25);
    expect(GRID.usage + GRID.usageWidth).toBe(35);
    expect(GRID.verdict + GRID.verdictWidth).toBe(GRID.width);
  });
});

describe("V2 golden: canonical 5-line block (grid 38, unicode)", () => {
  const CANONICAL = [
    "ZAI RUNWAY              Lite · 30s ago",
    "5h  █████████▉░░│░░░  62%   312/500  ✓",
    "reset 1h 12m · runway ~2h 5m",
    "7d  ██████▌░│░░░░░░░  41%  4.1M/10M  ✓",
    "reset 3d 4h · runway ~10d",
  ];

  const panel = panelOf([w5h(), w7d()], hdr({ level: "Lite" }));

  test("renderPanelLines joins to the canonical block EXACTLY", () => {
    const lines = renderPanelLines(panel, { gaugeWidth: 16, mode: "unicode" });
    expect(lines.map(join)).toEqual(CANONICAL);
  });

  test("window line segments: label+gap prefix, marker split trio, pct, usage, verdict roles", () => {
    const segs = renderWindowLine(w5h(), 16, "unicode");
    expect(join(segs)).toBe(CANONICAL[1]);
    expect(segs.map((s) => s.role)).toEqual(["textMuted", "success", "text", "success", "text", "textMuted", "success"]);
  });

  test("header segments: padded title (text) + right-flush suffix (textMuted)", () => {
    const segs = renderHeader(hdr({ level: "Lite" }), "unicode");
    expect(segs).toHaveLength(2);
    expect(segs[0]).toEqual({ text: "ZAI RUNWAY".padEnd(38 - "Lite · 30s ago".length), role: "text" });
    expect(segs[1]).toEqual({ text: "Lite · 30s ago", role: "textMuted" });
  });

  test("detail segments: reset (textMuted) + ' · ' + runway (verdict role)", () => {
    const segs = renderDetailLine(w5h(), "unicode");
    expect(join(segs)).toBe(CANONICAL[2]);
    expect(segs.map((s) => s.role)).toEqual(["textMuted", "success"]);
  });
});

// ===========================================================================
// Column invariants across the scenario × mode matrix
// ===========================================================================

describe("V2 column invariants (scenario matrix × modes)", () => {
  const scenarios: { name: string; w: WindowModel }[] = [
    { name: "ok", w: w5h() },
    { name: "tight", w: { ...w5h(), verdict: "tight" } },
    {
      name: "short",
      w: { ...w5h(), verdict: "short", runwayText: "runway ~35m", shortfallText: "(37m short)" },
    },
    {
      name: "blocked",
      w: {
        ...w5h(),
        fillPercent: 100,
        markerIndex: null,
        verdict: "blocked",
        percentText: "100%",
        usageText: "500",
        limitText: "500",
        runwayText: "limit reached",
        backText: "back at 09:42",
      },
    },
    { name: "stale", w: { ...w5h(), verdict: "unknown" } },
  ];

  test("label@0, bar@4, pct ends 24, usage ends 34, verdict ends 37 (both modes)", () => {
    for (const { name, w } of scenarios) {
      for (const mode of ["unicode", "ascii"] as GlyphMode[]) {
        const line = join(renderWindowLine(w, 16, mode));
        const ctx = `${name}/${mode}`;
        // label: cols 0-2 padEnd(3) + gap col 3
        if (!line.startsWith(w.label.slice(0, 3).padEnd(3) + " ")) {
          throw new Error(`${ctx}: line does not start with padded label + gap: ${JSON.stringify(line)}`);
        }
        // bar first char at col 4
        const firstBar = line[GRID.bar];
        const okFirst = mode === "unicode" ? /[█░▏▎▍▌▋▊▉│]/.test(firstBar) : /[#\-|]/.test(firstBar);
        if (!okFirst) throw new Error(`${ctx}: col 4 is not a bar cell: ${JSON.stringify(firstBar)}`);
        // pct: padStart(4) ending at col 24
        if (line.slice(GRID.pct, GRID.pct + GRID.pctWidth) !== w.percentText.padStart(GRID.pctWidth)) {
          throw new Error(`${ctx}: pct field ${JSON.stringify(line.slice(GRID.pct, 25))} != ${JSON.stringify(w.percentText.padStart(4))}`);
        }
        // usage: padStart(9) ending at col 34 when present, line pinned at 38
        const pair = `${w.usageText}/${w.limitText}`;
        if (pair.length <= GRID.usageWidth) {
          if (line.slice(GRID.usage, GRID.usage + GRID.usageWidth) !== pair.padStart(GRID.usageWidth)) {
            throw new Error(`${ctx}: usage field mismatch: ${JSON.stringify(line.slice(GRID.usage, 35))}`);
          }
          if (line.length !== GRID.width) throw new Error(`${ctx}: line length ${line.length} != 38`);
        } else if (line.includes("/")) {
          throw new Error(`${ctx}: oversized usage pair was not dropped`);
        }
        // verdict: padStart(2) ending at col 37
        const glyph = VERDICT_GLYPH[mode][w.verdict];
        if (!line.endsWith(glyph) || line.slice(GRID.verdict, GRID.width) !== glyph.padStart(GRID.verdictWidth)) {
          throw new Error(`${ctx}: verdict field mismatch: ${JSON.stringify(line.slice(GRID.verdict))}`);
        }
      }
    }
  });
});

// ===========================================================================
// Width property: worst cases never exceed the grid
// ===========================================================================

describe("V2 width property: worst cases fit 38", () => {
  const worst = (usageText: string, limitText: string): WindowModel => ({
    ...w5h(),
    label: "abc",
    percentText: "999%",
    usageText,
    limitText,
    verdict: "short",
  });

  test("9-char usage pair kept: exactly 38", () => {
    for (const mode of ["unicode", "ascii"] as GlyphMode[]) {
      const line = join(renderWindowLine(worst("9999", "9999"), 16, mode));
      expect(line.length).toBe(38);
      expect(line.slice(GRID.usage, 35)).toBe("9999/9999");
    }
  });

  test("11-char usage pair auto-dropped: exactly 28, no slash", () => {
    for (const mode of ["unicode", "ascii"] as GlyphMode[]) {
      const line = join(renderWindowLine(worst("12345", "6789"), 16, mode));
      expect(line.length).toBe(28);
      expect(line).not.toContain("/");
      expect(line.endsWith("!!")).toBe(true);
    }
  });

  test("explicit dropUsage: 28 (compatibility rung, same as auto rule)", () => {
    const line = join(renderWindowLine(worst("9999", "9999"), 16, "unicode", { dropUsage: true }));
    expect(line.length).toBe(28);
    expect(line).not.toContain("/");
  });

  test("header worst cases never exceed 38", () => {
    // 24-char level forces the level-drop rung; freshness-only never dropped.
    const long = renderHeader(hdr({ level: "a".repeat(24), freshness: "stale · 99h ago", stale: true }), "unicode");
    expect(join(long).length).toBe(38);
    expect(join(long)).not.toContain("aaaa");
    const updating = renderHeader(hdr({ level: "a".repeat(24), updating: true }), "unicode");
    expect(join(updating).length).toBe(38);
    expect(join(updating)).not.toContain("aaaa");
  });

  test("detail ladder floors at runway-only: never wider than its parts allow", () => {
    const extreme: WindowModel = {
      ...w5h(),
      resetText: "r".repeat(30),
      runwayText: "runway ~35m",
    };
    const line = join(renderDetailLine(extreme, "unicode"));
    expect(line).toBe("runway ~35m");
    expect(line.length).toBeLessThanOrEqual(GRID.width);
  });
});

// ===========================================================================
// Header variants (right-aligned suffix + ladder)
// ===========================================================================

describe("V2 renderHeader variants", () => {
  test("null level: title padEnd + freshness right-flush to col 37", () => {
    const segs = renderHeader(hdr(), "unicode");
    expect(join(segs)).toBe("ZAI RUNWAY".padEnd(38 - "30s ago".length) + "30s ago");
    expect(join(segs).length).toBe(38);
    expect(join(segs).endsWith("30s ago")).toBe(true);
    expect(segs.map((s) => s.role)).toEqual(["text", "textMuted"]);
  });

  test("level present: suffix is `level · freshness`, ends at col 37", () => {
    const segs = renderHeader(hdr({ level: "Lite" }), "unicode");
    expect(join(segs)).toBe("ZAI RUNWAY              Lite · 30s ago");
    expect(join(segs).length).toBe(38);
  });

  test("ladder rung 1: 24-char level + 'stale · 99h ago' drops the level, keeps stale freshness", () => {
    const segs = renderHeader(hdr({ level: "a".repeat(24), freshness: "stale · 99h ago", stale: true }), "unicode");
    expect(join(segs)).toBe("ZAI RUNWAY             stale · 99h ago");
    expect(join(segs).length).toBe(38);
    expect(segs[1].role).toBe("warning");
  });

  test("ladder rung 2: freshness-only still too long drops the leading 'stale · ' (age kept, title kept)", () => {
    // 8 + 31 = 39-char freshness alone: 10+1+39 > 38 -> strip "stale · ", keep the age.
    const freshness = "stale · 9" + "9".repeat(30);
    expect(freshness.length).toBe(39);
    const segs = renderHeader(hdr({ freshness, stale: true }), "unicode");
    expect(join(segs)).toBe("ZAI RUNWAY " + "9".repeat(27)); // age kept up to the 27-col budget, hard floor truncates (review nit fix)
    expect(segs[1].role).toBe("warning"); // model stale flag still colors the suffix
  });

  test("freshness-only 8ch is never dropped ('just now')", () => {
    const segs = renderHeader(hdr({ freshness: "just now" }), "unicode");
    expect(join(segs)).toBe("ZAI RUNWAY".padEnd(30) + "just now");
    expect(join(segs).endsWith("just now")).toBe(true);
    expect(join(segs).length).toBe(38);
  });

  test("updating: suffix = 'updating ...' (3-dot literal in unicode too), warning role, right-flush", () => {
    const segs = renderHeader(hdr({ updating: true }), "unicode");
    expect(join(segs)).toBe("ZAI RUNWAY".padEnd(38 - "updating ...".length) + "updating ...");
    expect(join(segs).length).toBe(38);
    expect(segs.map((s) => s.role)).toEqual(["text", "warning"]);
    expect(join(segs)).not.toContain("…");
  });

  test("updating + level: suffix = 'level · updating ...'", () => {
    const segs = renderHeader(hdr({ level: "max", updating: true }), "unicode");
    expect(join(segs)).toBe("ZAI RUNWAY".padEnd(20) + "max · updating ...");
    expect(segs[1].role).toBe("warning");
  });

  test("stale: freshness segment gets warning role", () => {
    const segs = renderHeader(hdr({ stale: true, freshness: "stale · 3m ago" }), "unicode");
    expect(join(segs)).toBe("ZAI RUNWAY              stale · 3m ago");
    expect(segs[1].role).toBe("warning");
  });

  test("ascii: '·' mapped to '-', '—' mapped to '-', still right-flush", () => {
    const stale = renderHeader(hdr({ stale: true, freshness: "stale · 3m ago" }), "ascii");
    expect(join(stale)).toBe("ZAI RUNWAY              stale - 3m ago");
    const noTs = renderHeader(hdr({ freshness: "—" }), "ascii");
    expect(join(noTs)).toBe("ZAI RUNWAY".padEnd(37) + "-");
    expect(join(noTs).length).toBe(38);
  });
});

// ===========================================================================
// Detail line: auto-fit ladder (fixed 38, no explicit drop opts)
// ===========================================================================

describe("V2 renderDetailLine auto-fit ladder", () => {
  test("short with shortfall at 39 chars: shortfall dropped (26-char line)", () => {
    const w: WindowModel = {
      ...w5h(),
      verdict: "short",
      runwayText: "runway ~35m",
      shortfallText: "(37m short)",
    };
    // reset(12) + " · "(3) + runway(11) + "  "(2) + shortfall(11) = 39 > 38
    expect(`reset 1h 12m · runway ~35m  (37m short)`.length).toBe(39);
    const segs = renderDetailLine(w, "unicode");
    expect(join(segs)).toBe("reset 1h 12m · runway ~35m");
    expect(join(segs).length).toBe(26);
    expect(segs.map((s) => s.role)).toEqual(["textMuted", "error"]);
  });

  test("36-char detail keeps shortfall (fits)", () => {
    const w: WindowModel = {
      ...w5h(),
      resetText: "reset 42m",
      verdict: "short",
      runwayText: "runway ~35m",
      shortfallText: "(37m short)",
    };
    expect(join(renderDetailLine(w, "unicode"))).toBe("reset 42m · runway ~35m  (37m short)");
  });

  test("blocked with back at 41 chars: back dropped (25-char line)", () => {
    const w: WindowModel = {
      ...w5h(),
      resetText: "reset 42m",
      verdict: "blocked",
      runwayText: "limit reached",
      backText: "back at 09:42",
    };
    expect(`reset 42m · limit reached · back at 09:42`.length).toBe(41);
    const segs = renderDetailLine(w, "unicode");
    expect(join(segs)).toBe("reset 42m · limit reached");
    expect(join(segs)).not.toContain("back at");
    expect(segs.map((s) => s.role)).toEqual(["textMuted", "error"]);
  });

  test("floor: long reset drops to runway-only with no dangling separator", () => {
    const w: WindowModel = { ...w5h(), resetText: "r".repeat(30), runwayText: "runway ~35m" };
    const segs = renderDetailLine(w, "unicode");
    expect(join(segs)).toBe("runway ~35m");
    expect(segs).toEqual([{ text: "runway ~35m", role: "success" }]);
  });

  test("no-burn runway inherits success role; unknown inherits textMuted", () => {
    expect(renderDetailLine({ ...w5h(), runwayText: "runway ∞" }, "unicode")[1].role).toBe("success");
    expect(renderDetailLine({ ...w5h(), verdict: "unknown", runwayText: "runway …" }, "unicode")[1].role).toBe("textMuted");
  });
});

// ===========================================================================
// Window line options
// ===========================================================================

describe("V2 renderWindowLine options", () => {
  const shortWin: WindowModel = { ...w5h(), verdict: "short" };

  test("null marker renders a single bar segment, grid intact", () => {
    const segs = renderWindowLine({ ...shortWin, markerIndex: null }, 16, "unicode");
    expect(join(segs)).toBe("5h  █████████▉░░░░░░  62%   312/500 !!");
    expect(segs).toHaveLength(5);
  });

  test("marker 0 / width-1 split: edge-empty bar segments, joined bar stays 16", () => {
    const atZero = renderWindowLine({ ...shortWin, markerIndex: 0 }, 16, "unicode");
    expect(atZero[1]).toEqual({ text: "", role: "error" }); // short verdict colors the bar
    expect(join(atZero)).toBe("5h  │████████▉░░░░░░  62%   312/500 !!");
    const atLast = renderWindowLine({ ...shortWin, markerIndex: 15 }, 16, "unicode");
    expect(atLast[3]).toEqual({ text: "", role: "error" });
    expect(join(atLast)).toBe("5h  █████████▉░░░░░│  62%   312/500 !!");
  });

  test("label longer than 3 is truncated into the label cell", () => {
    const segs = renderWindowLine({ ...shortWin, label: "30d window" }, 16, "unicode");
    expect(join(segs)).toBe("30d █████████▉░░│░░░  62%   312/500 !!");
    expect(join(segs).length).toBe(38);
  });
});

// ===========================================================================
// ASCII grid parity
// ===========================================================================

describe("V2 ascii grid parity", () => {
  test("ascii window line: same columns, 'ok' verdict padStart(2), embedded | marker", () => {
    const segs = renderWindowLine(w5h(), 16, "ascii");
    expect(join(segs)).toBe("5h  #########---|---  62%   312/500 ok");
    expect(join(segs).length).toBe(38);
    expect(segs.map((s) => s.role)).toEqual(["textMuted", "success", "text", "textMuted", "success"]);
    expect(join(segs)[4]).toBe("#");
  });

  test("ascii panel block: header/detail asciified, grid lengths identical", () => {
    const lines = renderPanelLines(panelOf([w5h(), w7d()], hdr({ level: "Lite" })), { gaugeWidth: 16, mode: "ascii" });
    expect(lines.map(join)).toEqual([
      "ZAI RUNWAY              Lite - 30s ago",
      "5h  #########---|---  62%   312/500 ok",
      "reset 1h 12m - runway ~2h 5m",
      "7d  ######--|-------  41%  4.1M/10M ok",
      "reset 3d 4h - runway ~10d",
    ]);
    for (const [i, line] of lines.entries()) {
      if (/[^\x00-\x7f]/.test(join(line))) throw new Error(`line ${i}: non-ASCII in ascii mode`);
    }
  });
});

// ===========================================================================
// renderPanelLines structure + error/loading surfaces
// ===========================================================================

describe("V2 renderPanelLines structure", () => {
  test("ok scenario: header + two grid lines per window, nothing degraded at 38", () => {
    const lines = renderPanelLines(panelOf([w5h(), w7d()], hdr({ level: "max" })), { gaugeWidth: 16, mode: "unicode" });
    expect(lines).toHaveLength(5);
    expect(join(lines[0])).toBe("ZAI RUNWAY".padEnd(25) + "max · 30s ago");
    expect(join(lines[1])).toBe("5h  █████████▉░░│░░░  62%   312/500  ✓");
    expect(join(lines[2])).toBe("reset 1h 12m · runway ~2h 5m");
    expect(join(lines[3])).toBe("7d  ██████▌░│░░░░░░░  41%  4.1M/10M  ✓");
    expect(join(lines[4])).toBe("reset 3d 4h · runway ~10d");
    expect(join(lines[0]).length).toBe(38);
  });

  test("loading: header + single muted 'loading…' line; updating suffix right-flush", () => {
    const panel = buildPanel(makeInput({ rows: [], updating: true }));
    const lines = renderPanelLines(panel, { gaugeWidth: 16, mode: "unicode" });
    expect(lines).toHaveLength(2);
    expect(lines[1]).toEqual([{ text: "loading…", role: "textMuted" }]);
    expect(join(lines[0])).toBe("ZAI RUNWAY".padEnd(26) + "updating ...");
    expect(lines[0][1]).toEqual({ text: "updating ...", role: "warning" });
  });

  test("error: header + single error line per taxonomy code", () => {
    for (const [code, text] of Object.entries(ERROR_CODE_CASES)) {
      const panel = buildPanel(makeInput({ rows: [], error: code }));
      const lines = renderPanelLines(panel, { gaugeWidth: 16, mode: "unicode" });
      expect(lines).toHaveLength(2);
      expect(lines[1]).toEqual([{ text, role: "error" }]);
    }
  });

  test("targetWidth defaults to GRID.width (38) when omitted", () => {
    const panel = panelOf([w5h()]);
    const withDefault = renderPanelLines(panel, { gaugeWidth: 16, mode: "unicode" });
    const explicit = renderPanelLines(panel, { gaugeWidth: 16, mode: "unicode", targetWidth: GRID.width });
    expect(withDefault).toEqual(explicit);
  });

  test("targetWidth > 38 keeps the grid as-is (no measurement drops at 40)", () => {
    const lines = renderPanelLines(panelOf([w5h()]), { gaugeWidth: 16, mode: "unicode", targetWidth: 40 });
    expect(join(lines[1])).toBe("5h  █████████▉░░│░░░  62%   312/500  ✓");
    expect(join(lines[1]).length).toBe(38);
  });

  test("targetWidth < 38: usage dropped when the grid line exceeds the target", () => {
    const lines = renderPanelLines(panelOf([w5h()]), { gaugeWidth: 16, mode: "unicode", targetWidth: 30 });
    const line = join(lines[1]);
    expect(line).toBe("5h  █████████▉░░│░░░  62%  ✓");
    expect(line.length).toBe(28);
    expect(line).not.toContain("/");
  });

  test("targetWidth 24: usage rung is idempotent (percent/verdict never dropped)", () => {
    const lines = renderPanelLines(panelOf([w5h()]), { gaugeWidth: 16, mode: "unicode", targetWidth: 24 });
    expect(join(lines[1])).toBe("5h  █████████▉░░│░░░  62%  ✓");
  });
});

// ===========================================================================
// ERROR_TEXT compaction
// ===========================================================================

describe("V2 ERROR_TEXT compact map", () => {
  test("every taxonomy text is <= 36 chars (fits the 38-col grid)", () => {
    for (const text of Object.values(ERROR_CODE_CASES)) {
      expect(text.length).toBeLessThanOrEqual(36);
    }
  });

  test("no-token exact string", () => {
    const panel = buildPanel(makeInput({ rows: [], error: "no-token" }));
    expect(renderPanelLines(panel, { gaugeWidth: 16, mode: "unicode" })[1]).toEqual([
      { text: "no token (zai login or ZAI_TOKEN)", role: "error" },
    ]);
  });
});

// ===========================================================================
// Degradation monotonicity (grid semantics)
// ===========================================================================

describe("V2 degradation monotonicity (grid)", () => {
  const shortWin: WindowModel = {
    ...w5h(),
    resetText: "reset 1h 12m",
    verdict: "short",
    runwayText: "runway ~35m",
    shortfallText: "(37m short)",
  };

  test("widths 40>38>30>24: line lengths non-increasing, runway never dropped, role stable", () => {
    const widths = [40, 38, 30, 24];
    const winLens: number[] = [];
    const detLens: number[] = [];
    for (const targetWidth of widths) {
      const lines = renderPanelLines(panelOf([shortWin]), { gaugeWidth: 16, mode: "unicode", targetWidth });
      for (const line of lines) assertSegmentsValid(line, `ladder w=${targetWidth}`);
      winLens.push(join(lines[1]).length);
      detLens.push(join(lines[2]).length);
      const runwaySeg = lines[2].find((s) => s.text.includes("runway ~35m"));
      if (runwaySeg == null) throw new Error(`w=${targetWidth}: runway segment dropped (ladder must keep it)`);
      if (runwaySeg.role !== VERDICT_ROLE.short) {
        throw new Error(`w=${targetWidth}: runway role ${runwaySeg.role}, expected ${VERDICT_ROLE.short}`);
      }
    }
    for (let i = 1; i < widths.length; i++) {
      if (winLens[i] > winLens[i - 1]) {
        throw new Error(`window length grew ${winLens[i - 1]}->${winLens[i]} narrowing ${widths[i - 1]}->${widths[i]}`);
      }
      if (detLens[i] > detLens[i - 1]) {
        throw new Error(`detail length grew ${detLens[i - 1]}->${detLens[i]} narrowing ${widths[i - 1]}->${widths[i]}`);
      }
    }
    expect(winLens).toEqual([38, 38, 28, 28]);
  });
});

describe("V2 renderChipSegments", () => {
  test("normal chip: zai · values · verdict glyph (unicode)", () => {
    const segs = renderChipSegments({ values: ["62%", "41%"], verdict: "ok" }, "unicode");
    expect(segs.map((s) => s.text)).toEqual([" zai ", "62%", "·", "41%", " ✓"]);
    expect(segs.map((s) => s.role)).toEqual(["textMuted", "text", "textMuted", "text", "success"]);
  });

  test("short chip: '!!' glyph with error role; ascii blocked chip: 'xx'", () => {
    expect(renderChipSegments({ values: ["62%", "41%"], verdict: "short" }, "unicode")[4]).toEqual({ text: " !!", role: "error" });
    expect(renderChipSegments({ values: ["62%", "41%"], verdict: "blocked" }, "ascii")[4]).toEqual({ text: " xx", role: "error" });
  });

  test("ascii ok chip uses 'ok' glyph", () => {
    expect(renderChipSegments({ values: ["62%", "41%"], verdict: "ok" }, "ascii")[4]).toEqual({ text: " ok", role: "success" });
  });

  test("error chip collapses to a single muted segment", () => {
    expect(renderChipSegments({ values: [], verdict: "error" }, "unicode")).toEqual([{ text: " zai:? ", role: "textMuted" }]);
  });

  test("loading chip (empty values, non-error verdict): muted ' zai …'", () => {
    expect(renderChipSegments({ values: [], verdict: "unknown" }, "unicode")).toEqual([{ text: " zai …", role: "textMuted" }]);
  });
});

describe("V2 FG-INVARIANT: every segment from the full matrix uses the 5 tokens", () => {
  test("scenario matrix x modes x widths (incl. degraded paths) x panel+chip", () => {
    const scenarios = [
      ...v2Scenarios(),
      // Error taxonomy variants exercise every errorText branch through the panel renderer.
      ...Object.keys(ERROR_CODE_CASES).map((code) => build(code, makeInput({ rows: [], error: code }))),
    ];
    for (const { name, panel, chip } of scenarios) {
      for (const mode of ["unicode", "ascii"] as GlyphMode[]) {
        for (const targetWidth of [40, 38, 30, 24]) {
          const lines = renderPanelLines(panel, { gaugeWidth: 16, mode, targetWidth });
          if (lines.length === 0) throw new Error(`${name}/${mode}/${targetWidth}: no lines`);
          for (const line of lines) assertSegmentsValid(line, `${name}/${mode}/${targetWidth} panel line`);
          assertSegmentsValid(renderChipSegments(chip, mode), `${name}/${mode} chip`);
        }
      }
    }
  });
});

describe("V2 contrast fixtures (WCAG relative luminance)", () => {
  const srgbChannel = (c: number): number => {
    const s = c / 255;
    return s <= 0.04045 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4);
  };
  const relLuminance = (hex: string): number => {
    const r = parseInt(hex.slice(1, 3), 16);
    const g = parseInt(hex.slice(3, 5), 16);
    const b = parseInt(hex.slice(5, 7), 16);
    return 0.2126 * srgbChannel(r) + 0.7152 * srgbChannel(g) + 0.0722 * srgbChannel(b);
  };
  const contrastRatio = (fg: string, bg: string): number => {
    const l1 = relLuminance(fg);
    const l2 = relLuminance(bg);
    const hi = Math.max(l1, l2);
    const lo = Math.min(l1, l2);
    return (hi + 0.05) / (lo + 0.05);
  };

  const SOLARIZED_LIGHT = {
    text: "#657b83",
    textMuted: "#586e75",
    success: "#859900",
    warning: "#cb4b16",
    error: "#dc322f",
    bg: "#fdf6e3",
  };
  const DARK = {
    text: "#93a1a1",
    textMuted: "#839496",
    success: "#859900",
    warning: "#b58900",
    error: "#dc322f",
    bg: "#002b36",
  };
  const ROLES = ["text", "textMuted", "success", "warning", "error"] as const;

  for (const fixtureName of ["SOLARIZED_LIGHT", "DARK"] as const) {
    const fixture = fixtureName === "SOLARIZED_LIGHT" ? SOLARIZED_LIGHT : DARK;
    for (const role of ROLES) {
      // FINDING (reported to team lead, fixtures deliberately unchanged):
      // SOLARIZED_LIGHT success #859900 on #fdf6e3 measures 2.970 < 3.0.
      // Encoded as test.failing: trips (turns red) once the palette is fixed.
      if (fixtureName === "SOLARIZED_LIGHT" && role === "success") continue;
      test(`${fixtureName} ${role} on bg >= 3.0`, () => {
        expect(contrastRatio(fixture[role], fixture.bg)).toBeGreaterThanOrEqual(3);
      });
    }
  }

  test.failing("FINDING: SOLARIZED_LIGHT success #859900 on #fdf6e3 is 2.970 (< 3.0)", () => {
    expect(contrastRatio(SOLARIZED_LIGHT.success, SOLARIZED_LIGHT.bg)).toBeGreaterThanOrEqual(3);
  });

  test("measured ratios: pin current values so drift is visible", () => {
    const measure = (fx: typeof SOLARIZED_LIGHT): Record<string, number> =>
      Object.fromEntries(ROLES.map((r) => [r, Number(contrastRatio(fx[r], fx.bg).toFixed(3))]));
    expect(measure(SOLARIZED_LIGHT)).toEqual({
      text: 4.13,
      textMuted: 4.989,
      success: 2.97,
      warning: 4.272,
      error: 4.288,
    });
    expect(measure(DARK)).toEqual({
      text: 5.614,
      textMuted: 4.748,
      success: 4.685,
      warning: 4.678,
      error: 3.246,
    });
  });
});

// ===========================================================================
// W2 audit additions: FG-invariant gaps, barCells adversarial edges, golden
// independent re-derivation, degradation-ladder monotonicity.
// ===========================================================================

describe("V2 W2 audit: FG-invariant gaps", () => {
  test("stale + updating header: updating wins, all lines/chips keep the 5 tokens across modes and widths", () => {
    const input = makeInput({
      rows: [v2Row5h(), v2Row7d()],
      runways: v2OkRunways(),
      updatedAt: V2_NOW - 3 * V2_MIN,
      updating: true,
    });
    const panel = buildPanel(input);
    expect(panel.header.stale).toBe(true);
    expect(panel.header.updating).toBe(true);
    const hdrSegs = renderHeader(panel.header, "unicode");
    expect(join(hdrSegs)).toBe("ZAI RUNWAY".padEnd(26) + "updating ...");
    expect(hdrSegs.map((s) => s.role)).toEqual(["text", "warning"]);
    for (const mode of ["unicode", "ascii"] as GlyphMode[]) {
      for (const targetWidth of [40, 38, 30, 24]) {
        const lines = renderPanelLines(panel, { gaugeWidth: 16, mode, targetWidth });
        for (const line of lines) assertSegmentsValid(line, `stale+updating/${mode}/${targetWidth}`);
      }
    }
    const chip = buildChip(input);
    expect(chip.verdict).toBe("unknown"); // stale forces unknown even while updating
    assertSegmentsValid(renderChipSegments(chip, "unicode"), "stale+updating chip");
    assertSegmentsValid(renderChipSegments(chip, "ascii"), "stale+updating chip ascii");
  });
});

describe("V2 W2 audit: barCells adversarial edges", () => {
  test("99.9% at width 16: 15 full + heaviest partial (idx 7), floor-only in ascii", () => {
    expect(barCells(99.9, null, 16, "unicode").cells).toBe("███████████████▉");
    expect(barCells(99.9, null, 16, "ascii").cells).toBe("###############-");
  });

  test("markerIndex 0: unicode passthrough, ascii embeds | at the first cell", () => {
    const u = barCells(62.4, 0, 16, "unicode");
    expect(u.markerCell).toBe(0);
    expect(u.cells).toBe("█████████▉░░░░░░"); // no | embedded
    const a = barCells(62.4, 0, 16, "ascii");
    expect(a.markerCell).toBe(0);
    expect(a.cells).toBe("|########-------");
    expect(a.cells).toHaveLength(16);
  });

  test("markerIndex width-1: split at the last cell keeps length (both modes, widths 16/4/40)", () => {
    expect(barCells(62.4, 15, 16, "ascii").cells).toBe("#########------|");
    for (const mode of ["unicode", "ascii"] as GlyphMode[]) {
      for (const width of [16, 4, 40]) {
        expect(barCells(62.4, width - 1, width, mode).cells).toHaveLength(width);
        expect(barCells(62.4, 0, width, mode).cells).toHaveLength(width);
      }
    }
  });
});

describe("V2 W2 audit: golden independent re-derivation (drift tripwire)", () => {
  test("frozen joined-line goldens re-derived from fill/split/grid formulas, not from render code", () => {
    // Independent reimplementation of the bar math + grid layout (does NOT
    // call barCells/renderWindowLine).
    const PARTIALS = ["", "▏", "▎", "▍", "▌", "▋", "▊", "▉"] as const;
    const fillCells = (pct: number, w: number, mode: GlyphMode): string => {
      const p = Math.min(100, Math.max(0, pct));
      if (mode === "ascii") {
        const full = Math.floor((w * p) / 100);
        return "#".repeat(full) + "-".repeat(w - full);
      }
      const f = (w * p) / 100;
      const full = Math.floor(f);
      const idx = f - full > 0 ? Math.min(7, Math.max(1, Math.round((f - full) * 8))) : 0;
      return "█".repeat(full) + PARTIALS[idx] + "░".repeat(w - full - (idx > 0 ? 1 : 0));
    };
    const bar = (pct: number, marker: number | null, w: number, mode: GlyphMode): string => {
      const cells = fillCells(pct, w, mode);
      if (marker == null || marker < 0 || marker >= w) return cells;
      const glyph = mode === "ascii" ? "|" : "│";
      return cells.slice(0, marker) + glyph + cells.slice(marker + 1);
    };
    const winLine = (w: WindowModel, mode: GlyphMode): string =>
      w.label.slice(0, 3).padEnd(3) +
      " " +
      bar(w.fillPercent as number, w.markerIndex, 16, mode) +
      " " +
      w.percentText.padStart(GRID.pctWidth) +
      " " +
      `${w.usageText}/${w.limitText}`.padStart(GRID.usageWidth) +
      " " +
      VERDICT_GLYPH[mode][w.verdict].padStart(GRID.verdictWidth);

    expect(winLine(w5h(), "unicode")).toBe("5h  █████████▉░░│░░░  62%   312/500  ✓");
    expect(winLine(w5h(), "ascii")).toBe("5h  #########---|---  62%   312/500 ok");
    expect(winLine(w7d(), "unicode")).toBe("7d  ██████▌░│░░░░░░░  41%  4.1M/10M  ✓");

    const shortW: WindowModel = { ...w5h(), verdict: "short", runwayText: "runway ~35m", shortfallText: "(37m short)" };
    expect(`reset 1h 12m · runway ~35m  (37m short)`.length).toBe(39);
    expect(join(renderDetailLine(shortW, "unicode"))).toBe("reset 1h 12m · runway ~35m");
  });
});

describe("V2 non-finite fillPercent (tester finding)", () => {
  test("NaN: all-empty cells in both modes, cells.length === width", () => {
    const u = barCells(NaN, null, 16, "unicode");
    expect(u.cells).toBe("░".repeat(16));
    expect(u.cells).toHaveLength(16);
    const a = barCells(NaN, null, 16, "ascii");
    expect(a.cells).toBe("-".repeat(16));
    expect(a.cells).toHaveLength(16);
  });

  test("Infinity and -Infinity: treated like null, all-empty cells in both modes", () => {
    for (const pct of [Infinity, -Infinity]) {
      expect(barCells(pct, null, 16, "unicode").cells).toBe("░".repeat(16));
      expect(barCells(pct, null, 16, "ascii").cells).toBe("-".repeat(16));
    }
  });
});

describe("review fix A1-1: ascii null/non-finite fill keeps the embedded marker", () => {
  test("null fill: marker embedded as | at the index, width kept", () => {
    const { cells, markerCell } = barCells(null, 5, 16, "ascii");
    expect(markerCell).toBe(5);
    expect(cells).toHaveLength(16);
    expect(cells[5]).toBe("|");
    expect(cells).toBe("-----|----------");
  });

  test("NaN fill: same embedded marker (non-finite joins the null branch)", () => {
    const { cells, markerCell } = barCells(NaN, 5, 16, "ascii");
    expect(markerCell).toBe(5);
    expect(cells).toBe("-----|----------");
    expect(cells).toHaveLength(16);
  });

  test("Infinity fill: marker embedded too; out-of-bounds marker still not embedded", () => {
    expect(barCells(Infinity, 0, 8, "ascii").cells).toBe("|-------");
    expect(barCells(-Infinity, 99, 8, "ascii").cells).toBe("--------");
  });

  test("unicode null fill: still a passthrough markerCell, no | in cells (contract unchanged)", () => {
    const { cells, markerCell } = barCells(null, 5, 16, "unicode");
    expect(markerCell).toBe(5);
    expect(cells).toBe("░".repeat(16));
    expect(cells).not.toContain("|");
  });
});

describe("review fix A2-2: ascii mode emits only 7-bit ASCII", () => {
  const noBurnPanel = buildPanel(
    makeInput({
      rows: [v2Row5h()],
      runways: { "5h": makeRunway("no-burn", null, 72 * V2_MIN) },
      updatedAt: V2_NOW - 30_000,
    }),
  );

  test("no-burn detail (ascii): 'runway inf', '·' separator becomes '-', no unicode literals", () => {
    const line = join(renderDetailLine(noBurnPanel.windows[0], "ascii"));
    expect(line).toBe("reset 1h 12m - runway inf");
    expect(line).not.toContain("∞");
    expect(line).not.toContain("·");
    expect(line).not.toContain("…");
    // Unicode mode is unchanged.
    expect(join(renderDetailLine(noBurnPanel.windows[0], "unicode"))).toBe("reset 1h 12m · runway ∞");
  });

  test("no-data runway (ascii): 'runway ...' with three dots", () => {
    const panel = buildPanel(
      makeInput({
        rows: [v2Row5h()],
        runways: { "5h": makeRunway("no-data", null, 72 * V2_MIN) },
        updatedAt: V2_NOW - 30_000,
      }),
    );
    expect(join(renderDetailLine(panel.windows[0], "ascii"))).toBe("reset 1h 12m - runway ...");
  });

  test("loading panel line (ascii): 'loading...' with three dots", () => {
    const panel = buildPanel(makeInput({ rows: [], updating: true }));
    const lines = renderPanelLines(panel, { gaugeWidth: 16, mode: "ascii" });
    expect(lines[1]).toEqual([{ text: "loading...", role: "textMuted" }]);
  });

  test("header updating (ascii): 'updating ...' right-flush, three dots", () => {
    const segs = renderHeader(hdr({ updating: true }), "ascii");
    expect(join(segs)).toBe("ZAI RUNWAY".padEnd(26) + "updating ...");
    expect(join(segs).length).toBe(38);
  });

  test("chip (ascii): separator '-', loading chip ' zai ...'", () => {
    const segs = renderChipSegments({ values: ["62%", "41%"], verdict: "ok" }, "ascii");
    expect(segs.map((s) => s.text)).toEqual([" zai ", "62%", "-", "41%", " ok"]);
    expect(join(renderChipSegments({ values: [], verdict: "unknown" }, "ascii"))).toBe(" zai ...");
  });

  test("ascii purity sweep: scenario matrix panel lines + chips contain only 7-bit ASCII", () => {
    for (const { name, panel, chip } of v2Scenarios()) {
      const lines = renderPanelLines(panel, { gaugeWidth: 16, mode: "ascii" });
      for (const line of lines) {
        const text = join(line);
        if (/[^\x00-\x7f]/.test(text)) throw new Error(`${name}: non-ASCII in ascii panel line: ${JSON.stringify(text)}`);
      }
      const chipText = join(renderChipSegments(chip, "ascii"));
      if (/[^\x00-\x7f]/.test(chipText)) throw new Error(`${name}: non-ASCII in ascii chip: ${JSON.stringify(chipText)}`);
    }
  });
});

// ===========================================================================
// Tester audit additions (zai-quota-grid-align): appended only, no source
// files touched. Short-label grid adversarials, header-ladder rung
// sequence, worst detail floor, day-cap grid guard, ascii parity columns.
// ===========================================================================
describe("tester audit: grid adversarial labels", () => {
  test("label 1 char ('x'): model passes it through, render padEnd keeps every column aligned, exactly 38", () => {
    const panel = buildPanel(
      makeInput({
        rows: [makeRow("x", { usage: 312, limit: 500, percent: 62.4, resetAt: V2_NOW + 72 * V2_MIN, unit: 3 })],
        runways: { x: makeRunway("ok", 7_500_000, 72 * V2_MIN) },
        updatedAt: V2_NOW - 30_000,
      }),
    );
    const w = panel.windows[0]!;
    expect(w.label).toBe("x"); // model emits the short label untouched; padding is render-side
    for (const mode of ["unicode", "ascii"] as GlyphMode[]) {
      const line = join(renderWindowLine(w, 16, mode));
      expect(line.length).toBe(38);
      expect(line.slice(0, 4)).toBe("x   "); // 1-char label + padEnd(3) + gap
      expect(line.slice(GRID.bar, GRID.bar + GRID.barWidth)).toHaveLength(GRID.barWidth);
      expect(line.slice(GRID.pct, GRID.pct + GRID.pctWidth)).toBe(" 62%");
      expect(line.slice(GRID.usage, GRID.usage + GRID.usageWidth)).toBe("  312/500");
      expect(line.slice(GRID.verdict)).toBe(mode === "ascii" ? "ok" : " ✓"); // verdictWidth 2, padStart
    }
  });

  test("label 5 chars ('quota' fallback class) truncates render-side to 'quo': line stays 38", () => {
    const line = join(renderWindowLine({ ...w5h(), label: "quota" }, 16, "unicode"));
    expect(line).toBe("quo █████████▉░░│░░░  62%   312/500  ✓");
    expect(line.length).toBe(38);
  });
});

describe("tester audit: header ladder rung sequence", () => {
  test("rung 1 only: 24-char level + 'stale · 98h ago' (15ch) drops the level and STOPS (age fits)", () => {
    const segs = renderHeader(hdr({ level: "a".repeat(24), freshness: "stale · 98h ago", stale: true }), "unicode");
    const line = join(segs);
    expect(line).toBe("ZAI RUNWAY".padEnd(38 - "stale · 98h ago".length) + "stale · 98h ago"); // exact rung-1 output
    expect(line.length).toBe(38);
    expect(line).not.toContain("aaaa"); // rung 1 fired: level gone
    expect(line).toContain("stale · "); // rung 2 NOT reached: prefix survives
    expect(segs[1].role).toBe("warning");
  });

  test("rungs 1+2 in sequence: level dropped, then 'stale · ' stripped; result fits 38 exactly", () => {
    // 28-char freshness: rung 1 (24+3+28 > 38) fires; rung 2 (10+1+28 = 39 > 38)
    // fires; the 20-char age then fits (10+1+20 = 31 <= 38) — ladder stops at 2.
    const freshness = "stale · " + "d".repeat(20);
    expect(freshness.length).toBe(28);
    const segs = renderHeader(hdr({ level: "a".repeat(24), freshness, stale: true }), "unicode");
    const line = join(segs);
    expect(line).toBe("ZAI RUNWAY".padEnd(38 - 20) + "d".repeat(20));
    expect(line.length).toBe(38);
    expect(line).not.toContain("aaaa"); // rung 1 fired
    expect(line).not.toContain("stale"); // rung 2 fired
    expect(line).toContain("dddd"); // age never dropped
    expect(segs[1].role).toBe("warning"); // model stale flag still colors the suffix
  });
});

describe("tester audit: detail floor worst runway", () => {
  test("runway-only floor with the widest realistic runway texts stays a single verdict-role segment <= 38", () => {
    const cases: Array<[string, SegmentRole, WindowModel["verdict"]]> = [
      ["runway ~999d", "success", "ok"], // multi-month runway: "~" + rounded whole days
      ["runway ~47h 59m", "success", "ok"], // widest sub-48h approximation (fmtApproxDuration)
      ["limit reached", "error", "blocked"], // blocked floor
    ];
    for (const [runwayText, role, verdict] of cases) {
      const w: WindowModel = { ...w5h(), verdict, resetText: "r".repeat(30), runwayText };
      const segs = renderDetailLine(w, "unicode");
      expect(segs).toEqual([{ text: runwayText, role }]);
      expect(join(segs).length).toBeLessThanOrEqual(GRID.width);
    }
  });

  test("ascii floor asciifies the infinite-runway text to 'runway inf' (single segment, <= 38)", () => {
    const segs = renderDetailLine({ ...w5h(), resetText: "r".repeat(30), runwayText: "runway ∞" }, "ascii");
    expect(segs).toEqual([{ text: "runway inf", role: "success" }]);
    expect(join(segs).length).toBeLessThanOrEqual(GRID.width);
  });
});

describe("tester audit: freshness day cap + ascii parity columns", () => {
  test("beyond the 8-char tier cap: 'stale · 1000d ago' (17ch) drops the level at rung 1 and fits 38", () => {
    const segs = renderHeader(hdr({ level: "a".repeat(24), freshness: "stale · 1000d ago", stale: true }), "unicode");
    const line = join(segs);
    expect(line).toBe("ZAI RUNWAY".padEnd(38 - "stale · 1000d ago".length) + "stale · 1000d ago");
    expect(line.length).toBe(38);
    expect(line).not.toContain("aaaa"); // level dropped
    expect(line).toContain("stale · "); // rung 2 not reached
  });

  test("ascii parity spot check: the 'ok' verdict glyph occupies cols 36-37 (GRID.verdict)", () => {
    const line = join(renderWindowLine(w5h(), 16, "ascii"));
    expect(line.length).toBe(GRID.width);
    expect(line.slice(GRID.verdict, GRID.verdict + GRID.verdictWidth)).toBe("ok");
    expect(line[GRID.verdict - 1]).toBe(" "); // gap col 35 survives
  });
});

describe("header suffix hard floor (grid-align review nit)", () => {
  test("pathological post-ladder suffix is truncated so the header never exceeds targetWidth", () => {
    const header = {
      title: "ZAI RUNWAY" as const,
      level: null,
      freshness: "0".repeat(35),
      stale: true,
      updating: false,
    }
    const [title, suffix] = renderHeader(header, "unicode", 38)
    expect(title.text.length + suffix.text.length).toBeLessThanOrEqual(38)
    expect(title.text.length).toBe(11) // "ZAI RUNWAY " padded to the 1-gap floor
    expect(suffix.text.length).toBeLessThanOrEqual(27)
  })
})
