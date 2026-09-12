# Final Production Cutover — Preparation Document

**Status of this document: PREPARATION ONLY. No cutover step below has been executed.**
Written after Phase 50, incorporating the business decisions confirmed on 2026-09-12
(migrate all 5 optional branches; exclude `orders_verification_snapshot_20260815`;
cutover after 12:30 AM, exact date/time not yet set; password-reset-only credential
strategy). This phase performed **read-only verification only** — every fact below was
re-checked live against the running self-hosted stack this session
(`docker ps`, `docker exec supabase-db psql ...`) and found **unchanged from Phase 50**:
migration ledger (150/151, migration 69 held), `owner_protection`/`is_owner()`, storage
buckets (0), `shams_offers` (0)/`shams_product_catalog` (8,484 exact match), all 3 cron
jobs active, all 11 production containers `Up 4 days (healthy)`, production destination
tables (`orders`, `complaints`, `profiles`, `user_roles`, `cdr_records`,
`alshrouq_dispatches`) all still 0 rows, and the exact trigger inventory on `orders` (6),
`complaints` (2), and the two telesales sync triggers. No Cloud write, no self-hosted
schema/data write, no migration applied, no DNS change, no branch created/switched, no
credential invented, no cutover date/time chosen.

---

## 1. Reconciliation — final prerequisite status (baseline: Phase 50)

| # | Prerequisite | Status | Notes |
|---|---|---|---|
| 1 | Migration ledger / migration 69 hold | **CLOSED** | 150/151 applied, `20260723022830` confirmed absent, unchanged since Phase 48 |
| 2 | `owner_protection` / `is_owner()` | **CLOSED** | Both triggers present, enabled, live-verified this session |
| 3 | Auth FK graph / `telesales_leads` self-ref / order-complaint triggers | **CLOSED** | Live-verified this session, exact names below (§4) |
| 4 | Security ACLs / RLS (6 functions, 4 email tables) | **CLOSED** | Unchanged since Phase 48; one non-blocking low-severity note (unpinned `search_path` on 4 fully-qualified email-queue functions) carried forward, not a gate item |
| 5 | Self-hosted schema recapture | **CLOSED** | Performed in Phase 50 (`prod_schema_phase50.sql`); a further recapture immediately before the real export remains standard cutover-day hygiene, not an outstanding gap |
| 6 | Phase 44 scratch rehearsal container | **CLOSED** | Destroyed in Phase 50, confirmed absent this session, production containers unaffected |
| 7 | Auth roster pull | **REQUIRES OPERATOR INPUT** | Needs Cloud `service_role` GoTrue Admin API access — not available in this environment |
| 8 | `avatars` storage bucket | **REQUIRES OPERATOR INPUT** (RLS is READY) | 4 RLS policies pre-attached to `storage.objects`; bucket itself not created — size/MIME limits still undecided (no existing Cloud value to mirror) |
| 9 | Real SMTP credentials | **REQUIRES OPERATOR INPUT** | `GOTRUE_SMTP_*` names present on `supabase-auth`; `GOTRUE_SMTP_USER` still reads as a placeholder pattern |
| 10 | Application env vars (`SITE_URL`, `VITE_SITE_URL`, `LOVABLE_API_KEY`, `LOVABLE_SEND_URL`) | **REQUIRES OPERATOR INPUT** | Load-bearing, absent from `.env.example`, live app runs on Vercel (not inspectable here) |
| 11 | Shams credentials (`SHAMS_CRM_*`, `SHAMS_MIS_*`) | **REQUIRES OPERATOR INPUT** | No `SHAMS_*` name found in any inspectable container this session |
| 12 | libpq client tooling + Cloud Postgres export credentials | **REQUIRES OPERATOR INPUT** | Host has neither `psql` nor `pg_dump` installed; no Cloud connection string available here |
| 13 | 5 optional branches decision | **CLOSED** | Business confirmed: migrate all 5 (`P0312`, `P0313`, General Administration, Branch Administration, Warehouse) |
| 14 | `orders_verification_snapshot_20260815` exclusion sign-off | **CLOSED** | Business confirmed: exclude |
| 15 | Maintenance window | **REQUIRES OPERATOR INPUT (business)** | Business confirmed "after 12:30 AM" as a constraint only — exact date/time still not chosen; this phase does not choose it |
| 16 | Credential-strategy sign-off | **CLOSED** | Business confirmed password-reset-only, UUID/relationship-preserving, no hash migration |
| 17 | Cloud write freeze | **REQUIRES CUTOVER-DAY ACTION** | Must not happen before Gate B |
| 18 | Final production export/snapshot | **REQUIRES CUTOVER-DAY ACTION** | Must not happen before Gate B |
| 19 | DNS/reverse-proxy switch | **REQUIRES CUTOVER-DAY ACTION** | Must not happen before Gate B |

**Net change from Phase 50**: business decisions 13, 14, and 16 move from OPEN to
CLOSED. The maintenance window (15) is partially constrained ("after 12:30 AM") but not
closed — the exact date/time is still required from the business before Gate A. All 6
operator-credential items (7–12) are unchanged and still open; none of them require
further investigation, only operator execution.

---

## 2. Final cutover runbook (exact ordered sequence — NOT executed)

This sequence is the single authoritative execution order for the eventual cutover. It
consolidates the validated findings of Phases 44–50 into one document. **Steps 2 onward
may not begin until Gate B (§8) receives an explicit `GO`.**

### 1. Pre-cutover checks
1.1. Confirm all prerequisites in §1 are CLOSED or READY FOR CUTOVER (no
REQUIRES OPERATOR INPUT items remain).
1.2. Recapture `prod_schema.sql` fresh (self-hosted, schema-only, read-only) — even
though Phase 50 already did this once, a same-day recapture is standard hygiene since
self-hosted may have advanced further.
1.3. Re-run the same live checks as §"Executive verdict" above (ledger, triggers,
containers, cron, storage) one final time immediately before freeze.
1.4. Confirm the exact maintenance-window date/time has been supplied by the business
(Gate A).
1.5. Confirm rollback plan (§7) and all named operators/approvers are available and on
call for the window.

### 2. Cloud write freeze
2.1. Pause/freeze writes to Lovable Cloud at the agreed instant (exact mechanism to be
selected by the operator performing cutover — e.g., maintenance-mode flag, connection
revocation, or provider-level pause — not decided in this document).
2.2. Record the exact freeze timestamp.
2.3. Confirm no write activity continues after the freeze (spot-check `updated_at`/
`created_at` max values on the highest-traffic tables: `orders`, `order_activity`,
`cdr_records`, `alshrouq_dispatches`).

### 3. Final production snapshot/export
3.1. Using the provisioned libpq/export credentials (§6), take the authoritative final
export of Cloud via direct `libpq` connection (per `phase45_export_runbook.md`'s
methodology), covering every table classified CLOUD→REPLACE, MERGE/RECONCILE, or HYBRID.
3.2. Record final row counts for every exported table and compare against every prior
phase's reconciliation assumption; reconcile any drift found before proceeding.
3.3. This export explicitly **includes** all 7 previously-partitioned branch rows:
`P0310`, `P0311` (already required) plus the 5 newly-approved optional branches
(`P0312`, `P0313`, General Administration, Branch Administration, Warehouse).
3.4. This export explicitly **excludes** `orders_verification_snapshot_20260815` per the
confirmed business decision.

### 4. Cloud Auth roster acquisition
4.1. Using Cloud `service_role` access (§6), call the GoTrue Admin API list operation
(`GET /admin/users`) to acquire the complete, current Cloud Auth roster.
4.2. Record each user's `id` (UUID), `email`, and metadata needed for `profiles`/
`user_roles` reconciliation. **Do not** capture or transport password hashes — the
confirmed strategy is password-reset-only (§5).

### 5. UUID-preserving Auth import (password-reset-only strategy)
5.1. For each Cloud Auth user, call self-hosted GoTrue's `admin.createUser` with the
caller-specified `id` set to the exact Cloud UUID (Phase 47's empirically validated
mechanism — accepted and preserved by GoTrue `v2.189.0`).
5.2. Do **not** supply or migrate any password hash. Users are created without a valid
password and will authenticate for the first time only via the password-reset flow.
5.3. Allow `handle_new_user()` to fire and create the default `profiles`/`user_roles`
row exactly as it does today (default `customer_care` role).
5.4. Upsert the real `profiles` row (name, contact fields, etc.) and the real
`user_roles` row on top of the synthetic default, then delete any stray default role row
left over from the trigger, per the Phase 44-proven sequence.
5.5. Reject/investigate any duplicate-UUID creation attempt — this is expected to fail
cleanly at the database level (`users_pkey` unique violation) per Phase 47's validation;
it must not be forced through.
5.6. Confirm final `auth.users` count matches the Cloud roster count exactly, and every
`profiles`/`user_roles` row's `id` matches its `auth.users.id`.

### 6. Dependency-safe business-data import
Import in the FK-safe order established across Phases 44–46:
6.1. `branches` (reconcile: base 137 self-hosted rows plus the 7 Cloud-only rows —
`P0310`, `P0311`, `P0312`, `P0313`, General Administration, Branch Administration,
Warehouse — all now in scope per the confirmed business decision).
6.2. `telesales_products` (reconcile), `telesales_product_aliases`/`telesales_product_patterns`
(verify identical, no import needed unless drift is found in step 1.3/3.2).
6.3. Auth/profiles/user_roles (already completed in step 5, sequenced here for
dependency completeness — all downstream business tables reference `profiles.id`).
6.4. `orders`, `complaints`, and their activity/dependent tables (CLOUD→REPLACE),
disabling the 4 import-unsafe triggers first (§4 of this runbook).
6.5. `telesales_leads` using the validated two-pass strategy for its non-deferrable
self-referential FK (`telesales_leads_parent_lead_id_fkey`): first pass inserts all rows
with `parent_lead_id` temporarily NULL, second pass updates `parent_lead_id` to the real
value once all rows exist.
6.6. Remaining `telesales_*` transactional tables (customers, activities, followups,
generation runs) per their established CLOUD→REPLACE/MERGE classification.
6.7. `telesales_product_relations` (Cloud 26, human-curated, no enforced FK) — reconcile
by direct copy, no FK validation needed by design.
6.8. `alshrouq_dispatches` (CLOUD→REPLACE) — the `20260820180000_alshrouq_dispatch.sql`
*migration* is already applied on self-hosted and must **not** be manually replayed;
only the *data* is imported here.
6.9. CDR historical data per the hybrid strategy (`phase45_cdr_migration_plan.md`) —
import historical rows, then let the existing Yeastar sync resume for anything after the
freeze point.
6.10. Confirm `orders_verification_snapshot_20260815` is **not** created or imported on
self-hosted at any point in this sequence.

### 7. Trigger handling
See §4 of this document (dedicated section) for the exact list. Summary: disable the 4
import-unsafe triggers only for the duration of steps 6.4–6.5, then re-enable
immediately after. Migration 69 remains held throughout — it is never applied at any
point in this sequence.

### 8. Shams rebuild/sync
8.1. `shams_product_catalog` requires no action — already an exact match (8,484 rows)
via its own independent sync pipeline, unaffected by this cutover.
8.2. Once Shams credentials are configured (§6), allow the existing
`shams-sync-tick` cron job (already active, running every minute) to rebuild
`shams_offers` via its own staging-table + atomic-promotion mechanism
(`20260916120000_shams_offers.sql`). This is a **rebuild/derive**, not a row-for-row
Cloud copy — do not attempt to import `shams_offers` data directly from Cloud.
8.3. Confirm `shams_offers` row count approaches Cloud's live count (was 110,524 at
Phase 48, growing) only as a sanity check, not an exact-match requirement (Cloud
continues to grow independently).

### 9. Storage bucket/object handling
9.1. Create the self-hosted `avatars` bucket (exact name `avatars`) once the
size/MIME-limit decision is made (§1, item 8) — the 4 RLS policies
(`avatars_owner_insert/read/update/delete`) are already attached and require no changes.
9.2. Migrate any required existing avatar objects from Cloud storage to the new bucket,
preserving object paths/ownership so the pre-attached RLS policies resolve correctly.

### 10. SMTP/application/Shams configuration
10.1. Replace placeholder `GOTRUE_SMTP_*` values on self-hosted `supabase-auth` with
real production SMTP credentials.
10.2. Set `SITE_URL`, `VITE_SITE_URL`, `LOVABLE_API_KEY`, `LOVABLE_SEND_URL` on the
Vercel application deployment environment.
10.3. Set `SHAMS_CRM_USERNAME`, `SHAMS_CRM_PASSWORD`, `SHAMS_MIS_*` wherever the Shams
sync runtime reads them.
10.4. Do not print or log any of these values at any point; verify presence by name/
connectivity test only.

### 11. Post-import validation
11.1. Run full count/FK/orphan validation across every imported table
(`phase45_validation.sql` methodology).
11.2. Run Auth/profile/role consistency checks — every `auth.users.id` has exactly one
`profiles` row and one `user_roles` row, no orphans, no duplicates
(`phase46_auth_validation.sql` sections D–G methodology).
11.3. Confirm branch count now includes all 7 newly-required rows (137 + 7 = 144,
matching Cloud's reference count from Phase 48) and that `orders`/`telesales_leads`
FK integrity holds against the newly-added branch rows.
11.4. Confirm the 4 disabled triggers have been re-enabled and are reporting
`tgenabled='O'`.
11.5. Confirm migration 69 is still absent from the ledger.

### 12. Controlled authentication/password-reset test
12.1. Verify SMTP delivery works end-to-end **before** opening the system to real users:
send one test password-reset email through the real SMTP configuration set in step 10.1
and confirm delivery/format.
12.2. Perform exactly one controlled login/reset-password flow using a designated test
or operator account: request reset, receive email, set a new password, log in
successfully.
12.3. Do not skip this step — SMTP presence (name-only) was never confirmed to produce
real deliverable email in any prior phase; this is the first real-world proof.

### 13. Application smoke tests
13.1. Verify core surfaces load and authenticate correctly: Dashboard, Orders,
Complaints, Calls, Branches (including the 7 newly-added branches), Users.
13.2. Verify RBAC/permission checks behave identically to Cloud for at least one account
per role tier.
13.3. Verify Yeastar CDR mirror and AlShrouq dispatch flows are live and functioning.

### 14. DNS/reverse-proxy switch
14.1. Only after every check in steps 11–13 passes, switch DNS/reverse-proxy routing to
point at self-hosted production.
14.2. This step requires explicit Gate B `GO` and is the last irreversible-in-practice
action of the cutover (see §7 rollback plan for what "irreversible in practice" means
here).

### 15. Rollback decision point
15.1. Immediately after the DNS switch, monitor closely for the defined observation
window (§7).
15.2. If any rollback trigger condition is met (§7), revert DNS to Cloud and treat
self-hosted as not yet cut over; Cloud remains authoritative and untouched up to the
freeze point.
15.3. If no rollback trigger fires within the observation window, declare cutover
accepted.

### 16. Post-cutover monitoring
16.1. Continue observing error rates, auth success rates, cron job health, and Yeastar/
Shams sync health for an extended period after acceptance.
16.2. Keep the Cloud rollback path available (per §7) until the business formally closes
out the migration.

---

## 3. Data scope

### Included — required branches
`branches` reference data already present on self-hosted (137 rows) is retained as-is;
no destructive replace, only additive reconciliation for the rows below.

### Included — 7 branch rows sourced from Cloud
- `P0310`, `P0311` — **required regardless of business decision** (live-referenced by
  Cloud `orders.branch_no`).
- `P0312`, `P0313`, General Administration (الادارة العامة), Branch Administration
  (الادارة الفرعية), Warehouse (المستودع) — **newly approved** by the business for
  migration (previously optional/undecided as of Phase 49–50).

### Included — Auth/profile/role relationships
- Full Cloud Auth roster (UUIDs, emails, metadata) — imported preserving UUIDs via
  `admin.createUser({id})`.
- `profiles` and `user_roles` for every imported user, upserted on top of the
  `handle_new_user()` default, per the Phase 44-proven sequence.
- **Not included**: password hashes, MFA secrets/factors, or any other Cloud
  Auth-internal credential material — the confirmed strategy is password-reset-only.

### Included — business tables (CLOUD→REPLACE / MERGE / HYBRID, per Phase 42–48 classification)
`orders`, `order_activity`, `complaints`, `complaint_activity`, `satisfaction_surveys`,
`notifications`, `admin_activity`, `alshrouq_dispatches`, all 5 `telesales_*`
transactional tables (`telesales_leads`, `telesales_customers`, `telesales_lead_activities`,
`telesales_followups`, `telesales_generation_runs`), `telesales_product_relations`,
`cdr_records` (per the hybrid historical-import + resume-live-sync strategy).

### Included — Shams data (rebuild/derive strategy, not copied)
- `shams_product_catalog`: no action needed — already synced via its own independent
  pipeline (exact match, 8,484 rows).
- `shams_offers`: **not copied from Cloud**. Rebuilt locally via the existing
  `shams-sync-tick` cron and the migration's own staging + atomic-promotion mechanism,
  once Shams CRM/MIS credentials are configured.
- `shams_catalog_state`, `shams_sync_*`, `shams_crm_agent_links`: DEFER-classified —
  operational/runtime state, not treated as export targets.

### Excluded
- `orders_verification_snapshot_20260815` — **explicit business decision to exclude**.
  Confirmed static (3,837 rows, unchanged across every phase that checked), not
  referenced by any application code, does not exist on self-hosted, and will not be
  created.
- Cloud Auth password hashes and any other credential material — excluded per the
  password-reset-only strategy, not a data-completeness gap.
- No additional table, row, or credential is excluded or included beyond what is listed
  above or in the confirmed business decisions — this document does not invent scope.

---

## 4. Trigger safety

**Migration 69 (`20260723022830`) MUST remain held for the entire cutover.** It is never
applied at any step of this runbook. No trigger state is modified by this preparation
document — the following is documentation of what the eventual execution phase must do,
verified live this session but not acted upon.

### Triggers that MAY be disabled — only for the duration of the bulk import (steps 6.4–6.5), and MUST be re-enabled immediately after
| Table | Trigger | Verified live state |
|---|---|---|
| `orders` | `trg_log_order_activity` | enabled (`tgenabled='O'`) |
| `orders` | `trg_notify_order` | enabled (`tgenabled='O'`) |
| `complaints` | `trg_log_complaint_activity` | enabled (`tgenabled='O'`) |
| `complaints` | `trg_notify_complaint` | enabled (`tgenabled='O'`) |

These 4 exist specifically because migration 69 (which would drop `trg_notify_order`,
`trg_notify_complaint`, and their backing functions) has never been applied — this is
precisely why migration 69 must stay held: disabling-then-re-enabling requires the
triggers to still exist.

### Triggers that MUST remain enabled throughout (never disabled)
| Table | Trigger | Verified live state |
|---|---|---|
| `orders` | `orders_prevent_reassignment` | enabled |
| `orders` | `orders_updated` | enabled |
| `orders` | `trg_set_order_display_no` | enabled |
| `orders` | `trg_sync_order_invoice_flags` | enabled |
| `telesales_followups` | `telesales_followups_sync_lead` | enabled |
| `telesales_lead_activities` | `telesales_activities_sync_last_contact` | enabled |
| all other tables | every trigger not named above | enabled |

Rationale: only the 4 named triggers cause the specific bulk-insert duplication problem
identified in Phase 44 (synthetic activity/notification rows fired once per imported
historical row). No other trigger has this failure mode, so no other trigger may be
touched.

**FK note carried forward**: `telesales_leads_parent_lead_id_fkey` remains
non-deferrable (confirmed live this session) — this is why the two-pass import strategy
(§2, step 6.5) is required rather than a deferred-constraint bulk insert.

---

## 5. Password-reset handling — post-migration user experience

This is a plain description of what every migrated user will experience. Nothing in
this section is implemented or tested against production in this phase.

1. **Accounts and identity are preserved.** Every user keeps the same account, the same
   UUID, and the same `profiles`/`user_roles` relationships they had on Cloud. Nothing
   about who a user is or what they can do changes.
2. **Passwords are not preserved.** Cloud password hashes are never read, transported,
   or written anywhere in this migration. This is a deliberate, validated strategy
   (Phase 47), not a limitation being worked around.
3. **Every user must reset their password once, after cutover, before they can log in.**
   There is no password that will work immediately post-migration — this must be
   communicated to users ahead of the cutover window as part of the business's own
   communication plan (outside the scope of this technical document).
4. **SMTP must be proven to deliver real email before the system is opened to users**
   (runbook step 12.1) — presence of `GOTRUE_SMTP_*` variable names is not sufficient
   proof; an actual test email must be sent and received through the real production
   SMTP configuration.
5. **Exactly one controlled reset-password smoke test is required during cutover**
   (runbook step 12.2), using a designated test/operator account, performed after SMTP
   is configured and before the system is declared open. This is the first real-world
   validation of the full reset flow against the self-hosted GoTrue instance with real
   SMTP — Phase 47 validated the mechanism structurally (`resetPasswordForEmail`
   compatibility) but never sent a real, deliverable email.
6. Only after both the SMTP test (5.4) and the controlled reset test (5.5 / runbook
   12.2) succeed should the system be considered ready to accept real user traffic.

---

## 6. Credentials and secrets checklist

No secret value appears anywhere below — this is a checklist of what must be supplied,
by whom, and where. All items are unchanged from Phase 50's findings; re-confirmed live
this session (name-only presence checks).

| Credential/config | Required for | Where it must be supplied | Current status |
|---|---|---|---|
| Cloud Auth `service_role` key | Auth roster pull (GoTrue Admin API `GET /admin/users`) | Whatever tooling/environment performs the roster pull | **Not available in this environment — operator must supply** |
| Cloud Postgres direct connection credentials (libpq) | Final production export | Export host/tooling performing the `libpq` dump | **Not available — operator must supply**; host also lacks `psql`/`pg_dump` client tooling entirely (confirmed this session) |
| Self-hosted `GOTRUE_SMTP_HOST/PORT/USER/PASS/SENDER_NAME/ADMIN_EMAIL` | Real password-reset email delivery | `supabase-auth` container environment (self-hosted) | Variable names present; values still read as placeholder — **operator must replace with real production SMTP credentials** |
| `SITE_URL`, `VITE_SITE_URL` | Password-reset redirect URL correctness | Vercel project environment variables | **Missing from `.env.example`; must come from institutional knowledge — operator must supply** |
| `LOVABLE_API_KEY`, `LOVABLE_SEND_URL` | Email queue/webhook routes | Vercel project environment variables | **Missing from `.env.example`; must come from institutional knowledge — operator must supply** |
| `SHAMS_CRM_USERNAME`, `SHAMS_CRM_PASSWORD`, `SHAMS_MIS_BASE_URL`, `SHAMS_MIS_ACCOUNT_IDENTIFIER`, `SHAMS_MIS_API_KEY` | `shams_offers` rebuild via `shams-sync-tick` | Wherever the Shams sync runtime reads its environment | **Not found in any inspectable container — operator must supply, all required together per `.env.example`'s documented grouping** |
| `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`, `SUPABASE_PUBLISHABLE_KEY`, `SUPABASE_PROJECT_ID` (+ `VITE_` counterparts) | Application-to-database connectivity | Vercel project environment variables | Documented in `.env.example`; live presence on the actual deployment unverifiable from this environment — operator should confirm |
| `ALSHROUQ_SCHEDULER_SECRET`, `CDR_SYNC_SECRET`, `YEASTAR_*` | Scheduler/sync authentication | Vercel project environment variables | Documented in `.env.example`; live presence unverifiable — operator should confirm |
| `ALSHROUQ_LIVE_DISPATCH_ENABLED` | Live dispatch gating | Vercel project environment variables | Documented, defaults safe-closed (`"false"`) — no action required unless the business wants it enabled post-cutover |

**No credential above was read, guessed, or invented in this phase.** Every "status" is
a presence/pattern observation only.

---

## 7. Rollback plan

### What remains available on Cloud before cutover
Cloud (Lovable-managed Supabase project) remains the live, authoritative, growing
source of truth **up until the write freeze (runbook step 2)**. Nothing in this
preparation phase or any prior phase has paused, exported, or altered Cloud in any way.

### When rollback is still possible
- **Before the write freeze**: trivially possible — nothing has happened yet.
- **After the write freeze, before DNS switch**: possible and low-cost — simply resume
  Cloud writes (unfreeze) and abandon the in-progress self-hosted import; self-hosted was
  never serving traffic, so no user-facing impact occurred.
- **After the DNS switch, before rollback trigger conditions are evaluated**: possible
  by reverting DNS back to Cloud. Cloud has been frozen (not deleted or modified) since
  step 2, so it still holds an accurate, if slightly stale (frozen-at-cutover), copy of
  all data. Any writes that happened on self-hosted between DNS switch and the rollback
  decision would be lost on rollback — this is the real cost of rolling back post-switch,
  and is the reason for the smoke tests (runbook step 13) and monitoring window (step 15)
  before declaring acceptance.
- **After acceptance is formally declared**: rollback is no longer a same-day operation;
  it would require a fresh reverse-migration effort. This is why acceptance must not be
  declared until all validation gates below pass.

### Validation gates that must pass before declaring success
1. Post-import count/FK/orphan validation (runbook 11.1) — zero orphans, counts
   reconcile against the final export.
2. Auth/profile/role consistency checks (runbook 11.2) — zero mismatches.
3. Branch integrity check including all 7 newly-added rows (runbook 11.3).
4. Trigger re-enable confirmation — all 4 temporarily-disabled triggers back to
   `tgenabled='O'` (runbook 11.4).
5. Migration 69 still absent from the ledger (runbook 11.5).
6. SMTP real-delivery test succeeds (runbook 12.1).
7. Controlled password-reset smoke test succeeds end-to-end (runbook 12.2).
8. Application smoke tests pass across all 6 surfaces (runbook 13).
9. No rollback-trigger condition (below) is observed during the post-switch monitoring
   window (runbook 15).

### What would trigger rollback
- Any validation gate above fails and cannot be corrected within the maintenance window.
- Auth import produces any duplicate-UUID corruption, orphaned `profiles`/`user_roles`
  row, or a roster count mismatch against the acquired Cloud roster.
- FK/orphan validation finds any violation in the imported business data.
- SMTP delivery test or the controlled password-reset test fails.
- Any of the 4 temporarily-disabled triggers fails to re-enable correctly.
- Critical application smoke test failure (login broken, RBAC broken, core surface
  non-functional) on self-hosted post-switch.
- Any evidence of data loss or corruption relative to the final Cloud export.
- Migration 69 is found applied, or any other unplanned schema/trigger change is
  detected, at any point in the sequence.

Rollback itself (reverting DNS, resuming Cloud) is **not performed by this document** —
it is a decision and action reserved for the operator during the actual cutover, per
runbook step 15.

---

## 8. Human confirmation gates

### Gate A — Before scheduling cutover
**Required before any date/time is fixed for the cutover:**
- Every prerequisite in §1 must be CLOSED or READY FOR CUTOVER — no
  REQUIRES OPERATOR INPUT item may remain open.
- The business must supply the exact cutover date/time, honoring the confirmed
  constraint of "after 12:30 AM." **This document does not choose that date/time.**

Gate A has **not** been passed yet — 6 operator-credential items (§1, rows 7–12) remain
open, and the exact date/time has not been provided.

### Gate B — Immediately before executing cutover
Once Gate A is passed and a specific date/time is scheduled, execution may not begin
until the user explicitly responds `GO` or `NO-GO` at the start of the scheduled window.

**No freeze, final export, import, DNS switch, or any other cutover action (runbook
steps 2–16) may occur before Gate B receives an explicit `GO`.** A `NO-GO` (or no
response) means the cutover does not proceed and Cloud continues operating normally,
untouched.

---

## Current verdict

**READY WITH CONDITIONS.**

### Remaining operator inputs
1. Cloud Auth `service_role` access for the roster pull.
2. Real production SMTP credentials for self-hosted `supabase-auth`.
3. `SITE_URL`/`VITE_SITE_URL`/`LOVABLE_API_KEY`/`LOVABLE_SEND_URL` on the Vercel
   deployment.
4. Shams CRM/MIS credentials for the sync runtime.
5. libpq client tooling plus Cloud Postgres export credentials for the final export.
6. `avatars` bucket size/MIME-limit decision (operator or business), then bucket
   creation.

### Remaining credentials/access
Identical to the 6 items above (§6 gives the exact variable names and destinations for
each) — no credential has been supplied, read, or invented in this phase.

### Remaining business confirmations
1. Exact cutover date/time (constraint already given: after 12:30 AM; specific date/time
   still pending).

No other business decision remains open — optional branches, verification-snapshot
exclusion, and credential strategy are all CLOSED as of this phase.

### Exact next action
Operator closes items 1–6 above (in parallel, independent of each other and of the date/
time decision). Once closed, and once the business supplies the exact cutover date/time,
Gate A is passed. At the start of the scheduled window, the user must issue an explicit
`GO`/`NO-GO` at Gate B before any execution phase (a future "Phase 51 — Cutover
Execution") may begin runbook step 2 onward.
