/**
 * Pure render model for the ZAI quota panel: roles, block gauges,
 * status-line chip segments, and the panel view model.
 * No I/O, no theme dependency — consumers map `Role` to theme tokens.
 */

import type { QuotaRow } from "./api";
import type { RunwayResult } from "./runway";
import { fmtCount, fmtDuration, sanitize } from "./format";
import type { Role, SegmentRole } from "./roles";
import type { ChipModel, PanelModel as V2PanelModel, WindowModel } from "./model";
import type { Verdict } from "./status";

/**
 * Sanitize moved to ./format (pure string util home) so the V2 view-model
 * (model.ts) can share it without an import cycle; re-exported here because
 * legacy consumers (tui.tsx, tests) import it from this module.
 */
export { sanitize } from "./format";

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

// ---------------------------------------------------------------------------
// V2 renderer (redesign W2). Pure functions over the W1 view-model
// (src/model.ts) producing Segment[] — text plus exactly one of the five
// universal SegmentRole tokens. Legacy exports above stay untouched until
// W3 retires tui.tsx.
// ---------------------------------------------------------------------------

/** One styled run of text; role is always one of the five V2 tokens. */
export type Segment = { text: string; role: SegmentRole };

/** Glyph vocabulary: full unicode blocks or portable ascii. */
export type GlyphMode = "unicode" | "ascii";

/** Per-verdict glyph appended to window lines and chips. */
export const VERDICT_GLYPH: Record<GlyphMode, Record<Verdict | "error", string>> = {
  unicode: { ok: "✓", tight: "!", short: "!!", blocked: "✗", unknown: "?", error: "?" },
  ascii: { ok: "ok", tight: "!", short: "!!", blocked: "xx", unknown: "?", error: "?" },
};

/**
 * Bar/percent/glyph coloring follows the verdict, not the raw percent.
 * Note the no-burn ("runway ∞" -> ok -> success) and unknown ("runway …"
 * -> textMuted) cases fall out of this map without text matching.
 */
export const VERDICT_ROLE: Record<Verdict, SegmentRole> = {
  ok: "success",
  tight: "warning",
  short: "error",
  blocked: "error",
  unknown: "textMuted",
};

const roleForVerdict = (v: Verdict | "error"): SegmentRole => (v === "error" ? "error" : VERDICT_ROLE[v]);

/**
 * Ascii-mode substitution for the unicode literals the model emits and the
 * render literals carry ("∞" runway, "…" ellipsis, "·" separators, "—"
 * no-timestamp dash): in ascii mode every emitted segment must be 7-bit
 * ASCII. Applied render-side only — model outputs stay unicode.
 */
const asciify = (s: string): string =>
  s.replace(/∞/g, "inf").replace(/…/g, "...").replace(/·/g, "-").replace(/—/g, "-");

/** Identity in unicode mode, asciify in ascii mode — for model-sourced texts and shared literals. */
const textFor = (mode: GlyphMode, s: string): string => (mode === "ascii" ? asciify(s) : s);

/**
 * One-line bar of exactly `width` cells. Unicode: fractional fill renders a
 * partial block; ascii: floor-only "#" fill, "-" empty, no partials.
 * Marker contract differs by mode: unicode returns `markerCell` as a
 * passthrough (the caller splits `cells` around it); ascii embeds "|"
 * directly at the index (single-segment bars). In both modes
 * `cells.length === width`; a non-finite fill (NaN, ±Infinity) is
 * treated like null (all-empty cells).
 */
export function barCells(
  fillPercent: number | null,
  markerIndex: number | null,
  width: number,
  mode: GlyphMode,
): { cells: string; markerCell: number | null } {
  const markerCell = markerIndex;
  const inBounds = markerIndex != null && markerIndex >= 0 && markerIndex < width;
  if (mode === "ascii") {
    if (fillPercent == null || !Number.isFinite(fillPercent)) {
      // Null/non-finite fill embeds the marker too, mirroring the finite
      // path: an empty ascii bar must not silently drop the reset marker.
      let cells = "-".repeat(width);
      if (inBounds) cells = cells.slice(0, markerIndex!) + "|" + cells.slice(markerIndex! + 1);
      return { cells, markerCell };
    }
    const pct = Math.min(100, Math.max(0, fillPercent));
    const full = Math.floor((width * pct) / 100);
    let cells = "#".repeat(full) + "-".repeat(width - full);
    if (inBounds) cells = cells.slice(0, markerIndex!) + "|" + cells.slice(markerIndex! + 1);
    return { cells, markerCell };
  }
  if (fillPercent == null || !Number.isFinite(fillPercent)) return { cells: "░".repeat(width), markerCell };
  const pct = Math.min(100, Math.max(0, fillPercent));
  const cellsFloat = (width * pct) / 100;
  const full = Math.floor(cellsFloat);
  const frac = cellsFloat - full;
  const partialIdx = frac > 0 ? Math.min(7, Math.max(1, Math.round(frac * 8))) : 0;
  const cells =
    "█".repeat(full) + PARTIALS[partialIdx] + "░".repeat(width - full - (partialIdx > 0 ? 1 : 0));
  return { cells, markerCell };
}

/**
 * Window line: label, verdict-colored bar (unicode marker "|" glyph drawn as
 * its own text-colored segment), percent, usage/limit, verdict glyph last.
 * `dropUsage` (used by the width-degradation ladder) omits " usage/limit".
 */
export function renderWindowLine(
  w: WindowModel,
  width: number,
  mode: GlyphMode,
  opts: { dropUsage?: boolean } = {},
): Segment[] {
  const barRole = VERDICT_ROLE[w.verdict];
  const { cells, markerCell } = barCells(w.fillPercent, w.markerIndex, width, mode);
  const markerInBar = mode === "unicode" && markerCell != null && markerCell >= 0 && markerCell < cells.length;
  const bar: Segment[] = markerInBar
    ? [
        { text: cells.slice(0, markerCell!), role: barRole },
        { text: "│", role: "text" },
        { text: cells.slice(markerCell! + 1), role: barRole },
      ]
    : [{ text: cells, role: barRole }];
  const segs: Segment[] = [{ text: w.label + "  ", role: "textMuted" }, ...bar, { text: " " + w.percentText, role: "text" }];
  if (!opts.dropUsage) segs.push({ text: " " + w.usageText + "/" + w.limitText, role: "textMuted" });
  segs.push({ text: " " + VERDICT_GLYPH[mode][w.verdict], role: barRole });
  return segs;
}

/**
 * Second line (5-space indent): reset, runway (colored by verdict), optional
 * shortfall / back-at annotations. `drop*` options are the degradation
 * ladder rungs; when reset is dropped the indent moves onto the runway
 * segment (no dangling " · " leader). In ascii mode model-sourced texts and
 * the " · " separators are asciified (7-bit only).
 */
export function renderDetailLine(
  w: WindowModel,
  mode: GlyphMode,
  opts: { dropBack?: boolean; dropReset?: boolean; dropShortfall?: boolean } = {},
): Segment[] {
  const segs: Segment[] = [];
  if (!opts.dropReset) segs.push({ text: "     " + textFor(mode, w.resetText), role: "textMuted" });
  segs.push({
    text: (segs.length > 0 ? textFor(mode, " · ") : "     ") + textFor(mode, w.runwayText),
    role: VERDICT_ROLE[w.verdict],
  });
  if (!opts.dropShortfall && w.shortfallText != null) {
    segs.push({ text: "  " + textFor(mode, w.shortfallText), role: "textMuted" });
  }
  if (!opts.dropBack && w.backText != null) {
    segs.push({ text: textFor(mode, " · ") + textFor(mode, w.backText), role: "textMuted" });
  }
  return segs;
}

/**
 * Header line: title, optional level ("  " prefix), freshness. While
 * updating, freshness is replaced by a warning " updating…" segment; a
 * stale freshness also gets the warning role. In ascii mode the level,
 * freshness and updating literals are asciified (7-bit only).
 */
export function renderHeader(header: V2PanelModel["header"], mode: GlyphMode): Segment[] {
  const segs: Segment[] = [{ text: header.title, role: "text" }];
  if (header.level != null) segs.push({ text: "  " + textFor(mode, header.level), role: "textMuted" });
  segs.push(
    header.updating
      ? { text: textFor(mode, " updating…"), role: "warning" }
      : { text: " " + textFor(mode, header.freshness), role: header.stale ? "warning" : "textMuted" },
  );
  return segs;
}

/** Error taxonomy code -> human text (local copy of tui.tsx errorText; tui is legacy-frozen until W3). */
const ERROR_TEXT: Record<string, string> = {
  "no-token": "no token (login via zai or set ZAI_TOKEN)",
  network: "network error",
  "bad-json": "bad response",
  timeout: "timeout",
  empty: "no data",
};

const errorText = (code: string): string =>
  code.startsWith("http-") ? "HTTP " + code.slice("http-".length) : (ERROR_TEXT[code] ?? code);

const lineWidth = (segs: readonly Segment[]): number => segs.reduce((n, s) => n + s.text.length, 0);

/**
 * Full panel as lines of segments. Error (no rows): header + one error line.
 * Loading (no rows, no error): header + one muted line. Otherwise header +
 * [windowLine, detailLine] per window — the detail line is always shown.
 * Width degradation (targetWidth, default 40): window lines drop the
 * usage/limit segment first; detail lines drop backText, then resetText,
 * then shortfall (runway is never dropped).
 */
export function renderPanelLines(
  model: V2PanelModel,
  opts: { gaugeWidth: number; mode: GlyphMode; targetWidth?: number },
): Segment[][] {
  const targetWidth = opts.targetWidth ?? 40;
  const header = renderHeader(model.header, opts.mode);
  if (model.error != null) {
    return [header, [{ text: errorText(model.error), role: "error" }]];
  }
  if (model.windows.length === 0) {
    return [header, [{ text: textFor(opts.mode, "loading…"), role: "textMuted" }]];
  }
  const lines: Segment[][] = [header];
  for (const w of model.windows) {
    let win = renderWindowLine(w, opts.gaugeWidth, opts.mode);
    if (lineWidth(win) > targetWidth) {
      win = renderWindowLine(w, opts.gaugeWidth, opts.mode, { dropUsage: true });
    }
    let detail = renderDetailLine(w, opts.mode);
    if (lineWidth(detail) > targetWidth) detail = renderDetailLine(w, opts.mode, { dropBack: true });
    if (lineWidth(detail) > targetWidth) detail = renderDetailLine(w, opts.mode, { dropBack: true, dropReset: true });
    if (lineWidth(detail) > targetWidth) {
      detail = renderDetailLine(w, opts.mode, { dropBack: true, dropReset: true, dropShortfall: true });
    }
    lines.push(win, detail);
  }
  return lines;
}

/**
 * Status-line chip: " zai v0·v1 <glyph>" with the glyph colored by verdict.
 * Error chip collapses to a single muted " zai:? "; empty values with a
 * non-error verdict (loading) render a muted " zai …". In ascii mode the
 * separator, values and loading literal are asciified (7-bit only).
 */
export function renderChipSegments(chip: ChipModel, mode: GlyphMode): Segment[] {
  if (chip.values.length === 0 && chip.verdict === "error") {
    return [{ text: " zai:? ", role: "textMuted" }];
  }
  if (chip.values.length === 0) {
    return [{ text: textFor(mode, " zai …"), role: "textMuted" }];
  }
  return [
    { text: " zai ", role: "textMuted" },
    { text: textFor(mode, chip.values[0] ?? "?"), role: "text" },
    { text: textFor(mode, "·"), role: "textMuted" },
    { text: textFor(mode, chip.values[1] ?? "?"), role: "text" },
    { text: " " + VERDICT_GLYPH[mode][chip.verdict], role: roleForVerdict(chip.verdict) },
  ];
}
