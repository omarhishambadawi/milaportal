-- The dispatch snapshot: what the courier was actually told.
--
-- ===========================================================================
-- Why the order row cannot answer this
-- ===========================================================================
-- An order is dispatched from one branch and invoiced from another. An agent
-- raises it against P0025, AlShrouq collects from P0025 and delivers it, and
-- then invoice review finds a product short there and processes the sale from
-- P0001 — so `orders.branch_no` legitimately becomes P0001.
--
-- Both facts are true. The order was fulfilled from P0001; the delivery was
-- collected from P0025. Reading the delivery's branch off `orders` after that
-- edit reports the wrong shop for a van that has already been.
--
-- `alshrouq_dispatches` already froze most of what was sent — `branch_no`,
-- `alshrouq_branch_id`, `client_order_id`, `payment_type`, `customer_address`,
-- `customer_lat`/`lng`, `value`, `tracking_url`, `external_order_id`. These are
-- the three that were still being read live from the order, which completes it:
-- after dispatch the row is the whole record of the request, and nothing about
-- the delivery has to be inferred from a row that is free to change.
--
-- Nothing here syncs back. The Portal has no AlShrouq update endpoint — only
-- create, refresh and cancel — so an edit to the order cannot reach the courier
-- whatever it changes.

BEGIN;

ALTER TABLE public.alshrouq_dispatches
  ADD COLUMN IF NOT EXISTS customer_name  text,
  ADD COLUMN IF NOT EXISTS customer_phone text,
  -- The appointment this dispatch was held for, when it was a scheduled one.
  -- Copied at dispatch so a later change to `orders.alshrouq_scheduled_at`
  -- cannot rewrite the history of a delivery already made.
  ADD COLUMN IF NOT EXISTS scheduled_at   timestamptz;

COMMENT ON COLUMN public.alshrouq_dispatches.customer_name IS
  'The name sent to the CRM, frozen at dispatch. Not read from orders afterwards.';
COMMENT ON COLUMN public.alshrouq_dispatches.customer_phone IS
  'The number sent to the CRM, frozen at dispatch.';
COMMENT ON COLUMN public.alshrouq_dispatches.scheduled_at IS
  'The held-until time this dispatch was waiting on, if any. Frozen at dispatch.';

COMMENT ON COLUMN public.alshrouq_dispatches.branch_no IS
  'The Shams branch the delivery was collected from. Deliberately NOT kept in step with orders.branch_no, which may later change to the branch that invoiced the order.';

COMMIT;
