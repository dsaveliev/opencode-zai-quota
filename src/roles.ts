/**
 * Semantic roles for quota panel rendering, mapped to theme token keys.
 */

export type Role = "crit" | "warn" | "ok" | "muted" | "accent" | "info"

export const ROLE_THEME_KEY: Record<Role, string> = {
  crit: "error",
  warn: "warning",
  ok: "success",
  muted: "textMuted",
  accent: "primary",
  info: "info",
}
