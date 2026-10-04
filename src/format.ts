/**
 * Formatting helpers for quota panel: durations and counters.
 */

/** Human-readable duration: seconds, minutes, hours (+minutes), or total hours. */
export function fmtDuration(ms: number): string {
  if (!Number.isFinite(ms) || ms <= 0) return "0m"
  if (ms < 60_000) return `${Math.floor(ms / 1000)}s`
  if (ms < 3_600_000) return `${Math.floor(ms / 60_000)}m`
  if (ms < 86_400_000) {
    const hours = Math.floor(ms / 3_600_000)
    const minutes = Math.floor((ms % 3_600_000) / 60_000)
    return minutes > 0 ? `${hours}h ${minutes}m` : `${hours}h`
  }
  return `${Math.floor(ms / 3_600_000)}h`
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
