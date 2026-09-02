-- Telesales CRM: the lead lifecycle, derived rather than stored.
--
-- ===========================================================================
-- A view, not a column
-- ===========================================================================
-- Staleness is a function of *today*. A lead due on 1 August with a 28-day
-- cycle becomes stale on 30 August without anything happening to it, so a
-- stored `is_stale` boolean is correct only until midnight and then needs a job
-- to keep it true. A flag that silently rots is worse than no flag.
--
-- It is also orthogonal to `status`. A lead can be `follow_up` *and* stale, or
-- `new` and stale. Folding the two axes into one column would destroy the
-- answer to "has anybody actually worked this?", which is the question the
-- status column exists to answer and the one a supervisor looking at a
-- 479-lead backlog needs most.
--
-- So nothing is written down. This view computes the boundary on every read,
-- which means it cannot disagree with the clock, and -- because the boundary is
-- a plain date column -- the queue can still filter and page on it server-side
-- rather than dragging the table into the browser.
--
-- ===========================================================================
-- The same rule as the recommendation engine, deliberately
-- ===========================================================================
-- `src/lib/telesales/lifecycle.ts` is the source of truth for the rule, and
-- both the queue and Recommended Leads call it. This view reproduces the
-- *boundary date* so SQL can filter on it. The two must agree:
--
--   due_on      = next_followup_on, else (last purchase of this product + cycle)
--   stale_after = due_on + cycle
--   stale       = business today > stale_after
--
-- A human-confirmed callback wins over a projection in both places. That is the
-- Phase 3 precedence rule, and this view does not get an opinion of its own.
--
-- ===========================================================================
-- RLS
-- ===========================================================================
-- `security_invoker = true` is the whole reason this is safe. Without it a view
-- runs as its owner and would hand every caller every lead, straight past the
-- policies on `telesales_leads`. With it the view is a lens, and those policies
-- still decide what the caller may see.

-- The per-lead purchase lookup below is what makes this a lookup and not a scan.
CREATE INDEX IF NOT EXISTS telesales_source_records_phone_item_idx
  ON public.telesales_source_records (phone, item_code, source_date DESC)
  WHERE archived_at IS NULL AND phone IS NOT NULL;

DROP VIEW IF EXISTS public.telesales_lead_lifecycle;

CREATE VIEW public.telesales_lead_lifecycle
WITH (security_invoker = true) AS
SELECT
  l.*,

  -- The product's configured cycle. NULL where nobody has classified the
  -- product, which is a real state: there is no rhythm to be late against.
  p.refill_days AS refill_cycle_days,

  -- The most recent purchase of *this* product by *this* customer.
  --
  -- Not the lead's own `source_date`. Nearly always the same value, but it
  -- differs on 29 of the 712 open leads -- the ones whose customer has bought
  -- again since the lead was raised. Using the lead's own date there would make
  -- this view disagree with the recommendation engine about which leads are
  -- stale, which is exactly the bug this migration exists to avoid.
  h.last_purchased_on,

  d.refill_due_on,

  -- The last day the opportunity is still current: one full cycle of grace.
  -- The 30-day fallback is reachable only by a lead whose due date came from a
  -- callback -- a projection cannot exist without a cycle to project with.
  d.refill_due_on + COALESCE(p.refill_days, 30) AS stale_after,

  -- The verdict, evaluated now.
  --
  -- Riyadh, not UTC. `businessToday()` in the application reads the Riyadh
  -- calendar date and this must agree with it, or every lead would change state
  -- three hours early each night.
  CASE
    WHEN d.refill_due_on IS NULL THEN 'none'
    WHEN (now() AT TIME ZONE 'Asia/Riyadh')::date
         > d.refill_due_on + COALESCE(p.refill_days, 30) THEN 'stale'
    ELSE 'active'
  END AS lifecycle

FROM public.telesales_leads l
LEFT JOIN public.telesales_products p ON p.item_code = l.item_code
LEFT JOIN LATERAL (
  SELECT max(s.source_date) AS last_purchased_on
  FROM public.telesales_source_records s
  WHERE s.archived_at IS NULL
    AND s.phone = l.phone
    AND s.item_code = l.item_code
) h ON true
CROSS JOIN LATERAL (
  -- The agreed callback wins. A date a human committed to outranks a
  -- projection, here and in the engine.
  SELECT COALESCE(l.next_followup_on, h.last_purchased_on + p.refill_days) AS refill_due_on
) d;

COMMENT ON VIEW public.telesales_lead_lifecycle IS
  'telesales_leads with the derived refill lifecycle. Computed on every read, '
  'so it cannot go out of date; nothing here is stored. security_invoker=true, '
  'so the policies on telesales_leads still decide what a caller sees. The '
  'boundary matches src/lib/telesales/lifecycle.ts -- one full refill cycle '
  'past the due date, with an agreed callback taking precedence over the '
  'projection from the last purchase.';

GRANT SELECT ON public.telesales_lead_lifecycle TO authenticated;

-- The project's default privileges hand every new relation to `anon`, which is
-- how four Telesales functions ended up executable by anon in `20260903150000`.
-- Nothing leaks here -- `security_invoker` resolves `telesales_leads` as the
-- caller, and anon holds no grant on that table, so a read is refused before
-- RLS is even consulted -- but a write grant on a view nobody may write is
-- noise in an access audit. Take them back explicitly.
REVOKE ALL ON public.telesales_lead_lifecycle FROM anon;
REVOKE INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER
  ON public.telesales_lead_lifecycle FROM authenticated;
GRANT SELECT ON public.telesales_lead_lifecycle TO authenticated;
