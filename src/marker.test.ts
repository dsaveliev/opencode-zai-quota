import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { elapsedMs, markerIndex, WINDOW_MS } from "./marker";

const MIN = 60_000;

describe("WINDOW_MS", () => {
  test("maps plan tiers to exact window lengths", () => {
    expect(WINDOW_MS[3]).toBe(18_000_000);
    expect(WINDOW_MS[6]).toBe(604_800_000);
  });
});

describe("elapsedMs", () => {
  test("full window has elapsed at the reset moment", () => {
    const resetAt = 1_700_000_000_000;
    expect(elapsedMs(resetAt, resetAt, 300 * MIN)).toBe(300 * MIN);
  });

  test("nothing has elapsed at the window start", () => {
    const resetAt = 1_700_000_000_000;
    expect(elapsedMs(resetAt - 604_800_000, resetAt, 604_800_000)).toBe(0);
  });
});

describe("markerIndex", () => {
  const W = WINDOW_MS[3];

  test("elapsed 0 maps to the first cell", () => {
    expect(markerIndex(0, W, 8)).toBe(0);
  });

  test("elapsed == window maps to the last cell", () => {
    expect(markerIndex(W, W, 8)).toBe(7);
  });

  test("elapsed beyond the window clamps to the last cell", () => {
    expect(markerIndex(2 * W, W, 8)).toBe(7);
  });

  test("negative elapsed clamps to the first cell", () => {
    expect(markerIndex(-5_000, W, 8)).toBe(0);
  });

  test("width 16 fractional positions floor correctly", () => {
    expect(markerIndex(0.76 * W, W, 16)).toBe(12); // 0.76 * 16 = 12.16
    expect(markerIndex(0.5476 * W, W, 16)).toBe(8); // 0.5476 * 16 = 8.7616
  });

  test("width 2 yields both indices", () => {
    expect(markerIndex(0, W, 2)).toBe(0);
    expect(markerIndex(0.5 * W, W, 2)).toBe(1);
    expect(markerIndex(W, W, 2)).toBe(1);
  });

  test("degenerate windowMs or width returns null", () => {
    expect(markerIndex(1_000, undefined, 8)).toBeNull();
    expect(markerIndex(1_000, null, 8)).toBeNull();
    expect(markerIndex(1_000, 0, 8)).toBeNull();
    expect(markerIndex(1_000, -1, 8)).toBeNull();
    expect(markerIndex(1_000, Number.NaN, 8)).toBeNull();
    expect(markerIndex(1_000, Number.POSITIVE_INFINITY, 8)).toBeNull();
    expect(markerIndex(1_000, W, 1)).toBeNull();
  });
});

describe("module purity", () => {
  test("marker.ts imports nothing", () => {
    const source = readFileSync(new URL("./marker.ts", import.meta.url), "utf8");
    expect(/^\s*import[\s({]/m.test(source)).toBe(false);
    expect(/\bimport\s*\(/.test(source)).toBe(false);
    expect(/\brequire\s*\(/.test(source)).toBe(false);
  });

  test("marker.ts has no clock, console, global, fs or timer tokens", () => {
    const source = readFileSync(new URL("./marker.ts", import.meta.url), "utf8");
    const forbidden = /Date\.now|new Date|console\.|globalThis|setTimeout|setInterval|setImmediate|\bfs\.|require\(/;
    expect(source.match(forbidden)?.join(",") ?? null).toBeNull();
  });
});

describe("W1 audit: gauge boundaries", () => {
  const W = WINDOW_MS[3];

  test("width 16: fraction 0.999 floors to width-1 (floor(15.984) = 15)", () => {
    expect(markerIndex(0.999 * W, W, 16)).toBe(15);
  });

  test("width 40 (max realistic): last-cell, cell-entry and mid-cell boundaries", () => {
    expect(markerIndex(0, W, 40)).toBe(0);
    expect(markerIndex(0.5 * W, W, 40)).toBe(20);
    expect(markerIndex((39 / 40) * W, W, 40)).toBe(39); // exact entry into cell 39 (fp-safe: ratio*40 == 39 exactly)
    expect(markerIndex((39 / 40) * W - 1, W, 40)).toBe(38); // 1ms before entry floors back to 38
    expect(markerIndex(0.999 * W, W, 40)).toBe(39);
    expect(markerIndex(W, W, 40)).toBe(39); // full window clamps into the last cell
  });
});

// ---------------------------------------------------------------------------
// Review fix F4: symmetric finite guard on elapsed. Non-finite elapsed is
// garbage in -> no marker. Semantics change pinned here: Infinity used to
// clamp to width-1 and NaN leaked a NaN index; both are null now.
// ---------------------------------------------------------------------------

describe("review fix F4: non-finite elapsed yields no marker", () => {
  test("NaN elapsed is null", () => {
    expect(markerIndex(Number.NaN, 18_000_000, 16)).toBeNull();
  });

  test("Infinity elapsed is null (was width-1)", () => {
    expect(markerIndex(Number.POSITIVE_INFINITY, 18_000_000, 16)).toBeNull();
  });

  test("-Infinity elapsed is null (negative finite still clamps to 0)", () => {
    expect(markerIndex(Number.NEGATIVE_INFINITY, 18_000_000, 16)).toBeNull();
    expect(markerIndex(-5_000, 18_000_000, 16)).toBe(0);
  });
});
