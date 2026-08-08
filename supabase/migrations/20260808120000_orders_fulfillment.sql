-- [ORDERS] Fulfillment: one definition of delivery vs store pickup.
--
-- Three things, all of them consequences of the same gap: `orders.delivery_type`
-- records the courier or hand-over method, and nothing recorded whether that
-- method *is* a delivery. Every caller re-derived it, and the derivations had
-- already drifted from each other.
--
--   1. `order_fulfillment()` — the SQL mirror of `classifyFulfillment()` in
--      src/features/orders/fulfillment.ts. It exists only because a PostgREST
--      filter cannot call into TypeScript; it is deliberately the same three
--      cases in the same order, and the TS suite pins both to one value table.
--
--   2. `orders_kpi_summary` — its `_fulfillment` predicate said
--      `COALESCE(delivery_type,'') NOT ILIKE '%pickup%'` for the delivery group,
--      which counts a row with NO method recorded as a delivery. The list query
--      beside it used PostgREST `not(...ilike)`, which under SQL's three-valued
--      logic drops that same row. The table and the KPI cards above it were
--      therefore totalling different sets of orders — the bug that presented as
--      "the Delivery/Pickup filter is not working". Both now agree: a row with no
--      method is in neither group. The parameter also accepts a `delivery_type`
--      verbatim, so filtering to one courier narrows the cards as well as the list.
--
--   3. `orders_delivery` — gains completed-order counts, split Cash/Wasfaty, so
--      the Dashboard's fulfillment mix is a fold over rows it ALREADY fetches
--      rather than a new query or a new pass over the orders table. It returns
--      one row per method (four of them today), so the analytic costs nothing.
--
-- Return type changes, so `orders_delivery` is dropped and recreated: Postgres
-- will not let CREATE OR REPLACE add columns to a RETURNS TABLE.

/* -------------------------------------------------------------------------- */
/* 1. The classifier                                                          */
/* -------------------------------------------------------------------------- */

CREATE OR REPLACE FUNCTION public.order_fulfillment(_delivery_type text)
RETURNS text
LANGUAGE sql
IMMUTABLE
SET search_path TO 'public'
AS $$
  -- NULL rather than a third label: a row that records no hand-over method is
  -- not a known delivery and certainly not a pickup, and folding it into either
  -- side would be inventing the answer. Callers report it separately.
  SELECT CASE
    WHEN _delivery_type IS NULL OR btrim(_delivery_type) = '' THEN NULL
    -- Pickup is the closed half of the cut — the business controls that wording.
    -- Delivery is open, so a courier signed next quarter counts the day it
    -- appears in the data, with no migration.
    WHEN _delivery_type ILIKE '%pickup%' THEN 'pickup'
    ELSE 'delivery'
  END
$$;

COMMENT ON FUNCTION public.order_fulfillment(text) IS
  'Delivery vs store pickup for one orders.delivery_type. Mirror of classifyFulfillment() in src/features/orders/fulfillment.ts — change both together.';

GRANT EXECUTE ON FUNCTION public.order_fulfillment(text) TO authenticated;

/* -------------------------------------------------------------------------- */
/* 2. Orders list KPI summary                                                 */
/* -------------------------------------------------------------------------- */

CREATE OR REPLACE FUNCTION public.orders_kpi_summary(
  _from        date,
  _to          date,
  _team        text  DEFAULT 'all',
  _agent       uuid  DEFAULT NULL,
  _status      text  DEFAULT 'all',
  _mine        boolean DEFAULT false,
  _q           text  DEFAULT NULL,
  _fulfillment text  DEFAULT 'all'
) RETURNS jsonb
LANGUAGE sql
STABLE
SET search_path TO 'public'
AS $$
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
        -- A group: delegate to the classifier so this can never drift from the
        -- list query again. NULL = NULL is not true, so unrecorded methods fall
        -- out of both groups exactly as they do client-side.
        OR (_fulfillment IN ('delivery', 'pickup')
            AND public.order_fulfillment(o.delivery_type) = _fulfillment)
        -- One method, verbatim. Equality, so it can never disagree with the
        -- group that contains it.
        OR (_fulfillment NOT IN ('all', 'delivery', 'pickup')
            AND o.delivery_type = _fulfillment)
      )
      AND (
        _q IS NULL OR length(btrim(_q)) = 0
        OR o.customer_name ILIKE '%' || _q || '%'
        OR o.customer_phone ILIKE '%' || _q || '%'
        OR o.invoice_no ILIKE '%' || _q || '%'
        OR o.display_no ILIKE '%' || _q || '%'
        OR o.branch_no ILIKE '%' || _q || '%'
        OR o.notes ILIKE '%' || _q || '%'
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
$$;

GRANT EXECUTE ON FUNCTION public.orders_kpi_summary(date, date, text, uuid, text, boolean, text, text) TO authenticated;

/* -------------------------------------------------------------------------- */
/* 3. Delivery-method performance, with completed counts                      */
/* -------------------------------------------------------------------------- */

DROP FUNCTION IF EXISTS public.orders_delivery(date, date, text, uuid, boolean);

CREATE FUNCTION public.orders_delivery(
  _from  date,
  _to    date,
  _team  text    DEFAULT 'all',
  _agent uuid    DEFAULT NULL,
  _mine  boolean DEFAULT false
) RETURNS TABLE(
  delivery_type            text,
  order_count              bigint,
  completed_sales          numeric,
  completion_rate          numeric,
  -- Added: the Dashboard's fulfillment mix is COMPLETED orders only, split by
  -- order type. Returned per method and folded client-side, so delivery vs
  -- pickup and its Cash/Wasfaty composition cost no additional query.
  completed_count          bigint,
  completed_cash_count     bigint,
  completed_wasfaty_count  bigint
)
LANGUAGE sql
STABLE
SECURITY INVOKER
SET search_path TO 'public'
AS $$
  SELECT COALESCE(delivery_type, '—') AS delivery_type,
         COUNT(*) AS order_count,
         COALESCE(SUM(invoice_value) FILTER (WHERE status = 'Completed'), 0) AS completed_sales,
         CASE WHEN COUNT(*) > 0
              THEN (COUNT(*) FILTER (WHERE status = 'Completed')::numeric / COUNT(*)) * 100
              ELSE 0 END AS completion_rate,
         COUNT(*) FILTER (WHERE status = 'Completed') AS completed_count,
         COUNT(*) FILTER (WHERE status = 'Completed' AND order_type = 'Cash') AS completed_cash_count,
         COUNT(*) FILTER (WHERE status = 'Completed' AND order_type = 'Wasfaty') AS completed_wasfaty_count
  FROM public.orders_in_scope(_from, _to, _team, _agent, _mine)
  GROUP BY delivery_type
  ORDER BY order_count DESC
$$;

GRANT EXECUTE ON FUNCTION public.orders_delivery(date, date, text, uuid, boolean) TO authenticated;
