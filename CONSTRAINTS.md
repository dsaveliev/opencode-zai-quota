# Constraints

Last reviewed: 2026-10-04 (headless run — floor applied per constraint-driven-development;
interview questions deferred to a human session, flagged in DECISIONS.md)

## Floor (always enforced, no setup required)

- No new suppression comments: `@ts-ignore`, `eslint-disable`, `// biome-ignore`
- No unimplemented stubs: `throw new Error("Not implemented")`, empty `catch {}`
- No skipped or deleted tests without a reason in the commit message
- No secrets in source (auth tokens are read at runtime, never logged or committed)
- This file does not get weakened to make a change pass

## Enforced with numbers

| Dimension | Rule | Checked by | Runs at |
|-----------|------|-----------|---------|
| Types | Zero type errors | `tsc --noEmit` | task end |
| Tests | All green, changed modules covered | `bun test` | task end |
| Coverage floor (suite) | Every exported pure function in src/ has ≥ 1 boundary test | `bun test` (assertion audit in review) | task end |
| Deprecations | Zero use of `api.command.*` legacy API | `grep -rn "api.command" src/` returns nothing | task end |
| Theme purity | No hardcoded hex/ANSI colors in render output paths | `grep -rn "#[0-9a-fA-F]\{6\}" src/` returns nothing (test fixtures exempt) | task end |

Rationale for numbers: this is a pure-TypeScript plugin with no runtime URL, so
Lighthouse/axe/perf dimensions do not apply (dropped, not silently ignored — see
constraint-driven-development "say so and drop the dimension"). Types + tests +
mechanical greps are the applicable external/project checks; the suite is
project-authored, hence the review-stage assertion audit as the counterweight.

## Measured, not yet enforced

| Metric | Today | Direction |
|--------|-------|-----------|
| Test count | 0 (pre-implementation) | must not fall once set |
