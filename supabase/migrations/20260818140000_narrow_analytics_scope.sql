-- Narrow the two analytics scope functions to the columns their callers read.
--
-- ---------------------------------------------------------------------------
-- What was measured
-- ---------------------------------------------------------------------------
-- `orders_in_scope()` is `RETURNS SETOF public.orders` doing `SELECT o.*`, and
-- carries `SET search_path TO 'public'`. A `SET` clause makes a set-returning
-- SQL function non-inlinable (`inline_set_returning_function()` bails when
-- `pg_proc.proconfig` is non-null), so the nine `orders_*` RPCs that select from
-- it each execute it as an opaque **Function Scan**: every qualifying row is
-- materialised into a tuplestore, at full 19-column width, before the caller
-- projects it down to the two or three columns it aggregates.
--
-- Measured on PostgreSQL 18.3 with 120k synthetic orders (see the commit
-- message for the caveats — this is not production hardware):
--
--   window     rows scanned   shared blocks (wide / narrow)   temp blocks (wide / narrow)
--   1 month           5,084          786  /  786                     0  /     0
--   1 quarter        15,088        1,732  / 1,732                 2,468  /     0
--   1 year           59,860        5,872  / 5,872                 9,776  /     0
--
-- The `shared blocks` column is the important one, and it is what the previous
-- audit guessed wrong: it is **identical**. Postgres is a row store, so a heap
-- scan reads the same pages whether the query wants three columns or nineteen —
-- narrowing the projection saves no I/O at all against the base table.
--
-- The cost is entirely in the tuplestore. Wide tuples fill `work_mem` sooner,
-- and past roughly fifteen thousand rows in the window the Function Scan starts
-- **spilling to temp files** — 9,776 temp blocks over a year window where the
-- narrow equivalent spills nothing. That is the real defect: not wasted reads,
-- but a materialisation whose size is set by the widest column in the table
-- (`notes`, unbounded free text) rather than by what the aggregation needs.
--
-- ---------------------------------------------------------------------------
-- The change
-- ---------------------------------------------------------------------------
-- One function each, nine + two RPCs untouched. The returned column list is the
-- **union of what every caller references**, so there is still exactly one
-- definition of the analytics filter and no aggregation moves:
--
--   orders_in_scope      order_date, team, agent_id, order_type, branch_no,
--                        delivery_type, invoice_value, status, call_center_verified
--   complaints_in_scope  branch_no, status
--
-- Dropped from the orders scope are `id`, `order_no`, `invoice_no`, `notes`,
-- `display_no`, `customer_name`, `customer_phone`, `invoices_verified`,
-- `created_by`, `created_at`, `updated_at` — every wide text column among them,
-- and not one of them read by any of the nine aggregations. From the complaints
-- scope, `description` and `resolution` go the same way.
--
-- Security is unchanged and deliberately so. Both stay SECURITY INVOKER, so RLS
-- on the base tables is still what decides which rows a caller sees; both keep
-- `SET search_path TO 'public'`; the WHERE clause, including the `auth.uid()`
-- test behind `_mine`, is copied across character for character. Making these
-- inlinable by dropping the `SET` clause was considered and rejected: it is
-- security hardening, and the measurement above shows narrowing already closes
-- the gap to a hand-inlined query (4.35ms vs 4.47ms over a month window).
--
-- DROP then CREATE, not CREATE OR REPLACE: the return type changes, and Postgres
-- will not replace a function with one that returns something else. The argument
-- signature is untouched, so all eleven call sites still resolve. The bodies are
-- stored as text rather than as parsed `BEGIN ATOMIC` blocks, so no dependency
-- tracking objects to the drop. Grants are re-issued because a drop takes them
-- with it.

BEGIN;

DROP FUNCTION IF EXISTS public.orders_in_scope(date, date, text, uuid, boolean);

CREATE FUNCTION public.orders_in_scope(
  _from  date,
  _to    date,
  _team  text    DEFAULT 'all',
  _agent uuid    DEFAULT NULL,
  _mine  boolean DEFAULT false
) RETURNS TABLE(
  order_date           date,
  team                 public.app_role,
  agent_id             uuid,
  order_type           text,
  branch_no            text,
  delivery_type        text,
  invoice_value        numeric,
  status               text,
  call_center_verified boolean
)
LANGUAGE sql
STABLE
SECURITY INVOKER
SET search_path TO 'public'
AS $$
  SELECT o.order_date, o.team, o.agent_id, o.order_type, o.branch_no,
         o.delivery_type, o.invoice_value, o.status, o.call_center_verified
  FROM public.orders o
  WHERE o.order_date >= _from
    AND o.order_date <= _to
    AND (_team = 'all' OR o.team::text = _team)
    AND (_agent IS NULL OR o.agent_id = _agent)
    AND (NOT _mine OR o.agent_id = auth.uid())
$$;

GRANT EXECUTE ON FUNCTION public.orders_in_scope(date, date, text, uuid, boolean) TO authenticated;

DROP FUNCTION IF EXISTS public.complaints_in_scope(date, date, uuid, boolean);

CREATE FUNCTION public.complaints_in_scope(
  _from  date,
  _to    date,
  _agent uuid    DEFAULT NULL,
  _mine  boolean DEFAULT false
) RETURNS TABLE(
  branch_no text,
  status    text
)
LANGUAGE sql
STABLE
SECURITY INVOKER
SET search_path TO 'public'
AS $$
  SELECT c.branch_no, c.status
  FROM public.complaints c
  WHERE c.complaint_date >= _from
    AND c.complaint_date <= _to
    AND (_agent IS NULL OR c.agent_id = _agent)
    AND (NOT _mine OR c.agent_id = auth.uid())
$$;

GRANT EXECUTE ON FUNCTION public.complaints_in_scope(date, date, uuid, boolean) TO authenticated;

COMMIT;
