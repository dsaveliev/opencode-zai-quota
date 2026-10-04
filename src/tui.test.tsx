/**
 * Wiring smoke tests for the TUI plugin (src/tui.tsx).
 *
 * Runs against a fake api object; global fetch is stubbed. JSX in the wiring
 * needs a renderer context, so slot functions are rendered headless through
 * `testRender` from @opentui/solid (direct invocation throws "No renderer
 * found" by design of the reconciler).
 *
 * Machine-independence: token resolution is isolated via config options
 * (`authKeys`/`tokenEnv` pointed at names that never exist), so the host's
 * real ~/.local/share/opencode/auth.json cannot influence results.
 */
import { describe, test, expect, beforeEach, afterEach } from "bun:test"
import { readFileSync } from "node:fs"
import { testRender } from "@opentui/solid"
import { createTuiPlugin } from "./tui"
import { resolveConfig } from "./config"

/** Distinct valid hex per theme key: proves colors resolve through ROLE_THEME_KEY. */
const THEME_HEX: Record<string, string> = {
  error: "#ff0001",
  warning: "#ff8002",
  success: "#00ff03",
  textMuted: "#808004",
  primary: "#0000f5",
  info: "#00f0f6",
  border: "#a0a0a7",
}

function fakeApi() {
  const slots: any[] = []
  const layers: any[] = []
  const handlers = new Map<string, any>()
  const toasts: any[] = []
  const disposed: string[] = []
  const api = {
    theme: {
      current: new Proxy(
        {},
        {
          get: (_t: any, k: string | symbol) =>
            THEME_HEX[String(k)] ?? `color-for-${String(k)}`,
        },
      ),
    },
    slots: {
      register: (p: any) => {
        slots.push(p)
        return () => {
          disposed.push("slots")
        }
      },
    },
    keymap: {
      registerLayer: (l: any) => {
        layers.push(l)
        return () => {
          disposed.push("layer")
        }
      },
    },
    event: {
      on: (t: any, h: any) => {
        handlers.set(t, h)
        return () => {
          handlers.delete(t)
        }
      },
    },
    ui: { toast: (t: any) => { toasts.push(t) } },
    lifecycle: {
      onDispose: (fn: any) => {
        handlers.set("__dispose", fn)
        return () => {}
      },
    },
  }
  return { api, slots, layers, handlers, toasts, disposed }
}

function quotaPayload(): unknown {
  const now = Date.now()
  return {
    data: {
      level: "Max Plan",
      limits: [
        // unit 3 -> "5h" row at 80% (warn role), unit 6 -> "wk" row at 30% (ok role)
        { unit: 3, currentValue: 400, remaining: 100, nextResetTime: now + 3_600_000 },
        { unit: 6, currentValue: 600, remaining: 1400, nextResetTime: now + 86_400_000 },
      ],
    },
  }
}

const OPT = { authKeys: ["__test_absent__"] }
const NO_TOKEN_OPT = { authKeys: ["__test_absent__"], tokenEnv: ["__test_absent_env__"] }
const tick = (ms = 10) => new Promise<void>((r) => setTimeout(r, ms))

type StubResponse = { status: number; text: () => Promise<string> }

const stubOk = (): StubResponse => ({ status: 200, text: async () => JSON.stringify(quotaPayload()) })

let fetchCalls = 0
let respond: () => Promise<StubResponse> = () => Promise.resolve(stubOk())
let savedEnv: Record<string, string | undefined> = {}
let savedFetch: typeof fetch
const pendingDispose: Array<() => void> = []

async function renderSlot(fn: () => unknown) {
  const setup = await testRender(fn as any)
  await setup.flush()
  return setup
}

function fgHex(span: any): string {
  const b = span.fg.buffer
  const h = (n: number) => n.toString(16).padStart(2, "0")
  return `#${h(b[0])}${h(b[1])}${h(b[2])}`
}

beforeEach(() => {
  savedEnv = {}
  for (const key of ["ZAI_TOKEN", "Z_AI_TOKEN", "ZAI_QUOTA_INTERVAL_MS"]) {
    savedEnv[key] = process.env[key]
  }
  process.env.ZAI_TOKEN = "test-token"
  delete process.env.Z_AI_TOKEN
  process.env.ZAI_QUOTA_INTERVAL_MS = "10000" // min clamp; never fires during a test
  fetchCalls = 0
  respond = () => Promise.resolve(stubOk())
  savedFetch = globalThis.fetch
  globalThis.fetch = (async () => {
    fetchCalls++
    return respond()
  }) as any
})

afterEach(() => {
  while (pendingDispose.length > 0) {
    const dispose = pendingDispose.pop()
    try {
      dispose?.()
    } catch {
      // best-effort teardown
    }
  }
  for (const [key, value] of Object.entries(savedEnv)) {
    if (value === undefined) delete process.env[key]
    else process.env[key] = value
  }
  globalThis.fetch = savedFetch
})

describe("createTuiPlugin wiring", () => {
  test("loads with defaults and registers both slots", async () => {
    const f = fakeApi()
    await createTuiPlugin(f.api, OPT, {})
    pendingDispose.push(() => f.handlers.get("__dispose")?.())

    expect(f.slots.length).toBe(1)
    expect(f.slots[0].order).toBe(100)
    const keys = Object.keys(f.slots[0].slots)
    expect(keys).toContain("sidebar_content")
    expect(keys).toContain("session_prompt_right")
    expect(typeof f.slots[0].slots.sidebar_content).toBe("function")
    expect(typeof f.slots[0].slots.session_prompt_right).toBe("function")
  })

  test("panel: false and chip: false drop the respective slot keys", async () => {
    const noPanel = fakeApi()
    await createTuiPlugin(noPanel.api, { ...OPT, panel: false }, {})
    pendingDispose.push(() => noPanel.handlers.get("__dispose")?.())
    expect(Object.keys(noPanel.slots[0].slots)).not.toContain("sidebar_content")
    expect(Object.keys(noPanel.slots[0].slots)).toContain("session_prompt_right")

    const noChip = fakeApi()
    await createTuiPlugin(noChip.api, { ...OPT, chip: false }, {})
    pendingDispose.push(() => noChip.handlers.get("__dispose")?.())
    expect(Object.keys(noChip.slots[0].slots)).toContain("sidebar_content")
    expect(Object.keys(noChip.slots[0].slots)).not.toContain("session_prompt_right")
  })

  test("panel: false and chip: false skip slots.register entirely; polling and command stay live", async () => {
    const f = fakeApi()
    await createTuiPlugin(f.api, { ...OPT, panel: false, chip: false }, {})
    pendingDispose.push(() => f.handlers.get("__dispose")?.())
    await tick()

    expect(f.slots.length).toBe(0) // no register call -> no empty slots object
    expect(f.layers.length).toBe(1) // /zai-quota command still registered
    expect(fetchCalls).toBe(1) // initial refresh still fetched
  })

  test("initial refresh performs exactly one fetch and chip renders percentages", async () => {
    const f = fakeApi()
    await createTuiPlugin(f.api, OPT, {})
    pendingDispose.push(() => f.handlers.get("__dispose")?.())
    await tick()

    expect(fetchCalls).toBe(1)
    const chip = await renderSlot(f.slots[0].slots.session_prompt_right)
    const frame = chip.captureCharFrame()
    expect(frame).toContain(" zai 80\u00b730")
  })

  test("sidebar panel renders header, rows and gauges after fetch", async () => {
    const f = fakeApi()
    await createTuiPlugin(f.api, OPT, {})
    pendingDispose.push(() => f.handlers.get("__dispose")?.())
    await tick()

    const panel = await renderSlot(f.slots[0].slots.sidebar_content)
    const frame = panel.captureCharFrame()
    expect(frame).toContain("ZAI RUNWAY")
    expect(frame).toContain("Max Plan")
    expect(frame).toContain("5h")
    expect(frame).toContain("wk")
    expect(frame).toContain("\u2588") // filled gauge cell
    expect(frame).toContain("80%")
    expect(frame).toContain("reset")
  })

  test("concurrent event refreshes dedupe onto the in-flight request", async () => {
    const f = fakeApi()
    let release: ((r: StubResponse) => void) | null = null
    respond = () =>
      new Promise((res) => {
        release = res
      })
    await createTuiPlugin(f.api, OPT, {})
    pendingDispose.push(() => f.handlers.get("__dispose")?.())
    expect(fetchCalls).toBe(1) // initial request in flight, unresolved

    void f.handlers.get("session.error")()
    void f.handlers.get("session.idle")()
    await tick()
    expect(fetchCalls).toBe(1) // both events joined the in-flight refresh

    release!(stubOk())
    await tick()
    expect(fetchCalls).toBe(1)
  })

  test("session.idle within intervalMs/2 is throttled away", async () => {
    const f = fakeApi()
    await createTuiPlugin(f.api, OPT, {})
    pendingDispose.push(() => f.handlers.get("__dispose")?.())
    await tick()
    expect(fetchCalls).toBe(1)

    void f.handlers.get("session.idle")()
    await tick()
    expect(fetchCalls).toBe(1) // last fetch started ~10ms ago < 5000ms
  })

  test("session.error forces a refresh bypassing the throttle", async () => {
    const f = fakeApi()
    await createTuiPlugin(f.api, OPT, {})
    pendingDispose.push(() => f.handlers.get("__dispose")?.())
    await tick()
    expect(fetchCalls).toBe(1)

    void f.handlers.get("session.error")()
    await tick()
    expect(fetchCalls).toBe(2)
  })

  test("HTTP error surfaces in chip and panel", async () => {
    const f = fakeApi()
    respond = () => Promise.resolve({ status: 500, text: async () => "server says no" })
    await createTuiPlugin(f.api, OPT, {})
    pendingDispose.push(() => f.handlers.get("__dispose")?.())
    await tick()

    const chip = await renderSlot(f.slots[0].slots.session_prompt_right)
    expect(chip.captureCharFrame()).toContain("zai:?")

    const panel = await renderSlot(f.slots[0].slots.sidebar_content)
    expect(panel.captureCharFrame()).toContain("HTTP 500")
  })

  test("missing token yields no-token error without any fetch", async () => {
    const f = fakeApi()
    delete process.env.ZAI_TOKEN
    await createTuiPlugin(f.api, NO_TOKEN_OPT, {})
    pendingDispose.push(() => f.handlers.get("__dispose")?.())
    await tick()

    expect(fetchCalls).toBe(0)
    const chip = await renderSlot(f.slots[0].slots.session_prompt_right)
    expect(chip.captureCharFrame()).toContain("zai:?")
    const panel = await renderSlot(f.slots[0].slots.sidebar_content)
    expect(panel.captureCharFrame()).toContain("no token")
  })

  test("dispose clears the timer and calls slot/layer disposers", async () => {
    const f = fakeApi()
    const originalClearInterval = globalThis.clearInterval
    const cleared: unknown[] = []
    globalThis.clearInterval = ((id: unknown) => {
      cleared.push(id)
      return originalClearInterval(id as any)
    }) as any
    try {
      await createTuiPlugin(f.api, OPT, {})
      await tick()
      const before = fetchCalls

      expect(() => f.handlers.get("__dispose")!()).not.toThrow()
      await tick(20)
      expect(fetchCalls).toBe(before) // no background fetch after dispose
      expect(cleared.length).toBe(1)
      expect(f.disposed).toContain("slots")
      expect(f.disposed).toContain("layer")
    } finally {
      globalThis.clearInterval = originalClearInterval
    }
  })

  test("keymap command forces refresh and toasts the summary", async () => {
    const f = fakeApi()
    await createTuiPlugin(f.api, OPT, {})
    pendingDispose.push(() => f.handlers.get("__dispose")?.())
    await tick()

    expect(f.layers.length).toBe(1)
    expect(f.layers[0].bindings).toEqual([])
    const cmd = f.layers[0].commands[0]
    expect(cmd.name).toBe("zai-quota.refresh")
    expect(cmd.title).toBe("Z.AI quota: refresh now")
    expect(typeof cmd.desc).toBe("string")
    expect(cmd.slashName).toBe("zai-quota")
    expect(cmd.slashAliases).toEqual(["zq"])
    expect(cmd.namespace).toBe("palette")

    const before = fetchCalls
    await cmd.run()
    expect(fetchCalls).toBe(before + 1)
    expect(f.toasts.length).toBe(1)
    expect(f.toasts[0].variant).toBe("success")
    expect(f.toasts[0].title).toBe("Z.AI quota")
    expect(String(f.toasts[0].message)).toContain("5h:")
    expect(String(f.toasts[0].message)).toContain("wk:")
  })

  test("run() toast strips raw ANSI escapes from server-controlled row labels", async () => {
    const f = fakeApi()
    respond = () =>
      Promise.resolve({
        status: 200,
        text: async () =>
          JSON.stringify({
            data: {
              level: "Max Plan",
              limits: [
                // unknown unit -> label falls back to the server-controlled `type`
                {
                  type: "\u001b[31mevil\u001b[0m",
                  currentValue: 400,
                  remaining: 100,
                  nextResetTime: Date.now() + 3_600_000,
                },
              ],
            },
          }),
      })
    await createTuiPlugin(f.api, OPT, {})
    pendingDispose.push(() => f.handlers.get("__dispose")?.())
    await tick()

    await f.layers[0].commands[0].run()
    expect(f.toasts.length).toBe(1)
    const message = String(f.toasts[0].message)
    expect(message).toContain("evil")
    expect(message).not.toContain("\u001b") // raw escape stripped
  })

  test("chip colors resolve exclusively through ROLE_THEME_KEY theme lookups", async () => {
    const f = fakeApi()
    await createTuiPlugin(f.api, OPT, {})
    pendingDispose.push(() => f.handlers.get("__dispose")?.())
    await tick()

    const setup = await renderSlot(f.slots[0].slots.session_prompt_right)
    const spans = (setup.captureSpans() as any).lines.flatMap((line: any) => line.spans)
    const palette = new Set(Object.values(THEME_HEX))
    const byText = new Map<string, any>()
    for (const span of spans) {
      const text = String(span.text ?? "")
      if (text.trim() === "") continue
      const hex = fgHex(span)
      if (hex !== "#ffffff") {
        // every non-default color must come from the theme proxy palette
        expect(palette).toContain(hex)
      }
      byText.set(text, span)
    }
    expect(fgHex(byText.get(" zai "))).toBe(THEME_HEX.textMuted)
    expect(fgHex(byText.get("80"))).toBe(THEME_HEX.warning)
    expect(fgHex(byText.get("\u00b7"))).toBe(THEME_HEX.textMuted)
    expect(fgHex(byText.get("30"))).toBe(THEME_HEX.success)
  })

  test("config warnings produce a single warning toast", async () => {
    const f = fakeApi()
    await createTuiPlugin(f.api, { ...OPT, intervalMs: 5 }, {}) // clamped to 10000 -> warning
    pendingDispose.push(() => f.handlers.get("__dispose")?.())

    expect(f.toasts.length).toBe(1)
    expect(f.toasts[0].variant).toBe("warning")
    expect(f.toasts[0].title).toBe("Z.AI quota config")
    expect(String(f.toasts[0].message)).toContain("clamped intervalMs to 10000")
    expect(f.toasts[0].duration).toBe(4000)
  })
})

describe("wiring race and boundary audit", () => {
  /**
   * Queue-based respond: each fetch pops the next body; the last body repeats.
   * Deterministic multi-refresh scenarios without real sleeps.
   */
  function queueRespond(bodies: unknown[]): void {
    const queue = bodies.map((b) => JSON.stringify(b))
    respond = () => {
      const body = queue.length > 1 ? queue.shift()! : queue[0]
      return Promise.resolve({ status: 200, text: async () => body })
    }
  }

  /**
   * Deterministic clock: patches Date.now for the duration of `run` and
   * restores it in finally. The wiring reads time only via Date.now, so this
   * is the seam for window/boundary semantics (no real sleeps involved).
   */
  async function withFakeNow(
    start: number,
    run: (clock: { value: number }) => Promise<void>,
  ): Promise<void> {
    const realNow = Date.now
    const clock = { value: start }
    ;(Date as any).now = () => clock.value
    try {
      await run(clock)
    } finally {
      Date.now = realNow
    }
  }

  function limitsPayload(
    rows: Array<{ unit: number; usage: number | null; remaining: number; resetAt: number }>,
  ): unknown {
    return {
      data: {
        level: "Max Plan",
        limits: rows.map((r) => ({
          unit: r.unit,
          ...(r.usage == null ? {} : { currentValue: r.usage }),
          remaining: r.remaining,
          nextResetTime: r.resetAt,
        })),
      },
    }
  }

  test("entrypoint glue: index.ts stays a pure re-export (<= 10 lines, no logic); plugin shim mirrors it", async () => {
    const glue = readFileSync(new URL("./index.ts", import.meta.url), "utf8")
    const codeLines = glue.split("\n").filter((l) => {
      const t = l.trim()
      return t !== "" && !t.startsWith("//")
    })
    expect(codeLines.length).toBeLessThanOrEqual(10)
    expect(glue).toMatch(/^import \{ createTuiPlugin \} from "\.\/tui"/m)
    expect(glue).toContain('export const id = "zai-quota"')
    expect(glue).toContain("export const tui = createTuiPlugin")
    // no logic may leak into the entrypoint: no functions, I/O, timers, toasts
    expect(glue).not.toMatch(/\bfunction\b|\bsetInterval\b|fetch\(|toast|Date\.|new Map|\bcatch\b/)

    const entry = await import("./index")
    expect(entry.id).toBe("zai-quota")
    expect(entry.tui).toBe(createTuiPlugin)

    const shim = readFileSync(new URL("../.opencode/plugins/zai-quota.ts", import.meta.url), "utf8")
    const shimLines = shim.split("\n").filter((l) => {
      const t = l.trim()
      return t !== "" && !t.startsWith("//")
    })
    expect(shimLines.length).toBeLessThanOrEqual(10)
    expect(shim).toContain('export { id, tui } from "../../src/index"')
  })

  test("idle, error and manual run() fired in the same tick dedupe onto one in-flight fetch", async () => {
    // The timer tick path is the same scheduleRefresh() call as session.idle
    // (non-forced); the real setInterval callback cannot be reached quickly
    // because intervalMs is clamped to >= 10000, so idle stands in for it.
    const f = fakeApi()
    let release: ((r: StubResponse) => void) | null = null
    respond = () =>
      new Promise((res) => {
        release = res
      })
    await createTuiPlugin(f.api, OPT, {})
    pendingDispose.push(() => f.handlers.get("__dispose")?.())
    expect(fetchCalls).toBe(1) // initial refresh in flight, held open

    const manual = f.layers[0].commands[0].run()
    void f.handlers.get("session.idle")()
    void f.handlers.get("session.error")()
    await tick()
    expect(fetchCalls).toBe(1) // every trigger joined the same request

    release!(stubOk())
    await manual
    await tick()
    expect(fetchCalls).toBe(1)
    expect(f.toasts.length).toBe(1)
    expect(f.toasts[0].variant).toBe("success")
    expect(String(f.toasts[0].message)).toContain("5h:")
  })

  test("dispose during an in-flight refresh: late completion neither throws nor re-enters", async () => {
    const f = fakeApi()
    respond = () => new Promise((res) => setTimeout(() => res(stubOk()), 50))
    const rejections: unknown[] = []
    const onUnhandled = (reason: unknown) => {
      rejections.push(reason)
    }
    process.on("unhandledRejection", onUnhandled)
    try {
      await createTuiPlugin(f.api, OPT, {})
      expect(fetchCalls).toBe(1) // refresh in flight (50ms stub)

      f.handlers.get("__dispose")!() // dispose mid-flight
      expect(f.disposed).toContain("slots")
      expect(f.disposed).toContain("layer")
      expect(f.handlers.has("session.idle")).toBe(false) // events detached
      expect(f.handlers.has("session.error")).toBe(false)

      await tick(120) // let the late completion land and write signals
      expect(fetchCalls).toBe(1) // completed once; nothing rescheduled
      await tick(80) // and still nothing fires afterwards
      expect(fetchCalls).toBe(1)
      expect(rejections).toEqual([]) // no unhandled rejection from the late write
    } finally {
      process.off("unhandledRejection", onUnhandled)
    }
  })

  test("two rapid run() invocations dedupe onto one fetch and both toasts await fresh state", async () => {
    const f = fakeApi()
    let release: ((r: StubResponse) => void) | null = null
    respond = () =>
      new Promise((res) => {
        release = res
      })
    await createTuiPlugin(f.api, OPT, {})
    pendingDispose.push(() => f.handlers.get("__dispose")?.())
    expect(fetchCalls).toBe(1)

    const cmd = f.layers[0].commands[0]
    const first = cmd.run()
    const second = cmd.run() // same tick, fetch still open
    await tick()
    expect(fetchCalls).toBe(1) // second invocation joined the first request

    release!(stubOk())
    await Promise.all([first, second])
    expect(f.toasts.length).toBe(2) // one toast per command invocation
    for (const toast of f.toasts) {
      expect(toast.variant).toBe("success")
      // fresh, post-resolution state in BOTH toasts (never a stale empty summary)
      expect(String(toast.message)).toContain("5h: 400/500")
      expect(String(toast.message)).toContain("wk: 600/2000")
    }
    expect(f.toasts[1].message).toBe(f.toasts[0].message)
  })

  test("throttle boundary: elapsed == intervalMs/2 proceeds; strictly below is skipped", async () => {
    const f = fakeApi()
    await withFakeNow(1_000_000, async (clock) => {
      await createTuiPlugin(f.api, OPT, {})
      pendingDispose.push(() => f.handlers.get("__dispose")?.())
      await tick()
      expect(fetchCalls).toBe(1) // started at clock.value = 1_000_000

      clock.value += 5000 - 1 // 4999ms elapsed < intervalMs/2 (5000)
      void f.handlers.get("session.idle")()
      await tick()
      expect(fetchCalls).toBe(1) // skipped

      clock.value += 1 // elapsed exactly == intervalMs/2: equality proceeds
      void f.handlers.get("session.idle")()
      await tick()
      expect(fetchCalls).toBe(2)
    })
  })

  test("five config warnings collapse into one joined warning toast", async () => {
    const opts = {
      ...OPT,
      intervalMs: 5,
      timeoutMs: "junk",
      gaugeWidth: 999,
      maxHistory: 1,
      endpoint: "http://insecure.example",
    }
    const { warnings } = resolveConfig(process.env, opts)
    expect(warnings.length).toBe(5)

    const f = fakeApi()
    await createTuiPlugin(f.api, opts, {})
    pendingDispose.push(() => f.handlers.get("__dispose")?.())

    expect(f.toasts.length).toBe(1)
    expect(f.toasts[0].variant).toBe("warning")
    expect(f.toasts[0].title).toBe("Z.AI quota config")
    const message = String(f.toasts[0].message)
    for (const warning of warnings) {
      expect(message).toContain(warning) // every warning survives the join
    }
    expect(message).toContain("; ")
  })

  test("joined config warning toast truncates at exactly 300 chars", async () => {
    const opts = {
      ...OPT,
      intervalMs: 5,
      timeoutMs: "junk",
      gaugeWidth: 999,
      maxHistory: 1,
      endpoint: "http://insecure.example",
      showRunway: "yes",
      panel: 1,
      chip: 0,
      warnThreshold: 2,
      tokenEnv: [],
      authKeys: [],
    }
    const { warnings } = resolveConfig(process.env, opts)
    const joined = warnings.join("; ")
    expect(joined.length).toBeGreaterThan(300) // premise: there is something to cut

    const f = fakeApi()
    await createTuiPlugin(f.api, opts, {})
    pendingDispose.push(() => f.handlers.get("__dispose")?.())

    expect(f.toasts.length).toBe(1)
    const message = String(f.toasts[0].message)
    expect(message).toBe(joined.slice(0, 300))
    expect(message.length).toBe(300)
    expect(message).not.toContain(warnings[warnings.length - 1]) // tail cut off
  })

  test("null-usage rows never accumulate samples: runway stays no-limit, toast shows ?", async () => {
    const f = fakeApi()
    await withFakeNow(1_700_000_000_000, async (clock) => {
      const five = (usage5h: number | null, usageWk: number) =>
        limitsPayload([
          { unit: 3, usage: usage5h, remaining: 100, resetAt: clock.value + 3_600_000 },
          { unit: 6, usage: usageWk, remaining: 1400, resetAt: clock.value + 86_400_000 },
        ])
      queueRespond([five(null, 600), five(null, 620)])
      await createTuiPlugin(f.api, OPT, {})
      pendingDispose.push(() => f.handlers.get("__dispose")?.())
      await tick()

      // chip: 5h percent unknown, wk valid
      const chip = await renderSlot(f.slots[0].slots.session_prompt_right)
      expect(chip.captureCharFrame()).toContain(" zai ?\u00b7")

      // panel: 5h row has no limit -> "runway —" and "?/?" usage text
      const panel = await renderSlot(f.slots[0].slots.sidebar_content)
      const frame = panel.captureCharFrame()
      expect(frame).toContain("runway \u2014")
      expect(frame).toContain("?/?")

      // second refresh 2s later: the valid row gains a projection from two
      // samples while the null-usage row stays inert (no samples, no crash)
      clock.value += 2000
      void f.handlers.get("session.error")()
      await tick()
      expect(fetchCalls).toBe(2)
      const panel2 = await renderSlot(f.slots[0].slots.sidebar_content)
      const frame2 = panel2.captureCharFrame()
      expect(frame2).toContain("runway \u2014") // null row still no-limit
      expect(frame2).toContain("runway ~") // valid row projected

      const before = f.toasts.length
      await f.layers[0].commands[0].run()
      expect(f.toasts.length).toBe(before + 1)
      expect(String(f.toasts[before].message)).toContain("5h: ?/?")
    })
  })

  test("empty-but-valid 200 payload collapses chip to zai:? and panel to 'no data'", async () => {
    const f = fakeApi()
    respond = () =>
      Promise.resolve({
        status: 200,
        text: async () => JSON.stringify({ data: { limits: [], level: null } }),
      })
    await createTuiPlugin(f.api, OPT, {})
    pendingDispose.push(() => f.handlers.get("__dispose")?.())
    await tick()

    // chip: error-state collapse (not the " zai ?·? " no-rows fallback)
    const chip = await renderSlot(f.slots[0].slots.session_prompt_right)
    expect(chip.captureCharFrame()).toContain(" zai:?")

    // panel: ERROR_TEXT.empty instead of "loading…"; updatedAt stays set
    const panel = await renderSlot(f.slots[0].slots.sidebar_content)
    const frame = panel.captureCharFrame()
    expect(frame).toContain("no data")
    expect(frame).not.toContain("loading")
    expect(frame).not.toContain("\u2014") // header shows a real timestamp
  })

  test("valid rows keep error null: chip shows digits (regression guard)", async () => {
    const f = fakeApi()
    await createTuiPlugin(f.api, OPT, {}) // default stub: valid two-row payload
    pendingDispose.push(() => f.handlers.get("__dispose")?.())
    await tick()

    const chip = await renderSlot(f.slots[0].slots.session_prompt_right)
    const chipFrame = chip.captureCharFrame()
    expect(chipFrame).toContain(" zai 80\u00b730")
    expect(chipFrame).not.toContain("zai:?")

    const panel = await renderSlot(f.slots[0].slots.sidebar_content)
    const frame = panel.captureCharFrame()
    expect(frame).toContain("80%")
    expect(frame).not.toContain("no data")
    expect(frame).not.toContain("loading")
  })

  test("recovery: empty payload then run() with rows returns the chip to digits", async () => {
    const f = fakeApi()
    const bodies = [
      JSON.stringify({ data: { limits: [], level: null } }),
      JSON.stringify(quotaPayload()),
    ]
    respond = () => Promise.resolve({ status: 200, text: async () => bodies.shift()! })
    await createTuiPlugin(f.api, OPT, {})
    pendingDispose.push(() => f.handlers.get("__dispose")?.())
    await tick()

    // first refresh: empty taxonomy state visible
    const chip1 = await renderSlot(f.slots[0].slots.session_prompt_right)
    expect(chip1.captureCharFrame()).toContain(" zai:?")

    // manual run() fetches again; rows arrive -> error clears, digits return
    await f.layers[0].commands[0].run()
    expect(f.toasts.length).toBe(1)
    expect(f.toasts[0].variant).toBe("success") // error() back to null

    const chip2 = await renderSlot(f.slots[0].slots.session_prompt_right)
    const frame2 = chip2.captureCharFrame()
    expect(frame2).not.toContain("zai:?")
    expect(frame2).toContain(" zai 80\u00b730")
  })

  test("changed resetAt between refreshes resets that row's runway history", async () => {
    const f = fakeApi()
    await withFakeNow(1_700_000_000_000, async (clock) => {
      const t1 = clock.value + 3_600_000
      const t2 = clock.value + 7_200_000
      const five = (usage: number, resetAt: number) =>
        limitsPayload([{ unit: 3, usage, remaining: 100, resetAt }])
      queueRespond([five(400, t1), five(420, t1), five(440, t2)])
      await createTuiPlugin(f.api, OPT, {})
      pendingDispose.push(() => f.handlers.get("__dispose")?.())
      await tick()

      // one sample only: no projection yet
      const panel1 = await renderSlot(f.slots[0].slots.sidebar_content)
      expect(panel1.captureCharFrame()).toContain("runway \u2026")

      clock.value += 2000
      void f.handlers.get("session.error")()
      await tick()
      expect(fetchCalls).toBe(2)
      // same window, two samples 2s apart, burn 0.01/ms -> projection exists
      // (limit 520, usage 420, remaining 100 -> runway 10s < 59m to reset: warn)
      const panel2 = await renderSlot(f.slots[0].slots.sidebar_content)
      expect(panel2.captureCharFrame()).toContain("runway ~10s !")

      clock.value += 2000
      void f.handlers.get("session.error")()
      await tick()
      expect(fetchCalls).toBe(3)
      // resetAt changed -> history restarts from one sample -> back to no-data
      const panel3 = await renderSlot(f.slots[0].slots.sidebar_content)
      const frame3 = panel3.captureCharFrame()
      expect(frame3).toContain("runway \u2026")
      expect(frame3).not.toContain("runway ~")
    })
  })
})
