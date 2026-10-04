import type { QuotaRow } from "./api";

export type Sample = { t: number; usage: number };

export type RunwayResult = {
  state: "no-limit" | "no-reset" | "no-data" | "no-burn" | "ok" | "warn";
  runwayMs: number | null;
  resetInMs: number | null;
};

/**
 * Append a sample to the usage history (pure: returns a new array).
 *
 * A usage decrease relative to the last sample marks a quota-window boundary,
 * so the history restarts from the new sample alone. `prevResetAt` is reserved
 * for the wiring layer's resetAt-change detection; this function ignores it.
 * A degenerate `maxHistory` (0, negative, fractional) is clamped to a floor of
 * 1 so trimming can never empty the history.
 */
export function pushSample(
  history: readonly Sample[],
  sample: Sample,
  prevResetAt: number | null,
  maxHistory: number,
): Sample[] {
  void prevResetAt;
  const cap = Math.max(1, Math.floor(maxHistory));
  if (history.length > 0 && sample.usage < history[history.length - 1].usage) {
    return [sample];
  }
  const next = [...history, sample];
  if (next.length > cap) {
    return next.slice(next.length - cap);
  }
  return next;
}

/**
 * Project the time until the quota limit is exhausted (runway) versus the time
 * until the quota window resets. Pure: inputs are never mutated. A non-finite
 * resetAt is treated as absent (no-reset), never as a real timestamp.
 */
export function computeRunway(history: readonly Sample[], row: QuotaRow, now: number): RunwayResult {
  const resetAt = row.resetAt != null && Number.isFinite(row.resetAt) ? row.resetAt : null;
  if (row.limit == null) {
    return {
      state: "no-limit",
      runwayMs: null,
      resetInMs: resetAt != null ? Math.max(0, resetAt - now) : null,
    };
  }
  if (resetAt == null) {
    return { state: "no-reset", runwayMs: null, resetInMs: null };
  }
  const resetInMs = Math.max(0, resetAt - now);
  if (row.usage == null || history.length < 2) {
    return { state: "no-data", runwayMs: null, resetInMs };
  }
  const first = history[0];
  const last = history[history.length - 1];
  const span = last.t - first.t;
  if (span < 1000) {
    return { state: "no-data", runwayMs: null, resetInMs };
  }
  const burnPerMs = (last.usage - first.usage) / span;
  if (burnPerMs <= 0) {
    return { state: "no-burn", runwayMs: null, resetInMs };
  }
  const remaining = row.limit - row.usage;
  const runwayMs = remaining / burnPerMs;
  if (!Number.isFinite(runwayMs)) {
    return { state: "no-burn", runwayMs: null, resetInMs };
  }
  return { state: runwayMs < resetInMs ? "warn" : "ok", runwayMs, resetInMs };
}
