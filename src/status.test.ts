import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { classifyWindow, VERDICT_SEVERITY, worstVerdict, type StatusInput } from "./status";

const MIN = 60_000;

function base(overrides: Partial<StatusInput> = {}): StatusInput {
  return {
    usage: 312,
    limit: 500,
    runwayMs: 90 * MIN,
    runwayState: "ok",
    resetInMs: 60 * MIN,
    spanMs: 5 * MIN,
    stale: false,
    tightFactor: 1.5,
    ...overrides,
  };
}

describe("classifyWindow", () => {
  test("usage >= limit is blocked (equality and above)", () => {
    expect(classifyWindow(base({ usage: 500, limit: 500 }))).toBe("blocked");
    expect(classifyWindow(base({ usage: 505, limit: 500 }))).toBe("blocked");
  });

  test("blocked wins over stale, short span and no-data (rule 1 precedence)", () => {
    const input = base({
      usage: 500,
      limit: 500,
      stale: true,
      spanMs: 1_000,
      runwayState: "no-data",
    });
    expect(classifyWindow(input)).toBe("blocked");
  });

  test("stale sample is unknown", () => {
    expect(classifyWindow(base({ usage: 312, limit: 500, runwayState: "ok", stale: true }))).toBe("unknown");
  });

  test("span below 60s is unknown", () => {
    expect(classifyWindow(base({ spanMs: 59_999 }))).toBe("unknown");
  });

  test("span of exactly 60s passes the guard", () => {
    expect(classifyWindow(base({ spanMs: 60_000, runwayMs: 90 * MIN, resetInMs: 60 * MIN, tightFactor: 1.5 }))).toBe("ok");
  });

  test("no-burn is ok even when runwayMs is null", () => {
    expect(classifyWindow(base({ runwayState: "no-burn", runwayMs: null }))).toBe("ok");
  });

  for (const state of ["no-data", "no-limit", "no-reset"] as const) {
    test(`runwayState ${state} is unknown`, () => {
      expect(classifyWindow(base({ runwayState: state }))).toBe("unknown");
    });
  }

  test("runway < reset is short; 35m also satisfies the tight band (35 < 90), but rule 7 fires before rule 8", () => {
    expect(classifyWindow(base({ runwayMs: 35 * MIN, resetInMs: 60 * MIN, tightFactor: 1.5 }))).toBe("short");
  });

  test("runway == reset is tight (equality band start)", () => {
    expect(classifyWindow(base({ runwayMs: 60 * MIN, resetInMs: 60 * MIN }))).toBe("tight");
  });

  test("runway inside the tight band is tight", () => {
    expect(classifyWindow(base({ runwayMs: 89 * MIN, resetInMs: 60 * MIN }))).toBe("tight");
  });

  test("runway == reset * tightFactor is ok (upper boundary)", () => {
    expect(classifyWindow(base({ runwayMs: 90 * MIN, resetInMs: 60 * MIN, tightFactor: 1.5 }))).toBe("ok");
  });

  test("tightFactor 2.0 shifts the ok boundary", () => {
    expect(classifyWindow(base({ runwayMs: 119 * MIN, resetInMs: 60 * MIN, tightFactor: 2.0 }))).toBe("tight");
    expect(classifyWindow(base({ runwayMs: 120 * MIN, resetInMs: 60 * MIN, tightFactor: 2.0 }))).toBe("ok");
  });

  test("null usage or limit makes blocked impossible and falls through to runway math", () => {
    expect(classifyWindow(base({ usage: null }))).toBe("ok");
    expect(classifyWindow(base({ limit: null }))).toBe("ok");
  });
});

describe("VERDICT_SEVERITY", () => {
  test("orders ok < tight < short < blocked", () => {
    expect(VERDICT_SEVERITY.ok).toBeLessThan(VERDICT_SEVERITY.tight);
    expect(VERDICT_SEVERITY.tight).toBeLessThan(VERDICT_SEVERITY.short);
    expect(VERDICT_SEVERITY.short).toBeLessThan(VERDICT_SEVERITY.blocked);
  });
});

describe("worstVerdict", () => {
  test("picks the most severe verdict", () => {
    expect(worstVerdict(["ok", "tight"])).toBe("tight");
    expect(worstVerdict(["tight", "short", "ok"])).toBe("short");
    expect(worstVerdict(["short", "blocked"])).toBe("blocked");
  });

  test("unknown entries are filtered out", () => {
    expect(worstVerdict(["unknown", "ok"])).toBe("ok");
  });

  test("empty, lone unknown and all-unknown inputs return unknown", () => {
    expect(worstVerdict([])).toBe("unknown");
    expect(worstVerdict(["unknown"])).toBe("unknown");
    expect(worstVerdict(["unknown", "unknown"])).toBe("unknown");
  });
});

describe("module purity", () => {
  test("status.ts imports nothing", () => {
    const source = readFileSync(new URL("./status.ts", import.meta.url), "utf8");
    expect(/^\s*import[\s({]/m.test(source)).toBe(false);
    expect(/\bimport\s*\(/.test(source)).toBe(false);
    expect(/\brequire\s*\(/.test(source)).toBe(false);
  });

  test("status.ts has no clock, console, global, fs or timer tokens", () => {
    const source = readFileSync(new URL("./status.ts", import.meta.url), "utf8");
    const forbidden = /Date\.now|new Date|console\.|globalThis|setTimeout|setInterval|setImmediate|\bfs\.|require\(/;
    expect(source.match(forbidden)?.join(",") ?? null).toBeNull();
  });
});

describe("W1 audit: classifyWindow boundaries", () => {
  test("usage and limit both null -> blocked impossible, runway math decides (ok)", () => {
    expect(classifyWindow(base({ usage: null, limit: null }))).toBe("ok");
  });

  test("zero runway dries up strictly before the reset -> short", () => {
    expect(classifyWindow(base({ runwayMs: 0 }))).toBe("short");
  });

  test("zero runway and zero reset: equality falls through rules 7 and 8 -> ok (empty band)", () => {
    expect(classifyWindow(base({ runwayMs: 0, resetInMs: 0 }))).toBe("ok");
  });

  test("resetInMs 0 with positive runway -> ok (runway survives an already-arrived reset)", () => {
    expect(classifyWindow(base({ resetInMs: 0, runwayMs: 1 * MIN }))).toBe("ok");
  });

  test("tightFactor exactly 1 empties the tight band: runway == reset is ok, below is short", () => {
    expect(classifyWindow(base({ runwayMs: 60 * MIN, resetInMs: 60 * MIN, tightFactor: 1 }))).toBe("ok");
    expect(classifyWindow(base({ runwayMs: 59 * MIN, resetInMs: 60 * MIN, tightFactor: 1 }))).toBe("short");
    expect(classifyWindow(base({ runwayMs: 61 * MIN, resetInMs: 60 * MIN, tightFactor: 1 }))).toBe("ok");
  });
});

// ---------------------------------------------------------------------------
// Review fix F3: non-finite runway inputs support no verdict — NaN/Infinity
// must land in "unknown" instead of sneaking through the comparison ladder
// (NaN comparisons are all false -> "ok"; Infinity reset -> "short").
// ---------------------------------------------------------------------------

describe("review fix F3: non-finite runway inputs are unknown", () => {
  test("runwayMs NaN (runwayState ok, otherwise short-worthy numbers) is unknown", () => {
    expect(classifyWindow(base({ runwayMs: Number.NaN, resetInMs: 60 * MIN }))).toBe("unknown");
  });

  test("resetInMs Infinity is unknown", () => {
    expect(classifyWindow(base({ runwayMs: 90 * MIN, resetInMs: Number.POSITIVE_INFINITY }))).toBe("unknown");
  });

  test("finite inputs still classify (regression: guards do not overfire)", () => {
    expect(classifyWindow(base({ runwayMs: 30 * MIN, resetInMs: 60 * MIN }))).toBe("short");
    expect(classifyWindow(base({ runwayMs: 90 * MIN, resetInMs: 60 * MIN }))).toBe("ok");
  });
});
