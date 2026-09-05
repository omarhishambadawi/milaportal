-- Telesales CRM: the import cycle a lead belongs to, and deleting one lead.
--
-- Two changes, one release:
--
--   1. A lead records which import raised it, so "the current Wasfaty cycle" is
--      a `WHERE` clause rather than an idea.
--   2. An administrator can remove a single lead from the operational views
--      without the append-only activity log being the thing that decides
--      whether that is possible.

-- ===========================================================================
-- 1. Which cycle a lead belongs to
-- ===========================================================================
-- Every monthly Wasfaty file is a new cycle: September's 3,400 prescriptions,
-- October's 3,500, November's 3,600. The desk works one of them at a time, and
-- "All Leads" meaning "every prescription this system has ever seen" is a page
-- that grows without bound and answers nobody's question.
--
-- The link already exists, one hop away — `telesales_leads.source_record_id`
-- points at a `telesales_source_records` row, which carries `import_id`. It is
-- copied onto the lead rather than joined for two reasons, and neither is
-- performance:
--
--   * `telesales_source_records` is readable only with `manage_telesales`. The
--     lifecycle view runs `security_invoker`, so an agent joining through it
--     would silently get NULL for every lead and an empty cycle filter. The
--     raw drop stays restricted; which *batch* raised a lead is not the raw
--     drop.
--
--   * `source_record_id` is ON DELETE SET NULL, because deleting an import must
--     never delete the work done on its leads. A worked lead that outlives its
--     import keeps its own copy of where it came from, and the FK below is SET
--     NULL for the same reason: the cycle is history, not a dependency.
--
-- Nothing is duplicated by this. There is still exactly one lead row per
-- prescription — a prescription that appears again in next month's file is the
-- same lead (see `wasfatyKey` in `src/lib/telesales/dedup.ts`), and it stays in
-- the cycle that raised it.

ALTER TABLE public.telesales_leads
  ADD COLUMN IF NOT EXISTS import_id uuid
  REFERENCES public.telesales_imports(id) ON DELETE SET NULL;

COMMENT ON COLUMN public.telesales_leads.import_id IS
  'The import batch that raised this lead — its cycle. Copied from '
  'telesales_source_records.import_id by trigger, because that table is '
  'manage-only and the lifecycle view is security_invoker. NULL for retention '
  '(generated from a previous lead) and for a lead whose import was deleted.';

-- Backfill. One pass, through the link that already existed.
UPDATE public.telesales_leads l
   SET import_id = s.import_id
  FROM public.telesales_source_records s
 WHERE s.id = l.source_record_id
   AND l.import_id IS DISTINCT FROM s.import_id;

-- Kept true by the database rather than by the generator.
--
-- A trigger rather than a column in `draftToRow`: the generator is not the only
-- writer this table will ever have, and a lead whose cycle depended on the
-- caller remembering to set it is a lead that quietly belongs to no cycle. It
-- is one index lookup on a row that is being inserted anyway.
CREATE OR REPLACE FUNCTION public.telesales_lead_inherit_import()
RETURNS trigger
LANGUAGE plpgsql
SET search_path TO 'public'
AS $function$
BEGIN
  IF NEW.import_id IS NULL AND NEW.source_record_id IS NOT NULL THEN
    SELECT s.import_id INTO NEW.import_id
      FROM public.telesales_source_records s
     WHERE s.id = NEW.source_record_id;
  END IF;
  RETURN NEW;
END;
$function$;

DROP TRIGGER IF EXISTS telesales_leads_inherit_import ON public.telesales_leads;
CREATE TRIGGER telesales_leads_inherit_import
  BEFORE INSERT ON public.telesales_leads
  FOR EACH ROW EXECUTE FUNCTION public.telesales_lead_inherit_import();

-- The cycle filter's read: one lead type, one batch, unarchived.
CREATE INDEX IF NOT EXISTS telesales_leads_cycle_idx
  ON public.telesales_leads (lead_type, import_id)
  WHERE archived_at IS NULL;

-- ---------------------------------------------------------------------------
-- The lifecycle view has to be rebuilt to see the new column
-- ---------------------------------------------------------------------------
-- `SELECT l.*` is expanded at creation time, so the existing view does not
-- carry `import_id` and CREATE OR REPLACE cannot insert a column in the middle
-- of a view's output list. Dropped and recreated, byte-identical otherwise —
-- the definition below is `20260906120000`'s with nothing changed.
DROP VIEW IF EXISTS public.telesales_lead_lifecycle;

CREATE VIEW public.telesales_lead_lifecycle
WITH (security_invoker = true) AS
SELECT
  l.*,
  p.refill_days AS refill_cycle_days,
  h.last_purchased_on,
  d.refill_due_on,
  d.refill_due_on + COALESCE(p.refill_days, 30) AS stale_after,
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
REVOKE ALL ON public.telesales_lead_lifecycle FROM anon;
REVOKE INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER
  ON public.telesales_lead_lifecycle FROM authenticated;
GRANT SELECT ON public.telesales_lead_lifecycle TO authenticated;

-- ---------------------------------------------------------------------------
-- The periods an agent may choose between
-- ---------------------------------------------------------------------------
-- `telesales_imports` is readable only with `manage_telesales`, and the period
-- selector is on a page every agent uses. This is the narrowest thing that
-- unblocks it: the month, its label, the batches in it and how many leads they
-- raised — no file names, no row counts, no uploader.
--
-- Grouped by the business month of `imported_at` rather than returning one
-- entry per file, because "October" is what the desk calls the cycle and two
-- uploads of a corrected October file are one cycle, not two.
CREATE OR REPLACE FUNCTION public.telesales_wasfaty_cycles()
RETURNS TABLE (period text, label text, import_ids uuid[], leads bigint)
LANGUAGE plpgsql
STABLE SECURITY DEFINER
SET search_path TO 'public'
AS $function$
BEGIN
  IF NOT public.has_permission(auth.uid(), 'view_telesales') THEN
    RAISE EXCEPTION 'Forbidden: telesales access required';
  END IF;

  RETURN QUERY
  SELECT
    to_char(i.imported_at AT TIME ZONE 'Asia/Riyadh', 'YYYY-MM')     AS period,
    to_char(i.imported_at AT TIME ZONE 'Asia/Riyadh', 'FMMonth YYYY') AS label,
    array_agg(DISTINCT i.id)                                          AS import_ids,
    count(l.id)                                                       AS leads
  FROM public.telesales_imports i
  LEFT JOIN public.telesales_leads l
    ON l.import_id = i.id
   AND l.lead_type = 'wasfaty'
   AND l.archived_at IS NULL
  WHERE i.source_type = 'wasfaty'
  GROUP BY 1, 2
  ORDER BY 1 DESC;
END;
$function$;

REVOKE ALL ON FUNCTION public.telesales_wasfaty_cycles() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.telesales_wasfaty_cycles() TO authenticated, service_role;

COMMENT ON FUNCTION public.telesales_wasfaty_cycles() IS
  'The Wasfaty import cycles, newest first: business month, its label, the '
  'import batches in it and how many live leads they raised. Readable with '
  'view_telesales so an agent can choose a period without being granted the '
  'raw import table.';

-- ===========================================================================
-- 2. Deleting one lead
-- ===========================================================================
-- An administrator needs to be able to remove a lead that should not be on the
-- board — a test row, a prescription that was never real, a duplicate the
-- dedup key could not see because half its identifiers were blank.
--
-- ---------------------------------------------------------------------------
-- Two outcomes, decided by the lead's own history
-- ---------------------------------------------------------------------------
-- `telesales_lead_activities` is append-only, enforced by a trigger, so that a
-- bug in a server function cannot rewrite a call log. That guarantee is not
-- weakened here, and it is not worked around either. It decides the outcome:
--
--   * **No history.** The lead carries only its 'created' bookkeeping row. It
--     is an artefact of an import and nothing happened to it, so it is deleted
--     — the same rule and the same transaction-local flag that
--     `telesales_delete_import` uses for the leads nobody worked.
--
--   * **History.** Somebody called it, actioned it, converted it, or raised a
--     retention cycle from it. The call log is evidence and is not destroyed to
--     satisfy a screen. The lead is archived instead: `archived_at` takes it
--     out of Generated, All and Worked exactly as it takes it out of every
--     other working view, and the timeline underneath it is untouched.
--
-- The UI says which happened. "It disappeared and the audit survived" is the
-- honest outcome; "it disappeared" with the log quietly gone is not.
--
-- The append-only trigger is unchanged: DELETE is still permitted only while
-- `telesales.purge_import` is set, and only for a row whose activity_type is
-- 'created'. If the history test below were ever wrong, the cascade would hit a
-- 'call' row and the whole delete would abort rather than destroying the log.
CREATE OR REPLACE FUNCTION public.telesales_delete_lead(_lead_id uuid, _actor uuid)
RETURNS TABLE (mode text)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  _worked boolean;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM public.telesales_leads WHERE id = _lead_id) THEN
    RAISE EXCEPTION 'That lead no longer exists.';
  END IF;

  SELECT
    EXISTS (SELECT 1 FROM public.telesales_lead_activities a
             WHERE a.lead_id = _lead_id AND a.activity_type <> 'created')
    OR EXISTS (SELECT 1 FROM public.telesales_leads c WHERE c.parent_lead_id = _lead_id)
    OR EXISTS (SELECT 1 FROM public.telesales_leads l
                WHERE l.id = _lead_id
                  AND (l.last_outcome IS NOT NULL
                       OR l.order_id IS NOT NULL
                       OR l.converted_at IS NOT NULL))
  INTO _worked;

  IF _worked THEN
    UPDATE public.telesales_leads
       SET archived_at    = COALESCE(archived_at, now()),
           archived_by    = COALESCE(archived_by, _actor),
           archive_reason = COALESCE(archive_reason, 'Deleted by an administrator')
     WHERE id = _lead_id;
    RETURN QUERY SELECT 'archived'::text;
    RETURN;
  END IF;

  PERFORM set_config('telesales.purge_import', 'on', true);

  -- Follow-ups first, so `telesales_followups_sync_lead` settles
  -- `next_followup_on` against a lead row that still exists.
  DELETE FROM public.telesales_followups WHERE lead_id = _lead_id;
  DELETE FROM public.telesales_leads WHERE id = _lead_id;

  RETURN QUERY SELECT 'deleted'::text;
END;
$function$;

REVOKE ALL ON FUNCTION public.telesales_delete_lead(uuid, uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.telesales_delete_lead(uuid, uuid) TO service_role;

COMMENT ON FUNCTION public.telesales_delete_lead(uuid, uuid) IS
  'Removes one lead from the operational views. A lead nobody worked is '
  'deleted outright; a lead carrying call history is archived instead, so the '
  'append-only activity log survives. Returns which happened. service_role '
  'only — the administrator check lives in telesalesDeleteLead.';
