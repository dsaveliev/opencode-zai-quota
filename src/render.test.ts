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
