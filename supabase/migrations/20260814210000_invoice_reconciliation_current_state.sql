-- Reconcile from the order's *current* invoices, not from its whole history.
--
-- ## The bug, as it actually happened
--
-- Order #8724, 2026-08-14, reconstructed from its own timeline:
--
--   18:07  created, invoice `0123891` typed, value entered manually as 1261.40
--   18:35  `0123891` verified — 242.71, Non Call Centre. Value → 242.71. Correct.
--   18:38  agent notices the wrong number and edits it to `0123892`
--   18:38  `0123892` verified — 1261.40, Call Centre.
--          Value → **1504.11**, `invoice_count: 2`, "0123891, 0123892"
--
-- The order names one invoice worth 1261.40 and claims to be worth 1504.11,
-- because the total was computed as `SUM(total)` over every `invoice_verified`
-- row the order had ever accumulated. A corrected invoice number does not
-- retract the row written under the old one, so the superseded document went on
-- contributing for ever. The same shape produces the reported
-- 1200 + 1261.40 = 2461.40: a historical row is not a second invoice.
--
-- The Call Centre flag was computed the same way and inherits the same defect —
-- which is the attribution bug. An order whose only current invoice is Non Call
-- Centre could carry the flag, and a `call_center_flagged` event could name an
-- invoice the order no longer has, next to a panel showing "Non Call Centre".
--
-- ## What replaces it
--
-- Two changes, and the first is the whole fix.
--
-- **Current, not historical.** `orders.invoice_no` is parsed here — the same
-- separators `parseInvoiceNumbers` splits on, the same zero-stripping
-- `invoiceKey` applies — and only invoices whose key is on the order today
-- count towards the total, the flag, or the events. Remove a number and it
-- stops counting; the log keeps the history, which is what a log is for.
--
-- **Latest, not first.** A document whose total the MIS later corrects used to
-- be skipped outright: the idempotency guard saw the key and did nothing, so the
-- order kept the stale figure for ever. Corrections are now recorded as
-- `invoice_value_changed` — carrying `from`, `to` and the invoice number — and
-- the reconciliation reads the *most recent* total per key. `invoice_verified`
-- stays exactly what it was: the one-per-document event saying the MIS first
-- returned it.
--
-- Both totals still come from the log rather than from the caller, so a repeated
-- call cannot inflate anything, and the `WHERE` guard on the UPDATE still means
-- an order already in agreement is not written to at all.

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

    new_total := (entry->>'total')::numeric;

    -- What this document was last known to be worth. `invoice_value_changed`
    -- carries a `total` too, so this is simply the most recent statement about
    -- the key, whichever event made it.
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
      -- First sighting. Exactly the event this has always written, and still
      -- one per document however many times it is checked.
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
          -- Both recorded so the timeline can say *how* this was established.
          -- Nothing else in the log is machine-originated, and an agent reading
          -- history needs to know which entries they are accountable for.
          'automated',     true,
          'source',        'MilaPortal / Shams MIS'
        ))
      );
      recorded := recorded + 1;

    ELSIF prev_total IS DISTINCT FROM new_total THEN
      -- The MIS corrected the document. Recorded rather than skipped — this is
      -- what used to be silently dropped, leaving the order on a stale figure —
      -- and carrying both sides so the timeline can state the correction.
      INSERT INTO public.order_activity(order_id, actor_id, action, details)
      VALUES (
        _order_id, uid, 'invoice_value_changed',
        jsonb_strip_nulls(jsonb_build_object(
          'invoice_no',    btrim(entry->>'invoice_no'),
          'invoice_key',   key,
          'branch_code',   entry->>'branch_code',
          'from',          prev_total,
          'to',            new_total,
          -- Carried so the reconciliation below reads one shape per key.
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
    -- Unchanged total: nothing written, which is what keeps a repeated check
    -- free of events.
  END LOOP;

  -- The order's position, rebuilt from scratch every time.
  --
  -- `current_keys` is what the order names *now*; `latest` is the most recent
  -- total and channel per document. Their intersection is the answer, so a
  -- superseded invoice number contributes nothing and a corrected total
  -- replaces its predecessor instead of adding to it.
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
         string_agg(invoice_no, ', ' ORDER BY invoice_no) FILTER (WHERE is_cc IS TRUE)
    INTO verified_sum, verified_cnt, verified_nos, call_centre_cnt, call_centre_nos
  FROM cur;

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
      -- replaced and the invoices it is now built from. Written only because
      -- the row above actually changed, so processing the same verified total
      -- again produces nothing.
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
      -- Only on the transition, and naming only the call-centre documents the
      -- order actually holds — never a Non Call Centre one, and never one that
      -- has since been replaced.
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
    'revalued', revalued,
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
