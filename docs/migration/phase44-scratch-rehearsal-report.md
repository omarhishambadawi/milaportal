# Phase 44 — Cloud → Self-Hosted Migration Rehearsal (Scratch Only)

> Rehearsal executed 2026-09-10 against a disposable scratch PostgreSQL container.
> **No production database (self-hosted `supabase-db` or Lovable Cloud) was written to.**
> This document contains methodology, schema-level findings, and go-forward requirements
> for the eventual real cutover. It contains no production data, no row-level exports, and
> no credentials — those artifacts, where they exist, live only under a local scratch
> directory and were never committed.

## Scope and method

- **Source**: Lovable Cloud project (Supabase-backed), read via `query_database` (SELECT
  only — every write attempt would have been rejected by policy, and none was made).
- **Reference**: self-hosted production `supabase-db`, read-only (`SELECT`,
  `pg_dump --schema-only`) — never written to.
- **Target**: a disposable `postgres:17.6` Docker container on its own volume, unrelated to
  and non-overlapping with the production bind-mounted data directory under
  `/opt/supabase/supabase-project`. Destroyable/recreatable in one command; the exact
  destroy/recreate commands were verified not to reference any production volume, network,
  or credential.

Every table listed in the Phase 42/43 migration matrix (CLOUD→REPLACE, MERGE/RECONCILE,
IDENTICAL, HYBRID, OPTIONAL, KEEP/DEFER) was re-validated against live row counts on both
sides before moving data, rather than trusting the prior matrix as-is.

## Result: every table imported to scratch in full, row counts match Cloud exactly

22 populated/empty tables were exercised end to end (reconciliation, replace, or hybrid
import as appropriate) and validated: row counts, PK-duplicate checks, FK-orphan checks
(17 relationships, 0 orphans), UUID/timestamp/NULL spot checks, and business-key uniqueness
(`branch_no`, `item_code`, `alias_item_code`, `(from_item_code,to_item_code)`) all passed.

## Findings that change the real cutover plan

1. **Bulk-insert trigger collisions (new blocker, not in Phase 42/43).** `complaints` and
   `orders` both carry `AFTER INSERT` triggers that write into `complaint_activity` /
   `order_activity` and `notifications`. A naive bulk import of historical rows fires those
   triggers once per inserted row, creating synthetic activity/notification rows *in
   addition to* the real historical ones being imported — a silent duplication, not an
   error. **The real migration script must disable these triggers for the duration of the
   bulk load** (`ALTER TABLE complaints, orders DISABLE TRIGGER ...` or
   `SET session_replication_role = replica` for the bulk-load transaction) and re-enable /
   reset afterward. Any other CLOUD→REPLACE table with an equivalent logging/notify trigger
   should be checked the same way before the real cutover.

2. **Branch reconciliation escalation.** Of the 7 branch_no values that exist only in Cloud
   (P0310, P0311, P0312, P0313, الادارة العامة, الادارة الفرعية, المستودع) — previously
   flagged as "pending business confirmation" — at least one (**P0310**) is referenced by
   live Cloud order data via `orders.branch_no`. This is not a low-stakes directory
   addition; it must be resolved with the business **before** the real cutover, not after,
   or the real `orders` import will fail its FK check.

3. **Corrected FK/dependency graph.** A first read-only pass under-reported several
   `telesales_*` foreign keys. The actually-exercised, FK-safe import order is:

   ```
   1. branches (reconcile), telesales_products (reconcile), telesales_product_aliases/
      patterns (verify identical, no import needed)
   2. auth UUID sequence: synthetic auth.users insert -> handle_new_user() trigger fires
      with its hardcoded default role -> upsert real profile/role on top -> delete any
      stray default-role row the trigger created that doesn't match the real role
   3. complaints, telesales_customers, telesales_imports, telesales_source_records,
      telesales_generation_runs, admin_activity, telesales_product_relations,
      email_send_log, notifications
   4. orders (needs branches; disable its logging/notify triggers first — see finding 1)
   5. order_activity, order_stars, alshrouq_dispatches, satisfaction_surveys,
      complaint_activity
   6. telesales_leads (needs orders, customers, generation_runs, imports, source_records)
   7. telesales_lead_activities, telesales_followups, telesales_patient_contacts
   8. cdr_records (hybrid, independent — the existing self-hosted Yeastar sync process
      continues unmodified afterward, keyed by the same row_id scheme Cloud already uses)
   ```

4. **Auth UUID sequence validated.** A real Cloud user's UUID was preserved through a
   synthetic `auth.users` insert; `handle_new_user()` fired exactly as it does in
   production, creating a `profiles` row and a `user_roles` row with its hardcoded default
   role; the real profile fields and role were then upserted on top, and the stray
   default-role row was explicitly deleted. End state: exactly one correct role row, no
   duplicate, no orphan. **The real cutover script must explicitly delete any trigger-
   created role row that doesn't match the real target role — an upsert/`ON CONFLICT DO
   NOTHING` alone is not sufficient**, since it only protects against exact duplicates, not
   a wrong default role sitting alongside a correct one.

5. **Unlisted table found.** `orders_verification_snapshot_20260815` exists on Cloud
   (thousands of rows) and is not in the Phase 42/43 matrix. It reads as a point-in-time
   manual verification snapshot rather than live operational data. **Needs an explicit
   categorization decision before the real cutover**; excluded from this rehearsal.

## What remains before the first real production export

- A direct `libpq` connection to Cloud Postgres for `pg_dump`/`COPY` — the read path used
  in this rehearsal is safe and adequate for a rehearsal but is not the intended bulk-
  transfer mechanism for the real cutover.
- Business decision on the 7 extra Cloud-only branches (see finding 2).
- Categorization decision on `orders_verification_snapshot_20260815` (see finding 5).
- Trigger-disable step written into the real migration script (see finding 1).

## What remains before final cutover

A maintenance window with Cloud writes frozen (or a final delta sync), the real
`auth.users` import using the sequence validated in this rehearsal, application cutover,
and a post-cutover row-count + FK validation sweep identical to the one run here — against
the real target.

## Estimated cutover duration

This rehearsal moved ~85k rows / ~58 MB in about 43 minutes, but that time was dominated by
an intentionally indirect, response-capped read path and interactive schema debugging, not
by data-transfer speed. A real `pg_dump`/`pg_restore` or `COPY` pipeline over a direct
connection should move the data itself in single-digit minutes at today's volumes; budget
30–60 minutes end to end including the auth-user sequencing and post-cutover verification,
and re-check against actual row counts at cutover time.

## Explicit safety confirmation

- Lovable Cloud: **READ-ONLY, no writes** (every `query_database` call in this rehearsal
  was a `SELECT`).
- Self-hosted production DB (`supabase-db`): **no writes** — verified before and after via
  unchanged row counts (`orders`/`complaints` still 0, `branches` still 137,
  `telesales_products` still 28).
- Migration `20260723022830_368c2698-13a3-484e-b266-bcf629c85399.sql`: **not replayed**.
- `20260820180000_alshrouq_dispatch.sql`: **not replayed**.
- No production data was imported anywhere outside the disposable scratch container.
- No secrets were accessed or exposed.
- No migration files were modified.
- All writes were confined to the scratch container/database created for this rehearsal.
