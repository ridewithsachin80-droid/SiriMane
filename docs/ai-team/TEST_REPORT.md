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

### Sprint 17 — independent review (2 rounds)
- 6f8a498: **BLOCK** — S17-3 the real "Table" button calls pgRooms without navigating, so table saves redrew the map (test used a navigate no button does); S17-1 a request still with a turned-off assignee could not be saved/closed, and the request sheet still listed turned-off accounts (stale cache); S17-4 `APP_PATHS` was case-sensitive while Express routes are not — `/MANAGEMENT` served the staff page with the home (GA) policy. Should-fix: the ui CSP check was reset before the leak test (early violations lost); the deferral note overstated the protection (navigation leak). Minor: GA4 `*.googletagmanager.com`; checklist/bulk guards untested; two-admin turn-off race; turned-off right password counted against the shared login limit; visible "Remove". → 6498749.
- 6498749: **APPROVE** — 12/12 ×2 on fresh gate5, 2,773. Real flows re-driven at 360/390 (Table→Edit→Save stays on table; Table→Delete; nav away and back resets to map). Race probe: 40 simultaneous mutual turn-offs → 0/40 both-off with the lock vs 38/40 without. Mutations N1–N10 caught; N11 (caller re-check) has no automated test — covered by the manual race probe.
Backlog from review: `pool.connect()` outside try/catch in setDisabled (same pre-existing pattern at index.js ~1971) — an unhandled rejection if the DB is down · quick Table/Map double tap can draw the older response (pre-existing drawSeq root cause) · missing asset paths serve home.html (pre-existing catch-all).
Implementer gates: 6f8a498 12/12 ×2, 2,747 · 6498749 12/12 ×2, 2,773. Implementer mutations: 7 (round 1) + 8 (round 2), all caught; one test rewritten after its mutation survived (sheet cache).
Release: run `node backend/scripts/migrate-all.js` after Online (adds users.disabled_at); check Google Analytics Realtime on the home page.

### Hotfix 17.1 — Google Analytics blocked on the home page (production, 9 Nov)
Owner's console on sirimane.in: `connect-src` blocked `www.google.com/g/collect` (GA4 property linked to Google Ads). Fix f3703a5 adds Google's published "GA with Ads-related endpoints" hosts to the HOME policy only (*.google.com, *.google.co.in, *.g.doubleclick.net, pagead2.googlesyndication.com; frame-src googletagmanager). App policy byte-identical.
Review: **APPROVE** (1 round). Browser check: g/collect, ccm/collect, ga-audiences, stats/googleads doubleclick, pagead2, GTM iframe now allowed on `/`; all still blocked on /MANAGEMENT; 41 paths × GET/HEAD, 0 policy mismatches. Mutations m1–m4 caught.
Gates: 10/12 green; api and notify stop at the D-15-2 date checks between 18:30–24:00 UTC — identical on the parent af6f6b7. With node's clock shifted 7 h (dates agree), api 418 and notify 64 pass on the hotfix (parent 416 / 64).
Accepted residual risk: `*.google.com` on the home page is another possible exfiltration endpoint; equivalent paths (own GA property, own GTM container, navigation) were already open — real fix is D-17-1 (token out of localStorage) or a separate origin for the home page. Other-country Google domains (e.g. google.ae) still blocked for ga-audiences — console noise only.
D-15-2 is a real app bug, not test-only: between 00:00–05:30 IST the server's "today" is yesterday (dashboard computes today as a UTC date in node; DB CURRENT_DATE is UTC) — affects early-morning checklist ticks and maintenance dates. Recommended as the next sprint.

### Sprint 18 — one clock (D-15-2): implementer evidence
**Root cause.** Railway's Node and Postgres run in UTC. Between 00:00 and 05:30 IST: `new Date().toISOString()`, `CURRENT_DATE`, `NOW()` used as a date, `col::date` on stored time stamps, and the phones' `nowDate()` all gave **yesterday**. The database session time zone is deliberately left alone: 58 `timestamp without time zone` columns hold UTC wall-clock time.

**MONEY — before/after (measured, not estimated)**
| Case | Before | After |
|---|---|---|
| Collection form default date, entered 01:00 IST on 1 Dec | 2026-11-30 (counted in November) | 2026-12-01 (December) |
| Additional-deposit `collection_date` written by the server at 01:00 IST on 1 Dec | 2026-11-30 | 2026-12-01 |
| Rent ledger of a resident (₹6,000/month, joined 1 Sep, paid Sep–Nov) at 01:00 IST on 1 Dec | months Sep–Nov, balance ₹0 | months Sep–Dec, balance −₹6,000 (same as both versions show from 05:30) |
| Year-to-date report range on an IST phone (any hour) | 2025-12-31 … today | 2026-01-01 … today |
| YTD income with sample collections ₹6,000 on 2025-12-31 and ₹5,000 on 2026-01-05 (report's own WHERE clause) | ₹11,000 | ₹5,000 |
Also moved to India's date: dashboard "income/expenses this month", the resident UPI claim's `collection_date`, checkout `leave_date`, rent-change effective date, report default month, balance-sheet `asOf`, trend end month. Existing rows are untouched; `pending_verification` handling is unchanged.

**Found on the way.** Checkout reminders had never been drafted: pg returns a DATE as a JS Date and `String(date).slice(0,10)` gave "Wed Nov 11", which never compares ≤ "2026-11-15". Fixed (date as text); reminders cover today … +7 days.

**Test harness.** `backend/test/fakeclock.js` (new, test-only) shifts `Date` in Node and in every browser page; Postgres runs on libfaketime in a separate UTC cluster (port 5436, like Railway). Browser pages now emulate Asia/Kolkata like every phone at the PG. Test fixtures write India dates (CURRENT_DATE → IST; `daysAgo()` in quick/bulk). The outbox test no longer depends on the day of the month (a resident leaving within a week guarantees a draft; the overdue follow-up is asserted only from the 7th).
Process note: two early sweeps (1 am / 14:00) were contaminated by an earlier faked-clock batch still running on the same cluster and were discarded and rerun alone.

**Mutations (at 01:00 IST on 1 Dec), all caught:** ledger on the UTC month (assistant: "Kavya (settled) not listed") · screens' today = UTC date (ui) · SQL today = CURRENT_DATE (api: "additional deposit is dated India's today, got 2026-11-30") · year-to-date from 31 Dec (ui: S18-3).

Backlog from this sprint: visitors' `expected_at` is stored as India wall-clock (typed by the resident) while `checked_in_at` is UTC wall-clock — handled per column here, but should be unified · quick-entry category guesses learn from purchases other suites saved (order-dependent test; G-1) · `CURRENT_DATE` remains only as column defaults (`collections.collection_date`, `purchases.purchase_date`, `room_inspections.inspected_on`) — every insert in the app passes the date explicitly (scanned), so the default is never used.
**Implementer gates on f5ea735 (12/12 each, run one at a time):** 01:00 IST on 1 Dec 2,793 · 14:00 IST 2,791 · 23:45 IST 2,791 · real clock (≈02:10 and 02:15 IST, inside the window) 2,791 ×2. (ui has two extra assertions on the 1st of a month.)

### Sprint 18 — independent review round 1: **BLOCK** (4a2ebac) → fixes 85b11d1
- **Blocker:** POST /collections and /purchases with a blank date used `new Date()` (UTC date) — and a blank-date collection skipped the closed-day lock (measured: stored on a closed 30 Nov at 01:00 IST on 1 Dec, 201). Now India's today, and the lock checks it. My "every insert passes the date explicitly" claim was wrong: the scan only looked for omitted columns, not `x || new Date()` fallbacks.
- Should-fix: the ledger end month used local getters on a shifted instant — right only with Node in UTC (wrong from 18:30 IST on the last day with Node in IST). Now built from India's date string; verified identical with Node TZ=UTC and TZ=Asia/Kolkata at 23:30 IST 30 Nov (Sep–Nov) and 01:00 / 06:00 IST 1 Dec (Sep–Dec). server.js pins TZ=UTC.
- Should-fix: dashboard month income and the UPI claim date had no test (mutations survived) — tests added; mutations R1–R3 now caught. Rent-due PDF "As of" in India's date. Screens on a non-India phone: one ui pass on America/New_York (R4 caught). Checkout reminders: +10 days and past dates not drafted; date named plainly.

**MONEY — more before/after (measured on sample rows, UTC session like Railway, event at 01:00 IST on 1 Dec)**
| Case | Before | After |
|---|---|---|
| Deposit refund saved at 01:00 IST 1 Dec — its day | 2026-11-30 | 2026-12-01 |
| Owner report refunds, November / December (₹4,000 refund) | ₹4,000 / ₹0 | ₹0 / ₹4,000 |
| Balance sheet as of 30 Nov includes that refund | yes | no (it happened on 1 Dec) |
| Dashboard "income this month" (₹5,000 on 20 Nov, ₹6,000 on 1 Dec) | ₹5,000 (November) | ₹6,000 (December) |
| Resident UPI claim date | 2026-11-30 | 2026-12-01 — status `pending_verification` either way, never income |
| Collection / purchase saved with a blank date | 2026-11-30, could land in a closed day | 2026-12-01; refused if that day is closed |
- fba857c: **APPROVE** (round 2). Reviewer: 12/12 on the real clock (03:26 IST, inside the window) 2,802; faked 01:00 IST 1 Dec 2,804; faked 00:30 IST 1 Jan 2027 2,804. Blank-date matrix at 01:00 IST 1 Dec with 30 Nov closed: blank/missing/null → 201 dated 1 Dec; explicit 30 Nov → 409; blank after closing 1 Dec → 409. Ledger agrees with Node in UTC and IST at five times around the boundary. Mutations R5 (lock on explicit date only), R6 (no lower bound on checkout reminders), R7 (month picker on phone clock) caught.
Minor, backlog: the 409 text says "record this against today" even when today is the closed day · the non-India-phone ui pass does not cover post-save month navigation or the move-in duplicate lookup (correct by reading) · with TZ pinned to UTC, a Node-time-zone bug can no longer be caught by a test (the ledger no longer depends on it).

### Sprint 19 — login in an HttpOnly cookie (D-17-1): implementer evidence
- Staff `sm_staff` / resident `sm_guest`: HttpOnly, SameSite=Strict, Path=/api, Secure when the request is HTTPS (trust proxy 1). Staff Max-Age 8 h; resident 24 h when "keep me signed in", otherwise a browser-session cookie. The token is still in the login response body for API clients; the screens no longer store it.
- Anti-forgery: a write authenticated by cookie needs `X-Requested-With: sirimane` (else 403). Bearer-header requests (gates, Copilot/bulk internal calls) are unaffected. CORS unchanged: no credentials, and the header is not allowed cross-origin.
- Old phones: stored tokens are deleted on load; with no cookie the first request is 401 → login screen once (tested, no reload loop).
- User-visible: none intended. Note: "keep me signed in" was labelled 30 days but the token always lasted 24 h; the 24 h is kept (a longer life needs server-side revocation first — backlog D-19-1).
- Test changes: three in-page logins (ui) moved into the test process — with cookies, logging in inside the admin's page correctly replaces the admin's session. xss count 141 vs 147 at 06:40 IST is time-of-day dependent (Why? buttons) — the Sprint 18 code gives 141 at the same hour.
- Mutations: M1 cookie readable (api + portal caught) · M2 no anti-forgery check (api) · M4 resident token stored again (portal) · M5 Copilot forwarding only a header for cookie users (ui) · M3 removing the top-level old-token delete survives — equivalent: the 401 path also deletes it, and S19-5 checks it is gone.
- Gates on bd3fe4d: 12/12 ×2, 2,833 each (api 445, ui 902, portal 250, xss 147).
### Hotfix 19.1 — public guest lookup leaked password hash and ID number (SECURITY)
Found by the Sprint 19 independent review: `GET /api/guest-lookup` needed no login and returned `SELECT g.*` for any phone number — her bcrypt password hash and ID-proof number included. Present since the first upload; no screen calls it. Fix a381906: `auth, requireAdmin`, named columns only (no hash, ID type/number or address). Route deleted in hotfix 19.2 (owner approved, 9 Nov).
Review: **APPROVE**. Express route walk (177 routes): without a login only /auth/login, /guest-login, /guest-message, /health and pages. Live scan, 85 GET routes × (no login, resident A, staff, admin) with B's ids: nothing leaks without a login or across residents. Mutations (public again, g.* back, requireAdmin removed) caught. Gates 12/12 ×2 (implementer) + ×1 (reviewer), 2,805.
Follow-up for Sprint 19: staff logins receive residents' `password_hash` from /dashboard, /guests, /guests/:id and two `RETURNING *` routes — to be stripped. Backlog: /guest-portal shows every active announcement, ignoring room/floor targeting.

### Sprint 19 — review round 1: **BLOCK** (7ee1c2c) → fixes 203b67a, 895e51e (+ hotfix 19.1 merged in)
- Blocker (pre-existing): public `/api/guest-lookup` leaked password hash + ID number — shipped separately as hotfix 19.1 (approved, PR #23) and merged into this branch.
- Token was still in the login / change-password response body → omitted when the request comes from the app's screens (X-Requested-With); API clients still get it.
- A cookie could outlive the screen (new tab on a shared phone; expired remembered session) → both screens end any cookie session on load when they show nobody logged in; logins wait for it.
- Logout with a wrong cookie path passed every gate → tests now assert `Path=/api` on the clearing header and that logging out through the screen drops the cookie.
- The "no reload loop" check could never fail → now counts real main-frame navigations (1–2).
- Resident password change now refreshes the screen's 24 h expiry. A wrong current password no longer logs the warden out.
- From the hotfix review: staff routes sent residents' password hashes (guests.* / RETURNING *) → one filter on every /api response drops `password_hash`; ID numbers kept.
- Mutations N1–N4 (token in screen responses, wrong logout path, resident cookie outliving the screen, wrong password logging out) and the no-filter mutant all caught.
- Gates on 895e51e: 12/12 ×2, 2,862 each (api 458, ui 908, portal 260).
Backlog: `/guest-portal` lists every active announcement, ignoring room/floor targeting (`noticeWhere()`), D-19-1 a real 30-day "keep me signed in" needs server-side session revocation first.
- 051dcce: **APPROVE** (round 2). Reviewer: 12/12 ×2 on fresh gate9, 2,862 each; browser probe 32/32 (cookie flags, cross-site and same-site-other-origin forgery attempts, WhatsApp-style links, forced first-login change, cookie swap, logouts, old phones). Mutants: filter skipping arrays caught; staff stale-cookie clear never logging out and resident login not awaiting the clear survive the gates (probe caught the first; the second needs a slow logout reply).
Backlog (minor): a 401 from /auth/change-password caused by an expired cookie or a turned-off account now shows "Invalid token" instead of logging out (throw only for "Current password is incorrect") · ui test for the staff stale-cookie clear · blank line splits a comment in server.js.
### Hotfix 19.2 — remove the guest lookup; every resident chooses a new password
Owner, 9 Nov 07:55: "Yes for both" (delete the route; ask residents to change their password).
- `GET /api/guest-lookup` removed (404 from the API catch-all).
- `guests.must_change_password` (additive, `migrate-password-refresh.js`). A flagged resident logs in with her CURRENT password and gets the existing restricted first-login token (`pwc`, 1 h, change-password only) with `password_reason: 'refresh'`; the screen says the PG is asking everyone. Password and flag are written in one statement; before the migration the password alone is saved.
- `backend/scripts/require-password-change.js`: dry run by default; `--apply` flags active residents only; re-running says "Nothing to do" or warns it re-asks anyone who changed since.
- Review: **APPROVE** (adfe73…): flagged token gets 403 on every resident route and 401 on staff routes; wrong/other passwords refused; unflagged residents unchanged; shared-number path unchanged; checked-out residents get 401 and are never flagged. Mutations: flag not cleared, full token instead of restricted, 42703 tolerance removed — caught; `--apply` flagging checked-out residents survived → test added.
- Fixes folded in after the review: duplicate `guests` key in schema-check (the new column was not actually checked), one-statement update, script messages, the forced-change wording reset for a second resident on the same page, checked-out test.
- Known by design: whoever knows (or cracked) her current password reaches the forced-change screen first; the warden's "Reset app login" is the recovery.
- 22fc983 (19.2 fixes + Sprint 19 merged in): **APPROVE**. Reviewer: 12/12 ×2 on fresh gate12, 2,876 each; merge verified line-by-line (Sprint 19's 697-line diff intact, 19.2 changes intact); cookie probe 33/33 (refresh login → restricted 1 h cookie, remember carried, full 24 h cookie after the change). Mutants M1–M3 killed. Backlog (minor): test for the wording reset (M5 survives), script wording when there are 0 active residents.

### Sprint 20 — AI that keeps working, Admin on a phone: implementer evidence
- Root cause (owner's screenshot, 9 Nov): Groq 404 — `llama-3.3-70b-versatile` retired 16 Aug 2026. With GROQ_API_KEY set, Copilot routing, the quick-entry category model and /ai/parse (voice fill for collections/complaints) called Groq only: their AI step had failed silently since August (rules-only results; voice fill showed "please fill the form").
- `providers.text()`: Groq → Gemini on any failure; Groq skipped 10 min after a failure; ai_actions.interpretation.provider records who answered. Default `GROQ_MODEL=openai/gpt-oss-120b` (with `reasoning_effort: low`) — **not verifiable from the sandbox (no Groq key/network)**; if it is wrong, the fallback keeps everything working and "Test AI connection" shows it.
- Admin tabs wrap (44 px) — mutant without wrap reproduces the owner's screen exactly ("Settings, Copilot log, AI impact" off-screen at 360). Audit Log: five headings over four columns (stray "PAYS") fixed.
- Resident portal notices use the shared targeting rule (`services/notices.js`, new); a room notice no longer reaches other rooms.
- Change-password: only "Wrong current password" keeps the session; an expired/turned-off login logs out.
- Test harness: quick-entry tests reset the skip window when swapping stubs (a simulated outage correctly started it).
- Mutations M1–M6 (no fallback, no skip window, tabs not wrapping, stray heading, portal ignoring targeting, expired login kept) all caught.
- Gates on 9d24462: 12/12 ×2, 2,899 each (api 472, ai 219, copilot 253, quick 195, ui 920, portal 262).

### Sprint 20 — independent review (2 rounds)
- edba5d9: **APPROVE** with should-fixes: the skip window started on any Groq error (a one-off 400, or a Groq-only setup with nothing to fall back to); an empty/cut-off Groq answer counted as success; worst case ~50 s (Groq 25 s + Gemini 25 s); no test pinned what Gemini receives or that quick entry falls back (mutants survived). Minor: Gemini without JSON mode, max_tokens deprecated, invalid tablist role. → 86440ce.
- 86440ce: **APPROVE**. 12/12 ×2 on fresh gate14, 2,907 each. Worst case now ~33 s (8 + 25). Mutants mA2 (extra data to Gemini), mB2 (quick Groq-only), mH (pause without Gemini), mI (cut-off accepted) caught.
Backlog (minor): the probe still starts the skip window in a Groq-only setup (production has both keys) · no test of Gemini's request body (`responseMimeType`) · "+ Add" clipped in Admin → Staff at 360 px (pre-existing) · the Groq model and JSON/reasoning settings are unverified against the live service — "Test AI connection" after release shows it.

### Sprint 21 — she speaks Kannada: implementer evidence
- Root cause (owner's Copilot log screenshots, 9 Nov): every mic used `rec.lang='en-IN'`, so spoken Kannada ("eerulli") reached the server as English words ("heroine", "Erode"), with nothing left to repair. The typed-Kanglish failures in the same screenshots date from 17 Sept and do not reproduce on today's code (probe re-run: "eruli 500rs", "pudina soppu 500rs" → Groceries).
- `SMParse.toLatin` (new, in the shared speech-parser.js): Kannada script → WhatsApp-style Latin, Kannada digits, loan words (ಕ್ಯಾಶ್ → cash, ಯುಪಿಐ → upi, ರೂಪಾಯಿ → rupees, ಫಿನಾಯಿಲ್ → phenyl). Input with no Kannada letters is returned unchanged. It is used by quick.classify, parseCollection, parseComplaint, the purchase-form voice and `/copilot/category`.
- Kannada number words (teens, the one-word hundreds such as ಐನೂರು, ಸಾವಿರದ); Kannada fault phrases; Kannada question words; "-kaayi" → Groceries; more dictionary words (hal, hittu, koli …).
- An item with no amount asks "How much was the …?". The check is every word ∈ Groceries/Cleaning, and the deterministic dictionary is used, never the model.
- Mic language: per phone (`sm_voice_lang`, try/catch). Two buttons switch it: one while listening and one after a result. `language-not-supported` → back to English. Both voice engines share it.
- `POST /copilot/category`: auth, 120-character cap, dictionary and history only (the model is never called; a test proves it).
- Copilot log outcome is in one block; Collect and Complaint voice previews escape what was heard.
- Mutations M1–M7 were all caught:
  - M1 transliteration off;
  - M2 no amount-question;
  - M3 mic hard-coded to English;
  - M4 no purchase-category lookup;
  - M5 old log layout;
  - M6 unescaped preview;
  - M7 category route allowed to call the model.
- UI flake: the second mic tap after the Kannada preview missed 2 of 5 runs. The test now waits for network idle before tapping and has a diagnostic catch, and it then passed 3/3 plus both full runs. The cause was not proven (likely a late re-layout of the preview moving the mic).
- Gates on e19eb58: 12/12 ×2, 3,023 each (Sprint 20 approved at 2,907); quick 280, ui 954.
- **Not verified:** Chrome's real ಕನ್ನಡ output on an Android phone (numbers as digits or words, loan-word spellings). The owner tries it on Test.

### Sprint 21 — independent review round 1: **BLOCK** (e19eb58) → fixes 9be9c8a
- B1 (money): common Kannada amounts were read as confident wrong figures ("ಐದೂವರೆ ಸಾವಿರ" → ₹1,000; "ಇನ್ನೂರ ಐವತ್ತು" → ₹50). Now the -ವರೆ halves, joined tens+ones, hundreds compounds and joining forms are read, and the short forms work before ಸಾವಿರ. A ಸಾವಿರ after an unreadable word gives no amount (she is asked). English "onion hundred" stays ₹100. A regression I found while fixing ("aidu nooru" read as 105) is fixed and tested.
- B2: the "How much was…" question took over typed English ("milk bill", "groceries", "water", "menu", words from old purchase notes). It now uses dictionary items only, with a not-an-item list and no history.
- S1: a spoken item with no amount called the voice-repair model, which could invent an amount. That question is now final, and a test proves 0 model calls.
- S2/S3: Kannada question words now count anywhere in the sentence, and resident names are exempt ("Elli 5000" is a payment again).
- S4: compound Kannada numbers (₹25, ₹75, ₹150, ₹600, ₹700).
- S5: the mic switch now works when browser storage is blocked and when abort() throws.
- S6: a quantity ("5 kg", "ಐದು ಕೆಜಿ", "2 packets") is no longer read as the price.
- Minor: tests now cover -kaayi, the 4-word cap and the CSS. Added more Kannada complaint wordings and leftover words. Short dictionary words no longer stretch ("raveena" → Other). Transliteration goes word by word with NFC. Comment moved.
- Mutations N1–N9 (every fix above removed in turn) are all caught. Quick 362, UI 958.
- Test-only: the fake recogniser could fire onerror before its delayed onstart. The test now waits for "Listening in ಕನ್ನಡ" first; this is the likely cause of the earlier intermittent miss.

### Sprint 21 — independent review round 2: **BLOCK** (9be9c8a) → fixes 0baa5b8, 9a776d0
- Every round-1 finding was verified fixed by the reviewer's probes. Three regressions came from my own rewrite:
  - R1: a full stop after a number ("5000.", "1.5k.") lost the amount or changed it to ₹2;
  - R2: the bare letters "g" and "l" counted as quantities ("6000 g pay");
  - R3: the new suffix rule broke English prefixes ("milkman", "toiletries").
- Fixed:
  - A full stop that is not a decimal point is treated as punctuation.
  - The bare g/l were removed; a glued "500g" or "2l" is still a quantity. A pay-word guard I added turned out to be dead code once g/l were gone (its mutation survived), so I removed it.
  - The suffix rule applies only to the short Kannada words added in S21.
  - The amount's own words are removed before resident matching (a resident named Noora is no longer taken from "ನೂರೈವತ್ತು").
  - A quantity with no price asks how much ("ಹಾಲು ಮೂರು ಪ್ಯಾಕೆಟ್" → "How much was the haalu?").
- A bug I introduced while fixing (operator precedence turned the Kannada grocery list into one word) was caught by the existing tests before commit.
- Test isolation: one quick run collided with a full gate run on the same database, so both were discarded and re-run sequentially.
- Mutations P1–P5 (full stop, bare g/l, suffix scope, amount words in names, quantity strip) were all caught.
- Gates on 9a776d0: 12/12 ×2, 3,133 each (quick 386, ui 958).

### Sprint 21 — independent review round 3: **BLOCK** (9a776d0) → fixes f9cc936, 6e743f4
- All round-2 findings were verified fixed against b79cae1 (full stops, G Pay, English prefixes, amount words kept out of names, quantities asking the price). Across the reviewer's 140+ typed-English phrases, every difference from base is an intended S21 change.
- N1 (money, typed English): a resident named **Noora** got a made-up ₹100. "Noora paid" read ನೂರ (noora, the joining form I added in round 2) as ×100. The reviewer says it was already visible at 9be9c8a but missed in their round-2 report.
- Fixed:
  - "noora" is a number only when another number word follows it.
  - In both quick.classify and the on-device Collect parser, an amount made only of a resident's name words is dropped, so she is asked. This also covers "Ainoor" (500).
- Mutations Q1–Q3 were all caught. Q3 survived at first, then an Ainoor parser test was added.
- Gates on 6e743f4: 12/12 ×2, 3,151 each (quick 404, ui 958).

### Sprint 21 — independent review round 4: **BLOCK** (6e743f4) → fix 950f54b
- N1 was verified fixed ("Noora paid", "Ainoor paid" give no amount; an existing ₹10 for "Priya Das paid" is also gone).
- N2 (money): her name before her amount still added ₹100 ("Noora five thousand" → ₹5,100, also in plain English).
- Fix: a general rule replaces the per-case guards. Every word of every active resident's name is blanked (`SMParse.maskNames`) before any amount is read, in Quick Entry and in the on-device Collect parser.
  - With a resident named Noora, the spaced "noora aivattu" reads as her name + ₹50, which is the pre-S21 result; the joined "ನೂರೈವತ್ತು" stays ₹150.
  - "aidu noora" now gives no amount, so she is asked.
- Mutations T1–T3 caught. Gates on 950f54b: 12/12 ×2, 3,164 each (quick 417, ui 958).
