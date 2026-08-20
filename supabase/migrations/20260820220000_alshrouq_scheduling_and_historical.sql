-- Holding an AlShrouq delivery until a chosen time, and marking one historical
-- by hand.
--
-- ===========================================================================
-- 1. Why the Portal holds the request rather than telling the courier to wait
-- ===========================================================================
-- The CRM accepts a delivery time, and AlShrouq does not honour it: an order
-- submitted now with "deliver in three hours" is collected now. So the only
-- thing that actually defers a delivery is not sending the create request yet.
-- `alshrouq_scheduled_at` is the time the Portal will send it; until then no
-- CRM request exists and no dispatch row is written, so nothing anywhere claims
-- the courier has the order.
--
-- Null means "send on save", which is the ordinary case and the existing
-- behaviour. A time in the past behaves the same way — a schedule that has
-- already come round is simply due.

BEGIN;

ALTER TABLE public.orders
  ADD COLUMN IF NOT EXISTS alshrouq_scheduled_at timestamptz,
  ADD COLUMN IF NOT EXISTS alshrouq_historical   boolean NOT NULL DEFAULT false;

COMMENT ON COLUMN public.orders.alshrouq_scheduled_at IS
  'When the Portal will POST this order to the CRM. Null = send immediately on save. The courier is not told to wait; the request itself is withheld until this time.';
COMMENT ON COLUMN public.orders.alshrouq_historical IS
  'Set by an owner or admin to declare an AlShrouq order as predating the integration. Enforced server-side in isHistoricalAlShrouqOrder alongside the automatic detection.';

-- The sweep runs on a schedule and must not seq-scan `orders` to find the
-- handful that are due. Partial, because almost every row has no schedule.
CREATE INDEX IF NOT EXISTS orders_alshrouq_due_idx
  ON public.orders (alshrouq_scheduled_at)
  WHERE alshrouq_scheduled_at IS NOT NULL;

COMMIT;

-- ===========================================================================
-- POST-MIGRATION STEP — REQUIRED for scheduled dispatch to run at all
-- ===========================================================================
-- Same shape as the email queue in `20260806151650_email_infra.sql`, and for
-- the same reason: the job needs the project URL and the service_role key, so
-- it cannot be static SQL and is applied out of band.
--
-- Until this job exists, a scheduled order is held and never sent. Everything
-- else works; nothing dispatches early. Register it against the project:
--
--   -- 1. the key the sweep authenticates with
--   SELECT vault.create_secret(
--     '<SERVICE_ROLE_KEY>', 'alshrouq_dispatch_service_role_key');
--
--   -- 2. the sweep itself, once a minute
--   SELECT cron.schedule(
--     'alshrouq-dispatch-scheduled',
--     '* * * * *',
--     $$
--     SELECT net.http_post(
--       url     := '<APP_ORIGIN>/api/alshrouq/run-scheduled',
--       headers := jsonb_build_object(
--         'Content-Type',  'application/json',
--         'Authorization', 'Bearer ' || (
--           SELECT decrypted_secret FROM vault.decrypted_secrets
--            WHERE name = 'alshrouq_dispatch_service_role_key')),
--       body    := '{}'::jsonb)
--     WHERE EXISTS (
--       SELECT 1 FROM public.orders o
--        WHERE o.delivery_type = 'AlShrouq'
--          AND o.alshrouq_scheduled_at IS NOT NULL
--          AND o.alshrouq_scheduled_at <= now()
--          AND o.alshrouq_historical = false
--          AND NOT EXISTS (
--            SELECT 1 FROM public.alshrouq_dispatches d
--             WHERE d.order_id = o.id AND d.cancelled_at IS NULL));
--     $$);
--
--   -- To revert: SELECT cron.unschedule('alshrouq-dispatch-scheduled');
--
-- The `WHERE EXISTS` guard means the minute-by-minute job costs one cheap index
-- probe and makes no HTTP call at all unless something is actually due.
