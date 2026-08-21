-- Who called off a scheduled AlShrouq delivery.
--
-- ===========================================================================
-- Why this is worth a column
-- ===========================================================================
-- Cancelling a scheduled delivery is a decision, not a state change: somebody
-- looked at a pending courier handoff and stopped it. Every other consequential
-- act on a dispatch already records its actor -- `dispatched_by` for the send,
-- `scheduled_by` for the approval -- and cancellation was the one that did not,
-- which meant the only irreversible operator action on this table was also the
-- only anonymous one.
--
-- It reuses the pattern those two established: a nullable uuid referencing
-- auth.users, written server-side from the authenticated identity. It is *not*
-- a new audit mechanism, and `admin_activity` is deliberately not involved --
-- that table records administration of the portal itself, and this is one more
-- fact about a dispatch row, on the dispatch row.
--
-- ===========================================================================
-- The value is never supplied by the browser
-- ===========================================================================
-- `alshrouqCancelScheduledDispatch` takes an order id and nothing else. The
-- actor comes from `requireSupabaseAuth`'s verified claims, so a caller cannot
-- attribute a cancellation to somebody else by asking to.
--
-- Additive and idempotent: one nullable column and one index. It reads no data,
-- rewrites no rows, and touches no table but this one. Existing cancellations --
-- there are none in production at the time of writing -- keep a NULL actor,
-- which is the honest record of a cancellation made before anyone was recorded.

ALTER TABLE public.alshrouq_dispatches
  ADD COLUMN IF NOT EXISTS cancelled_by uuid REFERENCES auth.users(id);

COMMENT ON COLUMN public.alshrouq_dispatches.cancelled_by IS
  'The authenticated operator who cancelled a scheduled dispatch. Written '
  'server-side from the verified session, never from a client-supplied id. '
  'NULL for a cancellation made before this column existed.';

-- Answering "what did this person call off" without scanning the table. Partial,
-- because the overwhelming majority of rows were never cancelled.
CREATE INDEX IF NOT EXISTS alshrouq_dispatches_cancelled_by_idx
  ON public.alshrouq_dispatches (cancelled_by)
  WHERE cancelled_by IS NOT NULL;

-- No grant and no policy change. Writes to this table remain service-role only:
-- the single RLS policy on it is SELECT, and a command with no permissive policy
-- is denied. (Note for anyone reading the 20260820180000 comment: `authenticated`
-- does hold default table grants here -- Supabase issues them on every new
-- public table and a later GRANT SELECT does not remove them -- so the policy,
-- not the grant, is what makes this table write-protected.)
