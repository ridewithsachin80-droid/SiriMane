# Siri Mane — Decision Record

Owner of this record: ARCH pass. Owner decisions are attributed to **Sachin**; agent recommendations are marked as such.

## Owner decisions (standing)

| Date | Decision | Why it matters |
|---|---|---|
| 2026-09 | Residents keep the default password (mobile number) unless they change it | No forced reset flow |
| 2026-09 | Six dead legacy route files deleted; only index.js + feature routers remain | Any zip must not resurrect them |
| 2026-09-14 | Bulk actions: cap 15, second confirm above 8; reminded-in-7-days is skipped; staff may draft reminders and assign requests; notices-to-group and document verification are admin-only | Enforced server-side in services/bulk.js |
| 2026-09-17 | Quick Entry: never assume payment mode — ask; an amount with no item asks "for what?"; learn categories from this PG's purchases **and** consult the model | services/quick.js + copilot.js |
| 2026-09-17 | Voice must interpret the transcript (like FitLife), not take it verbatim | 14.1 |
| 2026-09-17 | Near-miss names suggest the resident, never file an expense | 14.2 |
| 2026-09-17 | Kannada/Hindi item words recognised whatever the spelling | 14.4 |
| 2026-11-07 | Adopt AI Engineering Team Framework 2.0; create and push a test branch | This phase |

## Architecture decisions (ARCH)

| ID | Decision | Alternatives considered | Trade-off |
|---|---|---|---|
| A-01 | `tools.js` is the only thing the AI can do; model picks tool+args, server validates and calls the same HTTP route the form calls | Let the model write SQL / call services directly | Slower to add tools, but no privilege escalation path and every action is audited |
| A-02 | Numbers from code, words from the model | Model computes figures | A hallucinated rupee figure is unacceptable; phrasing errors are tolerable |
| A-03 | Quick Entry classifier is deterministic first, model only as tie-breaker (category) or transcript repair (voice) | Model-first | Works keyless; <50 ms; typed text is never "corrected" |
| A-04 | Preview → single-use proposal → confirm for every mutation | Direct execute with undo | Undo on money is unreliable; double-tap safety comes free |
| A-05 | All migrations additive, run by hand in Railway console | Auto-migrate on boot | Owner controls when schema changes land |
| A-06 | Framework adoption adds `docs/ai-team/` only; no application code changes in the adoption commit | Fold adoption into a feature sprint | Keeps the adoption diff reviewable and separable |
| A-07 | Test branch is `ai/test`, cut from `main@48deac23`; integration method is PR with base `ai/test` | Direct pushes to `ai/test` | Owner's standing rule "never push without permission" — a PR is the permission step |

## Agent recommendations (NOT owner decisions)

- R-01 (OPS/SEC, 2026-11-07): Add a GitHub ruleset on `main` that blocks pushes from the Claude GitHub App identity and requires a PR. Without it, instruction is the only control. **Owner has not decided.**
- R-02 (OPS, 2026-11-07): A second Railway service pointed at `ai/test` with its own Postgres would give a real test URL and make G5 possible. Costs a Railway service + DB. **Owner has not decided.**
- R-03 (PM, 2026-11-07): Sprint 15 should be chosen from Admin → AI impact `source` counts after a week of Quick Entry use, per the owner's own rule. **Not yet scoped.**
