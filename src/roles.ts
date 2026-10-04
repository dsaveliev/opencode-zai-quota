/**
 * Semantic roles for quota panel rendering, mapped to theme token keys.
 *
 * Two vocabularies coexist during the redesign (W2 -> W3):
 *
 * - Legacy `Role` / `ROLE_THEME_KEY` (crit/warn/ok/muted/accent/info) power
 *   the legacy render.ts paths (gauge/chipSegments/panelModel) and tui.tsx,
 *   which imports ROLE_THEME_KEY directly; format.test.ts asserts the exact
 *   six-entry map. They stay byte-identical until W3 retires tui — renaming
 *   them would break files outside this wave's scope.
 *
 * - V2 `SegmentRole` / `THEME_KEY` (five universal tokens) are the redesign
 *   contract: every Segment produced by the V2 renderer carries exactly one
 *   of these. Identity map — the token names are already theme-key names.
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

/** V2: the five universal semantic tokens used by rendered segments. */
export type SegmentRole = "text" | "textMuted" | "success" | "warning" | "error"

/** V2: segment role -> theme key (identity; roles are theme-key names). */
export const THEME_KEY: Record<SegmentRole, string> = {
  text: "text",
  textMuted: "textMuted",
  success: "success",
  warning: "warning",
  error: "error",
}
