-- Orders — the Invoice Verification filter, and the search branches it sits beside.
--
-- ---------------------------------------------------------------------------
-- Why the RPC has to change at all
-- ---------------------------------------------------------------------------
-- The Orders table narrows through PostgREST (`applyOrderFilters`); the KPI
-- cards above it are a separate server-side aggregation. A predicate added to
-- only one of them puts a list and a total on the same screen describing
-- different sets of orders — the exact defect `order_fulfillment()` was
-- introduced to end, and the reason `_starred` was appended here rather than
-- applied client-side. Two things reached the table in this change and so both
-- have to reach the cards:
--
--   `_verification`  the new Invoice Verification filter. The four cases are the
--                    SQL mirror of `matchesVerification` in
--                    src/features/orders/verification.ts, and
--                    __tests__/verification.test.ts pins the two together.
--
--   `_agent_ids`     the seventh branch of the search disjunction. `agent_name`
--                    is joined from `profiles`, not a column on `orders`, so the
--                    client resolves the name against the agent directory it has
--                    already loaded and sends ids. The RPC takes them rather
--                    than re-joining, so the cards match the table exactly and
--                    the aggregation stays a single scan of `orders`.
--
-- The prefixed-order-number branch needs nothing here: `orderNumberTerm` turns
-- `c-3258` into `3258` before the term is sent, and `_q` is already matched
-- against `display_no`.
--
-- ---------------------------------------------------------------------------
-- Three-valued logic, again
-- ---------------------------------------------------------------------------
-- `invoices_verified` and `call_center_verified` are nullable. `NOT
-- invoices_verified` is NULL — not true — for a row that has never been
-- verified, which is precisely the row *Not verified* is asking for. Every
-- negative test below is therefore written `IS NOT TRUE`, matching the
-- `not(col, is, true)` the PostgREST side uses. This is the same trap
-- `applyFulfillment` documents at length.
--
-- DROP then CREATE rather than CREATE OR REPLACE: adding parameters makes a new
-- signature, and leaving the 9-argument function in place would make a
-- 9-argument call ambiguous between the two. Both new parameters carry defaults,
-- so the MCP tools that call this with fewer arguments are unaffected.

BEGIN;

DROP FUNCTION IF EXISTS public.orders_kpi_summary(
  date, date, text, uuid, text, boolean, text, text, boolean);

CREATE OR REPLACE FUNCTION public.orders_kpi_summary(
  _from         date,
  _to           date,
  _team         text    DEFAULT 'all',
  _agent        uuid    DEFAULT NULL,
  _status       text    DEFAULT 'all',
  _mine         boolean DEFAULT false,
  _q            text    DEFAULT NULL,
  _fulfillment  text    DEFAULT 'all',
  _starred      boolean DEFAULT false,
  _verification text    DEFAULT 'all',
  _agent_ids    uuid[]  DEFAULT NULL
) RETURNS jsonb
LANGUAGE sql
STABLE
SET search_path TO 'public'
AS $function$
  WITH base AS (
    SELECT o.*
    FROM public.orders o
    WHERE
      (_q IS NOT NULL AND length(btrim(_q)) > 0
           OR (o.order_date >= _from AND o.order_date <= _to))
      AND (_team = 'all' OR o.team::text = _team)
      AND (_status = 'all' OR o.status = _status)
      AND (_agent IS NULL OR o.agent_id = _agent)
      AND (NOT _mine OR o.agent_id = auth.uid())
      AND (
        _fulfillment = 'all'
        OR (_fulfillment IN ('delivery', 'pickup')
            AND public.order_fulfillment(o.delivery_type) = _fulfillment)
        OR (_fulfillment NOT IN ('all', 'delivery', 'pickup')
            AND o.delivery_type = _fulfillment)
      )
      -- The mirror of `matchesVerification` / `applyVerification`. Four cases,
      -- same order, and every negative written IS NOT TRUE so a NULL flag counts
      -- as "not verified" rather than dropping the row.
      AND (
        _verification = 'all'
        OR (_verification = 'verified'        AND o.invoices_verified IS TRUE)
        OR (_verification = 'pending'         AND o.invoices_verified IS NOT TRUE)
        OR (_verification = 'call_centre'     AND o.call_center_verified IS TRUE)
        OR (_verification = 'non_call_centre' AND o.invoices_verified IS TRUE
                                              AND o.call_center_verified IS NOT TRUE)
      )
      -- Scoped to auth.uid() in the predicate itself, so the parameter cannot be
      -- used to total up somebody else's shortlist.
      AND (
        NOT _starred
        OR EXISTS (
          SELECT 1 FROM public.order_stars s
          WHERE s.order_id = o.id AND s.user_id = auth.uid()
        )
      )
      AND (
        _q IS NULL OR length(btrim(_q)) = 0
        OR o.customer_name ILIKE '%' || _q || '%'
        OR o.customer_phone ILIKE '%' || _q || '%'
        OR o.invoice_no ILIKE '%' || _q || '%'
        OR o.display_no ILIKE '%' || _q || '%'
        OR o.branch_no ILIKE '%' || _q || '%'
        OR o.notes ILIKE '%' || _q || '%'
        -- The agent branch. RLS still decides which rows come back, so a caller
        -- who passes ids they cannot see gets fewer rows, never more.
        OR (_agent_ids IS NOT NULL AND o.agent_id = ANY(_agent_ids))
      )
  )
  SELECT jsonb_build_object(
    'cash_sales',           COALESCE(SUM(invoice_value) FILTER (WHERE order_type = 'Cash'), 0),
    'cash_completed_sales', COALESCE(SUM(invoice_value) FILTER (WHERE order_type = 'Cash' AND status = 'Completed'), 0),
    'cash_count',           COUNT(*) FILTER (WHERE order_type = 'Cash'),
    'cash_completed_count', COUNT(*) FILTER (WHERE order_type = 'Cash' AND status = 'Completed'),
    'was_sales',            COALESCE(SUM(invoice_value) FILTER (WHERE order_type = 'Wasfaty'), 0),
    'was_completed_sales',  COALESCE(SUM(invoice_value) FILTER (WHERE order_type = 'Wasfaty' AND status = 'Completed'), 0),
    'was_count',            COUNT(*) FILTER (WHERE order_type = 'Wasfaty'),
    'was_completed_count',  COUNT(*) FILTER (WHERE order_type = 'Wasfaty' AND status = 'Completed'),
    'total_sales',          COALESCE(SUM(invoice_value), 0),
    'total_completed_sales',COALESCE(SUM(invoice_value) FILTER (WHERE status = 'Completed'), 0),
    'total_count',          COUNT(*),
    'completed_count',      COUNT(*) FILTER (WHERE status = 'Completed')
  ) FROM base
$function$;

GRANT EXECUTE ON FUNCTION public.orders_kpi_summary(
  date, date, text, uuid, text, boolean, text, text, boolean, text, uuid[]) TO authenticated;

COMMIT;
