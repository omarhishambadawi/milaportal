CREATE OR REPLACE FUNCTION public.orders_delivery(
  _from  date,
  _to    date,
  _team  text    DEFAULT 'all',
  _agent uuid    DEFAULT NULL,
  _mine  boolean DEFAULT false
) RETURNS TABLE(
  delivery_type   text,
  order_count     bigint,
  completed_sales numeric,
  completion_rate numeric
)
LANGUAGE sql
STABLE
SECURITY INVOKER
SET search_path TO 'public'
AS $$
  WITH s AS (
    SELECT delivery_type, invoice_value
    FROM public.orders_in_scope(_from, _to, _team, _agent, _mine)
    WHERE status = 'Completed'
  ), t AS (
    SELECT COALESCE(SUM(invoice_value), 0) AS total FROM s
  )
  SELECT COALESCE(s.delivery_type, '—') AS delivery_type,
         COUNT(*) AS order_count,
         COALESCE(SUM(s.invoice_value), 0) AS completed_sales,
         CASE WHEN (SELECT total FROM t) > 0
              THEN (COALESCE(SUM(s.invoice_value), 0) / (SELECT total FROM t)) * 100
              ELSE 0 END AS completion_rate
  FROM s
  GROUP BY s.delivery_type
  ORDER BY order_count DESC
$$;

GRANT EXECUTE ON FUNCTION public.orders_delivery(date, date, text, uuid, boolean) TO authenticated;

DROP FUNCTION IF EXISTS public.orders_kpi_summary(date, date, text, uuid, text, boolean, text);

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
        OR (_fulfillment = 'pickup' AND o.delivery_type ILIKE '%pickup%')
        OR (_fulfillment = 'delivery' AND COALESCE(o.delivery_type, '') NOT ILIKE '%pickup%')
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