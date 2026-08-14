-- Order value sync, and separating who created an order from who owns it.
--
-- Three changes, each fixing something the previous migration got wrong or left
-- coupled.
--
-- ## 1. `record_invoice_verification` was a one-shot
--
-- It wrote `orders.invoice_value` only `IF recorded > 0` — that is, only on the
-- single call where an invoice was seen for the first time. The client matched
-- it: `invoicesToRecord` returns the verified invoices the timeline does *not*
-- already hold, so once the activity row existed the order was never looked at
-- again.
--
-- The consequence is the bug this migration exists for. If that one write did
-- not land — the function not yet deployed, a dropped response, a closed tab
-- mid-flight — the activity row and the order's value disagreed **permanently**.
-- Every later page open recomputed "nothing new to record" and asked for
-- nothing, so an order sat showing a verified invoice of SAR 212.60 beside an
-- order value of 0.00, with no way back.
--
-- Verification is now **reconciliation, not an event**: whenever the order has
-- at least one verified invoice in its log, the value and the flag are brought
-- into line with it. The `WHERE` clause still means an order already in
-- agreement is not written to, so a page open costs nothing and the trigger
-- raises no spurious `edited` row — but an order out of agreement is repaired
-- the next time anyone looks at it.
--
-- ## 2. The creator was forced to be the assignee
--
-- `orders` had `agent_id` and nothing else, and the INSERT policy required
-- `auth.uid() = agent_id`. So an Owner or Supervisor taking an order down could
-- only file it under **themselves** — the person who typed it became the agent
-- who owns it, and a supervisor's name appeared in agent workload, team splits
-- and the "My orders" filter.
--
-- `created_by` separates the two. It is not a duplicate of `agent_id`: one
-- records who entered the order and never changes, the other records who owns it
-- and can be reassigned. The INSERT policy now lets a caller who may edit every
-- order name a different agent, while everyone else still files their own work
-- under themselves.
--
-- ## 3. Reassignment left no trace
--
-- `log_order_activity` tracked eight fields and not `agent_id`, so an order
-- moving between agents was invisible in its own history. It is a tracked change
-- now, with both sides recorded. Idempotent by construction: a trigger on
-- `IS DISTINCT FROM` cannot fire for a page render or a repeated load, only for
-- an actual change.

BEGIN;

-- ---------------------------------------------------------------------------
-- 1. created_by
-- ---------------------------------------------------------------------------

ALTER TABLE public.orders
  ADD COLUMN IF NOT EXISTS created_by uuid REFERENCES auth.users(id) ON DELETE SET NULL;

-- The default is what keeps this honest without the client having to send it:
-- the column fills itself with the caller, and the INSERT policy below refuses
-- anything else. Historical rows are backfilled from `agent_id` — before this
-- column existed the two were necessarily the same person.
ALTER TABLE public.orders
  ALTER COLUMN created_by SET DEFAULT auth.uid();

UPDATE public.orders SET created_by = agent_id WHERE created_by IS NULL;

COMMENT ON COLUMN public.orders.created_by IS
  'Who entered the order. Never changes. Distinct from agent_id, which is who owns it and may be reassigned.';

DROP POLICY IF EXISTS "Orders created by permitted active users" ON public.orders;
CREATE POLICY "Orders created by permitted active users"
ON public.orders
FOR INSERT
TO authenticated
WITH CHECK (
  public.is_active(auth.uid())
  AND public.has_permission(auth.uid(), 'create_orders')
  -- Not forgeable: whatever the client sends, this must be the caller. The
  -- column default supplies it, so an insert that omits it still passes.
  AND created_by = auth.uid()
  AND (
    -- The ordinary case: an agent files their own work.
    auth.uid() = agent_id
    -- Or a caller who may edit every order files it under the agent who owns
    -- it. This is the same permission that governs reassignment afterwards, so
    -- assigning at creation grants nothing that could not be done a second
    -- later by editing.
    OR public.has_permission(auth.uid(), 'edit_all_orders')
  )
);

-- ---------------------------------------------------------------------------
-- 2. Assignment is a tracked change
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.log_order_activity()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  uid uuid := auth.uid();
  changed jsonb := '{}'::jsonb;
BEGIN
  IF TG_OP = 'INSERT' THEN
    INSERT INTO public.order_activity(order_id, actor_id, action, details)
    VALUES (NEW.id, uid, 'created',
      jsonb_build_object(
        'status', NEW.status,
        'invoice_value', NEW.invoice_value,
        -- Recorded on the event as well as the row, so history reads correctly
        -- even for an order whose assignment has since moved.
        'assigned_to', NEW.agent_id,
        'team', NEW.team
      ));
    RETURN NEW;
  END IF;

  IF TG_OP = 'UPDATE' THEN
    IF NEW.status IS DISTINCT FROM OLD.status THEN
      INSERT INTO public.order_activity(order_id, actor_id, action, details)
      VALUES (NEW.id, uid, 'status_changed',
        jsonb_build_object('from', OLD.status, 'to', NEW.status));
    END IF;
    IF NEW.call_center_verified IS DISTINCT FROM OLD.call_center_verified THEN
      INSERT INTO public.order_activity(order_id, actor_id, action, details)
      VALUES (NEW.id, uid, 'verification_changed',
        jsonb_build_object('verified', NEW.call_center_verified));
    END IF;
    -- Assignment. `IS DISTINCT FROM` is the whole idempotency story: a page
    -- render, a refetch, or a save that did not touch the agent cannot reach
    -- this branch. Both sides are recorded so the timeline can say "reassigned
    -- from X to Y" rather than only naming the destination.
    IF NEW.agent_id IS DISTINCT FROM OLD.agent_id THEN
      INSERT INTO public.order_activity(order_id, actor_id, action, details)
      VALUES (NEW.id, uid, 'assigned',
        jsonb_strip_nulls(jsonb_build_object(
          'from', OLD.agent_id,
          'to', NEW.agent_id,
          'from_team', OLD.team,
          'to_team', NEW.team
        )));
    END IF;
    -- Field edits. `agent_id` is deliberately absent: it has its own event
    -- above, and listing it here too would report one change twice.
    IF NEW.customer_name IS DISTINCT FROM OLD.customer_name THEN changed := changed || jsonb_build_object('customer_name', NEW.customer_name); END IF;
    IF NEW.customer_phone IS DISTINCT FROM OLD.customer_phone THEN changed := changed || jsonb_build_object('customer_phone', NEW.customer_phone); END IF;
    IF NEW.branch_no IS DISTINCT FROM OLD.branch_no THEN changed := changed || jsonb_build_object('branch_no', NEW.branch_no); END IF;
    IF NEW.delivery_type IS DISTINCT FROM OLD.delivery_type THEN changed := changed || jsonb_build_object('delivery_type', NEW.delivery_type); END IF;
    IF NEW.invoice_no IS DISTINCT FROM OLD.invoice_no THEN changed := changed || jsonb_build_object('invoice_no', NEW.invoice_no); END IF;
    IF NEW.invoice_value IS DISTINCT FROM OLD.invoice_value THEN changed := changed || jsonb_build_object('invoice_value', NEW.invoice_value); END IF;
    IF NEW.order_type IS DISTINCT FROM OLD.order_type THEN changed := changed || jsonb_build_object('order_type', NEW.order_type); END IF;
    IF NEW.notes IS DISTINCT FROM OLD.notes THEN changed := changed || jsonb_build_object('notes', NEW.notes); END IF;
    IF NEW.order_date IS DISTINCT FROM OLD.order_date THEN changed := changed || jsonb_build_object('order_date', NEW.order_date); END IF;
    -- `team` moves with the agent, so a reassignment would otherwise report a
    -- team edit beside it. Only a team change on its own is worth an edit row.
    IF NEW.team IS DISTINCT FROM OLD.team AND NEW.agent_id IS NOT DISTINCT FROM OLD.agent_id THEN
      changed := changed || jsonb_build_object('team', NEW.team);
    END IF;
    IF changed <> '{}'::jsonb THEN
      INSERT INTO public.order_activity(order_id, actor_id, action, details)
      VALUES (NEW.id, uid, 'edited', changed);
    END IF;
    RETURN NEW;
  END IF;

  RETURN NEW;
END;
$$;

REVOKE ALL ON FUNCTION public.log_order_activity() FROM PUBLIC, anon, authenticated;

-- ---------------------------------------------------------------------------
-- 3. Verification reconciles rather than fires once
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.record_invoice_verification(
  _order_id uuid,
  -- [{invoice_no, branch_code, total, customer, is_call_centre, doc_date}]
  _entries  jsonb
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  uid           uuid := auth.uid();
  entry         jsonb;
  key           text;
  recorded      int := 0;
  verified_sum  numeric(12,2);
  verified_cnt  int;
  synced        boolean := false;
  ord           public.orders%ROWTYPE;
BEGIN
  IF uid IS NULL THEN
    RAISE EXCEPTION 'Not authorized';
  END IF;

  SELECT * INTO ord FROM public.orders WHERE id = _order_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Order not found';
  END IF;

  -- The same predicate as the "Orders updated by permitted users" policy. This
  -- function is SECURITY DEFINER, so RLS does not run for it and the check has
  -- to be stated rather than inherited. `view_shams_mis` is required on top:
  -- the values being written are Shams data, and nobody who cannot read Shams
  -- should be able to put a Shams total on an order.
  IF NOT (
    public.is_active(uid)
    AND public.has_permission(uid, 'view_shams_mis')
    AND (
      public.has_permission(uid, 'edit_all_orders')
      OR (uid = ord.agent_id AND public.has_permission(uid, 'edit_orders'))
      OR public.has_permission(uid, 'verify_all_orders')
      OR (uid = ord.agent_id AND public.has_permission(uid, 'verify_own_orders'))
    )
  ) THEN
    RAISE EXCEPTION 'You do not have permission to verify this order';
  END IF;

  IF jsonb_typeof(_entries) <> 'array' THEN
    RAISE EXCEPTION 'Entries must be an array';
  END IF;

  FOR entry IN SELECT * FROM jsonb_array_elements(_entries) LOOP
    CONTINUE WHEN COALESCE(btrim(entry->>'invoice_no'), '') = '';

    -- Identity is the number with leading zeros stripped, matching
    -- `stripLeadingZeros` on the client and `documentKey` in sales.server: the
    -- MIS accepts `022138` and returns `22138`, and both are one document.
    -- All-zeros keeps one zero, as `stripLeadingZeros` does.
    key := ltrim(btrim(entry->>'invoice_no'), '0');
    IF key = '' THEN key := '0'; END IF;

    -- The idempotency guard. A re-render, a refetch, a second agent on the same
    -- order, or a retry after a dropped response all land here and do nothing.
    CONTINUE WHEN EXISTS (
      SELECT 1 FROM public.order_activity a
      WHERE a.order_id = _order_id
        AND a.action = 'invoice_verified'
        AND a.details->>'invoice_key' = key
    );

    INSERT INTO public.order_activity(order_id, actor_id, action, details)
    VALUES (
      _order_id, uid, 'invoice_verified',
      jsonb_strip_nulls(jsonb_build_object(
        'invoice_no',    btrim(entry->>'invoice_no'),
        'invoice_key',   key,
        'branch_code',   entry->>'branch_code',
        'total',         (entry->>'total')::numeric,
        'customer',      entry->>'customer',
        'is_call_centre',(entry->>'is_call_centre')::boolean,
        'doc_date',      entry->>'doc_date',
        -- Both recorded so the timeline can say *how* this was established.
        -- Nothing else in the log is machine-originated, and an agent reading
        -- history needs to know which entries they are accountable for.
        'automated',     true,
        'source',        'MilaPortal / Shams MIS'
      ))
    );
    recorded := recorded + 1;
  END LOOP;

  -- Recomputed from the log rather than accumulated, so the total is a function
  -- of what has actually been verified and a repeated call cannot inflate it.
  SELECT COALESCE(SUM((a.details->>'total')::numeric), 0), COUNT(*)
    INTO verified_sum, verified_cnt
  FROM public.order_activity a
  WHERE a.order_id = _order_id
    AND a.action = 'invoice_verified'
    AND a.details ? 'total';

  -- Reconciliation, not an event. This used to run only `IF recorded > 0`,
  -- which made the whole thing a one-shot: an order whose invoice was logged
  -- but whose value never landed could not be repaired, because the next call
  -- recorded nothing and therefore wrote nothing. Now any order holding a
  -- verified invoice is brought into agreement with it, on whatever call
  -- notices.
  --
  -- The `WHERE` guard is what keeps that cheap and quiet: an order already in
  -- agreement is not written to at all, so no `edited` or
  -- `verification_changed` row is raised for simply looking at it.
  IF verified_cnt > 0 THEN
    UPDATE public.orders
       SET invoice_value = verified_sum,
           -- Set, never cleared. The flag records that verification happened,
           -- so a later MIS outage cannot un-verify an order.
           call_center_verified = true
     WHERE id = _order_id
       AND (
         invoice_value IS DISTINCT FROM verified_sum
         OR call_center_verified IS DISTINCT FROM true
       );
    synced := FOUND;
  END IF;

  RETURN jsonb_build_object(
    'recorded', recorded,
    'verified_count', verified_cnt,
    'verified_total', verified_sum,
    -- Lets the caller tell "brought into line" from "already agreed", so a
    -- reconciliation that changed nothing need not invalidate any cache.
    'synced', synced
  );
END;
$$;

REVOKE ALL ON FUNCTION public.record_invoice_verification(uuid, jsonb) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.record_invoice_verification(uuid, jsonb) TO authenticated, service_role;

COMMIT;
