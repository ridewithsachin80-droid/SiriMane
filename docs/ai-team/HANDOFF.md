# Siri Mane — Session Handoff

Updated: 7 November 2026 · Framework 2.0 · Execution mode: LIMITED MULTI-AGENT from Sprint 15 (implementer + independent reviewer/QA agents)

## Status at 7 Nov 2026, 23:00 IST — Sprints 15 → 15.5 on Test, NOT on production

| Branch | State |
|---|---|
| `main` (production, sirimane.in) | `48deac23` — unchanged all session |
| `ai/test` (Test site) | Sprints 15, 15.1, 15.2, 15.3, 15.4, 15.5 merged via PRs #1–#6, each after independent review |

Gates on the last code: 12/12 PASS twice, 2,552 assertions (the 12th gate, `xss`, was added this session).

### Why production should follow soon
**D-15-6 (Critical):** on sirimane.in today, text typed by residents — and by anyone on the internet via the public "message the PG" form — runs as code on the warden's/admin's screens (reproduced in a browser). Fixed on Test only. The repo is public, so the fix is visible there.

### Owner actions, in order
1. **Railway Test → Variables → `JWT_SECRET`**: set a new value (generated one was given in chat) and redeploy. Required before production (N-6).
2. Change the Test admin password.
3. Phone test on sirimane-test.up.railway.app: resident 4-tab app, move-in (deposit recorded once, message says what was recorded), Payments (Type column, received vs waiting), checkout (deposit received of agreed), Inbox/Requests look normal.
4. On Railway (production, after release): confirm the login limiter still blocks when `X-Forwarded-For` changes (reviewer note).
5. Release: GitHub PR `ai/test` → `main`, merge. Users with sessions from before the release keep working (no mass logout).

### Decisions only the owner can make
- **P-2:** allow or block two active residents on one phone number (today: safe — each logs in with her own password; identical password → refused).
- Backfill: tidy existing phone numbers saved with spaces (login already works without it).
- Forced password change after the first resident login (default password = phone number).
- Separate login limiters for staff and residents (shared Wi-Fi typos can lock out the warden).
- D-15-3: bcrypt 5 → 6 (major dependency upgrade).
- F-20: existing residents with ID type "— select —" (data update).
- Refund maths: refund is computed from the agreed deposit even if less was collected (now shown as a warning only).

### Next engineering items (no permission needed)
- D-15-7 (Med): a slow screen's late render can overwrite the screen you moved to (~25 screens).
- D-15-8 (High, hardening): admin token in localStorage + CSP off → move to httpOnly cookie and/or enable CSP.
- LIMIT 5 on shared numbers → return the 409 message above 5 (Low). G-1/G-2 test hygiene. D-15-2 date columns under non-UTC TZ.

## Where things stand (F0, kept for history)

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

## Sprint 15 — production blockers (owner)
1. Railway **Test** → Variables → set a NEW `JWT_SECRET` (any long random string), redeploy Test. Closes N-6.
2. Change the Test admin password from the seeded default (F0.10).
3. Test boot log must say `🔐 login tokens bound to environment … (source: railway)` (N-3).

## Owner's new deploy workflow (since the ruleset)
GitHub upload → choose **Create a new branch and start a pull request** → **Merge pull request** → Railway deploys `main`. AI sessions push to `ai/test` only; Railway deploys it to the Test environment for checking first.
