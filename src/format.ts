/**
 * Formatting helpers for quota panel: durations and counters.
 */

/**
 * Sanitize a server-controlled string for display: whole ANSI escape
 * sequences (CSI color, OSC title) are removed first — stripping only the
 * ESC byte would leave their parameter bodies ("[31m") printable — then any
 * remaining C0/C1 control characters, zero-width/bidi characters, and a
 * 24-char length cap. Lives in this pure-string-util home so the legacy
 * renderer (re-export), the V2 view-model (model.ts) and the wiring layer
 * all share one implementation without import cycles.
 */
export const sanitize = (s: string): string =>
  s
    .replace(/\u001b\[[0-9;?]*[ -/]*[@-~]/g, "")
    .replace(/\u001b\][^\u0007]*\u0007/g, "")
    .replace(/[\u0000-\u001f\u007f-\u009f]/g, "")
    .replace(/[\u200b-\u200f\u202a-\u202e\ufeff]/g, "")
    .slice(0, 24);

/** Human-readable duration: seconds, minutes, hours (+minutes), or days (+hours). */
export function fmtDuration(ms: number): string {
  if (!Number.isFinite(ms) || ms <= 0) return "0m"
  if (ms < 60_000) return `${Math.floor(ms / 1000)}s`
  if (ms < 3_600_000) return `${Math.floor(ms / 60_000)}m`
  if (ms < 172_800_000) {
    const hours = Math.floor(ms / 3_600_000)
    const minutes = Math.floor((ms % 3_600_000) / 60_000)
    return minutes > 0 ? `${hours}h ${minutes}m` : `${hours}h`
  }
  const days = Math.floor(ms / 86_400_000)
  const hours = Math.floor((ms % 86_400_000) / 3_600_000)
  return hours > 0 ? `${days}d ${hours}h` : `${days}d`
}

/**
 * Approximate duration for runway estimates: "~" + exact fmtDuration below
 * 48h; beyond that a single whole-day figure ("~10d"), rounded half-up,
 * with no hours/minutes tail.
 */
export function fmtApproxDuration(ms: number): string {
  if (!Number.isFinite(ms) || ms <= 0) return "~0m"
  const totalHours = ms / 3_600_000
  if (totalHours < 48) return "~" + fmtDuration(ms)
  return `~${Math.round(totalHours / 24)}d`
}

/**
 * Reset annotation: below 24h an absolute clock time ("back at <time>"),
 * beyond that a relative duration ("back in 3d 4h"). Pure: `now` is passed
 * in, `formatTime` renders absolute timestamps.
 */
export function fmtBackAt(
  resetInMs: number,
  now: number,
  formatTime: (absMs: number) => string,
): string {
  if (resetInMs <= 0) return "back at " + formatTime(now)
  if (resetInMs < 86_400_000) return "back at " + formatTime(now + resetInMs)
  return "back in " + fmtDuration(resetInMs)
}

/** Compact counter: 999, 1k, 1.5k, 1M, 1.8B (sign preserved, no exponent notation). */
export function fmtCount(n: number): string {
  if (!Number.isFinite(n)) return "?"
  const abs = Math.abs(n)
  const sign = n < 0 ? "-" : ""

  let scale: number
  let tier: string
  if (abs >= 1e9) {
    scale = 1e9
    tier = "B"
  } else if (abs >= 1e6) {
    scale = 1e6
    tier = "M"
  } else if (abs >= 1e3) {
    scale = 1e3
    tier = "k"
  } else {
    return sign + String(abs)
  }

  const value = abs / scale
  if (Number.isInteger(value)) return `${sign}${value}${tier}`

  const fixed = value.toFixed(1)
  const stripped = fixed.endsWith(".0") ? fixed.slice(0, -2) : fixed
  return `${sign}${stripped}${tier}`
}
