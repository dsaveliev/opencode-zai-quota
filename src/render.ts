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

/**
 * Fixed panel geometry: every line targets exactly 38 columns.
 *   label   cols 0-2   (padEnd 3) + gap col 3
 *   bar     cols 4-19  (16 cells, GRID.barWidth)
 *   pct     cols 21-24 (padStart 4) + gap col 20
 *   usage   cols 26-34 (padStart 9) + gap col 25
 *   verdict cols 36-37 (padStart 2) + gap col 35
 * The gaps live as leading spaces on each field segment, so dropping the
 * usage segment removes its gap too (38 -> 28).
 */
export const GRID = {
  width: 38,
  label: 0,
  bar: 4,
  barWidth: 16,
  pct: 21,
  pctWidth: 4,
  usage: 26,
  usageWidth: 9,
  verdict: 36,
  verdictWidth: 2,
  detail: { runway: 15 },
} as const;

// ---------------------------------------------------------------------------
// V2 renderer. Pure functions over the W1 view-model (src/model.ts)
// producing Segment[] — text plus exactly one of the five universal
// SegmentRole tokens.
// ---------------------------------------------------------------------------

/** One styled run of text; role is always one of the five V2 tokens. */
export type Segment = { text: string; role: SegmentRole; bold?: boolean };

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
 * Window line assembled onto the fixed GRID columns (38 wide at the default
 * bar width 16): label+gap prefix (one muted segment, cols 0-3), verdict-
 * colored 16-cell bar (unicode marker "|" drawn as its own text-colored
 * segment), padStart(4) percent, padStart(9) usage/limit pair, padStart(2)
 * verdict glyph. The usage pair is OMITTED (together with its gap) when it
 * exceeds GRID.usageWidth — the only width rung; percent and verdict are
 * never dropped (the grid holds them). `dropUsage` is the explicit
 * compatibility rung on top of the automatic >9 rule.
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
  const segs: Segment[] = [
    { text: w.label.slice(0, 3).padEnd(3) + " ", role: "textMuted" },
    ...bar,
    { text: " " + w.percentText.padStart(GRID.pctWidth), role: "text" },
  ];
  const usagePair = `${w.usageText}/${w.limitText}`;
  if (!opts.dropUsage && usagePair.length <= GRID.usageWidth) {
    segs.push({ text: " " + usagePair.padStart(GRID.usageWidth), role: "textMuted" });
  }
  segs.push({ text: " " + VERDICT_GLYPH[mode][w.verdict].padStart(GRID.verdictWidth), role: barRole });
  return segs;
}

/**
 * Second line: `reset · runway [· back][  shortfall]` (current composition,
 * no indent) auto-fitted to GRID.width by a fixed ladder: drop backText,
 * then shortfall, then reset — the runway-only line is the floor and never
 * loses its verdict role. In ascii mode model-sourced texts and the " · "
 * separators are asciified (7-bit only).
 */
export function renderDetailLine(w: WindowModel, mode: GlyphMode): Segment[] {
  const runwayRole = VERDICT_ROLE[w.verdict];
  const reset = textFor(mode, w.resetText);
  const runway = textFor(mode, w.runwayText);
  const sep = textFor(mode, " · ");
  const variant = (k: { reset: boolean; back: boolean; shortfall: boolean }): Segment[] => {
    const segs: Segment[] = [];
    // Fixed grid: reset occupies cols 0..14 (padEnd), the runway block starts
    // exactly at GRID.detail.runway so 5h/7d rows align vertically in every rung.
    if (k.reset) segs.push({ text: reset.padEnd(GRID.detail.runway), role: "textMuted" });
    else segs.push({ text: " ".repeat(GRID.detail.runway), role: "textMuted" });
    segs.push({ text: runway, role: runwayRole });
    if (k.back && w.backText != null) segs.push({ text: sep + textFor(mode, w.backText), role: "textMuted" });
    if (k.shortfall && w.shortfallText != null) {
      segs.push({ text: "  " + textFor(mode, w.shortfallText), role: "textMuted" });
    }
    return segs;
  };
  let segs = variant({ reset: true, back: true, shortfall: true });
  if (lineWidth(segs) > GRID.width) segs = variant({ reset: true, back: false, shortfall: true });
  if (lineWidth(segs) > GRID.width) segs = variant({ reset: true, back: false, shortfall: false });
  if (lineWidth(segs) > GRID.width) segs = variant({ reset: false, back: false, shortfall: false });
  return segs;
}

/** Freshness prefix the header ladder may strip at rung 2 (age text survives). */
const STALE_PREFIX = "stale · ";

/**
 * Header line, right-aligned onto the grid: `title ... suffix` where suffix
 * = [level, freshness] joined " · " (freshness becomes the literal
 * "updating ..." — 3-dot in both modes — while updating). Ladder when
 * title + 1 gap + suffix overflows targetWidth: drop the level, then the
 * leading "stale · " of the freshness; title and age are never dropped and
 * at least one gap column always survives. Two segments: padded title
 * (text) and suffix (warning while stale/updating, else textMuted).
 */
export function renderHeader(
  header: V2PanelModel["header"],
  mode: GlyphMode,
  targetWidth: number = GRID.width,
): Segment[] {
  const title = header.title;
  const sep = textFor(mode, " · ");
  const age = textFor(mode, header.freshness);
  const tail = header.updating ? "updating ..." : age;
  const level = header.level != null ? textFor(mode, header.level) : null;
  const fits = (suffix: string): boolean => title.length + 1 + suffix.length <= targetWidth;
  let suffix = level != null ? level + sep + tail : tail;
  if (!fits(suffix) && level != null) suffix = tail;
  if (!fits(suffix) && header.freshness.startsWith(STALE_PREFIX)) {
    suffix = textFor(mode, header.freshness.slice(STALE_PREFIX.length));
  }
  // Hard floor: even after both rungs a pathological suffix must never push
  // the line past targetWidth (title+age are never dropped, so truncate here).
  const suffixBudget = targetWidth - title.length - 1;
  if (suffix.length > suffixBudget) suffix = suffix.slice(0, suffixBudget);
  const pad = Math.max(targetWidth - suffix.length, title.length + 1);
  const role: SegmentRole = header.updating || header.stale ? "warning" : "textMuted";
  const segs: Segment[] = [{ text: title.padEnd(pad), role: "text" }];
  // Split the suffix so the plan level can render bold while the joined
  // line stays byte-identical to the single-segment form.
  if (level != null && tail.length > 0 && suffix === level + sep + tail) {
    segs.push({ text: level, role, bold: true });
    segs.push({ text: sep + tail, role });
  } else {
    segs.push({ text: suffix, role });
  }
  return segs;
}

/** Error taxonomy code -> human text (render owns the presentation; each fits the 38-col grid). */
const ERROR_TEXT: Record<string, string> = {
  "no-token": "no token (zai login or ZAI_TOKEN)",
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
 * Grid semantics: header and detail lines are fitted to GRID.width by their
 * own renderers; the window line's only degradation rung is the usage drop
 * (percent/verdict never leave — the grid holds them). A custom
 * targetWidth < GRID.width re-applies that single rung when the grid line
 * still exceeds the target; a targetWidth >= GRID.width changes nothing.
 */
export function renderPanelLines(
  model: V2PanelModel,
  opts: { gaugeWidth: number; mode: GlyphMode; targetWidth?: number },
): Segment[][] {
  const targetWidth = opts.targetWidth ?? GRID.width;
  const header = renderHeader(model.header, opts.mode, GRID.width);
  if (model.error != null) {
    return [header, [{ text: errorText(model.error), role: "error" }]];
  }
  if (model.windows.length === 0) {
    return [header, [{ text: textFor(opts.mode, "loading…"), role: "textMuted" }]];
  }
  const lines: Segment[][] = [header];
  for (const w of model.windows) {
    let win = renderWindowLine(w, opts.gaugeWidth, opts.mode);
    if (targetWidth < GRID.width && lineWidth(win) > targetWidth) {
      win = renderWindowLine(w, opts.gaugeWidth, opts.mode, { dropUsage: true });
    }
    lines.push(win, renderDetailLine(w, opts.mode));
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
