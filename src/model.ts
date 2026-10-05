/**
 * Pure view-model layer: turns raw quota rows + runway results into the
 * panel/chip models the renderer consumes. No clock, no IO — every input,
 * including `now` and the time formatter, is injected via ModelInput.
 */
import type { QuotaRow } from "./api";
import { fmtApproxDuration, fmtBackAt, fmtCount, fmtDuration, sanitize } from "./format";
import { WINDOW_MS, elapsedMs, markerIndex } from "./marker";
import type { RunwayResult } from "./runway";
import { classifyWindow, worstVerdict } from "./status";
import type { RunwayState, Verdict } from "./status";

/** Re-export convenience for the glyph/render layer. */
export type GlyphVerdict = Verdict;

/**
 * QuotaRow as consumed here. `unit` is not on api.QuotaRow yet (later wave
 * adds it); rows may already carry it — missing unit simply means "marker
 * unknown", same as a unit absent from WINDOW_MS.
 */
export type ModelRow = QuotaRow & { unit?: number };

export type WindowModel = {
  /**
   * Display label, sanitized at construction (ANSI/control chars stripped,
   * 24-char cap). Ordering and runway lookups key on the RAW row label —
   * sanitization applies to the emitted field only.
   */
  label: string;
  /** row.percent passthrough (raw, may exceed 100 or be negative) — gauge-bar clamping is a render concern; text clamps via pctText. */
  fillPercent: number | null;
  /** Gauge cell index; null = no marker. */
  markerIndex: number | null;
  verdict: Verdict;
  percentText: string;
  usageText: string;
  limitText: string;
  resetText: string;
  runwayText: string;
  /** blocked windows only. */
  backText: string | null;
  /** short windows only. */
  shortfallText: string | null;
};

export type PanelModel = {
  header: { title: "Z.ai Runway"; level: string | null; freshness: string; stale: boolean; updating: boolean };
  /** Error taxonomy code; null when cached rows are shown (stale presentation). */
  error: string | null;
  windows: WindowModel[];
};

export type ChipModel = { values: string[]; verdict: Verdict | "error" };

export type ModelInput = {
  rows: ModelRow[];
  /** Keyed by row label. spanMs is a separate field today; a later wave moves it onto RunwayResult. */
  runways: Record<string, { result: RunwayResult; spanMs: number | null }>;
  level: string | null;
  /** Last successful refresh. */
  updatedAt: number | null;
  /** Last attempt (success or not) — freshness source in error state. */
  lastAttemptAt: number | null;
  error: string | null;
  updating: boolean;
  now: number;
  intervalMs: number;
  tightFactor: number;
  gaugeWidth: number;
  formatTime: (absMs: number) => string;
};

const NO_RUNWAY: { result: RunwayResult; spanMs: number | null } = {
  result: { state: "no-reset", runwayMs: null, resetInMs: null, spanMs: null },
  spanMs: null,
};

/**
 * Prototype-safe runway lookup: labels like "__proto__" or "toString" must
 * miss and fall back to NO_RUNWAY instead of resolving to inherited
 * Object.prototype members (whose `.result` is undefined).
 */
const runwayFor = (runways: ModelInput["runways"], label: string) =>
  Object.hasOwn(runways, label) ? runways[label] : NO_RUNWAY;

/** Order: first "5h", then "7d", then the rest as-is; duplicate labels dropped (first wins). */
function orderRows(rows: readonly ModelRow[]): ModelRow[] {
  const out: ModelRow[] = [];
  const seen = new Set<string>();
  for (const label of ["5h", "7d"]) {
    const row = rows.find((r) => r.label === label);
    if (row) {
      out.push(row);
      seen.add(label);
    }
  }
  for (const row of rows) {
    if (!seen.has(row.label)) {
      out.push(row);
      seen.add(row.label);
    }
  }
  return out;
}

/**
 * Stale = cached rows shown AND the governing timestamp missed two refresh
 * intervals. The governing timestamp is lastAttemptAt while erroring
 * (attempts are being made), updatedAt otherwise.
 */
function computeStale(input: ModelInput): boolean {
  if (input.rows.length === 0) return false;
  const ts = input.error != null ? input.lastAttemptAt : input.updatedAt;
  return ts != null && input.now - ts > 2 * input.intervalMs;
}

function freshnessText(ts: number | null, now: number, stale: boolean): string {
  if (ts == null) return "—";
  const age = Math.max(0, now - ts);
  let text: string;
  if (age < 10_000) text = "just now";
  else if (age < 60_000) text = `${Math.floor(age / 1000)}s ago`;
  else if (age < 3_600_000) text = `${Math.floor(age / 60_000)}m ago`;
  else if (age < 356_400_000) text = `${Math.floor(age / 3_600_000)}h ago`; // < 99h
  else if (age < 86_400_000_000) text = `${Math.floor(age / 86_400_000)}d ago`;
  else text = "999d+";
  return stale ? `stale · ${text}` : text;
}

/**
 * Percent display text shared by panel rows and chip values: null -> "?",
 * negatives clamp to 0%, values over 999 clamp to "999%" (width guard —
 * keeps the longest realistic text at 4 chars). fillPercent stays raw.
 */
function pctText(percent: number | null): string {
  if (percent == null) return "?";
  const clamped = Math.max(0, Math.round(percent));
  return clamped > 999 ? "999%" : `${clamped}%`;
}

function runwayTextFor(verdict: Verdict, result: RunwayResult): string {
  if (verdict === "blocked") return "limit reached";
  if (result.state === "no-burn") return "runway ∞";
  if (result.state === "no-data" || result.state === "no-limit" || result.state === "no-reset") return "runway …";
  return result.runwayMs != null ? `runway ${fmtApproxDuration(result.runwayMs)}` : "runway …";
}

function buildWindow(
  row: ModelRow,
  runway: { result: RunwayResult; spanMs: number | null },
  stale: boolean,
  input: ModelInput,
): WindowModel {
  const resetIn = row.resetAt != null ? Math.max(0, row.resetAt - input.now) : null;
  const verdict = classifyWindow({
    usage: row.usage,
    limit: row.limit,
    runwayMs: runway.result.runwayMs,
    runwayState: runway.result.state,
    resetInMs: resetIn,
    spanMs: runway.spanMs,
    stale,
    tightFactor: input.tightFactor,
  });
  const windowMs = row.unit != null ? WINDOW_MS[row.unit] : undefined;
  const markerIdx =
    windowMs != null && row.resetAt != null
      ? markerIndex(elapsedMs(input.now, row.resetAt, windowMs), windowMs, input.gaugeWidth)
      : null;
  return {
    // Output field only: ordering (orderRows) and the runway lookup in
    // buildPanel/buildChip already ran on the RAW label.
    label: sanitize(row.label),
    fillPercent: row.percent,
    markerIndex: markerIdx,
    verdict,
    percentText: pctText(row.percent),
    usageText: row.usage != null ? fmtCount(row.usage) : "?",
    limitText: row.limit != null ? fmtCount(row.limit) : "?",
    resetText: resetIn != null ? `reset ${fmtDuration(resetIn)}` : "reset ?",
    runwayText: runwayTextFor(verdict, runway.result),
    backText:
      verdict === "blocked" && row.resetAt != null && resetIn != null
        ? fmtBackAt(resetIn, input.now, input.formatTime)
        : null,
    shortfallText:
      verdict === "short" && runway.result.runwayMs != null && resetIn != null
        ? `(${fmtDuration(Math.max(0, resetIn - runway.result.runwayMs))} short)`
        : null,
  };
}

function capitalize(s: string): string {
  return s ? s[0].toUpperCase() + s.slice(1) : s
}

export function buildPanel(input: ModelInput): PanelModel {
  const stale = computeStale(input);
  const ts = input.error != null ? input.lastAttemptAt : input.updatedAt;
  return {
    header: {
      title: "Z.ai Runway",
      // Server-controlled; sanitized here so every V2 consumer inherits. null stays null.
      level: input.level == null ? null : capitalize(sanitize(input.level)),
      freshness: freshnessText(ts, input.now, stale),
      stale,
      updating: input.updating,
    },
    // Error with cached rows is presented as staleness, not as an error code.
    error: input.rows.length === 0 ? input.error : null,
    windows: orderRows(input.rows).map((row) => buildWindow(row, runwayFor(input.runways, row.label), stale, input)),
  };
}

export function buildChip(input: ModelInput): ChipModel {
  if (input.error != null && input.rows.length === 0) return { values: [], verdict: "error" };
  if (input.rows.length === 0) return { values: [], verdict: "unknown" };
  const pct = (label: string): string => {
    const row = input.rows.find((r) => r.label === label);
    return row ? pctText(row.percent) : "?";
  };
  const stale = computeStale(input);
  const verdicts = orderRows(input.rows).map(
    (row) => buildWindow(row, runwayFor(input.runways, row.label), stale, input).verdict,
  );
  return { values: [pct("5h"), pct("7d")], verdict: stale ? "unknown" : worstVerdict(verdicts) };
}

// Re-exported for consumers that want the runway-state vocabulary alongside the model types.
export type { RunwayState };
