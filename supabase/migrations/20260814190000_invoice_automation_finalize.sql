-- Finishing the automatic invoice verification: the flag, and saying what happened.
--
-- Two defects and one gap, all in the same path.
--
-- ## 1. The Call Center flag was set for *any* verified invoice
--
-- `record_invoice_verification` wrote `call_center_verified = true` whenever the
-- order held a verified document, without looking at what the document said. The
-- entries carry `is_call_centre` — derived from `Customer_Name`'s `-Call Centre`
-- suffix, the MIS's own channel label, and already recorded on every
-- `invoice_verified` row — and it was simply not read. So verifying a walk-in
-- invoice ticked the Call Center box, which is the one thing the checkbox is not
-- allowed to mean.
--
-- The flag is now decided by the log: true when at least one *verified*
-- invoice on the order is a Call Centre document. Still only ever **set** — a
-- non-call-centre invoice arriving later cannot untick a box, and neither can an
-- MIS outage.
--
-- ## 2. The automated changes were narrated by the generic edit trigger
--
-- The value moving from 100.00 to 212.60 appeared in the timeline as
-- `Updated invoice_value`, attributed to whoever had the order open, beside a
-- `verification_changed` row that said only "verified: true". Neither says the
-- portal did it, neither names the invoice, and neither carries the previous
-- value.
--
-- `log_order_activity` now stands down for those two fields while a verification
-- is running (`milaserv.invoice_sync`), and the function writes the two events
-- itself: `value_synced` (from, to, the invoice numbers behind it) and
-- `call_center_flagged` (the call-centre invoices that caused it), both marked
-- `automated` with MilaPortal as the source. The transaction-local GUC is scoped
-- to exactly one UPDATE, so an ordinary edit is logged exactly as before.
--
-- Idempotence is inherited rather than added: both events are written only when
-- the UPDATE actually changed the row, and the row is only changed when the
-- order disagrees with its own log. Re-checking the same invoice reconciles
-- nothing and therefore records nothing.

BEGIN;

-- ---------------------------------------------------------------------------
-- 1. The trigger yields the two fields the automated path narrates itself
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
  -- Set only by `record_invoice_verification`, transaction-locally, around the
  -- single UPDATE it performs. Everything else in the system leaves it unset,
  -- and `current_setting(…, true)` returns NULL rather than raising for that.
  automated boolean := COALESCE(current_setting('milaserv.invoice_sync', true), 'off') = 'on';
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
    -- A person ticking the box still produces this row. The automated path
    -- writes `call_center_flagged` instead, which names the invoice that caused
    -- it and does not read as though an agent decided anything.
    IF NEW.call_center_verified IS DISTINCT FROM OLD.call_center_verified AND NOT automated THEN
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
    -- Same reasoning as the flag: an agent correcting the figure is an edit, the
    -- portal reconciling it against Shams is a `value_synced` event that says
    -- where the number came from.
    IF NEW.invoice_value IS DISTINCT FROM OLD.invoice_value AND NOT automated THEN
      changed := changed || jsonb_build_object('invoice_value', NEW.invoice_value);
    END IF;
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
-- 2. The flag follows the document, and the portal says what it did
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
  uid             uuid := auth.uid();
  entry           jsonb;
  key             text;
  recorded        int := 0;
  verified_sum    numeric(12,2);
  verified_cnt    int;
  call_centre_cnt int;
  call_centre_nos text;
  verified_nos    text;
  prev_value      numeric(12,2);
  prev_flag       boolean;
  synced          boolean := false;
  flagged         boolean := false;
  ord             public.orders%ROWTYPE;
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

  -- Read before anything is written, so the event can state what the order was
  -- worth before the portal reconciled it.
  prev_value := ord.invoice_value;
  prev_flag  := COALESCE(ord.call_center_verified, false);

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
  -- One row per document — the guard above is what makes that true — so this is
  -- the sum of the *distinct* verified invoices and nothing is counted twice.
  SELECT COALESCE(SUM((a.details->>'total')::numeric), 0),
         COUNT(*),
         string_agg(a.details->>'invoice_no', ', ' ORDER BY a.created_at)
    INTO verified_sum, verified_cnt, verified_nos
  FROM public.order_activity a
  WHERE a.order_id = _order_id
    AND a.action = 'invoice_verified'
    AND a.details ? 'total';

  -- The Call Center question, answered from the documents rather than from the
  -- fact that a lookup happened. `is_call_centre` is the MIS's own channel
  -- classification, carried onto the row when the invoice was recorded.
  SELECT COUNT(*), string_agg(a.details->>'invoice_no', ', ' ORDER BY a.created_at)
    INTO call_centre_cnt, call_centre_nos
  FROM public.order_activity a
  WHERE a.order_id = _order_id
    AND a.action = 'invoice_verified'
    AND (a.details->>'is_call_centre')::boolean IS TRUE;

  -- Reconciliation, not an event: any order holding a verified invoice is
  -- brought into agreement with it, on whatever call notices. The `WHERE` guard
  -- keeps that cheap and quiet — an order already in agreement is not written
  -- to at all — and is also what makes the two events below idempotent.
  IF verified_cnt > 0 THEN
    PERFORM set_config('milaserv.invoice_sync', 'on', true);

    UPDATE public.orders
       SET invoice_value = verified_sum,
           -- Set, never cleared, and only for an order that actually holds a
           -- call-centre document. A walk-in invoice being verified must leave
           -- the box exactly as it was.
           call_center_verified = CASE
             WHEN call_centre_cnt > 0 THEN true
             ELSE call_center_verified
           END
     WHERE id = _order_id
       AND (
         invoice_value IS DISTINCT FROM verified_sum
         OR (call_centre_cnt > 0 AND call_center_verified IS DISTINCT FROM true)
       );
    synced := FOUND;

    PERFORM set_config('milaserv.invoice_sync', 'off', true);

    IF synced THEN
      -- "Order value updated automatically by MilaPortal", with the figure it
      -- replaced and the invoices it came from. Written only because the row
      -- above actually changed, so processing the same verified total again
      -- produces nothing.
      IF prev_value IS DISTINCT FROM verified_sum THEN
        INSERT INTO public.order_activity(order_id, actor_id, action, details)
        VALUES (_order_id, uid, 'value_synced',
          jsonb_strip_nulls(jsonb_build_object(
            'from',          prev_value,
            'to',            verified_sum,
            'invoice_no',    verified_nos,
            'invoice_count', verified_cnt,
            'automated',     true,
            'source',        'MilaPortal / Shams MIS'
          )));
      END IF;

      -- "…and the order was marked as a Call Center Invoice automatically."
      -- Only on the transition, so an order already flagged — by a person or by
      -- an earlier run — gains nothing on a re-check.
      IF call_centre_cnt > 0 AND NOT prev_flag THEN
        flagged := true;
        INSERT INTO public.order_activity(order_id, actor_id, action, details)
        VALUES (_order_id, uid, 'call_center_flagged',
          jsonb_strip_nulls(jsonb_build_object(
            'invoice_no',    call_centre_nos,
            'invoice_count', call_centre_cnt,
            'automated',     true,
            'source',        'MilaPortal / Shams MIS'
          )));
      END IF;
    END IF;
  END IF;

  RETURN jsonb_build_object(
    'recorded', recorded,
    'verified_count', verified_cnt,
    'verified_total', verified_sum,
    'call_centre_count', call_centre_cnt,
    -- Lets the caller tell "brought into line" from "already agreed", so a
    -- reconciliation that changed nothing need not invalidate any cache.
    'synced', synced,
    'flagged', flagged
  );
END;
$$;

REVOKE ALL ON FUNCTION public.record_invoice_verification(uuid, jsonb) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.record_invoice_verification(uuid, jsonb) TO authenticated, service_role;

COMMIT;
