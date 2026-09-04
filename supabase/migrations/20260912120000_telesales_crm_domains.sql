-- Telesales CRM: two domains, one catalogue, and imports that can really be
-- deleted.
--
-- Four independent changes, kept in one migration because they are one release
-- and each is small:
--
--   1. Cross-sell relations gain a kind, so up-sell is a configured
--      relationship rather than a second table.
--   2. Products record where they came from, now that the catalogue is curated
--      from Shams MIS Branch Stock rather than seeded.
--   3. Deleting an import means deleting it.
--   4. Two indexes for the Wasfaty views' date and worked-state predicates.

-- ===========================================================================
-- 1. Cross-sell and up-sell are the same relationship, differently justified
-- ===========================================================================
-- Both say "a customer who bought A is worth telling about B". They differ in
-- what the desk means by it — a companion product against a larger pack or a
-- higher tier of the same thing — and an agent reading the recommendation needs
-- to know which, because the two open a sentence differently.
--
-- One table, one column. A second table would duplicate the unique pair key,
-- the activation flag, the audit columns and the RLS policy, and would then
-- have to answer what it means for a pair to exist in both.
--
-- The Phase 8 rule is unchanged and is worth restating, because "up-sell" is
-- exactly the word that invites breaking it: NOTHING here infers a
-- relationship. A pair exists because a person with `manage_telesales` typed
-- it. In particular the module still never proposes a dose change — Mounjaro
-- 5 MG to 10 MG is a prescribing decision, and it being expressible as an
-- up-sell does not make it one the software may suggest on its own.

ALTER TABLE public.telesales_product_relations
  ADD COLUMN IF NOT EXISTS kind text NOT NULL DEFAULT 'cross_sell';

ALTER TABLE public.telesales_product_relations
  DROP CONSTRAINT IF EXISTS telesales_product_relations_kind_valid;
ALTER TABLE public.telesales_product_relations
  ADD CONSTRAINT telesales_product_relations_kind_valid
  CHECK (kind IN ('cross_sell', 'up_sell'));

COMMENT ON COLUMN public.telesales_product_relations.kind IS
  'cross_sell: a companion product. up_sell: a larger pack or higher tier of '
  'what they already buy. Both are configured by a person; neither is inferred. '
  'The pair key is unchanged, so one pair carries one kind.';

-- ===========================================================================
-- 2. Where a catalogue product came from
-- ===========================================================================
-- The catalogue used to be seeded from the workbooks. It is now curated from
-- Shams MIS Branch Stock through Add Product, which is the source of truth for
-- a product's identity — the item code and the name come from there and are
-- never retyped.
--
-- `source` is provenance, not behaviour: nothing branches on it. It exists so
-- that "why is this row here" is answerable, which matters most for the 25 rows
-- that predate the catalogue screen.
ALTER TABLE public.telesales_products
  ADD COLUMN IF NOT EXISTS source text NOT NULL DEFAULT 'seed';

ALTER TABLE public.telesales_products
  DROP CONSTRAINT IF EXISTS telesales_products_source_valid;
ALTER TABLE public.telesales_products
  ADD CONSTRAINT telesales_products_source_valid
  CHECK (source IN ('seed', 'branch_stock', 'manual'));

ALTER TABLE public.telesales_products
  ADD COLUMN IF NOT EXISTS added_by uuid REFERENCES auth.users(id) ON DELETE SET NULL;

COMMENT ON COLUMN public.telesales_products.source IS
  'seed: from the original workbook import. branch_stock: added from Shams MIS '
  'Branch Stock through the Cross & Up-sell screen. manual: entered by hand.';

-- ===========================================================================
-- 3. Delete means delete
-- ===========================================================================
-- Removing an import used to archive it: rows were stamped `archived_at`, left
-- the queue, and stayed in the history behind a badge. That was the right
-- default while nothing else could be undone, and it is not what the desk
-- means by "delete this file I uploaded by mistake" — the file stayed on the
-- screen, and a second upload of the corrected file sat underneath the first.
--
-- ---------------------------------------------------------------------------
-- What survives, and why
-- ---------------------------------------------------------------------------
-- The schema was already built for this, which is most of why it is safe:
--
--   * `telesales_source_records.import_id` is ON DELETE CASCADE — the parsed
--     rows are part of the import and go with it.
--   * `telesales_leads.source_record_id` is ON DELETE SET NULL, with a comment
--     from the first migration saying exactly why: "deleting an import must
--     never delete the work done on its leads".
--   * `telesales_generation_runs.import_id` is ON DELETE SET NULL — a run is a
--     historical fact and outlives the import it read.
--
-- So the only judgement here is which leads to remove. A lead nobody has
-- touched is an artefact of the import and goes with it; a lead somebody has
-- called, actioned, converted, or raised a retention cycle from has become
-- independent CRM activity and stays, detached from the file it came from.
--
-- ---------------------------------------------------------------------------
-- The append-only trigger
-- ---------------------------------------------------------------------------
-- `telesales_lead_activities` refuses UPDATE and DELETE from a trigger, so that
-- a bug in a server function cannot rewrite a call log. Deleting a lead
-- cascades into that table and would therefore abort the whole transaction.
--
-- The invariant is narrowed rather than removed, and narrowed twice:
--
--   * UPDATE is still refused unconditionally. Nothing may rewrite history.
--   * DELETE is permitted only while `telesales.purge_import` is set — which
--     only the function below does, transaction-locally — AND only for a row
--     whose `activity_type` is 'created'.
--
-- The second condition is the one that matters. A 'created' row is written by
-- the generator with no actor; it is bookkeeping, not an interaction. If the
-- lead-selection query below were ever wrong and caught a lead somebody had
-- called, the cascade would hit a 'call' row and the whole delete would abort
-- with the original error rather than destroying the log. The failure mode is
-- a refused deletion, which is the right way round.
CREATE OR REPLACE FUNCTION public.telesales_activity_is_immutable()
RETURNS trigger
LANGUAGE plpgsql
AS $function$
BEGIN
  IF TG_OP = 'DELETE'
     AND coalesce(current_setting('telesales.purge_import', true), '') = 'on'
     AND OLD.activity_type = 'created' THEN
    RETURN OLD;
  END IF;
  RAISE EXCEPTION 'telesales_lead_activities is append-only (attempted %)', TG_OP;
END;
$function$;

-- ---------------------------------------------------------------------------
-- Which leads a delete would take, counted before anything is written
-- ---------------------------------------------------------------------------
-- The same shape as `telesales_archive_impact`, so the confirmation dialog can
-- quote real numbers rather than a warning.
CREATE OR REPLACE FUNCTION public.telesales_delete_impact(_import_id uuid)
RETURNS TABLE (
  source_records bigint,
  leads_deleted  bigint,
  leads_kept     bigint,
  followups      bigint,
  runs           bigint
)
LANGUAGE sql
STABLE SECURITY DEFINER
SET search_path TO 'public'
AS $function$
  WITH src AS (
    SELECT id FROM public.telesales_source_records WHERE import_id = _import_id
  ),
  mine AS (
    SELECT l.id, l.last_outcome, l.order_id, l.converted_at
    FROM public.telesales_leads l
    JOIN src ON src.id = l.source_record_id
  ),
  -- Independent CRM activity: anything beyond having been generated.
  kept AS (
    SELECT m.id FROM mine m
    WHERE m.last_outcome IS NOT NULL
       OR m.order_id IS NOT NULL
       OR m.converted_at IS NOT NULL
       OR EXISTS (SELECT 1 FROM public.telesales_lead_activities a
                   WHERE a.lead_id = m.id AND a.activity_type <> 'created')
       OR EXISTS (SELECT 1 FROM public.telesales_leads c WHERE c.parent_lead_id = m.id)
  ),
  doomed AS (
    SELECT m.id FROM mine m WHERE m.id NOT IN (SELECT id FROM kept)
  )
  SELECT
    (SELECT count(*) FROM src),
    (SELECT count(*) FROM doomed),
    (SELECT count(*) FROM kept),
    (SELECT count(*) FROM public.telesales_followups f
       JOIN doomed d ON d.id = f.lead_id),
    (SELECT count(*) FROM public.telesales_generation_runs r WHERE r.import_id = _import_id);
$function$;

REVOKE ALL ON FUNCTION public.telesales_delete_impact(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.telesales_delete_impact(uuid) TO service_role;

-- ---------------------------------------------------------------------------
-- Do it
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.telesales_delete_import(_import_id uuid)
RETURNS TABLE (source_records bigint, leads_deleted bigint, leads_kept bigint)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  _src bigint := 0; _del bigint := 0; _kept bigint := 0;
BEGIN
  -- Transaction-local, and only ever set here. `SET LOCAL` unwinds on commit or
  -- rollback, so nothing outside this function ever sees the flag.
  PERFORM set_config('telesales.purge_import', 'on', true);

  CREATE TEMP TABLE _doomed ON COMMIT DROP AS
    SELECT l.id
    FROM public.telesales_leads l
    JOIN public.telesales_source_records s ON s.id = l.source_record_id
    WHERE s.import_id = _import_id
      AND l.last_outcome IS NULL
      AND l.order_id IS NULL
      AND l.converted_at IS NULL
      AND NOT EXISTS (SELECT 1 FROM public.telesales_lead_activities a
                       WHERE a.lead_id = l.id AND a.activity_type <> 'created')
      AND NOT EXISTS (SELECT 1 FROM public.telesales_leads c WHERE c.parent_lead_id = l.id);

  SELECT count(*) INTO _kept
    FROM public.telesales_leads l
    JOIN public.telesales_source_records s ON s.id = l.source_record_id
   WHERE s.import_id = _import_id
     AND l.id NOT IN (SELECT id FROM _doomed);

  -- Follow-ups first, so `telesales_followups_sync_lead` settles
  -- `next_followup_on` against a lead row that still exists. The cascade would
  -- reach them anyway; doing it in this order keeps the trigger's update from
  -- being applied to a row that has already gone.
  DELETE FROM public.telesales_followups WHERE lead_id IN (SELECT id FROM _doomed);

  -- Activities cascade from here. Only 'created' rows can be in that set, and
  -- the trigger above enforces that rather than trusting it.
  DELETE FROM public.telesales_leads WHERE id IN (SELECT id FROM _doomed);
  GET DIAGNOSTICS _del = ROW_COUNT;

  SELECT count(*) INTO _src
    FROM public.telesales_source_records WHERE import_id = _import_id;

  -- Source records cascade; generation runs detach. Customers are untouched —
  -- an identity is shared across imports and pipelines by construction.
  DELETE FROM public.telesales_imports WHERE id = _import_id;

  RETURN QUERY SELECT _src, _del, _kept;
END;
$function$;

REVOKE ALL ON FUNCTION public.telesales_delete_import(uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.telesales_delete_import(uuid) TO service_role;

COMMENT ON FUNCTION public.telesales_delete_import(uuid) IS
  'Permanently removes an import, its source rows, and the leads it generated '
  'that nobody has worked. Leads carrying an outcome, an order, a call or a '
  'child retention cycle are kept and detached. Not reversible.';

-- ===========================================================================
-- 4. Indexes for the Wasfaty views
-- ===========================================================================
-- The three views are one table asked three questions, and two of the
-- predicates are new: a range over the prescription's own date, and whether an
-- action has been recorded.
--
-- Both are partial on `archived_at IS NULL`, matching every working read, so
-- the indexes carry only rows the queue can return.
CREATE INDEX IF NOT EXISTS telesales_leads_type_date_idx
  ON public.telesales_leads (lead_type, source_date DESC)
  WHERE archived_at IS NULL;

CREATE INDEX IF NOT EXISTS telesales_leads_worked_idx
  ON public.telesales_leads (lead_type, source_date DESC)
  WHERE archived_at IS NULL AND last_outcome IS NOT NULL;
