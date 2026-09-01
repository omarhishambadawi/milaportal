-- A cancelled AlShrouq dispatch becomes history, not a permanent lock.
--
-- ===========================================================================
-- The reproduction
-- ===========================================================================
--   1. An agent schedules order #9540 for AlShrouq. A row is written with
--      `client_order_id = '9540'`, taken from the order's own display number.
--   2. They notice a mistake and cancel it. `cancelled_at` is set, and the row
--      correctly stops owning the order's dispatch slot -- that is what
--      `alshrouq_dispatches_live_order_key` (UNIQUE (order_id) WHERE
--      cancelled_at IS NULL) is for, and its own comment says so: "a cancelled
--      one no longer counts, so a mistaken dispatch can be cancelled and
--      re-sent".
--   3. They send the same order again. The duplicate check passes, the branch
--      resolves, the payload is built -- with the same `client_order_id`,
--      because it is derived from the order and deliberately never invented --
--      and **AlShrouq books a courier**.
--   4. The insert that records that courier hits
--      `alshrouq_dispatches_client_order_key`, which is
--      `UNIQUE (client_order_id)` with no predicate at all. The cancelled row
--      from step 2 still holds that value and always will.
--
-- A real driver is on the way and the order has no record of it. The Portal
-- reports the second attempt as "already dispatched" and shows a dispatch that
-- does not exist.
--
-- ===========================================================================
-- What the constraint was for, and what it should say
-- ===========================================================================
-- It was added as "the same protection on the identity we hand the CRM" -- the
-- sibling of the per-order index. But the two were written differently: the
-- per-order one is scoped to live rows and this one is not, so it does not
-- express the same rule. It says "one row per client_order_id **ever**", which
-- makes the table incapable of holding the history the per-order index was
-- designed around.
--
-- The intended model, stated once and enforced twice:
--
--     an order may have many dispatch records over its life,
--     but at most one that is not cancelled.
--
-- So this index gets the predicate its sibling already has. Nothing is
-- weakened: while a live dispatch exists, a second row carrying the same
-- identity is still refused -- by *both* indexes, since `client_order_id` is
-- derived one-to-one from the order. Only cancelled history stops blocking.
--
-- `indeterminate`, `failed`, `processing` and `accepted` rows are all
-- uncancelled, so they keep holding the slot exactly as before. This changes
-- nothing about them, and in particular nothing about the rule that an
-- uncertain dispatch is never followed by a second POST.

-- Dropped rather than altered: a partial index is a different index, and
-- `CREATE UNIQUE INDEX ... WHERE` cannot replace a total one in place.
DROP INDEX IF EXISTS public.alshrouq_dispatches_client_order_key;

CREATE UNIQUE INDEX IF NOT EXISTS alshrouq_dispatches_client_order_key
  ON public.alshrouq_dispatches (client_order_id)
  WHERE cancelled_at IS NULL;

COMMENT ON INDEX public.alshrouq_dispatches_client_order_key IS
  'At most one live dispatch per client_order_id. Partial on cancelled_at IS NULL, '
  'the same predicate as alshrouq_dispatches_live_order_key, so a cancelled dispatch '
  'remains as history and the order can be sent again.';

-- ===========================================================================
-- The guard
-- ===========================================================================
-- Both halves of the rule, verified after the fact. The failure was two indexes
-- that were meant to say the same thing and did not, so what is checked is that
-- they now agree -- a total unique index on either column is the defect, and it
-- fails the migration rather than waiting for a courier to go unrecorded.
DO $$
DECLARE
  live_pred text;
  ident_pred text;
BEGIN
  SELECT pg_get_expr(i.indpred, i.indrelid) INTO live_pred
    FROM pg_index i
    JOIN pg_class c ON c.oid = i.indexrelid
    JOIN pg_namespace n ON n.oid = c.relnamespace
   WHERE n.nspname = 'public'
     AND c.relname = 'alshrouq_dispatches_live_order_key'
     AND i.indisunique;

  SELECT pg_get_expr(i.indpred, i.indrelid) INTO ident_pred
    FROM pg_index i
    JOIN pg_class c ON c.oid = i.indexrelid
    JOIN pg_namespace n ON n.oid = c.relnamespace
   WHERE n.nspname = 'public'
     AND c.relname = 'alshrouq_dispatches_client_order_key'
     AND i.indisunique;

  IF live_pred IS NULL OR ident_pred IS NULL THEN
    RAISE EXCEPTION
      'the AlShrouq duplicate-dispatch indexes must both be partial on cancelled_at '
      '(order key: %, identity key: %)',
      coalesce(live_pred, 'no predicate'), coalesce(ident_pred, 'no predicate');
  END IF;

  IF live_pred IS DISTINCT FROM ident_pred THEN
    RAISE EXCEPTION
      'the AlShrouq duplicate-dispatch indexes disagree about what counts as live '
      '(order key: %, identity key: %)',
      live_pred, ident_pred;
  END IF;
END;
$$;
