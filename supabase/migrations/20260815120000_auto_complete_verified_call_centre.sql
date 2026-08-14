-- Automatic completion, and the tri-state the Orders list needs to show why.
--
-- ## What this adds
--
-- An order whose invoices are all verified, whose value has been reconciled to
-- their total, and at least one of which the MIS classifies as Call Centre, is
-- an order with nothing left to do. It is now completed by the portal, in the
-- same statement that reconciles it, rather than waiting for someone to notice
-- and change the dropdown.
--
-- Every one of those conditions is load-bearing, and each answers a way of
-- getting this wrong:
--
--   * **every** invoice verified, not merely one. `verified_cnt = current_cnt`
--     compares what the log knows against what `orders.invoice_no` currently
--     names, so an order with a second invoice still pending is not finished and
--     is not completed.
--   * the value **reconciled**, which is true by construction: the same
--     statement sets `invoice_value = verified_sum`. There is no path where the
--     status moves without the figure agreeing.
--   * at least one **Call Centre** document, read from `is_call_centre` on the
--     activity row — the MIS's own channel, never inferred from a customer name
--     and never from the order-level flag, which a person can set by hand.
--   * the order **not Cancelled**. Cancellation is a manual business decision
--     taken when a pharmacist reports one, and this automation must never undo
--     it. `NOT IN ('Cancelled','Completed')` is also the whole idempotency
--     story: once completed, `should_complete` is false and a re-check writes
--     nothing at all.
--
-- ## `invoices_verified`
--
-- The Orders list needs three states, not two. `call_center_verified = false`
-- currently means both "not checked yet" and "checked, and it is a walk-in
-- invoice", and those want opposite treatments on screen — the first is
-- unremarkable, the second is a warning worth a tinted row. This column
-- separates them: it says the MIS has actually answered for this order, so the
-- list can show a neutral row, a Call Centre tick, or a Non Call Centre
-- warning, and never has to guess which.
--
-- Maintained by the reconciliation itself and backfilled here from the activity
-- log, which has held the truth all along.

BEGIN;

-- ---------------------------------------------------------------------------
-- 1. Has the MIS answered for this order at all?
-- ---------------------------------------------------------------------------

ALTER TABLE public.orders
  ADD COLUMN IF NOT EXISTS invoices_verified boolean NOT NULL DEFAULT false;

COMMENT ON COLUMN public.orders.invoices_verified IS
  'True once Shams has returned at least one of this order''s invoices. Distinct from call_center_verified, which says what that invoice was: together they separate "not checked yet" from "checked, and not a Call Centre invoice".';

-- Backfilled from the log. `orders_prevent_reassignment` raises
-- 'Not authorized' for any connection without a JWT — every migration — so it
-- stands down for this one statement and is restored before the transaction
-- ends, exactly as 20260814160000 does for its own backfill.
ALTER TABLE public.orders DISABLE TRIGGER orders_prevent_reassignment;

UPDATE public.orders o
   SET invoices_verified = true
 WHERE NOT o.invoices_verified
   AND EXISTS (
     SELECT 1 FROM public.order_activity a
     WHERE a.order_id = o.id
       AND a.action IN ('invoice_verified', 'invoice_value_changed')
   );

ALTER TABLE public.orders ENABLE TRIGGER orders_prevent_reassignment;

-- ---------------------------------------------------------------------------
-- 2. The edit trigger yields `status` too, while a verification is running
-- ---------------------------------------------------------------------------
--
-- `status_changed` is the right event for a person changing the dropdown and
-- the wrong one for the portal completing an order: it says neither that this
-- was automated nor why. The automated path writes `auto_completed` instead,
-- naming the invoices and the total behind the decision. Everything outside the
-- RPC leaves the GUC unset and is logged exactly as before — a manual
-- cancellation still produces its own `status_changed` row.

CREATE OR REPLACE FUNCTION public.log_order_activity()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  uid uuid := auth.uid();
  changed jsonb := '{}'::jsonb;
  automated boolean := COALESCE(current_setting('milaserv.invoice_sync', true), 'off') = 'on';
BEGIN
  IF TG_OP = 'INSERT' THEN
    INSERT INTO public.order_activity(order_id, actor_id, action, details)
    VALUES (NEW.id, uid, 'created',
      jsonb_build_object(
        'status', NEW.status,
        'invoice_value', NEW.invoice_value,
        'assigned_to', NEW.agent_id,
        'team', NEW.team
      ));
    RETURN NEW;
  END IF;

  IF TG_OP = 'UPDATE' THEN
    IF NEW.status IS DISTINCT FROM OLD.status AND NOT automated THEN
      INSERT INTO public.order_activity(order_id, actor_id, action, details)
      VALUES (NEW.id, uid, 'status_changed',
        jsonb_build_object('from', OLD.status, 'to', NEW.status));
    END IF;
    IF NEW.call_center_verified IS DISTINCT FROM OLD.call_center_verified AND NOT automated THEN
      INSERT INTO public.order_activity(order_id, actor_id, action, details)
      VALUES (NEW.id, uid, 'verification_changed',
        jsonb_build_object('verified', NEW.call_center_verified));
    END IF;
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
    IF NEW.customer_name IS DISTINCT FROM OLD.customer_name THEN changed := changed || jsonb_build_object('customer_name', NEW.customer_name); END IF;
    IF NEW.customer_phone IS DISTINCT FROM OLD.customer_phone THEN changed := changed || jsonb_build_object('customer_phone', NEW.customer_phone); END IF;
    IF NEW.branch_no IS DISTINCT FROM OLD.branch_no THEN changed := changed || jsonb_build_object('branch_no', NEW.branch_no); END IF;
    IF NEW.delivery_type IS DISTINCT FROM OLD.delivery_type THEN changed := changed || jsonb_build_object('delivery_type', NEW.delivery_type); END IF;
    IF NEW.invoice_no IS DISTINCT FROM OLD.invoice_no THEN changed := changed || jsonb_build_object('invoice_no', NEW.invoice_no); END IF;
    IF NEW.invoice_value IS DISTINCT FROM OLD.invoice_value AND NOT automated THEN
      changed := changed || jsonb_build_object('invoice_value', NEW.invoice_value);
    END IF;
    IF NEW.order_type IS DISTINCT FROM OLD.order_type THEN changed := changed || jsonb_build_object('order_type', NEW.order_type); END IF;
    IF NEW.notes IS DISTINCT FROM OLD.notes THEN changed := changed || jsonb_build_object('notes', NEW.notes); END IF;
    IF NEW.order_date IS DISTINCT FROM OLD.order_date THEN changed := changed || jsonb_build_object('order_date', NEW.order_date); END IF;
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
-- 3. Reconcile, then complete
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
  new_total       numeric;
  prev_total      numeric;
  had_row         boolean;
  recorded        int := 0;
  revalued        int := 0;
  verified_sum    numeric(12,2);
  verified_cnt    int;
  current_cnt     int;
  call_centre_cnt int;
  call_centre_nos text;
  verified_nos    text;
  prev_value      numeric(12,2);
  prev_flag       boolean;
  prev_status     text;
  should_complete boolean := false;
  synced          boolean := false;
  flagged         boolean := false;
  completed       boolean := false;
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
  --
  -- Deliberately unchanged by the completion rule below. Completing an order is
  -- part of reconciling it, not a separate act needing a separate permission,
  -- so nobody who could already reconcile an order is refused here and no new
  -- dependency on being its assignee is introduced.
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

  prev_value  := ord.invoice_value;
  prev_flag   := COALESCE(ord.call_center_verified, false);
  prev_status := ord.status;

  FOR entry IN SELECT * FROM jsonb_array_elements(_entries) LOOP
    CONTINUE WHEN COALESCE(btrim(entry->>'invoice_no'), '') = '';

    -- Identity is the number with leading zeros stripped, matching
    -- `stripLeadingZeros` on the client and `documentKey` in sales.server.
    key := ltrim(btrim(entry->>'invoice_no'), '0');
    IF key = '' THEN key := '0'; END IF;

    new_total := (entry->>'total')::numeric;

    -- What this document was last known to be worth, whichever event said so.
    SELECT (a.details->>'total')::numeric INTO prev_total
    FROM public.order_activity a
    WHERE a.order_id = _order_id
      AND a.action IN ('invoice_verified', 'invoice_value_changed')
      AND a.details->>'invoice_key' = key
      AND a.details ? 'total'
    ORDER BY a.created_at DESC, a.id DESC
    LIMIT 1;
    had_row := FOUND;

    IF NOT had_row THEN
      INSERT INTO public.order_activity(order_id, actor_id, action, details)
      VALUES (
        _order_id, uid, 'invoice_verified',
        jsonb_strip_nulls(jsonb_build_object(
          'invoice_no',    btrim(entry->>'invoice_no'),
          'invoice_key',   key,
          'branch_code',   entry->>'branch_code',
          'total',         new_total,
          'customer',      entry->>'customer',
          'is_call_centre',(entry->>'is_call_centre')::boolean,
          'doc_date',      entry->>'doc_date',
          'automated',     true,
          'source',        'MilaPortal / Shams MIS'
        ))
      );
      recorded := recorded + 1;

    ELSIF prev_total IS DISTINCT FROM new_total THEN
      INSERT INTO public.order_activity(order_id, actor_id, action, details)
      VALUES (
        _order_id, uid, 'invoice_value_changed',
        jsonb_strip_nulls(jsonb_build_object(
          'invoice_no',    btrim(entry->>'invoice_no'),
          'invoice_key',   key,
          'branch_code',   entry->>'branch_code',
          'from',          prev_total,
          'to',            new_total,
          'total',         new_total,
          'customer',      entry->>'customer',
          'is_call_centre',(entry->>'is_call_centre')::boolean,
          'doc_date',      entry->>'doc_date',
          'automated',     true,
          'source',        'MilaPortal / Shams MIS'
        ))
      );
      revalued := revalued + 1;
    END IF;
  END LOOP;

  -- The order's position, rebuilt from scratch every time: what it names now,
  -- crossed with the most recent total and channel per document. `current_cnt`
  -- is what makes partial verification detectable — it counts the numbers on
  -- the order, whether or not the MIS has answered for them.
  WITH current_keys AS (
    SELECT DISTINCT
      CASE
        WHEN ltrim(btrim(part), '0') = '' THEN '0'
        ELSE ltrim(btrim(part), '0')
      END AS key
    FROM regexp_split_to_table(COALESCE(ord.invoice_no, ''), '[,\n]+') AS part
    WHERE btrim(part) <> ''
  ),
  latest AS (
    SELECT DISTINCT ON (a.details->>'invoice_key')
           a.details->>'invoice_key'               AS key,
           (a.details->>'total')::numeric          AS total,
           (a.details->>'is_call_centre')::boolean AS is_cc,
           a.details->>'invoice_no'                AS invoice_no
    FROM public.order_activity a
    WHERE a.order_id = _order_id
      AND a.action IN ('invoice_verified', 'invoice_value_changed')
      AND a.details ? 'total'
    ORDER BY a.details->>'invoice_key', a.created_at DESC, a.id DESC
  ),
  cur AS (
    SELECT l.* FROM latest l JOIN current_keys c ON c.key = l.key
  )
  SELECT COALESCE(SUM(total), 0),
         COUNT(*),
         string_agg(invoice_no, ', ' ORDER BY invoice_no),
         COUNT(*) FILTER (WHERE is_cc IS TRUE),
         string_agg(invoice_no, ', ' ORDER BY invoice_no) FILTER (WHERE is_cc IS TRUE),
         (SELECT COUNT(*) FROM current_keys)
    INTO verified_sum, verified_cnt, verified_nos, call_centre_cnt, call_centre_nos, current_cnt
  FROM cur;

  -- Is there anything left to do on this order?
  --
  -- `verified_cnt = current_cnt` is the partial-verification guard: every number
  -- the order names has been answered for, not just the first. The status test
  -- is both the Cancelled protection and the idempotency guard.
  should_complete := current_cnt > 0
    AND verified_cnt = current_cnt
    AND call_centre_cnt > 0
    AND prev_status NOT IN ('Cancelled', 'Completed');

  IF verified_cnt > 0 THEN
    PERFORM set_config('milaserv.invoice_sync', 'on', true);

    UPDATE public.orders
       SET invoice_value = verified_sum,
           -- Set, never cleared, and only for an order that actually holds a
           -- call-centre document.
           call_center_verified = CASE
             WHEN call_centre_cnt > 0 THEN true
             ELSE call_center_verified
           END,
           -- The MIS has answered for this order, whatever it answered.
           invoices_verified = true,
           status = CASE WHEN should_complete THEN 'Completed' ELSE status END
     WHERE id = _order_id
       AND (
         invoice_value IS DISTINCT FROM verified_sum
         OR (call_centre_cnt > 0 AND call_center_verified IS DISTINCT FROM true)
         OR invoices_verified IS DISTINCT FROM true
         OR should_complete
       );
    synced := FOUND;

    PERFORM set_config('milaserv.invoice_sync', 'off', true);

    IF synced THEN
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

      -- "Order automatically completed by MilaPortal", carrying the decision:
      -- the status it moved from, the total it reconciled to, and — named
      -- separately from the full list — the call-centre invoice that qualified
      -- it. Written only inside `synced` and only when `should_complete`, both
      -- of which are false on a re-check of an order already completed.
      IF should_complete THEN
        completed := true;
        INSERT INTO public.order_activity(order_id, actor_id, action, details)
        VALUES (_order_id, uid, 'auto_completed',
          jsonb_strip_nulls(jsonb_build_object(
            'from',                prev_status,
            'to',                  'Completed',
            'invoice_no',          verified_nos,
            'call_centre_invoice', call_centre_nos,
            'invoice_count',       verified_cnt,
            'total',               verified_sum,
            'automated',           true,
            'source',              'MilaPortal / Shams MIS'
          )));
      END IF;
    END IF;
  END IF;

  RETURN jsonb_build_object(
    'recorded', recorded,
    'revalued', revalued,
    'verified_count', verified_cnt,
    'invoice_count', current_cnt,
    'verified_total', verified_sum,
    'call_centre_count', call_centre_cnt,
    'synced', synced,
    'flagged', flagged,
    'completed', completed
  );
END;
$$;

REVOKE ALL ON FUNCTION public.record_invoice_verification(uuid, jsonb) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.record_invoice_verification(uuid, jsonb) TO authenticated, service_role;

COMMIT;
