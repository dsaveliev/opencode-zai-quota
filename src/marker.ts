export const WINDOW_MS: Readonly<Record<number, number>> = {
  3: 300 * 60_000,
  6: 7 * 24 * 60 * 60_000,
};

export function elapsedMs(now: number, resetAt: number, windowMs: number): number {
  return now - (resetAt - windowMs);
}

export function markerIndex(elapsed: number, windowMs: number | null | undefined, width: number): number | null {
  // Symmetric finite guard: non-finite elapsed (NaN, ±Infinity) is garbage in → no marker.
  if (!Number.isFinite(elapsed)) return null;
  if (windowMs == null || !Number.isFinite(windowMs) || windowMs <= 0 || width < 2) return null;
  const index = Math.floor((elapsed / windowMs) * width);
  return Math.min(Math.max(index, 0), width - 1);
}
