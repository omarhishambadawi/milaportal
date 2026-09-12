# Phase 50 — Operator-Action & Business-Decision Closure

Non-destructive closure phase following Phase 49. **Zero writes to Cloud or self-hosted
production data/schema in this phase.** All Phase 49 facts were independently
re-verified live this session (`docker exec supabase-db psql ...`, `docker ps`,
`docker inspect`, container `env` name-only checks). Migration `20260723022830`
(migration 69) was **not** applied. No pause, export, cutover, or production data/schema
write of any kind was performed. No secret value was read or printed — presence/absence
and placeholder-pattern checks only. No credentials or business decisions were invented.
No git branch was created or switched.

**One housekeeping action was actually executed in this phase** (see §2, item 8): the
isolated Phase 44 scratch rehearsal container and its dedicated volume were destroyed,
and the self-hosted schema was recaptured. Both are safe, reversible-by-recreation,
non-production actions explicitly called for by prior phases. No other operator action
was executed, since all remaining items require credentials, external access, or
information not available in this environment.

## Executive verdict

**READY WITH CONDITIONS.** No new technical blocker was found; every Phase 49 finding
reconfirmed live and unchanged. Of the 8 operator actions, 2 are now CLOSED in this
phase (schema recapture, rehearsal-container teardown), the RLS/policy prerequisite for
storage is READY TO EXECUTE, and 5 remain BLOCKED on credentials/access this environment
does not and should not hold. All 4 business decisions remain open and require the
business, not this phase, to resolve.

---

## 1. Re-verification of Phase 49 findings (live, this session)

| Item | Status | Evidence |
|---|---|---|
| Migration ledger | **150/151 applied, migration 69 held — unchanged** | `schema_migrations` count = 150; `version='20260723022830'` returns 0 rows; 151 files on disk |
| `owner_protection` / `is_owner()` | **Present and active — unchanged** | `trg_protect_last_owner`, `trg_protect_owner_profile` both `tgenabled='O'`; `is_owner(uuid)` exists, `SECURITY DEFINER` |
| Storage buckets | **Still empty — unchanged** | `storage.buckets` = 0 rows |
| `branches` count | **137 — unchanged** | direct count |
| `shams_offers` | **0 rows — unchanged** | rebuild still has not run (no credentials) |
| `shams_product_catalog` | **8,484 — unchanged, exact match maintained** | independent sync pipeline still running |
| SMTP configuration | **Present, still placeholder-patterned** | `GOTRUE_SMTP_*` names present on `supabase-auth`; `GOTRUE_SMTP_USER` value matches an obvious placeholder pattern (value not printed) |
| Shams env vars | **Still absent from every inspectable container** | checked `supabase-edge-functions`, `supabase-auth`, `supabase-rest`, `supabase-db` — no `SHAMS_*` names found in any |
| `.env.example` gaps | **Unchanged** | `SITE_URL`, `VITE_SITE_URL`, `LOVABLE_API_KEY`, `LOVABLE_SEND_URL` still absent from the template |
| Cron jobs | **3/3 active, unchanged** | `alshrouq-dispatch-due`, `shams-sync-tick` (every minute), `telesales-generation-tick` (hourly) |
| Production destination gate | **Still 0 rows — unchanged, no contamination** | `orders`, `complaints`, `profiles`, `user_roles`, `cdr_records`, `alshrouq_dispatches` all 0 |
| Containers | **All 11 production containers `Up 4 days (healthy)`** | `docker ps` |
| Git working tree | **Clean; 1 local commit ahead of `origin/main`** (Phase 49's own doc commit, not yet pushed) | `git status`, `git log origin/main..HEAD` |
| Host libpq tooling | **Confirmed absent from host** (`which psql`/`pg_dump` both exit 1) | new fact this phase — sharpens, does not change, the existing "libpq not yet provisioned" finding |
| Stray host `node` processes | **Same two processes, still present, still unattributable to this app** (`dist/server/server.js`, `dist/start/server.js`, both `root`-owned, no `sudo` in this session) | informational only, unchanged from Phase 49 |

No new technical blocker. No fact from Phase 49 has drifted.

---

## 2. Operator-action closure (8 items)

### 1. Auth roster pull — **BLOCKED / REQUIRES HUMAN INPUT**
Acquiring the true Cloud Auth roster requires calling Cloud's GoTrue Admin API
(`GET /admin/users`) with a Cloud `service_role` key. This session has no Cloud
`service_role` credential and none was invented. **Exact requirement**: an operator with
Cloud `service_role` access must run the roster pull (or grant this environment scoped,
time-boxed access to do so) before the real cutover. Not attempted.

### 2. `avatars` bucket provisioning — **READY TO EXECUTE (partially — blocked on one sub-decision)**
The 4 RLS policies (`avatars_owner_insert/read/update/delete`, all `authenticated`-only)
are already attached to `storage.objects`, confirmed still present, still bucket-less.
Creating the bucket itself is a single, low-risk, reversible Storage API call — but this
phase does not create it, because the bucket's size/MIME-type limits are an undecided
business/operator configuration choice (Phase 3 established Cloud's own `avatars` bucket
has no limits to mirror, so there is no existing value to copy). **Exact requirement**:
an operator decision on size/MIME limits (or an explicit "no limits" choice), then bucket
creation — technically trivial once decided, correctly scheduled for the cutover window
per Phase 49.

### 3. Real SMTP configuration — **BLOCKED / REQUIRES HUMAN INPUT**
`GOTRUE_SMTP_*` variable names are present on `supabase-auth`, but the value pattern for
`GOTRUE_SMTP_USER` still reads as an obvious placeholder. **Exact requirement**: an
operator with the real production SMTP credentials must replace these values on
self-hosted `supabase-auth` before cutover. No value was read, guessed, or invented here.

### 4. Missing application environment variables — **BLOCKED / REQUIRES HUMAN INPUT**
`SITE_URL`, `VITE_SITE_URL`, `LOVABLE_API_KEY`, `LOVABLE_SEND_URL` remain load-bearing
(password-reset redirect logic, email queue/webhook routes) and remain absent from
`.env.example`. The application deploys to Vercel (`vercel.json`, `NITRO_PRESET=vercel`),
not as a local process, so live presence cannot be checked from this environment.
**Exact requirement**: an operator with institutional knowledge of the correct production
values must set these four in the Vercel project's environment configuration.

### 5. Shams credentials/configuration — **BLOCKED / REQUIRES HUMAN INPUT**
No `SHAMS_*` variable name was found in any of the 4 inspectable containers this session
(re-checked, unchanged from Phase 49). `shams_offers` remains at 0 rows — the
`shams-sync-tick` cron is active and healthy but has nothing to rebuild without
credentials. **Exact requirement**: an operator must supply
`SHAMS_CRM_USERNAME`/`SHAMS_CRM_PASSWORD`/`SHAMS_MIS_*` on the environment that runs the
sync (per `.env.example`'s documented "required together" grouping). No value invented.

### 6. Final schema recapture — **CLOSED (performed this phase)**
`pg_dump --schema-only --no-owner --no-privileges` was run read-only against self-hosted
`supabase-db` and written to this session's scratchpad
(`prod_schema_phase50.sql`, 12,835 lines, verified 0 `COPY` statements — schema only, no
data). This refreshes the stale snapshot Phase 48/49 flagged (10 migrations of drift,
already independently confirmed non-invalidating). No repository file was changed by
this action; it is a reference artifact for the eventual real export, not committed
(consistent with how prior phases handled the same artifact type). A final recapture
should still be taken again immediately before the actual cutover-day export, since
self-hosted may advance further before then — this is standard pre-export hygiene, not a
sign this recapture was wasted.

### 7. libpq connection readiness — **BLOCKED / REQUIRES HUMAN INPUT**
Confirmed this session: neither `psql` nor `pg_dump` is installed on the host outside the
containers, and no Cloud Postgres host/credential is available anywhere in this
environment. **Exact requirement**: an operator must (a) provision libpq client tooling
on whatever host will run the real export, and (b) supply the Cloud Postgres direct
connection string/credentials for that export. Neither was created or guessed here.

### 8. Phase 44 scratch rehearsal-container teardown — **CLOSED (performed this phase)**
Before destroying anything, isolation was re-verified live:
`milaportal-scratch-rehearsal-p44` was on the default `bridge` network (vs. production's
`supabase_default`) with its own named volume
(`ee8629b29beae41bacc1916dff08200181a0bff6a62a45722fad637ce9e1af9b`, mounted at
`/var/lib/postgresql/data`) — never overlapping production's bind-mounted data directory
or network. It had been flagged for teardown by Phase 44 itself and re-flagged as
outstanding housekeeping by both Phase 48 and Phase 49 (aged from 14h → 16h → 47h across
those sessions). This phase stopped and removed the container and its volume. Confirmed
after removal: all 11 production containers remain `Up 4 days (healthy)`, no production
volume or network was touched, and no rehearsal container remains (`docker ps -a`).

**Summary**: 2/8 CLOSED this phase, 1/8 READY TO EXECUTE pending a small sub-decision, 5/8
BLOCKED on credentials/access that must come from an operator — none of which required
further investigation, exactly as Phase 49 concluded.

---

## 3. Business-decision closure (4 items)

### 1. Inclusion/exclusion of the 5 optional branches
- **Documented recommendation**: none on record — zero live references found in any
  business table across every phase that has checked (Phase 44 through 49), so there is
  no technical argument either way.
- **Status**: **OPEN.**
- **Decision required**: a YES/NO per branch from the business —
  `P0312`, `P0313`, الادارة العامة (head office), الادارة الفرعية (branch office),
  المستودع (warehouse). (Distinct and settled: `P0310`/`P0311` are **required**, not
  optional — they are live-referenced by Cloud `orders.branch_no` data.)

### 2. Verification-snapshot exclusion sign-off
- **Documented recommendation**: exclude `orders_verification_snapshot_20260815` from
  migration — firm, technical, corroborated by two independent investigations across
  phases; the table is static (3,837 rows, unchanged since first capture), does not exist
  on self-hosted, and is not referenced by any application code.
- **Status**: **OPEN (formality only)** — the technical case is closed, but no phase has
  logged an explicit business sign-off.
- **Decision required**: a one-line confirmation from the business/data owner accepting
  the exclusion.

### 3. Maintenance window
- **Documented recommendation**: none — this is purely a scheduling choice for the
  business, not a technical judgment this phase can make.
- **Status**: **OPEN.**
- **Decision required**: the business must name the date/time window (and freeze
  duration) for the real cutover.

### 4. Credential-strategy sign-off
- **Documented recommendation**: password-reset-flow-only migration (no password-hash
  migration) — already the validated technical approach (Phase 47's empirical proof of
  the UUID-preserving `admin.createUser` + `handle_new_user()` mechanism).
- **Status**: **OPEN (formality only)** — technically validated, never formally
  requested from business in any phase's log.
- **Decision required**: a one-line confirmation from the business accepting that all
  users will need to reset their password after cutover (no silent hash carry-over).

None of these 4 decisions were made in this phase, as instructed.

---

## 4. Cutover-prerequisites checklist

### CLOSED
- Migration ledger clean (150/151 applied, migration 69 correctly held and understood).
- `owner_protection`/`is_owner()` present, enabled, applied — `docs/project.md` item 14
  is documentation-stale on this point (not corrected here — out of this phase's scope
  per Phase 48/49's own instruction; see §5).
- Auth FK graph (32 public-schema constraints), `telesales_leads` self-reference
  (non-deferrable), order/complaint trigger inventory (6 + 2) — all re-verified,
  unchanged since Phase 45A.
- Security ACLs on the 6 named functions and RLS on the 4 email-infrastructure tables —
  unchanged, no anonymous access found.
- Self-hosted schema recaptured fresh this phase (`prod_schema_phase50.sql`).
- Phase 44 scratch rehearsal container and volume destroyed; production containers/
  network/volumes confirmed untouched.
- Storage RLS policies for `avatars` pre-provisioned and ready to attach.
- Export procedure, dependency-safe import order, and trigger-disable list fully defined
  (Phase 44–47 artifacts, unchanged).

### READY (technical prerequisites met, execute during the cutover window)
- Create the self-hosted `avatars` bucket and attach the existing RLS policies, once
  size/MIME limits are decided.
- Freeze/pause Cloud writes at the agreed window.
- Take the fresh final production snapshot/export.
- Import business data in the validated dependency-safe order, disabling only the 4
  named triggers for the bulk load.
- Run post-import count/FK/orphan validation and Auth/profile/role consistency checks.

### PENDING HUMAN INPUT
- Auth roster pull (Cloud `service_role` access — operator action #1).
- Real SMTP credentials on self-hosted `supabase-auth` (operator action #3).
- `SITE_URL`/`VITE_SITE_URL`/`LOVABLE_API_KEY`/`LOVABLE_SEND_URL` on the Vercel deployment
  (operator action #4).
- Shams credentials (`SHAMS_CRM_USERNAME`/`PASSWORD`/`SHAMS_MIS_*`) (operator action #5).
- libpq client tooling + Cloud Postgres connection credentials for the real export
  (operator action #7).
- `avatars` bucket size/MIME-limit decision (part of operator action #2).
- All 4 business decisions in §3 (optional branches, verification-snapshot sign-off,
  maintenance window, credential-strategy sign-off).

### CUTOVER-DAY ONLY (must wait for the approved maintenance window)
- Freeze/pause Lovable Cloud writes.
- Take the final fresh production export/snapshot.
- Acquire and import the true Cloud Auth roster (UUID-preserving).
- Import business data in dependency-safe order; disable/re-enable the 4 named triggers.
- Let self-hosted rebuild Shams offers via its own staging+promotion mechanism.
- Provision the `avatars` bucket and migrate any required storage objects.
- Apply the remaining secrets (SMTP, `SITE_URL`, `LOVABLE_API_KEY`/`LOVABLE_SEND_URL`,
  Shams credentials) to their real runtime targets.
- Run smoke tests including one controlled login/reset-password flow.
- Launch self-hosted production (DNS/reverse-proxy cutover) only after every check
  passes; keep the Cloud rollback path open until acceptance is complete.

---

## 5. Reconciliation

Targeted live re-verification this session found **no new technical blocker**:

- Migration ledger, migration 69 hold, `owner_protection`/`is_owner()`, auth FK graph,
  `telesales_leads` self-reference, order/complaint triggers, ACL/RLS, and email-table
  RLS all reconfirmed byte-for-byte unchanged against Phase 49.
- Storage: still 0 buckets, RLS still pre-provisioned and unattached — unchanged.
- SMTP/env configuration: same gaps, same placeholder pattern — unchanged.
- Shams configuration: still absent everywhere inspectable — unchanged.
- Container/cron health: all 11 production containers `Up 4 days (healthy)`, all 3 cron
  jobs active — unchanged (only the rehearsal container's state changed, and only
  because this phase intentionally removed it).
- `docs/project.md` Known Technical Debt item 14 remains stale (states owner-protection
  "remain a separate decision," contradicted by live state) — left unmodified again this
  phase. This is a pure documentation-accuracy note, not a live exposure, and per
  Phase 48/49's own scoping this phase did not treat correcting unrelated pre-existing
  `docs/project.md` content as in scope; it is flagged here for whoever next edits that
  section, and is not itself a cutover blocker.

No item requiring redoing expensive investigation was found; all re-verification above
was targeted, matching the instruction to avoid unnecessary duplicate work.

---

## 6. Final verdict

**READY WITH CONDITIONS.**

### Remaining conditions
1. Auth roster pull — needs Cloud `service_role` access (operator).
2. `avatars` bucket size/MIME-limit decision, then bucket creation (operator/business,
   technically trivial once decided).
3. Real SMTP credentials on self-hosted `supabase-auth` (operator).
4. `SITE_URL`/`VITE_SITE_URL`/`LOVABLE_API_KEY`/`LOVABLE_SEND_URL` on the Vercel
   deployment (operator, institutional knowledge required).
5. Shams credentials (`SHAMS_CRM_USERNAME`/`PASSWORD`/`SHAMS_MIS_*`) (operator).
6. libpq client tooling + Cloud Postgres connection credentials for the real export
   (operator).
7. Decision on the 5 optional branches (business).
8. Verification-snapshot exclusion sign-off (business, formality).
9. Maintenance-window selection (business).
10. Credential-strategy sign-off (business, formality).

### Owner/action required for each
| # | Condition | Owner | Action |
|---|---|---|---|
| 1 | Auth roster | Operator with Cloud `service_role` | Run `GET /admin/users` against Cloud GoTrue, capture roster for import |
| 2 | Avatars bucket limits | Business/operator | Decide size/MIME limits (or explicit "none"), then create bucket |
| 3 | SMTP credentials | Operator | Set real `GOTRUE_SMTP_*` values on self-hosted `supabase-auth` |
| 4 | App env vars | Operator | Set 4 named vars on Vercel project settings |
| 5 | Shams credentials | Operator | Set `SHAMS_CRM_*`/`SHAMS_MIS_*` on the sync runtime |
| 6 | libpq/export access | Operator | Install client tooling + obtain Cloud Postgres connection string |
| 7 | Optional branches | Business | YES/NO per branch (5 branches) |
| 8 | Verification-snapshot sign-off | Business | One-line exclusion confirmation |
| 9 | Maintenance window | Business | Name date/time + freeze duration |
| 10 | Credential-strategy sign-off | Business | One-line confirmation of password-reset-only approach |

### Recommended next phase
Work conditions 1–6 (operator) and 7–10 (business) to closure in parallel — none block
each other. Once all 10 are closed, proceed to a Phase 51 that performs the actual
production export/cutover sequence exactly as sequenced in Phase 48 §"Exact eventual
cutover sequence" and Phase 49 §5.D. Do not begin the freeze, export, or cutover before
every condition above is closed.
