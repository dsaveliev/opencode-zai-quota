/**
 * Semantic roles for quota panel rendering, mapped to theme token keys.
 *
 * `SegmentRole` / `THEME_KEY` (five universal tokens) are the redesign
 * contract: every Segment produced by the render layer carries exactly one
 * of these, and the wiring (tui.tsx) resolves colors exclusively through
 * this map. Identity map — the token names are already theme-key names.
 * (The legacy six-role vocabulary was retired in W3 together with the
 * legacy renderer that consumed it.)
 */

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
