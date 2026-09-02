-- Telesales CRM, phase 1: a customer identity, and a safe way to undo an import.
--
-- ===========================================================================
-- Three things, and the evidence for each
-- ===========================================================================
--
--   1. `telesales_customers`  — one row per canonical phone number, so a
--      customer with three products is one customer with three opportunities
--      rather than three unrelated leads.
--
--   2. Archive columns       — removing an import must not destroy CRM history,
--      so nothing is deleted; rows are marked archived and disappear from the
--      operational queue.
--
--   3. `last_contacted_by`   — who actually spoke to this customer last, which
--      is a different question from who owns the lead.
--
-- Every one of these is sized against the live data rather than guessed at:
-- 712 leads, 709 with a usable phone, 656 distinct phones, 49 phones carrying
-- more than one lead, and a maximum of 3 leads on any single number.

-- ===========================================================================
-- 1. Customer identity
-- ===========================================================================
-- ---------------------------------------------------------------------------
-- Why the phone is the key, and why it is only a *link*
-- ---------------------------------------------------------------------------
-- The canonical Saudi mobile number is the only identifier that survives every
-- pipeline. Cash rows carry a Shams `Id` that is not a person (83,634 of the
-- July extract share the walk-in placeholder 437745); Wasfaty rows carry a
-- Patient ID that never appears on a Cash row; names are free text typed by
-- whoever answered the phone. The number is what the desk dials, and it is what
-- the Shams MIS loyalty lookup is keyed on.
--
-- But it is a link, not an identity claim. Measured on the live data: of the 49
-- phones holding more than one lead, 48 carry a single customer name and one —
-- `0559374809` — carries two ("SFD" and an Arabic full name). One of those is
-- almost certainly a placeholder rather than a second human, but the schema does
-- not get to assume that.
--
-- So this table records the names it has seen instead of choosing between them:
-- `display_name` is the one to show, `alternate_names` is everything else, and
-- the profile surfaces the disagreement rather than resolving it silently.
-- Nothing about a lead is rewritten — `telesales_leads.customer_name` keeps
-- whatever the source row said, because a lead is a snapshot of an opportunity.
CREATE TABLE IF NOT EXISTS public.telesales_customers (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),

  -- The canonical Saudi mobile number, `05XXXXXXXX`. The natural key.
  --
  -- NOT NULL and UNIQUE: a customer without a number is not a customer this
  -- table can identify, and those leads simply carry `customer_id IS NULL`.
  -- That is the honest representation — 3 of the 712 live leads have no usable
  -- number, and inventing an identity for them would merge them with each other.
  phone         text NOT NULL UNIQUE
                CHECK (phone ~ '^05[03-9][0-9]{7}$'),

  -- The name to show. The most recently seen non-empty name, maintained by the
  -- application when it links a lead.
  display_name  text,
  -- Every other name seen against this number. Usually empty; when it is not,
  -- the profile shows it, because "this number answered to two names" is
  -- something an agent should know before dialling.
  alternate_names text[] NOT NULL DEFAULT '{}',

  -- The Shams MIS loyalty customer id, once a lookup has resolved it. Null
  -- until then, and null forever if the MIS has never heard of this number.
  -- Filled by the phase-2 lookup; no MIS data is duplicated here beyond the id.
  mis_customer_id text,
  mis_synced_at   timestamptz,

  first_seen_at timestamptz NOT NULL DEFAULT now(),
  last_seen_at  timestamptz NOT NULL DEFAULT now(),
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS telesales_customers_mis_idx
  ON public.telesales_customers (mis_customer_id) WHERE mis_customer_id IS NOT NULL;

DROP TRIGGER IF EXISTS telesales_customers_updated_at ON public.telesales_customers;
CREATE TRIGGER telesales_customers_updated_at
  BEFORE UPDATE ON public.telesales_customers
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

-- ===========================================================================
-- 2. Lead columns
-- ===========================================================================
ALTER TABLE public.telesales_leads
  -- The consolidation link. ON DELETE SET NULL rather than CASCADE: a customer
  -- row is a convenience, and losing it must never take the opportunity with it.
  ADD COLUMN IF NOT EXISTS customer_id uuid
    REFERENCES public.telesales_customers(id) ON DELETE SET NULL,

  -- ---------------------------------------------------------------------
  -- Who last actually spoke to this customer
  -- ---------------------------------------------------------------------
  -- Deliberately not the same as `assigned_to`. A lead can be owned by one
  -- agent and last called by another — that is the normal state after a
  -- reassignment, and the queue has to show both or an agent will re-dial a
  -- customer a colleague spoke to yesterday.
  --
  -- `last_contacted_at` already exists and is set by `recordOutcome`; this is
  -- the actor to go with it, maintained by the same trigger so the two can
  -- never disagree.
  ADD COLUMN IF NOT EXISTS last_contacted_by uuid
    REFERENCES auth.users(id) ON DELETE SET NULL,

  -- --- archive ---------------------------------------------------------
  -- Soft delete, everywhere. "Remove this import" must not destroy the record
  -- that an agent called somebody — the activity log is append-only precisely
  -- so that history survives operational churn, and a hard delete would walk
  -- straight through it via ON DELETE CASCADE.
  ADD COLUMN IF NOT EXISTS archived_at timestamptz,
  ADD COLUMN IF NOT EXISTS archived_by uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS archive_reason text;

CREATE INDEX IF NOT EXISTS telesales_leads_customer_idx
  ON public.telesales_leads (customer_id) WHERE customer_id IS NOT NULL;

-- The queue's real predicate is now "open AND not archived". Replacing the
-- index rather than adding a second one: two partial indexes over the same
-- rows would both be maintained on every write and only one would ever be used.
DROP INDEX IF EXISTS public.telesales_leads_queue_idx;
CREATE INDEX IF NOT EXISTS telesales_leads_queue_idx
  ON public.telesales_leads (lead_type, status, priority DESC, created_at)
  WHERE archived_at IS NULL
    AND status IN ('new', 'assigned', 'in_progress', 'follow_up');

CREATE INDEX IF NOT EXISTS telesales_leads_archived_idx
  ON public.telesales_leads (archived_at) WHERE archived_at IS NOT NULL;

-- ===========================================================================
-- 3. Import and source-record archive
-- ===========================================================================
ALTER TABLE public.telesales_imports
  ADD COLUMN IF NOT EXISTS archived_at timestamptz,
  ADD COLUMN IF NOT EXISTS archived_by uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS archive_reason text,
  -- What the archive actually did, recorded at the time it was done. Counts
  -- computed later would drift as leads are worked; this is the receipt.
  ADD COLUMN IF NOT EXISTS archived_source_records integer,
  ADD COLUMN IF NOT EXISTS archived_leads integer,
  ADD COLUMN IF NOT EXISTS archived_followups integer;

ALTER TABLE public.telesales_source_records
  ADD COLUMN IF NOT EXISTS archived_at timestamptz;

CREATE INDEX IF NOT EXISTS telesales_source_records_active_idx
  ON public.telesales_source_records (source_type, source_date)
  WHERE archived_at IS NULL AND source_date IS NOT NULL;

-- ===========================================================================
-- 4. Last contact, maintained from the activity log
-- ===========================================================================
-- ---------------------------------------------------------------------------
-- What counts as contacting a customer
-- ---------------------------------------------------------------------------
-- Only `activity_type = 'call'`. This is the rule the brief asks to be defined
-- and written down, and the live activity mix is why it matters: of 727
-- activities, 719 are `created` (written by lead generation, with no actor at
-- all), 5 are `assigned`, 1 is a `note`, and 2 are calls.
--
-- Counting any of the other three would report "last contacted by" for 719
-- leads nobody has ever dialled, and would attribute the contact to whoever
-- happened to press Import.
--
-- A trigger rather than application code because there are two write paths that
-- append a call (`recordOutcome`, and the bulk paths added in this phase), and
-- a denormalised column maintained in one of them is a column that is wrong.
CREATE OR REPLACE FUNCTION public.telesales_sync_last_contact()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
BEGIN
  IF NEW.activity_type <> 'call' THEN
    RETURN NULL;
  END IF;

  UPDATE public.telesales_leads
     SET last_contacted_at = NEW.created_at,
         last_contacted_by = NEW.actor_id,
         first_contacted_at = COALESCE(first_contacted_at, NEW.created_at)
   WHERE id = NEW.lead_id
     -- Never move the marker backwards. Activities are append-only but they can
     -- be inserted out of order by a backfill, and the *latest* call is the one
     -- the queue is asking about.
     AND (last_contacted_at IS NULL OR NEW.created_at >= last_contacted_at);

  RETURN NULL;
END;
$function$;

DROP TRIGGER IF EXISTS telesales_activities_sync_last_contact ON public.telesales_lead_activities;
CREATE TRIGGER telesales_activities_sync_last_contact
  AFTER INSERT ON public.telesales_lead_activities
  FOR EACH ROW EXECUTE FUNCTION public.telesales_sync_last_contact();

-- ===========================================================================
-- 5. Backfill
-- ===========================================================================
DO $do$
DECLARE
  _customers integer;
  _linked    integer;
  _contacts  integer;
BEGIN
  -- ---- customers, from the leads that already exist --------------------
  -- The display name is the most recent non-empty one, which for a repeat
  -- customer is the spelling the desk saw last.
  INSERT INTO public.telesales_customers (phone, display_name, first_seen_at, last_seen_at)
  SELECT l.phone,
         (SELECT x.customer_name FROM public.telesales_leads x
           WHERE x.phone = l.phone AND NULLIF(btrim(x.customer_name), '') IS NOT NULL
           ORDER BY x.created_at DESC LIMIT 1),
         min(l.created_at),
         max(l.created_at)
  FROM public.telesales_leads l
  WHERE l.phone IS NOT NULL
  GROUP BY l.phone
  ON CONFLICT (phone) DO NOTHING;
  GET DIAGNOSTICS _customers = ROW_COUNT;

  -- Every other name seen against the number, so a disagreement is visible
  -- rather than silently resolved by the ORDER BY above.
  UPDATE public.telesales_customers c
     SET alternate_names = COALESCE(a.names, '{}')
    FROM (
      SELECT l.phone,
             array_agg(DISTINCT btrim(l.customer_name)) FILTER (
               WHERE NULLIF(btrim(l.customer_name), '') IS NOT NULL
             ) AS names
      FROM public.telesales_leads l
      WHERE l.phone IS NOT NULL
      GROUP BY l.phone
    ) a
   WHERE a.phone = c.phone
     AND array_length(a.names, 1) > 1;

  -- Drop the display name out of the alternates so it is not listed twice.
  UPDATE public.telesales_customers
     SET alternate_names = array_remove(alternate_names, display_name)
   WHERE display_name IS NOT NULL
     AND display_name = ANY(alternate_names);

  UPDATE public.telesales_leads l
     SET customer_id = c.id
    FROM public.telesales_customers c
   WHERE c.phone = l.phone AND l.customer_id IS NULL;
  GET DIAGNOSTICS _linked = ROW_COUNT;

  -- ---- last contact, from the activity log -----------------------------
  UPDATE public.telesales_leads l
     SET last_contacted_at = a.at,
         last_contacted_by = a.actor
    FROM (
      SELECT DISTINCT ON (lead_id) lead_id, created_at AS at, actor_id AS actor
      FROM public.telesales_lead_activities
      WHERE activity_type = 'call'
      ORDER BY lead_id, created_at DESC
    ) a
   WHERE a.lead_id = l.id;
  GET DIAGNOSTICS _contacts = ROW_COUNT;

  RAISE NOTICE 'telesales phase 1 backfill: % customers, % leads linked, % last-contact stamps',
    _customers, _linked, _contacts;
END;
$do$;

-- ===========================================================================
-- 6. Security
-- ===========================================================================
ALTER TABLE public.telesales_customers ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Telesales customers readable with view_telesales" ON public.telesales_customers;
CREATE POLICY "Telesales customers readable with view_telesales"
  ON public.telesales_customers
  FOR SELECT
  TO authenticated
  USING (public.has_permission(auth.uid(), 'view_telesales'));

GRANT SELECT ON public.telesales_customers TO authenticated;
REVOKE ALL ON public.telesales_customers FROM anon;

COMMENT ON TABLE public.telesales_customers IS
  'One row per canonical Saudi mobile number. Consolidates a customer''s several '
  'leads without merging them: the leads stay separate opportunities and keep '
  'their own customer_name. Phone is a strong link, not an identity claim -- see '
  'alternate_names.';

COMMENT ON COLUMN public.telesales_leads.last_contacted_by IS
  'The agent who last recorded a call activity on this lead. Deliberately not '
  'assigned_to: a lead can be owned by one agent and last called by another.';

COMMENT ON COLUMN public.telesales_leads.archived_at IS
  'Soft delete. Archived leads leave the operational queue but keep their '
  'append-only activity history. Nothing in this module hard-deletes a lead.';
