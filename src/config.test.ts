import { describe, expect, test } from "bun:test";
import { DEFAULT_CONFIG, resolveConfig } from "./config";

describe("resolveConfig", () => {
  test("returns all defaults for empty env and no options", () => {
    const { config, warnings } = resolveConfig({});

    expect(config.intervalMs).toBe(60000);
    expect(config.endpoint).toBe("https://api.z.ai/api/monitor/usage/quota/limit");
    expect(config.timeoutMs).toBe(8000);
    expect(config.gaugeWidth).toBe(12);
    expect(config.warnThreshold).toBe(0.7);
    expect(config.critThreshold).toBe(0.9);
    expect(config.panel).toBe(true);
    expect(config.chip).toBe(true);
    expect(config.showRunway).toBe(true);
    expect(config.maxHistory).toBe(120);
    expect(config.tokenEnv).toEqual(["ZAI_TOKEN", "Z_AI_TOKEN"]);
    expect(config.authKeys).toEqual(["zai-coding-plan", "zai"]);
    expect(warnings).toEqual([]);
    expect(config).toEqual(DEFAULT_CONFIG);
  });

  test("precedence: env beats default, option beats env (intervalMs probed through all three layers)", () => {
    const envOnly = resolveConfig({ ZAI_QUOTA_INTERVAL_MS: "30000" });
    expect(envOnly.config.intervalMs).toBe(30000);

    const envAndOption = resolveConfig({ ZAI_QUOTA_INTERVAL_MS: "30000" }, { intervalMs: 45000 });
    expect(envAndOption.config.intervalMs).toBe(45000);
  });

  test("non-numeric env value for intervalMs keeps default with warning", () => {
    const abc = resolveConfig({ ZAI_QUOTA_INTERVAL_MS: "abc" });
    expect(abc.config.intervalMs).toBe(60000);
    expect(abc.warnings.some((w) => w.includes("intervalMs"))).toBe(true);

    const empty = resolveConfig({ ZAI_QUOTA_INTERVAL_MS: "" });
    expect(empty.config.intervalMs).toBe(60000);
    expect(empty.warnings.some((w) => w.includes("intervalMs"))).toBe(true);
  });

  test("intervalMs clamping: floor 10000, no clamp warnings inside range", () => {
    const zero = resolveConfig({ ZAI_QUOTA_INTERVAL_MS: "0" });
    expect(zero.config.intervalMs).toBe(10000);
    expect(zero.warnings.some((w) => w.includes("clamped") && w.includes("intervalMs"))).toBe(true);

    expect(resolveConfig({ ZAI_QUOTA_INTERVAL_MS: "9999" }).config.intervalMs).toBe(10000);

    const exact = resolveConfig({ ZAI_QUOTA_INTERVAL_MS: "60000" });
    expect(exact.config.intervalMs).toBe(60000);
    expect(exact.warnings).toEqual([]);

    expect(resolveConfig({ ZAI_QUOTA_INTERVAL_MS: "10000000" }).config.intervalMs).toBe(10000000);
  });

  test("timeoutMs clamping: min 1000, max 60000", () => {
    expect(resolveConfig({ ZAI_QUOTA_TIMEOUT_MS: "0" }).config.timeoutMs).toBe(1000);
    expect(resolveConfig({ ZAI_QUOTA_TIMEOUT_MS: "999999" }).config.timeoutMs).toBe(60000);
  });

  test("gaugeWidth clamping: floor to [4, 40]", () => {
    expect(resolveConfig({ ZAI_QUOTA_GAUGE_WIDTH: "0" }).config.gaugeWidth).toBe(4);
    expect(resolveConfig({ ZAI_QUOTA_GAUGE_WIDTH: "3.9" }).config.gaugeWidth).toBe(4);
    expect(resolveConfig({ ZAI_QUOTA_GAUGE_WIDTH: "40.9" }).config.gaugeWidth).toBe(40);
    expect(resolveConfig({ ZAI_QUOTA_GAUGE_WIDTH: "12.6" }).config.gaugeWidth).toBe(12);
  });

  test("invalid threshold combinations revert both to defaults", () => {
    const crossed = resolveConfig({ ZAI_QUOTA_WARN: "0.9", ZAI_QUOTA_CRIT: "0.8" });
    expect(crossed.config.warnThreshold).toBe(0.7);
    expect(crossed.config.critThreshold).toBe(0.9);
    expect(crossed.warnings).toContain("invalid thresholds, using defaults");

    const zeroWarn = resolveConfig({ ZAI_QUOTA_WARN: "0" });
    expect(zeroWarn.config.warnThreshold).toBe(0.7);
    expect(zeroWarn.config.critThreshold).toBe(0.9);
    expect(zeroWarn.warnings).toContain("invalid thresholds, using defaults");

    const bigCrit = resolveConfig({ ZAI_QUOTA_CRIT: "1.5" });
    expect(bigCrit.config.warnThreshold).toBe(0.7);
    expect(bigCrit.config.critThreshold).toBe(0.9);
    expect(bigCrit.warnings).toContain("invalid thresholds, using defaults");
  });

  test("valid thresholds via options are applied as-is", () => {
    const { config, warnings } = resolveConfig({}, { warnThreshold: 0.5, critThreshold: 0.8 });
    expect(config.warnThreshold).toBe(0.5);
    expect(config.critThreshold).toBe(0.8);
    expect(warnings).toEqual([]);
  });

  test("boolean env parsing: 1/true/yes vs 0/false/no, case-insensitive", () => {
    const all = resolveConfig({
      ZAI_QUOTA_PANEL: "TRUE",
      ZAI_QUOTA_CHIP: "0",
      ZAI_QUOTA_RUNWAY: "no",
    });
    expect(all.config.panel).toBe(true);
    expect(all.config.chip).toBe(false);
    expect(all.config.showRunway).toBe(false);

    const banana = resolveConfig({ ZAI_QUOTA_PANEL: "banana" });
    expect(banana.config.panel).toBe(true);
    expect(banana.warnings.some((w) => w.includes("panel"))).toBe(true);
  });

  test("non-string boolean env value does not throw, keeps default, warns", () => {
    const env = resolveConfig({ ZAI_QUOTA_PANEL: 1 } as unknown as Record<string, string | undefined>);
    expect(env.config.panel).toBe(true);
    expect(env.warnings.some((w) => w.includes("panel"))).toBe(true);
  });

  test("boolean options accept only literal true/false", () => {
    expect(resolveConfig({}, { panel: true }).config.panel).toBe(true);
    expect(resolveConfig({}, { panel: false }).config.panel).toBe(false);
    expect(resolveConfig({ ZAI_QUOTA_PANEL: "0" }, { panel: true }).config.panel).toBe(true);

    const yesString = resolveConfig({}, { panel: "yes" });
    expect(yesString.config.panel).toBe(true);
    expect(yesString.warnings.some((w) => w.includes("panel"))).toBe(true);
  });

  test("endpoint: whitespace-only env keeps default with warning, valid URL passes through", () => {
    const blank = resolveConfig({ ZAI_QUOTA_ENDPOINT: "  " });
    expect(blank.config.endpoint).toBe("https://api.z.ai/api/monitor/usage/quota/limit");
    expect(blank.warnings.some((w) => w.includes("endpoint"))).toBe(true);

    const valid = resolveConfig({ ZAI_QUOTA_ENDPOINT: "https://example.test/quota" });
    expect(valid.config.endpoint).toBe("https://example.test/quota");
    expect(valid.warnings).toEqual([]);
  });

  test("endpoint scheme: non-https accepted with warning, uppercase HTTPS silent, default silent", () => {
    const httpEnv = resolveConfig({ ZAI_QUOTA_ENDPOINT: "http://proxy.local/api" });
    expect(httpEnv.config.endpoint).toBe("http://proxy.local/api");
    expect(httpEnv.warnings).toContain(
      "endpoint is not https, token will be sent over an insecure connection",
    );

    const httpOption = resolveConfig({}, { endpoint: "http://proxy.local/api" });
    expect(httpOption.config.endpoint).toBe("http://proxy.local/api");
    expect(httpOption.warnings).toContain(
      "endpoint is not https, token will be sent over an insecure connection",
    );

    const upper = resolveConfig({ ZAI_QUOTA_ENDPOINT: "HTTPS://api.z.ai/x" });
    expect(upper.config.endpoint).toBe("HTTPS://api.z.ai/x");
    expect(upper.warnings).toEqual([]);

    const def = resolveConfig({});
    expect(def.config.endpoint).toBe(DEFAULT_CONFIG.endpoint);
    expect(def.warnings).toEqual([]);
  });

  test("tokenEnv/authKeys via options: filter empty entries, fall back on empty or non-array", () => {
    expect(resolveConfig({}, { tokenEnv: ["A", ""] }).config.tokenEnv).toEqual(["A"]);

    const emptyList = resolveConfig({}, { tokenEnv: [] });
    expect(emptyList.config.tokenEnv).toEqual(["ZAI_TOKEN", "Z_AI_TOKEN"]);
    expect(emptyList.warnings.some((w) => w.includes("tokenEnv"))).toBe(true);

    const notArray = resolveConfig({}, { tokenEnv: "not-array" });
    expect(notArray.config.tokenEnv).toEqual(["ZAI_TOKEN", "Z_AI_TOKEN"]);
    expect(notArray.warnings.some((w) => w.includes("tokenEnv"))).toBe(true);

    expect(resolveConfig({}, { authKeys: ["k2"] }).config.authKeys).toEqual(["k2"]);
  });

  test("non-string non-number option values are rejected instead of coerced", () => {
    const arr = resolveConfig({}, { gaugeWidth: ["12"] });
    expect(arr.config.gaugeWidth).toBe(12);
    expect(arr.warnings).toContain("invalid gaugeWidth, using 12");

    const bool = resolveConfig({}, { intervalMs: true });
    expect(bool.config.intervalMs).toBe(60000);
    expect(bool.warnings).toContain("invalid intervalMs, using 60000");
  });

  test("garbage options object never throws and yields defaults plus warnings", () => {
    const garbage = resolveConfig({}, { intervalMs: { weird: true } });
    expect(garbage.config.intervalMs).toBe(60000);
    expect(garbage.config).toEqual(DEFAULT_CONFIG);
    expect(garbage.warnings.some((w) => w.includes("intervalMs"))).toBe(true);

    const nullOptions = resolveConfig({}, null as unknown as Partial<Record<keyof typeof DEFAULT_CONFIG, unknown>>);
    expect(nullOptions.config).toEqual(DEFAULT_CONFIG);
    expect(nullOptions.warnings).toEqual([]);
  });

  test("identical warning messages are deduplicated", () => {
    const { warnings } = resolveConfig({ ZAI_QUOTA_INTERVAL_MS: "abc" }, { intervalMs: "abc" });
    expect(warnings.filter((w) => w.includes("intervalMs"))).toHaveLength(1);
    expect(warnings).toEqual(["invalid intervalMs, using 60000"]);
  });

  test("MAX_SAFE_INTEGER intervalMs clamps to 2147483647 with a clamp warning", () => {
    const viaEnv = resolveConfig({ ZAI_QUOTA_INTERVAL_MS: "9007199254740991" });
    expect(viaEnv.config.intervalMs).toBe(2147483647);
    expect(viaEnv.warnings).toContain("clamped intervalMs to 2147483647");

    const viaOption = resolveConfig({}, { intervalMs: Number.MAX_SAFE_INTEGER });
    expect(viaOption.config.intervalMs).toBe(2147483647);
    expect(viaOption.warnings).toContain("clamped intervalMs to 2147483647");
  });

  test("in-range intervalMs values pass through without clamp warnings", () => {
    for (const value of [60000, 500000, 2147483647]) {
      const { config, warnings } = resolveConfig({}, { intervalMs: value });
      expect(config.intervalMs).toBe(value);
      expect(warnings).toEqual([]);
    }
  });

  test("non-finite env numbers (Infinity, NaN, 10k-digit string) fall back to defaults with warnings", () => {
    const inf = resolveConfig({ ZAI_QUOTA_INTERVAL_MS: "Infinity" });
    expect(inf.config.intervalMs).toBe(60000);
    expect(inf.warnings.some((w) => w.includes("intervalMs"))).toBe(true);

    const negInf = resolveConfig({ ZAI_QUOTA_INTERVAL_MS: "-Infinity" });
    expect(negInf.config.intervalMs).toBe(60000);

    const nanTimeout = resolveConfig({ ZAI_QUOTA_TIMEOUT_MS: "NaN" });
    expect(nanTimeout.config.timeoutMs).toBe(8000);
    expect(nanTimeout.warnings.some((w) => w.includes("timeoutMs"))).toBe(true);

    // 10000 digits overflows double precision to Infinity -> rejected, not crash.
    const huge = resolveConfig({ ZAI_QUOTA_INTERVAL_MS: "9".repeat(10000) });
    expect(huge.config.intervalMs).toBe(60000);
    expect(huge.warnings.some((w) => w.includes("intervalMs"))).toBe(true);
  });

  test("warn threshold exactly equal to crit threshold reverts both to defaults", () => {
    const env = resolveConfig({ ZAI_QUOTA_WARN: "0.9", ZAI_QUOTA_CRIT: "0.9" });
    expect(env.config.warnThreshold).toBe(0.7);
    expect(env.config.critThreshold).toBe(0.9);
    expect(env.warnings).toContain("invalid thresholds, using defaults");

    const opt = resolveConfig({}, { warnThreshold: 0.6, critThreshold: 0.6 });
    expect(opt.config.warnThreshold).toBe(0.7);
    expect(opt.config.critThreshold).toBe(0.9);
    expect(opt.warnings).toContain("invalid thresholds, using defaults");
  });

  test("gaugeWidth NaN warns and keeps default without a clamp warning", () => {
    const viaOption = resolveConfig({}, { gaugeWidth: NaN });
    expect(viaOption.config.gaugeWidth).toBe(12);
    expect(viaOption.warnings).toEqual(["invalid gaugeWidth, using 12"]);

    const viaEnv = resolveConfig({ ZAI_QUOTA_GAUGE_WIDTH: "not-a-number" });
    expect(viaEnv.config.gaugeWidth).toBe(12);
    expect(viaEnv.warnings.some((w) => w.includes("gaugeWidth"))).toBe(true);
  });

  test("maxHistory clamping: floor 2, cap 1000, fractional floored, in-range silent", () => {
    expect(resolveConfig({ ZAI_QUOTA_MAX_HISTORY: "0" }).config.maxHistory).toBe(2);
    expect(resolveConfig({ ZAI_QUOTA_MAX_HISTORY: "-5" }).config.maxHistory).toBe(2);
    expect(resolveConfig({ ZAI_QUOTA_MAX_HISTORY: "2000" }).config.maxHistory).toBe(1000);
    expect(resolveConfig({ ZAI_QUOTA_MAX_HISTORY: "3.9" }).config.maxHistory).toBe(3);

    const exact = resolveConfig({ ZAI_QUOTA_MAX_HISTORY: "120" });
    expect(exact.config.maxHistory).toBe(120);
    expect(exact.warnings).toEqual([]);
  });

  test("endpoint boundary: 10k-char and unicode values pass through unmodified", () => {
    const long = resolveConfig({ ZAI_QUOTA_ENDPOINT: `https://x.test/${"a".repeat(10000)}` });
    expect(long.config.endpoint).toBe(`https://x.test/${"a".repeat(10000)}`);
    expect(long.warnings).toEqual([]);

    // Deliberate unicode fixture (CJK + IDN host): endpoint strings must pass
    // through byte-identical, no normalization or rejection.
    const unicode = resolveConfig({ ZAI_QUOTA_ENDPOINT: "https://例え.jp/配额" });
    expect(unicode.config.endpoint).toBe("https://例え.jp/配额");
    expect(unicode.warnings).toEqual([]);
  });
});
