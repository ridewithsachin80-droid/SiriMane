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

### Independent re-review (separate agent) of 7089aed — APPROVE FOR TEST DEPLOYMENT
Re-ran 11/11 gates itself (2,291). S15-6 money PASS; S15-7 security sound. New findings, fixed in the next commit:
N-1 (Med) fixed calendar cut-off would log everyone out on a later production deploy → cut-off is now server boot time ·
N-2 (Low) non-numeric `iat` passed the cut-off → now must be a finite number; test verified by mutation (old check fails it) ·
N-4 (Low) `payment_mode`/`collection_month` unescaped in the portal → escaped · N-5 (Info) unused `jwt` import in routes → removed.
Not fixed, recorded: N-3 (Low) if Railway's environment id were missing, Test and production could share an id — owner check: boot log must say `source: railway`. F-15, F-16, F-20 open (F-20 needs an approved data update).

G15h — fix commit: **11/11 PASS, 2,296 assertions** (api 262 = +5 malformed-iat cases).

### Re-check of 01c8083 (same independent agent) — APPROVE FOR TEST DEPLOYMENT
Re-ran 11/11 itself (2,296); N-2/N-4/N-5 confirmed fixed, N-2 mutation check reproduced.
**N-6 (Medium, PRODUCTION BLOCKER until resolved):** while Test shares production's `JWT_SECRET`, a Test token minted by pre-S15 code is accepted by production after any production restart (boot-time cut-off). Resolution chosen: owner gives Test its own `JWT_SECRET` before Sprint 15 goes to production — this removes cross-environment token acceptance entirely. Fallback if not done: keep Test on S15 for >24 h before production.
N-6d (test weakness) fixed: the post-boot legacy token is now dated after boot but in the past; mutation-checked — a per-request cut-off fails the gate.

## Sprint 15.1 — D-15-5 move-in double deposit

| Run | Source | Result |
|---|---|---|
| ui (single, fresh DB) | 9da6faf working tree | FAIL once at 358: `Waiting failed: 5000ms` — same position as the D-15-4 modal-close wait at 360px; then PASS 750. Recorded as probable D-15-4 recurrence, not proven |
| G151j | 9da6faf | **11/11 PASS, 2,321** |
| G151k | 9da6faf | **11/11 PASS, 2,321** |
| Mutation: fix disabled | — | api FAIL "server records NO deposit itself (got 1)"; ui FAIL "exactly one deposit record … (got 2)" — reproduces the owner's bug |

Gate gap closed: the wizard test previously asserted `some` deposit row; it now asserts exactly one deposit and one rent row, the amount and the mode.
D-15-4 now 2 occurrences in 13 ui runs.

## Sprint 15.2

**D-15-6 (Critical, SEC) — stored XSS into staff screens.** Found while scoping S15.2-3. The management app had no HTML escaping; `helmet` runs with `contentSecurityPolicy: false`. Untrusted writers: the PUBLIC `POST /api/guest-message` (no login) and residents (complaint category/description, visitor name/relation, meal comment, survey comment). New gate `backend/test/xss.smoke.js` (new file) plants payloads through every untrusted door and opens every router page, every inbox message, the request sheet, every Resident 360 / Room 360 tab, search and a Copilot answer.
- Before fix (73d2159): FAIL on 12 screens; the payload's code RAN on Requests, Inbox (list + opened message), request sheet and a Copilot answer.
- After fix (82e250a): PASS, 50 assertions.
On production (`main`) since at least 17 Sep. Release is the owner's decision.

**D-15-1 closed** — proposal expiry now decided by Postgres. Evidence: `GATE_TZ=Asia/Kolkata` copilot FAIL "owner confirms (got 409)" before; copilot 250 / bulk 116 / quick 195 PASS after.

| Run | Source | Result |
|---|---|---|
| G152a | 82e250a (uncommitted at run, same content) | **12/12 PASS, 2,409** (api 276 · ai 213 · assistant 82 · owner 94 · copilot 250 · finance 71 · notify 64 · bulk 116 · quick 195 · ui 781 · portal 217 · xss 50) |
| G152tz | same, TZ=Asia/Kolkata | copilot/bulk/quick PASS |
| G152tz-before | 73d2159, TZ=Asia/Kolkata | copilot FAIL (D-15-1 reproduced) |

Gate list is now TWELVE (adds `xss`).

### Sprint 15.2 — review round 1: BLOCK (separate agent) → fixed
Reviewer reproduced in headless Chrome: F-1 Critical admin Home "flagged" card (no click) · F-2 Copilot answer + proposal preview · F-3 Why? popover · F-4 bulk preview · F-5 audit log + Copilot log · S15.2-3 payment fields (staff → admin) · Money (Medium): move-in retry could double-post when the server saved but the 4G reply was lost.
Fix 13e64cf: broad escaping pass (every DB text field in HTML; JSON-encoded onclick string args), lost-reply check on retry. xss gate extended with every reviewer door: **against 82e250a → FAIL on 21 screens; 13e64cf → PASS 68**.

### D-15-4 — CLOSED (root cause by QA specialist agent, isolated worktree + DB)
Not the dashboard: navigate-then-`setTimeout` openers ("Add expense" → form after 350 ms) fired on whatever screen was showing. Reproduced 5/26 before, 0/41 after. Real user impact: a form popping up on the next screen; a slow "Generate owner report" silently doing nothing. Fix 4794995: `navigate()` resolves true only if the screen is still current; `navigateThen()` replaces timers.

| Run | Source | Result |
|---|---|---|
| G152c | 13e64cf | **12/12 PASS, 2,437** |
| G152d | 13e64cf | **12/12 PASS, 2,437** |
| ui ×3 more | 13e64cf | PASS 791 ×3 (5 consecutive incl. G152c/d) |

New backlog (not fixed):
- **D-15-7 (Medium):** a slow screen's late render can overwrite the screen the user moved to (Home content shown on Rooms with delayed data). ~25 screens; own sprint item.
- **D-15-8 (High, hardening):** admin token lives in localStorage and CSP is off, so any future missed escape = admin takeover. Defence in depth: httpOnly cookie session and/or a CSP once inline handlers are removed.
- **G-1 (Low, test hygiene):** reviewer saw `quick` fail when run after other gates on a shared DB (learned data). The runner rebuilds per sweep; per-gate isolation recommended.

### Sprint 15.2 — review round 2 (same independent agent) of 13e64cf: **APPROVE FOR TEST DEPLOYMENT**
Re-ran 12/12 on fresh DBs (2,436; xss 67 vs 68 — one-assertion gap, recorded). Every resident/public attack from round 1 re-run clean. navigate()/navigateThen() no regression; retry never wrongly skips another resident's or a hand-recorded payment.
**Before production (Sprint 15.3):** R-1 (Med) staff→admin XSS: Resident 360 kv() Address/Emergency/ID type, viewGuest grid, rentHistoryModal name `"`, evening summary `<pre>`, Reports expense category · R-4 (Med, money) retry message tells the warden to "record it later in Collect" → hand double-entry risk · R-6 (Med) resident save with lost reply → retry creates a second resident · R-2 (Low) onclick JSON vs literal `&quot;` in data · R-5 (Low, introduced) inbox search double-escaped · R-3 (Low) raw error messages; guest.html shows staff text raw.

### Sprint 15.3 — independent review of 913a44a: **APPROVE FOR TEST DEPLOYMENT**
Reviewer: 12/12 on fresh DBs, 2,518 (xss Why-button count varies 140/142 — G-2, Low). Every XSS door clean incl. staff doors; no visible double escaping; guest portal shows `&` and `'` correctly. S15.3-1/-2/-4/-6/-7 PASS.
Before production: **T-1 (Med, money/data)** phone typed with spaces/dashes defeats the R-6 lookup → lost reply can still create a 2nd resident (reproduced) · **T-2 (Low-Med)** guest.html ID card prints `emergency_contact_name` raw (reproduced) · **T-3 (Low)** Back still available after a failed save → edited name/phone can duplicate or adopt the wrong resident.
Implementer gates G153c/d: 12/12 PASS ×2, 2,520.

### Sprint 15.4 — independent review of 80c5956: **APPROVE FOR TEST DEPLOYMENT**
Reviewer: 12/12 fresh gate3, 2,536 (xss Why-button variance). T-1 lost reply with digits/space/dash → one resident, one deposit; T-2 payload inert; T-3 400/409 keep Back, 0/500 lock Back and retry adopts; 429 lands as "uncertain" (safe, wrong wording).
Before production: **P-1 (Med)** guest-login compares the typed mobile exactly — "+91…", spaced, "0…" get 401 (Android autofill adds +91); edits now normalise old spaced phones so those residents must use the plain number → normalise `mobile` at login too · **P-2 (Med, pre-existing, OWNER DECISION)** two active residents can share a phone; guest-login takes LIMIT 1 → one can see the other's dues / file a UPI claim on her account · backfill of old phones needs owner approval · Low: apiFetch returns undefined on 401 (wizard can mark a payment saved just before the redirect); landline/foreign numbers with leading 0 become wrong +91 wa.me links.
Implementer gates G154b/c: 12/12 ×2, 2,538.

### Sprint 15.5 — independent review: approved after the A-1 fix
Round 1 (24896ba): APPROVE for Test but **A-1 (Med) regression** — last-10-digit match + LIMIT 1 locked the second resident on a shared number out → fixed in ae16efb before any push.
Re-check (ae16efb): **APPROVE FOR TEST DEPLOYMENT** — 30 combinations (two sisters × two formats × five password states): every login lands on the sister whose password was typed; ties → 409; 409 is not a new enumeration oracle. 12/12 on fresh gate3, 2,550 (xss variance).
Before production: verify on Railway that a changing `X-Forwarded-For` still reaches 429 (limiter depends on the proxy) · Low: LIMIT 5 → a 6th resident on one number gets 401; return the 409 message above 5 · owner calls: forced password change after first login, separate staff/resident limiters, phone backfill, P-2.
Implementer gates G155g/h: 12/12 ×2, 2,552.

### Sprint 16 — independent review (4 rounds)
- 35fc515: **BLOCK** — F16-1 (default bypass by spelling "98…x"), F16-2 (is_active "true" text). Portal flake found by the gate (2/5 new vs 0/5 old): stray background login in the test + two real app bugs (onload re-restore; late jump to Home) — fixed in ecb45a3.
- ecb45a3: **BLOCK** — F16-1b (old hashes of formatted numbers gave a full token) → 299b94c.
- 299b94c: **APPROVE FOR TEST DEPLOYMENT** — 12/12 on fresh gate3, 2,600. Production blocker **F16-1c** (old data): an old hash of a number saved with "." "/" or letters still skips the forced change → force whenever the password's digits contain her number.
Data scripts: reviewer ran both on 15 crafted rows — dry run changes nothing, apply atomic and guarded, re-run changes 0; owner should read both dry-run lists before --apply.
Implementer gates: 12/12 ×2, 2,602.

### Sprint 16.1 — independent review of f90e349: **APPROVE FOR TEST DEPLOYMENT, no code blocker for production**
12/12 on fresh gate3, 2,604 (xss variance). Old hashes of her number in 10 formats incl. "X.X", "+91.X", "X/", "X (s)" all force the change; never-logged-in spellings get 401; new passwords containing her number refused.
Release checklist (not code): verify on Railway that a changing `X-Forwarded-For` still reaches 429 · read both data-script dry runs before `--apply` · resident tokens issued before release stay valid up to 24 h · accepted risk: whoever first logs in with the default sets the password.
Implementer gates: 12/12 ×2, 2,606.

### Sprint 16.2 — independent review of beb6d7e: **APPROVE FOR TEST DEPLOYMENT**
12/12 on fresh gate3, 2,609 (xss variance); no limiter warnings. Account key can't be dodged (+91/0/spaced/numeric/array forms collapse; staff key broader than the route's match). Interactions with address/global limiters and forced change consistent; counts in memory → reset on deploy.
Before production: **settle X-Real-IP from the owner's outside test** — if Railway sets it to one shared internal address, every client shares one bucket (10 failures anywhere pause everyone's address limit) → then drop it · anyone knowing the staff username can keep `admin` paused (~20 tries/15 min; open sessions keep working) → rename the default `admin`, alert the warden when an account pause trips, confirm the default admin password was changed.
Implementer gates: 12/12 ×2, 2,611.

### Sprint 16.2.1 — independent review of 6ebfcb3: **APPROVE FOR TEST DEPLOYMENT**
Revert correct (per-address limiters on req.ip; per-account limits unchanged). 12/12 fresh gate3, 2,609.
**Correction to the implementer's reading:** attempts 1–11 counted together prove a forged XFF cannot change req.ip from the internet, but "the window expired" does NOT explain attempt 12 → 401 (each key's window starts at its own first failure; earlier shared failures would have blocked before 11). More likely: the home public IP changed mid-run (IPv6 rotation / v4↔v6), a restart wiped in-memory counts, or a second replica with its own counter. Before production: confirm Railway runs ONE replica; optional re-run recording RateLimit headers.

### Sprint 16.3 gates
G163d: 11/12 — ui FAIL at 789 (`.room-tile` wait). Traced via GATE_LOG: the step after check 789 is ui.smoke.js:1390 `paletteRunCommand('expense'); navigate('rooms')` — the purchases page's late render overwrites Rooms = **D-15-7** (known, pre-existing; 16.3 does not touch it). 1 failure in 7 ui runs (G163d, G163e, 5 extra). Next sprint fixes D-15-7.
G163e: **12/12 PASS, 2,668**. Mutation: removing the lockout bell fails "the warden is told once … (0)".
Also found by the gate: deleting a staff account with any history returned a raw FK error (pre-existing) → now 409 with the way out (set a new password).

### Sprint 16.4 — independent review (3 rounds)
- 69f9569: **BLOCK** — B16.4-1 (a local `backend/node_modules` symlink was committed); D16.4-a (save helpers redraw after `await` even if she moved away — navSeq must be captured before the await); D16.4-b (navigate's error card painted over the screen she moved to); minor: POST /users did not check the username format. → 950543d, 4895bb0.
- 4895bb0: **BLOCK** — two refreshes missed by the D16.4-a sweep: `markSent` (Outbox "Sent", 600 ms timer) and `approveRentVariance`; should-fix `loadHome(force)` pulled her back to Home after a slow brief; minor: no test for the error card's esc(), numeric username → 500. → c3553ce.
- c3553ce: **APPROVE** — 12/12 on fresh gate3, 2,691. AST check: 46 gates, all first statement, 48 uses; no ungated redraw after an await remains. Mutations M1 (gate off), M2/M2b (Sent timer ungated / checked at set time), M3 (esc off), M5 (old trim) all fail the gate.
Not covered by a test yet (backlog, D-15-7 follow-up): the same-screen clause of refreshGate (M4) and the loadHome guard (M6) pass the gate when removed · `saveRoom` from the Room map refreshes the table view, `setRoomStatus` from Room 360 always refreshes the map · a left screen can still set the bulk-action bar (pre-existing) · moveInSave / checkoutSave / saveRequest navigate to a fixed screen after their await (accepted).
Implementer gates: 950543d 12/12 ×2, 2,682 · c3553ce 12/12 ×2, 2,691. Mutation-checked by the implementer: D16.4-a, D16.4-b, POST /users rule, Sent timer, error-card esc().
Process note: the first D16.4-b test (delayed /purchases fetch) passed with the guard off — pgPurchases catches its own fetch error — found by mutation and rewritten before review.
