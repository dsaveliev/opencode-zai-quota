/**
 * Pure render model for the ZAI quota panel: roles, block gauges,
 * status-line chip segments, and the panel view model.
 * No I/O, no theme dependency — consumers map `Role` to theme tokens.
 */

import type { QuotaRow } from "./api";
import type { RunwayResult } from "./runway";
import { fmtCount, fmtDuration } from "./format";
import type { Role } from "./roles";

/** Default thresholds used where the gauge API takes no explicit cfg. */
const DEFAULT_CFG = { warnThreshold: 70, critThreshold: 90 };

/** Map a percentage to a semantic role. null percent means "no data" -> muted. */
export function colorRole(
  percent: number | null,
  cfg: { warnThreshold: number; critThreshold: number },
): Role {
  if (percent == null) return "muted";
  if (percent >= cfg.critThreshold) return "crit";
  if (percent >= cfg.warnThreshold) return "warn";
  return "ok";
}

const PARTIALS = ["", "▏", "▎", "▍", "▌", "▋", "▊", "▉"] as const;

/**
 * Sanitize a server-controlled string for display: whole ANSI escape
 * sequences (CSI color, OSC title) are removed first — stripping only the
 * ESC byte would leave their parameter bodies ("[31m") printable — then any
 * remaining C0/C1 control characters, zero-width/bidi characters, and a
 * 24-char length cap. Exported so the wiring layer can reuse it for toast
 * messages built outside the render model.
 */
export const sanitize = (s: string): string =>
  s
    .replace(/\u001b\[[0-9;?]*[ -/]*[@-~]/g, "")
    .replace(/\u001b\][^\u0007]*\u0007/g, "")
    .replace(/[\u0000-\u001f\u007f-\u009f]/g, "")
    .replace(/[\u200b-\u200f\u202a-\u202e\ufeff]/g, "")
    .slice(0, 24);

/**
 * Build a one-line block gauge of exactly `width` cells.
 * Fractional fill renders as a partial block; percent is clamped to [0, 100]
 * (the clamped value also drives the role, so 150 behaves like 100).
 */
export function gauge(
  percent: number | null,
  width: number,
  cfg: { warnThreshold: number; critThreshold: number } = DEFAULT_CFG,
): { cells: string; role: Role } {
  if (percent == null) {
    return { cells: "░".repeat(width), role: "muted" };
  }
  const clampedPct = Math.min(100, Math.max(0, percent));
  const cellsFloat = (width * clampedPct) / 100;
  const fullCells = Math.floor(cellsFloat);
  const frac = cellsFloat - fullCells;
  const partialIdx = frac > 0 ? Math.min(7, Math.max(1, Math.round(frac * 8))) : 0;
  const cells =
    "█".repeat(fullCells) +
    PARTIALS[partialIdx] +
    "░".repeat(width - fullCells - (partialIdx > 0 ? 1 : 0));
  return { cells, role: colorRole(clampedPct, cfg) };
}

export type ChipSegment = { text: string; role: Role };

/**
 * Status-line chip: " zai <5h>%·<wk>%". Rows are selected by label
 * (first match), never by array index. Any fetch error collapses the
 * whole chip into a single muted " zai:?" segment.
 */
export function chipSegments(
  input: { rows: QuotaRow[]; error: string | null },
  cfg: { warnThreshold: number; critThreshold: number },
): ChipSegment[] {
  if (input.error != null) {
    return [{ text: " zai:?", role: "muted" }];
  }
  const row5h = input.rows.find((r) => r.label === "5h") ?? null;
  const rowWk = input.rows.find((r) => r.label === "wk") ?? null;
  const pctText = (row: QuotaRow | null): string =>
    row == null || row.percent == null ? "?" : String(Math.round(row.percent));
  return [
    { text: " zai ", role: "muted" },
    { text: pctText(row5h), role: colorRole(row5h?.percent ?? null, cfg) },
    { text: "·", role: "muted" },
    { text: pctText(rowWk), role: colorRole(rowWk?.percent ?? null, cfg) },
  ];
}

export type PanelRowLine = {
  label: string;
  gaugeCells: string;
  gaugeRole: Role;
  percentText: string;
  usageText: string;
  limitText: string;
  resetText: string;
  runwayText: string | null;
  runwayRole: Role;
};

export type PanelModel = {
  header: { title: string; level: string | null; updatedAt: string; stale: boolean };
  rowLines: PanelRowLine[];
};

/**
 * View model for the full panel. Header carries title/level/updated-at and
 * a stale flag (age > 2 refresh intervals). Rows are ordered "5h", "wk",
 * then the rest in input order; duplicates of "5h"/"wk" beyond the first
 * are dropped (first-match-wins, consistent with chipSegments). Each line
 * pairs the gauge with formatted usage/limit/reset texts and an optional
 * runway annotation. Server-controlled strings (row labels, header level)
 * are sanitized at construction; null level stays null.
 */
export function panelModel(
  input: {
    rows: QuotaRow[];
    runways: Record<string, RunwayResult>;
    level: string | null;
    updatedAt: number | null;
    now: number;
    intervalMs: number;
    showRunway: boolean;
    formatTime: (ms: number) => string;
  },
  cfg: { warnThreshold: number; critThreshold: number; gaugeWidth: number },
): PanelModel {
  const header = {
    title: "ZAI RUNWAY",
    level: input.level == null ? null : sanitize(input.level),
    updatedAt: input.updatedAt == null ? "—" : input.formatTime(input.updatedAt),
    stale: input.updatedAt != null && input.now - input.updatedAt > 2 * input.intervalMs,
  };

  const row5h = input.rows.find((r) => r.label === "5h");
  const rowWk = input.rows.find((r) => r.label === "wk");
  const rest = input.rows.filter((r) => r.label !== "5h" && r.label !== "wk");
  const ordered = [
    ...(row5h != null ? [row5h] : []),
    ...(rowWk != null ? [rowWk] : []),
    ...rest,
  ];

  const rowLines: PanelRowLine[] = ordered.map((row) => {
    const g = gauge(row.percent, cfg.gaugeWidth, cfg);
    const state: RunwayResult["state"] = input.runways[row.label]?.state ?? "no-reset";
    const runwayMs = input.runways[row.label]?.runwayMs ?? null;

    const runwayRole: Role =
      state === "warn" ? "crit"
      : state === "ok" ? "ok"
      : state === "no-burn" ? "info"
      : "muted";

    let runwayText: string | null;
    if (!input.showRunway) {
      runwayText = null;
    } else if (state === "no-limit") {
      runwayText = "runway —";
    } else if (state === "no-reset") {
      runwayText = null;
    } else if (state === "no-data") {
      runwayText = "runway …";
    } else if (state === "no-burn") {
      runwayText = "runway ∞";
    } else {
      const base = "runway ~" + (runwayMs != null ? fmtDuration(runwayMs) : "?");
      runwayText = state === "warn" ? base + " !" : base;
    }

    return {
      label: sanitize(row.label),
      gaugeCells: g.cells,
      gaugeRole: g.role,
      percentText: row.percent == null ? "?" : Math.round(row.percent) + "%",
      usageText: row.usage == null ? "?" : fmtCount(row.usage),
      limitText: row.limit == null ? "?" : fmtCount(row.limit),
      resetText:
        row.resetAt == null
          ? "reset ?"
          : "reset " + fmtDuration(Math.max(0, row.resetAt - input.now)),
      runwayText,
      runwayRole,
    };
  });

  return { header, rowLines };
}
