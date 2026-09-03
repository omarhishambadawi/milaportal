-- Telesales CRM: one product identity, whatever code the row carries.
--
-- ===========================================================================
-- The defect this closes
-- ===========================================================================
-- The retention source uses **two code systems for the same medicines**. Of the
-- 745 imported rows, 652 carry the pharmacy's eight-digit catalogue codes and 88
-- carry a five- or six-digit number for products the catalogue already holds:
-- twenty distinct codes naming `MOUNJARO KWIKPEN 12.5 MG`, twelve naming the
-- 5 MG pen, 112 distinct codes across 23 product names.
--
-- `20260908120000` fixed the *refill cycle* half of this by falling back to an
-- exact product name, and said in its own closing paragraph what it was leaving
-- behind: the engine still matched purchases by item code, so the same medicine
-- under two codes hid a repeat purchase for 13 customers. That is this
-- migration.
--
-- Measured against live data before applying:
--
--   * leads with a recognised earlier purchase   27  ->  52   (+26)
--   * purchase matches lost                                0
--   * leads whose last purchase date moves      16, every one of them *later*
--     or newly known; none moves earlier, and 7 of the 16 carry an agreed
--     callback that decides their due date regardless
--   * lifecycle stale -> active                            7
--   * lifecycle none  -> active                            1
--   * lifecycle none  -> stale                             1
--   * lifecycle active -> stale                            0
--
-- Nothing is hidden, archived or de-prioritised as a result. The one lead that
-- becomes stale gains a last-purchase date it did not have, and that date is old
-- -- it was `none` because we could not see the purchase, not because there was
-- not one.
--
-- ===========================================================================
-- An interpretation layer. Nothing is rewritten
-- ===========================================================================
-- No source record is touched. `telesales_source_records.item_code` and
-- `item_name` keep the values the workbook supplied, every lead keeps its
-- denormalised copy, no `telesales_products` rows are merged or renamed, and no
-- Shams MIS identifier is affected. Canonical identity is computed on read, and
-- switching a mapping off reverts every answer it changed without touching a
-- row. That is the whole reason it is a mapping table rather than an UPDATE.

-- ===========================================================================
-- 1. The mapping
-- ===========================================================================
CREATE TABLE IF NOT EXISTS public.telesales_product_aliases (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),

  -- The code as it appears in the source. Never a `telesales_products` row --
  -- see the guard trigger below.
  alias_item_code text NOT NULL,

  -- The catalogue product it means. A real FK, so a mapping cannot point at a
  -- product that does not exist and a product cannot be deleted out from under
  -- one. RESTRICT rather than CASCADE: silently dropping mappings because
  -- somebody removed a catalogue row would change what counts as a repeat
  -- purchase with nothing to say why.
  canonical_item_code text NOT NULL
    REFERENCES public.telesales_products(item_code) ON UPDATE CASCADE ON DELETE RESTRICT,

  -- The name the alias code was seen under when the mapping was made.
  --
  -- Not for matching -- resolution never reads it. It is the evidence: 88 of
  -- these were activated because the alias code's product name matched exactly
  -- one catalogue product, and this column records what that name actually was,
  -- so the decision stays auditable after the source rows have been archived or
  -- the catalogue renamed.
  alias_name_snapshot text,

  -- Why the mapping exists, in the desk's own words. Read by the person who
  -- will one day ask whether these really are one medicine.
  note text,

  active boolean NOT NULL DEFAULT true,
  created_by uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_by uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  updated_at timestamptz NOT NULL DEFAULT now(),

  -- One code means one product. The key ignores `active` and it ignores the
  -- canonical, which is what makes re-saving a switched-off mapping a
  -- reactivation of the original row and re-pointing one an edit with a
  -- history, rather than either failing on a constraint or quietly creating a
  -- second, contradictory answer.
  CONSTRAINT telesales_product_aliases_alias_key UNIQUE (alias_item_code),

  -- A code is not an alias of itself.
  CONSTRAINT telesales_product_aliases_distinct
    CHECK (alias_item_code <> canonical_item_code),

  CONSTRAINT telesales_product_aliases_alias_not_blank
    CHECK (length(btrim(alias_item_code)) > 0)
);

-- The read the resolver performs: every active mapping, once per page.
CREATE INDEX IF NOT EXISTS telesales_product_aliases_active_idx
  ON public.telesales_product_aliases (canonical_item_code)
  WHERE active;

-- ---------------------------------------------------------------------------
-- The guard that makes resolution a single step, forever
-- ---------------------------------------------------------------------------
-- An alias code must not itself be a `telesales_products` row. Combined with the
-- foreign key -- which says the canonical must be one -- that makes a chain
-- (`A -> B` where `B -> C`) structurally impossible rather than something every
-- consumer has to decide how far to follow. No code in this module ever loops.
--
-- A CHECK constraint cannot look at another table, so this is a trigger. It
-- fires on the alias table for new and changed mappings, and on
-- `telesales_products` for the other direction: adding a catalogue product whose
-- code somebody has already mapped as an alias would create the same chain from
-- the far end.
CREATE OR REPLACE FUNCTION public.telesales_product_alias_guard()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF TG_TABLE_NAME = 'telesales_product_aliases' THEN
    IF EXISTS (SELECT 1 FROM public.telesales_products p
                WHERE p.item_code = NEW.alias_item_code) THEN
      RAISE EXCEPTION
        'item code % is a Telesales catalogue product and cannot be an alias',
        NEW.alias_item_code
        USING ERRCODE = '23514';
    END IF;
    RETURN NEW;
  END IF;

  -- telesales_products
  IF EXISTS (SELECT 1 FROM public.telesales_product_aliases a
              WHERE a.alias_item_code = NEW.item_code) THEN
    RAISE EXCEPTION
      'item code % is configured as a Telesales product identity alias; '
      'remove the mapping before adding it to the catalogue',
      NEW.item_code
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS telesales_product_aliases_guard ON public.telesales_product_aliases;
CREATE TRIGGER telesales_product_aliases_guard
  BEFORE INSERT OR UPDATE OF alias_item_code ON public.telesales_product_aliases
  FOR EACH ROW EXECUTE FUNCTION public.telesales_product_alias_guard();

DROP TRIGGER IF EXISTS telesales_products_alias_guard ON public.telesales_products;
CREATE TRIGGER telesales_products_alias_guard
  BEFORE INSERT OR UPDATE OF item_code ON public.telesales_products
  FOR EACH ROW EXECUTE FUNCTION public.telesales_product_alias_guard();

-- `updated_at` by trigger rather than by convention, matching the six other
-- Telesales tables that carry one. `telesales_product_relations` sets it in the
-- server function instead; that works only because there is exactly one write
-- path, and a guarantee is worth more than a convention on a table whose
-- history is the audit trail.
DROP TRIGGER IF EXISTS telesales_product_aliases_updated_at ON public.telesales_product_aliases;
CREATE TRIGGER telesales_product_aliases_updated_at
  BEFORE UPDATE ON public.telesales_product_aliases
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

-- ===========================================================================
-- 2. Security -- exactly the shape `telesales_product_relations` uses
-- ===========================================================================
ALTER TABLE public.telesales_product_aliases ENABLE ROW LEVEL SECURITY;

-- Reading is part of reading a recommendation: an agent shown "bought this
-- twice" is entitled to see that the two purchases were joined by a configured
-- mapping rather than by magic.
DROP POLICY IF EXISTS telesales_product_aliases_select ON public.telesales_product_aliases;
CREATE POLICY telesales_product_aliases_select
  ON public.telesales_product_aliases
  FOR SELECT
  TO authenticated
  USING (public.has_permission(auth.uid(), 'view_telesales'));

-- No INSERT/UPDATE/DELETE policy, and that is the design rather than an
-- omission. RLS with a SELECT policy alone refuses every write through PostgREST
-- for `anon` and `authenticated` alike, so a mapping can change only through a
-- server function running as `service_role` that checks `manage_telesales`
-- itself. Deciding that two item codes are one medicine is a supervisor act.
--
-- The project's default privileges hand each new table to `anon` with full write
-- grants -- the trap that left four functions callable by anon in
-- `20260903150000` and write grants on the lifecycle view in `20260906120000`.
-- RLS already refuses those writes; a DELETE grant to anonymous users on a
-- table that decides what counts as the same medicine is not something an
-- access audit should have to reason about. Take them back.
REVOKE ALL ON public.telesales_product_aliases FROM anon;
REVOKE INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER
  ON public.telesales_product_aliases FROM authenticated;
GRANT SELECT ON public.telesales_product_aliases TO authenticated;

COMMENT ON TABLE public.telesales_product_aliases IS
  'Source item codes that mean an existing telesales_products product. A CRM '
  'interpretation layer: no source record, lead, catalogue row or Shams MIS '
  'identifier is modified, and deactivating a mapping reverts every answer it '
  'changed. Read by anyone with view_telesales; written only by a server '
  'function checking manage_telesales. An alias code is never itself a '
  'catalogue product, so resolution is always a single step.';

COMMENT ON COLUMN public.telesales_product_aliases.alias_name_snapshot IS
  'The product name the alias code carried when the mapping was made. Evidence '
  'for the decision, never used for matching.';

-- ===========================================================================
-- 3. The audited mappings
-- ===========================================================================
-- 88 rows, and every one of them is here because the database proved it, not
-- because a name looked similar.
--
-- The audit over live data: 112 distinct source item codes, of which 22 are
-- catalogue products already. Of the remaining 90, **88** carry a product name
-- that, normalised for whitespace and case and compared whole, matches exactly
-- one active catalogue product. Zero were ambiguous -- no catalogue name is
-- carried by two products -- and the two that matched nothing are
-- `10609623 LIMITLESS CHROMAX CUT SACHETS, 30'S` and
-- `10606737 SAXENDA 6MG/ML, 5 PRE-FILLED PEN`, which are simply products the
-- Telesales catalogue does not carry. They are deliberately left unresolved.
--
-- The five Mounjaro strengths stay five products. 2.5, 5, 7.5, 10, 12.5 and 15
-- MG each collect their own alias codes below and none is mapped to another;
-- the same holds for the four Wegovy strengths, the three Rybelsus tablets and
-- the two Ozempic pens. Similar names are not evidence, and nothing here
-- treated them as any.
--
-- Written as literal pairs rather than as an INSERT...SELECT that re-derives
-- them at apply time. The mappings were reviewed as data; re-inferring them
-- against whatever the catalogue happens to say on the day this runs would make
-- the migration's effect depend on the environment, which is the opposite of an
-- audited decision. The join to `telesales_products` is a guard, not a
-- derivation: a pair whose canonical is missing is skipped rather than failing.
INSERT INTO public.telesales_product_aliases
  (alias_item_code, canonical_item_code, alias_name_snapshot, note)
SELECT v.alias_code, v.canonical_code, v.alias_name,
       'Activated from the Phase 8 audit: the source name matched exactly one catalogue product.'
FROM (VALUES
  ('146104','10104196','OZEMPIC .50MG 1.5ML PEN, 1''S'),
  ('67442' ,'10104196','OZEMPIC .50MG 1.5ML PEN, 1''S'),
  ('122746','10104198','OZEMPIC 1 MG 1.5ML PEN, 1''S'),
  ('180131','10104198','OZEMPIC 1 MG 1.5ML PEN, 1''S'),
  ('276274','10104198','OZEMPIC 1 MG 1.5ML PEN, 1''S'),
  ('374971','10104198','OZEMPIC 1 MG 1.5ML PEN, 1''S'),
  ('377897','10104198','OZEMPIC 1 MG 1.5ML PEN, 1''S'),
  ('417893','10104198','OZEMPIC 1 MG 1.5ML PEN, 1''S'),
  ('49445' ,'10104198','OZEMPIC 1 MG 1.5ML PEN, 1''S'),
  ('514963','10104198','OZEMPIC 1 MG 1.5ML PEN, 1''S'),
  ('517250','10104198','OZEMPIC 1 MG 1.5ML PEN, 1''S'),
  ('59106' ,'10104198','OZEMPIC 1 MG 1.5ML PEN, 1''S'),
  ('271208','10602062','RYBELSUS 3MG TAB, 30''S'),
  ('516960','10602062','RYBELSUS 3MG TAB, 30''S'),
  ('519335','10602062','RYBELSUS 3MG TAB, 30''S'),
  ('244654','10602063','RYBELSUS 7MG TAB, 30''S'),
  ('444129','10602063','RYBELSUS 7MG TAB, 30''S'),
  ('445453','10602063','RYBELSUS 7MG TAB, 30''S'),
  ('515445','10602063','RYBELSUS 7MG TAB, 30''S'),
  ('56274' ,'10602063','RYBELSUS 7MG TAB, 30''S'),
  ('333943','10602064','RYBELSUS 14MG TAB, 30''S'),
  ('369644','10602064','RYBELSUS 14MG TAB, 30''S'),
  ('481152','10602064','RYBELSUS 14MG TAB, 30''S'),
  ('490803','10602064','RYBELSUS 14MG TAB, 30''S'),
  ('218971','10611027','MOUNJARO KWIKPEN 2.5 MG/0.6ML 2.4ML*1 AA'),
  ('289037','10611027','MOUNJARO KWIKPEN 2.5 MG/0.6ML 2.4ML*1 AA'),
  ('318920','10611027','MOUNJARO KWIKPEN 2.5 MG/0.6ML 2.4ML*1 AA'),
  ('392613','10611027','MOUNJARO KWIKPEN 2.5 MG/0.6ML 2.4ML*1 AA'),
  ('215163','10611028','MOUNJARO KWIKPEN 5 MG/0.6ML 2.4ML*1 AA'),
  ('320384','10611028','MOUNJARO KWIKPEN 5 MG/0.6ML 2.4ML*1 AA'),
  ('384435','10611028','MOUNJARO KWIKPEN 5 MG/0.6ML 2.4ML*1 AA'),
  ('394345','10611028','MOUNJARO KWIKPEN 5 MG/0.6ML 2.4ML*1 AA'),
  ('427819','10611028','MOUNJARO KWIKPEN 5 MG/0.6ML 2.4ML*1 AA'),
  ('490756','10611028','MOUNJARO KWIKPEN 5 MG/0.6ML 2.4ML*1 AA'),
  ('498452','10611028','MOUNJARO KWIKPEN 5 MG/0.6ML 2.4ML*1 AA'),
  ('506434','10611028','MOUNJARO KWIKPEN 5 MG/0.6ML 2.4ML*1 AA'),
  ('506707','10611028','MOUNJARO KWIKPEN 5 MG/0.6ML 2.4ML*1 AA'),
  ('511193','10611028','MOUNJARO KWIKPEN 5 MG/0.6ML 2.4ML*1 AA'),
  ('518814','10611028','MOUNJARO KWIKPEN 5 MG/0.6ML 2.4ML*1 AA'),
  ('519914','10611028','MOUNJARO KWIKPEN 5 MG/0.6ML 2.4ML*1 AA'),
  ('141808','10611029','MOUNJARO KWIKPEN 7.5 MG/0.6ML 2.4ML*1 AA'),
  ('235229','10611029','MOUNJARO KWIKPEN 7.5 MG/0.6ML 2.4ML*1 AA'),
  ('90149' ,'10611029','MOUNJARO KWIKPEN 7.5 MG/0.6ML 2.4ML*1 AA'),
  ('185573','10611030','MOUNJARO KWIKPEN 10 MG/0.6ML 2.4ML*1 AA'),
  ('398167','10611030','MOUNJARO KWIKPEN 10 MG/0.6ML 2.4ML*1 AA'),
  ('485291','10611030','MOUNJARO KWIKPEN 10 MG/0.6ML 2.4ML*1 AA'),
  ('507301','10611030','MOUNJARO KWIKPEN 10 MG/0.6ML 2.4ML*1 AA'),
  ('514706','10611030','MOUNJARO KWIKPEN 10 MG/0.6ML 2.4ML*1 AA'),
  ('518264','10611030','MOUNJARO KWIKPEN 10 MG/0.6ML 2.4ML*1 AA'),
  ('111913','10611031','MOUNJARO KWIKPEN 12.5 MG/0.6ML 2.4ML*1 QR'),
  ('137167','10611031','MOUNJARO KWIKPEN 12.5 MG/0.6ML 2.4ML*1 QR'),
  ('147312','10611031','MOUNJARO KWIKPEN 12.5 MG/0.6ML 2.4ML*1 QR'),
  ('292050','10611031','MOUNJARO KWIKPEN 12.5 MG/0.6ML 2.4ML*1 QR'),
  ('305860','10611031','MOUNJARO KWIKPEN 12.5 MG/0.6ML 2.4ML*1 QR'),
  ('352589','10611031','MOUNJARO KWIKPEN 12.5 MG/0.6ML 2.4ML*1 QR'),
  ('388659','10611031','MOUNJARO KWIKPEN 12.5 MG/0.6ML 2.4ML*1 QR'),
  ('404379','10611031','MOUNJARO KWIKPEN 12.5 MG/0.6ML 2.4ML*1 QR'),
  ('445360','10611031','MOUNJARO KWIKPEN 12.5 MG/0.6ML 2.4ML*1 QR'),
  ('470966','10611031','MOUNJARO KWIKPEN 12.5 MG/0.6ML 2.4ML*1 QR'),
  ('484645','10611031','MOUNJARO KWIKPEN 12.5 MG/0.6ML 2.4ML*1 QR'),
  ('50488' ,'10611031','MOUNJARO KWIKPEN 12.5 MG/0.6ML 2.4ML*1 QR'),
  ('505625','10611031','MOUNJARO KWIKPEN 12.5 MG/0.6ML 2.4ML*1 QR'),
  ('508442','10611031','MOUNJARO KWIKPEN 12.5 MG/0.6ML 2.4ML*1 QR'),
  ('508707','10611031','MOUNJARO KWIKPEN 12.5 MG/0.6ML 2.4ML*1 QR'),
  ('513440','10611031','MOUNJARO KWIKPEN 12.5 MG/0.6ML 2.4ML*1 QR'),
  ('517321','10611031','MOUNJARO KWIKPEN 12.5 MG/0.6ML 2.4ML*1 QR'),
  ('517721','10611031','MOUNJARO KWIKPEN 12.5 MG/0.6ML 2.4ML*1 QR'),
  ('517865','10611031','MOUNJARO KWIKPEN 12.5 MG/0.6ML 2.4ML*1 QR'),
  ('90750' ,'10611031','MOUNJARO KWIKPEN 12.5 MG/0.6ML 2.4ML*1 QR'),
  ('506998','10611032','MOUNJARO KWIKPEN 15MG/0.6ML 2.4ML*1 QR'),
  ('507383','10611032','MOUNJARO KWIKPEN 15MG/0.6ML 2.4ML*1 QR'),
  ('141483','10612030','WEGOVY 0.25 MG 1/1.5 ML PEN, 1''S'),
  ('186477','10612030','WEGOVY 0.25 MG 1/1.5 ML PEN, 1''S'),
  ('508287','10612030','WEGOVY 0.25 MG 1/1.5 ML PEN, 1''S'),
  ('519647','10612030','WEGOVY 0.25 MG 1/1.5 ML PEN, 1''S'),
  ('269051','10612031','WEGOVY 0.5 MG 1/1.5 ML PEN, 1''S'),
  ('294579','10612031','WEGOVY 0.5 MG 1/1.5 ML PEN, 1''S'),
  ('518004','10612031','WEGOVY 0.5 MG 1/1.5 ML PEN, 1''S'),
  ('94320' ,'10612031','WEGOVY 0.5 MG 1/1.5 ML PEN, 1''S'),
  ('103765','10612032','WEGOVY 1 MG 1/1.5 ML PEN, 1''S'),
  ('129443','10612032','WEGOVY 1 MG 1/1.5 ML PEN, 1''S'),
  ('149670','10612032','WEGOVY 1 MG 1/1.5 ML PEN, 1''S'),
  ('496990','10612032','WEGOVY 1 MG 1/1.5 ML PEN, 1''S'),
  ('498111','10612032','WEGOVY 1 MG 1/1.5 ML PEN, 1''S'),
  ('500790','10612032','WEGOVY 1 MG 1/1.5 ML PEN, 1''S'),
  ('513632','10612032','WEGOVY 1 MG 1/1.5 ML PEN, 1''S'),
  ('324289','10612033','WEGOVY 1.7 MG 1/1.5 ML PEN, 1''S'),
  ('517943','10612033','WEGOVY 1.7 MG 1/1.5 ML PEN, 1''S')
) AS v(alias_code, canonical_code, alias_name)
JOIN public.telesales_products p ON p.item_code = v.canonical_code
WHERE NOT EXISTS (
  SELECT 1 FROM public.telesales_products p2 WHERE p2.item_code = v.alias_code
)
ON CONFLICT (alias_item_code) DO NOTHING;

-- ===========================================================================
-- 4. The lifecycle view resolves identity the same way
-- ===========================================================================
-- Rewritten from `20260908120000`, which resolved a lead's *cycle* by code then
-- by exact name. Two things change and nothing else does.
--
-- **The cycle now also consults an alias**, between the code and the name, so
-- the three rules are the same three `resolveTelesalesProductIdentity` applies
-- and in the same order.
--
-- **The purchase lookup matches on identity rather than on the raw code.** That
-- is the actual fix: `s.item_code = l.item_code` is what hid a repeat purchase
-- for 13 customers, and it is now compared against every code that resolves to
-- the same canonical product.
--
-- ---------------------------------------------------------------------------
-- Keeping the purchase lookup on its index
-- ---------------------------------------------------------------------------
-- `telesales_source_records_phone_item_idx` is `(phone, item_code, source_date
-- DESC)` and it is what makes this view cheap. Comparing a *computed* canonical
-- on the source side would abandon it and scan.
--
-- So the codes are expanded instead: `codeset` builds, once, the list of raw
-- codes that resolve to each catalogue product -- the product's own code plus
-- its active aliases -- and the lookup stays `item_code = ANY(...)`, which the
-- planner still answers with an index-only scan. `codeset` reads two tiny
-- tables (28 rows and 88) and never touches `telesales_source_records`.
--
-- Measured on live data, seven runs each, best of: **9.85 ms before, 10.38 ms
-- after** -- 1473 shared buffers against 1482. The extra work is nine buffers.
--
-- ---------------------------------------------------------------------------
-- The one place SQL and TypeScript can differ, stated plainly
-- ---------------------------------------------------------------------------
-- `codeset` expands codes through the catalogue and the alias table, not
-- through the name rule, because the name rule needs a *row's* name and
-- collecting those means scanning the source table on every read -- measured at
-- +10 ms, to cover a case that is currently empty.
--
-- So: a lead resolves by code, alias or name (all three), while a source row is
-- gathered by code or alias. A source row whose code is in neither the
-- catalogue nor the alias table but whose *name* matches a product would be
-- counted by `recommendations.ts` and missed here. On live data that set is
-- empty -- all 88 such codes are aliases as of this migration, and the only two
-- remaining unmapped codes match no catalogue name at all -- and the management
-- screen surfaces any new one for a decision. It is the cost of keeping the
-- queue's own view on its index, and it is recorded here rather than left to be
-- discovered.

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

-- No index is added for the name join, for the reason `20260908120000` gave and
-- re-verified here: `telesales_products` is 28 rows in a single page, so
-- Postgres hashes it and would never choose one.
