export type Verdict = "ok" | "tight" | "short" | "blocked" | "unknown";

export type RunwayState = "no-limit" | "no-reset" | "no-data" | "no-burn" | "ok" | "warn";

export type StatusInput = {
  usage: number | null;
  limit: number | null;
  runwayMs: number | null;
  runwayState: RunwayState;
  resetInMs: number | null;
  spanMs: number | null;
  stale: boolean;
  /** Validated >= 1 by caller. */
  tightFactor: number;
};

export const VERDICT_SEVERITY: Record<Exclude<Verdict, "unknown">, number> = {
  ok: 0,
  tight: 1,
  short: 2,
  blocked: 3,
};

export function classifyWindow(input: StatusInput): Verdict {
  // 1. Hard exhaustion wins over every other signal.
  if (input.usage != null && input.limit != null && input.usage >= input.limit) return "blocked";
  // 2. A stale sample supports no verdict.
  if (input.stale) return "unknown";
  // 3. A measurement span shorter than a minute supports no verdict.
  if (input.spanMs != null && input.spanMs < 60_000) return "unknown";
  // 4. No burn recorded: this window is intact.
  if (input.runwayState === "no-burn") return "ok";
  // 5. Missing upstream runway inputs support no verdict.
  if (input.runwayState === "no-data" || input.runwayState === "no-limit" || input.runwayState === "no-reset") {
    return "unknown";
  }
  // 6. Runway projection or reset distance missing or non-finite supports no verdict
  //    (NaN/Infinity would poison the comparison ladder below).
  if (
    input.runwayMs == null ||
    input.resetInMs == null ||
    !Number.isFinite(input.runwayMs) ||
    !Number.isFinite(input.resetInMs)
  ) {
    return "unknown";
  }
  // 7. Runs dry before the reset.
  if (input.runwayMs < input.resetInMs) return "short";
  // 8. Tight band: reset <= runway < reset * tightFactor (equality lands here).
  if (input.runwayMs < input.resetInMs * input.tightFactor) return "tight";
  // 9. Comfortably past the reset, equality included.
  return "ok";
}

export function worstVerdict(verdicts: readonly Verdict[]): Verdict {
  const known = verdicts.filter((v): v is Exclude<Verdict, "unknown"> => v !== "unknown");
  if (known.length === 0) return "unknown";
  return known.reduce((worst, v) => (VERDICT_SEVERITY[v] > VERDICT_SEVERITY[worst] ? v : worst));
}
