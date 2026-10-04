/** @jsxImportSource @opentui/solid */
/**
 * Wiring layer for the redesigned (V2) surfaces: pulls quota on a timer +
 * session events, keeps usage histories, and renders the sidebar panel /
 * status chip from the pure V2 modules (model.ts -> render.ts). All I/O
 * (env, fs, fetch, theme, TUI api) stays at this edge.
 *
 * Rendering note: under Bun the loaded @opentui/solid bundle pairs with the
 * SSR solid build, whose reconciler never re-runs reactive children. The
 * slot renderers therefore drive re-renders themselves: a render effect
 * (real solid instance) rebuilds the content box and swaps it into a stable
 * container via Renderable add/remove. In a reactive host the same code is
 * simply driven by the identical signal/effect instance.
 */
import { createSignal, createRenderEffect } from "solid-js/dist/solid.js"
import { getOwner, runWithOwner } from "solid-js"
import { readFileSync } from "node:fs"
import { homedir } from "node:os"
import { TextAttributes } from "@opentui/core"
import type { JSX } from "@opentui/solid"
import { resolveConfig } from "./config"
import { resolveToken } from "./token"
import { fetchQuota, parseQuota, type QuotaRow } from "./api"
import { computeRunway, pushSample, type Sample } from "./runway"
import { buildPanel, buildChip, type ModelInput, type PanelModel } from "./model"
import { renderPanelLines, renderChipSegments, type Segment } from "./render"
import { THEME_KEY } from "./roles"
import { sanitize } from "./format"

/** Adapt global fetch to fetchQuota's { status, text } contract. */
async function fetchAdapter(
  url: string,
  init: { headers: Record<string, string>; signal: AbortSignal },
): Promise<{ status: number; text: string }> {
  const response = await fetch(url, init)
  return { status: response.status, text: await response.text() }
}

export async function createTuiPlugin(
  api: any,
  options: unknown,
  _meta: unknown,
): Promise<void> {
  // Config is resolved once; warnings surface as a single toast.
  const { config, warnings } = resolveConfig(process.env, options as any)
  if (warnings.length > 0) {
    api.ui.toast({
      variant: "warning",
      title: "Z.AI quota config",
      message: warnings.join("; ").slice(0, 300),
      duration: 4000,
    })
  }

  // Signals feed the render tree; histories are plain non-reactive state.
  const [rows, setRows] = createSignal<QuotaRow[]>([])
  const [error, setError] = createSignal<string | null>(null)
  const [updatedAt, setUpdatedAt] = createSignal<number | null>(null)
  // Stamped at every refresh completion (success OR failure): drives the
  // staleness marker while in an error state, where updatedAt (last success)
  // would either lag behind fresh attempts or never be set at all.
  const [lastAttemptAt, setLastAttemptAt] = createSignal<number | null>(null)
  const [level, setLevel] = createSignal<string | null>(null)
  // True while a fetch is actually in flight (set when it starts, cleared in
  // the finally) — skipped/joined scheduleRefresh calls never flip it.
  const [updating, setUpdating] = createSignal(false)
  // 10s heartbeat: slot renderers subscribe so freshness text and reset
  // markers advance between refreshes without refetching.
  const [tick, setTick] = createSignal(0)
  const histories = new Map<string, Sample[]>()
  const prevResetAt = new Map<string, number | null>()
  const theme = (): Record<string, string> => api.theme.current

  // Refresh engine: in-flight dedupe + idle throttle (design D5) + a 1s
  // cooldown on click-forced refresh starts (anti double-fetch for clicks;
  // engine forces — timer/session/command — are exempt, and a click is never
  // cooled down while data is missing: rows absent or an error state means a
  // fetch is required for correctness).
  let inFlight: Promise<void> | null = null
  let lastFetchStartedAt = 0
  let lastForceStartedAt = 0

  async function doRefresh(): Promise<void> {
    try {
      let token: string | undefined
      try {
        token = resolveToken((path) => readFileSync(path, "utf8"), homedir(), process.env, config)
      } catch {
        token = undefined
      }
      if (!token) {
        setError("no-token")
        return
      }
      const result = await fetchQuota(fetchAdapter, token, config)
      if (!result.ok) {
        setError(result.error)
        return
      }
      const parsed = parseQuota(result.payload)
      const now = Date.now()
      setRows(parsed.rows)
      setLevel(parsed.level)
      setUpdatedAt(now)
      // Empty-but-valid response is the designed "empty" taxonomy state, not a
      // fetch failure: surface it instead of leaving the panel on "loading…".
      setError(parsed.rows.length === 0 ? "empty" : null)
      for (const row of parsed.rows) {
        if (row.usage == null) continue
        const prev = prevResetAt.get(row.label)
        if (prev !== undefined && row.resetAt !== prev) {
          histories.set(row.label, []) // resetAt changed: window boundary
        }
        histories.set(
          row.label,
          pushSample(
            histories.get(row.label) ?? [],
            { t: now, usage: row.usage },
            prev ?? null,
            config.maxHistory,
          ),
        )
        prevResetAt.set(row.label, row.resetAt)
      }
      // Prune history keys whose labels vanished from this payload: a
      // misbehaving endpoint cycling label strings would grow the maps
      // without bound. Only a payload that actually yielded rows speaks for
      // the label universe — the designed "empty" state must not wipe history.
      if (parsed.rows.length > 0) {
        const live = new Set(parsed.rows.map((row) => row.label))
        for (const key of histories.keys()) {
          if (!live.has(key)) histories.delete(key)
        }
        for (const key of prevResetAt.keys()) {
          if (!live.has(key)) prevResetAt.delete(key)
        }
      }
    } finally {
      setLastAttemptAt(Date.now())
    }
  }

  function scheduleRefresh(force = false, source: "engine" | "click" = "engine"): Promise<void> {
    if (inFlight != null) return inFlight
    if (
      force &&
      source === "click" &&
      Date.now() - lastForceStartedAt < 1000 &&
      rows().length > 0 &&
      error() == null
    ) {
      return Promise.resolve()
    }
    if (!force && Date.now() - lastFetchStartedAt < config.intervalMs / 2) {
      return Promise.resolve()
    }
    lastFetchStartedAt = Date.now()
    if (force) lastForceStartedAt = Date.now()
    setUpdating(true)
    inFlight = (async () => {
      await doRefresh()
    })().finally(() => {
      inFlight = null
      setUpdating(false)
    })
    return inFlight
  }

  /** Shared ModelInput for both slots. Reading tick() subscribes the caller. */
  function modelInput(): ModelInput {
    void tick()
    const now = Date.now()
    const currentRows = rows()
    const runways: ModelInput["runways"] = {}
    for (const row of currentRows) {
      const h = histories.get(row.label)
      runways[row.label] = {
        result: computeRunway(h ?? [], row, now),
        spanMs: h == null ? null : h.length >= 2 ? h[h.length - 1].t - h[0].t : h.length === 1 ? 0 : null,
      }
    }
    return {
      rows: currentRows,
      runways,
      level: level(),
      updatedAt: updatedAt(),
      lastAttemptAt: lastAttemptAt(),
      error: error(),
      updating: updating(),
      now,
      intervalMs: config.intervalMs,
      tightFactor: config.tightFactor,
      gaugeWidth: config.gaugeWidth,
      formatTime: (ms) => new Date(ms).toLocaleTimeString(),
    }
  }

  /**
   * detail:"auto" drops the second (detail) line of every window whose
   * verdict is "ok". renderPanelLines returns [header, win, detail] * N (or
   * [header, single-line] for error/loading, left untouched).
   */
  function applyDetailMode(lines: Segment[][], model: PanelModel): Segment[][] {
    if (config.detail !== "auto" || model.windows.length === 0) return lines
    if (lines.length !== 1 + 2 * model.windows.length) return lines
    const out: Segment[][] = [lines[0]]
    for (let i = 0; i < model.windows.length; i++) {
      out.push(lines[1 + 2 * i])
      if (model.windows[i].verdict !== "ok") out.push(lines[2 + 2 * i])
    }
    return out
  }

  function panelSegments(): Segment[][] {
    const model = buildPanel(modelInput())
    return applyDetailMode(
      renderPanelLines(model, { gaugeWidth: config.gaugeWidth, mode: config.glyphs, targetWidth: 40 }),
      model,
    )
  }

  function renderPanel(): JSX.Element {
    // Click-to-refresh: a drag (selection) must not be treated as a click;
    // the flag is reset on the mouseup that consumed the drag.
    let dragged = false
    const owner = getOwner()
    const container = (
      <box
        flexDirection="column"
        paddingLeft={1}
        paddingRight={1}
        onMouseDrag={() => {
          dragged = true
        }}
        onMouseUp={() => {
          if (dragged) {
            dragged = false
            return
          }
          void scheduleRefresh(true, "click").catch(() => {})
        }}
      />
    ) as any
    let content: any = null
    createRenderEffect(() => {
      const lines = panelSegments()
      const next = runWithOwner(owner, () => (
        <box flexDirection="column">
          {lines.map((line, lineIdx) => (
            <box flexDirection="row">
              {line
                .filter((seg) => seg.text !== "")
                .map((seg, segIdx) => (
                  <text
                    fg={theme()[THEME_KEY[seg.role]]}
                    attributes={lineIdx === 0 && segIdx === 0 ? TextAttributes.BOLD : 0}
                  >
                    {seg.text}
                  </text>
                ))}
            </box>
          ))}
        </box>
      )) as any
      if (content != null) {
        container.remove(content)
        const old = content
        queueMicrotask(() => old.destroyRecursively())
      }
      content = next
      container.add(next)
    })
    return container as JSX.Element
  }

  function renderChip(): JSX.Element {
    const owner = getOwner()
    const container = <box flexDirection="row" /> as any
    let content: any = null
    createRenderEffect(() => {
      const segs = renderChipSegments(buildChip(modelInput()), config.glyphs)
      const next = runWithOwner(owner, () => (
        <box flexDirection="row">
          {segs
            .filter((seg) => seg.text !== "")
            .map((seg) => (
              <text fg={theme()[THEME_KEY[seg.role]]}>{seg.text}</text>
            ))}
        </box>
      )) as any
      if (content != null) {
        container.remove(content)
        const old = content
        queueMicrotask(() => old.destroyRecursively())
      }
      content = next
      container.add(next)
    })
    return container as JSX.Element
  }

  // Fire-and-forget refreshes carry their own rejection sink: a failure in
  // the refresh pipeline must not surface as an unhandled rejection. The
  // awaited run() path below is exempt — it toasts the error instead.
  scheduleRefresh(true).catch(() => {})
  const timer = setInterval(() => scheduleRefresh().catch(() => {}), config.intervalMs)
  const tickTimer = setInterval(() => setTick((t) => t + 1), 10_000)
  const offIdle = api.event.on("session.idle", () => scheduleRefresh(false).catch(() => {}))
  const offErr = api.event.on("session.error", () => scheduleRefresh(true).catch(() => {}))

  // No UI surface enabled -> no register call at all (an empty slots object
  // would be dead wiring). Polling and the /zai-quota command stay live.
  const disposeSlots =
    config.panel || config.chip
      ? api.slots.register({
          order: 100,
          slots: {
            ...(config.panel ? { sidebar_content: renderPanel } : {}),
            ...(config.chip ? { session_prompt_right: renderChip } : {}),
          },
        })
      : null

  const disposeLayer = api.keymap.registerLayer({
    commands: [
      {
        name: "zai-quota.refresh",
        title: "Z.AI quota: refresh now",
        desc: "Fetch current zai-coding-plan usage from the Z.AI API",
        slashName: "zai-quota",
        slashAliases: ["zq"],
        namespace: "palette",
        run: async () => {
          await scheduleRefresh(true)
          const current = rows()
          api.ui.toast({
            variant: error() != null ? "error" : "success",
            title: "Z.AI quota",
            message:
              error() ??
              current
                .map((x) => `${sanitize(x.label)}: ${x.usage ?? "?"}/${x.limit ?? "?"}`)
                .join(" | ")
                .slice(0, 300),
            duration: 4000,
          })
        },
      },
    ],
    bindings: [],
  })

  api.lifecycle.onDispose(() => {
    clearInterval(timer)
    clearInterval(tickTimer)
    offIdle()
    offErr()
    disposeLayer?.()
    disposeSlots?.()
  })
}
