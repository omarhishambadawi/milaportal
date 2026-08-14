-- The Call Centre flag follows the order's current invoices, both ways.
--
-- ## The bug
--
--   1. Order raised, invoice `0169580` verified — a Call Centre document.
--      `call_center_verified` becomes true. Correct.
--   2. The agent finds the number was wrong and replaces it with `0177777`,
--      a walk-in document. The value reconciles to the new total, correctly.
--   3. The flag stays **true**, describing a document the order no longer has.
--
-- Reproduced against the deployed function before this change: after step 2 the
-- reconciliation returned `call_centre_count = 0` and `verified_count = 1`, and
-- the order still read `call_center_verified = t`.
--
-- ## Why it could not clear
--
-- `call_center_verified = CASE WHEN call_centre_cnt > 0 THEN true ELSE
-- call_center_verified END` — set-only, by an explicit earlier decision that a
-- later MIS outage must not be able to un-verify an order. The `WHERE` guard
-- agreed with it (`call_centre_cnt > 0 AND ... IS DISTINCT FROM true`), so an
-- order needing the flag *cleared* was never even written to; and the client's
-- `needsValueSync` only asked for a sync when the flag needed setting, so the
-- server was not called either. Three set-only paths, one stale flag.
--
-- ## What replaces it
--
-- `call_center_verified = (call_centre_cnt > 0)` — derived from the same
-- current-invoice set the total is derived from, so the two can never disagree
-- about the same documents.
--
-- The outage concern that motivated set-only is still handled, by the enclosing
-- `IF verified_cnt > 0`: the counts are taken from the activity log crossed with
-- the order's current numbers, so an unreachable MIS contributes nothing new and
-- the log still holds the last answer. Nothing is recomputed from an absence.
-- A pending replacement invoice likewise leaves the flag alone until the MIS
-- answers for it, so the state does not flap while a document is in flight.
--
-- Clearing gets its own event, `call_center_cleared`, rather than reusing
-- `verification_changed`: the timeline should distinguish the portal withdrawing
-- a verification from a person unticking a box.

BEGIN;

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
  cleared         boolean := false;
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
    ORDER BY a.created_at DESC, (a.action = 'invoice_value_changed') DESC, a.id DESC
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
    -- `created_at` defaults to `now()`, which is *transaction* time, so two
    -- events written in one transaction tie and the tie-break falls to a random
    -- uuid. A correction is always later than the first sighting it corrects, so
    -- it wins the tie explicitly rather than by luck.
    ORDER BY a.details->>'invoice_key',
             a.created_at DESC,
             (a.action = 'invoice_value_changed') DESC,
             a.id DESC
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
  -- **Every** invoice, not merely one.
  --
  --   current_cnt > 0                 the order actually has an invoice
  --   verified_cnt = current_cnt      all of them answered for by the MIS
  --   call_centre_cnt = verified_cnt  and all of those raised through the
  --                                   call centre
  --
  -- The middle and last clauses together are the whole change: an order with a
  -- call-centre invoice beside a walk-in one used to satisfy `call_centre_cnt >
  -- 0` and complete itself, filing away the one question worth asking about it.
  should_complete := current_cnt > 0
    AND verified_cnt = current_cnt
    AND call_centre_cnt = verified_cnt
    AND prev_status NOT IN ('Cancelled', 'Completed');

  IF verified_cnt > 0 THEN
    PERFORM set_config('milaserv.invoice_sync', 'on', true);

    UPDATE public.orders
       SET invoice_value = verified_sum,
           -- Set, never cleared, and only for an order that actually holds a
           -- call-centre document.
           -- Derived, not latched. `> 0` used to set it and nothing ever
           -- cleared it, so replacing a call-centre invoice with a walk-in one
           -- left the order claiming a verification its own documents no longer
           -- supported.
           call_center_verified = (call_centre_cnt > 0),
           -- The MIS has answered for this order, whatever it answered.
           invoices_verified = true,
           status = CASE WHEN should_complete THEN 'Completed' ELSE status END
     WHERE id = _order_id
       AND (
         invoice_value IS DISTINCT FROM verified_sum
         OR call_center_verified IS DISTINCT FROM (call_centre_cnt > 0)
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
      ELSIF call_centre_cnt = 0 AND prev_flag THEN
        -- The other direction, which had no event because it could not happen.
        -- Named separately from `verification_changed` so history distinguishes
        -- the portal withdrawing a verification from a person unticking a box.
        cleared := true;
        INSERT INTO public.order_activity(order_id, actor_id, action, details)
        VALUES (_order_id, uid, 'call_center_cleared',
          jsonb_strip_nulls(jsonb_build_object(
            'invoice_no',    verified_nos,
            'invoice_count', verified_cnt,
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
            -- Recorded so the timeline can say *why* rather than only *what*,
            -- and so a later reader can tell this was the all-invoices rule.
            'all_call_centre',     true,
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
    'cleared', cleared,
    'completed', completed
  );
END;
$$;

REVOKE ALL ON FUNCTION public.record_invoice_verification(uuid, jsonb) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.record_invoice_verification(uuid, jsonb) TO authenticated, service_role;

COMMIT;
