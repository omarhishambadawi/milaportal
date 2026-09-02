-- Telesales CRM: resolve a lead's refill cycle the way the engine does.
--
-- ===========================================================================
-- The defect
-- ===========================================================================
-- The retention workbook uses **two code systems for the same medicines**. Of
-- the 745 imported source rows, 654 carry the pharmacy's eight-digit catalogue
-- codes and 88 carry a five- or six-digit number for products the catalogue
-- already holds -- sixteen distinct codes all naming
-- `MOUNJARO KWIKPEN 5 MG/0.6ML 2.4ML*1 AA`, for one example. The import stored
-- what the file said, which is correct; the consequence landed downstream.
--
-- Both this view and `recommendations.ts` looked a cycle up by item code alone,
-- so those 88 leads had no `refill_days`, therefore no projected due date, and
-- therefore no refill lifecycle and no possibility of ever being recommended.
-- Twelve of them showed "No refill scheduled" while the pharmacy's own
-- catalogue knew the product's cycle perfectly well.
--
-- ===========================================================================
-- The fix, and why it is conservative
-- ===========================================================================
-- An exact code match still wins. Only when the code is absent from the
-- catalogue is the product's **name** consulted, compared whole and normalised
-- for whitespace and case only -- the same compare the invoice reconciler uses,
-- and for the same reason: `MOUNJARO KWIKPEN 5 MG` and `MOUNJARO KWIKPEN 15MG`
-- are different medicines, and a prefix or fuzzy match would silently equate
-- two doses.
--
-- Measured against live data before applying: 76 of the 88 leads do not move at
-- all (they carry an agreed callback, which already decided their due date), 12
-- move from `none` to `active` by gaining a real due date, and **none becomes
-- stale**. Nothing is hidden, archived or de-prioritised as a result.
--
-- `buildCycleIndex` in `recommendations.ts` resolves it identically, so the
-- queue and Recommended Leads cannot disagree about which leads have a cycle.
--
-- ===========================================================================
-- Two joins rather than one, on purpose
-- ===========================================================================
-- The obvious shapes are both worse. A single scan with an `OR`, or a ranked
-- `LATERAL`, forces the catalogue to be re-examined per lead: measured at 35-37
-- ms against 712 leads, against 4.6 ms before the change. Two plain LEFT JOINs
-- are hashed once each -- 28 rows apiece -- and bring it to 15 ms while doing
-- strictly more work than the original did.
--
-- The `CASE` picks the *row*, not the value. A catalogued product whose
-- `refill_days` is NULL must stay cycle-less rather than inherit one from a
-- product that happens to share its name, so the code match wins whenever it
-- matched at all. Active product names are unique, so the name join cannot
-- multiply rows.
--
-- ===========================================================================
-- Also fixed here: inactive products
-- ===========================================================================
-- The view joined `telesales_products` with no `active` filter while the engine
-- loads cycles with `active = true`. No product is inactive today, so nothing
-- diverged yet -- but deactivating one would have made a lead stale on the
-- queue and cycle-less in the engine, which is exactly the disagreement the
-- lifecycle view exists to prevent. Both joins now filter `active`.

DROP VIEW IF EXISTS public.telesales_lead_lifecycle;

CREATE VIEW public.telesales_lead_lifecycle
WITH (security_invoker = true) AS
SELECT
  l.*,

  -- The code match wins whenever the catalogue carries the code at all.
  CASE WHEN pc.item_code IS NOT NULL THEN pc.refill_days ELSE pn.refill_days END
    AS refill_cycle_days,

  h.last_purchased_on,
  d.refill_due_on,

  -- One full cycle of grace. The 30-day fallback is reachable only by a lead
  -- whose due date came from a callback -- a projection cannot exist without a
  -- cycle to project with.
  d.refill_due_on
    + COALESCE(CASE WHEN pc.item_code IS NOT NULL THEN pc.refill_days ELSE pn.refill_days END, 30)
    AS stale_after,

  -- Riyadh, not UTC. `businessToday()` reads the Riyadh calendar date and this
  -- must agree with it, or every lead would change state three hours early.
  CASE
    WHEN d.refill_due_on IS NULL THEN 'none'
    WHEN (now() AT TIME ZONE 'Asia/Riyadh')::date
         > d.refill_due_on
           + COALESCE(
               CASE WHEN pc.item_code IS NOT NULL THEN pc.refill_days ELSE pn.refill_days END, 30)
      THEN 'stale'
    ELSE 'active'
  END AS lifecycle

FROM public.telesales_leads l

-- By code.
LEFT JOIN public.telesales_products pc
       ON pc.active AND pc.item_code = l.item_code

-- By name, used only where the code matched nothing.
LEFT JOIN public.telesales_products pn
       ON pn.active
      AND upper(regexp_replace(pn.item_name, '\s+', ' ', 'g'))
        = upper(regexp_replace(l.item_name,  '\s+', ' ', 'g'))

-- The most recent purchase of this product by this customer. Not the lead's own
-- `source_date`: nearly always the same value, but it differs on 29 of the 712
-- open leads -- those whose customer has bought again since the lead was
-- raised -- and using the lead's date there would make this view disagree with
-- the recommendation engine about which leads are stale.
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
  SELECT COALESCE(
    l.next_followup_on,
    h.last_purchased_on
      + CASE WHEN pc.item_code IS NOT NULL THEN pc.refill_days ELSE pn.refill_days END
  ) AS refill_due_on
) d;

COMMENT ON VIEW public.telesales_lead_lifecycle IS
  'telesales_leads with the derived refill lifecycle. Computed on every read, '
  'so it cannot go out of date; nothing here is stored. security_invoker=true, '
  'so the policies on telesales_leads still decide what a caller sees. The '
  'boundary matches src/lib/telesales/lifecycle.ts and the cycle is resolved '
  'the way buildCycleIndex resolves it -- by item code, falling back to an '
  'exact product name because the source workbook uses two code systems for '
  'the same medicines.';

GRANT SELECT ON public.telesales_lead_lifecycle TO authenticated;
REVOKE ALL ON public.telesales_lead_lifecycle FROM anon;
REVOKE INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER
  ON public.telesales_lead_lifecycle FROM authenticated;
GRANT SELECT ON public.telesales_lead_lifecycle TO authenticated;

-- No index is added for the name join. `telesales_products` is 28 rows in one
-- page, so Postgres hashes it and an index would never be chosen; one was
-- created during this work, measured as unused, and dropped again.
DROP INDEX IF EXISTS public.telesales_products_name_idx;
