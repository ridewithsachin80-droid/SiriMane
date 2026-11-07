# Siri Mane — Session Handoff

Updated: 7 November 2026 · Framework 2.0 · Execution mode: SINGLE-AGENT SEQUENTIAL ROLES (self-review, labelled as such)

## Where things stand

- **Repository:** `ridewithsachin80-droid/SiriMane` · **production branch:** `main` (Railway auto-deploys it) · **test branch:** `ai/test`
- **Baseline SHA:** `48deac233fcafe667b4977d344106fff62b301a5` — this is `main`, and it already contains Sprints 0–14.4. The GitHub tree matches what was delivered and deployed; nothing is missing.
- **This phase (F0) changed no application code.** It added `docs/ai-team/` and nothing else.
- **Gate evidence for the baseline:** see TEST_REPORT.md (run against this exact SHA, local scratch Postgres, headless Chromium 360/390).

## Owner actions (both completed 7 Nov 2026 — kept for history)

These are the G0 findings. Neither can be done from an AI session — both are deliberately yours.

1. **Protect `main`.** GitHub → Settings → Rules → Rulesets → New branch ruleset: target `main`, enable *Restrict updates*, *Require a pull request before merging*, and leave bypass empty. Today `main` has **no protection and no rulesets** (verified via API on 7 Nov). Until this exists, the only thing stopping an AI session from deploying to production is instruction — which the framework says is not a control.
2. **Know that AI sessions already have unrestricted write access.** The tooling *claimed* pushes would be refused; the push to `ai/test` succeeded anyway. That means a session could equally push to `main`. Step 1 is therefore not optional hygiene — it is the only real control, and it should happen before the next AI session that touches this repo.

The standing rule "never push without Sachin's explicit permission" still applies to every session; this push was explicitly requested in this one.

## Permitted next action for the next session

1. Verify these facts are still true (`git fetch`, re-check rulesets) — never trust this file blindly.
2. Work on `ai/test` (or an `ai/<task>` branch cut from it); open PRs with base `ai/test`; never target `main`.
3. Scope Sprint 15 from evidence (Admin → AI impact, `source` column) — owner's standing rule.

## Open defects / known gaps (carried over)

| ID | Severity | Item | Owner |
|---|---|---|---|
| D-15-3 | Medium | bcrypt 5.x pulls a vulnerable install-time `tar`; fix is bcrypt 6 (major) | DEV, Sprint 15 — with gate + phone login test |
| D-13-1 | Low | "Select all shown" scrolls out of the bulk bar when three buttons are present | DEV, next layout sprint |
| D-13-2 | Low | `outline-width` computes to 0 on `.nav-item` despite `:focus-visible` matching; worked around with a box-shadow ring; root cause unknown | ARCH |
| D-DATA-1 | Low | Four residents have wrong/duplicated bed numbers (106 ×2, 206, 207); map flags them ⚑ — data fix in the app, not code | Owner/warden |
| G0-1 | ~~High~~ | ~~No server-side protection on `main`~~ — CLOSED 7 Nov: ruleset requires a PR, blocks force-push/deletion | Owner |
| G0-2 | ~~Medium~~ | ~~No separate test deployment~~ — CLOSED 7 Nov: https://sirimane-test.up.railway.app on its own Postgres | Owner |

## Owner's new deploy workflow (since the ruleset)
GitHub upload → choose **Create a new branch and start a pull request** → **Merge pull request** → Railway deploys `main`. AI sessions push to `ai/test` only; Railway deploys it to the Test environment for checking first.
