import { describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { fmtApproxDuration, fmtBackAt, fmtCount, fmtDuration } from "./format"
import { ROLE_THEME_KEY, type Role } from "./roles"

describe("fmtDuration", () => {
  test("ms <= 0 -> \"0m\"", () => {
    expect(fmtDuration(0)).toBe("0m")
    expect(fmtDuration(-1)).toBe("0m")
    expect(fmtDuration(-86_400_000)).toBe("0m")
  })

  test("below one minute -> seconds", () => {
    expect(fmtDuration(1)).toBe("0s")
    expect(fmtDuration(999)).toBe("0s")
    expect(fmtDuration(45_000)).toBe("45s")
    expect(fmtDuration(59_999)).toBe("59s")
  })

  test("below one hour -> minutes", () => {
    expect(fmtDuration(60_000)).toBe("1m")
    expect(fmtDuration(3_599_000)).toBe("59m")
    expect(fmtDuration(3_599_999)).toBe("59m")
  })

  test("below 48h -> hours plus optional minutes", () => {
    expect(fmtDuration(3_600_000)).toBe("1h")
    expect(fmtDuration(3_660_000)).toBe("1h 1m")
    expect(fmtDuration(4_320_000)).toBe("1h 12m")
    expect(fmtDuration(7_194_000)).toBe("1h 59m")
    expect(fmtDuration(86_399_999)).toBe("23h 59m")
    expect(fmtDuration(86_400_000)).toBe("24h")
    expect(fmtDuration(172_799_999)).toBe("47h 59m")
  })

  test("48h and beyond -> days plus optional hours", () => {
    expect(fmtDuration(172_800_000)).toBe("2d")
    expect(fmtDuration(176_400_000)).toBe("2d 1h")
    expect(fmtDuration(259_200_000)).toBe("3d")
  })

  test("MAX_SAFE_INTEGER -> finite digits, days-terminated, never Infinity", () => {
    const s = fmtDuration(Number.MAX_SAFE_INTEGER)
    expect(s).toMatch(/^\d+d( \d+h)?$/)
    expect(s).not.toContain("Infinity")
  })
})

describe("fmtApproxDuration", () => {
  test("non-finite or <= 0 -> \"~0m\"", () => {
    expect(fmtApproxDuration(0)).toBe("~0m")
    expect(fmtApproxDuration(-1)).toBe("~0m")
    expect(fmtApproxDuration(Number.POSITIVE_INFINITY)).toBe("~0m")
    expect(fmtApproxDuration(Number.NaN)).toBe("~0m")
  })

  test("below 48h -> tilde + exact fmtDuration", () => {
    expect(fmtApproxDuration(7_500_000)).toBe("~2h 5m")
    expect(fmtApproxDuration(172_799_999)).toBe("~47h 59m")
  })

  test("48h and beyond -> tilde + whole days, no minutes tail", () => {
    expect(fmtApproxDuration(172_800_000)).toBe("~2d")
    expect(fmtApproxDuration(874_800_000)).toBe("~10d") // 243h -> 10.125d
    expect(fmtApproxDuration(915_840_000)).toBe("~11d") // 254.4h -> 10.6d
    expect(fmtApproxDuration(414_720_000)).toBe("~5d") // 115.2h -> 4.8d
  })

  test("day rounding is half-up", () => {
    expect(fmtApproxDuration(216_000_000)).toBe("~3d") // 60h -> 2.5d -> 3d
  })
})

describe("fmtBackAt", () => {
  const at = (ms: number) => "AT" + ms

  test("resetIn <= 0 -> back at now", () => {
    expect(fmtBackAt(0, 1_000_000, at)).toBe("back at AT1000000")
    expect(fmtBackAt(-1, 1_000_000, at)).toBe("back at AT1000000")
  })

  test("resetIn < 24h -> back at now + resetIn", () => {
    expect(fmtBackAt(2_520_000, 1_000_000, at)).toBe("back at AT3520000") // 42m
  })

  test("resetIn >= 24h -> back in fmtDuration form", () => {
    expect(fmtBackAt(86_400_000, 1_000_000, at)).toBe("back in 24h")
    expect(fmtBackAt(259_200_000, 1_000_000, at)).toBe("back in 3d")
    expect(fmtBackAt(273_600_000, 1_000_000, at)).toBe("back in 3d 4h") // 76h
  })
})

describe("fmtCount", () => {
  test("small values pass through", () => {
    expect(fmtCount(0)).toBe("0")
    expect(fmtCount(5)).toBe("5")
    expect(fmtCount(999)).toBe("999")
  })

  test("thousands tier", () => {
    expect(fmtCount(1_000)).toBe("1k")
    expect(fmtCount(1_500)).toBe("1.5k")
    expect(fmtCount(999_999)).toBe("1000k")
  })

  test("millions tier", () => {
    expect(fmtCount(1e6)).toBe("1M")
    expect(fmtCount(1.5e6)).toBe("1.5M")
  })

  test("billions tier", () => {
    expect(fmtCount(1e9)).toBe("1B")
    expect(fmtCount(1.75e9)).toBe("1.8B")
  })

  test("negative values keep sign", () => {
    expect(fmtCount(-1_500)).toBe("-1.5k")
    expect(fmtCount(-2_000)).toBe("-2k")
  })

  test("MAX_SAFE_INTEGER -> no e+ notation, no Infinity", () => {
    const s = fmtCount(Number.MAX_SAFE_INTEGER)
    expect(s).toContain("B")
    expect(s).not.toContain("e+")
    expect(s).not.toContain("Infinity")
  })
})

describe("roles", () => {
  test("ROLE_THEME_KEY is the exact six-entry mapping", () => {
    expect(ROLE_THEME_KEY).toEqual({
      crit: "error",
      warn: "warning",
      ok: "success",
      muted: "textMuted",
      accent: "primary",
      info: "info",
    })
  })

  test("every theme key is letters only (no hex/ANSI escapes)", () => {
    // "textMuted" is camelCase, so the guard is ASCII letters only.
    // It still rejects hex colors ("#ff0000") and ANSI escapes ("\x1b[31m").
    const roles = Object.keys(ROLE_THEME_KEY) as Role[]
    expect(roles).toHaveLength(6)
    for (const role of roles) {
      expect(ROLE_THEME_KEY[role]).toMatch(/^[a-zA-Z]+$/)
    }
  })
})

describe("fmtCount boundary regressions", () => {
  test("999.5 stays below the k tier and passes through unrounded", () => {
    expect(fmtCount(999.5)).toBe("999.5")
  })

  test("1000.4 rounds down to 1k at tier entry via toFixed(1)", () => {
    expect(fmtCount(1000.4)).toBe("1k")
  })

  test("negative zero formats as \"0\" without a minus sign", () => {
    expect(fmtCount(-0)).toBe("0")
  })
})

describe("non-finite guards (F2)", () => {
  test("fmtDuration(Infinity) -> \"0m\"", () => {
    expect(fmtDuration(Number.POSITIVE_INFINITY)).toBe("0m")
  })

  test("fmtDuration(NaN) -> \"0m\"", () => {
    expect(fmtDuration(Number.NaN)).toBe("0m")
  })

  test("fmtCount(Infinity) -> \"?\"", () => {
    expect(fmtCount(Number.POSITIVE_INFINITY)).toBe("?")
  })

  test("fmtCount(NaN) -> \"?\"", () => {
    expect(fmtCount(Number.NaN)).toBe("?")
  })
})

describe("W1 audit: tier boundaries", () => {
  const at = (ms: number) => "AT" + ms

  test("fmtDuration: 176_399_999 is the last hours-free \"2d\" (hours tail floors to 0)", () => {
    // 172_800_000 + 3_599_999: one ms below "2d 1h", the tail still floors away.
    expect(fmtDuration(176_399_999)).toBe("2d")
    expect(fmtDuration(176_400_000)).toBe("2d 1h")
  })

  test("fmtDuration: 86_400_000 exactly stays on the hours tier (24h < 48h tier end)", () => {
    expect(fmtDuration(86_400_000)).toBe("24h")
    expect(fmtDuration(86_399_999)).toBe("23h 59m")
  })

  test("fmtApproxDuration: N.5-day rounding is exactly half-up at 10.5d", () => {
    // 252h = 10.5d exactly; Math.round is half-up -> 11, never banker's 10.
    expect(fmtApproxDuration(907_200_000)).toBe("~11d")
    // A hair below 10.5d must stay 10.
    expect(fmtApproxDuration(907_199_999)).toBe("~10d")
  })

  test("fmtBackAt: 86_399_999 is still an absolute time, 86_400_000 flips to \"back in\"", () => {
    expect(fmtBackAt(86_399_999, 1_000_000, at)).toBe("back at AT87399999")
    expect(fmtBackAt(86_400_000, 1_000_000, at)).toBe("back in 24h")
  })
})

describe("module purity (format)", () => {
  test("format.ts has no clock, console, global, fs, require or timer tokens", () => {
    const source = readFileSync(new URL("./format.ts", import.meta.url), "utf8")
    const forbidden = /Date\.now|new Date|console\.|globalThis|setTimeout|setInterval|setImmediate|\bfs\.|require\(/
    expect(source.match(forbidden)?.join(",") ?? null).toBeNull()
  })
})
