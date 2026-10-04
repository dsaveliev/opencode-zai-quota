import { describe, expect, test } from "bun:test";
import { fetchQuota, parseQuota } from "./api";

const happyPayload = {
  code: 200,
  success: true,
  data: {
    level: "Lite",
    limits: [
      {
        type: "a",
        unit: 3,
        number: 1,
        usage: 100,
        currentValue: 80,
        remaining: 20,
        percentage: 80,
        nextResetTime: 1759000000000,
      },
      { type: "b", unit: 6, currentValue: 5, remaining: 15 },
    ],
  },
};

describe("parseQuota", () => {
  test("full happy path maps limits with preferred fields", () => {
    const { rows, level } = parseQuota(happyPayload);
    expect(level).toBe("Lite");
    expect(rows).toHaveLength(2);
    expect(rows[0]).toEqual({
      label: "5h",
      usage: 80,
      limit: 100,
      percent: 80,
      resetAt: 1759000000000,
    });
    expect(rows[1]).toEqual({
      label: "wk",
      usage: 5,
      limit: 20,
      percent: 25,
      resetAt: null,
    });
  });

  test("percentage is clamped to [0, 100]", () => {
    const over = parseQuota({ data: { limits: [{ type: "a", percentage: 150 }] } });
    expect(over.rows[0]?.percent).toBe(100);

    const under = parseQuota({ data: { limits: [{ type: "a", percentage: -5 }] } });
    expect(under.rows[0]?.percent).toBe(0);
  });

  test("percent is null when percentage absent and not derivable (no NaN)", () => {
    const noUsage = parseQuota({ data: { limits: [{ type: "a" }] } });
    expect(noUsage.rows[0]?.percent).toBeNull();

    const zeroLimit = parseQuota({ data: { limits: [{ type: "a", usage: 0, remaining: 0 }] } });
    expect(zeroLimit.rows[0]?.percent).toBeNull();
  });

  test("non-numeric nextResetTime yields null resetAt", () => {
    const parsed = parseQuota({ data: { limits: [{ type: "a", nextResetTime: "2026-01-01" }] } });
    expect(parsed.rows[0]?.resetAt).toBeNull();
  });

  test("label falls back from unit to type to 'quota'", () => {
    const parsed = parseQuota({
      data: { limits: [{ type: "custom-limit" }, { usage: 1, remaining: 1 }, { type: "" }] },
    });
    expect(parsed.rows.map((r) => r.label)).toEqual(["custom-limit", "quota", "quota"]);
  });

  test("empty limits array triggers generic scan elsewhere in payload", () => {
    const payload = {
      data: { level: "Lite", limits: [], extra: { type: "migrated", usage: 3, remaining: 9 } },
    };
    const { rows, level } = parseQuota(payload);
    expect(level).toBe("Lite");
    expect(rows).toHaveLength(1);
    expect(rows[0]).toEqual({ label: "migrated", usage: 3, limit: 12, percent: 25, resetAt: null });
  });

  test("non-array limits triggers generic scan", () => {
    const payload = { data: { limits: "nope", nested: { deep: { currentValue: 10, remaining: 30 } } } };
    const { rows } = parseQuota(payload);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toEqual({ label: "quota", usage: 10, limit: 40, percent: 25, resetAt: null });
  });

  test("empty and non-object payloads return empty rows and null level", () => {
    expect(parseQuota({})).toEqual({ rows: [], level: null });
    expect(parseQuota(null)).toEqual({ rows: [], level: null });
    expect(parseQuota("str")).toEqual({ rows: [], level: null });
    expect(parseQuota(42)).toEqual({ rows: [], level: null });
  });

  test("invalid limit entries are skipped without throwing", () => {
    expect(parseQuota({ data: { limits: [null] } }).rows).toEqual([]);
    expect(parseQuota({ data: { limits: [42] } }).rows).toEqual([]);
    expect(parseQuota({ data: { limits: [{}] } }).rows).toEqual([]);

    const mixed = parseQuota({
      data: { limits: [null, 42, { type: "keep", usage: 1, remaining: 1 }] },
    });
    expect(mixed.rows).toHaveLength(1);
    expect(mixed.rows[0]?.label).toBe("keep");
  });

  test("level must be a non-empty string", () => {
    expect(parseQuota({ data: { level: 42, limits: [] } }).level).toBeNull();
    expect(parseQuota({ data: { level: "", limits: [] } }).level).toBeNull();
  });

  test("duplicate unit-3 rows are all kept", () => {
    const parsed = parseQuota({ data: { limits: [{ unit: 3, usage: 1 }, { unit: 3, usage: 2 }] } });
    expect(parsed.rows.map((r) => r.label)).toEqual(["5h", "5h"]);
  });

  test("cyclic payload does not hang during generic scan", () => {
    const cyclic: Record<string, unknown> = { data: { usage: 1, remaining: 1 } };
    cyclic.self = cyclic;
    const parsed = parseQuota(cyclic);
    expect(parsed.rows).toHaveLength(1);
    expect(parsed.rows[0]?.label).toBe("quota");
  });
});

describe("fetchQuota", () => {
  test("success returns parsed payload", async () => {
    const fetchImpl = async () => ({ status: 200, text: JSON.stringify(happyPayload) });
    const result = await fetchQuota(fetchImpl, "tok-1", {
      endpoint: "https://api.test/quota",
      timeoutMs: 1000,
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.payload).toEqual(happyPayload);
    }
  });

  test("sends Authorization header with Bearer token", async () => {
    let captured: { headers: Record<string, string>; signal: AbortSignal } | undefined;
    const fetchImpl = async (
      _url: string,
      init: { headers: Record<string, string>; signal: AbortSignal },
    ): Promise<{ status: number; text: string }> => {
      captured = init;
      return { status: 200, text: "{}" };
    };
    await fetchQuota(fetchImpl, "tok-1", { endpoint: "https://api.test/quota", timeoutMs: 1000 });
    expect(captured?.headers.Authorization).toBe("Bearer tok-1");
  });

  test("http error statuses map to http-<status>", async () => {
    const rateLimited = async (): Promise<{ status: number; text: string }> => ({ status: 429, text: "{}" });
    const rateLimitedResult = await fetchQuota(rateLimited, "t", { endpoint: "u", timeoutMs: 100 });
    expect(rateLimitedResult).toEqual({ ok: false, error: "http-429" });

    const serverError = async (): Promise<{ status: number; text: string }> => ({ status: 500, text: "{}" });
    const serverErrorResult = await fetchQuota(serverError, "t", { endpoint: "u", timeoutMs: 100 });
    expect(serverErrorResult).toEqual({ ok: false, error: "http-500" });
  });

  test("non-JSON body maps to bad-json", async () => {
    const fetchImpl = async (): Promise<{ status: number; text: string }> => ({
      status: 200,
      text: "<html>oops",
    });
    const result = await fetchQuota(fetchImpl, "t", { endpoint: "u", timeoutMs: 100 });
    expect(result).toEqual({ ok: false, error: "bad-json" });
  });

  test("fetch rejection maps to network without leaking the message", async () => {
    const fetchImpl = async (): Promise<{ status: number; text: string }> => {
      throw new Error("ECONNREFUSED dark-secret");
    };
    const result = await fetchQuota(fetchImpl, "tok-secret", { endpoint: "u", timeoutMs: 100 });
    expect(result).toEqual({ ok: false, error: "network" });
    if (!result.ok) {
      expect(result.error).not.toContain("ECONNREFUSED");
    }
  });

  test("timeout wins when fetch ignores the abort signal", async () => {
    const started = Date.now();
    const lateFetch = (): Promise<{ status: number; text: string }> =>
      new Promise((resolve) => {
        setTimeout(() => resolve({ status: 200, text: JSON.stringify(happyPayload) }), 5000);
      });
    const result = await fetchQuota(lateFetch, "tok", { endpoint: "u", timeoutMs: 20 });
    const elapsed = Date.now() - started;
    expect(result).toEqual({ ok: false, error: "timeout" });
    expect(elapsed).toBeLessThan(1000);
  });

  test("usage Infinity is treated as null; Infinity currentValue falls back to usage", () => {
    const infUsage = parseQuota({ data: { limits: [{ type: "a", usage: Infinity }] } });
    expect(infUsage.rows[0]?.usage).toBeNull();
    expect(infUsage.rows[0]?.limit).toBeNull();
    expect(infUsage.rows[0]?.percent).toBeNull();

    const infCurrent = parseQuota({
      data: { limits: [{ type: "a", currentValue: Infinity, usage: 5, remaining: 5 }] },
    });
    expect(infCurrent.rows[0]?.usage).toBe(5);
    expect(infCurrent.rows[0]?.limit).toBe(10);
  });

  test("usage + remaining overflow to Infinity leaves limit and percent null", () => {
    const parsed = parseQuota({
      data: { limits: [{ type: "a", currentValue: Number.MAX_VALUE, remaining: Number.MAX_VALUE }] },
    });
    expect(parsed.rows[0]?.usage).toBe(Number.MAX_VALUE);
    expect(parsed.rows[0]?.limit).toBeNull();
    expect(parsed.rows[0]?.percent).toBeNull();
  });

  test("percentage NaN is treated as absent (derived or null, never NaN)", () => {
    const alone = parseQuota({ data: { limits: [{ type: "a", percentage: NaN }] } });
    expect(alone.rows[0]?.percent).toBeNull();

    const derivable = parseQuota({
      data: { limits: [{ type: "a", percentage: NaN, usage: 3, remaining: 1 }] },
    });
    expect(derivable.rows[0]?.percent).toBe(75);
    expect(Number.isNaN(derivable.rows[0]?.percent as number)).toBe(false);
  });

  test("generic scan depth cap: entry at depth 6 is collected, depth 7 is not", () => {
    const w = (v: unknown): Record<string, unknown> => ({ skip: true, v });
    const wrap = (n: number): Record<string, unknown> => {
      let node: Record<string, unknown> = { usage: 1, remaining: 1 };
      for (let i = 0; i < n; i++) node = w(node);
      return node;
    };

    // data at depth 1, then 4 wrappers -> entry at depth 6 (<= cap): collected.
    const atCap = parseQuota({ data: { pad: wrap(4) } });
    expect(atCap.rows).toEqual([
      { label: "quota", usage: 1, limit: 2, percent: 50, resetAt: null },
    ]);

    // 5 wrappers -> entry at depth 7 (> cap): NOT collected.
    const beyondCap = parseQuota({ data: { pad: wrap(5) } });
    expect(beyondCap.rows).toEqual([]);
  });

  test("status 400 boundary maps to http-400", async () => {
    const fetchImpl = async (): Promise<{ status: number; text: string }> => ({ status: 400, text: "{}" });
    const result = await fetchQuota(fetchImpl, "t", { endpoint: "u", timeoutMs: 100 });
    expect(result).toEqual({ ok: false, error: "http-400" });
  });

  test("status 399 still proceeds to JSON parsing (not treated as http error)", async () => {
    const fetchImpl = async (): Promise<{ status: number; text: string }> => ({
      status: 399,
      text: JSON.stringify(happyPayload),
    });
    const result = await fetchQuota(fetchImpl, "t", { endpoint: "u", timeoutMs: 100 });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.payload).toEqual(happyPayload);
    }
  });

  test("token containing newlines goes only into the Authorization header, without error", async () => {
    let capturedUrl: string | undefined;
    let capturedHeaders: Record<string, string> | undefined;
    const fetchImpl = async (
      url: string,
      init: { headers: Record<string, string>; signal: AbortSignal },
    ): Promise<{ status: number; text: string }> => {
      capturedUrl = url;
      capturedHeaders = init.headers;
      return { status: 200, text: "{}" };
    };
    const result = await fetchQuota(fetchImpl, "tok\nwith\nnewlines", {
      endpoint: "https://api.test/quota",
      timeoutMs: 100,
    });
    expect(result.ok).toBe(true);
    expect(capturedHeaders?.Authorization).toBe("Bearer tok\nwith\nnewlines");
    expect(capturedUrl).toBe("https://api.test/quota");
  });

  test("non-finite timeoutMs falls back to the 8000 default and still succeeds", async () => {
    const fetchImpl = async (): Promise<{ status: number; text: string }> => ({ status: 200, text: "{}" });
    const nan = await fetchQuota(fetchImpl, "t", { endpoint: "u", timeoutMs: NaN });
    expect(nan.ok).toBe(true);
    const inf = await fetchQuota(fetchImpl, "t", { endpoint: "u", timeoutMs: Infinity });
    expect(inf.ok).toBe(true);
  });

  test("double invocation is independent (no shared state between calls)", async () => {
    const seen: string[] = [];
    const mk = (token: string) => async (
      _url: string,
      init: { headers: Record<string, string>; signal: AbortSignal },
    ): Promise<{ status: number; text: string }> => {
      seen.push(init.headers.Authorization);
      return { status: 200, text: JSON.stringify({ token }) };
    };
    const [a, b] = await Promise.all([
      fetchQuota(mk("tok-a"), "tok-a", { endpoint: "u", timeoutMs: 100 }),
      fetchQuota(mk("tok-b"), "tok-b", { endpoint: "u", timeoutMs: 100 }),
    ]);
    expect(a.ok).toBe(true);
    expect(b.ok).toBe(true);
    expect(seen.sort()).toEqual(["Bearer tok-a", "Bearer tok-b"]);
    if (a.ok && b.ok) {
      expect(a.payload).toEqual({ token: "tok-a" });
      expect(b.payload).toEqual({ token: "tok-b" });
    }
  });

  test("success path clears the abort timer (no dangling timer, no unhandled rejection)", async () => {
    const fetchImpl = async (): Promise<{ status: number; text: string }> => ({ status: 200, text: "{}" });
    const result = await fetchQuota(fetchImpl, "t", { endpoint: "u", timeoutMs: 30 });
    expect(result.ok).toBe(true);
    // If the 30ms abort timer were not cleared in the finally block, it would fire
    // after the race settled and reject the unobserved timeout promise, producing an
    // unhandled rejection that fails this test file. 80ms > 30ms with ~2.7x margin.
    await new Promise<void>((resolve) => setTimeout(resolve, 80));
  });
});

describe("parseQuota row cap (F6)", () => {
  test("limits fast path caps rows at 16, keeping the first 16 in order", () => {
    const limits = Array.from({ length: 20 }, (_, i) => ({ type: "t" + i, percentage: i }));
    const { rows } = parseQuota({ data: { limits } });
    expect(rows).toHaveLength(16);
    expect(rows.map((r) => r.label)).toEqual(Array.from({ length: 16 }, (_, i) => "t" + i));
  });

  test("generic scan collector also stops at 16 rows", () => {
    const items = Array.from({ length: 20 }, (_, i) => ({
      type: "s" + i,
      usage: i,
      remaining: 100,
    }));
    const { rows } = parseQuota({ data: { nested: { items } } });
    expect(rows).toHaveLength(16);
    expect(rows.map((r) => r.label)).toEqual(Array.from({ length: 16 }, (_, i) => "s" + i));
  });
});
