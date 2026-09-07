# Phase 3 — Production schema snapshot (read-only)

Goal: produce a schema-only reconstruction of the live production database, treat it as the source of truth, and compare it against `supabase/migrations/`. Nothing in production is modified, and no rows, credentials or Vault values are exported.

## What is and is not possible here (verified before planning)

- A `pg_dump --schema-only` is not available through this environment; full database dumps are not offered here. The snapshot will instead be **generated from the live system catalogues**, which produces the same DDL content for the application schema.
- Confirmed readable from the sandbox database role: `information_schema.columns` for `public` (707 columns), `pg_get_functiondef` for application functions, and `pg_policy` (66 policies). So full `public` DDL is reproducible.
- Confirmed **not** readable by that role: the `auth`, `cron`, `vault` and `pgmq` schemas (permission denied). Those are reachable only through the Cloud read tool, which returns metadata rows rather than DDL.
- Consequence: `public` gets true DDL; the Supabase-managed schemas get a documented inventory instead. That is the correct outcome anyway — a self-hosted Supabase stack creates `auth`, `storage`, `pgmq`, `vault`, `cron` and `supabase_migrations` itself, and hand-restoring their internal DDL would fight the platform.

## Deliverables

Written to `/mnt/documents/milaportal-schema-snapshot/`:

1. `01-extensions.sql` — `CREATE EXTENSION` statements with version and schema placement (PostGIS pinned to `public`, pg_net/pg_trgm/pgcrypto/uuid-ossp to `extensions`, pgmq/vault to their own schemas).
2. `02-types.sql` — enums and composite types, including `app_role`.
3. `03-tables.sql` — every `public` table: columns, types, defaults, identity/sequences, then primary keys, uniques, check constraints and foreign keys as separate `ALTER TABLE` statements so load order cannot deadlock.
4. `04-indexes.sql` — all non-constraint indexes via `pg_get_indexdef`, including the trigram/GiN and analytics indexes.
5. `05-functions.sql` — every application function and trigger function via `pg_get_functiondef`, preserving `SECURITY DEFINER` and pinned `search_path`. PostGIS-owned routines are excluded (the extension supplies them).
6. `06-views.sql` — the 3 views (and materialised views, if the catalogue shows any) via `pg_get_viewdef`.
7. `07-triggers.sql` — all 32 non-internal triggers via `pg_get_triggerdef`.
8. `08-rls-and-grants.sql` — `ALTER TABLE ... ENABLE ROW LEVEL SECURITY` for the 52 RLS tables, all 66 policies rebuilt from `pg_policy` with roles/USING/CHECK, and table plus **column-level** grants (the `profiles` column grants matter and a naive dump loses them).
9. `09-managed-schema-inventory.md` — auth/storage/pgmq/vault/cron/supabase_migrations: object and column inventory, counts, and what the self-hosted stack must provide. Metadata only.
10. `10-scheduled-jobs.sql` — the 3 pg_cron schedules and the queue/dispatch functions that call `net.http_post`, with every endpoint URL and secret lookup preserved structurally.
11. `REPORT.md` — the A–H comparison report.

## Redaction rules applied while generating

- Schema only. No `INSERT`, no `COPY`, no table rows anywhere in the output.
- No `auth.users`, `storage.objects`, session or refresh-token data.
- Vault secret **names** appear (they are needed to rebuild the jobs); no decrypted value is ever selected.
- Any literal that looks like a key or token inside a function body is replaced with `<<REDACTED:reason>>` and listed in `REPORT.md`. Function structure and the surrounding `vault.decrypted_secrets` lookups stay intact so the logic is still reviewable.
- Before the snapshot is declared finished, the whole output directory is scanned for key-shaped strings (JWT-like triples, `sb_secret_`, `sb_publishable_`, long base64 runs) and anything found is redacted.

## Live-vs-repository comparison

Live catalogue inventory is diffed against the objects the 151 migration files create, producing:

- **A.** Where live differs from the migration folder.
- **B.** Objects in production not reproducible by replaying the folder.
- **C.** Objects the migrations create that are absent from production.
- **D.** Ad-hoc/manual production changes. Two candidates are already known and will be confirmed: the `avatars` bucket currently has no size or MIME limit although the repo's verification script expects both, and the invoice-flag backfill was applied with an adapted body. The 46 ledger-missing versions will be classified per object as *applied under a different ledger stamp* versus *genuinely absent*.
- **E.** Whether the snapshot generated cleanly, and exactly which parts are catalogue-derived versus documented-only.
- **F.** Where the files are and how to move them.

`supabase/verify/security_verification.sql` is re-run read-only against production so the security invariants the snapshot must preserve are recorded as PASS/FAIL rather than assumed.

## Transfer to the self-hosted server

The directory is a plain set of text files under `/mnt/documents/`, downloadable from the project's files. Recommended apply order on a fresh PostgreSQL 17 instance: start the Supabase stack (so managed schemas exist), then run files 01 through 08 in numeric order, then 10 last once the Vault secrets have been recreated by hand. `REPORT.md` will state this as a checklist.

## Guarantees

Read-only throughout: catalogue `SELECT`s only, no migration is created or applied, no production object is touched, and nothing is committed or pushed. No repository file is modified — every artefact lands in `/mnt/documents/`.
