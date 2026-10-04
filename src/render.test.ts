import { describe, expect, test } from "bun:test";
import { chipSegments, colorRole, gauge, panelModel } from "./render";
import type { QuotaRow } from "./api";
import type { RunwayResult } from "./runway";
import type { Role } from "./roles";

const CFG = { warnThreshold: 70, critThreshold: 90 };
const PANEL_CFG = { ...CFG, gaugeWidth: 10 };

function row(partial: Partial<QuotaRow> & { label: string }): QuotaRow {
  return { usage: null, limit: null, percent: null, resetAt: null, ...partial };
}

function runway(state: RunwayResult["state"], runwayMs: number | null = null): RunwayResult {
  return { state, runwayMs, resetInMs: null };
}

describe("colorRole", () => {
  test("null percent maps to muted", () => {
    expect(colorRole(null, CFG)).toBe("muted");
  });

  test("0 maps to ok", () => {
    expect(colorRole(0, CFG)).toBe("ok");
  });

  test("69.9 (just below warn threshold) maps to ok", () => {
    expect(colorRole(69.9, CFG)).toBe("ok");
  });

  test("70 (at warn threshold) maps to warn", () => {
    expect(colorRole(70, CFG)).toBe("warn");
  });

  test("89.9 (just below crit threshold) maps to warn", () => {
    expect(colorRole(89.9, CFG)).toBe("warn");
  });

  test("90 (at crit threshold) maps to crit", () => {
    expect(colorRole(90, CFG)).toBe("crit");
  });

  test("custom cfg (50/90): 50 maps to warn", () => {
    expect(colorRole(50, { warnThreshold: 50, critThreshold: 90 })).toBe("warn");
  });

  test("custom cfg (50/90): 49.9 maps to ok", () => {
    expect(colorRole(49.9, { warnThreshold: 50, critThreshold: 90 })).toBe("ok");
  });
});

describe("gauge", () => {
  test("null percent: muted role and all empty cells, width preserved", () => {
    const { cells, role } = gauge(null, 12);
    expect(role).toBe("muted");
    expect(cells).toBe("░".repeat(12));
    expect(cells.length).toBe(12);
  });

  test("0 percent: ok role and all empty cells", () => {
    const { cells, role } = gauge(0, 12);
    expect(role).toBe("ok");
    expect(cells).toBe("░".repeat(12));
    expect(cells.length).toBe(12);
  });

  test("100 percent: all full blocks", () => {
    const { cells } = gauge(100, 12);
    expect(cells).toBe("█".repeat(12));
    expect(cells.length).toBe(12);
  });

  test("150 percent clamps to full: all full blocks, crit role with default thresholds", () => {
    const { cells, role } = gauge(150, 12);
    expect(cells).toBe("█".repeat(12));
    expect(role).toBe("crit");
    expect(cells.length).toBe(12);
  });

  test("-10 percent clamps to empty: all empty cells, ok role", () => {
    const { cells, role } = gauge(-10, 12);
    expect(cells).toBe("░".repeat(12));
    expect(role).toBe("ok");
    expect(cells.length).toBe(12);
  });

  test("50 percent at width 12: exact half fill with no partial block", () => {
    const { cells } = gauge(50, 12);
    expect(cells).toBe("██████░░░░░░");
    expect(cells.length).toBe(12);
  });

  test("8.333 percent at width 12: heaviest partial block then empties", () => {
    const { cells } = gauge(8.333, 12);
    expect(cells).toBe("▉░░░░░░░░░░░");
    expect(cells.length).toBe(12);
  });

  test("33.3 percent at width 3: partial block scaled to narrow width", () => {
    const { cells } = gauge(33.3, 3);
    expect(cells).toBe("▉░░");
    expect(cells.length).toBe(3);
  });

  test("custom cfg (50/90): 50 percent maps to warn role", () => {
    const { role } = gauge(50, 12, { warnThreshold: 50, critThreshold: 90 });
    expect(role).toBe("warn");
  });

  test("no cfg arg: 95 percent still maps to crit via default thresholds", () => {
    const { role } = gauge(95, 8);
    expect(role).toBe("crit");
  });
});

describe("chipSegments", () => {
  test("happy path: 5h and wk percents as text with roles", () => {
    const input = {
      rows: [
        row({ label: "5h", percent: 62 }),
        row({ label: "wk", percent: 41 }),
      ],
      error: null,
    };
    const segments = chipSegments(input, CFG);
    expect(segments.map((s) => s.text)).toEqual([" zai ", "62", "·", "41"]);
    expect(segments.map((s) => s.role)).toEqual(["muted", "ok", "muted", "ok"] as Role[]);
  });

  test("5h at 95 gets crit role", () => {
    const input = {
      rows: [row({ label: "5h", percent: 95 }), row({ label: "wk", percent: 41 })],
      error: null,
    };
    const segments = chipSegments(input, CFG);
    expect(segments[1]).toEqual({ text: "95", role: "crit" });
  });

  test("missing 5h row renders ? with muted role", () => {
    const input = { rows: [row({ label: "wk", percent: 41 })], error: null };
    const segments = chipSegments(input, CFG);
    expect(segments[1]).toEqual({ text: "?", role: "muted" });
    expect(segments[3]).toEqual({ text: "41", role: "ok" });
  });

  test("both rows missing renders ? for both slots", () => {
    const segments = chipSegments({ rows: [], error: null }, CFG);
    expect(segments.map((s) => s.text)).toEqual([" zai ", "?", "·", "?"]);
  });

  test("non-null error short-circuits to a single muted zai:? segment", () => {
    const segments = chipSegments(
      { rows: [row({ label: "5h", percent: 62 })], error: "HTTP 500" },
      CFG,
    );
    expect(segments).toEqual([{ text: " zai:?", role: "muted" }]);
  });

  test("selection is by label, not index: wk first in input still lands in the wk slot", () => {
    const input = {
      rows: [row({ label: "wk", percent: 41 }), row({ label: "5h", percent: 62 })],
      error: null,
    };
    const segments = chipSegments(input, CFG);
    expect(segments[1].text).toBe("62");
    expect(segments[3].text).toBe("41");
  });
});

describe("panelModel", () => {
  const NOW = 1_000_000;

  function panelInput(
    overrides: Partial<Parameters<typeof panelModel>[0]> = {},
  ): Parameters<typeof panelModel>[0] {
    return {
      rows: [],
      runways: {},
      level: null,
      updatedAt: NOW,
      now: NOW,
      intervalMs: 60_000,
      showRunway: true,
      formatTime: (ms: number) => "T" + ms,
      ...overrides,
    };
  }

  test("stale is true when age exceeds 2*intervalMs by 1", () => {
    const model = panelModel(
      panelInput({ updatedAt: 0, now: 2 * 60_000 + 1, intervalMs: 60_000 }),
      PANEL_CFG,
    );
    expect(model.header.stale).toBe(true);
  });

  test("stale is false when age is exactly 2*intervalMs", () => {
    const model = panelModel(
      panelInput({ updatedAt: 0, now: 2 * 60_000, intervalMs: 60_000 }),
      PANEL_CFG,
    );
    expect(model.header.stale).toBe(false);
  });

  test("updatedAt null renders an em dash", () => {
    const model = panelModel(panelInput({ updatedAt: null }), PANEL_CFG);
    expect(model.header.updatedAt).toBe("—");
  });

  test("updatedAt non-null renders via injected formatTime", () => {
    const model = panelModel(panelInput({ updatedAt: 42, formatTime: (ms) => "T" + ms }), PANEL_CFG);
    expect(model.header.updatedAt).toBe("T42");
  });

  test("row order: wk first in input still yields 5h first, wk second, rest after", () => {
    const model = panelModel(
      panelInput({
        rows: [
          row({ label: "wk", percent: 41 }),
          row({ label: "5h", percent: 62 }),
          row({ label: "mo", percent: 10 }),
        ],
      }),
      PANEL_CFG,
    );
    expect(model.rowLines.map((l) => l.label)).toEqual(["5h", "wk", "mo"]);
  });

  test("usage null renders ? and limit null renders ?", () => {
    const model = panelModel(
      panelInput({ rows: [row({ label: "5h", usage: null, limit: null, percent: 50 })] }),
      PANEL_CFG,
    );
    expect(model.rowLines[0].usageText).toBe("?");
    expect(model.rowLines[0].limitText).toBe("?");
  });

  test("resetAt null renders 'reset ?'", () => {
    const model = panelModel(
      panelInput({ rows: [row({ label: "5h", resetAt: null })] }),
      PANEL_CFG,
    );
    expect(model.rowLines[0].resetText).toBe("reset ?");
  });

  test("future resetAt renders the formatted remaining duration", () => {
    const model = panelModel(
      panelInput({ rows: [row({ label: "5h", resetAt: NOW + 4_320_000 })] }),
      PANEL_CFG,
    );
    expect(model.rowLines[0].resetText).toBe("reset 1h 12m");
  });

  test("no-limit runway renders 'runway —' with muted role", () => {
    const model = panelModel(
      panelInput({ rows: [row({ label: "5h" })], runways: { "5h": runway("no-limit") } }),
      PANEL_CFG,
    );
    expect(model.rowLines[0].runwayText).toBe("runway —");
    expect(model.rowLines[0].runwayRole).toBe("muted");
  });

  test("no-data runway renders 'runway …' with muted role", () => {
    const model = panelModel(
      panelInput({ rows: [row({ label: "5h" })], runways: { "5h": runway("no-data") } }),
      PANEL_CFG,
    );
    expect(model.rowLines[0].runwayText).toBe("runway …");
    expect(model.rowLines[0].runwayRole).toBe("muted");
  });

  test("no-burn runway renders 'runway ∞' with info role", () => {
    const model = panelModel(
      panelInput({ rows: [row({ label: "5h" })], runways: { "5h": runway("no-burn") } }),
      PANEL_CFG,
    );
    expect(model.rowLines[0].runwayText).toBe("runway ∞");
    expect(model.rowLines[0].runwayRole).toBe("info");
  });

  test("ok runway renders 'runway ~2h' with ok role for 7_200_000ms", () => {
    const model = panelModel(
      panelInput({ rows: [row({ label: "5h" })], runways: { "5h": runway("ok", 7_200_000) } }),
      PANEL_CFG,
    );
    expect(model.rowLines[0].runwayText).toBe("runway ~2h");
    expect(model.rowLines[0].runwayRole).toBe("ok");
  });

  test("warn runway text ends with ' !' and gets crit role", () => {
    const model = panelModel(
      panelInput({ rows: [row({ label: "5h" })], runways: { "5h": runway("warn", 7_200_000) } }),
      PANEL_CFG,
    );
    expect(model.rowLines[0].runwayText).toBe("runway ~2h !");
    expect(model.rowLines[0].runwayText?.endsWith(" !")).toBe(true);
    expect(model.rowLines[0].runwayRole).toBe("crit");
  });

  test("row absent from runways record is treated as no-reset: null text, muted role", () => {
    const model = panelModel(
      panelInput({ rows: [row({ label: "5h" })], runways: {} }),
      PANEL_CFG,
    );
    expect(model.rowLines[0].runwayText).toBeNull();
    expect(model.rowLines[0].runwayRole).toBe("muted");
  });

  test("showRunway false nulls runwayText for every state", () => {
    const states: RunwayResult["state"][] = ["no-limit", "no-data", "no-burn", "ok", "warn", "no-reset"];
    const rows = states.map((state) => row({ label: state }));
    const runways = Object.fromEntries(states.map((state) => [state, runway(state, 7_200_000)]));
    const model = panelModel(panelInput({ rows, runways, showRunway: false }), PANEL_CFG);
    expect(model.rowLines.map((l) => l.runwayText)).toEqual(
      states.map(() => null),
    );
  });

  test("row with non-ASCII unicode label passes through unchanged without crashing", () => {
    const label = "\u914d\u7d66-quota";
    const model = panelModel(panelInput({ rows: [row({ label, percent: 50 })] }), PANEL_CFG);
    expect(model.rowLines[0].label).toBe(label);
    expect(model.rowLines[0].gaugeCells.length).toBe(PANEL_CFG.gaugeWidth);
  });

  test("custom cfg (40/80): row percent 50 yields warn gaugeRole in panel rows", () => {
    const customCfg = { warnThreshold: 40, critThreshold: 80, gaugeWidth: 10 };
    const model = panelModel(
      panelInput({ rows: [row({ label: "5h", percent: 50 })] }),
      customCfg,
    );
    expect(model.rowLines[0].gaugeRole).toBe("warn");
  });
});

function deepFreeze(value: unknown): unknown {
  if (value !== null && typeof value === "object") {
    for (const key of Object.keys(value as Record<string, unknown>)) {
      deepFreeze((value as Record<string, unknown>)[key]);
    }
    Object.freeze(value);
  }
  return value;
}

describe("gauge width invariants", () => {
  test("width 4: exact length at empty, half, near-full, full, and null fills", () => {
    expect(gauge(0, 4).cells).toBe("░░░░");
    expect(gauge(50, 4).cells).toBe("██░░"); // 50*4/100 = 2 exactly -> no partial cell
    expect(gauge(99.9, 4).cells).toBe("███▉"); // heaviest partial, no spill past width
    expect(gauge(100, 4).cells).toBe("████"); // exact 100 -> frac ~0, no partial cell
    expect(gauge(null, 4).cells).toBe("░░░░");
    for (const { cells } of [gauge(0, 4), gauge(50, 4), gauge(99.9, 4), gauge(100, 4), gauge(null, 4)]) {
      expect(cells).toHaveLength(4);
    }
  });

  test("width 40: exact length at extremes and exact half fill", () => {
    expect(gauge(0, 40).cells).toBe("░".repeat(40));
    expect(gauge(100, 40).cells).toBe("█".repeat(40));
    expect(gauge(50, 40).cells).toBe("█".repeat(20) + "░".repeat(20)); // 20.0 exactly
    expect(gauge(99.9, 40).cells).toBe("█".repeat(39) + "▉"); // 39.96 -> 39 full + heaviest partial
    for (const { cells } of [gauge(0, 40), gauge(100, 40), gauge(50, 40), gauge(99.9, 40)]) {
      expect(cells).toHaveLength(40);
    }
  });

  test("99.9 percent at width 12: 11 full blocks plus heaviest partial, crit role", () => {
    const { cells, role } = gauge(99.9, 12);
    expect(cells).toBe("█".repeat(11) + "▉");
    expect(cells).toHaveLength(12);
    expect(role).toBe("crit");
  });

  test("deep-frozen inputs do not throw or mutate panelModel/gauge/chipSegments (strict-mode purity)", () => {
    const frozenRunway = deepFreeze(runway("ok", 7_200_000)) as RunwayResult;
    const frozenRow = deepFreeze(
      row({ label: "5h", usage: 120, limit: 200, percent: 60, resetAt: 1_060_000 }),
    ) as QuotaRow;
    const input = deepFreeze({
      rows: [frozenRow],
      runways: { "5h": frozenRunway },
      level: null,
      updatedAt: 1_000_000,
      now: 1_000_000,
      intervalMs: 60_000,
      showRunway: true,
      formatTime: (ms: number) => "T" + ms,
    }) as Parameters<typeof panelModel>[0];
    const frozenPanelCfg = deepFreeze(PANEL_CFG) as typeof PANEL_CFG;

    const model = panelModel(input, frozenPanelCfg);
    expect(model.rowLines).toHaveLength(1);
    expect(model.rowLines[0].runwayText).toBe("runway ~2h");

    const frozenCfg = deepFreeze(CFG) as typeof CFG;
    expect(() => gauge(50, 12, frozenCfg)).not.toThrow();
    expect(() => chipSegments(deepFreeze({ rows: [frozenRow], error: null }) as { rows: QuotaRow[]; error: null }, frozenCfg)).not.toThrow();
    expect(() => colorRole(50, frozenCfg)).not.toThrow();

    // A write to any frozen input would throw in ESM strict mode.
    expect(frozenRow.usage).toBe(120);
    expect(frozenRow.resetAt).toBe(1_060_000);
  });
});

describe("empty-input regressions", () => {
  test("chipSegments with rows [] keeps four segments, all muted", () => {
    const segments = chipSegments({ rows: [], error: null }, CFG);
    expect(segments.map((s) => s.text)).toEqual([" zai ", "?", "·", "?"]);
    expect(segments.map((s) => s.role)).toEqual(["muted", "muted", "muted", "muted"] as Role[]);
  });

  test("panelModel with rows [] yields empty rowLines but a full header", () => {
    const model = panelModel(
      {
        rows: [],
        runways: {},
        level: null,
        updatedAt: 1_000_000,
        now: 1_000_000,
        intervalMs: 60_000,
        showRunway: true,
        formatTime: (ms: number) => "T" + ms,
      },
      PANEL_CFG,
    );
    expect(model.rowLines).toEqual([]);
    expect(model.header.title).toBe("ZAI RUNWAY");
    expect(model.header.stale).toBe(false);
  });

  test("explicit no-reset runway entry renders null text with muted role", () => {
    const model = panelModel(
      {
        rows: [row({ label: "5h" })],
        runways: { "5h": runway("no-reset") },
        level: null,
        updatedAt: 1_000_000,
        now: 1_000_000,
        intervalMs: 60_000,
        showRunway: true,
        formatTime: (ms: number) => "T" + ms,
      },
      PANEL_CFG,
    );
    expect(model.rowLines[0].runwayText).toBeNull();
    expect(model.rowLines[0].runwayRole).toBe("muted");
  });
});

describe("panelModel label/level sanitization (F5)", () => {
  const NOW = 1_000_000;

  function input(
    overrides: Partial<Parameters<typeof panelModel>[0]> = {},
  ): Parameters<typeof panelModel>[0] {
    return {
      rows: [],
      runways: {},
      level: null,
      updatedAt: NOW,
      now: NOW,
      intervalMs: 60_000,
      showRunway: true,
      formatTime: (ms: number) => "T" + ms,
      ...overrides,
    };
  }

  test("label with ANSI color escapes is stripped to the clean label", () => {
    const model = panelModel(
      input({ rows: [row({ label: "\u001b[31m5h\u001b[0m", percent: 50 })] }),
      PANEL_CFG,
    );
    expect(model.rowLines).toHaveLength(1);
    expect(model.rowLines[0].label).toBe("5h");
  });

  test("label with a leading zero-width space is stripped to the visible chars", () => {
    const model = panelModel(input({ rows: [row({ label: "\u200bX", percent: 50 })] }), PANEL_CFG);
    expect(model.rowLines[0].label).toBe("X");
  });

  test("label longer than 24 chars is sliced to the first 24", () => {
    const long = "abcdefghijklmnopqrstuvwxyz0123"; // 30 chars
    const model = panelModel(input({ rows: [row({ label: long, percent: 50 })] }), PANEL_CFG);
    expect(model.rowLines[0].label).toBe(long.slice(0, 24));
    expect(model.rowLines[0].label).toHaveLength(24);
  });

  test("level with an OSC title-injection sequence is fully stripped", () => {
    const model = panelModel(input({ level: "\u001b]0;pwn\u0007" }), PANEL_CFG);
    expect(model.header.level).toBe("");
  });

  test("printable unicode label passes through intact", () => {
    const label = "\u914d\u7d66-quota";
    const model = panelModel(input({ rows: [row({ label, percent: 50 })] }), PANEL_CFG);
    expect(model.rowLines[0].label).toBe(label);
  });

  test("null level stays null", () => {
    const model = panelModel(input({ level: null }), PANEL_CFG);
    expect(model.header.level).toBeNull();
  });
});

// ===========================================================================
// V2 renderer (redesign W2): segments over the W1 view-model (src/model.ts).
// Every Segment carries exactly one of the five universal SegmentRole tokens.
// ===========================================================================

import {
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
  return { result: { state, runwayMs, resetInMs }, spanMs };
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

const ERROR_CODE_CASES: Record<string, string> = {
  "no-token": "no token (login via zai or set ZAI_TOKEN)",
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

describe("V2 goldens (frozen from manual check)", () => {
  const okPanel = buildPanel(
    makeInput({ rows: [v2Row5h(), v2Row7d()], runways: v2OkRunways(), level: "max", updatedAt: V2_NOW - 30_000 }),
  );
  const shortPanel = buildPanel(
    makeInput({
      rows: [v2Row5h(), v2Row7d()],
      runways: { ...v2OkRunways(), "5h": makeRunway("ok", 2_100_000, 72 * V2_MIN) },
      updatedAt: V2_NOW - 30_000,
    }),
  );
  const blockedPanel = buildPanel(
    makeInput({
      rows: [makeRow("5h", { usage: 500, limit: 500, percent: 100, resetAt: V2_NOW + 42 * V2_MIN, unit: 3 })],
      runways: {},
      updatedAt: V2_NOW - 30_000,
    }),
  );

  test("ok 5h window line (unicode, 16): marker bar split at index 12, verdict glyph at end", () => {
    const segs = renderWindowLine(okPanel.windows[0], 16, "unicode");
    expect(join(segs)).toBe("5h  █████████▉░░│░░░ 62% 312/500 ✓");
    expect(segs.map((s) => s.role)).toEqual(["textMuted", "success", "text", "success", "text", "textMuted", "success"]);
  });

  test("ok 7d window line (unicode, 16)", () => {
    const segs = renderWindowLine(okPanel.windows[1], 16, "unicode");
    expect(join(segs)).toBe("7d  ██████▌░│░░░░░░░ 41% 4.1M/10M ✓");
  });

  test("ok 5h window line (ascii, 16): embedded | marker, single bar segment, 'ok' glyph", () => {
    const segs = renderWindowLine(okPanel.windows[0], 16, "ascii");
    expect(join(segs)).toBe("5h  #########---|--- 62% 312/500 ok");
    expect(segs.map((s) => s.role)).toEqual(["textMuted", "success", "text", "textMuted", "success"]);
  });

  test("short detail line (unicode): reset · runway + 2-space shortfall", () => {
    const segs = renderDetailLine(shortPanel.windows[0], "unicode");
    expect(join(segs)).toBe("     reset 1h 12m · runway ~35m  (37m short)");
    expect(segs.map((s) => s.role)).toEqual(["textMuted", "error", "textMuted"]);
  });

  test("blocked detail line (unicode): reset · limit reached · back at", () => {
    const segs = renderDetailLine(blockedPanel.windows[0], "unicode");
    expect(join(segs)).toBe("     reset 42m · limit reached · back at T1000002520000");
    expect(segs.map((s) => s.role)).toEqual(["textMuted", "error", "textMuted"]);
  });

  test("header line (unicode): title + level + freshness", () => {
    const segs = renderHeader(okPanel.header, "unicode");
    expect(join(segs)).toBe("ZAI RUNWAY  max 30s ago");
    expect(segs.map((s) => s.role)).toEqual(["text", "textMuted", "textMuted"]);
  });
});

describe("V2 renderHeader variants", () => {
  const base: V2PanelModel["header"] = {
    title: "ZAI RUNWAY",
    level: null,
    freshness: "30s ago",
    stale: false,
    updating: false,
  };

  test("null level: no level segment", () => {
    expect(join(renderHeader(base, "unicode"))).toBe("ZAI RUNWAY 30s ago");
  });

  test("updating: freshness replaced by a warning ' updating…' segment", () => {
    const segs = renderHeader({ ...base, updating: true }, "unicode");
    expect(join(segs)).toBe("ZAI RUNWAY updating…");
    expect(segs.map((s) => s.role)).toEqual(["text", "warning"]);
  });

  test("stale: freshness segment gets warning role", () => {
    const segs = renderHeader({ ...base, stale: true, freshness: "stale · 3m ago" }, "unicode");
    expect(join(segs)).toBe("ZAI RUNWAY stale · 3m ago");
    expect(segs[1].role).toBe("warning");
  });
});

describe("V2 renderWindowLine / renderDetailLine options", () => {
  const w: WindowModel = {
    label: "5h",
    fillPercent: 62.4,
    markerIndex: 12,
    verdict: "short",
    percentText: "62%",
    usageText: "312",
    limitText: "500",
    resetText: "reset 1h 12m",
    runwayText: "runway ~35m",
    backText: null,
    shortfallText: "(37m short)",
  };

  test("dropUsage removes only the usage/limit segment", () => {
    const full = renderWindowLine(w, 16, "unicode");
    const dropped = renderWindowLine(w, 16, "unicode", { dropUsage: true });
    expect(join(full)).toBe("5h  █████████▉░░│░░░ 62% 312/500 !!");
    expect(join(dropped)).toBe("5h  █████████▉░░│░░░ 62% !!");
    expect(dropped.some((s) => s.text.includes("/"))).toBe(false);
  });

  test("null marker renders a single bar segment", () => {
    const segs = renderWindowLine({ ...w, markerIndex: null }, 16, "unicode");
    expect(join(segs)).toBe("5h  █████████▉░░░░░░ 62% 312/500 !!");
  });

  test("detail without back/shortfall is just reset · runway", () => {
    const segs = renderDetailLine({ ...w, backText: null, shortfallText: null }, "unicode");
    expect(join(segs)).toBe("     reset 1h 12m · runway ~35m");
    expect(segs.map((s) => s.role)).toEqual(["textMuted", "error"]);
  });

  test("dropReset moves the 5-space indent onto the runway segment (no leading separator)", () => {
    expect(join(renderDetailLine(w, "unicode", { dropReset: true }))).toBe("     runway ~35m  (37m short)");
  });

  test("no-burn runway inherits success role via the ok verdict", () => {
    const segs = renderDetailLine({ ...w, verdict: "ok", runwayText: "runway ∞" }, "unicode");
    expect(segs[1].role).toBe("success");
  });

  test("unknown-verdict runway inherits textMuted role", () => {
    const segs = renderDetailLine({ ...w, verdict: "unknown", runwayText: "runway …" }, "unicode");
    expect(segs[1].role).toBe("textMuted");
  });
});

describe("V2 renderPanelLines structure", () => {
  test("ok scenario: header + two lines per window, nothing degraded at width 40", () => {
    const panel = buildPanel(
      makeInput({ rows: [v2Row5h(), v2Row7d()], runways: v2OkRunways(), level: "max", updatedAt: V2_NOW - 30_000 }),
    );
    const lines = renderPanelLines(panel, { gaugeWidth: 16, mode: "unicode", targetWidth: 40 });
    expect(lines).toHaveLength(5);
    expect(join(lines[0])).toBe("ZAI RUNWAY  max 30s ago");
    expect(join(lines[1])).toBe("5h  █████████▉░░│░░░ 62% 312/500 ✓");
    expect(join(lines[2])).toBe("     reset 1h 12m · runway ~2h 5m");
    expect(join(lines[3])).toBe("7d  ██████▌░│░░░░░░░ 41% 4.1M/10M ✓");
    expect(join(lines[4])).toBe("     reset 3d 4h · runway ~10d");
  });

  test("loading: header + single muted 'loading…' line", () => {
    const panel = buildPanel(makeInput({ rows: [], updating: true }));
    const lines = renderPanelLines(panel, { gaugeWidth: 16, mode: "unicode", targetWidth: 40 });
    expect(lines).toHaveLength(2);
    expect(lines[1]).toEqual([{ text: "loading…", role: "textMuted" }]);
    expect(lines[0][1]).toEqual({ text: " updating…", role: "warning" });
  });

  test("error: header + single error line per taxonomy code", () => {
    for (const [code, text] of Object.entries(ERROR_CODE_CASES)) {
      const panel = buildPanel(makeInput({ rows: [], error: code }));
      const lines = renderPanelLines(panel, { gaugeWidth: 16, mode: "unicode", targetWidth: 40 });
      expect(lines).toHaveLength(2);
      expect(lines[1]).toEqual([{ text, role: "error" }]);
    }
  });

  test("targetWidth defaults to 40 when omitted", () => {
    const panel = buildPanel(
      makeInput({ rows: [v2Row5h(), v2Row7d()], runways: v2OkRunways(), level: null, updatedAt: V2_NOW - 30_000 }),
    );
    const withDefault = renderPanelLines(panel, { gaugeWidth: 16, mode: "unicode" });
    const explicit = renderPanelLines(panel, { gaugeWidth: 16, mode: "unicode", targetWidth: 40 });
    expect(withDefault).toEqual(explicit);
  });
});

describe("V2 width degradation ladder", () => {
  const hdr = { title: "ZAI RUNWAY" as const, level: null, freshness: "30s ago", stale: false, updating: false };
  const panelOf = (w: WindowModel): V2PanelModel => ({ header: hdr, error: null, windows: [w] });

  // Detail: "     reset 42m · limit reached · back at 09:42" = 46 chars.
  const blockedWin: WindowModel = {
    label: "5h",
    fillPercent: 100,
    markerIndex: null,
    verdict: "blocked",
    percentText: "100%",
    usageText: "500",
    limitText: "500",
    resetText: "reset 42m",
    runwayText: "limit reached",
    backText: "back at 09:42",
    shortfallText: null,
  };

  // Detail: "     reset 1h 12m · runway ~35m  (37m short)" = 44 chars.
  const shortWin: WindowModel = {
    label: "5h",
    fillPercent: 62.4,
    markerIndex: null,
    verdict: "short",
    percentText: "62%",
    usageText: "312",
    limitText: "500",
    resetText: "reset 1h 12m",
    runwayText: "runway ~35m",
    backText: null,
    shortfallText: "(37m short)",
  };

  const detailAt = (w: WindowModel, targetWidth: number): string => {
    const lines = renderPanelLines(panelOf(w), { gaugeWidth: 16, mode: "unicode", targetWidth });
    return join(lines[2]);
  };
  const windowAt = (w: WindowModel, targetWidth: number): string => {
    const lines = renderPanelLines(panelOf(w), { gaugeWidth: 16, mode: "unicode", targetWidth });
    return join(lines[1]);
  };

  test("blocked detail: targetWidth 46 keeps everything (46 <= 46)", () => {
    expect(detailAt(blockedWin, 46)).toBe("     reset 42m · limit reached · back at 09:42");
  });

  test("blocked detail: targetWidth 34 drops only backText (rung 1)", () => {
    const detail = detailAt(blockedWin, 34);
    expect(detail).toBe("     reset 42m · limit reached");
    expect(detail).not.toContain("back at");
  });

  test("blocked detail: targetWidth 29 drops backText then reset (rung 2)", () => {
    expect(detailAt(blockedWin, 29)).toBe("     limit reached");
  });

  test("short detail: targetWidth 44 keeps everything", () => {
    expect(detailAt(shortWin, 44)).toBe("     reset 1h 12m · runway ~35m  (37m short)");
  });

  test("short detail: targetWidth 43 drops reset (no backText to drop first)", () => {
    expect(detailAt(shortWin, 43)).toBe("     runway ~35m  (37m short)");
  });

  test("short detail: targetWidth 25 drops reset then shortfall (rung 3)", () => {
    expect(detailAt(shortWin, 25)).toBe("     runway ~35m");
  });

  test("window line: targetWidth 30 drops the usage/limit segment (35 -> 27)", () => {
    const line = windowAt(blockedWin, 30);
    expect(line).toBe("5h  ████████████████ 100% ✗");
    expect(line).not.toContain("/");
  });

  test("window line: targetWidth 40 keeps usage on the same fixture", () => {
    expect(windowAt(blockedWin, 40)).toBe("5h  ████████████████ 100% 500/500 ✗");
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
        for (const targetWidth of [40, 30, 24]) {
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
    const hdr = renderHeader(panel.header, "unicode");
    expect(join(hdr)).toBe("ZAI RUNWAY updating…");
    expect(hdr.map((s) => s.role)).toEqual(["text", "warning"]);
    for (const mode of ["unicode", "ascii"] as GlyphMode[]) {
      for (const targetWidth of [40, 30, 24]) {
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

  test("renderWindowLine: unicode split at marker 0 / width-1 yields edge-empty segments, joined bar stays 16", () => {
    const base: WindowModel = {
      label: "5h",
      fillPercent: 62.4,
      markerIndex: null,
      verdict: "ok",
      percentText: "62%",
      usageText: "312",
      limitText: "500",
      resetText: "reset 1h 12m",
      runwayText: "runway ~2h",
      backText: null,
      shortfallText: null,
    };
    const atZero = renderWindowLine({ ...base, markerIndex: 0 }, 16, "unicode");
    expect(atZero[1]).toEqual({ text: "", role: "success" });
    expect(join(atZero)).toBe("5h  │████████▉░░░░░░ 62% 312/500 ✓");
    const atLast = renderWindowLine({ ...base, markerIndex: 15 }, 16, "unicode");
    expect(atLast[3]).toEqual({ text: "", role: "success" });
    expect(join(atLast)).toBe("5h  █████████▉░░░░░│ 62% 312/500 ✓");
  });
});

describe("V2 W2 audit: golden independent re-derivation (drift tripwire)", () => {
  test("frozen joined-line goldens re-derived from fill/split/separator formulas, not from render code", () => {
    // Independent reimplementation of the W2 bar math (does NOT call barCells/renderWindowLine).
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
      `${w.label}  ${bar(w.fillPercent as number, w.markerIndex, 16, mode)}` +
      ` ${w.percentText} ${w.usageText}/${w.limitText} ${VERDICT_GLYPH[mode][w.verdict]}`;

    // Marker indexes come from the W1 model (marker.ts); everything after is re-derived here.
    const okPanel = buildPanel(
      makeInput({ rows: [v2Row5h(), v2Row7d()], runways: v2OkRunways(), level: "max", updatedAt: V2_NOW - 30_000 }),
    );
    const [w5h, w7d] = okPanel.windows;
    expect(w5h.markerIndex).toBe(12);
    expect(winLine(w5h, "unicode")).toBe("5h  █████████▉░░│░░░ 62% 312/500 ✓");
    expect(winLine(w5h, "ascii")).toBe("5h  #########---|--- 62% 312/500 ok");
    expect(w7d.markerIndex).toBe(8);
    expect(winLine(w7d, "unicode")).toBe("7d  ██████▌░│░░░░░░░ 41% 4.1M/10M ✓");

    const shortPanel = buildPanel(
      makeInput({
        rows: [v2Row5h(), v2Row7d()],
        runways: { ...v2OkRunways(), "5h": makeRunway("ok", 2_100_000, 72 * V2_MIN) },
        updatedAt: V2_NOW - 30_000,
      }),
    );
    const sw = shortPanel.windows[0];
    expect(`     ${sw.resetText} · ${sw.runwayText}  ${sw.shortfallText}`).toBe(
      "     reset 1h 12m · runway ~35m  (37m short)",
    );
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

describe("V2 W2 audit: degradation-ladder monotonicity", () => {
  test("widths 46>45>34>29>25: line lengths non-increasing, runway never dropped, role stable, tokens intact", () => {
    const hdr = { title: "ZAI RUNWAY" as const, level: null, freshness: "30s ago", stale: false, updating: false };
    const cases: { win: WindowModel; runwayRole: SegmentRole }[] = [
      {
        // blocked: detail 46 -> drop back (30) -> drop reset (18)
        win: {
          label: "5h", fillPercent: 100, markerIndex: null, verdict: "blocked", percentText: "100%",
          usageText: "500", limitText: "500", resetText: "reset 42m",
          runwayText: "limit reached", backText: "back at 09:42", shortfallText: null,
        },
        runwayRole: VERDICT_ROLE.blocked,
      },
      {
        // short: detail 44 -> drop back n/a (44) -> drop reset (29) -> drop shortfall (16)
        win: {
          label: "5h", fillPercent: 62.4, markerIndex: null, verdict: "short", percentText: "62%",
          usageText: "312", limitText: "500", resetText: "reset 1h 12m",
          runwayText: "runway ~35m", backText: null, shortfallText: "(37m short)",
        },
        runwayRole: VERDICT_ROLE.short,
      },
    ];
    const widths = [46, 45, 34, 29, 25];
    for (const { win, runwayRole } of cases) {
      const winLens: number[] = [];
      const detLens: number[] = [];
      for (const targetWidth of widths) {
        const lines = renderPanelLines({ header: hdr, error: null, windows: [win] }, {
          gaugeWidth: 16, mode: "unicode", targetWidth,
        });
        for (const line of lines) assertSegmentsValid(line, `ladder w=${targetWidth}`);
        winLens.push(join(lines[1]).length);
        detLens.push(join(lines[2]).length);
        const runwaySeg = lines[2].find((s) => s.text.includes(win.runwayText));
        if (runwaySeg == null) throw new Error(`w=${targetWidth}: runway segment dropped (ladder must keep it)`);
        if (runwaySeg.role !== runwayRole) {
          throw new Error(`w=${targetWidth}: runway role ${runwaySeg.role}, expected ${runwayRole}`);
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
    expect(line).toBe("     reset 1h 12m - runway inf");
    expect(line).not.toContain("∞");
    expect(line).not.toContain("·");
    expect(line).not.toContain("…");
    // Unicode mode is unchanged.
    expect(join(renderDetailLine(noBurnPanel.windows[0], "unicode"))).toBe("     reset 1h 12m · runway ∞");
  });

  test("no-data runway (ascii): 'runway ...' with three dots", () => {
    const panel = buildPanel(
      makeInput({
        rows: [v2Row5h()],
        runways: { "5h": makeRunway("no-data", null, 72 * V2_MIN) },
        updatedAt: V2_NOW - 30_000,
      }),
    );
    expect(join(renderDetailLine(panel.windows[0], "ascii"))).toBe("     reset 1h 12m - runway ...");
  });

  test("loading panel line (ascii): 'loading...' with three dots", () => {
    const panel = buildPanel(makeInput({ rows: [], updating: true }));
    const lines = renderPanelLines(panel, { gaugeWidth: 16, mode: "ascii", targetWidth: 40 });
    expect(lines[1]).toEqual([{ text: "loading...", role: "textMuted" }]);
  });

  test("header updating (ascii): ' updating...' with three dots", () => {
    const segs = renderHeader(
      { title: "ZAI RUNWAY", level: null, freshness: "30s ago", stale: false, updating: true },
      "ascii",
    );
    expect(join(segs)).toBe("ZAI RUNWAY updating...");
  });

  test("header freshness (ascii): stale '·' mapped, null-timestamp '—' mapped", () => {
    const stale = renderHeader(
      { title: "ZAI RUNWAY", level: null, freshness: "stale · 3m ago", stale: true, updating: false },
      "ascii",
    );
    expect(join(stale)).toBe("ZAI RUNWAY stale - 3m ago");
    const noTs = renderHeader(
      { title: "ZAI RUNWAY", level: null, freshness: "—", stale: false, updating: false },
      "ascii",
    );
    expect(join(noTs)).toBe("ZAI RUNWAY -");
  });

  test("chip (ascii): separator '-', loading chip ' zai ...'", () => {
    const segs = renderChipSegments({ values: ["62%", "41%"], verdict: "ok" }, "ascii");
    expect(segs.map((s) => s.text)).toEqual([" zai ", "62%", "-", "41%", " ok"]);
    expect(join(renderChipSegments({ values: [], verdict: "unknown" }, "ascii"))).toBe(" zai ...");
  });

  test("ascii purity sweep: scenario matrix panel lines + chips contain only 7-bit ASCII", () => {
    for (const { name, panel, chip } of v2Scenarios()) {
      const lines = renderPanelLines(panel, { gaugeWidth: 16, mode: "ascii", targetWidth: 40 });
      for (const line of lines) {
        const text = join(line);
        if (/[^\x00-\x7f]/.test(text)) throw new Error(`${name}: non-ASCII in ascii panel line: ${JSON.stringify(text)}`);
      }
      const chipText = join(renderChipSegments(chip, "ascii"));
      if (/[^\x00-\x7f]/.test(chipText)) throw new Error(`${name}: non-ASCII in ascii chip: ${JSON.stringify(chipText)}`);
    }
  });
});
