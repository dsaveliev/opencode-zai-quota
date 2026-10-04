/**
 * Pure V2 render layer for the ZAI quota surfaces: block bars, window /
 * detail / header lines and the status chip, all as Segment[] over the W1
 * view-model (src/model.ts). No I/O, no theme dependency — consumers map
 * `SegmentRole` to theme tokens via roles.THEME_KEY.
 */

import type { ChipModel, PanelModel as V2PanelModel, WindowModel } from "./model";
import type { SegmentRole } from "./roles";
import type { Verdict } from "./status";

const PARTIALS = ["", "▏", "▎", "▍", "▌", "▋", "▊", "▉"] as const;

// ---------------------------------------------------------------------------
// V2 renderer. Pure functions over the W1 view-model (src/model.ts)
// producing Segment[] — text plus exactly one of the five universal
// SegmentRole tokens.
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

/** Error taxonomy code -> human text (render owns the presentation). */
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
