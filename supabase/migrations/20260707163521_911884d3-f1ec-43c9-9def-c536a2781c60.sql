-- KPI summary for the Orders list. Runs as SECURITY INVOKER so RLS on
-- public.orders scopes rows to what the caller can already see (admins/owners/
-- view_all_agents see all; other users see their own).
CREATE OR REPLACE FUNCTION public.orders_kpi_summary(
  _from     date,
  _to       date,
  _team     text  DEFAULT 'all',
  _agent    uuid  DEFAULT NULL,
  _status   text  DEFAULT 'all',
  _mine     boolean DEFAULT false,
  _q        text  DEFAULT NULL
) RETURNS jsonb
LANGUAGE sql
STABLE
SET search_path TO 'public'
AS $$
  WITH base AS (
    SELECT o.*
    FROM public.orders o
    WHERE
      (_q IS NULL OR length(btrim(_q)) = 0 OR (
        o.order_date >= _from AND o.order_date <= _to
      ))
      -- when searching, drop the date window (matches client behaviour)
      AND (_q IS NOT NULL AND length(btrim(_q)) > 0
           OR (o.order_date >= _from AND o.order_date <= _to))
      AND (_team = 'all' OR o.team::text = _team)
      AND (_status = 'all' OR o.status = _status)
      AND (_agent IS NULL OR o.agent_id = _agent)
      AND (NOT _mine OR o.agent_id = auth.uid())
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

GRANT EXECUTE ON FUNCTION public.orders_kpi_summary(date, date, text, uuid, text, boolean, text) TO authenticated;