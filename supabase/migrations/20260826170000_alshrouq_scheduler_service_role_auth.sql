-- The scheduler stops depending on a credential somebody has to remember.
--
-- ===========================================================================
-- The defect, and why a new secret was never the answer
-- ===========================================================================
-- `alshrouq_dispatch_due()` authenticated to the application with
-- `x-alshrouq-scheduler-secret`: one string held twice, once in the vault and
-- once in the deployment's `ALSHROUQ_SCHEDULER_SECRET`, kept equal by somebody
-- remembering to do it.
--
-- Nobody did. The vault half was never created, so the function reached
-- `IF endpoint IS NULL OR secret IS NULL THEN RETURN 0` on every one of 5,769
-- consecutive `succeeded` cron runs and made no HTTP request at all. A real
-- delivery sat in `scheduled` for days with `attempt_count = 0`. Supplying the
-- missing half would have fixed today's outage and left the mechanism that
-- caused it in place, ready to do the same thing after the next rotation.
--
-- ===========================================================================
-- What replaces it already exists in this database
-- ===========================================================================
-- `public.email_queue_dispatch()` -- the platform's own cron-driven job, live
-- and returning 200 -- authenticates like this:
--
--   'Authorization', 'Bearer ' || (SELECT decrypted_secret
--                                    FROM vault.decrypted_secrets
--                                   WHERE name = 'email_queue_service_role_key')
--
-- and the endpoint it calls, `/lovable/email/queue/process`, compares that
-- token against `process.env.SUPABASE_SERVICE_ROLE_KEY`. Its own comment states
-- the contract: "the pg_cron job sends the service role key as a Bearer token".
--
-- Both halves of that credential are issued and rotated by the platform, on
-- both sides, with nobody copying anything. That is the property the AlShrouq
-- poll was missing, so it now uses the same entry and the same header.
-- `/api/alshrouq-run-scheduled` accepts it through `isScheduler()`, which still
-- accepts the old header too, in constant time, so nothing that works today
-- stops working.
--
-- This grants no new authority. A caller holding the service role key can
-- already write `alshrouq_dispatches` directly and do considerably worse than
-- ask this endpoint to run a poll.
--
-- ===========================================================================
-- What is deliberately unchanged
-- ===========================================================================
--   * The endpoint. `alshrouq_scheduler_url` in the vault, as configured.
--   * The schedule. Every minute, already registered and active.
--   * The safety gate. `ALSHROUQ_LIVE_DISPATCH_ENABLED` still decides alone
--     whether a courier is contacted, and this migration cannot reach it.
--   * The dispatch itself. The poll pokes; it has never sent anything, and the
--     TypeScript worker behind the endpoint remains the only thing that does.
--
-- Note for whoever reads the two 2026-08-26 migrations together: the earlier
-- one, `20260826100000`, also defines this function. Its copy carries the same
-- Bearer credential, so whichever of the two is applied last, the scheduler
-- authenticates. That was the point of patching it rather than leaving a
-- pending migration able to silently restore a credential that does not work.

CREATE OR REPLACE FUNCTION public.alshrouq_dispatch_due()
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, net, vault
AS $$
DECLARE
  due_count   integer;
  endpoint    text;
  service_key text;
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

  -- The platform's service role key, read live rather than copied. The same
  -- entry `email_queue_dispatch()` uses, so a rotation that updates one job's
  -- credential updates this one's in the same moment.
  SELECT decrypted_secret INTO service_key
    FROM vault.decrypted_secrets WHERE name = 'email_queue_service_role_key';

  -- Default-safe, unchanged in spirit. An environment without the endpoint or
  -- without a service role key does nothing at all -- it does not guess a URL,
  -- and it does not fail the cron run. The rows stay `scheduled`.
  IF endpoint IS NULL OR service_key IS NULL THEN
    RETURN 0;
  END IF;

  PERFORM net.http_post(
    url     := endpoint,
    headers := jsonb_build_object(
                 'content-type', 'application/json',
                 'Authorization', 'Bearer ' || service_key
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
  'endpoint when work is due; dispatches nothing itself. Authenticates with the '
  'platform-managed service role key as a Bearer token, the same way '
  'email_queue_dispatch() does. No-op when the vault entries '
  'alshrouq_scheduler_url / email_queue_service_role_key are absent.';

-- ===========================================================================
-- The credential nobody needs any more
-- ===========================================================================
-- Removed rather than left lying about: an unused secret is one a later reader
-- has to work out the status of, and the function above no longer reads it.
-- Nothing else in the schema references it -- this name appears only in the two
-- AlShrouq scheduler migrations.
--
-- The *deployment* variable `ALSHROUQ_SCHEDULER_SECRET` is untouched and still
-- works: `isScheduler()` accepts that header from any external caller. This
-- only drops the database's copy, which existed solely for this function.
DELETE FROM vault.secrets WHERE name = 'alshrouq_scheduler_secret';
