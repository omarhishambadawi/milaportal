-- Telesales CRM: triggers, row level security and grants.
--
-- ===========================================================================
-- The access model, in one paragraph
-- ===========================================================================
-- Reads are RLS-bounded and go straight from the browser: the queue is a list of
-- 50 rows with filters and paging, and routing that through a server function
-- would reimplement PostgREST badly. Writes do not: recording an outcome updates
-- the lead, appends an activity, may open or close a follow-up and may start a
-- retention cycle, and half of that landing is worse than none of it. So every
-- table here grants SELECT to `authenticated` and nothing else, and the writes
-- live in `src/lib/telesales.functions.ts` behind `service_role`.
--
-- That is the same split `alshrouq_dispatches` uses, for the same reason, and it
-- means the RLS policies below have exactly one job: decide who may *see* Shams
-- telesales data. `has_permission()` answers it, so the policy and the
-- application check cannot drift.

-- ===========================================================================
-- 1. `updated_at`, everywhere it exists
-- ===========================================================================
-- `public.set_updated_at()` already exists (it is what `orders`,
-- `branches` and `profiles` use). Reused rather than reimplemented.

DROP TRIGGER IF EXISTS telesales_products_updated_at ON public.telesales_products;
CREATE TRIGGER telesales_products_updated_at
  BEFORE UPDATE ON public.telesales_products
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

DROP TRIGGER IF EXISTS telesales_product_patterns_updated_at ON public.telesales_product_patterns;
CREATE TRIGGER telesales_product_patterns_updated_at
  BEFORE UPDATE ON public.telesales_product_patterns
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

DROP TRIGGER IF EXISTS telesales_leads_updated_at ON public.telesales_leads;
CREATE TRIGGER telesales_leads_updated_at
  BEFORE UPDATE ON public.telesales_leads
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

DROP TRIGGER IF EXISTS telesales_followups_updated_at ON public.telesales_followups;
CREATE TRIGGER telesales_followups_updated_at
  BEFORE UPDATE ON public.telesales_followups
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

-- ===========================================================================
-- 2. The lead's next follow-up date follows its follow-ups
-- ===========================================================================
-- `telesales_leads.next_followup_on` is a cache of "the open follow-up's due
-- date, or nothing". It exists so the queue can filter and sort on it without a
-- correlated subquery per row, and it is maintained by trigger rather than by
-- the application because there are four write paths that can change a
-- follow-up and only one of them is obvious.
--
-- It reads the table rather than trusting NEW, so cancelling one follow-up while
-- another is open still leaves the lead pointing at the survivor. The partial
-- unique index makes that at most one row, but the query does not assume it.
CREATE OR REPLACE FUNCTION public.telesales_sync_next_followup()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  _lead_id uuid := COALESCE(NEW.lead_id, OLD.lead_id);
  _due date;
BEGIN
  SELECT f.due_on INTO _due
    FROM public.telesales_followups f
   WHERE f.lead_id = _lead_id AND f.status = 'scheduled'
   ORDER BY f.due_on
   LIMIT 1;

  UPDATE public.telesales_leads
     SET next_followup_on = _due
   WHERE id = _lead_id
     AND next_followup_on IS DISTINCT FROM _due;

  RETURN NULL;
END;
$function$;

DROP TRIGGER IF EXISTS telesales_followups_sync_lead ON public.telesales_followups;
CREATE TRIGGER telesales_followups_sync_lead
  AFTER INSERT OR UPDATE OR DELETE ON public.telesales_followups
  FOR EACH ROW EXECUTE FUNCTION public.telesales_sync_next_followup();

-- ===========================================================================
-- 3. Activity is append-only, in the database
-- ===========================================================================
-- "Never overwrite historical interactions" is a requirement, so it is an
-- invariant rather than a convention. `service_role` writes every activity row
-- and RLS does not constrain it, which is exactly why the guarantee has to be a
-- trigger: without this, a bug in a server function could rewrite a call log and
-- nothing would notice.
CREATE OR REPLACE FUNCTION public.telesales_activity_is_immutable()
RETURNS trigger
LANGUAGE plpgsql
AS $function$
BEGIN
  RAISE EXCEPTION 'telesales_lead_activities is append-only (attempted %)', TG_OP;
END;
$function$;

DROP TRIGGER IF EXISTS telesales_lead_activities_immutable ON public.telesales_lead_activities;
CREATE TRIGGER telesales_lead_activities_immutable
  BEFORE UPDATE OR DELETE ON public.telesales_lead_activities
  FOR EACH ROW EXECUTE FUNCTION public.telesales_activity_is_immutable();

-- ===========================================================================
-- 4. Row level security
-- ===========================================================================

ALTER TABLE public.telesales_products          ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.telesales_product_patterns  ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.telesales_settings          ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.telesales_imports           ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.telesales_source_records    ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.telesales_generation_runs   ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.telesales_leads             ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.telesales_lead_activities   ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.telesales_followups         ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.telesales_patient_contacts  ENABLE ROW LEVEL SECURITY;

-- ---------------------------------------------------------------------------
-- Leads, activities, follow-ups: `view_telesales`
-- ---------------------------------------------------------------------------
-- Every holder sees every lead, not only their own. That is deliberate and it is
-- the point of replacing the spreadsheets: an agent about to dial a number needs
-- to be able to see that a colleague called it yesterday. Ownership is enforced
-- on the *write* side -- an agent may only act on a lead assigned to them, or
-- claim an unassigned one -- which is where the duplicate-call risk actually
-- lives.
CREATE POLICY "Telesales leads readable with view_telesales"
  ON public.telesales_leads
  FOR SELECT
  TO authenticated
  USING (public.has_permission(auth.uid(), 'view_telesales'));

CREATE POLICY "Telesales activity readable with view_telesales"
  ON public.telesales_lead_activities
  FOR SELECT
  TO authenticated
  USING (public.has_permission(auth.uid(), 'view_telesales'));

CREATE POLICY "Telesales follow-ups readable with view_telesales"
  ON public.telesales_followups
  FOR SELECT
  TO authenticated
  USING (public.has_permission(auth.uid(), 'view_telesales'));

-- ---------------------------------------------------------------------------
-- Product configuration and settings: readable with `view_telesales`
-- ---------------------------------------------------------------------------
-- The queue renders family badges and the detail page explains why a lead
-- exists; both need this reference data. It is configuration, not customer
-- information.
CREATE POLICY "Telesales products readable with view_telesales"
  ON public.telesales_products
  FOR SELECT
  TO authenticated
  USING (public.has_permission(auth.uid(), 'view_telesales'));

CREATE POLICY "Telesales product patterns readable with view_telesales"
  ON public.telesales_product_patterns
  FOR SELECT
  TO authenticated
  USING (public.has_permission(auth.uid(), 'view_telesales'));

CREATE POLICY "Telesales settings readable with view_telesales"
  ON public.telesales_settings
  FOR SELECT
  TO authenticated
  USING (public.has_permission(auth.uid(), 'view_telesales'));

-- ---------------------------------------------------------------------------
-- Imports, source records, runs: `manage_telesales`
-- ---------------------------------------------------------------------------
-- Narrower than the leads on purpose. A source record is the raw extract -- every
-- customer in the pharmacy's month, including the ~99.6% of July rows that never
-- became a lead. An agent needs the 670 opportunities, not the 173,008 purchases,
-- and the least-privilege reading of "do not unnecessarily expose customer
-- information" is that the raw drop stays with the people who manage it.
CREATE POLICY "Telesales imports readable with manage_telesales"
  ON public.telesales_imports
  FOR SELECT
  TO authenticated
  USING (public.has_permission(auth.uid(), 'manage_telesales'));

CREATE POLICY "Telesales source records readable with manage_telesales"
  ON public.telesales_source_records
  FOR SELECT
  TO authenticated
  USING (public.has_permission(auth.uid(), 'manage_telesales'));

CREATE POLICY "Telesales runs readable with manage_telesales"
  ON public.telesales_generation_runs
  FOR SELECT
  TO authenticated
  USING (public.has_permission(auth.uid(), 'manage_telesales'));

-- ---------------------------------------------------------------------------
-- Patient contacts: `view_telesales`
-- ---------------------------------------------------------------------------
-- The phone number is the thing the Wasfaty agent is working; withholding it
-- from the person on the call would defeat the feature. The *history* of
-- corrections is visible to the same holders, because "who changed this number"
-- is an operational question the desk asks of itself.
CREATE POLICY "Telesales patient contacts readable with view_telesales"
  ON public.telesales_patient_contacts
  FOR SELECT
  TO authenticated
  USING (public.has_permission(auth.uid(), 'view_telesales'));

-- ---------------------------------------------------------------------------
-- No INSERT / UPDATE / DELETE policy anywhere in this module
-- ---------------------------------------------------------------------------
-- Not an omission. Each write is a multi-row transition that has to hold
-- together (record an outcome -> update the lead -> append an activity -> settle
-- the follow-up), and a client that could do the first three but not the fourth
-- would leave the desk with leads whose timeline disagrees with their state. The
-- server functions run as `service_role`, which RLS does not apply to, and they
-- each perform their own `has_permission()` check against the same keys these
-- policies use.

-- ===========================================================================
-- 5. Grants
-- ===========================================================================
-- SELECT only, and never to `anon`. This is healthcare-adjacent operational data
-- about named patients; an unauthenticated role has no business holding a
-- privilege on it even behind an RLS policy that would refuse it.
GRANT SELECT ON public.telesales_products         TO authenticated;
GRANT SELECT ON public.telesales_product_patterns TO authenticated;
GRANT SELECT ON public.telesales_settings         TO authenticated;
GRANT SELECT ON public.telesales_imports          TO authenticated;
GRANT SELECT ON public.telesales_source_records   TO authenticated;
GRANT SELECT ON public.telesales_generation_runs  TO authenticated;
GRANT SELECT ON public.telesales_leads            TO authenticated;
GRANT SELECT ON public.telesales_lead_activities  TO authenticated;
GRANT SELECT ON public.telesales_followups        TO authenticated;
GRANT SELECT ON public.telesales_patient_contacts TO authenticated;

REVOKE ALL ON public.telesales_products         FROM anon;
REVOKE ALL ON public.telesales_product_patterns FROM anon;
REVOKE ALL ON public.telesales_settings         FROM anon;
REVOKE ALL ON public.telesales_imports          FROM anon;
REVOKE ALL ON public.telesales_source_records   FROM anon;
REVOKE ALL ON public.telesales_generation_runs  FROM anon;
REVOKE ALL ON public.telesales_leads            FROM anon;
REVOKE ALL ON public.telesales_lead_activities  FROM anon;
REVOKE ALL ON public.telesales_followups        FROM anon;
REVOKE ALL ON public.telesales_patient_contacts FROM anon;

-- ===========================================================================
-- 6. The management read model
-- ===========================================================================
-- One SECURITY DEFINER function rather than eleven `count(*)` round trips from
-- the browser. The team-lead view asks the same aggregate question thirteen ways
-- over one day's leads, and doing that client-side would mean either thirteen
-- requests or shipping the day's rows to count them.
--
-- It re-checks the permission itself: SECURITY DEFINER means the caller's RLS
-- does not apply, so the function has to be the thing that refuses.
CREATE OR REPLACE FUNCTION public.telesales_management_summary(_day date DEFAULT NULL)
RETURNS TABLE (
  metric text,
  value  bigint
)
LANGUAGE plpgsql
STABLE SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  -- Riyadh-local "today" by default. `now()` is UTC on this platform, so a run
  -- between midnight and 03:00 UTC would otherwise report yesterday's figures to
  -- a team that is already at work.
  _anchor date := COALESCE(_day, ((now() AT TIME ZONE 'Asia/Riyadh')::date));
BEGIN
  IF NOT public.has_permission(auth.uid(), 'view_telesales') THEN
    RAISE EXCEPTION 'Forbidden: view_telesales required';
  END IF;

  RETURN QUERY
  WITH today AS (
    SELECT * FROM public.telesales_leads
     WHERE (created_at AT TIME ZONE 'Asia/Riyadh')::date = _anchor
  ),
  open_leads AS (
    SELECT * FROM public.telesales_leads
     WHERE status IN ('new', 'assigned', 'in_progress', 'follow_up')
  )
  SELECT 'leads_today'::text,        count(*)::bigint FROM today
  UNION ALL SELECT 'cash_today',      count(*) FROM today WHERE lead_type = 'cash'
  UNION ALL SELECT 'retention_today', count(*) FROM today WHERE lead_type = 'retention'
  UNION ALL SELECT 'wasfaty_today',   count(*) FROM today WHERE lead_type = 'wasfaty'
  UNION ALL SELECT 'open_total',      count(*) FROM open_leads
  UNION ALL SELECT 'unassigned',      count(*) FROM open_leads WHERE assigned_to IS NULL
  UNION ALL SELECT 'assigned',        count(*) FROM open_leads WHERE assigned_to IS NOT NULL
  UNION ALL SELECT 'contacted_today', count(*) FROM public.telesales_leads
              WHERE (last_contacted_at AT TIME ZONE 'Asia/Riyadh')::date = _anchor
  UNION ALL SELECT 'converted_today', count(*) FROM public.telesales_leads
              WHERE (converted_at AT TIME ZONE 'Asia/Riyadh')::date = _anchor
  UNION ALL SELECT 'closed_today',    count(*) FROM public.telesales_leads
              WHERE (closed_at AT TIME ZONE 'Asia/Riyadh')::date = _anchor
  UNION ALL SELECT 'followups_due',   count(*) FROM public.telesales_followups
              WHERE status = 'scheduled' AND due_on = _anchor
  UNION ALL SELECT 'followups_overdue', count(*) FROM public.telesales_followups
              WHERE status = 'scheduled' AND due_on < _anchor
  UNION ALL SELECT 'followups_upcoming', count(*) FROM public.telesales_followups
              WHERE status = 'scheduled' AND due_on > _anchor
  -- Outcome counts for the day, from the activity log rather than from the lead:
  -- a lead carries only its *last* outcome, so counting states would report one
  -- "No Answer" for a customer called three times.
  UNION ALL SELECT 'calls_today',     count(*) FROM public.telesales_lead_activities
              WHERE activity_type = 'call'
                AND (created_at AT TIME ZONE 'Asia/Riyadh')::date = _anchor
  UNION ALL SELECT 'no_answer_today', count(*) FROM public.telesales_lead_activities
              WHERE outcome = 'no_answer'
                AND (created_at AT TIME ZONE 'Asia/Riyadh')::date = _anchor;
END;
$function$;

GRANT EXECUTE ON FUNCTION public.telesales_management_summary(date) TO authenticated, service_role;
REVOKE EXECUTE ON FUNCTION public.telesales_management_summary(date) FROM anon;

-- ---------------------------------------------------------------------------
-- Agent workload
-- ---------------------------------------------------------------------------
-- Separate from the summary because it is a different shape (one row per agent,
-- not one row per metric) and because it is the only part of the management view
-- that names people.
CREATE OR REPLACE FUNCTION public.telesales_agent_workload(_day date DEFAULT NULL)
RETURNS TABLE (
  agent_id        uuid,
  agent_name      text,
  open_leads      bigint,
  contacted_today bigint,
  converted_today bigint,
  followups_due   bigint,
  followups_overdue bigint
)
LANGUAGE plpgsql
STABLE SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  _anchor date := COALESCE(_day, ((now() AT TIME ZONE 'Asia/Riyadh')::date));
BEGIN
  IF NOT public.has_permission(auth.uid(), 'view_telesales') THEN
    RAISE EXCEPTION 'Forbidden: view_telesales required';
  END IF;

  RETURN QUERY
  SELECT
    p.id,
    p.full_name,
    (SELECT count(*) FROM public.telesales_leads l
      WHERE l.assigned_to = p.id
        AND l.status IN ('new', 'assigned', 'in_progress', 'follow_up')),
    (SELECT count(DISTINCT a.lead_id) FROM public.telesales_lead_activities a
      WHERE a.actor_id = p.id AND a.activity_type = 'call'
        AND (a.created_at AT TIME ZONE 'Asia/Riyadh')::date = _anchor),
    (SELECT count(*) FROM public.telesales_leads l
      WHERE l.assigned_to = p.id
        AND (l.converted_at AT TIME ZONE 'Asia/Riyadh')::date = _anchor),
    (SELECT count(*) FROM public.telesales_followups f
      WHERE f.assigned_to = p.id AND f.status = 'scheduled' AND f.due_on = _anchor),
    (SELECT count(*) FROM public.telesales_followups f
      WHERE f.assigned_to = p.id AND f.status = 'scheduled' AND f.due_on < _anchor)
  FROM public.profiles p
  -- Anybody who currently holds telesales work, plus everyone on the telesales
  -- team. The union matters: an agent whose last lead closed yesterday should
  -- still appear on today's board at zero rather than vanish from it.
  WHERE p.active
    AND (
      EXISTS (SELECT 1 FROM public.user_roles r
               WHERE r.user_id = p.id AND r.role = 'telesales'::public.app_role)
      OR EXISTS (SELECT 1 FROM public.telesales_leads l WHERE l.assigned_to = p.id)
    )
  ORDER BY p.full_name;
END;
$function$;

GRANT EXECUTE ON FUNCTION public.telesales_agent_workload(date) TO authenticated, service_role;
REVOKE EXECUTE ON FUNCTION public.telesales_agent_workload(date) FROM anon;
