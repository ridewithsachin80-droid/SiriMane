# Siri Mane — Test Report and Defect Ledger

Owner of this record: QA pass (self-review — single-agent session). Framework 2.0.

## How the gates run

Eleven smoke suites under `backend/test/*.smoke.js`, each against a **real Postgres rebuilt from `backend/scripts/migrate-all.js` + `seed.js`**, with headless Chromium at 360px and 390px for `ui` and `portal`. Synthetic data only. AI providers keyless or stubbed via `ai.providers._stub`. Each suite prints `✅ <name> gate passed — N assertions` or `❌ … FAILED after N assertions` and exits non-zero on failure. A runner error is a failure, not a pass.

```
DATABASE_URL=<scratch> JWT_SECRET=test NODE_ENV=test TZ=UTC \
CHROME_PATH=<chrome> NODE_PATH=<dir containing puppeteer-core> \
node backend/test/<name>.smoke.js
```

## Baseline runs — source SHA `48deac233fcafe667b4977d344106fff62b301a5` (main)

### Run B-1 — 2026-11-07 08:37Z — container TZ = `Asia` (an invalid zone name) — **FAILED BASELINE**

| Gate | Result | Assertions reached | First failure |
|---|---|---|---|
| api | FAIL | 110 | backdated effective_from kept — off by one day |
| ai | PASS | 213 | |
| assistant | PASS | 82 | |
| owner | PASS | 94 | |
| copilot | FAIL | 62 | owner confirms → 409 "proposal has expired" |
| finance | PASS | 71 | |
| notify | FAIL | 47 | next due = today + interval — off by one day |
| bulk | FAIL | 35 | confirm → 409 expired |
| quick | FAIL | 66 | confirm → 409 expired |
| ui | FAIL | 126 | timeout waiting for a confirm-driven screen |
| portal | PASS | 171 | |

Passed assertions in this run: 631 (not comparable to the 2,141 total; the suites abort at the first failure).

**Root cause (reproduced, not inferred):** `ai_proposals.expires_at` is `timestamp` *without* time zone. Postgres stores a wall-clock value; `pg` reads it back in the Node process's local zone. With the process zone invalid, the read-back landed 5h30 behind, so `new Date(p.expires_at) < new Date()` was true the instant a proposal was created. The same mismatch shifts date-only columns by a day in `api` and `notify`. Evidence: a direct reproduction printed `db expires_at 03:18Z` against `db now 08:38Z` for a row created seconds earlier.

**Classification:** environment artefact in this container **and** a latent fragility in the code (defect D-15-1 below). Not a regression introduced since September: Railway runs UTC, where the two zones agree, and the September gate runs were green in a container whose zone was valid.

### Run B-2 — 2026-11-07 — same SHA, same DB rebuilt, `TZ=UTC` (matches Railway)

_Results appended below by the run script; see `## Run B-2 results`._

## Defect ledger

| ID | Sev | Requirement | Steps | Expected / actual | Owner | State |
|---|---|---|---|---|---|---|
| D-15-1 | Medium | Proposal expiry must not depend on the server's local time zone | Run the server with any process TZ that differs from Postgres's; ask → confirm within seconds | Expected 200; actual 409 "expired". Cause: `ai_proposals.expires_at` is `timestamp` not `timestamptz`; comparison done in JS | DEV (ARCH review) | OPEN — fix is an additive migration (`ALTER … TYPE timestamptz` is a rewrite, so instead compare in SQL: `expires_at < NOW()` in the same query) — **not applied in F0**, which changes no code |
| D-15-2 | Low | Date-only columns (`effective_from`, maintenance `next_due`) read back as the previous day under a mismatched TZ | as above | off by one | DEV | OPEN — same family; covered by the `api`/`notify` assertions that caught it |
| D-15-3 | Medium | Dependencies must have no known high/critical vulnerabilities | `cd backend && npm audit --omit=dev` | 3 findings: bcrypt 5.1.1 → @mapbox/node-pre-gyp → tar ≤7.5.20 (install-time only, not on the request path). Fix = bcrypt 6.0.0, a major bump | DEV + SEC review | OPEN — first item for Sprint 15; needs full gate + phone login test |
| D-13-1 | Low | "Select all shown" scrolls out of the bulk bar | select rows on Rent Due with 3 actions | control not visible | DEV | OPEN |
| D-13-2 | Low | `outline-width` computes 0 on `.nav-item` | Tab to a nav item | ring drawn only via box-shadow workaround | ARCH | OPEN |

## Independence and limitations

- All verification here is **self-review**: the same agent wrote the code (Sprints 13–14.4) and these gates. No separate reviewer was available.
- Browser checks are **headless Chromium emulation** at 360/390px, not a physical device. Sachin's phone tests are the only physical-device evidence and live in chat screenshots, not here.
- No test deployment exists, so G5 was never exercised for any sprint.

## Run B-2 results — 2026-11-07 08:39–08:40Z, `TZ=UTC`, fresh scratch DB, SHA `48deac23`

| Gate | Result | Assertions | Matches last delivery? |
|---|---|---|---|
| api | PASS | 250 | yes |
| ai | PASS | 213 | yes |
| assistant | PASS | 82 | yes |
| owner | PASS | 94 | yes |
| copilot | PASS | 250 | yes |
| finance | PASS | 71 | yes |
| notify | PASS | 64 | yes |
| bulk | PASS | 116 | yes |
| quick | PASS | 195 | yes |
| ui | PASS | 690 | yes |
| portal | PASS | 171 | yes |
| **Total** | **PASS** | **2,196** | all eleven at their September counts |

Tools: Node v22.23.4 · PostgreSQL 16 (local, SSL on, trust auth, port 5435) · Chromium (Playwright build 1243) via puppeteer-core · exit code 0 on every suite.

**Verdict (QA, self-review):** the GitHub baseline is what was delivered and is green in a UTC environment. D-15-1/D-15-2 remain OPEN as latent fragilities and are the first recommended item for Sprint 15, since they would bite anyone running the app outside UTC.

## G5 — first verified test deployment · 2026-11-07 (owner-run, evidence by screenshot)

| Step | Result | Evidence |
|---|---|---|
| Railway environment `Test` (id `ae09e94e…`), service SiriMane, source branch `ai/test` | VERIFIED | Railway deployment panel: "ridewithsachin80-droid/SiriMane · ai/test", commit "docs: record D-15-3 …" = `669ccef` |
| Separate database | VERIFIED | `/health` on a fresh deploy listed **every** table missing — an empty Test Postgres, not production's |
| Build | PASS | Nixpacks, Node 20.19.5, `npm install` honoured the lockfile (242 packages) |
| Start | PASS (after fix) | First two deploys failed: a pre-deploy command `node backend/scripts/migrate-accountability.js` ran against an empty DB before Railway's private network was up. Cleared → service Online |
| Migrations | PASS | Console: `node backend/scripts/migrate-all.js` → all 18 → "🎉 All migrations are up to date"; `seed.js` → admin created |
| Smoke: login + Quick Entry write | PASS | `/management` login as admin; "onion 100" → Confirm → Expenses shows ₹100 Groceries, November 2026 |
| Serverless | OFF | required — the 15-min notification sweep and 07:00/15:00/20:00 jobs run in-process |

Limitations: performed by the owner in a desktop browser; the AI session cannot reach `*.up.railway.app` (egress allowlist). Not a physical-phone test. `/health` still read `schema: missing` for up to 10 min after migrating — it caches its check (see `schemaCheckedAt`); expected, not a defect.

**Lesson recorded:** Railway copies variables into a new environment. After creating one, check `DATABASE_URL` and clear any pre-deploy command *before* the first deploy.

## Sprint 15 — gate runs (fresh scratch DB, `TZ=UTC`, headless Chromium 360/390)

| Run | Source | Result | Notes |
|---|---|---|---|
| G15a–d | 59b33be + work in progress | FAIL | auth recursion bug (verifyToken called itself → every authed request 401); fixed |
| G15e | 59b33be + review fixes | 10/11 | portal: theme-toggle size measured while its page was hidden (test fault, 0×0); fixed in the test |
| G15f | same + test fix | 10/11 | ui: "@390 focus returns to what opened the modal" — **intermittent**: then 7 consecutive ui passes. Assertion now reports where focus landed so the next occurrence is diagnosable |
| **G15g** | **7089aed** | **11/11 PASS, 2,291 assertions** | api 257 · ai 213 · assistant 82 · owner 94 · copilot 250 · finance 71 · notify 64 · bulk 116 · quick 195 · ui 732 · portal 217 |

New defect: **D-15-4** (Low) — ui focus-return assertion failed 1 time in 9 runs. Cause not established. Room 360 / modal focus code was not changed in Sprint 15; `setContent` was (sub-tab re-injection). OPEN — diagnostics added.
