-- The Shams sync Control Center: configurable daily schedule slots.
--
-- ===========================================================================
-- What changes, and what deliberately does not
-- ===========================================================================
-- Phase 2A hardcoded one nightly trigger into `pg_cron` (`0 22 * * *`). That
-- meant changing the schedule meant changing a cron job, which meant a
-- migration, which meant an engineer. This replaces it with schedule *data*:
--
--   * `shams_sync_schedule_slots` — one row per daily time, each targeting
--     stock, promotions, or both. Administrators add, edit and remove rows.
--   * `shams_sync_settings` — one global automation switch.
--   * `shams_sync_tick()` — a single fixed `* * * * *` job that asks one indexed
--     question and, almost always, does nothing.
--
-- `pg_cron` is touched exactly once, here. After this migration nobody schedules
-- or unschedules anything ever again; the administrator changes rows.
--
-- ===========================================================================
-- The three defaults are three daily times, not an interval
-- ===========================================================================
-- 15:00, 21:00 and 00:00 Asia/Riyadh. The gaps between them are 6h, 3h and 15h
-- — deliberately uneven — so they cannot be collapsed into "every eight hours"
-- without changing what the business asked for. The model stores each as its
-- own row precisely so that moving one leaves the others alone.
--
-- ===========================================================================
-- Applying this changes no behaviour
-- ===========================================================================
-- `automation_enabled` seeds to **false**. The slots exist, are enabled, and
-- target both kinds — but nothing evaluates them until an administrator turns
-- automation on. Applying this migration to production starts no sync, exactly
-- as `20260827120000` did not.

-- ===========================================================================
-- 1. The global switch
-- ===========================================================================

CREATE TABLE IF NOT EXISTS public.shams_sync_settings (
  id                  integer PRIMARY KEY DEFAULT 1 CHECK (id = 1),
  -- Seeded false. Enabling production automation is a human decision taken in
  -- the Control Center, never a side effect of a deploy.
  automation_enabled  boolean NOT NULL DEFAULT false,
  updated_at          timestamptz NOT NULL DEFAULT now(),
  -- No FK: the setting must outlive the account that last changed it, the same
  -- reason `admin_activity` carries no FK to `profiles`.
  updated_by          uuid
);

INSERT INTO public.shams_sync_settings (id, automation_enabled)
VALUES (1, false)
ON CONFLICT (id) DO NOTHING;

ALTER TABLE public.shams_sync_settings ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Administrators can read Shams sync settings"
  ON public.shams_sync_settings;
CREATE POLICY "Administrators can read Shams sync settings"
  ON public.shams_sync_settings
  FOR SELECT TO authenticated
  USING (public.is_administrator(auth.uid()));

COMMENT ON TABLE public.shams_sync_settings IS
  'One row (id=1). The global Shams automation switch. Seeded false; only an '
  'administrator turns it on, through the Control Center. Writes go through the '
  'audited server functions on the service role, never through RLS.';

-- ===========================================================================
-- 2. The schedule slots
-- ===========================================================================

CREATE TABLE IF NOT EXISTS public.shams_sync_schedule_slots (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),

  enabled            boolean NOT NULL DEFAULT true,

  -- The wall-clock time an administrator entered. Stored as a local time plus a
  -- named zone rather than as UTC, so the stored value is the one they typed and
  -- the conversion happens at evaluation. Nobody has to think in UTC.
  local_time         time NOT NULL,

  -- IANA name, never a fixed offset. Saudi Arabia observes no daylight saving
  -- today; a schedule that would silently break if that ever changed is not
  -- something to write on purpose.
  time_zone          text NOT NULL DEFAULT 'Asia/Riyadh',

  -- What this slot targets. Both, by default, matching the three seeded slots.
  sync_stock         boolean NOT NULL DEFAULT true,
  sync_promotions    boolean NOT NULL DEFAULT true,

  -- The contract with the scheduler: a UTC instant, written by the application.
  -- `shams_sync_tick()` compares this to now() and does nothing else with it.
  -- NULL means "not yet computed" — the first evaluation fills it in without
  -- running anything.
  next_due_at        timestamptz,

  -- The occurrence most recently acted on, for the history and for diagnosis.
  last_scheduled_for timestamptz,

  created_at         timestamptz NOT NULL DEFAULT now(),
  updated_at         timestamptz NOT NULL DEFAULT now(),
  updated_by         uuid
);

-- The tick's predicate. Partial, because a disabled slot is never a candidate.
CREATE INDEX IF NOT EXISTS shams_sync_schedule_slots_due_idx
  ON public.shams_sync_schedule_slots (next_due_at)
  WHERE enabled;

ALTER TABLE public.shams_sync_schedule_slots ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Administrators can read Shams sync schedule slots"
  ON public.shams_sync_schedule_slots;
CREATE POLICY "Administrators can read Shams sync schedule slots"
  ON public.shams_sync_schedule_slots
  FOR SELECT TO authenticated
  USING (public.is_administrator(auth.uid()));

COMMENT ON TABLE public.shams_sync_schedule_slots IS
  'Configurable daily schedule slots for Shams sync. Each row is one wall-clock '
  'time in a named zone, targeting stock, promotions, or both. Administrators '
  'change these rows; pg_cron is never rescheduled. next_due_at is a UTC instant '
  'written by the application and is the only thing shams_sync_tick() reads.';

-- The three defaults, seeded once. `next_due_at` is left NULL on purpose: the
-- application computes it at the first evaluation, so the schedule arithmetic
-- lives in exactly one place (`sync-schedule.ts`) rather than being duplicated
-- in plpgsql where it could drift.
INSERT INTO public.shams_sync_schedule_slots (local_time, time_zone, sync_stock, sync_promotions, enabled)
SELECT v.t, 'Asia/Riyadh', true, true, true
  FROM (VALUES ('15:00'::time), ('21:00'::time), ('00:00'::time)) AS v(t)
 WHERE NOT EXISTS (SELECT 1 FROM public.shams_sync_schedule_slots);

-- ===========================================================================
-- 3. Run history gains its scheduling identity
-- ===========================================================================
-- Additive only. Every Phase 2A row keeps its meaning; the new columns are NULL
-- on them, which reads correctly as "this predates slots".

ALTER TABLE public.shams_sync_runs
  ADD COLUMN IF NOT EXISTS scheduled_for    timestamptz,
  ADD COLUMN IF NOT EXISTS schedule_slot_id uuid,
  ADD COLUMN IF NOT EXISTS requested_by     uuid;

COMMENT ON COLUMN public.shams_sync_runs.scheduled_for IS
  'The occurrence this run belongs to. NULL for manual runs, and NULL for rows '
  'written before the Control Center existed.';

/*
 * Exactly once per occurrence.
 *
 * This is the idempotency guarantee the schedule needs, and it is enforced by
 * the database rather than by application logic that could be raced. A duplicate
 * cron tick, two workers, a redeploy mid-evaluation or a pg_net retry all
 * converge on the same row: the second insert violates this index and stops.
 *
 * Keyed on (sync_type, scheduled_for) rather than on the slot, so two slots
 * configured at the same time cannot produce two stock runs for one instant
 * either. Manual runs carry scheduled_for = NULL and are outside it entirely --
 * which is what lets a manual run coexist with the schedule without consuming
 * it.
 */
CREATE UNIQUE INDEX IF NOT EXISTS shams_sync_runs_occurrence_key
  ON public.shams_sync_runs (sync_type, scheduled_for)
  WHERE execution_source = 'scheduled' AND scheduled_for IS NOT NULL;

-- ===========================================================================
-- 4. The tick
-- ===========================================================================
-- Replaces `shams_sync_due(task)`. One job, one question, no business logic.
--
-- It answers: is there anything at all for the application to do? Two ways for
-- that to be true --
--
--   * a run is open and needs reconciling, or
--   * automation is on and an enabled slot's next_due_at has arrived.
--
-- When neither holds it records `idle` and makes **no HTTP request**, which is
-- what keeps a one-minute cadence free. The global switch is evaluated here as
-- well as in TypeScript, so turning automation off stops the outbound request at
-- the database rather than merely at the application.

CREATE OR REPLACE FUNCTION public.shams_sync_tick()
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, net, vault
AS $$
DECLARE
  open_count  integer;
  due_count   integer;
  endpoint    text;
  secret      text;
  prior_id    bigint;
  prior_code  integer;
  prior_err   text;
  note        text;
  request_id  bigint;
BEGIN
  SELECT count(*) INTO open_count
    FROM public.shams_sync_runs
   WHERE status IN ('triggered', 'running');

  SELECT count(*) INTO due_count
    FROM public.shams_sync_schedule_slots s
   WHERE s.enabled
     AND (s.sync_stock OR s.sync_promotions)
     AND (s.next_due_at IS NULL OR s.next_due_at <= now())
     AND EXISTS (SELECT 1 FROM public.shams_sync_settings g
                  WHERE g.id = 1 AND g.automation_enabled);

  /*
   * Read the previous tick's reply before deciding anything.
   *
   * pg_net answers asynchronously, so a 401 -- the exact shape of a credential
   * drifting apart between the vault and the deployment -- can only ever be
   * observed here, one tick later. Without this the job would fire into a
   * rejecting endpoint indefinitely and report success every time.
   */
  SELECT last_request_id INTO prior_id
    FROM public.shams_sync_scheduler_state WHERE id = 1;

  IF prior_id IS NOT NULL THEN
    SELECT status_code, error_msg INTO prior_code, prior_err
      FROM net._http_response WHERE id = prior_id;

    IF prior_err IS NOT NULL THEN
      note := 'The Shams sync scheduler could not be reached on its last attempt.';
    ELSIF prior_code IS NOT NULL AND (prior_code < 200 OR prior_code > 299) THEN
      note := 'The Shams sync scheduler was refused by the application (HTTP '
              || prior_code || ') on its last attempt.';
    END IF;

    IF note IS NOT NULL THEN
      RAISE WARNING 'shams_sync_tick: previous poll failed (status %, %)',
        prior_code, coalesce(prior_err, 'no transport error');
    END IF;
  END IF;

  UPDATE public.shams_sync_scheduler_state
     SET last_poll_at = now(), updated_at = now()
   WHERE id = 1;

  IF open_count = 0 AND due_count = 0 THEN
    -- The overwhelmingly common case: 1,438 of 1,440 minutes a day.
    UPDATE public.shams_sync_scheduler_state
       SET last_outcome = 'idle', last_task = 'tick', last_error = note, updated_at = now()
     WHERE id = 1;
    RETURN 0;
  END IF;

  SELECT decrypted_secret INTO endpoint
    FROM vault.decrypted_secrets WHERE name = 'shams_sync_scheduler_url';

  /*
   * The platform's own service role key -- the same vault entry
   * `email_queue_dispatch()` and `alshrouq_dispatch_due()` read. Not a new
   * credential, and deliberately not a hand-maintained one.
   */
  SELECT decrypted_secret INTO secret
    FROM vault.decrypted_secrets WHERE name = 'email_queue_service_role_key';

  IF endpoint IS NULL OR secret IS NULL THEN
    RAISE WARNING
      'shams_sync_tick: work is due but the scheduler is not configured '
      '(vault entry shams_sync_scheduler_url is absent)';

    note := 'The Shams sync scheduler is not connected on this deployment, so no '
            'synchronisation has been started. An administrator needs to complete the setup.';

    UPDATE public.shams_sync_scheduler_state
       SET last_outcome = 'unconfigured', last_task = 'tick', last_error = note, updated_at = now()
     WHERE id = 1;

    RETURN -1;
  END IF;

  SELECT net.http_post(
    url     := endpoint,
    headers := jsonb_build_object(
                 'content-type', 'application/json',
                 'Authorization', 'Bearer ' || secret
               ),
    body    := jsonb_build_object('task', 'tick', 'open', open_count, 'due', due_count),
    timeout_milliseconds := 60000
  ) INTO request_id;

  UPDATE public.shams_sync_scheduler_state
     SET last_outcome    = 'poked',
         last_task       = 'tick',
         last_poke_at    = now(),
         last_request_id = request_id,
         last_error      = note,
         updated_at      = now()
   WHERE id = 1;

  RETURN open_count + due_count;
END;
$$;

REVOKE ALL ON FUNCTION public.shams_sync_tick() FROM PUBLIC, anon, authenticated;

COMMENT ON FUNCTION public.shams_sync_tick() IS
  'pg_cron entry point for Shams CRM sync. Wakes every minute; pokes the application '
  'only when a run is open or an enabled slot is due and automation is on. Contacts '
  'Shams never, and contains no scheduling logic -- next_due_at is written by the '
  'application. Returns -1 when it could not act because the vault entry '
  'shams_sync_scheduler_url is absent.';

-- ===========================================================================
-- 5. The schedule, replaced once
-- ===========================================================================
-- The two Phase 2A jobs are retired in favour of one evaluator. This is the only
-- time pg_cron is touched by this feature: from here the administrator changes
-- slot rows and the cron entry never moves.

DO $do$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'pg_cron') THEN
    PERFORM cron.unschedule('shams-sync-trigger')
      WHERE EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'shams-sync-trigger');
    PERFORM cron.unschedule('shams-sync-reconcile')
      WHERE EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'shams-sync-reconcile');

    PERFORM cron.unschedule('shams-sync-tick')
      WHERE EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'shams-sync-tick');
    PERFORM cron.schedule(
      'shams-sync-tick',
      '* * * * *',
      $cmd$SELECT public.shams_sync_tick();$cmd$
    );
  END IF;
END;
$do$;

-- Retired. Nothing references it once the jobs above are replaced, and an unused
-- SECURITY DEFINER function that can issue HTTP requests is not worth leaving in
-- the schema for a later reader to work out the status of.
DROP FUNCTION IF EXISTS public.shams_sync_due(text);
