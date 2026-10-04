/** @jsxImportSource @opentui/solid */
import { createSignal } from "solid-js"
import { readFileSync } from "node:fs"
import { homedir } from "node:os"
import { TextAttributes } from "@opentui/core"
import type { JSX } from "@opentui/solid"
import { resolveConfig } from "./config"
import { resolveToken } from "./token"
import { fetchQuota, parseQuota, type QuotaRow } from "./api"
import { computeRunway, pushSample, type RunwayResult, type Sample } from "./runway"
import { chipSegments, panelModel, sanitize } from "./render"
import { ROLE_THEME_KEY } from "./roles"

const ERROR_TEXT: Record<string, string> = {
  "no-token": "no token (login via zai or set ZAI_TOKEN)",
  network: "network error",
  "bad-json": "bad response",
  timeout: "timeout",
  empty: "no data",
}

function errorText(code: string): string {
  if (code.startsWith("http-")) return "HTTP " + code.slice("http-".length)
  return ERROR_TEXT[code] ?? code
}

/** Adapt global fetch to fetchQuota's { status, text } contract. */
async function fetchAdapter(
  url: string,
  init: { headers: Record<string, string>; signal: AbortSignal },
): Promise<{ status: number; text: string }> {
  const response = await fetch(url, init)
  return { status: response.status, text: await response.text() }
}

/**
 * Wiring layer: pulls quota on a timer + session events, keeps usage
 * histories, and renders the sidebar panel / status chip via the pure
 * modules. All I/O (env, fs, fetch, theme, TUI api) stays at this edge.
 */
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
  const histories = new Map<string, Sample[]>()
  const prevResetAt = new Map<string, number | null>()
  const theme = (): Record<string, string> => api.theme.current

  // Refresh engine: in-flight dedupe + idle throttle (design D5).
  let inFlight: Promise<void> | null = null
  let lastFetchStartedAt = 0

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

  function scheduleRefresh(force = false): Promise<void> {
    if (inFlight != null) return inFlight
    if (!force && Date.now() - lastFetchStartedAt < config.intervalMs / 2) {
      return Promise.resolve()
    }
    lastFetchStartedAt = Date.now()
    inFlight = (async () => {
      await doRefresh()
    })().finally(() => {
      inFlight = null
    })
    return inFlight
  }

  // Fire-and-forget refreshes carry their own rejection sink: a failure in
  // the refresh pipeline must not surface as an unhandled rejection. The
  // awaited run() path below is exempt — it toasts the error instead.
  scheduleRefresh(true).catch(() => {})
  const timer = setInterval(() => scheduleRefresh().catch(() => {}), config.intervalMs)
  const offIdle = api.event.on("session.idle", () => scheduleRefresh(false).catch(() => {}))
  const offErr = api.event.on("session.error", () => scheduleRefresh(true).catch(() => {}))

  function renderPanel(): JSX.Element {
    const now = Date.now()
    const currentRows = rows()
    const runways: Record<string, RunwayResult> = {}
    for (const row of currentRows) {
      runways[row.label] = computeRunway(histories.get(row.label) ?? [], row, now)
    }
    const t = theme()
    const err = error()
    const model = panelModel(
      {
        rows: currentRows,
        runways,
        level: level(),
        // Error state: the header clock tracks the last ATTEMPT, so repeated
        // fresh failures stay un-stale and only a genuinely silent panel
        // ages out. Normal state: the last successful refresh, as before.
        updatedAt: err != null ? lastAttemptAt() : updatedAt(),
        now,
        intervalMs: config.intervalMs,
        showRunway: config.showRunway,
        formatTime: (ms) => new Date(ms).toLocaleTimeString(),
      },
      {
        warnThreshold: config.warnThreshold * 100,
        critThreshold: config.critThreshold * 100,
        gaugeWidth: config.gaugeWidth,
      },
    )
    return (
      <box
        flexDirection="column"
        border={true}
        borderStyle="rounded"
        borderColor={t.border}
        paddingLeft={1}
        paddingRight={1}
      >
        <box flexDirection="row" justifyContent="space-between">
          <text fg={t[ROLE_THEME_KEY.accent]} attributes={TextAttributes.BOLD}>
            {model.header.title}
          </text>
          {model.header.level != null ? (
            <text fg={t[ROLE_THEME_KEY.muted]}>{model.header.level}</text>
          ) : null}
          <text fg={model.header.stale ? t[ROLE_THEME_KEY.warn] : t[ROLE_THEME_KEY.muted]}>
            {model.header.updatedAt}
            {model.header.stale ? " stale" : null}
          </text>
        </box>
        {err != null ? (
          <text fg={t[ROLE_THEME_KEY.crit]}>{errorText(err)}</text>
        ) : model.rowLines.length === 0 ? (
          <text fg={t[ROLE_THEME_KEY.muted]}>loading…</text>
        ) : (
          model.rowLines.map((line) => (
            <box flexDirection="column">
              <box flexDirection="row">
                <text fg={t[ROLE_THEME_KEY.muted]}>{line.label.padEnd(4)}</text>
                <text fg={t[ROLE_THEME_KEY[line.gaugeRole]]}>{line.gaugeCells}</text>
                <text>{line.percentText}</text>
                <text fg={t[ROLE_THEME_KEY.muted]}>
                  {line.usageText}/{line.limitText}
                </text>
              </box>
              <text fg={t[ROLE_THEME_KEY[line.runwayRole]]}>
                {line.resetText}
                {line.runwayText != null ? " · " + line.runwayText : null}
              </text>
            </box>
          ))
        )}
      </box>
    )
  }

  function renderChip(): JSX.Element {
    const segs = chipSegments(
      { rows: rows(), error: error() },
      {
        warnThreshold: config.warnThreshold * 100,
        critThreshold: config.critThreshold * 100,
      },
    )
    // NB: a <text> cannot nest renderable children in opentui, so the
    // per-segment colors live in sibling <text> elements inside a row box.
    return (
      <box flexDirection="row">
        {segs.map((seg) => (
          <text fg={theme()[ROLE_THEME_KEY[seg.role]]}>{seg.text}</text>
        ))}
      </box>
    )
  }

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
    offIdle()
    offErr()
    disposeLayer?.()
    disposeSlots?.()
  })
}
