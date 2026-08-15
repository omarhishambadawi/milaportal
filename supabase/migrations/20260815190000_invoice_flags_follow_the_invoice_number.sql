-- The Orders list's Call Centre state follows the order's invoice number.
--
-- ## The bug
--
--   1. Order raised with invoice `A`, a walk-in document. It verifies:
--      `invoices_verified = true`, `call_center_verified = false`. The Orders
--      list shows the warning triangle. Correct.
--   2. The agent replaces `A` with `B`, a Call Centre document, and saves.
--   3. The order page derives the channel from the live Shams answer, so it
--      shows Call Centre and ticks the box on screen. The **list** still shows
--      the warning, because the columns it reads still describe `A`.
--
-- ## Why it could not correct itself
--
-- `orders.call_center_verified`, `invoices_verified` and `invoice_value` are
-- derived columns, and until now exactly one thing derived them:
-- `record_invoice_verification`, called by the *order page* when Shams answers.
--
-- Nothing derived them when the set of invoices itself changed. On create the
-- client calls the function explicitly after the insert; the edit path is a
-- plain `UPDATE orders SET ... invoice_no = ...` and there is no equivalent, so
-- the columns kept describing documents the order no longer names. The order
-- page repairs it on the *next* open — `needsValueSync` notices the
-- disagreement — but an agent who saves and goes back to the list, which is the
-- ordinary way to work, sees the stale answer and has no way to know it is one.
--
-- ## What this adds
--
-- A trigger that re-derives the three columns whenever `invoice_no` changes,
-- from the same evidence and by the same rules `record_invoice_verification`
-- uses: the numbers the order names **now**, crossed with the latest recorded
-- statement per document in `order_activity`.
--
-- No new business logic. `call_center_verified = (call_centre_cnt > 0)` is the
-- rule from 20260815170000, ANY rather than ALL, so a Call Centre invoice beside
-- a walk-in one still makes this a call-centre order. The value is the sum over
-- the invoices named now, at their latest known totals (rule 10).
--
-- ## Why it may clear a flag that the RPC would have left alone
--
-- `record_invoice_verification` recomputes only inside `IF verified_cnt > 0`,
-- because it is called speculatively whenever the page is open and must not
-- rewrite an order from an MIS that happens to be unreachable.
--
-- This trigger fires only when someone has *deliberately changed the invoice
-- number*, and it reads the local activity log rather than the MIS — so an
-- outage cannot trigger it and cannot influence what it computes. When the new
-- number has never been verified on this order there genuinely is no evidence
-- for it, and `invoices_verified = false` is the honest answer: the list shows
-- "not verified yet" rather than a warning about a document that is gone. The
-- page's own reconciliation then sets it when Shams answers for the new number.
--
-- `invoice_value` keeps the RPC's guard, though: with nothing verified there is
-- no authoritative figure to replace what was typed, which is exactly what
-- `authoritativeValue` does on the client.
--
-- ## Attribution
--
-- The write runs under `milaserv.invoice_sync`, the same transaction-local GUC
-- `record_invoice_verification` uses, so `log_order_activity` stands down and
-- the correction is not filed as "someone ticked the box". It narrates itself
-- with the existing automated events instead — `call_center_flagged`,
-- `call_center_cleared`, `value_synced` — so the timeline reads the same
-- whichever path reconciled the order.
--
-- No permission check: unlike the RPC, which is called directly and is
-- SECURITY DEFINER, this only ever runs *after* an UPDATE that the orders RLS
-- policy has already permitted.

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

  -- ANY, not ALL: one Call Centre document among several still makes this a
  -- call-centre order. The ALL rule governs auto-completion, not the flag.
  --
  -- `OR manual_tick` keeps the one thing the derivation cannot know about. The
  -- order form still offers the box to `verify_*` holders, for a document raised
  -- outside the call centre that operationally belongs to it; without this,
  -- ticking it and correcting the invoice number in the same save would discard
  -- the tick before anyone saw it. It only survives the statement that made it —
  -- the next reconciliation derives the flag as it always has.
  new_flag     := (call_centre_cnt > 0) OR manual_tick;
  -- Has the MIS answered for anything the order names now? This is what
  -- separates "not checked yet" from "checked, and it is a walk-in".
  new_verified := (verified_cnt > 0);
  -- Nothing verified means no authoritative figure, so whatever was typed
  -- stands — the same rule as `authoritativeValue` on the client.
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
  'Re-derives invoices_verified, call_center_verified and invoice_value from the order''s current invoice numbers whenever invoice_no changes, by the same rules as record_invoice_verification. Without it the Orders list keeps describing invoices the order no longer has.';

-- `UPDATE OF invoice_no` plus the WHEN guard: the inner UPDATE above does not
-- touch `invoice_no`, so it cannot re-enter this trigger. Statement-level
-- recursion is impossible rather than merely unlikely.
DROP TRIGGER IF EXISTS trg_sync_order_invoice_flags ON public.orders;
CREATE TRIGGER trg_sync_order_invoice_flags
AFTER UPDATE OF invoice_no ON public.orders
FOR EACH ROW
WHEN (NEW.invoice_no IS DISTINCT FROM OLD.invoice_no)
EXECUTE FUNCTION public.sync_order_invoice_flags();

-- Repair the orders already carrying a stale answer.
--
-- Same derivation, applied once to every order whose columns disagree with the
-- invoices it currently names. `invoice_no` is not written, so the trigger above
-- does not fire; the GUC keeps `log_order_activity` from filing a hundred
-- `verification_changed` rows against nobody. This corrects a record rather than
-- narrating an event, so it writes no activity of its own.
SELECT set_config('milaserv.invoice_sync', 'on', true);

-- Same convention as the earlier backfills (20260814160000, 20260815120000):
-- `prevent_order_reassignment` is written for a signed-in agent and refuses a
-- migration-time UPDATE, so it stands down for this maintenance statement only.
ALTER TABLE public.orders DISABLE TRIGGER orders_prevent_reassignment;

WITH current_keys AS (
  SELECT o.id AS order_id,
         CASE
           WHEN ltrim(btrim(part), '0') = '' THEN '0'
           ELSE ltrim(btrim(part), '0')
         END AS key
  FROM public.orders o,
       regexp_split_to_table(COALESCE(o.invoice_no, ''), '[,\n]+') AS part
  WHERE btrim(part) <> ''
),
latest AS (
  SELECT DISTINCT ON (a.order_id, a.details->>'invoice_key')
         a.order_id,
         a.details->>'invoice_key'               AS key,
         (a.details->>'total')::numeric          AS total,
         (a.details->>'is_call_centre')::boolean AS is_cc
  FROM public.order_activity a
  WHERE a.action IN ('invoice_verified', 'invoice_value_changed')
    AND a.details ? 'total'
  ORDER BY a.order_id,
           a.details->>'invoice_key',
           a.created_at DESC,
           (a.action = 'invoice_value_changed') DESC,
           a.id DESC
),
derived AS (
  SELECT c.order_id,
         COALESCE(SUM(l.total), 0)                    AS verified_sum,
         COUNT(l.key)                                 AS verified_cnt,
         COUNT(l.key) FILTER (WHERE l.is_cc IS TRUE)  AS call_centre_cnt
  FROM current_keys c
  LEFT JOIN latest l ON l.order_id = c.order_id AND l.key = c.key
  GROUP BY c.order_id
)
UPDATE public.orders o
   SET call_center_verified = (d.call_centre_cnt > 0),
       invoices_verified    = (d.verified_cnt > 0),
       invoice_value        = CASE WHEN d.verified_cnt > 0 THEN d.verified_sum
                                   ELSE o.invoice_value END
  FROM derived d
 WHERE o.id = d.order_id
   AND (
     o.call_center_verified IS DISTINCT FROM (d.call_centre_cnt > 0)
     OR o.invoices_verified IS DISTINCT FROM (d.verified_cnt > 0)
     OR (d.verified_cnt > 0 AND o.invoice_value IS DISTINCT FROM d.verified_sum)
   );

ALTER TABLE public.orders ENABLE TRIGGER orders_prevent_reassignment;

SELECT set_config('milaserv.invoice_sync', 'off', true);

COMMIT;
