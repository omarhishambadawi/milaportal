# Phase 49 — Operational-Readiness Closure Gate

Non-destructive closure phase following Phase 48. **Zero writes to Cloud or self-hosted
production in this phase.** Every fact below was re-verified live against the running
self-hosted stack in this session (`docker exec supabase-db psql ...`, `docker ps`,
container `env` inspection by name only), not copied from Phase 48 without checking.
Migration `20260723022830` (migration 69) was **not** applied. No pause, export, or
cutover of any kind was performed. No secret value was read or printed anywhere in this
phase — presence/absence and pattern checks only.

## Executive verdict

**READY WITH CONDITIONS.** No new technical blocker was found. Every Phase 48 finding was
independently reconfirmed live and unchanged. The same operator actions and business
decisions Phase 48 identified remain the only items standing between here and the real
cutover — none require further investigation, only execution/decision time.

---

## 1. Re-verification of Phase 48 conditions (live, this session)

| Item | Status | Evidence |
|---|---|---|
| Migration ledger | **150/151 applied, migration 69 held** — unchanged | `schema_migrations` count = 150; `version='20260723022830'` returns 0 rows; 151 files still on disk |
| `owner_protection` / `is_owner()` | **Present and active** | `is_owner(uuid)` exists, `SECURITY DEFINER`, `search_path=public` pinned; triggers `trg_protect_last_owner` (user_roles) and `trg_protect_owner_profile` (profiles) both exist and enabled (`tgenabled='O'`); migrations `20260721001200`, `20260725004000`, `20260726000000`, `20260726001000` all confirmed in the applied ledger |
| Auth FK graph | **32 public-schema constraints referencing `auth.users`, unchanged** | Full recount = 40 total FKs to `auth.users`; 8 of those are GoTrue-internal (`auth.identities`, `auth.sessions`, `auth.mfa_factors`, `auth.one_time_tokens`, `auth.oauth_authorizations`, `auth.oauth_consents`, `auth.webauthn_credentials`, `auth.webauthn_challenges`) which Phase 46/48's "32" metric excludes; the remaining 32 public-schema FKs match exactly |
| `telesales_leads` self-reference | **Confirmed, still non-deferrable** | `telesales_leads_parent_lead_id_fkey`, `condeferrable = f` |
| Order/complaint trigger counts | **6 on `orders`, 2 on `complaints`, unchanged** | Names match Phase 45A's inventory exactly, including `trg_notify_order`/`trg_notify_complaint` (still present because migration 69 is held) |
| Security ACLs (6 named functions) | **Unchanged** | `is_administrator` and `branches_nearby` have `search_path` pinned; `enqueue_email`, `read_email_batch`, `delete_email`, `move_to_dlq` still have **no** `proconfig` (unpinned) — same LOW/non-blocking gap Phase 48 flagged; all 4 email functions are `supabase_admin`-owned `SECURITY DEFINER` |
| Email-table RLS | **Unchanged** | `email_send_log`, `email_send_state`, `email_unsubscribe_tokens`, `suppressed_emails` all have `relrowsecurity = t`; grants restricted to `service_role` only, no `anon`/`authenticated` |
| Containers/cron health | **Unchanged** | All 11 production containers `Up 3 days (healthy)`; 3/3 cron jobs (`alshrouq-dispatch-due`, `shams-sync-tick` every minute, `telesales-generation-tick` hourly) active |
| Storage buckets | **Still empty — no `avatars` bucket** | `storage.buckets` = 0 rows; 4 `avatars_owner_*` RLS policies pre-provisioned on `storage.objects`, still bucket-less |
| SMTP configuration | **Present, still reads as placeholder** | All `GOTRUE_SMTP_*` vars present in `supabase-auth`; `GOTRUE_SMTP_USER` value matched pattern `fake` on direct check (value itself not printed) |
| Required environment variables | **Same gaps as Phase 48** | See Section 3 |
| Shams credentials/configuration | **Still not configured** | No Shams env vars found in any inspectable container; `shams_offers` still 0 rows (rebuild has not run); `shams_product_catalog` still exact match (8,484 = 8,484) |

**Production destination gate reconfirmed**: `orders`, `complaints`, `profiles`, `user_roles`, `cdr_records`, `alshrouq_dispatches` all still 0 rows on self-hosted — no contamination from the Phase 44 rehearsal container, which remains network- and volume-isolated (`bridge` network + dedicated volume, vs. production's `supabase_default` network).

**Optional branches reconfirmed absent**: `P0310`, `P0311`, `P0312`, `P0313` all return 0 rows on self-hosted `branches` (137 rows total, unchanged).

### Newly reconfirmed (not previously spot-checked live in this exact way)

- **`docs/project.md` Known Technical Debt item #14 is confirmed stale**, precisely as Phase 48 flagged: it states the owner-protection triggers "were deliberately left out and remain a separate decision." Live state shows both triggers present, enabled, and applied via the ledger. This is a documentation staleness issue, not a live exposure — left unmodified per Phase 48's own instruction not to edit `docs/project.md` outside of this phase's actual scope of change (see note below).
- **Housekeeping**: `milaportal-scratch-rehearsal-p44` has now been running 16+ hours past Phase 48's observation (was "Up 14 hours" there, now "Up 16 hours" here). Still fully isolated, still not a technical blocker, but per Phase 44's own teardown instructions it should be destroyed once no longer needed for reference — not done in this phase (destructive action, out of scope here).
- **Two unrelated `node` processes** (`dist/server/server.js`, `dist/start/server.js`) were observed running on the host outside Docker. They do not correspond to this repository's build output (`vite build` produces a static bundle, not `dist/server/*`; `vercel.json` confirms the app deploys to Vercel via the Nitro preset, not a local Node server), and their environment/cwd could not be inspected (owned by `root`, no `sudo` access in this session). Not attributable to MilaPortal; flagged for operator awareness only, not treated as a finding about this application's readiness.

---

## 2. Storage

**`avatars` bucket does not exist** on self-hosted (`storage.buckets` is empty — 0 rows of any kind).

**Not created in this phase** — bucket creation was intentionally not performed; even though technically low-risk, provisioning storage config (size/MIME limits) that hasn't been decided is exactly the kind of production-affecting action this phase is scoped to avoid without explicit sign-off.

**Exact operator action required**:
- Bucket name: **`avatars`** (matches the 4 pre-provisioned RLS policy names: `avatars_owner_insert/read/update/delete`, all `authenticated`-only, already scoped to this exact bucket name via policy predicate).
- RLS is already fully prepared — the policies exist and only need a bucket to attach to. No new policy needs to be written.
- Size/MIME-type limits: **undetermined** — Phase 3's own snapshot flagged that Cloud's own `avatars` bucket has no limits configured either, so there is no existing production value to mirror. This must be a fresh operator/business decision, not a migration of an existing setting.
- Must be created via the Supabase Storage API/Studio (or equivalent) on self-hosted before any avatar-dependent functionality works post-cutover. Not required before the business-data export begins (no business table depends on storage).

---

## 3. Environment / secrets

No value was read or printed. Status by variable, reconfirmed live this session:

**Present and configured** (confirmed via container `env`, names only):
- `GOTRUE_SITE_URL`, `GOTRUE_SMTP_HOST/PORT/USER/PASS/SENDER_NAME/ADMIN_EMAIL` — present on `supabase-auth`.
- `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`, `SUPABASE_PUBLISHABLE_KEY`, `SUPABASE_PROJECT_ID` (+ `VITE_` counterparts) — documented in `.env.example` with clear real-value instructions; live application-side presence unverifiable (see below).
- `ALSHROUQ_SCHEDULER_SECRET`, `CDR_SYNC_SECRET`, `YEASTAR_*` — documented in `.env.example`.
- `SHAMS_MIS_BASE_URL`, `SHAMS_MIS_ACCOUNT_IDENTIFIER`, `SHAMS_MIS_API_KEY`, `SHAMS_CRM_USERNAME`, `SHAMS_CRM_PASSWORD` — documented in `.env.example` with explicit "required together" and secret-handling notes.
- `ALSHROUQ_LIVE_DISPATCH_ENABLED` — documented, defaults safe-closed (`"false"`), fails closed on any non-exact-match value.

**Appears to contain a placeholder**:
- `GOTRUE_SMTP_USER` on self-hosted `supabase-auth` — direct pattern check matched an obviously-fake marker. Must be replaced with real production SMTP credentials before cutover. (Value itself not read/printed; only a placeholder-pattern match was performed.)

**Missing from the documented template (`.env.example`) despite being load-bearing**:
- `SITE_URL`, `VITE_SITE_URL` — read in `src/lib/password.server.ts` for password-reset redirect logic; no entry in `.env.example`.
- `LOVABLE_API_KEY`, `LOVABLE_SEND_URL` — read in the email queue/webhook routes; no entry in `.env.example`.

These four must be supplied from institutional knowledge (an operator who already knows the correct production values), since the template gives no reminder or placeholder to fill in.

**Live application-side presence: unverifiable from this environment.** The app deploys to Vercel (`vercel.json`: `NITRO_PRESET=vercel`), not as a container/process in this self-hosted environment, so there is no local application process whose env can be inspected here. This is an environment-shape fact, not a new gap — same conclusion Phase 48 reached.

---

## 4. Optional branches — business decisions required

All 5 remain confirmed absent from self-hosted, with zero live references found in any business table across every phase that has checked (Phase 44 through this one):

| Branch | What enabling it changes | Recommendation | Decision required |
|---|---|---|---|
| `P0312` | Adds one more pharmacy directory row; no known live order/complaint/telesales reference | No documented recommendation on record | **YES/NO** |
| `P0313` | Same as above | No documented recommendation on record | **YES/NO** |
| الادارة العامة (head office) | Adds a non-pharmacy administrative facility row to `branches` | No documented recommendation on record | **YES/NO** |
| الادارة الفرعية (branch office) | Same as above | No documented recommendation on record | **YES/NO** |
| المستودع (warehouse) | Same as above | No documented recommendation on record | **YES/NO** |

Distinct from these 5: `P0310` and `P0311` are **not optional** — both are live-referenced by Cloud `orders.branch_no` data (Phase 44 finding) and are **required** for the real cutover's FK integrity, not a business choice.

---

## 5. Cutover readiness checklist

### A. Technical validations already complete
- Migration ledger clean, 150/151 applied, migration 69 correctly held and understood.
- Auth mechanism (UUID-preserving `admin.createUser`, `handle_new_user()` role sequencing, duplicate-UUID rejection) empirically validated (Phase 47).
- FK/dependency import order fully mapped and rehearsed end-to-end on scratch (Phase 44), including the `telesales_leads` self-reference two-pass strategy.
- Bulk-import trigger collision identified and the exact 4 triggers to disable are named (`orders.trg_log_order_activity`, `orders.trg_notify_order`, `complaints.trg_log_complaint_activity`, `complaints.trg_notify_complaint`).
- Security posture re-verified: no anonymous access to the 6 sensitive functions or the 4 email-infrastructure tables; one low-severity non-blocking hardening note (unpinned `search_path` on 4 fully-qualified email-queue functions).
- Table-by-table migration classification complete (CLOUD→REPLACE / MERGE / IDENTICAL / HYBRID / OPTIONAL / KEEP OUT / DEFER) for every table checked.
- Storage RLS policies for `avatars` pre-provisioned and ready to attach to a bucket.

### B. Operator actions required
1. Acquire the true Cloud Auth roster via the GoTrue Admin API (`GET /admin/users`) — still not attempted in any phase, requires `service_role` access.
2. Create the self-hosted `avatars` storage bucket (exact name: `avatars`) — RLS is ready, size/MIME limits need a fresh decision (no existing value to mirror from Cloud).
3. Replace the placeholder `GOTRUE_SMTP_*` credentials on self-hosted `supabase-auth` with real production SMTP.
4. Set `SITE_URL`/`VITE_SITE_URL`, `LOVABLE_API_KEY`, `LOVABLE_SEND_URL` on the real application deployment environment (Vercel project settings) — undocumented in `.env.example`, must come from institutional knowledge.
5. Configure `SHAMS_CRM_USERNAME`/`SHAMS_CRM_PASSWORD`/`SHAMS_MIS_*` so `shams_offers` (currently 0 rows) can rebuild via the existing `shams-sync-tick` cron.
6. Recapture `prod_schema.sql` immediately before the real export (still stale from Phase 44/45's snapshot; 10 migrations of drift already independently reconfirmed non-invalidating, but the artifact itself should be refreshed for fidelity).
7. Provision a direct `libpq` connection to Cloud Postgres for the real bulk export — still not done, still preparation-only.
8. Destroy or explicitly retain-with-reason the `milaportal-scratch-rehearsal-p44` container per Phase 44's own teardown instructions (housekeeping, not a technical blocker).

### C. Business decisions required
1. Inclusion/exclusion of the 5 optional branches (Section 4) — zero live references found, no documented recommendation either way.
2. Formal sign-off on excluding `orders_verification_snapshot_20260815` from migration — technical recommendation is firm and repeatedly corroborated; this is a formality.
3. Choice of maintenance window / freeze timing for the real cutover.
4. Formal sign-off on the post-migration credential strategy (password-reset-flow-only, no hash migration) — already the validated technical approach, not yet formally requested from business.

### D. Final cutover-day actions (not performed in this phase)
1. Freeze/pause Cloud writes at the agreed window.
2. Take the fresh final production snapshot/export.
3. Acquire the true Cloud Auth roster and import preserving UUIDs.
4. Import business data in the validated dependency-safe order, disabling only the 4 named triggers for the bulk load.
5. Let self-hosted rebuild Shams offers via its own staging+promotion mechanism once credentials are set.
6. Provision the `avatars` bucket and migrate any required storage objects.
7. Configure remaining secrets (SMTP, `SITE_URL`, `LOVABLE_API_KEY`/`LOVABLE_SEND_URL`, Shams credentials).
8. Run post-import count/FK/orphan validation and Auth/profile/role consistency checks.
9. Run smoke tests including one controlled login/reset-password flow.
10. Launch self-hosted production (DNS/reverse-proxy cutover) only after every check passes.
11. Keep the Cloud rollback path open until acceptance is complete.

---

## 6. Phase 49 verdict

**READY WITH CONDITIONS.**

---

## Deliverables summary

1. **Readiness report**: above — no technical blocker found; every Phase 48 condition reconfirmed live and unchanged.
2. **Remaining operator actions**: Section 5.B (8 items).
3. **Remaining business decisions**: Section 5.C (4 items).
4. **Newly discovered discrepancies**: none that change the verdict. Two observations recorded for awareness only — (a) the scratch rehearsal container has aged past its documented teardown point, (b) two unidentified, unrelated `node` processes exist on the host and were confirmed not to be this application. Both are informational, not blockers.
5. **Recommended next step**: work Section 5.B/5.C to closure (operator actions can proceed in parallel with business sign-off), then proceed to the real production export under a fresh phase, per the sequence in Section 5.D. Do not begin the actual export, freeze, or cutover until every item in B and C is closed.

## Explicit safety confirmation

- Lovable Cloud: not accessed in this phase at all (no read, no write).
- Self-hosted production: **READ-ONLY.** Every query was `SELECT`/`pg_catalog`/`information_schema`/`pg_proc`/`pg_constraint`/`pg_trigger`/`pg_policies` inspection, plus `docker ps`/`docker inspect`/`docker exec ... env`/`docker exec ... psql` read-only calls.
- No migrations executed (migration 69 remains unapplied).
- No schema, trigger, or RLS changes.
- No storage bucket created.
- No secrets read or printed — presence/absence and placeholder-pattern checks only.
- No users created, updated, or deleted.
- No git branch created or switched; work committed to `main` per instructions.
