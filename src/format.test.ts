import { describe, expect, test } from "bun:test"
import { fmtCount, fmtDuration } from "./format"
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
    expect(fmtDuration(59_999)).toBe("59s")
  })

  test("below one hour -> minutes", () => {
    expect(fmtDuration(60_000)).toBe("1m")
    expect(fmtDuration(3_599_999)).toBe("59m")
  })

  test("below one day -> hours plus optional minutes", () => {
    expect(fmtDuration(3_600_000)).toBe("1h")
    expect(fmtDuration(3_660_000)).toBe("1h 1m")
    expect(fmtDuration(7_194_000)).toBe("1h 59m")
    expect(fmtDuration(86_399_999)).toBe("23h 59m")
  })

  test("one day and beyond -> total hours only", () => {
    expect(fmtDuration(86_400_000)).toBe("24h")
    expect(fmtDuration(172_800_000)).toBe("48h")
  })

  test("MAX_SAFE_INTEGER -> finite digits-only + h", () => {
    const s = fmtDuration(Number.MAX_SAFE_INTEGER)
    expect(s).toMatch(/^\d+h$/)
    expect(s).not.toContain("Infinity")
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
