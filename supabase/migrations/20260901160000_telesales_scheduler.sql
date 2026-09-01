-- Telesales CRM: daily lead generation, on a schedule.
--
-- ===========================================================================
-- The same shape as the two schedulers already here
-- ===========================================================================
-- `pg_cron` wakes hourly, a plpgsql function decides whether anything is due,
-- and if it is, it pokes the application through `net.http_post`. Identical in
-- structure to `shams_sync_tick()` and `alshrouq_dispatch_due()`, reading the
-- same vault entry for the same service role key.
--
-- That is deliberate: a third scheduled job with a third architecture is a third
-- thing to learn, a third thing to monitor, and a third place for the credential
-- to drift. The brief asks not to introduce a new scheduling architecture, and
-- there is no reason to.
--
-- The generation itself is not here. The date windows, the product matching and
-- the deduplication keys are TypeScript, unit tested, and shared with the manual
-- "Generate now" button; reimplementing them in plpgsql would create a second
-- definition of the business rules that could quietly disagree with the first.
--
-- ===========================================================================
-- Why hourly rather than a single daily entry
-- ===========================================================================
-- Because the hour is configuration. `telesales_settings.generation_hour` is an
-- operator-editable number, and a fixed cron expression would mean either a
-- migration every time the desk changes its start time, or a function that
-- rewrites its own cron entry. Waking hourly and comparing against Riyadh's
-- current hour costs one row read, 24 times a day, and lets the setting be a
-- setting.

-- ===========================================================================
-- 1. Scheduler state -- what the last tick did
-- ===========================================================================
-- Without this, a scheduler that stops working reports nothing at all. That is
-- not hypothetical here: the AlShrouq scheduler ran 5,769 consecutive "successful"
-- cron jobs while every one of its HTTP calls was being refused with a 401, and
-- nothing in the database said so.
CREATE TABLE IF NOT EXISTS public.telesales_scheduler_state (
  id              integer PRIMARY KEY DEFAULT 1 CHECK (id = 1),

  -- 'poked' | 'idle' | 'disabled' | 'unconfigured'. Free text so a new outcome
  -- is not a migration.
  last_outcome    text,
  -- The Riyadh date the last successful poke was for. This is the idempotency
  -- guard at the schedule level: the tick refuses to poke twice for one day,
  -- so a deployment restart inside the generation hour cannot double-run.
  last_anchor     date,
  last_poke_at    timestamptz,
  -- `net.http_post`'s request id. pg_net is asynchronous, so this is the only
  -- handle on a request whose reply lands somewhere else entirely.
  last_request_id bigint,
  last_error      text,
  updated_at      timestamptz NOT NULL DEFAULT now()
);

INSERT INTO public.telesales_scheduler_state (id) VALUES (1) ON CONFLICT (id) DO NOTHING;

ALTER TABLE public.telesales_scheduler_state ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Telesales scheduler state readable with manage_telesales"
  ON public.telesales_scheduler_state
  FOR SELECT
  TO authenticated
  USING (public.has_permission(auth.uid(), 'manage_telesales'));

GRANT SELECT ON public.telesales_scheduler_state TO authenticated;
REVOKE ALL ON public.telesales_scheduler_state FROM anon;

-- ===========================================================================
-- 2. The tick
-- ===========================================================================
CREATE OR REPLACE FUNCTION public.telesales_generation_tick()
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'extensions', 'net', 'vault'
AS $$
DECLARE
  _enabled  boolean;
  _hour     integer;
  -- Riyadh, not UTC. The desk's morning is what the setting means, and on this
  -- platform `now()` is UTC -- an hour of 7 compared against UTC would fire at
  -- ten in the morning local time.
  _local    timestamptz := now() AT TIME ZONE 'Asia/Riyadh';
  _anchor   date := _local::date;
  _last     date;
  endpoint  text;
  secret    text;
  request_id bigint;
BEGIN
  SELECT automation_enabled, generation_hour INTO _enabled, _hour
    FROM public.telesales_settings WHERE id = true;

  IF NOT COALESCE(_enabled, false) THEN
    UPDATE public.telesales_scheduler_state
       SET last_outcome = 'disabled', last_error = NULL, updated_at = now()
     WHERE id = 1;
    RETURN 0;
  END IF;

  -- Not yet the configured hour.
  IF EXTRACT(HOUR FROM _local)::integer < COALESCE(_hour, 7) THEN
    UPDATE public.telesales_scheduler_state
       SET last_outcome = 'idle', updated_at = now()
     WHERE id = 1;
    RETURN 0;
  END IF;

  -- Already generated for this Riyadh day.
  --
  -- The application is idempotent anyway -- a second run collides with
  -- `telesales_leads_dedup_uidx` and creates nothing -- but a scheduler that
  -- pokes 17 more times after the first success would bury every real run in the
  -- history under a wall of no-ops.
  SELECT last_anchor INTO _last FROM public.telesales_scheduler_state WHERE id = 1;
  IF _last IS NOT NULL AND _last >= _anchor THEN
    UPDATE public.telesales_scheduler_state
       SET last_outcome = 'idle', updated_at = now()
     WHERE id = 1;
    RETURN 0;
  END IF;

  SELECT decrypted_secret INTO endpoint
    FROM vault.decrypted_secrets WHERE name = 'telesales_generation_url';
  /*
   * The platform's own service role key -- the same vault entry
   * `email_queue_dispatch()`, `alshrouq_dispatch_due()` and `shams_sync_tick()`
   * read. Not a new credential, and deliberately not a hand-maintained one.
   */
  SELECT decrypted_secret INTO secret
    FROM vault.decrypted_secrets WHERE name = 'email_queue_service_role_key';

  IF endpoint IS NULL OR secret IS NULL THEN
    RAISE WARNING
      'telesales_generation_tick: generation is due but the scheduler is not '
      'configured (vault entry telesales_generation_url is absent)';
    UPDATE public.telesales_scheduler_state
       SET last_outcome = 'unconfigured',
           last_error   = 'Vault entry telesales_generation_url is absent, so no '
                          'leads have been generated. An administrator needs to '
                          'complete the setup; the Import screen can generate by hand '
                          'in the meantime.',
           updated_at   = now()
     WHERE id = 1;
    RETURN -1;
  END IF;

  SELECT net.http_post(
    url     := endpoint,
    headers := jsonb_build_object(
                 'content-type', 'application/json',
                 'Authorization', 'Bearer ' || secret
               ),
    body    := jsonb_build_object('task', 'generate', 'anchor', _anchor),
    -- Generous: a Cash window over a large extract is the slowest thing this
    -- application does on a schedule, and a timeout here would leave the run
    -- half-done with the state table claiming it never started.
    timeout_milliseconds := 120000
  ) INTO request_id;

  /*
   * `last_anchor` is stamped on the poke, not on the reply.
   *
   * pg_net is asynchronous, so there is no reply to wait for. Stamping here means
   * a request that fails downstream is not retried automatically -- which is the
   * right trade for this job: the application is idempotent, the failure is
   * visible in `telesales_generation_runs`, and an unattended retry loop against
   * a broken deployment generates nothing except log volume. A person presses
   * "Generate now" instead.
   */
  UPDATE public.telesales_scheduler_state
     SET last_outcome    = 'poked',
         last_anchor     = _anchor,
         last_poke_at    = now(),
         last_request_id = request_id,
         last_error      = NULL,
         updated_at      = now()
   WHERE id = 1;

  RETURN 1;
END;
$$;

REVOKE ALL ON FUNCTION public.telesales_generation_tick() FROM PUBLIC, anon, authenticated;

COMMENT ON FUNCTION public.telesales_generation_tick() IS
  'pg_cron entry point for Telesales lead generation. Wakes hourly; pokes the '
  'application once per Riyadh day, only when automation is enabled and the '
  'configured hour has arrived. Contains no generation logic -- the windows, the '
  'product rules and the deduplication keys live in TypeScript and are shared with '
  'the manual run. Returns -1 when the vault entry telesales_generation_url is absent.';

-- ===========================================================================
-- 3. The schedule
-- ===========================================================================
-- Registered here rather than by hand so that it is reproducible: a generation
-- job that silently stops running means a desk with an empty queue and no
-- explanation, and a job that exists only because somebody once ran
-- `cron.schedule` in a console is a job nobody can rebuild or notice the absence
-- of.
DO $do$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'pg_cron') THEN
    PERFORM cron.unschedule('telesales-generation-tick')
      WHERE EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'telesales-generation-tick');
    PERFORM cron.schedule(
      'telesales-generation-tick',
      -- On the hour. The function decides whether that hour is the one.
      '0 * * * *',
      $cmd$SELECT public.telesales_generation_tick();$cmd$
    );
  END IF;
END;
$do$;

-- ===========================================================================
-- 4. What still has to be done by hand
-- ===========================================================================
-- The vault entry, once, per deployment:
--
--   SELECT vault.create_secret(
--     'https://<deployment-host>/api/telesales-generate',
--     'telesales_generation_url',
--     'Telesales daily lead generation endpoint'
--   );
--
-- It is not created here because the host differs per environment and a
-- migration that guessed it would arm a scheduler pointing at the wrong
-- deployment. Until it exists the tick records `unconfigured` and generation is
-- available from the Import screen, which is a working desk rather than a broken
-- one -- and `telesales_scheduler_state.last_error` says so in those words.
