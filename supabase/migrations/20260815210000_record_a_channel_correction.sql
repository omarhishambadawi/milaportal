-- A document's *channel* can change, and the log has to be told.
--
-- ## The bug, and why 20260815190000 could not fix it
--
-- CC-8744 carries a Call Centre invoice. The order page says so — it reads the
-- live Shams answer — and ticks the box. The Orders list still shows the
-- warning, and a hard refresh does not clear it, because the row genuinely says
-- `invoices_verified = true, call_center_verified = false`.
--
-- The previous migration made the flag follow the order's current invoices, and
-- it does: its backfill reported `still_stale = 0`. That is the tell. The row
-- and the derivation **agree**. They are wrong together, because both read the
-- same evidence — `order_activity.details->>'is_call_centre'` — and that
-- evidence is stale.
--
-- Once an invoice has an `invoice_verified` row, the only other thing that has
-- ever been written for it is `invoice_value_changed`, gated on the **total**:
--
--   IF NOT had_row THEN            -- first sighting
--   ELSIF prev_total IS DISTINCT FROM new_total THEN   -- re-priced
--   END IF;                        -- and nothing else
--
-- The lookup feeding that branch selects `prev_total` alone; it never reads the
-- channel the log holds, and no branch exists for the channel having changed. So
-- a document first recorded as a walk-in stays a walk-in for ever unless its
-- price moves — however many times Shams is asked and answers "Call Centre".
--
-- Two ordinary things put an order in that state:
--
--   * it was verified **before** `be824e2`, when the portal read the wrong
--     customer field (`Customer` rather than `Customer_Name`) and so recorded
--     `is_call_centre: false` for documents that always were Call Centre;
--   * the MIS corrected the customer on a number already recorded.
--
-- `docs/project.md` rule 11 already claims the second case works — "have the MIS
-- correct the channel on the same number, and the flag clears itself". It could
-- not. Nothing re-recorded the channel, so every reader downstream — the flag,
-- the auto-completion rule, the Orders list — was deciding from the first answer
-- ever received about that document.
--
-- ## What this adds
--
-- `invoice_channel_changed`, the channel's equivalent of the re-pricing event
-- this function already writes, and built the same way: the log keeps one row
-- per statement about a document, and the derivation reads the latest.
--
-- No new business logic and no new source of truth. The channel still comes from
-- the MIS's own classification, carried by the client exactly as before; what
-- changes is that a *correction* is now recordable rather than silently dropped.
--
-- No backfill. What a document's channel is today is a question only Shams can
-- answer, and inventing an answer for 4,458 orders would be exactly the kind of
-- guess this codebase refuses elsewhere. Orders repair themselves the next time
-- their page is opened: the client already asks for a reconciliation whenever the
-- stored flag disagrees with the live lookup (`needsValueSync`), which for these
-- orders is every single time — that call has been arriving all along and being
-- discarded here.

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
  new_is_cc       boolean;
  prev_total      numeric;
  prev_is_cc      boolean;
  had_row         boolean;
  recorded        int := 0;
  revalued        int := 0;
  rechannelled    int := 0;
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
    new_is_cc := (entry->>'is_call_centre')::boolean;

    -- What this document was last known to be — worth *and* channel, from
    -- whichever statement said so most recently. The channel half is the fix:
    -- it used to select the total alone, so a changed channel had nothing to be
    -- compared against and could not be noticed.
    SELECT (a.details->>'total')::numeric,
           (a.details->>'is_call_centre')::boolean
      INTO prev_total, prev_is_cc
    FROM public.order_activity a
    WHERE a.order_id = _order_id
      AND a.action IN ('invoice_verified', 'invoice_value_changed', 'invoice_channel_changed')
      AND a.details->>'invoice_key' = key
      AND a.details ? 'total'
    -- A correction is always later than the sighting it corrects, and ties on
    -- `created_at` (transaction time) fall to a random uuid without this.
    ORDER BY a.created_at DESC, (a.action <> 'invoice_verified') DESC, a.id DESC
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
          'is_call_centre',new_is_cc,
          'doc_date',      entry->>'doc_date',
          'automated',     true,
          'source',        'MilaPortal / Shams MIS'
        ))
      );
      recorded := recorded + 1;

    ELSIF prev_total IS DISTINCT FROM new_total THEN
      -- Re-priced. Carries the channel too, so one statement describes the
      -- document completely and a later reader needs only the latest row.
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
          'is_call_centre',new_is_cc,
          'doc_date',      entry->>'doc_date',
          'automated',     true,
          'source',        'MilaPortal / Shams MIS'
        ))
      );
      revalued := revalued + 1;

    ELSIF prev_is_cc IS DISTINCT FROM new_is_cc THEN
      -- Same money, different channel. The case that had no event at all, and
      -- therefore no way to reach any of the readers downstream of this log.
      -- `total` is repeated so this row can be the latest statement about the
      -- document without losing what it is worth.
      INSERT INTO public.order_activity(order_id, actor_id, action, details)
      VALUES (
        _order_id, uid, 'invoice_channel_changed',
        jsonb_strip_nulls(jsonb_build_object(
          'invoice_no',    btrim(entry->>'invoice_no'),
          'invoice_key',   key,
          'branch_code',   entry->>'branch_code',
          'from',          prev_is_cc,
          'to',            new_is_cc,
          'total',         new_total,
          'customer',      entry->>'customer',
          'is_call_centre',new_is_cc,
          'doc_date',      entry->>'doc_date',
          'automated',     true,
          'source',        'MilaPortal / Shams MIS'
        ))
      );
      rechannelled := rechannelled + 1;
    END IF;
  END LOOP;

  -- The order's position, rebuilt from scratch every time: what it names now,
  -- crossed with the most recent total and channel per document.
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
      AND a.action IN ('invoice_verified', 'invoice_value_changed', 'invoice_channel_changed')
      AND a.details ? 'total'
    ORDER BY a.details->>'invoice_key',
             a.created_at DESC,
             (a.action <> 'invoice_verified') DESC,
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

  --   current_cnt > 0                 the order actually has an invoice
  --   verified_cnt = current_cnt      all of them answered for by the MIS
  --   call_centre_cnt = verified_cnt  and all of those raised through the
  --                                   call centre
  should_complete := current_cnt > 0
    AND verified_cnt = current_cnt
    AND call_centre_cnt = verified_cnt
    AND prev_status NOT IN ('Cancelled', 'Completed');

  IF verified_cnt > 0 THEN
    PERFORM set_config('milaserv.invoice_sync', 'on', true);

    UPDATE public.orders
       SET invoice_value = verified_sum,
           -- Derived, not latched.
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
    'rechannelled', rechannelled,
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

-- The invoice-number trigger reads the same log and has to see the same
-- statements. Identical body to 20260815190000 apart from the action filter and
-- the matching tie-break.
CREATE OR REPLACE FUNCTION public.sync_order_invoice_flags()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  verified_sum    numeric(12,2);
  verified_cnt    int;
  call_centre_cnt int;
  verified_nos    text;
  call_centre_nos text;
  new_flag        boolean;
  new_verified    boolean;
  prev_flag       boolean := COALESCE(NEW.call_center_verified, false);
  manual_tick     boolean := COALESCE(NEW.call_center_verified, false)
                             AND NOT COALESCE(OLD.call_center_verified, false);
  prev_value      numeric(12,2) := NEW.invoice_value;
  new_value       numeric(12,2);
  uid             uuid := auth.uid();
  synced          boolean := false;
BEGIN
  WITH current_keys AS (
    SELECT DISTINCT
      CASE
        WHEN ltrim(btrim(part), '0') = '' THEN '0'
        ELSE ltrim(btrim(part), '0')
      END AS key
    FROM regexp_split_to_table(COALESCE(NEW.invoice_no, ''), '[,\n]+') AS part
    WHERE btrim(part) <> ''
  ),
  latest AS (
    SELECT DISTINCT ON (a.details->>'invoice_key')
           a.details->>'invoice_key'               AS key,
           (a.details->>'total')::numeric          AS total,
           (a.details->>'is_call_centre')::boolean AS is_cc,
           a.details->>'invoice_no'                AS invoice_no
    FROM public.order_activity a
    WHERE a.order_id = NEW.id
      AND a.action IN ('invoice_verified', 'invoice_value_changed', 'invoice_channel_changed')
      AND a.details ? 'total'
    ORDER BY a.details->>'invoice_key',
             a.created_at DESC,
             (a.action <> 'invoice_verified') DESC,
             a.id DESC
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

  new_flag     := (call_centre_cnt > 0) OR manual_tick;
  new_verified := (verified_cnt > 0);
  new_value    := CASE WHEN verified_cnt > 0 THEN verified_sum ELSE NEW.invoice_value END;

  PERFORM set_config('milaserv.invoice_sync', 'on', true);

  UPDATE public.orders
     SET call_center_verified = new_flag,
         invoices_verified    = new_verified,
         invoice_value        = new_value
   WHERE id = NEW.id
     AND (
       call_center_verified IS DISTINCT FROM new_flag
       OR invoices_verified IS DISTINCT FROM new_verified
       OR invoice_value IS DISTINCT FROM new_value
     );
  synced := FOUND;

  PERFORM set_config('milaserv.invoice_sync', 'off', true);

  IF synced THEN
    IF prev_value IS DISTINCT FROM new_value THEN
      INSERT INTO public.order_activity(order_id, actor_id, action, details)
      VALUES (NEW.id, uid, 'value_synced',
        jsonb_strip_nulls(jsonb_build_object(
          'from',          prev_value,
          'to',            new_value,
          'invoice_no',    verified_nos,
          'invoice_count', verified_cnt,
          'automated',     true,
          'source',        'MilaPortal / invoice number changed'
        )));
    END IF;

    IF new_flag AND NOT prev_flag THEN
      INSERT INTO public.order_activity(order_id, actor_id, action, details)
      VALUES (NEW.id, uid, 'call_center_flagged',
        jsonb_strip_nulls(jsonb_build_object(
          'invoice_no',    call_centre_nos,
          'invoice_count', call_centre_cnt,
          'automated',     true,
          'source',        'MilaPortal / invoice number changed'
        )));
    ELSIF NOT new_flag AND prev_flag THEN
      INSERT INTO public.order_activity(order_id, actor_id, action, details)
      VALUES (NEW.id, uid, 'call_center_cleared',
        jsonb_strip_nulls(jsonb_build_object(
          'invoice_no',    verified_nos,
          'invoice_count', verified_cnt,
          'automated',     true,
          'source',        'MilaPortal / invoice number changed'
        )));
    END IF;
  END IF;

  RETURN NULL;
END;
$$;

COMMIT;
