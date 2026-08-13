-- record_invoice_verification — the portal's automatic invoice verification.
--
-- ## Why this function exists at all
--
-- The Orders panel resolves an order's invoice numbers against Shams and, when
-- the MIS returns a document, three things follow: the timeline gains an event,
-- the order's value becomes the verified total, and the Call Center invoice flag
-- is set. None of that can be done from the client as it stands.
--
--   * `order_activity` has **no INSERT policy**. 20260624110517 dropped the
--     permissive one deliberately, so the table is written only by the
--     SECURITY DEFINER trigger `log_order_activity`. A client insert is refused
--     by RLS, and adding a policy that let browsers write arbitrary history
--     would be a strictly worse answer than one function that writes the one
--     row it is for.
--   * The three writes have to agree. Split across round trips they can half-
--     apply — an order whose value moved with no event saying why, or an event
--     for a value that was never written.
--   * Idempotency belongs next to the data. "Do not record the same invoice
--     twice" is a statement about rows, and two agents with the same order open,
--     or one agent refreshing, must not be able to double-count a total.
--
-- ## What it does not do
--
-- It does not decide anything. The caller has already asked Shams and been given
-- a document; this records that fact. An invoice that is merely *typed*, or one
-- whose lookup failed or came back empty, never reaches here — which is what
-- keeps `call_center_verified` meaning "the call centre's invoice was verified"
-- rather than "somebody opened the order".
--
-- It also never *unsets* anything. A later MIS outage cannot un-verify an order,
-- and an invoice that has appeared cannot un-appear.

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
  uid           uuid := auth.uid();
  entry         jsonb;
  key           text;
  recorded      int := 0;
  verified_sum  numeric(12,2);
  verified_cnt  int;
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

  -- Only when something would actually change: `log_order_activity` writes an
  -- `edited` row for any invoice_value change and a `verification_changed` row
  -- for the flag, and a no-op call must not manufacture either.
  IF recorded > 0 THEN
    UPDATE public.orders
       SET invoice_value = CASE WHEN verified_cnt > 0 THEN verified_sum ELSE invoice_value END,
           -- Set, never cleared. The flag records that verification happened.
           call_center_verified = true
     WHERE id = _order_id
       AND (
         call_center_verified IS DISTINCT FROM true
         OR (verified_cnt > 0 AND invoice_value IS DISTINCT FROM verified_sum)
       );
  END IF;

  RETURN jsonb_build_object(
    'recorded', recorded,
    'verified_count', verified_cnt,
    'verified_total', verified_sum
  );
END;
$$;

REVOKE ALL ON FUNCTION public.record_invoice_verification(uuid, jsonb) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.record_invoice_verification(uuid, jsonb) TO authenticated, service_role;

COMMIT;
