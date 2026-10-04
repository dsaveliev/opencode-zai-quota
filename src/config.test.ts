import { describe, expect, test } from "bun:test";
import { DEFAULT_CONFIG, resolveConfig } from "./config";

describe("resolveConfig", () => {
  test("returns all defaults for empty env and no options", () => {
    const { config, warnings } = resolveConfig({});

    expect(config.intervalMs).toBe(60000);
    expect(config.endpoint).toBe("https://api.z.ai/api/monitor/usage/quota/limit");
    expect(config.timeoutMs).toBe(8000);
    expect(config.gaugeWidth).toBe(16);
    expect(config.panel).toBe(true);
    expect(config.chip).toBe(true);
    expect(config.maxHistory).toBe(120);
    expect(config.tightFactor).toBe(1.5);
    expect(config.glyphs).toBe("unicode");
    expect(config.detail).toBe("always");
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

  test("retired threshold/runway keys are absent from the config surface", () => {
    // warnThreshold/critThreshold/showRunway were retired with the V2 verdict
    // ladder; guard against re-introduction through any layer.
    const { config } = resolveConfig({
      ZAI_QUOTA_WARN: "0.5",
      ZAI_QUOTA_CRIT: "0.8",
      ZAI_QUOTA_RUNWAY: "no",
    });
    expect("warnThreshold" in config).toBe(false);
    expect("critThreshold" in config).toBe(false);
    expect("showRunway" in config).toBe(false);
  });

  test("boolean env parsing: 1/true/yes vs 0/false/no, case-insensitive", () => {
    const all = resolveConfig({
      ZAI_QUOTA_PANEL: "TRUE",
      ZAI_QUOTA_CHIP: "0",
    });
    expect(all.config.panel).toBe(true);
    expect(all.config.chip).toBe(false);

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
    expect(arr.config.gaugeWidth).toBe(16);
    expect(arr.warnings).toContain("invalid gaugeWidth, using 16");

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

  test("gaugeWidth NaN warns and keeps default without a clamp warning", () => {
    const viaOption = resolveConfig({}, { gaugeWidth: NaN });
    expect(viaOption.config.gaugeWidth).toBe(16);
    expect(viaOption.warnings).toEqual(["invalid gaugeWidth, using 16"]);

    const viaEnv = resolveConfig({ ZAI_QUOTA_GAUGE_WIDTH: "not-a-number" });
    expect(viaEnv.config.gaugeWidth).toBe(16);
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

  test("tightFactor: env parsed, boundary 1 accepted, invalid values revert to 1.5 with warning", () => {
    expect(resolveConfig({ ZAI_QUOTA_TIGHT_FACTOR: "2" }).config.tightFactor).toBe(2);
    expect(resolveConfig({ ZAI_QUOTA_TIGHT_FACTOR: "1" }).config.tightFactor).toBe(1);
    expect(resolveConfig({ ZAI_QUOTA_TIGHT_FACTOR: "1.25" }).config.tightFactor).toBe(1.25);

    for (const raw of ["0.5", "0", "NaN", "Infinity", "-Infinity", "abc", ""]) {
      const r = resolveConfig({ ZAI_QUOTA_TIGHT_FACTOR: raw });
      expect(r.config.tightFactor).toBe(1.5);
      expect(r.warnings.some((w) => w.includes("tightFactor"))).toBe(true);
    }
  });

  test("tightFactor: option beats env, invalid option reverts to default with warning", () => {
    const both = resolveConfig({ ZAI_QUOTA_TIGHT_FACTOR: "2" }, { tightFactor: 3 });
    expect(both.config.tightFactor).toBe(3);
    expect(both.warnings).toEqual([]);

    const underOne = resolveConfig({}, { tightFactor: 0.5 });
    expect(underOne.config.tightFactor).toBe(1.5);
    expect(underOne.warnings).toContain("invalid tightFactor, using 1.5");

    const notFinite = resolveConfig({}, { tightFactor: Infinity });
    expect(notFinite.config.tightFactor).toBe(1.5);
    expect(notFinite.warnings.some((w) => w.includes("tightFactor"))).toBe(true);
  });

  test("glyphs: env accepts exact unicode/ascii case-insensitively, invalid reverts with warning", () => {
    expect(resolveConfig({ ZAI_QUOTA_GLYPHS: "ascii" }).config.glyphs).toBe("ascii");
    expect(resolveConfig({ ZAI_QUOTA_GLYPHS: "ASCII" }).config.glyphs).toBe("ascii");
    expect(resolveConfig({ ZAI_QUOTA_GLYPHS: "Ascii" }).config.glyphs).toBe("ascii");
    expect(resolveConfig({ ZAI_QUOTA_GLYPHS: "unicode" }).config.glyphs).toBe("unicode");
    expect(resolveConfig({ ZAI_QUOTA_GLYPHS: "UNICODE" }).config.glyphs).toBe("unicode");

    for (const raw of ["utf8", "uni", "", "1", "unicode9"]) {
      const r = resolveConfig({ ZAI_QUOTA_GLYPHS: raw });
      expect(r.config.glyphs).toBe("unicode");
      expect(r.warnings.some((w) => w.includes("glyphs"))).toBe(true);
    }
  });

  test("glyphs: option beats env, non-string option reverts with warning", () => {
    const both = resolveConfig({ ZAI_QUOTA_GLYPHS: "ascii" }, { glyphs: "unicode" });
    expect(both.config.glyphs).toBe("unicode");
    expect(both.warnings).toEqual([]);

    const invalid = resolveConfig({}, { glyphs: true });
    expect(invalid.config.glyphs).toBe("unicode");
    expect(invalid.warnings.some((w) => w.includes("glyphs"))).toBe(true);
  });

  test("detail: env accepts exact always/auto case-insensitively, invalid reverts with warning", () => {
    expect(resolveConfig({ ZAI_QUOTA_DETAIL: "auto" }).config.detail).toBe("auto");
    expect(resolveConfig({ ZAI_QUOTA_DETAIL: "AUTO" }).config.detail).toBe("auto");
    expect(resolveConfig({ ZAI_QUOTA_DETAIL: "always" }).config.detail).toBe("always");
    expect(resolveConfig({ ZAI_QUOTA_DETAIL: "Always" }).config.detail).toBe("always");

    for (const raw of ["sometimes", "", "yes", "automatic"]) {
      const r = resolveConfig({ ZAI_QUOTA_DETAIL: raw });
      expect(r.config.detail).toBe("always");
      expect(r.warnings.some((w) => w.includes("detail"))).toBe(true);
    }
  });

  test("detail: option beats env, invalid option reverts with warning", () => {
    const both = resolveConfig({ ZAI_QUOTA_DETAIL: "auto" }, { detail: "always" });
    expect(both.config.detail).toBe("always");
    expect(both.warnings).toEqual([]);

    const invalid = resolveConfig({}, { detail: "maybe" });
    expect(invalid.config.detail).toBe("always");
    expect(invalid.warnings.some((w) => w.includes("detail"))).toBe(true);
  });
});
