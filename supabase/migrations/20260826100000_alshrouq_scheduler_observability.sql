-- The scheduler's poll, made incapable of failing silently.
--
-- ===========================================================================
-- What went wrong, stated plainly
-- ===========================================================================
-- `alshrouq_dispatch_due()` shipped with two `RETURN 0` branches that mean
-- opposite things:
--
--     IF due_count = 0 THEN RETURN 0;                      -- nothing to do
--     IF endpoint IS NULL OR secret IS NULL THEN RETURN 0;  -- cannot do anything
--
-- The second one fired on this database from the day the job was registered.
-- The vault held neither `alshrouq_scheduler_url` nor
-- `alshrouq_scheduler_secret`, so every tick read the vault, found nothing, and
-- returned the same integer an idle minute returns. `cron.job_run_details`
-- recorded 5,769 consecutive successes. No HTTP request was ever made.
--
-- One real delivery sat in `scheduled` from 2026-08-23 18:45Z with
-- `attempt_count = 0`, `last_attempt_at` null and `last_error` null -- a row
-- carrying no trace of the fact that nothing had tried to send it, on a screen
-- whose countdown had read "due" for two days.
--
-- The missing configuration is a deployment fault and is fixed by supplying it.
-- *Being unable to tell that from an idle minute* is a fault in this function,
-- and that is what this migration fixes. An unconfigured scheduler must be
-- loud: in the Postgres log, in a state row an administrator can read, and on
-- the order itself.
--
-- ===========================================================================
-- 1. Where the poll records what it did
-- ===========================================================================
-- One row, `id = 1`, the same shape as `public.email_send_state`. A table
-- rather than a log: what matters operationally is the *current* answer to
-- "is the scheduler working", and a row that is overwritten every minute
-- answers it without growing forever.
--
-- It holds no payload, no customer and no credential -- only whether the last
-- poll could act, and what the endpoint said if it was asked.

CREATE TABLE IF NOT EXISTS public.alshrouq_scheduler_state (
  id                integer PRIMARY KEY DEFAULT 1 CHECK (id = 1),
  -- Every tick, whether or not there was work. Its absence or staleness is
  -- itself the alarm: it means pg_cron is not running the job at all.
  last_poll_at      timestamptz,
  -- Only when a request was actually sent.
  last_poke_at      timestamptz,
  -- `net.http_post`'s request id, kept so the *next* tick can read the reply.
  -- pg_net is asynchronous: the response lands in `net._http_response` after
  -- this function has long returned, so a poll that is never looked at again
  -- cannot notice a 401 loop.
  last_request_id   bigint,
  -- idle | unconfigured | poked. What the last tick was able to do.
  last_outcome      text,
  -- Why it could not act, or what the endpoint answered. Operations copy, and
  -- never the endpoint or the credential.
  last_error        text,
  updated_at        timestamptz NOT NULL DEFAULT now()
);

INSERT INTO public.alshrouq_scheduler_state (id)
VALUES (1)
ON CONFLICT (id) DO NOTHING;

ALTER TABLE public.alshrouq_scheduler_state ENABLE ROW LEVEL SECURITY;

-- Read-only to signed-in staff, exactly as `alshrouq_dispatches` is: knowing
-- whether the scheduler is alive is diagnostic, and the row holds nothing
-- sensitive. Writes belong to the SECURITY DEFINER function below and to the
-- service role, so no policy grants them.
DROP POLICY IF EXISTS "Authenticated can read scheduler state"
  ON public.alshrouq_scheduler_state;
CREATE POLICY "Authenticated can read scheduler state"
  ON public.alshrouq_scheduler_state
  FOR SELECT TO authenticated
  USING (true);

COMMENT ON TABLE public.alshrouq_scheduler_state IS
  'One row (id=1) recording what the AlShrouq scheduled-dispatch poll last did. '
  'A stale last_poll_at means pg_cron is not running the job; last_outcome = '
  '''unconfigured'' means the vault entries are missing.';

-- ===========================================================================
-- 2. The poll
-- ===========================================================================
-- The sentences it writes onto due rows are duplicated, deliberately, in
-- `alshrouq-scheduler.server.ts`, which clears exactly them when it finally
-- claims a row. Two short strings in two languages beats a lookup table for
-- text that exists only to be read by a person.

CREATE OR REPLACE FUNCTION public.alshrouq_dispatch_due()
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, net, vault
AS $$
DECLARE
  due_count   integer;
  stale_count integer;
  endpoint    text;
  secret      text;
  prior_id    bigint;
  prior_code  integer;
  prior_err   text;
  note        text;
  request_id  bigint;
BEGIN
  /*
   * Work is two things, not one.
   *
   * A row parked in `scheduled` whose time has come is the obvious case. A row
   * stuck in `processing` is the other: the worker claimed it and then died --
   * a deploy mid-run, a platform timeout -- and because the due query only
   * looks for `scheduled`, nothing would ever poke the endpoint on its behalf
   * again. It would sit claimed forever, invisible.
   *
   * Counting it here is what gets the worker woken up to reap it. The reaping
   * itself is the worker's, in `runDueAlShrouqDispatches`, because deciding
   * that an abandoned claim becomes `indeterminate` is dispatch policy and
   * belongs beside the rest of it.
   */
  SELECT count(*) INTO due_count
    FROM public.alshrouq_dispatches
   WHERE dispatch_status = 'scheduled'
     AND cancelled_at IS NULL
     AND scheduled_for <= now();

  SELECT count(*) INTO stale_count
    FROM public.alshrouq_dispatches
   WHERE dispatch_status = 'processing'
     AND cancelled_at IS NULL
     AND last_attempt_at < now() - interval '15 minutes';

  /*
   * Read the previous tick's reply before deciding anything.
   *
   * pg_net answers asynchronously, so the only place a 401 -- the exact shape
   * of a shared credential drifting apart between the vault and the deployment
   * -- can be observed is here, one minute later. Without this the job would
   * keep firing into a rejecting endpoint and keep reporting success.
   */
  SELECT last_request_id INTO prior_id
    FROM public.alshrouq_scheduler_state WHERE id = 1;

  IF prior_id IS NOT NULL THEN
    SELECT status_code, error_msg INTO prior_code, prior_err
      FROM net._http_response WHERE id = prior_id;

    IF prior_err IS NOT NULL THEN
      note := 'The delivery scheduler could not be reached. Nothing has been sent.';
    ELSIF prior_code IS NOT NULL AND (prior_code < 200 OR prior_code > 299) THEN
      note := 'The delivery scheduler was refused by the application (HTTP '
              || prior_code || '). Nothing has been sent.';
    END IF;

    IF note IS NOT NULL THEN
      RAISE WARNING 'alshrouq_dispatch_due: previous poll failed (status %, %)',
        prior_code, coalesce(prior_err, 'no transport error');
    END IF;
  END IF;

  UPDATE public.alshrouq_scheduler_state
     SET last_poll_at = now(), updated_at = now()
   WHERE id = 1;

  IF due_count = 0 AND stale_count = 0 THEN
    -- Genuinely idle. Recorded as such, so "idle" and "broken" stop looking
    -- alike, and no HTTP call is made.
    UPDATE public.alshrouq_scheduler_state
       SET last_outcome = 'idle', last_error = note, updated_at = now()
     WHERE id = 1;
    RETURN 0;
  END IF;

  SELECT decrypted_secret INTO endpoint
    FROM vault.decrypted_secrets WHERE name = 'alshrouq_scheduler_url';
  -- The platform's own service role key, the same entry `email_queue_dispatch()`
  -- reads. Not a credential anyone maintains by hand, which is the point: the
  -- endpoint compares it against the `SUPABASE_SERVICE_ROLE_KEY` the same
  -- platform put in the runtime, so the two halves cannot drift apart.
  SELECT decrypted_secret INTO secret
    FROM vault.decrypted_secrets WHERE name = 'email_queue_service_role_key';

  IF endpoint IS NULL OR secret IS NULL THEN
    /*
     * The failure this whole migration exists for.
     *
     * Still default-safe -- nothing is guessed and nothing is sent -- but no
     * longer quiet. It warns in the Postgres log, it records `unconfigured` in
     * the state row, and it stamps the waiting deliveries so the agent watching
     * a finished countdown is told why nothing happened.
     *
     * The stamp is written only where it differs, so a delivery waiting for a
     * week is updated once rather than ten thousand times.
     */
    RAISE WARNING
      'alshrouq_dispatch_due: % item(s) need the scheduler but it is not configured '
      '(vault entries alshrouq_scheduler_url / email_queue_service_role_key are absent)',
      due_count + stale_count;

    note := 'The delivery scheduler is not connected on this deployment, so '
            'nothing has been sent yet. An administrator needs to complete the setup.';

    UPDATE public.alshrouq_dispatches
       SET last_error = note
     WHERE dispatch_status = 'scheduled'
       AND cancelled_at IS NULL
       AND scheduled_for <= now()
       AND last_error IS DISTINCT FROM note;

    UPDATE public.alshrouq_scheduler_state
       SET last_outcome = 'unconfigured', last_error = note, updated_at = now()
     WHERE id = 1;

    -- Negative, so a caller reading the return value can tell "could not act"
    -- from "nothing to do". The cron command ignores it; a human running the
    -- function by hand does not.
    RETURN -1;
  END IF;

  -- A rejected or unreachable endpoint, carried onto the deliveries it is
  -- holding up. Same write-only-on-change rule as above.
  IF note IS NOT NULL THEN
    UPDATE public.alshrouq_dispatches
       SET last_error = note
     WHERE dispatch_status = 'scheduled'
       AND cancelled_at IS NULL
       AND scheduled_for <= now()
       AND last_error IS DISTINCT FROM note;
  END IF;

  SELECT net.http_post(
    url     := endpoint,
    headers := jsonb_build_object(
                 'content-type', 'application/json',
                 'Authorization', 'Bearer ' || secret
               ),
    body    := jsonb_build_object('due', due_count, 'stale', stale_count),
    timeout_milliseconds := 30000
  ) INTO request_id;

  UPDATE public.alshrouq_scheduler_state
     SET last_outcome    = 'poked',
         last_poke_at    = now(),
         last_request_id = request_id,
         last_error      = note,
         updated_at      = now()
   WHERE id = 1;

  RETURN due_count + stale_count;
END;
$$;

REVOKE ALL ON FUNCTION public.alshrouq_dispatch_due() FROM PUBLIC, anon, authenticated;

COMMENT ON FUNCTION public.alshrouq_dispatch_due() IS
  'pg_cron entry point for scheduled AlShrouq dispatch. Pokes the application '
  'endpoint when work is due; dispatches nothing itself. Returns the number of '
  'items poked for, 0 when idle, and -1 when it could not act because the vault '
  'entries alshrouq_scheduler_url / email_queue_service_role_key are absent -- which '
  'it also warns about and records in public.alshrouq_scheduler_state.';

-- The index the stale-claim count uses. Partial, for the same reason the due
-- index is: almost every row in this table is a finished delivery.
CREATE INDEX IF NOT EXISTS alshrouq_dispatches_stale_claim_idx
  ON public.alshrouq_dispatches (last_attempt_at)
  WHERE dispatch_status = 'processing' AND cancelled_at IS NULL;

-- ===========================================================================
-- 3. The registration, re-asserted
-- ===========================================================================
-- Idempotent, and repeated here rather than assumed: this migration is also the
-- one an operator reaches for when the scheduler is suspected dead, and it
-- should leave the job armed whether or not it already was.
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
