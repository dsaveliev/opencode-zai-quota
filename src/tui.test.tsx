/**
 * Wiring tests for the TUI plugin (src/tui.tsx), V2 surfaces (W3).
 *
 * Runs against a fake api object; global fetch is stubbed. Slot functions
 * are rendered headless through `testRender` from @opentui/solid (direct
 * invocation throws "No renderer found" by design of the reconciler). Under
 * Bun the loaded @opentui bundle pairs with the SSR solid build, so the
 * plugin drives re-renders itself; the tick/updating/click tests below pin
 * that machinery.
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

/**
 * Distinct valid hex per theme key. The five V2 tokens (text, textMuted,
 * success, warning, error) prove colors resolve through THEME_KEY; the
 * legacy keys (primary/info/border) stay in the palette so a leak back to
 * the old role map renders as a distinguishable color instead of passing.
 */
const THEME_HEX: Record<string, string> = {
  text: "#0102f6",
  textMuted: "#808004",
  success: "#00ff03",
  warning: "#ff8002",
  error: "#ff0001",
  primary: "#0000f5",
  info: "#00f0f6",
  border: "#a0a0a7",
}

const TOKEN_HEXES = [
  THEME_HEX.text,
  THEME_HEX.textMuted,
  THEME_HEX.success,
  THEME_HEX.warning,
  THEME_HEX.error,
]

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
      // Real host contract (verified against the opencode binary): register
      // returns the assigned slot ID STRING — slot lifetime is host-managed,
      // the plugin must never call it. Regression anchor for the
      // "disposeSlots is not a function" crash at shutdown.
      register: (p: any) => {
        slots.push(p)
        return "zai-quota"
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
        // unit 3 -> "5h" row at 80% (single sample: unknown verdict), unit 6 -> "7d" row at 30%
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

/** All spans of a rendered slot (across lines). */
function spansOf(setup: any): any[] {
  return (setup.captureSpans() as any).lines.flatMap((line: any) => line.spans)
}

/**
 * Find the renderable carrying the panel's mouse handlers by walking the
 * renderable tree from the root (children via getChildren()).
 */
function findPanelBox(setup: any): any {
  const walk = (node: any): any[] => {
    const out = [node]
    const kids = typeof node.getChildren === "function" ? node.getChildren() : (node.children ?? [])
    for (const k of kids) out.push(...walk(k))
    return out
  }
  const match = walk(setup.renderer.root).find(
    (nd: any) => nd._mouseListeners != null && Object.keys(nd._mouseListeners).length > 0,
  )
  if (match == null) throw new Error("panel box with mouse handlers not found")
  return match
}

/**
 * Capture setInterval callbacks registered at exactly 10_000ms (the tick
 * timer). Tests that need a wider refresh interval pass intervalMs so the
 * refresh timer never collides with 10_000.
 */
async function withTickHook<T>(run: (fireTick: () => void) => Promise<T>): Promise<T> {
  const hooks: Array<() => void> = []
  const original = globalThis.setInterval
  globalThis.setInterval = ((fn: any, ms?: any, ...args: any[]) => {
    if (typeof fn === "function" && ms === 10_000) hooks.push(fn)
    return original(fn, ms, ...args)
  }) as any
  try {
    return await run(() => hooks[0]?.())
  } finally {
    globalThis.setInterval = original
  }
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
    // order 50 = FIRST sidebar section, above the native Context section
    expect(f.slots[0].order).toBe(50)
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
    expect(frame).toContain(" zai 80%\u00b730%")
    expect(frame).not.toContain("zai:?")
  })

  test("sidebar panel renders header, rows and gauges after fetch", async () => {
    const f = fakeApi()
    await createTuiPlugin(f.api, OPT, {})
    pendingDispose.push(() => f.handlers.get("__dispose")?.())
    await tick()

    const panel = await renderSlot(f.slots[0].slots.sidebar_content)
    const frame = panel.captureCharFrame()
    expect(frame).toContain("Z.ai Runway")
    expect(frame).toContain("Max Plan")
    expect(frame).toContain("5h")
    expect(frame).toContain("7d")
    expect(frame).toContain("\u2588") // filled gauge cell
    expect(frame).toContain("80%")
    expect(frame).toContain(" 400/500") // single-space separator (no glued "80%400")
    expect(frame).not.toContain("80%400")
    expect(frame).toContain("reset")
  })

  test("panel container box carries no horizontal padding (grid starts at col 0)", async () => {
    const f = fakeApi()
    await createTuiPlugin(f.api, OPT, {})
    pendingDispose.push(() => f.handlers.get("__dispose")?.())
    await tick()

    const panel = await renderSlot(f.slots[0].slots.sidebar_content)
    const box = findPanelBox(panel)
    // Yoga edge constants: 0 = Left, 2 = Right. The panel must render its
    // 38-col grid flush with the sidebar's native sections (Context/MCP/LSP
    // render <box> without padding), so paddingLeft/paddingRight stay unset.
    expect(box.yogaNode.getComputedPadding(0)).toBe(0)
    expect(box.yogaNode.getComputedPadding(2)).toBe(0)
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

  test("dispose clears both timers and calls slot/layer disposers", async () => {
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
      expect(cleared.length).toBe(2) // refresh timer + 10s tick timer
      expect(f.disposed).toContain("layer")
      expect(f.disposed).not.toContain("slots") // host-managed: register returns the id string, nothing to call
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
    expect(String(f.toasts[0].message)).toContain("7d:")
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

  test("chip colors resolve exclusively through THEME_KEY lookups (V2 tokens)", async () => {
    const f = fakeApi()
    await createTuiPlugin(f.api, OPT, {})
    pendingDispose.push(() => f.handlers.get("__dispose")?.())
    await tick()

    const setup = await renderSlot(f.slots[0].slots.session_prompt_right)
    const spans = spansOf(setup).filter((s: any) => String(s.text ?? "").trim() !== "")
    const bad = spans.filter((s) => !TOKEN_HEXES.includes(fgHex(s)))
    expect(bad.map((s) => ({ text: s.text, fg: fgHex(s) }))).toEqual([])

    const byText = new Map(spans.map((s) => [String(s.text ?? ""), s]))
    expect(fgHex(byText.get(" zai "))).toBe(THEME_HEX.textMuted)
    expect(fgHex(byText.get("80%"))).toBe(THEME_HEX.text)
    expect(fgHex(byText.get("\u00b7"))).toBe(THEME_HEX.textMuted)
    expect(fgHex(byText.get("30%"))).toBe(THEME_HEX.text)
    // single sample -> unknown verdict -> "?" glyph carries textMuted
    expect(fgHex(byText.get(" ?"))).toBe(THEME_HEX.textMuted)
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
   * Queue-based respond with per-item status codes: each fetch pops the next
   * response; the last repeats. For mixed success/error refresh sequences.
   */
  function queueStatuses(items: Array<{ status: number; body: unknown }>): void {
    const queue = items.map((i) => ({ status: i.status, text: async () => JSON.stringify(i.body) }))
    respond = () => {
      const response = queue.length > 1 ? queue.shift()! : queue[0]
      return Promise.resolve(response)
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

  test("entrypoint glue: index.ts default-exports the plugin module contract { id, tui } (<= 10 lines, no logic)", async () => {
    const glue = readFileSync(new URL("./index.ts", import.meta.url), "utf8")
    const codeLines = glue.split("\n").filter((l) => {
      const t = l.trim()
      return t !== "" && !t.startsWith("//")
    })
    expect(codeLines.length).toBeLessThanOrEqual(10)
    expect(glue).toMatch(/^import \{ createTuiPlugin \} from "\.\/tui"/m)
    expect(glue).toContain('export default { id: "zai-quota", tui: createTuiPlugin }')
    // no logic may leak into the entrypoint: no functions, I/O, timers, toasts
    expect(glue).not.toMatch(/\bfunction\b|\bsetInterval\b|fetch\(|toast|Date\.|new Map|\bcatch\b/)

    const entry = await import("./index")
    expect(entry.default).toBeDefined()
    expect(entry.default.id).toBe("zai-quota")
    expect(entry.default.tui).toBe(createTuiPlugin)
    expect(typeof entry.default.tui).toBe("function")
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
      expect(f.disposed).toContain("layer")
      expect(f.disposed).not.toContain("slots") // host-managed: register returns the id string, nothing to call
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
      expect(String(toast.message)).toContain("7d: 600/2000")
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
      glyphs: "fancy",
      panel: 1,
      chip: 0,
      detail: "maybe",
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

      // panel: 5h row has no limit -> "runway …" and "?/?" usage text
      const panel = await renderSlot(f.slots[0].slots.sidebar_content)
      const frame = panel.captureCharFrame()
      expect(frame).toContain("runway \u2026")
      expect(frame).toContain("?/?")

      // second refresh 2s later: the valid row gains a projection from two
      // samples while the null-usage row stays inert (no samples, no crash)
      clock.value += 2000
      void f.handlers.get("session.error")()
      await tick()
      expect(fetchCalls).toBe(2)
      const panel2 = await renderSlot(f.slots[0].slots.sidebar_content)
      const frame2 = panel2.captureCharFrame()
      expect(frame2).toContain("runway \u2026") // null row still no-limit
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

    // panel: "no data" error line instead of "loading…"; header has an age
    const panel = await renderSlot(f.slots[0].slots.sidebar_content)
    const frame = panel.captureCharFrame()
    expect(frame).toContain("no data")
    expect(frame).not.toContain("loading")
    expect(frame).not.toContain("\u2014") // header shows a real attempt age
  })

  test("valid rows keep error null: chip shows digits (regression guard)", async () => {
    const f = fakeApi()
    await createTuiPlugin(f.api, OPT, {}) // default stub: valid two-row payload
    pendingDispose.push(() => f.handlers.get("__dispose")?.())
    await tick()

    const chip = await renderSlot(f.slots[0].slots.session_prompt_right)
    const chipFrame = chip.captureCharFrame()
    expect(chipFrame).toContain(" zai 80%\u00b730%")
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
    expect(frame2).toContain(" zai 80%\u00b730%")
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
      // (limit 520, usage 420, remaining 100 -> runway 10s < 59m to reset)
      const panel2 = await renderSlot(f.slots[0].slots.sidebar_content)
      expect(panel2.captureCharFrame()).toContain("runway ~10s")

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

  test("labels absent from a successful refresh are pruned: a reintroduced row starts with fresh history", async () => {
    const f = fakeApi()
    await withFakeNow(1_700_000_000_000, async (clock) => {
      const t0 = clock.value
      const wkReset = t0 + 86_400_000 // same absolute reset in every payload
      // 5h pinned at a constant 62% (usage never grows -> can only be "∞",
      // never a "~" projection, so "runway ~" isolates the wk row)
      const fiveRow = { unit: 3, usage: 310, remaining: 190, resetAt: t0 + 3_600_000 }
      const both = limitsPayload([
        fiveRow,
        { unit: 6, usage: 600, remaining: 1400, resetAt: wkReset },
      ])
      const fiveOnly = limitsPayload([fiveRow])
      // reintroduction with usage HIGHER than before (650 > 600) and an
      // UNCHANGED resetAt: a retained history would append (no window reset,
      // no usage decrease) and project "runway ~"; a pruned one holds a
      // single sample -> "runway …". A lower usage would restart history in
      // both cases and prove nothing.
      const reintro = limitsPayload([
        fiveRow,
        { unit: 6, usage: 650, remaining: 1350, resetAt: wkReset },
      ])
      queueRespond([both, fiveOnly, fiveOnly, reintro])
      await createTuiPlugin(f.api, OPT, {})
      pendingDispose.push(() => f.handlers.get("__dispose")?.())
      await tick() // fetch 1 at t0: 5h + 7d sampled

      clock.value += 2000
      void f.handlers.get("session.error")()
      await tick()
      expect(fetchCalls).toBe(2) // only 5h arrives: 7d pruned after this pass

      clock.value += 2000
      void f.handlers.get("session.error")()
      await tick()
      expect(fetchCalls).toBe(3) // still only 5h

      // chip: 5h at 62%, 7d row absent -> "?" in its slot
      const chip = await renderSlot(f.slots[0].slots.session_prompt_right)
      expect(chip.captureCharFrame()).toContain(" zai 62%\u00b7?")

      // reintroduce 7d: history must start from scratch
      clock.value += 2000
      void f.handlers.get("session.error")()
      await tick()
      expect(fetchCalls).toBe(4)
      const panel = await renderSlot(f.slots[0].slots.sidebar_content)
      const frame = panel.captureCharFrame()
      expect(frame).toContain("7d") // the reintroduced row renders
      expect(frame).toContain("runway \u2026") // fresh history -> no-data
      expect(frame).not.toContain("runway ~") // retained history would project
    })
  })

  test("stale marker: fresh identical 500-errors stay un-stale; an aged last attempt marks stale", async () => {
    const f = fakeApi()
    await withFakeNow(1_700_000_000_000, async (clock) => {
      queueStatuses([
        { status: 200, body: quotaPayload() },
        { status: 500, body: "server says no" },
      ])
      await createTuiPlugin(f.api, OPT, {})
      pendingDispose.push(() => f.handlers.get("__dispose")?.())
      await tick() // success at t0: updatedAt set
      expect(fetchCalls).toBe(1)

      // sanity: a fresh success is not stale
      const panel0 = await renderSlot(f.slots[0].slots.sidebar_content)
      expect(panel0.captureCharFrame()).not.toContain("stale")

      // 20.001s later the identical 500 lands: cached rows stay on screen
      // (no HTTP 500 line — the error hides behind cached data), and the
      // attempt is fresh, so the error panel must NOT be stale yet (old
      // code: stale keyed off the 20.001s-old last-success updatedAt)
      clock.value += 2 * 10000 + 1
      void f.handlers.get("session.error")()
      await tick()
      expect(fetchCalls).toBe(2)
      const panel1 = await renderSlot(f.slots[0].slots.sidebar_content)
      const frame1 = panel1.captureCharFrame()
      expect(frame1).toContain("5h") // cached rows still rendered
      expect(frame1).not.toContain("HTTP 500") // error hidden behind cache
      expect(frame1).not.toContain("stale")

      // second identical 500, still fresh -> still no stale
      void f.handlers.get("session.error")()
      await tick()
      expect(fetchCalls).toBe(3)
      const panel2 = await renderSlot(f.slots[0].slots.sidebar_content)
      expect(panel2.captureCharFrame()).not.toContain("stale")

      // attempts go silent; once the LAST ATTEMPT itself ages past two
      // intervals, the marker appears
      clock.value += 2 * 10000 + 1
      const panel3 = await renderSlot(f.slots[0].slots.sidebar_content)
      expect(panel3.captureCharFrame()).toContain("stale")
    })
  })

  test("stale marker: identical-error outage with no prior success marks stale after 2 intervals", async () => {
    const f = fakeApi()
    await withFakeNow(1_700_000_000_000, async (clock) => {
      respond = () => Promise.resolve({ status: 500, text: async () => "server says no" })
      await createTuiPlugin(f.api, OPT, {})
      pendingDispose.push(() => f.handlers.get("__dispose")?.())
      await tick() // attempt 1 fails
      void f.handlers.get("session.error")() // attempt 2: identical error string
      await tick()
      expect(fetchCalls).toBe(2)

      // attempts go silent (the 10s timer never fires within a test); the
      // last attempt ages past two intervals. V2 model contract: the stale
      // MARKER requires cached rows (computeStale returns false when rows
      // are empty), so an outage that never saw data shows the attempt age
      // growing instead — the header clock tracks lastAttemptAt, which old
      // code (updatedAt-based) could never do without a success.
      clock.value += 2 * 10000 + 1
      const panel = await renderSlot(f.slots[0].slots.sidebar_content)
      const frame = panel.captureCharFrame()
      expect(frame).toContain("HTTP 500") // no rows ever -> error line shown
      expect(frame).toContain("20s ago") // the aged LAST ATTEMPT, not "—"
      expect(frame).not.toContain("\u2014") // header shows the attempt age
      expect(frame).not.toContain("stale") // V2: stale needs cached rows
    })
  })
})

// ===========================================================================
// V2 slot surfaces (W3): ok-state golden, fg purity, updating indicator,
// click-to-refresh (with drag + cooldown + join), tick re-render, detail
// auto mode, ascii glyph mode.
// ===========================================================================

describe("V2 slot surfaces (W3)", () => {
  const T0 = 1_700_000_000_000

  /**
   * Two-fetch ok fixture on a fake clock: 5h 310 -> 312 over 120s (burn
   * projects a 188-minute runway against a 72-minute reset -> verdict ok),
   * 7d constant 4.1M/10M (no burn -> verdict ok). Rendered at T0+120s.
   */
  function okBodies(): { first: unknown; second: unknown } {
    const reset5h = T0 + 72 * 60_000
    const reset7d = T0 + 273_600_000
    return {
      first: limits(T0, 310, reset5h, reset7d),
      second: limits(T0, 312, reset5h, reset7d),
    }
  }

  function limits(now: number, usage5h: number, reset5h: number, reset7d: number): unknown {
    return {
      data: {
        level: "Max Plan",
        limits: [
          { unit: 3, currentValue: usage5h, remaining: 500 - usage5h, nextResetTime: reset5h },
          { unit: 6, currentValue: 4_100_000, remaining: 5_900_000, nextResetTime: reset7d },
        ],
      },
    }
  }

  /**
   * Short variant sized so the detail line survives the 40-col degradation
   * ladder: 5h burns 0 -> 480 over 120s (remaining 20 at 4e-3/ms -> runway
   * ~5s against a 59-minute reset -> verdict short, "!!"). Detail renders
   * as "     reset 57m · runway ~5s  (57m short)" = exactly 40 columns.
   */
  function shortBodies(): { first: unknown; second: unknown } {
    const reset5h = T0 + 59 * 60_000
    const reset7d = T0 + 273_600_000
    const mk = (usage: number) => limits(T0, usage, reset5h, reset7d)
    return { first: mk(0), second: mk(480) }
  }

  async function driveTwoFetches(
    f: ReturnType<typeof fakeApi>,
    bodies: { first: unknown; second: unknown },
    opts: Record<string, unknown> = {},
    run: (clock: { value: number }, fireTick: () => void) => Promise<void>,
  ): Promise<void> {
    const { withFakeNow } = auditHelpers
    await withFakeNow(T0, async (clock) => {
      const queue = [JSON.stringify(bodies.first), JSON.stringify(bodies.second)]
      respond = () =>
        Promise.resolve({
          status: 200,
          text: async () => (queue.length > 1 ? queue.shift()! : queue[0]),
        })
      await withTickHook(async (fireTick) => {
        await createTuiPlugin(f.api, { ...OPT, ...opts }, {})
        pendingDispose.push(() => f.handlers.get("__dispose")?.())
        await tick() // fetch 1 at T0
        clock.value += 120_000 // >= intervalMs/2: idle trigger allowed
        void f.handlers.get("session.idle")()
        await tick() // fetch 2 at T0+120s
        expect(fetchCalls).toBe(2)
        await run(clock, fireTick)
      })
    })
  }

  const auditHelpers = {
    async withFakeNow(
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
    },
  }

  test("(a) ok state: title, labels, verdict glyph, marker, percent, spaced separators, details", async () => {
    const f = fakeApi()
    await driveTwoFetches(f, okBodies(), {}, async () => {
      const panel = await renderSlot(f.slots[0].slots.sidebar_content)
      const frame = panel.captureCharFrame()
      expect(frame).toContain("Z.ai Runway")
      expect(frame).toContain("Max Plan")
      expect(frame).toContain("5h")
      expect(frame).toContain("7d")
      expect(frame).toContain("\u2713") // ok verdict glyph
      expect(frame).toContain("\u2502") // reset marker as its own segment
      expect(frame).toContain("62%") // rounded percent (62.4)
      expect(frame).toContain(" 62%") // single-space separator before percent
      expect(frame).not.toContain("62%312") // no glued percent+usage
      expect(frame).toContain("312/500") // usage/limit texts
      expect(frame).toContain("reset 1h 10m") // 5h detail line (detail: always)
      expect(frame).toContain("runway ~3h 8m") // 188-minute projection
      expect(frame.match(/reset/g)?.length).toBe(2) // both windows keep details
      // chip: ok verdict with both percents
      const chip = await renderSlot(f.slots[0].slots.session_prompt_right)
      const chipFrame = chip.captureCharFrame()
      expect(chipFrame).toContain(" zai 62%\u00b741%")
      expect(chipFrame).toContain("\u2713")
    })
  })

  test("(b) fg purity: every rendered span carries one of the 5 token colors; percent is colored", async () => {
    const f = fakeApi()
    await driveTwoFetches(f, okBodies(), {}, async () => {
      const panel = await renderSlot(f.slots[0].slots.sidebar_content)
      const spans = spansOf(panel).filter((s: any) => String(s.text ?? "").trim() !== "")
      expect(spans.length).toBeGreaterThan(0)
      const bad = spans
        .map((s: any) => ({ text: String(s.text ?? ""), fg: s.fg ? fgHex(s) : null }))
        .filter((s: any) => !TOKEN_HEXES.includes(s.fg))
      expect(bad).toEqual([]) // no span without an explicit 5-token fg
      // the white-percent regression guard: the percent text node HAS fg = text token
      const percent = spans.find((s: any) => String(s.text ?? "").includes("62%"))
      expect(percent).toBeDefined()
      expect(fgHex(percent)).toBe(THEME_HEX.text)
    })
  })

  test("(c) updating: header shows updating in flight, gone after; failure keeps cached rows and ages to stale", async () => {
    const f = fakeApi()
    const bodies = okBodies()
    let release: ((r: StubResponse) => void) | null = null
    await auditHelpers.withFakeNow(T0, async (clock) => {
      await withTickHook(async (fireTick) => {
        respond = () =>
          new Promise((res) => {
            release = res
          })
        await createTuiPlugin(f.api, { ...OPT, intervalMs: 30000 }, {})
        pendingDispose.push(() => f.handlers.get("__dispose")?.())

        // fetch 1 in flight: header carries the updating indicator
        const panel = await renderSlot(f.slots[0].slots.sidebar_content)
        expect(panel.captureCharFrame()).toContain("updating")

        release!({ status: 200, text: async () => JSON.stringify(bodies.first) })
        await tick()
        await panel.flush()
        const frame1 = panel.captureCharFrame()
        expect(frame1).not.toContain("updating")
        expect(frame1).toContain("5h")

        // failure after success: cached rows survive, no error line, no
        // fabricated fresh-success state
        clock.value += 21_000
        respond = () => Promise.resolve({ status: 500, text: async () => "server says no" })
        void f.handlers.get("session.error")()
        await tick()
        await panel.flush()
        const frame2 = panel.captureCharFrame()
        expect(frame2).toContain("5h") // cached rows still rendered
        expect(frame2).not.toContain("HTTP 500") // error hidden behind cache
        expect(frame2).not.toContain("updating")
        expect(frame2).not.toContain("stale") // fresh attempt keeps it un-stale

        // the failed attempt never wrote updatedAt: silence past two
        // intervals ages the LAST ATTEMPT and the stale marker appears
        clock.value += 2 * 30000 + 1
        fireTick()
        await tick()
        await panel.flush()
        expect(panel.captureCharFrame()).toContain("stale")
        expect(fetchCalls).toBe(2) // exactly: initial + one forced retry
      })
    })
  })

  test("(d) click: mouseup fetches; drag+mouseup does not; 1s cooldown; in-flight joins", async () => {
    const f = fakeApi()
    await auditHelpers.withFakeNow(T0, async (clock) => {
      respond = () => Promise.resolve(stubOk())
      await createTuiPlugin(f.api, OPT, {})
      pendingDispose.push(() => f.handlers.get("__dispose")?.())
      await tick()
      expect(fetchCalls).toBe(1)

      const panel = await renderSlot(f.slots[0].slots.sidebar_content)
      const box = findPanelBox(panel)

      // plain mouseup past the cooldown -> one forced fetch
      clock.value += 2000
      box._mouseListeners.up({})
      await tick()
      expect(fetchCalls).toBe(2)

      // drag followed by mouseup -> swallowed (selection, not a click)
      clock.value += 2000
      box._mouseListeners.drag({})
      box._mouseListeners.up({})
      await tick()
      expect(fetchCalls).toBe(2)
      // the drag flag reset: the next clean mouseup fetches again
      box._mouseListeners.up({})
      await tick()
      expect(fetchCalls).toBe(3)

      // double mouseup within the 1s force cooldown -> exactly one force
      clock.value += 2000
      box._mouseListeners.up({})
      await tick()
      expect(fetchCalls).toBe(4)
      box._mouseListeners.up({}) // still < 1s since the last force start
      await tick()
      expect(fetchCalls).toBe(4)
      clock.value += 1000 // cooldown elapsed -> click works again
      box._mouseListeners.up({})
      await tick()
      expect(fetchCalls).toBe(5)
    })
  })

  test("(d2) mouseup during an in-flight fetch joins it instead of starting a second", async () => {
    const f = fakeApi()
    let release: ((r: StubResponse) => void) | null = null
    respond = () =>
      new Promise((res) => {
        release = res
      })
    await createTuiPlugin(f.api, OPT, {})
    pendingDispose.push(() => f.handlers.get("__dispose")?.())
    expect(fetchCalls).toBe(1) // initial fetch held open

    const panel = await renderSlot(f.slots[0].slots.sidebar_content)
    const box = findPanelBox(panel)
    box._mouseListeners.up({})
    await tick()
    expect(fetchCalls).toBe(1) // click joined the in-flight refresh

    release!(stubOk())
    await tick()
    expect(fetchCalls).toBe(1)
  })

  test("(e) tick: a 10s heartbeat advances freshness text without a new fetch", async () => {
    const f = fakeApi()
    await driveTwoFetches(
      f,
      okBodies(),
      { intervalMs: 30000 }, // refresh timer at 30s: the only 10_000 interval is the tick
      async (clock, fireTick) => {
        const panel = await renderSlot(f.slots[0].slots.sidebar_content)
        expect(panel.captureCharFrame()).toContain("just now")

        clock.value += 15_000
        fireTick()
        await tick()
        await panel.flush()
        const frame = panel.captureCharFrame()
        expect(frame).toContain("15s ago") // freshness advanced
        expect(fetchCalls).toBe(2) // ...without refetching
        expect(frame).not.toContain("stale") // 15s << 2*interval
      },
    )
  })

  test("(f) detail auto: ok windows lose the detail line; short windows keep it", async () => {
    const f = fakeApi()
    await driveTwoFetches(f, shortBodies(), { detail: "auto" }, async () => {
      const panel = await renderSlot(f.slots[0].slots.sidebar_content)
      const frame = panel.captureCharFrame()
      // 5h is short: verdict glyph, detail line with reset + shortfall kept
      expect(frame).toContain("!!")
      expect(frame).toContain("reset 57m")
      expect(frame).toContain("runway ~5s")
      expect(frame).toContain("(56m short)") // 57m reset minus ~5s runway = 56m55s
      // 7d is ok: its detail line is dropped -> exactly one "reset" total
      expect(frame.match(/reset/g)?.length).toBe(1)
      expect(frame).not.toContain("reset 3d")
    })
  })

  test("(g) ascii glyph mode: output is 7-bit only", async () => {
    const f = fakeApi()
    await driveTwoFetches(f, okBodies(), { glyphs: "ascii" }, async () => {
      const panel = await renderSlot(f.slots[0].slots.sidebar_content)
      const frame = panel.captureCharFrame()
      for (const banned of ["\u2588", "\u2591", "\u2502", "\u2713", "\u00b7", "\u2026", "\u221e"]) {
        expect(frame).not.toContain(banned)
      }
      expect(frame).toContain("#") // ascii bar fill
      expect(frame).toContain("|") // embedded ascii reset marker
      expect(frame).toContain("62%")
      expect(frame).toContain("runway inf") // no-burn 7d asciified

      const chip = await renderSlot(f.slots[0].slots.session_prompt_right)
      expect(chip.captureCharFrame()).not.toContain("\u00b7")
    })
  })
})

// ===========================================================================
// W3 audit addenda: click-cooldown/in-flight interplay, tick-timer disposal
// by identity, updating indicator on click-triggered fetches vs the config
// warning toast.
// ===========================================================================

describe("W3 audit addenda", () => {
  const T0 = 1_700_000_000_000

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

  test("(h) click starts a slow force; a second click joins it without re-anchoring the 1s cooldown", async () => {
    const f = fakeApi()
    let release: ((r: StubResponse) => void) | null = null
    await withFakeNow(T0, async (clock) => {
      respond = () => Promise.resolve(stubOk())
      await createTuiPlugin(f.api, OPT, {})
      pendingDispose.push(() => f.handlers.get("__dispose")?.())
      await tick()
      expect(fetchCalls).toBe(1)

      const panel = await renderSlot(f.slots[0].slots.sidebar_content)
      const box = findPanelBox(panel)

      // click at t0: starts a click-forced fetch whose response is held open
      clock.value += 2000
      respond = () =>
        new Promise((res) => {
          release = res
        })
      box._mouseListeners.up({})
      await tick()
      expect(fetchCalls).toBe(2)

      // second click 0.5s later, first still in flight: joins the request
      // (join precedence over the cooldown) and must NOT bump
      // lastForceStartedAt, or the post-release cooldown would be extended
      clock.value += 500
      box._mouseListeners.up({})
      await tick()
      expect(fetchCalls).toBe(2)

      release!(stubOk())
      await tick()

      // 0.8s after the force START: fetch is done (inFlight null), rows
      // present, error null -> the click-anchored 1s cooldown rejects
      clock.value += 300
      box._mouseListeners.up({})
      await tick()
      expect(fetchCalls).toBe(2)

      // 1.2s after the force START: cooldown elapsed -> fresh force
      clock.value += 400
      box._mouseListeners.up({})
      await tick()
      expect(fetchCalls).toBe(3)
      release!(stubOk()) // hygiene: nothing left in flight for teardown
      await tick()
    })
  })

  test("(i) dispose clears both timer ids by identity: the 10s tick AND the refresh interval", async () => {
    const f = fakeApi()
    const originalSetInterval = globalThis.setInterval
    const originalClearInterval = globalThis.clearInterval
    const created = new Map<unknown, number>() // id -> interval ms
    const cleared = new Set<unknown>()
    globalThis.setInterval = ((fn: any, ms?: any, ...args: any[]) => {
      const id = originalSetInterval(fn, ms, ...args)
      created.set(id, Number(ms))
      return id
    }) as any
    globalThis.clearInterval = ((id: unknown) => {
      cleared.add(id)
      return originalClearInterval(id as any)
    }) as any
    try {
      await createTuiPlugin(f.api, { ...OPT, intervalMs: 30000 }, {})
      pendingDispose.push(() => f.handlers.get("__dispose")?.())
      await tick()

      const refreshIds = [...created].filter(([, ms]) => ms === 30000).map(([id]) => id)
      const tickIds = [...created].filter(([, ms]) => ms === 10_000).map(([id]) => id)
      expect(refreshIds.length).toBe(1) // premise: exactly one refresh timer
      expect(tickIds.length).toBe(1) // ...and exactly one 10s tick timer
      expect(refreshIds[0]).not.toBe(tickIds[0])

      f.handlers.get("__dispose")!()
      expect(cleared.has(refreshIds[0])).toBe(true) // refresh timer dead
      expect(cleared.has(tickIds[0])).toBe(true) // 10s heartbeat dead

      await tick(20)
      expect(fetchCalls).toBe(1) // no refresh side effects after dispose
    } finally {
      globalThis.setInterval = originalSetInterval
      globalThis.clearInterval = originalClearInterval
    }
  })

  test("(j) config warning toast alone never wedges updating; a click-started fetch shows it until it lands", async () => {
    const f = fakeApi()
    let release: ((r: StubResponse) => void) | null = null
    await withFakeNow(T0, async (clock) => {
      respond = () => Promise.resolve(stubOk())
      await createTuiPlugin(f.api, { ...OPT, intervalMs: 5 }, {}) // clamped -> warning toast
      pendingDispose.push(() => f.handlers.get("__dispose")?.())
      await tick()
      expect(fetchCalls).toBe(1) // initial refresh done (updating back to false)
      expect(f.toasts.some((t) => t.variant === "warning")).toBe(true) // premise

      // the warning toast itself left no updating marker behind
      const panel = await renderSlot(f.slots[0].slots.sidebar_content)
      await panel.flush()
      expect(panel.captureCharFrame()).not.toContain("updating")

      // click-started force with a held response: updating appears ...
      clock.value += 2000
      respond = () =>
        new Promise((res) => {
          release = res
        })
      findPanelBox(panel)._mouseListeners.up({})
      await tick()
      await panel.flush()
      expect(fetchCalls).toBe(2)
      expect(panel.captureCharFrame()).toContain("updating")

      // ... and clears once the click-started fetch lands
      release!(stubOk())
      await tick()
      await panel.flush()
      expect(panel.captureCharFrame()).not.toContain("updating")
    })
  })
})

// ---------------------------------------------------------------------------
// Tester audit addenda (zai-quota-grid-align): appended only, no source
// files touched. Closes the inner-box padding mutation gap: the existing
// padding test inspects the mouse-listener container only.
// ---------------------------------------------------------------------------
describe("tester audit addenda (zai-quota-grid-align)", () => {
  test("panel content box (inner, rebuilt per effect) also carries no horizontal padding", async () => {
    const f = fakeApi()
    await createTuiPlugin(f.api, OPT, {})
    pendingDispose.push(() => f.handlers.get("__dispose")?.())
    await tick()

    const panel = await renderSlot(f.slots[0].slots.sidebar_content)
    const container = findPanelBox(panel)
    const kids = container.getChildren()
    expect(kids.length).toBeGreaterThan(0)
    for (const kid of kids) {
      if (kid.yogaNode == null) continue // text leaves carry no box geometry
      // paddingLeft 1 on the rebuilt content box shifts the 38-col grid by
      // one column; the container-level test cannot see it, this one can.
      expect(kid.yogaNode.getComputedPadding(0)).toBe(0)
      expect(kid.yogaNode.getComputedPadding(2)).toBe(0)
    }
  })
})
