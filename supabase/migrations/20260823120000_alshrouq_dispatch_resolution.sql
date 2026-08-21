-- Operator resolution for a dispatch nobody can settle automatically.
--
-- ===========================================================================
-- What this is for
-- ===========================================================================
-- Two lifecycle states are terminal and have no automatic way out:
--
--   indeterminate -- the request was transmitted and the outcome is unknown
--   failed        -- AlShrouq refused it
--
-- Both are deliberate. An `indeterminate` dispatch must never be retried by
-- machinery, because the courier may already be moving, and `failed` has no
-- retry policy in this codebase. That leaves a row a person has to settle: they
-- ring AlShrouq, find out what actually happened, and record it.
--
-- These columns are where that answer goes.
--
-- ===========================================================================
-- Why resolution is NOT a `dispatch_status` value
-- ===========================================================================
-- Three different things are being tracked on this table and conflating any two
-- of them would be a mistake that is very hard to unpick later:
--
--   `status`             -- AlShrouq's own word, stored verbatim. Courier truth.
--   `dispatch_status`    -- this system's lifecycle. Machine truth.
--   `resolution_outcome` -- what a human established afterwards. Operator truth.
--
-- So `dispatch_status` is never overwritten by a resolution. A resolved row
-- stays `indeterminate` or `failed` forever, because that *is* what the machine
-- observed, and rewriting it to `accepted` would put an operator's conclusion
-- into the field that records the courier's. The resolution sits beside it.
--
-- ===========================================================================
-- The dispatch slot is deliberately NOT freed
-- ===========================================================================
-- `alshrouq_dispatches_live_order_key` -- UNIQUE (order_id) WHERE cancelled_at
-- IS NULL -- is the one-courier-per-order guarantee, and `blocksNewDispatch`
-- treats every non-cancelled state as owning the slot. Resolution changes
-- neither: it writes no `cancelled_at`, so a resolved row keeps its slot and the
-- order stays unsendable.
--
-- That is the conservative reading on purpose. "Confirmed not delivered" is an
-- operator saying no courier exists, which sounds like it should release the
-- order -- but releasing it is authorising a second courier, and the two
-- decisions deserve to be made separately by a person who can see the
-- consequences of each. Recording what happened and re-authorising a delivery
-- are different acts. A resend workflow, if one is ever wanted, is its own
-- explicit thing.
--
-- ===========================================================================
-- Additive and idempotent
-- ===========================================================================
-- Four nullable columns, two CHECK constraints and one partial index on this
-- table. No data is read, no row is rewritten, and nothing outside
-- `alshrouq_dispatches` is touched -- in particular not `orders`, not the
-- scheduler function, not the cron job and not vault.

ALTER TABLE public.alshrouq_dispatches
  -- What the operator established. Never a lifecycle value.
  ADD COLUMN IF NOT EXISTS resolution_outcome text,
  ADD COLUMN IF NOT EXISTS resolved_at timestamptz,
  -- Written server-side from the verified session, like `cancelled_by`.
  ADD COLUMN IF NOT EXISTS resolved_by uuid REFERENCES auth.users(id),
  -- The operator's own account of how they established it. Free text, capped by
  -- the server function. Never customer contact details -- see docs.
  ADD COLUMN IF NOT EXISTS resolution_note text;

-- The three answers a person can give. Deliberately not 'retry', and
-- deliberately not any `dispatch_status` value, so the two vocabularies cannot
-- be confused by anything reading this column.
ALTER TABLE public.alshrouq_dispatches
  DROP CONSTRAINT IF EXISTS alshrouq_dispatches_resolution_outcome_valid;
ALTER TABLE public.alshrouq_dispatches
  ADD CONSTRAINT alshrouq_dispatches_resolution_outcome_valid
  CHECK (resolution_outcome IS NULL OR resolution_outcome IN (
    'delivered', 'not_delivered', 'undetermined'
  ));

-- A resolution is all three facts or none of them. A row carrying an outcome
-- with no author, or a timestamp with no outcome, is a half-written audit record
-- and there is no reading of it that is safe to trust.
ALTER TABLE public.alshrouq_dispatches
  DROP CONSTRAINT IF EXISTS alshrouq_dispatches_resolution_complete;
ALTER TABLE public.alshrouq_dispatches
  ADD CONSTRAINT alshrouq_dispatches_resolution_complete
  CHECK (
    (resolution_outcome IS NULL AND resolved_at IS NULL AND resolved_by IS NULL)
    OR
    (resolution_outcome IS NOT NULL AND resolved_at IS NOT NULL AND resolved_by IS NOT NULL)
  );

-- The operator's worklist: stuck and not yet settled. Partial, because the
-- overwhelming majority of rows are neither.
CREATE INDEX IF NOT EXISTS alshrouq_dispatches_unresolved_idx
  ON public.alshrouq_dispatches (dispatch_status)
  WHERE dispatch_status IN ('indeterminate', 'failed') AND resolution_outcome IS NULL;

COMMENT ON COLUMN public.alshrouq_dispatches.resolution_outcome IS
  'delivered | not_delivered | undetermined. What an operator established after '
  'reviewing a stuck dispatch. NOT a lifecycle value: dispatch_status keeps '
  'recording what the machine observed, and status keeps the courier''s own word. '
  'Recording a resolution never contacts AlShrouq and never frees the dispatch slot.';
COMMENT ON COLUMN public.alshrouq_dispatches.resolved_by IS
  'The authenticated operator who resolved it, written server-side from the '
  'verified session and never from a client-supplied id.';

-- No grant and no policy change. Writes to this table remain service-role only:
-- its single RLS policy is SELECT, and a command with no permissive policy is
-- denied.
