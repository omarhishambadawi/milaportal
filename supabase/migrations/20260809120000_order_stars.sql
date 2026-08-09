-- order_stars — one agent's personal shortlist of orders.
--
-- Stars were localStorage (`milaserv.orders.starred.<user id>`), which made them
-- per browser: an agent who starred an order on the call-floor machine saw none
-- of it on their laptop. This is that state, moved to Postgres so it follows the
-- account rather than the device.
--
-- A star is a (user, order) pair and nothing else. There is no `starred` column
-- on `orders` on purpose: the flag is per *agent*, and a column would make it one
-- shared value that the last agent to click won — exactly the isolation the
-- feature exists to provide.
--
-- Isolation is RLS, not application code. `auth.uid() = user_id` on all three
-- commands means Agent A's stars are unreachable for Agent B through PostgREST,
-- the RPC layer, or anything else holding an `authenticated` JWT — including
-- administrators, deliberately: a shortlist is personal, and no role in this
-- system has a reason to read someone else's. There is no UPDATE policy and no
-- UPDATE grant, because a star has no mutable field; toggling is INSERT/DELETE.

BEGIN;

CREATE TABLE IF NOT EXISTS public.order_stars (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id    uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  order_id   uuid NOT NULL REFERENCES public.orders(id) ON DELETE CASCADE,
  created_at timestamptz NOT NULL DEFAULT now(),
  -- The same agent cannot star the same order twice. This is also the index the
  -- feature reads through — "my stars" is a prefix scan on `user_id` — so no
  -- second index is created for it.
  CONSTRAINT order_stars_user_order_key UNIQUE (user_id, order_id)
);

-- Supabase grants `anon` full table privileges by default on new public tables.
-- Nothing anonymous may touch a personal shortlist, and RLS with no anon policy
-- would already stop it; the revoke states it rather than relying on that.
REVOKE ALL ON public.order_stars FROM anon;
-- `authenticated` is revoked first for the same reason: the default grant hands
-- it UPDATE and TRUNCATE as well, and a star has no mutable field. RLS would
-- refuse an UPDATE anyway (there is no policy for it), but a privilege that is
-- only ever denied by a second mechanism is a privilege waiting to be relied on.
REVOKE ALL ON public.order_stars FROM authenticated;
GRANT SELECT, INSERT, DELETE ON public.order_stars TO authenticated;
GRANT ALL ON public.order_stars TO service_role;

ALTER TABLE public.order_stars ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "own order stars select" ON public.order_stars;
CREATE POLICY "own order stars select" ON public.order_stars
  FOR SELECT TO authenticated USING (auth.uid() = user_id);

-- WITH CHECK, not USING: this is what stops an agent inserting a row that names
-- somebody else as its owner.
DROP POLICY IF EXISTS "own order stars insert" ON public.order_stars;
CREATE POLICY "own order stars insert" ON public.order_stars
  FOR INSERT TO authenticated WITH CHECK (auth.uid() = user_id);

DROP POLICY IF EXISTS "own order stars delete" ON public.order_stars;
CREATE POLICY "own order stars delete" ON public.order_stars
  FOR DELETE TO authenticated USING (auth.uid() = user_id);

-- ---------------------------------------------------------------------------
-- orders_kpi_summary — carry the starred filter into the KPI cards.
-- ---------------------------------------------------------------------------
-- The list narrows to the agent's stars through PostgREST; the cards above it
-- are a separate server-side aggregation, and if the predicate were added to
-- only one of them the page would once again show a table and a total that
-- describe different sets of orders — the exact defect `order_fulfillment()`
-- was introduced to end. `_starred` is appended with a default so existing
-- callers (the MCP tools) are unaffected.
--
-- DROP then CREATE rather than CREATE OR REPLACE: adding a parameter makes a new
-- signature, and leaving the 8-argument function in place would make an
-- 8-argument call ambiguous between the two.
DROP FUNCTION IF EXISTS public.orders_kpi_summary(date, date, text, uuid, text, boolean, text, text);

CREATE OR REPLACE FUNCTION public.orders_kpi_summary(
  _from        date,
  _to          date,
  _team        text    DEFAULT 'all',
  _agent       uuid    DEFAULT NULL,
  _status      text    DEFAULT 'all',
  _mine        boolean DEFAULT false,
  _q           text    DEFAULT NULL,
  _fulfillment text    DEFAULT 'all',
  _starred     boolean DEFAULT false
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

GRANT EXECUTE ON FUNCTION public.orders_kpi_summary(date, date, text, uuid, text, boolean, text, text, boolean) TO authenticated;

COMMIT;
