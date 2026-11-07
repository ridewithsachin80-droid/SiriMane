# Siri Mane — Phase Status

Owner of this record: PM pass. Framework 2.0. Updated 7 Nov 2026.

## Completed (preserved from pre-framework history; evidence was delta zips + gate counts reported in chat)

| Sprint | Delivered | Gate evidence at delivery |
|---|---|---|
| 0–5 | Stabilise → Warden UX → Resident UX → AI inputs → AI assistant → Owner intelligence | per-sprint gates |
| 6–12 (Phase 2) | Copilot action layer, repaint, Home hierarchy, Resident 360, room map & requests, finance intel, resident experience, notify/docs | 9 gates, 1,787 assertions |
| 13 | Bulk actions w/ preview, command palette, Room 360, universal "Why?", 3 nudges, accessibility pass | 10 gates, 2,001 (+1 migration: room-360) |
| 14 | Quick Entry: verb-free "onion 100rs" / "jhanavi 500" / "tap leaking room 106" | 11 gates, 2,109 |
| 14.1 | Voice repair via Chrome alternatives + model | quick 140 |
| 14.2 | Fuzzy resident names ("janavi" → suggest Jhanavi, never an expense) | quick 159 |
| 14.3 | Copilot question box readable in dark mode; ₹ in Copilot text | ui 690 |
| 14.4 | Kannada/Hindi item words by sound; category taps on expense preview → learned | quick 195, copilot 250, ui 690 |

All of the above is on `main` at `48deac23` and deployed to production by the owner.

## Current phase: F0 — Framework adoption

| Task | Owner | Status | Evidence |
|---|---|---|---|
| F0.1 Read framework, project instructions, context doc | PM | COMPLETED | — |
| F0.2 Declare execution mode | PM | COMPLETED | SINGLE-AGENT SEQUENTIAL ROLES (PROJECT_CONTEXT.md) |
| F0.3 Verify repository, branch and isolation facts (G0) | OPS/SEC | COMPLETED — **findings** | PROJECT_CONTEXT.md §Safety facts |
| F0.4 Create test branch `ai/test` from baseline SHA | DEV | COMPLETED locally | `git checkout -b ai/test 48deac23` |
| F0.5 Add project records under docs/ai-team/ | PM | COMPLETED | this commit |
| F0.6 Re-run the eleven gates on the baseline to confirm the clone matches delivered state | QA | COMPLETED — 11/11 PASS, 2,196 assertions (TZ=UTC); first run under an invalid TZ failed and is kept as evidence | TEST_REPORT.md runs B-1, B-2 |
| F0.7 Push `ai/test` to GitHub | DEV | COMPLETED — `ai/test` → `d1641eb`; `main` verified unchanged at `48deac23` | `git ls-remote` after push |
| F0.8 Owner installs branch protection on `main` | Owner | COMPLETED — ruleset 26756000, verified via `GET /rules/branches/main` | PROJECT_CONTEXT.md §Safety facts |
| F0.9 Test environment on Railway | Owner + OPS | COMPLETED — https://sirimane-test.up.railway.app | TEST_REPORT.md §G5 |
| F0.10 Change the test admin password from the seeded default | Owner | OPEN | public URL + default password in seed.js |

Gate status for F0: G0 **PASS** (direct push to `main` blocked server-side; separate test env + DB), G1–G3 N/A (no application code changed), G4 PASS for a docs-only branch creation, G5 **PASS** — first verified test deployment, Railway `Test` env on `ai/test` (TEST_REPORT.md §G5).

## Next phase: Sprint 15 — not yet scoped

Owner's standing rule: pick it from evidence (Admin → AI impact, `source` column). Candidates from the backlog: "Select all shown" discoverability in the bulk bar; the unexplained `outline-width: 0` on `.nav-item`; four residents with bad bed numbers (data fix, not code); Gemini audio transcription if Copilot-log `heard/understood` pairs show repairs failing.
