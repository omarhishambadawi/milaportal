-- Automated Shams CRM stock and promotions synchronisation.
--
-- ===========================================================================
-- What this does, and what it deliberately does not
-- ===========================================================================
-- The synchronisation itself runs on `shams-crm.cloud`, in a background worker
-- this project does not own and does not change. Phase 1 established that the
-- PharmacyCRM Desktop client performs none of it: it POSTs a trigger, receives a
-- `run_id`, and polls a status endpoint. The operator can close the application
-- the moment the button is pressed.
--
-- So this migration automates *pressing the button*, and records what happened.
-- It contains no synchronisation logic because there is none to contain.
--
-- Two things live here:
--
--   1. `shams_sync_runs`           -- the history the CRM does not keep
--   2. `shams_sync_due()`          -- the pg_cron entry point that pokes the app
--
-- The Desktop remains the manual fallback and is untouched by all of this.
--
-- ===========================================================================
-- Why MilaPortal keeps its own history at all
-- ===========================================================================
-- `GET /stock/sync/status` returns exactly one run -- `latest_run` -- and no
-- history endpoint was found. There is therefore no way to answer "did last
-- night's sync run", "how long has it been taking", or "how often does it fail"
-- from the CRM, and those are the only questions automation actually needs to
-- answer. Every row here is written by this deployment about its own actions.
--
-- It stores no credential, no session token, and no upstream response body.

-- ===========================================================================
-- 1. The history
-- ===========================================================================

CREATE TABLE IF NOT EXISTS public.shams_sync_runs (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),

  sync_type             text NOT NULL CHECK (sync_type IN ('stock', 'promotions')),

  -- The CRM's own run id, once known. Text, not integer: it is an identifier,
  -- never arithmetic, and a third party may widen it without warning.
  -- Null while a trigger is in flight, and permanently null for a run that was
  -- skipped or that failed before it started.
  shams_run_id          text,

  -- 'scheduled' today. 'manual' exists so the Phase 2B controls can be added
  -- without a migration, not because anything writes it yet.
  execution_source      text NOT NULL DEFAULT 'scheduled'
                        CHECK (execution_source IN ('scheduled', 'manual')),

  -- The lifecycle:
  --
  --   triggered      claimed locally; the POST is in flight or just accepted
  --   running        the CRM confirms a run is active
  --   success        the CRM reported a completed run
  --   failed         the CRM reported failure, or refused to start one
  --   skipped        we chose not to trigger -- almost always because a run
  --                  was already active. Not a fault.
  --   indeterminate  the POST was sent and its outcome is unknown. A human
  --                  resolves this; nothing retries it automatically.
  --
  -- `triggered` and `running` are the non-terminal pair, and the partial unique
  -- index below keys on exactly them.
  status                text NOT NULL
                        CHECK (status IN ('triggered', 'running', 'success',
                                          'failed', 'skipped', 'indeterminate')),

  -- Why a run was skipped, in operator language. Only ever set with
  -- status = 'skipped'.
  skip_reason           text,

  -- When *we* acted. Distinct from `started_at`, which is when the CRM says its
  -- run began; the two differ by the trigger round trip, and on a night when the
  -- CRM misreports its clock they can differ by a great deal more.
  triggered_at          timestamptz NOT NULL DEFAULT now(),

  -- Mirrored from the CRM, after normalisation. See `source_timestamps_corrected`.
  started_at            timestamptz,
  completed_at          timestamptz,
  duration_seconds      integer CHECK (duration_seconds IS NULL OR duration_seconds >= 0),

  -- Volumes, as reported. All nullable: a field the CRM omits is recorded as
  -- unknown rather than as zero, because those mean very different things when
  -- the question is "did anything actually sync".
  rows_seen             integer CHECK (rows_seen IS NULL OR rows_seen >= 0),
  rows_changed          integer CHECK (rows_changed IS NULL OR rows_changed >= 0),
  pages_fetched         integer CHECK (pages_fetched IS NULL OR pages_fetched >= 0),
  branches_seen         integer CHECK (branches_seen IS NULL OR branches_seen >= 0),
  branches_targeted     integer CHECK (branches_targeted IS NULL OR branches_targeted >= 0),

  -- Operator copy. Never an upstream body, never a header, never a credential --
  -- the application maps a failure to a short sentence before it reaches here.
  error_summary         text,

  -- True when this row's timestamps had to be corrected from Riyadh local time
  -- to UTC at the application boundary.
  --
  -- Recorded per row rather than assumed per sync type, because it is a live
  -- statement about a third-party defect: Phase 1 observed it on promotions and
  -- not on stock, and the day Shams fixes it these values simply stop being
  -- true. See `sync-status.ts`, which is the only place the correction happens.
  source_timestamps_corrected boolean NOT NULL DEFAULT false,

  -- The last time the application read the CRM's status for this run. Its
  -- staleness on a non-terminal row is what tells an administrator that
  -- reconciliation has stopped.
  last_observed_at      timestamptz,

  created_at            timestamptz NOT NULL DEFAULT now(),
  updated_at            timestamptz NOT NULL DEFAULT now()
);

-- ---------------------------------------------------------------------------
-- The local concurrency guard
-- ---------------------------------------------------------------------------
-- At most one non-terminal run per sync type, enforced by the database rather
-- than by application logic that could be raced.
--
-- This is the primary duplicate-prevention mechanism and it is deliberately not
-- the only one. The scheduler also reads the CRM's own `is_running` before
-- triggering. Phase 1 could not verify what `POST /stock/sync` does when a run
-- is already active, so neither guard is trusted alone:
--
--   * this index stops two MilaPortal executions racing each other, which is a
--     situation we fully control and can therefore make impossible;
--   * the status pre-check stops us triggering over a run started by anything
--     else -- the Desktop, an operator, or the CRM's own dormant scheduler.
--
-- Stock and promotions are keyed separately because they are independent: Phase
-- 1 observed both running concurrently, six seconds apart, with no sign that
-- either depends on the other.
CREATE UNIQUE INDEX IF NOT EXISTS shams_sync_runs_active_key
  ON public.shams_sync_runs (sync_type)
  WHERE status IN ('triggered', 'running');

-- The monitoring page's query: the most recent rows for one sync type.
CREATE INDEX IF NOT EXISTS shams_sync_runs_recent_idx
  ON public.shams_sync_runs (sync_type, triggered_at DESC);

-- The reconciliation sweep, and the cheap gate in `shams_sync_due()`. Partial,
-- because almost every row in this table is a finished run.
CREATE INDEX IF NOT EXISTS shams_sync_runs_open_idx
  ON public.shams_sync_runs (triggered_at)
  WHERE status IN ('triggered', 'running');

ALTER TABLE public.shams_sync_runs ENABLE ROW LEVEL SECURITY;

-- Administrators read; nobody writes through RLS.
--
-- Stricter than `alshrouq_dispatches`, which is readable by any signed-in member
-- of staff, and deliberately so: that table is operational data an agent needs
-- to do their job, whereas this one is infrastructure telemetry that Phase 2A
-- exposes on an administrator-only page. Writes belong exclusively to the
-- service role the scheduler runs as, so no policy grants them -- a policy that
-- did would be a way for a browser to fabricate sync history.
DROP POLICY IF EXISTS "Administrators can read Shams sync runs" ON public.shams_sync_runs;
CREATE POLICY "Administrators can read Shams sync runs"
  ON public.shams_sync_runs
  FOR SELECT TO authenticated
  USING (public.is_administrator(auth.uid()));

COMMENT ON TABLE public.shams_sync_runs IS
  'MilaPortal''s own record of every Shams CRM stock/promotions sync it triggered. '
  'The CRM status endpoint returns only the latest run and keeps no history, so this '
  'is the only place the daily record exists. Holds no credentials and no upstream '
  'response bodies. At most one non-terminal row per sync_type (shams_sync_runs_active_key).';

COMMENT ON COLUMN public.shams_sync_runs.source_timestamps_corrected IS
  'True when this row''s timestamps arrived as Riyadh local time in a field the CRM '
  'labelled UTC and were corrected at the application boundary. Observed on promotions, '
  'not on stock. Expected to stop being true if Shams fixes the source.';

-- ===========================================================================
-- 2. What the poll last did
-- ===========================================================================
-- One row, id = 1, the same shape and for the same reason as
-- `public.alshrouq_scheduler_state`: what matters operationally is the *current*
-- answer to "is the scheduler alive", and a row overwritten every tick answers
-- it without growing forever.
--
-- This exists because of a failure this codebase has already had. The AlShrouq
-- poll shipped with two `RETURN 0` branches meaning opposite things -- "nothing
-- to do" and "cannot do anything" -- and the second one fired on every one of
-- 5,769 consecutive `succeeded` cron runs while nothing was ever sent. The same
-- mistake is available here and is refused the same way: an unconfigured
-- scheduler is loud, in the Postgres log and in a row an administrator can read.

CREATE TABLE IF NOT EXISTS public.shams_sync_scheduler_state (
  id                integer PRIMARY KEY DEFAULT 1 CHECK (id = 1),
  -- Every tick, whether or not there was anything to do. Staleness here means
  -- pg_cron is not running the job at all, which no other field can reveal.
  last_poll_at      timestamptz,
  -- Only when a request was actually sent to the application.
  last_poke_at      timestamptz,
  -- Which task the last poke asked for: 'trigger' or 'reconcile'.
  last_task         text,
  -- `net.http_post`'s request id. pg_net is asynchronous -- the reply lands in
  -- `net._http_response` long after this function returns -- so the only place a
  -- 401 loop can ever be noticed is the *next* tick, reading this.
  last_request_id   bigint,
  -- idle | unconfigured | poked
  last_outcome      text,
  -- Why it could not act, or what the endpoint answered. Operator copy only:
  -- never the endpoint, never the credential.
  last_error        text,
  updated_at        timestamptz NOT NULL DEFAULT now()
);

INSERT INTO public.shams_sync_scheduler_state (id)
VALUES (1)
ON CONFLICT (id) DO NOTHING;

ALTER TABLE public.shams_sync_scheduler_state ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Administrators can read Shams sync scheduler state"
  ON public.shams_sync_scheduler_state;
CREATE POLICY "Administrators can read Shams sync scheduler state"
  ON public.shams_sync_scheduler_state
  FOR SELECT TO authenticated
  USING (public.is_administrator(auth.uid()));

COMMENT ON TABLE public.shams_sync_scheduler_state IS
  'One row (id=1) recording what the Shams sync poll last did. A stale last_poll_at '
  'means pg_cron is not running the job; last_outcome = ''unconfigured'' means the '
  'vault entry shams_sync_scheduler_url is absent.';

-- ===========================================================================
-- 3. The poll
-- ===========================================================================
-- Two jobs call this, with different tasks, and the split is the whole design:
--
--   'trigger'    once a day. Start last night's syncs.
--   'reconcile'  every five minutes, but only while a run is actually open.
--
-- The alternative -- one job that both triggers and polls -- would have to know
-- the daily schedule in plpgsql as well as in cron, and would wake the
-- application 288 times a day to be told there is nothing to do. Here the cheap
-- `open_count` query means a reconcile tick makes no HTTP request at all unless
-- a run is genuinely in flight, which is roughly half an hour out of each day.
--
-- Note what this function does *not* do: it never contacts Shams, never decides
-- whether to trigger, and never writes to `shams_sync_runs`. It pokes the
-- application and nothing else. Every decision is TypeScript, because the
-- transport, the session handling, the status normalisation and the timestamp
-- correction are all TypeScript already, and a second implementation of any of
-- them in plpgsql would be a second thing to keep in step.

CREATE OR REPLACE FUNCTION public.shams_sync_due(task text DEFAULT 'reconcile')
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, net, vault
AS $$
DECLARE
  open_count  integer;
  endpoint    text;
  secret      text;
  prior_id    bigint;
  prior_code  integer;
  prior_err   text;
  note        text;
  request_id  bigint;
BEGIN
  IF task NOT IN ('trigger', 'reconcile') THEN
    RAISE EXCEPTION 'shams_sync_due: unknown task %', task;
  END IF;

  SELECT count(*) INTO open_count
    FROM public.shams_sync_runs
   WHERE status IN ('triggered', 'running');

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
      RAISE WARNING 'shams_sync_due: previous poll failed (status %, %)',
        prior_code, coalesce(prior_err, 'no transport error');
    END IF;
  END IF;

  UPDATE public.shams_sync_scheduler_state
     SET last_poll_at = now(), updated_at = now()
   WHERE id = 1;

  /*
   * A reconcile tick with nothing open is genuinely idle, and says so rather
   * than spending an HTTP request to be told the same. A trigger tick always
   * proceeds: deciding whether tonight's run should happen is the application's
   * judgement, not this function's.
   */
  IF task = 'reconcile' AND open_count = 0 THEN
    UPDATE public.shams_sync_scheduler_state
       SET last_outcome = 'idle', last_task = task, last_error = note, updated_at = now()
     WHERE id = 1;
    RETURN 0;
  END IF;

  SELECT decrypted_secret INTO endpoint
    FROM vault.decrypted_secrets WHERE name = 'shams_sync_scheduler_url';

  /*
   * The platform's own service role key -- the same vault entry
   * `email_queue_dispatch()` and `alshrouq_dispatch_due()` read.
   *
   * Not a new credential, and deliberately not a hand-maintained one. The
   * AlShrouq scheduler's outage was caused precisely by a secret held twice and
   * kept equal by somebody remembering to; both halves of this one are issued
   * and rotated by the same system, so there is no copy for anyone to forget.
   */
  SELECT decrypted_secret INTO secret
    FROM vault.decrypted_secrets WHERE name = 'email_queue_service_role_key';

  IF endpoint IS NULL OR secret IS NULL THEN
    RAISE WARNING
      'shams_sync_due: task % needs the scheduler but it is not configured '
      '(vault entries shams_sync_scheduler_url / email_queue_service_role_key are absent)',
      task;

    note := 'The Shams sync scheduler is not connected on this deployment, so no '
            'synchronisation has been started. An administrator needs to complete the setup.';

    UPDATE public.shams_sync_scheduler_state
       SET last_outcome = 'unconfigured', last_task = task, last_error = note, updated_at = now()
     WHERE id = 1;

    -- Negative, so a person running this by hand can tell "could not act" from
    -- "nothing to do". The cron command ignores the return value.
    RETURN -1;
  END IF;

  SELECT net.http_post(
    url     := endpoint,
    headers := jsonb_build_object(
                 'content-type', 'application/json',
                 'Authorization', 'Bearer ' || secret
               ),
    body    := jsonb_build_object('task', task, 'open', open_count),
    timeout_milliseconds := 60000
  ) INTO request_id;

  UPDATE public.shams_sync_scheduler_state
     SET last_outcome    = 'poked',
         last_task       = task,
         last_poke_at    = now(),
         last_request_id = request_id,
         last_error      = note,
         updated_at      = now()
   WHERE id = 1;

  RETURN open_count;
END;
$$;

REVOKE ALL ON FUNCTION public.shams_sync_due(text) FROM PUBLIC, anon, authenticated;

COMMENT ON FUNCTION public.shams_sync_due(text) IS
  'pg_cron entry point for Shams CRM sync. task=''trigger'' pokes the application to '
  'start the daily runs; task=''reconcile'' pokes it only while a run is open. Contacts '
  'Shams itself never. Returns the open-run count, or -1 when it could not act because '
  'the vault entry shams_sync_scheduler_url is absent -- which it also warns about and '
  'records in public.shams_sync_scheduler_state.';

-- ===========================================================================
-- 4. The schedule
-- ===========================================================================
-- 22:00 UTC is 01:00 in Riyadh. Chosen because:
--
--   * It is off-peak for a pharmacy chain, well clear of trading hours.
--   * The two observed runs took 24 and 26 minutes and ran concurrently, so a
--     01:00 start is comfortably finished before 02:00 and long before anyone
--     opens the Desktop in the morning.
--   * It leaves the whole working day as recovery time: a failed night is
--     visible on the admin page hours before it matters, and the Desktop remains
--     available as the manual fallback throughout.
--
-- Once daily, not more. There is no operational reason for a second run -- the
-- data being synced changes on a daily cycle -- and each run costs the CRM
-- roughly 840 upstream page fetches.
--
-- Changing the time does not need a deploy or a migration:
--
--   SELECT cron.alter_job(
--     (SELECT jobid FROM cron.job WHERE jobname = 'shams-sync-trigger'),
--     schedule := '0 23 * * *');
--
-- Registration is idempotent and re-asserted here, because this is also the file
-- an operator reaches for when the scheduler is suspected dead.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'pg_cron') THEN
    PERFORM cron.unschedule('shams-sync-trigger')
      WHERE EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'shams-sync-trigger');
    PERFORM cron.schedule(
      'shams-sync-trigger',
      '0 22 * * *',
      $cmd$SELECT public.shams_sync_due('trigger');$cmd$
    );

    PERFORM cron.unschedule('shams-sync-reconcile')
      WHERE EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'shams-sync-reconcile');
    PERFORM cron.schedule(
      'shams-sync-reconcile',
      '*/5 * * * *',
      $cmd$SELECT public.shams_sync_due('reconcile');$cmd$
    );
  END IF;
END;
$$;
