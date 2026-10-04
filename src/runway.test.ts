import { describe, expect, test } from "bun:test";
import type { QuotaRow } from "./api";
import { computeRunway, pushSample } from "./runway";

const NOW = 1_000_000;

function row(o: { usage?: number | null; limit?: number | null; resetAt?: number | null } = {}): QuotaRow {
  return { label: "5h", usage: null, limit: null, percent: null, resetAt: null, ...o };
}

describe("pushSample", () => {
  test("resets history to the single new sample when usage decreases (window boundary)", () => {
    const result = pushSample([{ t: 0, usage: 200 }], { t: 60_000, usage: 150 }, null, 120);
    expect(result).toEqual([{ t: 60_000, usage: 150 }]);
  });

  test("appends without reset when usage increases or stays equal", () => {
    const increased = pushSample([{ t: 0, usage: 100 }], { t: 1000, usage: 150 }, null, 120);
    expect(increased).toEqual([
      { t: 0, usage: 100 },
      { t: 1000, usage: 150 },
    ]);

    const equal = pushSample([{ t: 0, usage: 100 }], { t: 1000, usage: 100 }, null, 120);
    expect(equal).toEqual([
      { t: 0, usage: 100 },
      { t: 1000, usage: 100 },
    ]);
  });

  test("caps history at maxHistory keeping the most recent samples", () => {
    const samples = [
      { t: 0, usage: 100 },
      { t: 1000, usage: 101 },
      { t: 2000, usage: 102 },
      { t: 3000, usage: 103 },
      { t: 4000, usage: 104 },
    ];
    let history: ReturnType<typeof pushSample> = [];
    for (const sample of samples) {
      history = pushSample(history, sample, null, 2);
    }
    expect(history).toHaveLength(2);
    expect(history).toEqual([
      { t: 3000, usage: 103 },
      { t: 4000, usage: 104 },
    ]);
  });
});

describe("computeRunway", () => {
  test("returns no-limit with computed resetInMs when limit is null and resetAt is set", () => {
    const result = computeRunway([], row({ usage: 50, limit: null, resetAt: NOW + 5000 }), NOW);
    expect(result).toEqual({ state: "no-limit", runwayMs: null, resetInMs: 5000, spanMs: null });
  });

  test("returns no-limit with null resetInMs when both limit and resetAt are null", () => {
    const result = computeRunway([], row({ usage: 50, limit: null, resetAt: null }), NOW);
    expect(result).toEqual({ state: "no-limit", runwayMs: null, resetInMs: null, spanMs: null });
  });

  test("returns no-reset when limit is set but resetAt is null", () => {
    const result = computeRunway(
      [
        { t: 0, usage: 50 },
        { t: 60_000, usage: 60 },
      ],
      row({ usage: 60, limit: 100, resetAt: null }),
      NOW,
    );
    expect(result).toEqual({ state: "no-reset", runwayMs: null, resetInMs: null, spanMs: null });
  });

  test("returns no-data for empty history, a single sample, or a span under 1000ms", () => {
    const fullRow = row({ usage: 110, limit: 1000, resetAt: NOW + 5000 });

    const empty = computeRunway([], fullRow, NOW);
    expect(empty).toEqual({ state: "no-data", runwayMs: null, resetInMs: 5000, spanMs: null });

    const single = computeRunway([{ t: 0, usage: 100 }], fullRow, NOW);
    expect(single).toEqual({ state: "no-data", runwayMs: null, resetInMs: 5000, spanMs: 0 });

    const shortSpan = computeRunway(
      [
        { t: 0, usage: 100 },
        { t: 999, usage: 110 },
      ],
      fullRow,
      NOW,
    );
    expect(shortSpan).toEqual({ state: "no-data", runwayMs: null, resetInMs: 5000, spanMs: 999 });
  });

  test("returns no-burn for zero burn rate (equal usage, big span) and for a crafted negative-burn history", () => {
    const noBurnRow = row({ usage: 100, limit: 200, resetAt: NOW + 12_345 });

    const zeroBurn = computeRunway(
      [
        { t: 0, usage: 100 },
        { t: 60_000, usage: 100 },
      ],
      noBurnRow,
      NOW,
    );
    expect(zeroBurn).toEqual({ state: "no-burn", runwayMs: null, resetInMs: 12_345, spanMs: 60_000 });

    const negativeBurn = computeRunway(
      [
        { t: 0, usage: 100 },
        { t: 60_000, usage: 50 },
      ],
      noBurnRow,
      NOW,
    );
    expect(negativeBurn).toEqual({
      state: "no-burn",
      runwayMs: null,
      resetInMs: 12_345,
      spanMs: 60_000,
    });
  });

  test("returns ok when runway exceeds resetIn", () => {
    // burn = 1/60000 per ms; remaining = 49; runway = 49 * 60000 = 2_940_000 > resetIn 600_000.
    const result = computeRunway(
      [
        { t: 0, usage: 50 },
        { t: 60_000, usage: 51 },
      ],
      row({ usage: 51, limit: 100, resetAt: NOW + 600_000 }),
      NOW,
    );
    expect(result.state).toBe("ok");
    expect(result.runwayMs).toBeCloseTo(2_940_000);
    expect(result.resetInMs).toBe(600_000);
  });

  test("returns warn when runway is less than resetIn", () => {
    // burn = 10/60000 per ms; remaining = 40; runway = 240_000 < resetIn 600_000.
    const result = computeRunway(
      [
        { t: 0, usage: 50 },
        { t: 60_000, usage: 60 },
      ],
      row({ usage: 60, limit: 100, resetAt: NOW + 600_000 }),
      NOW,
    );
    expect(result.state).toBe("warn");
    expect(result.runwayMs).toBeCloseTo(240_000);
    expect(result.resetInMs).toBe(600_000);
  });

  test("returns ok at the exact equality boundary runwayMs === resetInMs", () => {
    // Powers of two keep the float math exact: burn = 1/1024, remaining = 512,
    // runway = 524288, resetIn = 524288 -> equal -> ok.
    const result = computeRunway(
      [
        { t: 0, usage: 511 },
        { t: 1024, usage: 512 },
      ],
      row({ usage: 512, limit: 1024, resetAt: NOW + 524_288 }),
      NOW,
    );
    expect(result).toEqual({ state: "ok", runwayMs: 524_288, resetInMs: 524_288, spanMs: 1024 });
  });

  test("clamps a past resetAt to resetInMs 0 and warns on a finite negative runway", () => {
    // resetAt 5000ms in the past -> resetInMs clamped to 0 (never negative);
    // overquota usage gives a finite negative runway, which is < 0 -> warn.
    const result = computeRunway(
      [
        { t: 0, usage: 95 },
        { t: 60_000, usage: 105 },
      ],
      row({ usage: 105, limit: 100, resetAt: NOW - 5000 }),
      NOW,
    );
    expect(result.state).toBe("warn");
    expect(result.resetInMs).toBe(0);
    expect(result.runwayMs).toBeCloseTo(-30_000);
  });

  test("returns warn with negative runwayMs when usage exceeds limit and burn is positive", () => {
    // burn = 20/60000 per ms; remaining = -20; runway = -60_000 < resetIn 600_000.
    const result = computeRunway(
      [
        { t: 0, usage: 100 },
        { t: 60_000, usage: 120 },
      ],
      row({ usage: 120, limit: 100, resetAt: NOW + 600_000 }),
      NOW,
    );
    expect(result.state).toBe("warn");
    expect(result.runwayMs).toBeCloseTo(-60_000);
    expect(result.runwayMs!).toBeLessThan(0);
  });

  test("keeps runwayMs finite for MAX_SAFE_INTEGER usage/limit with unit delta over 60000ms span", () => {
    const MAX = Number.MAX_SAFE_INTEGER;
    const result = computeRunway(
      [
        { t: 0, usage: MAX - 60_001 },
        { t: 60_000, usage: MAX - 60_000 },
      ],
      row({ usage: MAX - 60_000, limit: MAX, resetAt: NOW + 1000 }),
      NOW,
    );
    expect(Number.isFinite(result.runwayMs)).toBe(true);
    expect(result.runwayMs).toBeCloseTo(3_600_000_000);
    expect(result.state).toBe("ok");
  });

  test("leaves input arrays and objects unchanged after calls (purity)", () => {
    const history = [
      { t: 0, usage: 100 },
      { t: 1000, usage: 110 },
    ];
    const historySnapshot = history.map((sample) => ({ ...sample }));
    const quotaRow = row({ usage: 120, limit: 100, resetAt: NOW + 600_000 });
    const rowSnapshot = { ...quotaRow };
    const appendedSample = { t: 2000, usage: 120 };
    const decreasedSample = { t: 3000, usage: 50 };

    const appended = pushSample(history, appendedSample, null, 10);
    expect(appended).not.toBe(history);
    expect(appended).toHaveLength(3);
    expect(appended[0]).toBe(history[0]);
    expect(appended[2]).toBe(appendedSample);

    const reset = pushSample(history, decreasedSample, null, 10);
    expect(reset).toEqual([decreasedSample]);
    expect(reset[0]).toBe(decreasedSample);

    computeRunway(history, quotaRow, NOW);

    expect(history).toEqual(historySnapshot);
    expect(quotaRow).toEqual(rowSnapshot);
  });
});

describe("pushSample boundary regressions", () => {
  test("resets to a single sample when usage decreases while history is already at maxHistory cap", () => {
    const capped = [
      { t: 0, usage: 100 },
      { t: 1000, usage: 110 },
    ];
    const result = pushSample(capped, { t: 2000, usage: 90 }, null, 2);
    // The decrease check must win over the cap trim: result is 1 sample, not a
    // re-sliced window of 2.
    expect(result).toEqual([{ t: 2000, usage: 90 }]);
    expect(result).toHaveLength(1);
  });
});

describe("non-finite resetAt guard (F1)", () => {
  test("resetAt NaN with limit set returns no-reset with null resetInMs", () => {
    const result = computeRunway(
      [
        { t: 0, usage: 50 },
        { t: 60_000, usage: 60 },
      ],
      row({ usage: 60, limit: 100, resetAt: Number.NaN }),
      NOW,
    );
    expect(result).toEqual({ state: "no-reset", runwayMs: null, resetInMs: null, spanMs: null });
  });

  test("resetAt Infinity with limit set also returns no-reset", () => {
    const result = computeRunway(
      [],
      row({ usage: 60, limit: 100, resetAt: Number.POSITIVE_INFINITY }),
      NOW,
    );
    expect(result).toEqual({ state: "no-reset", runwayMs: null, resetInMs: null, spanMs: null });
  });

  test("resetAt NaN with null limit returns no-limit with null (not NaN) resetInMs", () => {
    const result = computeRunway([], row({ usage: 50, limit: null, resetAt: Number.NaN }), NOW);
    expect(result).toEqual({ state: "no-limit", runwayMs: null, resetInMs: null, spanMs: null });
  });
});

describe("maxHistory degenerate clamp (F4)", () => {
  const sample = { t: 1000, usage: 42 };

  test("maxHistory 0 clamps to 1: pushing onto [] returns [sample]", () => {
    const result = pushSample([], sample, null, 0);
    expect(result).toEqual([sample]);
    expect(result).toHaveLength(1);
  });

  test("maxHistory -5 clamps to 1: pushing onto [] returns [sample]", () => {
    const result = pushSample([], sample, null, -5);
    expect(result).toEqual([sample]);
    expect(result).toHaveLength(1);
  });

  test("maxHistory 0 on non-empty history keeps only the most recent sample", () => {
    const result = pushSample([{ t: 0, usage: 10 }], { t: 500, usage: 20 }, null, 0);
    expect(result).toEqual([{ t: 500, usage: 20 }]);
  });

  test("fractional maxHistory floors (2.7 acts as 2)", () => {
    const result = pushSample(
      [
        { t: 0, usage: 10 },
        { t: 100, usage: 11 },
        { t: 200, usage: 12 },
      ],
      { t: 300, usage: 13 },
      null,
      2.7,
    );
    expect(result).toEqual([
      { t: 200, usage: 12 },
      { t: 300, usage: 13 },
    ]);
  });
});

describe("computeRunway boundary regressions", () => {
  test("identical timestamps (span 0) return no-data without dividing by zero", () => {
    // Equal usage would make burn 0/0 (NaN); differing usage would make it
    // x/0 (Infinity, which would otherwise silently yield state "ok" with a
    // zero runway). The span gate must catch both before the division.
    const equalUsage = computeRunway(
      [
        { t: 5000, usage: 42 },
        { t: 5000, usage: 42 },
      ],
      row({ usage: 42, limit: 100, resetAt: NOW + 5000 }),
      NOW,
    );
    expect(equalUsage).toEqual({ state: "no-data", runwayMs: null, resetInMs: 5000, spanMs: 0 });

    const differingUsage = computeRunway(
      [
        { t: 5000, usage: 10 },
        { t: 5000, usage: 90 },
      ],
      row({ usage: 90, limit: 100, resetAt: NOW + 5000 }),
      NOW,
    );
    expect(differingUsage).toEqual({ state: "no-data", runwayMs: null, resetInMs: 5000, spanMs: 0 });
  });

  test("null usage with limit set returns no-data even when history is well-formed", () => {
    // History is degenerate-free (2 samples, large span, positive burn), so
    // only the explicit row.usage == null gate can produce no-data here.
    const result = computeRunway(
      [
        { t: 0, usage: 100 },
        { t: 60_000, usage: 150 },
      ],
      row({ usage: null, limit: 100, resetAt: NOW + 5000 }),
      NOW,
    );
    expect(result).toEqual({ state: "no-data", runwayMs: null, resetInMs: 5000, spanMs: 60_000 });
  });

  test("no-limit clamps past resetAt to resetInMs 0 (boundary: resetAt === now)", () => {
    const atNow = computeRunway([], row({ limit: null, resetAt: NOW }), NOW);
    expect(atNow).toEqual({ state: "no-limit", runwayMs: null, resetInMs: 0, spanMs: null });

    const pastNow = computeRunway([], row({ limit: null, resetAt: NOW - 1 }), NOW);
    expect(pastNow.state).toBe("no-limit");
    expect(pastNow.resetInMs).toBe(0);
  });

  test("deep-frozen inputs do not throw or mutate (strict-mode purity)", () => {
    const deepFreeze = (value: unknown): unknown => {
      if (value !== null && typeof value === "object") {
        for (const key of Object.keys(value as Record<string, unknown>)) {
          deepFreeze((value as Record<string, unknown>)[key]);
        }
        Object.freeze(value);
      }
      return value;
    };

    const history = deepFreeze([
      { t: 0, usage: 100 },
      { t: 1000, usage: 110 },
    ]) as Array<{ t: number; usage: number }>;
    const quotaRow = deepFreeze(row({ usage: 110, limit: 200, resetAt: NOW + 5000 })) as QuotaRow;
    const sample = deepFreeze({ t: 2000, usage: 120 }) as { t: number; usage: number };

    const appended = pushSample(history, sample, null, 10);
    expect(appended).toHaveLength(3);
    expect(computeRunway(history, quotaRow, NOW).state).toBe("ok");

    // A write to any frozen input would throw in ESM strict mode.
    expect(history).toHaveLength(2);
    expect(quotaRow.usage).toBe(110);
  });
});

describe("spanMs reporting (additive, no algorithm change)", () => {
  test("ok state reports the exact history span used for the projection", () => {
    const result = computeRunway(
      [
        { t: 5_000, usage: 50 },
        { t: 65_000, usage: 51 },
      ],
      row({ usage: 51, limit: 100, resetAt: NOW + 600_000 }),
      NOW,
    );
    expect(result.state).toBe("ok");
    expect(result.spanMs).toBe(60_000);
  });

  test("warn state reports the exact history span", () => {
    const result = computeRunway(
      [
        { t: 1_000, usage: 50 },
        { t: 121_000, usage: 60 },
      ],
      row({ usage: 60, limit: 100, resetAt: NOW + 600_000 }),
      NOW,
    );
    expect(result.state).toBe("warn");
    expect(result.spanMs).toBe(120_000);
  });

  test("no-data with a single sample reports spanMs 0", () => {
    const result = computeRunway(
      [{ t: 42_000, usage: 100 }],
      row({ usage: 100, limit: 200, resetAt: NOW + 5000 }),
      NOW,
    );
    expect(result.state).toBe("no-data");
    expect(result.spanMs).toBe(0);
  });

  test("no-data with empty history reports spanMs null", () => {
    const result = computeRunway([], row({ usage: 100, limit: 200, resetAt: NOW + 5000 }), NOW);
    expect(result.state).toBe("no-data");
    expect(result.spanMs).toBeNull();
  });

  test("no-limit and no-reset report spanMs null even with a populated history", () => {
    const history = [
      { t: 0, usage: 50 },
      { t: 60_000, usage: 60 },
    ];
    const noLimit = computeRunway(history, row({ usage: 60, limit: null, resetAt: NOW + 5000 }), NOW);
    expect(noLimit.state).toBe("no-limit");
    expect(noLimit.spanMs).toBeNull();

    const noReset = computeRunway(history, row({ usage: 60, limit: 100, resetAt: null }), NOW);
    expect(noReset.state).toBe("no-reset");
    expect(noReset.spanMs).toBeNull();
  });

  test("no-burn reports the span of the window samples", () => {
    const result = computeRunway(
      [
        { t: 10_000, usage: 100 },
        { t: 40_000, usage: 100 },
        { t: 70_000, usage: 100 },
      ],
      row({ usage: 100, limit: 200, resetAt: NOW + 12_345 }),
      NOW,
    );
    expect(result.state).toBe("no-burn");
    expect(result.spanMs).toBe(60_000);
  });
});
