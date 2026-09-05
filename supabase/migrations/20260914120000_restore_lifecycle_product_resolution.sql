-- Telesales CRM: put the lifecycle view's product resolution back.
--
-- ===========================================================================
-- What went wrong
-- ===========================================================================
-- `20260913120000` needed `telesales_lead_lifecycle` rebuilt, because the view
-- selects `l.*` and that list is expanded at creation time -- a new column on
-- `telesales_leads` is invisible until the view is recreated, and CREATE OR
-- REPLACE cannot insert a column in the middle of a view's output list.
--
-- It rebuilt the view from the wrong ancestor. Four migrations define this
-- view:
--
--   20260906120000  the original: one join, `p.item_code = l.item_code`
--   20260908120000  cycle resolution
--   20260909120000  product identity -- code, then alias, then product name
--   20260913120000  rebuilt from 20260906120000's text  <-- the mistake
--
-- Copying the oldest definition silently reverted the two after it. Nothing
-- errored, because the columns it dropped are read by nobody and the ones it
-- kept still had the right names -- it simply started answering differently.
--
-- Measured on production before this migration:
--
--   * 91 live leads lost their refill cycle entirely (88 resolved by an active
--     alias, 3 by product name). Those read `lifecycle = 'none'` instead of
--     `active` or `stale`, which moves the queue's lifecycle filter, the stale
--     backlog counts, the Days-to-Refill badge and the Recommended engine.
--   * 13 leads had a wrong `last_purchased_on`, because the purchase lookup
--     reverted from "any code that means this medicine" to "this exact code".
--   * `canonical_item_code` and `canonical_via` disappeared from the view.
--
-- ===========================================================================
-- What this migration is
-- ===========================================================================
-- `20260909120000`'s view definition, verbatim, and nothing else.
--
-- `import_id` needs no mention: it is a column on `telesales_leads`, so `l.*`
-- picks it up now that the column exists. That is the whole reason the rebuild
-- was needed in the first place, and it is why restoring the correct ancestor
-- is sufficient rather than a merge of two definitions.
--
-- Deliberately NOT touched: the append-only trigger on
-- `telesales_lead_activities`, `telesales_delete_lead`,
-- `telesales_wasfaty_cycles`, `telesales_leads.import_id`, its trigger, its
-- index, and every other object `20260913120000` created. This migration
-- replaces one view definition.
--
-- The grants are re-issued because DROP VIEW takes them with it. They are the
-- same four statements `20260909120000` and `20260913120000` both ended with,
-- and `security_invoker = true` is restated for the same reason it always is:
-- without it the view would run as its owner and hand every caller every lead,
-- straight past the policies on `telesales_leads`.

DROP VIEW IF EXISTS public.telesales_lead_lifecycle;

CREATE VIEW public.telesales_lead_lifecycle
WITH (security_invoker = true) AS
WITH codeset AS (
  SELECT canonical_code, array_agg(raw_code) AS codes
  FROM (
    -- Every live product is its own identity.
    SELECT p.item_code AS raw_code, p.item_code AS canonical_code
      FROM public.telesales_products p
     WHERE p.active
    UNION ALL
    -- Plus each active mapping onto a live product.
    SELECT a.alias_item_code, a.canonical_item_code
      FROM public.telesales_product_aliases a
      JOIN public.telesales_products p ON p.item_code = a.canonical_item_code AND p.active
     WHERE a.active
  ) i
  GROUP BY canonical_code
)
SELECT
  l.*,

  -- The resolved product, exposed so the queue can say *why* two purchases were
  -- treated as one rather than leaving an agent to wonder.
  k.canonical_item_code,
  CASE
    WHEN pc.item_code IS NOT NULL THEN 'item_code'
    WHEN pa.item_code IS NOT NULL THEN 'alias'
    WHEN pn.item_code IS NOT NULL THEN 'product_name'
    ELSE NULL
  END AS canonical_via,

  -- The CASE picks the *row*, not the value: a catalogued product whose
  -- `refill_days` is NULL must stay cycle-less rather than inherit one from
  -- whichever rule matched next. Active product names are unique, so the name
  -- join cannot multiply rows.
  CASE
    WHEN pc.item_code IS NOT NULL THEN pc.refill_days
    WHEN pa.item_code IS NOT NULL THEN pa.refill_days
    ELSE pn.refill_days
  END AS refill_cycle_days,

  h.last_purchased_on,
  d.refill_due_on,

  -- One full cycle of grace. The 30-day fallback is reachable only by a lead
  -- whose due date came from a callback -- a projection cannot exist without a
  -- cycle to project with.
  d.refill_due_on
    + COALESCE(
        CASE
          WHEN pc.item_code IS NOT NULL THEN pc.refill_days
          WHEN pa.item_code IS NOT NULL THEN pa.refill_days
          ELSE pn.refill_days
        END, 30)
    AS stale_after,

  -- Riyadh, not UTC. `businessToday()` reads the Riyadh calendar date and this
  -- must agree with it, or every lead would change state three hours early.
  CASE
    WHEN d.refill_due_on IS NULL THEN 'none'
    WHEN (now() AT TIME ZONE 'Asia/Riyadh')::date
         > d.refill_due_on
           + COALESCE(
               CASE
                 WHEN pc.item_code IS NOT NULL THEN pc.refill_days
                 WHEN pa.item_code IS NOT NULL THEN pa.refill_days
                 ELSE pn.refill_days
               END, 30)
      THEN 'stale'
    ELSE 'active'
  END AS lifecycle

FROM public.telesales_leads l

-- 1. By code.
LEFT JOIN public.telesales_products pc
       ON pc.active AND pc.item_code = l.item_code

-- 2. By an active mapping, used only where the code matched nothing.
LEFT JOIN public.telesales_product_aliases al
       ON al.active AND al.alias_item_code = l.item_code
LEFT JOIN public.telesales_products pa
       ON pa.active AND pa.item_code = al.canonical_item_code

-- 3. By an exact product name, used only where neither of the above matched.
LEFT JOIN public.telesales_products pn
       ON pn.active
      AND upper(regexp_replace(pn.item_name, '\s+', ' ', 'g'))
        = upper(regexp_replace(l.item_name,  '\s+', ' ', 'g'))

CROSS JOIN LATERAL (
  SELECT COALESCE(pc.item_code, pa.item_code, pn.item_code) AS canonical_item_code
) k

-- Every raw code that means the same medicine. Falls back to the lead's own
-- code when nothing resolved, so an uncatalogued product still matches itself
-- exactly as it did before this migration -- canonical matching is a strict
-- superset of code matching and no comparison that succeeded can start failing.
LEFT JOIN codeset cs ON cs.canonical_code = k.canonical_item_code

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
    AND s.item_code = ANY(COALESCE(cs.codes, ARRAY[l.item_code]))
) h ON true

CROSS JOIN LATERAL (
  -- The agreed callback wins. A date a human committed to outranks a
  -- projection, here and in the engine.
  SELECT COALESCE(
    l.next_followup_on,
    h.last_purchased_on
      + CASE
          WHEN pc.item_code IS NOT NULL THEN pc.refill_days
          WHEN pa.item_code IS NOT NULL THEN pa.refill_days
          ELSE pn.refill_days
        END
  ) AS refill_due_on
) d;

COMMENT ON VIEW public.telesales_lead_lifecycle IS
  'telesales_leads with the derived refill lifecycle. Computed on every read, '
  'so it cannot go out of date; nothing here is stored. security_invoker=true, '
  'so the policies on telesales_leads still decide what a caller sees. The '
  'boundary matches src/lib/telesales/lifecycle.ts, and product identity is '
  'resolved the way resolveTelesalesProductIdentity resolves it -- catalogue '
  'item code, then an active telesales_product_aliases mapping, then an exact '
  'product name unique in the catalogue. The purchase lookup compares that '
  'identity rather than the raw code, because the source uses two code systems '
  'for the same medicines.';

GRANT SELECT ON public.telesales_lead_lifecycle TO authenticated;
REVOKE ALL ON public.telesales_lead_lifecycle FROM anon;
REVOKE INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER
  ON public.telesales_lead_lifecycle FROM authenticated;
GRANT SELECT ON public.telesales_lead_lifecycle TO authenticated;
