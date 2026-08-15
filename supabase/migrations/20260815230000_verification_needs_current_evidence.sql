-- Absence of evidence is not evidence of a walk-in.
--
-- ## The incident
--
-- The backfill at the end of `20260815165443` wrote 3,837 orders in one
-- statement at 2026-08-15 16:54:43.943234+00, clearing `call_center_verified`
-- on 3,836 of them. 3,834 of those orders carry a `verification_changed` row
-- saying a person had set the flag to true; the log contradicts the row.
--
-- The derivation it applied reads `order_activity` rows of type
-- `invoice_verified` / `invoice_value_changed`, and that evidence only began to
-- exist on 2026-08-14 (`20260814140000`). `call_center_verified` has been a
-- checkbox agents ticked by hand since 2026-06-24 (`20260624110459`). Orders
-- raised before the log existed therefore join to nothing, count zero, and were
-- assigned `false` — not because anything established they were walk-ins, but
-- because nothing had established anything at all.
--
-- ## What this changes, and what it does not
--
-- `sync_order_invoice_flags` still fires on `invoice_no` changes and still
-- derives all three columns exactly as it did — when there is something to
-- derive from. The single new condition is the one
-- `record_invoice_verification` has always had and this function was written
-- without: the recompute happens only `WHEN verified_cnt > 0`.
--
-- With nothing verified for the numbers the order names now, all three columns
-- keep what they hold. That is already `invoice_value`'s rule on the line below
-- (and `authoritativeValue`'s on the client); the two flags now follow it. The
-- `UPDATE`'s existing `IS DISTINCT FROM` guard then matches nothing, so no row
-- is written and no event is filed — the function becomes a no-op rather than a
-- silent eraser.
--
-- This restores the invariant `docs/project.md` rule 11 already states: "Clearing
-- needs *current* evidence — the recompute sits inside `IF verified_cnt > 0`, so
-- a pending replacement or an unreachable MIS leaves the flag exactly as it was
-- rather than deriving it from an absence." The rule was kept by the RPC and
-- broken by this trigger and by its one-time backfill.
--
-- A manual tick still survives: with no evidence, `NEW.call_center_verified`
-- already carries whatever this statement set, so preserving the current value
-- preserves the tick.
--
-- ## Scope
--
-- Body copied from the deployed definition (`20260815165443`) with three
-- assignments changed and nothing else. Deliberately *not* based on the file at
-- `20260815210000`, which is present in the repository but has never been
-- applied: rebuilding from it would deploy the `invoice_channel_changed` work
-- along with this fix. No backfill, no repair of the 3,836 affected orders —
-- restoring them is a separate, reviewed step. This migration only stops the
-- bleeding.

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
  -- Did *this* statement raise the flag by hand? Distinguishes a person ticking
  -- the box from the row merely still carrying what the portal set earlier.
  manual_tick     boolean := COALESCE(NEW.call_center_verified, false)
                             AND NOT COALESCE(OLD.call_center_verified, false);
  prev_value      numeric(12,2) := NEW.invoice_value;
  new_value       numeric(12,2);
  uid             uuid := auth.uid();
  synced          boolean := false;
BEGIN
  -- The order's position, rebuilt from what it names *now*. Identical in shape
  -- to the block in `record_invoice_verification`: same zero-stripping as
  -- `invoiceKey` on the client, same latest-statement-per-document rule, so the
  -- two paths cannot disagree about the same documents.
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
      AND a.action IN ('invoice_verified', 'invoice_value_changed')
      AND a.details ? 'total'
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
         string_agg(invoice_no, ', ' ORDER BY invoice_no) FILTER (WHERE is_cc IS TRUE)
    INTO verified_sum, verified_cnt, verified_nos, call_centre_cnt, call_centre_nos
  FROM cur;

  -- Nothing answered for means nothing to derive from, so every column keeps
  -- what it holds. This is the whole fix: `verified_cnt = 0` used to be read as
  -- "checked, and not a call-centre order", which for any order predating the
  -- activity log is a conclusion drawn from silence.
  --
  -- ANY, not ALL: one Call Centre document among several still makes this a
  -- call-centre order. The ALL rule governs auto-completion, not the flag.
  --
  -- `OR manual_tick` keeps the one thing the derivation cannot know about. The
  -- order form still offers the box to `verify_*` holders, for a document raised
  -- outside the call centre that operationally belongs to it; without this,
  -- ticking it and correcting the invoice number in the same save would discard
  -- the tick before anyone saw it. It only survives the statement that made it —
  -- the next reconciliation derives the flag as it always has. With no evidence
  -- the current value is kept, which preserves that tick too.
  new_flag     := CASE WHEN verified_cnt > 0 THEN (call_centre_cnt > 0) OR manual_tick
                       ELSE COALESCE(NEW.call_center_verified, false) END;
  -- Has the MIS answered for anything the order names now? This is what
  -- separates "not checked yet" from "checked, and it is a walk-in" — and it may
  -- only ever be *raised* here, never lowered by an absence.
  new_verified := CASE WHEN verified_cnt > 0 THEN true
                       ELSE NEW.invoices_verified END;
  -- Nothing verified means no authoritative figure, so whatever was typed
  -- stands — the same rule as `authoritativeValue` on the client. Unchanged;
  -- the two lines above now match it.
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

  -- The same events the RPC writes, so the timeline does not depend on which
  -- path did the reconciling. Only when the row actually changed, which is
  -- where idempotence comes from.
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
  'Re-derives invoices_verified, call_center_verified and invoice_value from the order''s current invoice numbers whenever invoice_no changes, by the same rules as record_invoice_verification — and only when those numbers have actually been answered for. With no current evidence the columns keep what they hold, so an order verified before the activity log existed is never cleared by its own absence.';

COMMIT;
