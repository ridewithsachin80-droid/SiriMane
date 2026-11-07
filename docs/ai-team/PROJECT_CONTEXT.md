# Siri Mane — Project Contract (AI Engineering Team Framework 2.0)

Adopted: 7 November 2026 · Owner: Sachin (ridewithsachin80-droid) · Framework version: 2.0

This file is the project contract required by `AI-Engineering-Team-Master-Framework.md` §3.
It records **verified facts**, not aspirations. Anything marked UNKNOWN or MISSING is a real gap.

## Project

```yaml
project:
  name: "Siri Mane PG (sirimane.in)"
  mode: "existing"
  goal: "Stable, user-friendly, AI-first PG management app for one ladies' PG in Tumakuru"
  in_scope:
    - Continue the sprint programme (Sprints 0–14.4 delivered; Sprint 15 not yet scoped)
    - Work on the approved test branch only
  out_of_scope:
    - Anything touching main or the Railway production service
    - Multi-PG tenancy, inventory, vendor management, Web Push, SOS, AI workflow builder (owner decision, standing)
  acceptance_criteria:
    - All eleven gates green on a Postgres rebuilt from the migration scripts (api, ai, assistant, owner, copilot, finance, notify, bulk, quick, ui, portal)
    - Changed screens exercised in headless Chrome at 360px and 390px
    - Money rules unchanged unless called out with before/after on sample data

repository:
  identity: "ridewithsachin80-droid/SiriMane"
  approved_remote: "https://github.com/ridewithsachin80-droid/SiriMane (GitHub, public, no embedded credentials)"
  test_branch: "ai/test"
  baseline_sha: "48deac233fcafe667b4977d344106fff62b301a5"   # main, 17 Sep 2026, "Add files via upload" — contains Sprints 0–14.4
  work_branch_prefix: "ai/"
  registered_work_branches: ["ai/test", "ai/sprint-15", "ai/sprint-15-1", "ai/sprint-15-2"]   # ai/sprint-15: candidate branch for Sprint 15, not deployed; merged into ai/test only after G3
  forbidden_refs: ["main"]                                       # Railway deploys main → production
  integration_method: "pull-request (base: ai/test)"
  integrator: "DEV (single integrator; preserved)"

environment:
  local_test_workspace: "/home/claude/sirimane (clone of the baseline) + a throwaway Postgres 16 on a private socket"
  test_service_id: "Railway project f4e6997d…, service c2930e96…, environment Test (ae09e94e…)"
  test_environment_id: "ae09e94e-0f95-4220-be97-ca98d39565c6"
  test_url: "https://sirimane-test.up.railway.app"
  test_database_identity: "local scratch DB only, rebuilt per run from backend/scripts/migrate-all.js; NEVER the Railway DATABASE_URL"
  integrations: "Gemini/Groq disabled in gates (keyless) or stubbed via ai.providers._stub; WhatsApp is wa.me links only — nothing sends itself"
  production_access: "PROHIBITED"

authority:
  requested_scope: "Adopt framework 2.0; create and push the test branch; continue authorized work there"
  test_branch_push: "authorized by owner on 7 Nov 2026; performed once (ai/test → d1641eb). NOTE: write access turned out to be unrestricted — see §Safety facts"
  test_branch_merge: "not_authorized until a PR is reviewed"
  test_deployment: "authorized — Railway auto-deploys ai/test to the Test environment"
  spending_limit: "no new paid commitments"
  phase_progression: "automatic within authorized scope after required gates"
  owner_decisions_reserved:
    - "Anything that reaches main or production"
    - "Adding a dependency"
    - "Any file rename or deletion"
    - "Changes to how money is computed"
    - "Bulk cap 15 / second confirm above 8 / skip reminded-in-7-days / staff may draft & assign only (Sprint 13)"
    - "Quick Entry: ask mode, ask 'for what?', learn + model (Sprint 14)"

verification:
  required_checks:
    - "node backend/scripts/migrate-all.js && node backend/scripts/seed.js on a fresh scratch DB"
    - "node backend/test/{api,ai,assistant,owner,copilot,finance,notify,bulk,quick,ui,portal}.smoke.js"
  manual_checks:
    - "Sachin tests on a real Android phone (warden) and a resident's phone (Rakshitha B, Room 208) and sends screenshots"
  supported_platforms: ["Android Chrome 360px/390px", "desktop Chrome"]
  independent_review_required: false   # single-agent session; see execution.mode. Owner's phone test is the independent check.
  full_regression_at_phase_completion: true

execution:
  mode: "LIMITED MULTI-AGENT (from Sprint 15): one implementing agent; separate subagents for UX review and independent code review. Earlier phases: SINGLE-AGENT SEQUENTIAL ROLES"
  agent_roster:
    - "One Claude session performs PM, ARCH, DEV and QA as visibly separated passes. Review is SELF-REVIEW and is labelled as such. Subagents are available for read-only exploration but are not independent reviewers of this agent's code."
  specialist_assignments:
    - role: AI
      assignee: same agent (named pass)
      trigger: Quick Entry classifier, voice repair, category model fallback
      state: ACTIVE across sprints 14.x
      review: REQUIRED for any change to backend/services/quick.js or copilot.js — gate: G3
    - role: SEC
      assignee: same agent (named pass)
      trigger: privacy (what the model sees), forged-tap/execute boundary, role checks
      state: ACTIVE
      review: REQUIRED for any change touching tools.js, copilot.js, auth — gate: G3
    - role: DATA
      assignee: same agent (named pass)
      trigger: any migration, any change to money computations
      state: NOT NEEDED for this adoption commit
      review: REQUIRED whenever a migrate-*.js is added — gate: G1/G3
    - role: UX
      assignee: same agent (named pass)
      trigger: new screens; dark-mode contrast (two real defects found this way in Sprint 13/14)
      state: NOT NEEDED for this adoption commit
      review: ADVISORY unless the ui gate contrast sweep fails
    - role: OPS
      assignee: same agent (named pass)
      trigger: Railway/branch routing
      state: COMPLETED for G0 (findings below)
      review: REQUIRED before any remote push — gate: G0
  adopted_framework_version: "2.0"
  task_and_time_budget: "one sprint item per bounded package; full gate sweep per delivery"
```

## Safety facts — verified 7 Nov 2026 (OPS/SEC pass, G0)

| Control | State | Evidence |
|---|---|---|
| Remote identity | VERIFIED | `gh api repos/…` → `ridewithsachin80-droid/SiriMane`, public, default branch `main` |
| `main` is production-linked | VERIFIED | `railway.toml`/`nixpacks.toml` start `node backend/server.js`; Railway auto-deploys on push to `main` (owner's standing workflow) |
| GitHub Actions | VERIFIED NONE | `actions/workflows` → `total_count: 0`; no `.github/` directory |
| Git hooks / lifecycle scripts | VERIFIED NONE | no `.husky`, no `pre*`/`post*` npm scripts; `install` runs `npm install` only |
| Server-side protection on `main` | **VERIFIED (7 Nov 17:41)** — ruleset 26756000 "Main", active, target `~DEFAULT_BRANCH`, bypass list empty; GitHub enforces on `main`: deletion, non_fast_forward, creation, pull_request (0 approvals). `ai/test` has no rules. Limit: anyone with write access can still open and merge a PR via the API — direct pushes and force pushes are blocked. Previously: **MISSING** | `branches/main/protection` → 403 "not accessible by integration" (cannot read); `rulesets` → `[]` (empty). No ruleset exists; a classic protection rule may or may not — treat as MISSING |
| Write access from this AI session | **PRESENT and UNRESTRICTED** | `add_repo` *reported* `push_check: refused`, but `git push origin ai/test` succeeded. The session credential can write any ref, **including `main`**. Nothing on the GitHub side would have stopped a push to `main`. |
| Separate test deployment | VERIFIED | Railway `Test` environment deploys `ai/test` to its own Postgres (empty on first boot) |
| Production DB reachable from here | VERIFIED NO | no `DATABASE_URL` in this session; gates use a local scratch Postgres |

**Consequence (confirmed by a real push, not inferred):** today the only thing preventing an AI session from deploying to production is *instruction*. The framework (§4.2) is explicit that this is not a security guarantee. See HANDOFF.md for the two owner actions that close it.

## Standing project rules (from the Project Instructions — these are stricter than the framework and win)

- Never push or change anything on GitHub without Sachin's explicit permission.
- Deliveries are delta zips laid out under `SiriMane-main/` with exact destination paths.
- Schema changes additive only, each in a new `backend/scripts/migrate-<feature>.js`, wired into `migrate-all.js`.
- Money is sacred; `pending_verification` never counts as income.
- No file renames or deletions without agreement.
- Vanilla HTML/CSS/JS frontend, Express + pg backend, no new dependencies without stating cost.
- Test gate before every zip; never claim a test passed that did not run.
