-- The invoice-number trigger reads channel corrections too.
--
-- ## Why this exists
--
-- Two functions derive the order's flags from `order_activity`, and they must
-- read the same statements or they disagree about the same documents:
--
--   * `record_invoice_verification`, when the order page reconciles;
--   * `sync_order_invoice_flags`, when `invoice_no` changes.
--
-- `20260815210000` added `invoice_channel_changed` — the event that lets a
-- document's *channel* be corrected — and updated both. `20260815230000` then
-- fixed the incident of 2026-08-15 by adding the current-evidence guard, but it
-- was written against the deployed body, which predated the channel work. So the
-- two fixes each held half the answer:
--
--   20260815210000   channel-aware, unguarded
--   20260815230000   guarded, channel-blind
--
-- Applying them in version order leaves the guard in place and the channel
-- filter missing, which is exactly the state that produced the Orders-list
-- inconsistency this migration completes the fix for: the RPC would record a
-- channel correction that the trigger could not see, so changing an invoice
-- number afterwards re-derived the flag from evidence that excluded the
-- correction.
--
-- This is the last word on the function: both halves, and nothing else. Body
-- identical to `20260815210000`'s copy — the same action list and the same
-- correction-wins tie-break — with the `verified_cnt > 0` guard from
-- `20260815230000` kept intact.
--
-- No backfill. Orders repair themselves the next time their page is opened, as
-- `20260815210000` describes: the client asks for a reconciliation whenever the
-- stored flag disagrees with the live lookup, and that call now lands instead of
-- being discarded.

BEGIN;

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

  -- The guard from 20260815230000. Nothing answered for means nothing to derive
  -- from, so every column keeps what it holds.
  new_flag     := CASE WHEN verified_cnt > 0 THEN (call_centre_cnt > 0) OR manual_tick
                       ELSE COALESCE(NEW.call_center_verified, false) END;
  new_verified := CASE WHEN verified_cnt > 0 THEN true
                       ELSE NEW.invoices_verified END;
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

COMMENT ON FUNCTION public.sync_order_invoice_flags() IS
  'Re-derives invoices_verified, call_center_verified and invoice_value from the order''s current invoice numbers whenever invoice_no changes — reading the same statements as record_invoice_verification, channel corrections included, and only when those numbers have actually been answered for.';

COMMIT;
