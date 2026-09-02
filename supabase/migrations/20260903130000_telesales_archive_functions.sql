-- Telesales CRM: archiving an import, atomically.
--
-- ===========================================================================
-- Why this is SQL and not TypeScript
-- ===========================================================================
-- The rest of this module keeps its business rules in TypeScript on purpose.
-- This is the exception, and the reason is atomicity: archiving an import
-- touches three tables and must not half-happen. A supervisor who ends up with
-- archived source records, live leads and cancelled follow-ups has a desk in a
-- state no screen describes.
--
-- There is no business judgement in here to duplicate — no date window, no
-- product rule, no deduplication key. It is a set operation over rows that
-- already exist, expressed where it can be one statement.
--
-- ===========================================================================
-- What "exclusively" means
-- ===========================================================================
-- The brief asks that removing an import take only what that import created.
-- Two cases make that less obvious than it sounds:
--
--   * A **retention cycle** has no source record at all — it is generated from
--     a converted lead. Archiving the import that produced the parent must not
--     strand the child in the queue with a parent nobody can open, so a lead
--     with a live child is left alone and reported as retained.
--
--   * A **re-imported row** produces a source record whose lead already existed
--     and still points at the earlier import. Joining leads through
--     `source_record_id` therefore claims only the leads this import actually
--     created, which is the correct behaviour: archiving the second upload of
--     an overlapping file must not remove leads the first one is responsible
--     for.
--
-- Customers are never archived. A customer identity is shared across imports
-- and pipelines by construction; removing a Cash import must not delete the
-- identity a Wasfaty lead still points at.

-- ===========================================================================
-- 1. What would happen
-- ===========================================================================
CREATE OR REPLACE FUNCTION public.telesales_archive_impact(_import_id uuid)
RETURNS TABLE (
  source_records      bigint,
  leads               bigint,
  followups           bigint,
  leads_with_activity bigint,
  customers_affected  bigint,
  leads_retained      bigint
)
LANGUAGE sql
STABLE SECURITY DEFINER
SET search_path TO 'public'
AS $function$
  WITH src AS (
    SELECT id FROM public.telesales_source_records
     WHERE import_id = _import_id AND archived_at IS NULL
  ),
  owned AS (
    SELECT l.id, l.customer_id
    FROM public.telesales_leads l
    JOIN src ON src.id = l.source_record_id
    WHERE l.archived_at IS NULL
      AND NOT EXISTS (
        SELECT 1 FROM public.telesales_leads c
         WHERE c.parent_lead_id = l.id AND c.archived_at IS NULL
      )
  ),
  retained AS (
    SELECT l.id
    FROM public.telesales_leads l
    JOIN src ON src.id = l.source_record_id
    WHERE l.archived_at IS NULL
      AND EXISTS (
        SELECT 1 FROM public.telesales_leads c
         WHERE c.parent_lead_id = l.id AND c.archived_at IS NULL
      )
  )
  SELECT
    (SELECT count(*) FROM src),
    (SELECT count(*) FROM owned),
    (SELECT count(*) FROM public.telesales_followups f
       JOIN owned o ON o.id = f.lead_id WHERE f.status = 'scheduled'),
    -- Leads somebody has actually worked. `created` is written by the
    -- generator with no actor, so it does not count as work.
    (SELECT count(DISTINCT a.lead_id) FROM public.telesales_lead_activities a
       JOIN owned o ON o.id = a.lead_id
      WHERE a.activity_type <> 'created'),
    -- Customers whose every remaining live lead is in this import: the ones
    -- whose profile will go quiet. Reported, not archived.
    (SELECT count(*) FROM (
        SELECT o.customer_id FROM owned o
         WHERE o.customer_id IS NOT NULL
         GROUP BY o.customer_id
        HAVING count(*) = (
          SELECT count(*) FROM public.telesales_leads l2
           WHERE l2.customer_id = o.customer_id AND l2.archived_at IS NULL)
      ) c),
    (SELECT count(*) FROM retained);
$function$;

REVOKE ALL ON FUNCTION public.telesales_archive_impact(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.telesales_archive_impact(uuid) TO service_role;

-- ===========================================================================
-- 2. Do it
-- ===========================================================================
-- Follow-ups are cancelled before the leads are archived so that
-- `telesales_followups_sync_lead` clears `next_followup_on` while the lead row
-- is still in the queue's index. Archiving first would leave a stale due date
-- on a hidden row, which reappears the moment the import is restored.
CREATE OR REPLACE FUNCTION public.telesales_archive_import(
  _import_id uuid,
  _actor     uuid,
  _reason    text,
  _at        timestamptz DEFAULT now()
)
RETURNS TABLE (source_records bigint, leads bigint, followups bigint)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  _src bigint := 0; _leads bigint := 0; _fu bigint := 0;
BEGIN
  CREATE TEMP TABLE _owned ON COMMIT DROP AS
    SELECT l.id
    FROM public.telesales_leads l
    JOIN public.telesales_source_records s ON s.id = l.source_record_id
    WHERE s.import_id = _import_id
      AND l.archived_at IS NULL
      AND NOT EXISTS (
        SELECT 1 FROM public.telesales_leads c
         WHERE c.parent_lead_id = l.id AND c.archived_at IS NULL
      );

  UPDATE public.telesales_followups f
     SET status = 'cancelled', completed_at = _at, completed_by = _actor,
         result = 'import_archived'
   WHERE f.status = 'scheduled'
     AND f.lead_id IN (SELECT id FROM _owned);
  GET DIAGNOSTICS _fu = ROW_COUNT;

  UPDATE public.telesales_leads
     SET archived_at = _at, archived_by = _actor, archive_reason = _reason
   WHERE id IN (SELECT id FROM _owned);
  GET DIAGNOSTICS _leads = ROW_COUNT;

  UPDATE public.telesales_source_records
     SET archived_at = _at
   WHERE import_id = _import_id AND archived_at IS NULL;
  GET DIAGNOSTICS _src = ROW_COUNT;

  UPDATE public.telesales_imports
     SET archived_at = _at, archived_by = _actor, archive_reason = _reason,
         archived_source_records = _src, archived_leads = _leads, archived_followups = _fu
   WHERE id = _import_id;

  RETURN QUERY SELECT _src, _leads, _fu;
END;
$function$;

REVOKE ALL ON FUNCTION public.telesales_archive_import(uuid, uuid, text, timestamptz) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.telesales_archive_import(uuid, uuid, text, timestamptz) TO service_role;

-- ===========================================================================
-- 3. Undo it
-- ===========================================================================
-- Only rows this import archived come back, matched on the archive timestamp
-- recorded on the import. A lead archived separately by a supervisor stays
-- archived — restoring an import must not silently undo somebody else's
-- decision.
CREATE OR REPLACE FUNCTION public.telesales_restore_import(_import_id uuid)
RETURNS TABLE (leads bigint)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  _at timestamptz; _n bigint := 0;
BEGIN
  SELECT archived_at INTO _at FROM public.telesales_imports WHERE id = _import_id;
  IF _at IS NULL THEN
    RETURN QUERY SELECT 0::bigint;
    RETURN;
  END IF;

  UPDATE public.telesales_leads l
     SET archived_at = NULL, archived_by = NULL, archive_reason = NULL
    FROM public.telesales_source_records s
   WHERE s.id = l.source_record_id
     AND s.import_id = _import_id
     AND l.archived_at = _at;
  GET DIAGNOSTICS _n = ROW_COUNT;

  UPDATE public.telesales_source_records
     SET archived_at = NULL
   WHERE import_id = _import_id AND archived_at = _at;

  UPDATE public.telesales_imports
     SET archived_at = NULL, archived_by = NULL, archive_reason = NULL,
         archived_source_records = NULL, archived_leads = NULL, archived_followups = NULL
   WHERE id = _import_id;

  RETURN QUERY SELECT _n;
END;
$function$;

REVOKE ALL ON FUNCTION public.telesales_restore_import(uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.telesales_restore_import(uuid) TO service_role;

-- ===========================================================================
-- 4. Call Lookup — one customer's contact history
-- ===========================================================================
-- Answers "which agents have spoken to this number, and when", across every
-- lead the customer holds. The point is to stop a second agent dialling
-- somebody a colleague reached yesterday.
--
-- `activity_type = 'call'` only, for the reason documented in
-- `CONTACT_ACTIVITY_TYPES`: `created` has no actor, and `assigned`/`note` are
-- things done to a lead rather than to a person.
--
-- SECURITY DEFINER with its own permission check, because it reads across every
-- lead rather than one, and the caller's RLS does not apply inside it.
CREATE OR REPLACE FUNCTION public.telesales_contact_history(_phone text, _limit integer DEFAULT 50)
RETURNS TABLE (
  activity_id   uuid,
  lead_id       uuid,
  lead_type     text,
  item_name     text,
  occurred_at   timestamptz,
  agent_id      uuid,
  agent_name    text,
  outcome       text,
  note          text
)
LANGUAGE plpgsql
STABLE SECURITY DEFINER
SET search_path TO 'public'
AS $function$
BEGIN
  IF NOT public.has_permission(auth.uid(), 'view_telesales') THEN
    RAISE EXCEPTION 'Forbidden: view_telesales required';
  END IF;

  RETURN QUERY
  SELECT a.id, l.id, l.lead_type, l.item_name, a.created_at,
         a.actor_id, COALESCE(a.actor_name, p.full_name), a.outcome, a.note
  FROM public.telesales_lead_activities a
  JOIN public.telesales_leads l ON l.id = a.lead_id
  LEFT JOIN public.profiles p ON p.id = a.actor_id
  WHERE l.phone = _phone
    AND a.activity_type = 'call'
  ORDER BY a.created_at DESC
  LIMIT GREATEST(1, LEAST(_limit, 200));
END;
$function$;

GRANT EXECUTE ON FUNCTION public.telesales_contact_history(text, integer) TO authenticated, service_role;
REVOKE EXECUTE ON FUNCTION public.telesales_contact_history(text, integer) FROM anon;

-- ===========================================================================
-- 5. Import history with live counts
-- ===========================================================================
-- One round trip for the whole list. The alternative is a count query per
-- import row, which is the N+1 the brief asks to avoid and which grows with the
-- history rather than with the page.
--
-- `live_*` are counted now; `archived_leads` on the import row is the count
-- recorded at the moment of archiving. The two differ once leads are worked,
-- and the history shows both so an operator can see what an archive actually
-- did rather than what it would do today.
CREATE OR REPLACE FUNCTION public.telesales_import_summary(_limit integer DEFAULT 20)
RETURNS TABLE (
  id uuid, source_type text, file_name text, sheet_name text, status text,
  rows_total integer, rows_stored integer, rows_duplicate integer, rows_rejected integer,
  imported_at timestamptz, imported_by uuid, importer_name text, actor_role text,
  archived_at timestamptz, archive_reason text, archived_leads integer,
  live_source_records bigint, live_leads bigint, worked_leads bigint
)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path TO 'public'
AS $function$
BEGIN
  IF NOT public.has_permission(auth.uid(), 'manage_telesales') THEN
    RAISE EXCEPTION 'Forbidden: manage_telesales required';
  END IF;

  RETURN QUERY
  SELECT i.id, i.source_type, i.file_name, i.sheet_name, i.status,
         i.rows_total, i.rows_stored, i.rows_duplicate, i.rows_rejected,
         i.imported_at, i.imported_by, p.full_name, i.actor_role,
         i.archived_at, i.archive_reason, i.archived_leads,
         (SELECT count(*) FROM public.telesales_source_records s
           WHERE s.import_id = i.id AND s.archived_at IS NULL),
         (SELECT count(*) FROM public.telesales_leads l
            JOIN public.telesales_source_records s ON s.id = l.source_record_id
           WHERE s.import_id = i.id AND l.archived_at IS NULL),
         (SELECT count(DISTINCT a.lead_id) FROM public.telesales_lead_activities a
            JOIN public.telesales_leads l ON l.id = a.lead_id
            JOIN public.telesales_source_records s ON s.id = l.source_record_id
           WHERE s.import_id = i.id AND a.activity_type <> 'created')
  FROM public.telesales_imports i
  LEFT JOIN public.profiles p ON p.id = i.imported_by
  ORDER BY i.imported_at DESC
  LIMIT GREATEST(1, LEAST(_limit, 100));
END;
$function$;

GRANT EXECUTE ON FUNCTION public.telesales_import_summary(integer) TO authenticated, service_role;
REVOKE EXECUTE ON FUNCTION public.telesales_import_summary(integer) FROM anon;
