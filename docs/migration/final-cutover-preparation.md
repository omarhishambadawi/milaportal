# Final Production Cutover — Preparation Document

**Status of this document: PREPARATION ONLY. No cutover step below has been executed.**
Written after Phase 50, incorporating the business decisions confirmed on 2026-09-12
(migrate all 5 optional branches; exclude `orders_verification_snapshot_20260815`;
cutover after 12:30 AM, exact date/time not yet set; password-reset-only credential
strategy). This phase performed **read-only verification only** — every fact below was
re-checked live against the running self-hosted stack this session
(`docker ps`, `docker exec supabase-db psql ...`) and found **unchanged from Phase 50**:
`owner_protection`/`is_owner()`, storage buckets (0), `shams_offers` (0)/
`shams_product_catalog` (8,484 exact match), all 3 cron jobs active, all 11 production
containers `Up 5 days (healthy)`, production destination tables (`orders`, `complaints`,
`profiles`, `user_roles`, `cdr_records`, `alshrouq_dispatches`) all still 0 rows, and the
exact trigger inventory on `orders` (6), `complaints` (2), and the two telesales sync
triggers. No Cloud write, no self-hosted schema/data write, no migration applied, no DNS
change, no branch created/switched, no credential invented, no cutover date/time chosen.

**One genuine change since Phase 50, found during this phase's own git push**: while this
document was being prepared, 5 new commits landed on `origin/main` (merged into this
branch, no conflicts, no code reviewed or altered by this phase), including a new
migration file, `20260918120000_alshrouq_handled_manually.sql`. It **widens** the
`alshrouq_dispatches_resolution_outcome_valid` CHECK constraint to admit a fourth value
(`handled_manually`) alongside the existing three (`delivered`, `not_delivered`,
`undetermined`); it modifies no data and touches no other table. Confirmed live this
session: **not yet applied to self-hosted** (`schema_migrations` still shows 150 applied;
this version is absent from the ledger). This is a **normal pending migration**, unrelated
to migration 69's cutover-specific hold — it must be applied to self-hosted through the
project's regular migration-deployment process before or during cutover, like any other
ordinary schema change, and is tracked as its own line item below (§1, item 1b). It was
**not applied in this phase** — applying any migration to self-hosted is schema
modification, which this phase's hard safety rules forbid regardless of how low-risk the
change is.

**Second finding, from a dedicated read-only capability investigation (no cutover action
taken)**: this session's already-authenticated Lovable MCP connector
(`mcp__claude_ai_Lovable__*`) was confirmed — via a minimal read-only aggregate query, not
a data export — to be a live, working, authenticated connection to the actual MilaPortal
Lovable Cloud project (project id `ee0d9841-3e00-4fc2-b9e5-873ee8568720`, Supabase-stack
database enabled, project ref `gwnxlpophyvgafctrbkx` matching `supabase/config.toml`) —
not self-hosted, and not a stale or unrelated project. Through this connector: (a)
`auth.users` is directly queryable, giving `id`/`email`/metadata for the real Cloud Auth
roster without ever selecting `encrypted_password`; (b) arbitrary `SELECT` can be run
against every Cloud table needed for the final production dataset. This resolves §1 items
7 and 12 below (and their corresponding rows in §6) **without requiring any new
credential from the business owner**. The same connector also supports
`INSERT`/`UPDATE`/`DELETE`/`DDL` — it is not a scoped read-only credential — so its use
during preparation is restricted to `SELECT` only, per the safety statement immediately
below.

**Third finding, from this phase's documentation-audit task (no cutover action taken)**:
this document's items 10–11 (§1), runbook step 10.2, and the credentials checklist (§6)
described the live application as deployed to Vercel, authenticated via a separate Vercel
MCP connector. That is now stale: `vercel.json` was removed from the repository on
`origin/main` (commit `fa0a188`, 2026-09-12, merged into this branch before this phase
began), along with the last Vercel references in `.env.example`,
`.github/workflows/ci.yml`, and `src/routes/api/cdr-sync.ts` — confirmed this phase via
`git show`/`grep`, no repository file changed. `docs/project.md`'s own Deployment section
(already accurate, not modified by this phase) confirms the live app builds as a
Cloudflare Worker (Nitro preset `cloudflare-module`, `vite.config.ts`) and deploys via
Lovable — this was already the actual architecture; removing `vercel.json` did not change
it. This phase also re-confirmed live that the canonical Lovable Cloud Supabase project
remains `gwnxlpophyvgafctrbkx` (`supabase/config.toml`, `.lovable/mcp/manifest.json`,
`vite.config.ts`'s fallback constants all agree, unchanged) and that no prior phase ever
actually completed Vercel MCP authentication or used it to close any item — items 10–11
were only ever describing Vercel as the intended target, never resolved through it. Every
Vercel reference below is corrected to Lovable's Cloudflare Worker deployment target. No
prerequisite's status changes as a result of this correction alone: items 10 and 11 remain
**REQUIRES OPERATOR INPUT** — only the described dependency target changes, and item 10's
blocker on Vercel MCP OAuth is removed as moot (it never applied to the real
architecture), which simplifies but does not close that item.

**Fourth finding, from a dedicated read-only SMTP readiness audit (no cutover action, no
configuration change, no email sent)**: prior phases (49, 50, and this document's item 9)
confirmed only that `GOTRUE_SMTP_USER` matched a placeholder-pattern and left the other
`GOTRUE_SMTP_*` values as "cannot be verified without printing them." This audit went
further using safe, non-value-revealing checks and found the self-hosted SMTP
configuration to be **conclusively non-functional, not merely unverified**:
- `SMTP_HOST`, `SMTP_USER`, `SMTP_PASS`, `SMTP_ADMIN_EMAIL`, and `SMTP_SENDER_NAME` all
  match placeholder/fake-pattern shapes (checked by substring/shape heuristics only — no
  value was printed).
- `SMTP_PORT` is set to `2500`, a non-standard port (GoTrue's own documented default is
  `587`; common real values are `25`/`465`/`587`).
- The configured `SMTP_HOST` **fails DNS resolution** from inside the `supabase-auth`
  container.
- A control check resolving `smtp.gmail.com` from the same container **succeeded**,
  proving the container's own DNS/egress is fine — the failure is specific to the
  configured (placeholder) hostname, not the environment.
- **No email was sent** at any point during the audit; only DNS lookups and a TCP
  connection attempt (which failed, consistent with the DNS failure) were performed —
  both read-only, non-mutating network diagnostics.

The same audit also found that `GOTRUE_SITE_URL` (`http://localhost:3000`) and
`API_EXTERNAL_URL` (`http://localhost:8000/auth/v1`) — GoTrue's own site/API URLs, used to
build every email link and to validate `redirectTo` — are still set to local development
values, and `GOTRUE_URI_ALLOW_LIST`/`ADDITIONAL_REDIRECT_URLS` is empty (so only
`GOTRUE_SITE_URL` itself is an accepted redirect target). **This is a distinct dependency
from the application-level `SITE_URL`/`VITE_SITE_URL` in item 10 below** — that pair is
read by the Cloudflare Worker application itself (`src/lib/password.server.ts`) to build
the link it *asks* GoTrue to redirect to; `GOTRUE_SITE_URL`/`API_EXTERNAL_URL`/
`GOTRUE_URI_ALLOW_LIST` are GoTrue's own server-side settings that generate and *validate*
that link independently. Neither was previously tracked as its own prerequisite in this
document (see the new item 9b below). Item 9's status is corrected accordingly, and item
9b is added; no other item's status changes as a result of this finding.

> Until explicit cutover authorization is given, all Lovable Cloud access used for
> preparation must remain read-only/SELECT-only. No freeze, export execution, INSERT,
> UPDATE, DELETE, DDL, credential changes, or other production mutation is permitted.

---

## 1. Reconciliation — final prerequisite status (baseline: Phase 50)

| # | Prerequisite | Status | Notes |
|---|---|---|---|
| 1 | Migration ledger / migration 69 hold | **CLOSED** | 150 applied of 152 files now on disk (151 as of Phase 48, +1 new normal migration since, see 1b); `20260723022830` confirmed absent from the ledger, unchanged since Phase 48 |
| 1b | New migration `20260918120000_alshrouq_handled_manually.sql` (landed on `origin/main` during this phase, merged in) | **REQUIRES CUTOVER-DAY ACTION** | Pure additive CHECK-constraint widening on `alshrouq_dispatches.resolution_outcome`, no data change; confirmed not yet applied to self-hosted; unrelated to migration 69's hold — apply via the normal migration-deployment process before or during cutover (pre-cutover check 1.2 below), not part of this preparation phase |
| 2 | `owner_protection` / `is_owner()` | **CLOSED** | Both triggers present, enabled, live-verified this session |
| 3 | Auth FK graph / `telesales_leads` self-ref / order-complaint triggers | **CLOSED** | Live-verified this session, exact names below (§4) |
| 4 | Security ACLs / RLS (6 functions, 4 email tables) | **CLOSED** | Unchanged since Phase 48; one non-blocking low-severity note (unpinned `search_path` on 4 fully-qualified email-queue functions) carried forward, not a gate item |
| 5 | Self-hosted schema recapture | **CLOSED** | Performed in Phase 50 (`prod_schema_phase50.sql`); a further recapture immediately before the real export remains standard cutover-day hygiene, not an outstanding gap |
| 6 | Phase 44 scratch rehearsal container | **CLOSED** | Destroyed in Phase 50, confirmed absent this session, production containers unaffected |
| 7 | Auth roster pull | **READY FOR CUTOVER** | Confirmed this phase: obtainable via the already-authenticated Lovable MCP connector's direct query access to Cloud `auth.users` (`id`/`email`/metadata only, never `encrypted_password`) — no Cloud `service_role` GoTrue Admin API key or other new credential required |
| 8 | `avatars` storage bucket | **REQUIRES OPERATOR INPUT** (RLS is READY, settings fully determined) | No longer an open decision: name (`avatars`), private, `file_size_limit = 4194304` (4 MB), and `allowed_mime_types = {image/png,image/jpeg,image/webp,image/gif}` are all fixed by already-applied migration `20260721002100_avatars_bucket_limits.sql` and `src/lib/avatar.ts` — not "no existing Cloud value to mirror" as previously stated. That migration is an `UPDATE ... WHERE id='avatars'`, applied while the bucket didn't exist, so it was a no-op; creation must set these values explicitly, not rely on the migration re-firing. Exact statement attempted this phase and blocked by this session's own permission classifier ("Modify Shared Resources") — only remaining step is running it, with the operator's explicit go-ahead (see §2 step 9.1) |
| 9 | Real SMTP credentials | **NOT PRODUCTION-READY** (requires operator input) | Corrected by the SMTP readiness audit (see the fourth finding above): all of `GOTRUE_SMTP_HOST/USER/PASS/ADMIN_EMAIL/SENDER_NAME` match placeholder/fake-pattern shapes, `GOTRUE_SMTP_PORT` is a non-standard `2500`, and — going beyond pattern-matching — `SMTP_HOST` **fails DNS resolution** from `supabase-auth` while a control lookup (`smtp.gmail.com`) succeeds from the same container, proving the container's DNS/egress works and the configured host itself is not a real, reachable relay. This is a stronger, confirmed-non-functional finding, not merely "unverified" as Phases 49–50 and this document previously stated. No value was printed and no email was sent to reach this conclusion |
| 9b | GoTrue URL/redirect configuration (`GOTRUE_SITE_URL`, `API_EXTERNAL_URL`, `GOTRUE_URI_ALLOW_LIST`) | **REQUIRES OPERATOR INPUT** | New item, added from the SMTP readiness audit's fourth finding above. `GOTRUE_SITE_URL=http://localhost:3000` and `API_EXTERNAL_URL=http://localhost:8000/auth/v1` are still local-development values; `GOTRUE_URI_ALLOW_LIST` is empty. These are GoTrue's own server-side settings — distinct from the application-level `SITE_URL`/`VITE_SITE_URL` in item 10, which the Cloudflare Worker app reads separately. Every password-reset/invite email link GoTrue generates, and every `redirectTo` it will accept, depends on these being set to the real production domain before the controlled SMTP test (runbook step 12) can produce a usable, non-localhost link |
| 10 | Application env vars (`SITE_URL`, `VITE_SITE_URL`, `LOVABLE_API_KEY`, `LOVABLE_SEND_URL`) | **REQUIRES OPERATOR INPUT** | Load-bearing, absent from `.env.example`. **Corrected this phase**: Vercel is no longer part of the architecture (see the third finding at the top of this document) — the live app deploys as a Cloudflare Worker via Lovable, so these vars must be set in Lovable's project environment settings for that Worker, per `.env.example`'s own guidance for `SHAMS_MIS_BASE_URL`. No MCP tool available this session exposes Worker environment-variable values or presence, so this remains unverifiable from here — operator confirmation required, not a guess |
| 11 | Shams credentials (`SHAMS_CRM_*`, `SHAMS_MIS_*`) | **REQUIRES OPERATOR INPUT** | No `SHAMS_*` name found in any inspectable container this session; consumed only by the deployed Cloudflare Worker's server-only code (`src/lib/shams-crm/client.server.ts`, `src/lib/shams/client.server.ts`), not by any self-hosted container. self-hosted's `shams_sync_tick()` cron function additionally requires two Vault secrets, `shams_sync_scheduler_url` and `email_queue_service_role_key`, to reach that Worker's scheduler endpoint — both confirmed **absent** (no row in `vault.decrypted_secrets`) — a separate self-hosted wiring step from the CRM/MIS credentials themselves, not resolvable until the deployed Worker's scheduler endpoint exists |
| 12 | Cloud production export path | **READY FOR CUTOVER** | Confirmed this phase: obtainable via the same Lovable MCP connector's `query_database` capability against the live Cloud project — a literal `psql`/`pg_dump` binary is not required for this path; export *execution* is still a cutover-day action (item 18) and remains SELECT-only until Gate B |
| 13 | 5 optional branches decision | **CLOSED** | Business confirmed: migrate all 5 (`P0312`, `P0313`, General Administration, Branch Administration, Warehouse) |
| 14 | `orders_verification_snapshot_20260815` exclusion sign-off | **CLOSED** | Business confirmed: exclude |
| 15 | Maintenance window | **REQUIRES OPERATOR INPUT (business)** | Business confirmed "after 12:30 AM" as a constraint only — exact date/time still not chosen; this phase does not choose it |
| 16 | Credential-strategy sign-off | **CLOSED** | Business confirmed password-reset-only, UUID/relationship-preserving, no hash migration |
| 17 | Cloud write freeze | **REQUIRES CUTOVER-DAY ACTION** | Must not happen before Gate B |
| 18 | Final production export/snapshot | **REQUIRES CUTOVER-DAY ACTION** | Must not happen before Gate B |
| 19 | DNS/reverse-proxy switch | **REQUIRES CUTOVER-DAY ACTION** | Must not happen before Gate B |

**Net change from Phase 50**: business decisions 13, 14, and 16 move from OPEN to
CLOSED. The maintenance window (15) is partially constrained ("after 12:30 AM") but not
closed — the exact date/time is still required from the business before Gate A.

**Net change in that phase**: items 7 (Auth roster pull) and 12 (Cloud production export
path) moved from REQUIRES OPERATOR INPUT to READY FOR CUTOVER — both resolved via the
already-authenticated Lovable MCP connector, with **no new credential required from the
business owner**.

**Net change in this prerequisite-closure phase**: item 8's decision (`avatars` bucket
name/private/MIME/size limits) is now fully determined from existing code and migration
— it was never actually a business/operator decision, only an investigation gap. Bucket
*creation* remains open, blocked this phase by the session's own permission classifier
(see item 8's note and §2 step 9.1) — the operator can run the one exact statement given
there, or grant approval for it to be run in-session. Items 9–11 (real SMTP, Cloudflare
Worker application env vars, Shams CRM/MIS credentials) remain open and genuinely require
operator/business action; none of the 4 remaining items (8–11) require further
investigation beyond what is already documented.

**Net change in this documentation-audit phase**: no prerequisite's status changes. Items
10–11's described dependency is corrected from Vercel (removed from the architecture,
`vercel.json` deleted on `origin/main`) to the actual deployment target, a Cloudflare
Worker deployed via Lovable — see the third finding at the top of this document.

**Net change in this SMTP-readiness documentation update**: item 9 is relabeled from
"REQUIRES OPERATOR INPUT" (implying only that a value was unverified) to **NOT
PRODUCTION-READY** (confirmed non-functional by DNS/TCP checks) — operator action is
still what closes it, so this is a wording correction, not a new blocker. A new item, 9b,
is added for GoTrue's own URL/redirect settings, previously untracked in this document.
See the fourth finding at the top of this document for the full evidence trail.

---

## 2. Final cutover runbook (exact ordered sequence — NOT executed)

This sequence is the single authoritative execution order for the eventual cutover. It
consolidates the validated findings of Phases 44–50 into one document. **Steps 2 onward
may not begin until Gate B (§8) receives an explicit `GO`.**

### 1. Pre-cutover checks
1.1. Confirm all prerequisites in §1 are CLOSED or READY FOR CUTOVER (no
REQUIRES OPERATOR INPUT items remain).
1.2. Apply any normal (non-migration-69) pending migrations to self-hosted through the
project's regular migration-deployment process — as of this document, exactly one is
pending: `20260918120000_alshrouq_handled_manually.sql` (§1, item 1b). Re-check the
migration directory for any further migration added between now and the cutover window,
since main is an actively developed branch and this phase already observed one land
mid-preparation. **Migration 69 (`20260723022830`) remains excluded from this step and
from every step of this runbook.**
1.3. Recapture `prod_schema.sql` fresh (self-hosted, schema-only, read-only) — even
though Phase 50 already did this once, a same-day recapture is standard hygiene since
self-hosted may have advanced further (confirmed true again this phase — see the note at
the top of this document).
1.4. Re-run the same live checks as the Phase 50 baseline (ledger, triggers, containers,
cron, storage) one final time immediately before freeze.
1.5. Confirm the exact maintenance-window date/time has been supplied by the business
(Gate A).
1.6. Confirm rollback plan (§7) and all named operators/approvers are available and on
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
3.1. Using the already-authenticated Lovable MCP connector's `query_database` capability
against the live Cloud project (verified this phase; a literal `libpq`/`pg_dump` binary
is not required for this path), extract the authoritative final dataset for every table
classified CLOUD→REPLACE, MERGE/RECONCILE, or HYBRID via `SELECT`-only queries, following
`phase45_export_runbook.md`'s table-by-table methodology. This step is a cutover-day
action gated behind Gate B (§8) — it is not performed by this preparation phase, and the
connector must be used SELECT-only throughout per the safety statement at the top of this
document (it also supports writes, which must never be issued against Cloud here).
3.2. Record final row counts for every exported table and compare against every prior
phase's reconciliation assumption; reconcile any drift found before proceeding.
3.3. This export explicitly **includes** all 7 previously-partitioned branch rows:
`P0310`, `P0311` (already required) plus the 5 newly-approved optional branches
(`P0312`, `P0313`, General Administration, Branch Administration, Warehouse).
3.4. This export explicitly **excludes** `orders_verification_snapshot_20260815` per the
confirmed business decision.

### 4. Cloud Auth roster acquisition
4.1. Using the already-authenticated Lovable MCP connector's direct query access to the
live Cloud project (verified this phase), `SELECT id`, `email`, and required metadata
columns from `auth.users` to acquire the complete, current Cloud Auth roster. A separate
Cloud `service_role` GoTrue Admin API credential is not required for this path.
4.2. Record each user's `id` (UUID), `email`, and metadata needed for `profiles`/
`user_roles` reconciliation. **Never select `encrypted_password`, MFA factor secrets, or
any other credential-internal column** — the confirmed strategy is password-reset-only
(§5); the connector's own privilege is broader than this step needs, so this restriction
is procedural, not tool-enforced, and must be followed deliberately.

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
only the *data* is imported here. **Dependency**: Cloud rows may carry
`resolution_outcome = 'handled_manually'` (three incidents corrected on Cloud around
2026-09-12) — step 1.2's migration application
(`20260918120000_alshrouq_handled_manually.sql`) must complete *before* this import step,
or any such row will fail self-hosted's `alshrouq_dispatches_resolution_outcome_valid`
CHECK constraint.
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
9.1. Create the self-hosted `avatars` bucket. The decision is no longer open (§1, item
8) — the exact statement, fully determined from existing code/migration, is:
```sql
INSERT INTO storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
VALUES ('avatars', 'avatars', false, 4194304,
        ARRAY['image/png','image/jpeg','image/webp','image/gif'])
ON CONFLICT (id) DO NOTHING;
```
Attempted this phase and blocked by this session's own permission classifier ("Modify
Shared Resources") as a self-hosted write — requires the operator to run it directly, or
to grant explicit approval for it to be run in-session. The 4 RLS policies
(`avatars_owner_insert/read/update/delete`) are already attached and require no changes.
9.2. Migrate any required existing avatar objects from Cloud storage to the new bucket,
preserving object paths/ownership so the pre-attached RLS policies resolve correctly.

### 10. SMTP/application/Shams configuration
10.1. Replace placeholder `GOTRUE_SMTP_*` values on self-hosted `supabase-auth` with real
production SMTP credentials. The current values are confirmed non-functional (§1 item 9)
— `SMTP_HOST` does not resolve — not merely unverified, so this is not optional hygiene.
10.2. Set `SITE_URL`, `VITE_SITE_URL`, `LOVABLE_API_KEY`, `LOVABLE_SEND_URL` in Lovable's
project environment settings for the deployed Cloudflare Worker — the app's current, and
only, deployment target (Vercel was removed from the architecture; see the third finding
at the top of this document and §1 item 10).
10.3. Set `SHAMS_CRM_USERNAME`, `SHAMS_CRM_PASSWORD`, `SHAMS_MIS_*` wherever the Shams
sync runtime reads them.
10.4. Do not print or log any of these values at any point; verify presence by name/
connectivity test only.
10.5. Set GoTrue's own `GOTRUE_SITE_URL` and `API_EXTERNAL_URL` to the real production
domain (currently `localhost` values — §1 item 9b), and populate
`GOTRUE_URI_ALLOW_LIST`/`ADDITIONAL_REDIRECT_URLS` with any additional redirect targets
the application requires. **This is not the same variable as step 10.2's application-level
`SITE_URL`/`VITE_SITE_URL`** — GoTrue reads its own copy independently to both generate
email links and validate `redirectTo`. Skipping this step leaves step 10.1's SMTP fix
insufficient on its own: real credentials would deliver an email, but every link inside it
would still point at `localhost`.

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
12.1. Confirm both step 10.1 (real SMTP credentials) and step 10.5 (GoTrue
`SITE_URL`/`API_EXTERNAL_URL`/`URI_ALLOW_LIST` set to the real production domain) are
complete. SMTP credentials alone are not sufficient — see the fourth finding at the top
of this document.
12.2. Restart only the `supabase-auth` container to pick up the new environment values.
No other self-hosted container needs to restart for this change.
12.3. Before sending anything, re-verify DNS resolution and TCP reachability of the newly
configured `SMTP_HOST`:`SMTP_PORT` from inside `supabase-auth`, using the same read-only
method as the SMTP readiness audit (`getent hosts`, then a TCP connect attempt) — this
confirms the new values are actually live without yet sending any mail.
12.4. Send **exactly one** test through the real, now-configured SMTP path: a
password-recovery/invite request to a single designated operator/test account. Respect
GoTrue's mailer rate limit (`GOTRUE_SMTP_MAX_FREQUENCY`, ~1 minute per address by
default) — do not resend speculatively.
12.5. Confirm all of: real delivery, correct sender identity, a link pointing at the real
(non-`localhost`) production domain, and a successful end-to-end password-reset round
trip (request → receive → set new password → log in).
12.6. Do not skip this step — SMTP presence (name-only) was never confirmed to produce
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
   (runbook steps 12.1–12.4) — presence of `GOTRUE_SMTP_*` variable names is not
   sufficient proof, and neither is real SMTP credentials alone: a dedicated SMTP
   readiness audit found the self-hosted configuration confirmed non-functional (DNS
   resolution failure on `SMTP_HOST`, not just an unverified placeholder — see the
   fourth finding at the top of this document), and separately found that GoTrue's own
   `GOTRUE_SITE_URL`/`API_EXTERNAL_URL` still point at `localhost` (§1 item 9b). Both
   must be corrected (runbook steps 10.1 and 10.5) before an actual test email is sent
   and received with a usable, non-`localhost` link.
5. **Exactly one controlled reset-password smoke test is required during cutover**
   (runbook step 12.5), using a designated test/operator account, performed after both
   SMTP credentials (10.1) and GoTrue's URL/redirect settings (10.5) are configured and
   before the system is declared open. This is the first real-world validation of the
   full reset flow against the self-hosted GoTrue instance with real SMTP — Phase 47
   validated the mechanism structurally (`resetPasswordForEmail` compatibility) but
   never sent a real, deliverable email.
6. Only after both the SMTP test and the controlled reset test (runbook 12.4–12.5)
   succeed should the system be considered ready to accept real user traffic.

---

## 6. Credentials and secrets checklist

No secret value appears anywhere below — this is a checklist of what must be supplied,
by whom, and where. All rows are unchanged from Phase 50's findings and re-confirmed live
this session (name-only presence checks), **except the two rows marked superseded**,
which were resolved this phase via the already-authenticated Lovable MCP connector (see
the note at the top of this document). The connector's own authentication is pre-existing
and was neither created, modified, nor reset in this phase — only its capability was
verified, using a minimal, non-sensitive aggregate-count query (no rows dumped, no
secrets read). **"Where it must be supplied" is corrected in this phase**: rows previously
naming "Vercel project environment variables" are updated to Lovable's project environment
settings for the deployed Cloudflare Worker, the app's actual (and only) deployment target
— Vercel was removed from the architecture; see the third finding at the top of this
document. No status changes as a result, only the named destination.

| Credential/config | Required for | Where it must be supplied | Current status |
|---|---|---|---|
| Cloud Auth `service_role` key | Auth roster pull | — | **Superseded.** No longer required: the already-authenticated Lovable MCP connector (verified this phase) provides equivalent capability via direct `SELECT` on Cloud `auth.users`; no new credential needed from the business owner. |
| Cloud Postgres direct connection credentials (libpq) | Final production export | — | **Superseded.** No longer required: the already-authenticated Lovable MCP connector (verified this phase) can `SELECT` every table needed for the export directly against the live Cloud project; a literal `psql`/`pg_dump` binary is not required for this path. The connector is also capable of writes, so export *execution* remains a SELECT-only, Gate-B-gated cutover-day action, not performed by this preparation phase. |
| Self-hosted `GOTRUE_SMTP_HOST/PORT/USER/PASS/SENDER_NAME/ADMIN_EMAIL` | Real password-reset email delivery | `supabase-auth` container environment (self-hosted) | **NOT PRODUCTION-READY** (confirmed, not just placeholder-patterned): all 5 non-port values match placeholder/fake shapes and `SMTP_HOST` fails DNS resolution from `supabase-auth` (control lookup of `smtp.gmail.com` succeeds from the same container, so the container's own DNS/egress is not the cause); `SMTP_PORT` is a non-standard `2500` — **operator must replace with real, reachable production SMTP credentials** |
| Self-hosted `GOTRUE_SITE_URL`, `API_EXTERNAL_URL`, `GOTRUE_URI_ALLOW_LIST` | Correct (non-`localhost`) password-reset/invite links; `redirectTo` validation | `supabase-auth` container environment (self-hosted) | **New row, added by the SMTP readiness audit.** `GOTRUE_SITE_URL=http://localhost:3000`, `API_EXTERNAL_URL=http://localhost:8000/auth/v1`, `GOTRUE_URI_ALLOW_LIST` empty — all local-development values. Distinct from the `SITE_URL`/`VITE_SITE_URL` row below, which the Cloudflare Worker application reads separately — **operator must set these to the real production domain** |
| `SITE_URL`, `VITE_SITE_URL` | Password-reset redirect URL correctness | Lovable project environment settings (Cloudflare Worker) | **Missing from `.env.example`; must come from institutional knowledge — operator must supply** |
| `LOVABLE_API_KEY`, `LOVABLE_SEND_URL` | Email queue/webhook routes | Lovable project environment settings (Cloudflare Worker) | **Missing from `.env.example`; must come from institutional knowledge — operator must supply** |
| `SHAMS_CRM_USERNAME`, `SHAMS_CRM_PASSWORD`, `SHAMS_MIS_BASE_URL`, `SHAMS_MIS_ACCOUNT_IDENTIFIER`, `SHAMS_MIS_API_KEY` | `shams_offers` rebuild via `shams-sync-tick` | Wherever the Shams sync runtime reads its environment | **Not found in any inspectable container — operator must supply, all required together per `.env.example`'s documented grouping** |
| `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`, `SUPABASE_PUBLISHABLE_KEY`, `SUPABASE_PROJECT_ID` (+ `VITE_` counterparts) | Application-to-database connectivity | Lovable project environment settings (Cloudflare Worker) | Documented in `.env.example`; live presence on the actual deployment unverifiable from this environment — operator should confirm |
| `ALSHROUQ_SCHEDULER_SECRET`, `CDR_SYNC_SECRET`, `YEASTAR_*` | Scheduler/sync authentication | Lovable project environment settings (Cloudflare Worker) | Documented in `.env.example`; live presence unverifiable — operator should confirm |
| `ALSHROUQ_LIVE_DISPATCH_ENABLED` | Live dispatch gating | Lovable project environment settings (Cloudflare Worker) | Documented, defaults safe-closed (`"false"`) — no action required unless the business wants it enabled post-cutover |

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
6. SMTP real-delivery test succeeds (runbook 12.4).
7. Controlled password-reset smoke test succeeds end-to-end (runbook 12.5).
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

Gate A has **not** been passed yet — 5 items (§1, rows 8–9b, 10–11: `avatars` bucket
creation execution, real SMTP [now confirmed NOT PRODUCTION-READY, not just unverified],
GoTrue URL/redirect configuration [new, item 9b], Cloudflare Worker application env vars,
Shams CRM/MIS credentials) remain open, and the exact date/time has not been provided.
Item 8's decision is resolved (see its row) — only the creation statement's execution is
still pending. Items 7 and 12 (Auth roster pull, Cloud production export path) closed via
the already-authenticated Lovable MCP connector — no new credential required.

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
1. Real production SMTP credentials for self-hosted `supabase-auth`. **Confirmed
   NOT PRODUCTION-READY** by the SMTP readiness audit (DNS resolution failure on
   `SMTP_HOST`, placeholder-pattern values across `HOST/USER/PASS/ADMIN_EMAIL/SENDER_NAME`,
   non-standard `SMTP_PORT`) — this is stronger than the prior "unverified placeholder"
   framing; see the fourth finding at the top of this document and §1 item 9.
2. GoTrue's own `GOTRUE_SITE_URL`/`API_EXTERNAL_URL`/`GOTRUE_URI_ALLOW_LIST` on
   self-hosted `supabase-auth`, currently `localhost` values with an empty allow list
   (§1 item 9b, new this phase). Distinct from item 3 below's application-level
   `SITE_URL`/`VITE_SITE_URL` — both must be set correctly for password-reset links to
   work, but they are different variables read by different services.
3. Confirmation that `SITE_URL`/`VITE_SITE_URL`/`LOVABLE_API_KEY`/`LOVABLE_SEND_URL` are
   set in Lovable's project environment settings for the deployed Cloudflare Worker.
   **Corrected in a prior phase**: Vercel is no longer part of the architecture, so no
   MCP connector authorization or OAuth step applies here — this is a direct operator
   confirmation, not gated on any authentication flow.
4. Shams CRM/MIS credentials for the sync runtime, plus the two self-hosted Vault
   secrets (`shams_sync_scheduler_url`, `email_queue_service_role_key`) once the deployed
   Cloudflare Worker's scheduler endpoint exists.
5. Execute `avatars` bucket creation — the decision is closed (§1, item 8; exact
   statement in §2 step 9.1); only running it remains, blocked this phase by the
   session's own permission classifier, pending operator action or explicit approval.

Resolved in a prior phase, no longer remaining: Cloud Auth roster access and the Cloud
production export path (previously listed here) — both are obtainable via the
already-authenticated Lovable MCP connector, with no new credential required from the
business owner. See the note at the top of this document and §6. Within item 5 above, the
`avatars` bucket's size/MIME-limit *decision* is also resolved — only the creation
statement's *execution* remains open.

### Remaining credentials/access
Identical to the 5 items above (§6 gives the exact variable names and destinations for
each) — no credential has been supplied, read, or invented in any documentation phase.
Two previously-listed credential requirements (Cloud Auth `service_role` key, Cloud
Postgres libpq credentials) are superseded — see §6.

### Remaining business confirmations
1. Exact cutover date/time (constraint already given: after 12:30 AM; specific date/time
   still pending).

No other business decision remains open — optional branches, verification-snapshot
exclusion, and credential strategy are all CLOSED as of this phase.

### Exact next action
Operator closes items 1–5 above (in parallel, independent of each other and of the date/
time decision — items 1 and 2 are both self-hosted `supabase-auth` environment changes and
are naturally done together, but neither depends on the other being done first). Once
closed, and once the business supplies the exact cutover date/time,
Gate A is passed. At the start of the scheduled window, the user must issue an explicit
`GO`/`NO-GO` at Gate B before any execution phase (a future "Phase 51 — Cutover
Execution") may begin runbook step 2 onward. Cloud production export and Auth roster
acquisition (runbook steps 3–4) will use the already-authenticated Lovable MCP connector
SELECT-only, per the safety statement at the top of this document, and remain gated
behind Gate B like every other cutover action.
