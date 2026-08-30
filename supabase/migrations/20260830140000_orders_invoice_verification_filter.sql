-- Orders — carry the Invoice Verification filter into the KPI cards.
--
-- ---------------------------------------------------------------------------
-- Why the RPC has to change
-- ---------------------------------------------------------------------------
-- The Orders table narrows through PostgREST (`applyOrderFilters`); the three
-- KPI cards above it are a separate server-side aggregation. A predicate added
-- to only one of them puts a list and a total on the same screen describing
-- different sets of orders — the defect `order_fulfillment()` was introduced to
-- end, and the reason `_starred` was appended here rather than applied on the
-- client. `_verification` follows that precedent exactly.
--
-- The filter is three states over one existing column, `orders.invoices_verified`:
--
--   'all'         no narrowing
--   'verified'    invoices_verified IS TRUE
--   'unverified'  invoices_verified IS NOT TRUE
--
-- `IS NOT TRUE`, never `= false` and never `NOT invoices_verified`. The column is
-- nullable and an order the MIS has not answered for yet holds NULL, so under
-- SQL's three-valued logic both of those evaluate to NULL rather than true and
-- would silently drop the majority of the rows *Non verified* is asking for.
-- src/features/orders/verification.ts is the TypeScript mirror and
-- __tests__/verification.test.ts pins the two together.
--
-- ---------------------------------------------------------------------------
-- Why two DROPs
-- ---------------------------------------------------------------------------
-- Adding a parameter makes a new signature rather than replacing the old one,
-- and leaving a superseded signature in place makes a call ambiguous between
-- them. Two are dropped rather than one because an earlier, since-reverted
-- attempt at this feature shipped an 11-argument version
-- (`_verification text, _agent_ids uuid[]`) that may already have been applied
-- to a database even though its migration file no longer exists in the tree.
-- Both DROPs are `IF EXISTS`, so this runs correctly whether that function is
-- present or not.
--
-- `_verification` carries a default, so the MCP tools that call this with the
-- original argument list are unaffected.

BEGIN;

DROP FUNCTION IF EXISTS public.orders_kpi_summary(
  date, date, text, uuid, text, boolean, text, text, boolean);

DROP FUNCTION IF EXISTS public.orders_kpi_summary(
  date, date, text, uuid, text, boolean, text, text, boolean, text, uuid[]);

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
  _verification text    DEFAULT 'all'
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
      -- The mirror of `matchesVerification` / `applyVerification`. See the note
      -- above on IS NOT TRUE.
      AND (
        _verification = 'all'
        OR (_verification = 'verified'   AND o.invoices_verified IS TRUE)
        OR (_verification = 'unverified' AND o.invoices_verified IS NOT TRUE)
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
  date, date, text, uuid, text, boolean, text, text, boolean, text) TO authenticated;

COMMIT;
