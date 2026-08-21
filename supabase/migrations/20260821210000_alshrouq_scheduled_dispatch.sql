-- Scheduled AlShrouq dispatch: the state a courier handoff waits in, and the
-- job that wakes up to perform it.
--
-- ===========================================================================
-- Why the cron job is registered *here* and not by hand
-- ===========================================================================
-- This database already had a pg_cron job -- `SELECT public.email_queue_dispatch()`
-- -- which ran 54 times, all succeeded, from 2026-08-06 until 2026-08-20
-- 23:15:19Z, and then stopped. `cron.job` now holds zero rows. The function
-- still exists and its vault secret still exists; only the *registration* was
-- lost, 56 seconds after the Lovable revert completed.
--
-- It never came back because it was never written down. The email migration
-- describes that job in `--` comments ("Creates job 'process-email-queue'") but
-- never executes `cron.schedule`, so nothing in this repository could recreate
-- it and nothing noticed it was gone. Outbound email has been dead since.
--
-- A courier dispatch that silently stops is worse than an email that silently
-- stops, so this job is registered by a migration: reproducible, reviewable, and
-- restored by the same `supabase db push` that builds everything else.
--
-- ===========================================================================
-- 1. Scheduled-dispatch state
-- ===========================================================================
-- Deliberately columns on `alshrouq_dispatches` rather than a second table. The
-- unique index `alshrouq_dispatches_live_order_key` -- UNIQUE (order_id) WHERE
-- cancelled_at IS NULL -- is the one-courier-per-order guarantee, and putting
-- scheduled rows anywhere else would route around it. Here, *scheduling an order
-- reserves its slot*: a second schedule, or a manual send while one is pending,
-- collides with the index rather than producing a second driver.

ALTER TABLE public.alshrouq_dispatches
  -- The lifecycle, explicit rather than inferred from which columns are null.
  ADD COLUMN IF NOT EXISTS dispatch_status text NOT NULL DEFAULT 'accepted',
  -- When the courier should be called. NULL means "immediately", which is what
  -- every row created before this migration was.
  ADD COLUMN IF NOT EXISTS scheduled_for timestamptz,
  /*
   * The payload the agent approved, frozen.
   *
   * The dispatch that eventually runs must be the dispatch that was authorised,
   * not whatever the order says an hour later. Rebuilding from `orders` at
   * dispatch time would let an edit -- a corrected phone, a different branch --
   * silently change what a courier is told, with nobody having approved it. So
   * the snapshot is written once and read once, and the worker never reads the
   * order at all.
   */
  ADD COLUMN IF NOT EXISTS payload_snapshot jsonb,
  ADD COLUMN IF NOT EXISTS scheduled_by uuid REFERENCES auth.users(id),
  ADD COLUMN IF NOT EXISTS scheduled_at timestamptz,
  -- Diagnostics for a failed or ambiguous run. Never a credential.
  ADD COLUMN IF NOT EXISTS last_error text,
  ADD COLUMN IF NOT EXISTS attempt_count integer NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS last_attempt_at timestamptz;

/*
 * The state machine.
 *
 * `processing` is a claim, not a status anyone reports: a worker moves a row
 * into it and no other worker can then select it. `indeterminate` is a terminal
 * state a human resolves -- it means the request was transmitted and the outcome
 * is unknown, and the one thing that must never follow it is another POST.
 */
ALTER TABLE public.alshrouq_dispatches
  DROP CONSTRAINT IF EXISTS alshrouq_dispatches_status_valid;
ALTER TABLE public.alshrouq_dispatches
  ADD CONSTRAINT alshrouq_dispatches_status_valid
  CHECK (dispatch_status IN (
    'scheduled', 'processing', 'accepted', 'failed', 'indeterminate', 'cancelled'
  ));

-- A scheduled row must say when. Nothing else may.
ALTER TABLE public.alshrouq_dispatches
  DROP CONSTRAINT IF EXISTS alshrouq_dispatches_scheduled_has_time;
ALTER TABLE public.alshrouq_dispatches
  ADD CONSTRAINT alshrouq_dispatches_scheduled_has_time
  CHECK (dispatch_status <> 'scheduled' OR scheduled_for IS NOT NULL);

-- The worker's only query: due, still scheduled, not cancelled. Partial, because
-- the overwhelming majority of rows are finished dispatches it must never touch.
CREATE INDEX IF NOT EXISTS alshrouq_dispatches_due_idx
  ON public.alshrouq_dispatches (scheduled_for)
  WHERE dispatch_status = 'scheduled' AND cancelled_at IS NULL;

COMMENT ON COLUMN public.alshrouq_dispatches.dispatch_status IS
  'scheduled | processing | accepted | failed | indeterminate | cancelled. '
  'processing is a worker claim. indeterminate is terminal until a human resolves it '
  'and must never be followed by another POST.';
COMMENT ON COLUMN public.alshrouq_dispatches.payload_snapshot IS
  'The AlShrouq payload exactly as approved. Read at dispatch time instead of the '
  'order, so later Portal edits cannot change what the courier is told.';

-- Existing rows are completed deliveries, and the default above already says so.
-- Stated explicitly for the four that predate this migration.
UPDATE public.alshrouq_dispatches
   SET dispatch_status = 'accepted'
 WHERE dispatch_status IS NULL OR dispatch_status = '';

-- ===========================================================================
-- 2. The waker
-- ===========================================================================
-- Mirrors `public.email_queue_dispatch()`: pg_cron calls a SECURITY DEFINER
-- function, and the function -- not the cron command -- holds the endpoint and
-- the shared secret, read from vault. That keeps both out of `cron.job`, which
-- is world-readable to anyone who can read the catalog.
--
-- The function performs no dispatch itself. It pokes an application endpoint,
-- because the AlShrouq transport, the payload builder, the reconciliation and
-- the safety gate are all TypeScript running in the Worker, and reimplementing
-- any of them in plpgsql would be a second integration to keep in step.

CREATE OR REPLACE FUNCTION public.alshrouq_dispatch_due()
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, net, vault
AS $$
DECLARE
  due_count integer;
  endpoint  text;
  secret    text;
BEGIN
  -- Cheap guard first: no due work, no HTTP call, no log noise. This runs every
  -- minute forever, and the overwhelmingly common case is nothing to do.
  SELECT count(*) INTO due_count
    FROM public.alshrouq_dispatches
   WHERE dispatch_status = 'scheduled'
     AND cancelled_at IS NULL
     AND scheduled_for <= now();

  IF due_count = 0 THEN
    RETURN 0;
  END IF;

  SELECT decrypted_secret INTO endpoint
    FROM vault.decrypted_secrets WHERE name = 'alshrouq_scheduler_url';
  SELECT decrypted_secret INTO secret
    FROM vault.decrypted_secrets WHERE name = 'alshrouq_scheduler_secret';

  -- Default-safe. An environment that has not been given the endpoint and the
  -- secret does nothing at all -- it does not guess a URL, and it does not fail
  -- the cron run. The rows stay `scheduled` and are picked up once configured.
  IF endpoint IS NULL OR secret IS NULL THEN
    RETURN 0;
  END IF;

  PERFORM net.http_post(
    url     := endpoint,
    headers := jsonb_build_object(
                 'content-type', 'application/json',
                 'x-alshrouq-scheduler-secret', secret
               ),
    body    := jsonb_build_object('due', due_count),
    timeout_milliseconds := 30000
  );

  RETURN due_count;
END;
$$;

REVOKE ALL ON FUNCTION public.alshrouq_dispatch_due() FROM PUBLIC, anon, authenticated;

COMMENT ON FUNCTION public.alshrouq_dispatch_due() IS
  'pg_cron entry point for scheduled AlShrouq dispatch. Pokes the application '
  'endpoint when work is due; dispatches nothing itself. No-op when the vault '
  'secrets alshrouq_scheduler_url / alshrouq_scheduler_secret are absent.';

-- ===========================================================================
-- 3. The registration
-- ===========================================================================
-- Every minute. The agent picks a time to the minute, so finer buys nothing and
-- coarser would make "02:30 PM" mean something else.
--
-- Unschedule-then-schedule so re-running this migration is safe and so the
-- schedule can be corrected by editing this file rather than by remembering to
-- log in somewhere.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'pg_cron') THEN
    PERFORM cron.unschedule('alshrouq-dispatch-due')
      WHERE EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'alshrouq-dispatch-due');

    PERFORM cron.schedule(
      'alshrouq-dispatch-due',
      '* * * * *',
      'SELECT public.alshrouq_dispatch_due();'
    );
  END IF;
END;
$$;
