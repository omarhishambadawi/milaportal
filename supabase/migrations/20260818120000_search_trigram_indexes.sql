-- Trigram indexes for the Orders and Complaints search boxes.
--
-- ---------------------------------------------------------------------------
-- The query being indexed
-- ---------------------------------------------------------------------------
-- Typing in the Orders search box drops the date window on purpose — a search is
-- for one specific order, not for one inside the current day (see
-- `applyOrderFilters` in src/features/orders/utils.ts). What is left is:
--
--   SELECT … FROM orders
--    WHERE customer_name  ILIKE '%term%'
--       OR customer_phone ILIKE '%term%'
--       OR invoice_no     ILIKE '%term%'
--       OR display_no     ILIKE '%term%'
--       OR branch_no      ILIKE '%term%'
--       OR notes          ILIKE '%term%'
--
-- `orders_kpi_summary` runs the same six-way OR for the KPI cards above the
-- table, and the XLSX export runs it again over every matching row. A leading
-- `%` makes every one of them unindexable by btree, so all three were sequential
-- scans of the whole table, repeated 300ms after the agent stops typing.
-- Complaints does the same thing over its own six columns.
--
-- gin_trgm_ops is the index type that answers `ILIKE '%…%'`. One per searched
-- column, because the planner can only turn the OR into a BitmapOr if *every*
-- branch has an index — leave one column out and the whole disjunction falls
-- back to a sequential scan, which is why `notes` and `description` are indexed
-- here despite being the least likely thing anyone searches for.
--
-- ---------------------------------------------------------------------------
-- Why the write cost is acceptable here
-- ---------------------------------------------------------------------------
-- GIN indexes are not free on INSERT/UPDATE. These two tables are filled by
-- agents typing into a form — tens of rows a day — while the search runs on
-- every settled keystroke of every agent on the floor. The trade is heavily one
-- sided in favour of the read.
--
-- Additive and idempotent: no existing index is dropped, no function, policy or
-- grant is touched, and no row is read or written, so results and RLS are
-- exactly as before. Plain CREATE INDEX rather than CONCURRENTLY because
-- migrations run inside a transaction; it takes a SHARE lock (blocking writes,
-- not reads) for the duration of the build.
--
-- Note: a trigram index can only serve patterns with at least one full trigram,
-- so a one- or two-character search still plans as it does today.

BEGIN;

CREATE EXTENSION IF NOT EXISTS pg_trgm WITH SCHEMA extensions;

-- pg_trgm lives in `extensions` on Supabase but in `public` on a plain local
-- Postgres, and the opclass name has to resolve either way. Setting the path for
-- this transaction only keeps the CREATE INDEX statements below portable without
-- hard-coding a schema that may not exist.
SET LOCAL search_path = public, extensions, pg_catalog;

-- Orders — the six columns buildSearchOr() and orders_kpi_summary() both read.
CREATE INDEX IF NOT EXISTS orders_customer_name_trgm_idx
  ON public.orders USING gin (customer_name gin_trgm_ops);
CREATE INDEX IF NOT EXISTS orders_customer_phone_trgm_idx
  ON public.orders USING gin (customer_phone gin_trgm_ops);
CREATE INDEX IF NOT EXISTS orders_invoice_no_trgm_idx
  ON public.orders USING gin (invoice_no gin_trgm_ops);
CREATE INDEX IF NOT EXISTS orders_display_no_trgm_idx
  ON public.orders USING gin (display_no gin_trgm_ops);
CREATE INDEX IF NOT EXISTS orders_branch_no_trgm_idx
  ON public.orders USING gin (branch_no gin_trgm_ops);
CREATE INDEX IF NOT EXISTS orders_notes_trgm_idx
  ON public.orders USING gin (notes gin_trgm_ops);

-- Complaints — the six columns its own buildSearchOr() reads. `agent_id.in.(…)`
-- is the seventh branch of that OR and is already served by the primary key
-- lookup path, so it needs nothing here.
CREATE INDEX IF NOT EXISTS complaints_display_no_trgm_idx
  ON public.complaints USING gin (display_no gin_trgm_ops);
CREATE INDEX IF NOT EXISTS complaints_customer_name_trgm_idx
  ON public.complaints USING gin (customer_name gin_trgm_ops);
CREATE INDEX IF NOT EXISTS complaints_customer_phone_trgm_idx
  ON public.complaints USING gin (customer_phone gin_trgm_ops);
CREATE INDEX IF NOT EXISTS complaints_branch_no_trgm_idx
  ON public.complaints USING gin (branch_no gin_trgm_ops);
CREATE INDEX IF NOT EXISTS complaints_category_trgm_idx
  ON public.complaints USING gin (category gin_trgm_ops);
CREATE INDEX IF NOT EXISTS complaints_description_trgm_idx
  ON public.complaints USING gin (description gin_trgm_ops);

-- Keeps the planner's estimates honest for the new indexes straight away rather
-- than at the next autovacuum — same reason as 20260805170000.
ANALYZE public.orders;
ANALYZE public.complaints;

COMMIT;
