-- A fourth thing an operator can conclude about a stuck dispatch: that the
-- order was dealt with by hand, outside the automated system.
--
-- ===========================================================================
-- Why a new outcome rather than one of the three that already exist
-- ===========================================================================
-- `20260823120000` gave the operator three answers, and every one of them is a
-- statement about what **AlShrouq** said. The wording in
-- `alshrouq-resolution.ts` is explicit about it:
--
--   delivered      "AlShrouq confirmed the delivery exists and was completed."
--   not_delivered  "AlShrouq confirmed no delivery was created for this order."
--   undetermined   "The outcome could not be established even after checking
--                   with AlShrouq."
--
-- All three presuppose contact with the courier. The 2026-09-10 deliveries
-- 12389, 12422 and 12428 were handled manually by the people who handled them,
-- and the Portal is under a standing instruction not to contact AlShrouq about
-- any of them -- so recording any of those three would be an operator entering
-- a confirmation they were forbidden to obtain.
--
--   * `delivered` would be the worst: it would assert a courier delivery for
--     12389, where no request ever left the machine.
--   * `not_delivered` asserts the courier confirmed nothing was created. Nobody
--     asked them.
--   * `undetermined` asserts the outcome could not be established. It was
--     established -- by a person, operationally, off-system.
--
-- `handled_manually` is the one statement that is true and that requires no
-- external contact to make. It says the Portal's dispatch is finished with; it
-- says nothing whatever about the courier.
--
-- ===========================================================================
-- What this does NOT change
-- ===========================================================================
-- Nothing about the lifecycle. `dispatch_status` keeps saying what the machine
-- observed -- these rows stay `indeterminate` -- and `resolution_outcome` says
-- what a person established afterwards. The two vocabularies stay disjoint, and
-- `handled_manually` is deliberately not a `dispatch_status` value so nothing
-- reading either column can confuse them.
--
-- It also does not free any order's dispatch slot. `cancelled_at` is untouched
-- by resolution, so `alshrouq_dispatches_live_order_key` still holds the order
-- and no second courier request can be created for it. Recording what happened
-- and re-authorising a delivery remain separate decisions.
--
-- No row is modified by this migration. It widens a CHECK and nothing else:
-- resolving the three dispatches is an operator action, performed through the
-- audited flow with their own identity attached, and is not something a
-- migration is entitled to do on their behalf.

ALTER TABLE public.alshrouq_dispatches
  DROP CONSTRAINT IF EXISTS alshrouq_dispatches_resolution_outcome_valid;
ALTER TABLE public.alshrouq_dispatches
  ADD CONSTRAINT alshrouq_dispatches_resolution_outcome_valid
  CHECK (resolution_outcome IS NULL OR resolution_outcome IN (
    'delivered', 'not_delivered', 'undetermined', 'handled_manually'
  ));

COMMENT ON COLUMN public.alshrouq_dispatches.resolution_outcome IS
  'delivered | not_delivered | undetermined | handled_manually. What an operator '
  'established after reviewing a stuck dispatch. NOT a lifecycle value: '
  'dispatch_status keeps saying what the machine observed. handled_manually means '
  'the order was dealt with outside the automated system and is the only outcome '
  'that asserts nothing about the courier -- it is NOT a delivery confirmation.';

-- The widened constraint, read back. A CHECK that silently failed to apply
-- would surface as a confusing insert error at the moment an operator is trying
-- to settle a delivery, which is the worst time to discover it.
DO $$
DECLARE
  def text;
BEGIN
  SELECT pg_get_constraintdef(c.oid) INTO def
    FROM pg_constraint c
    JOIN pg_class t ON t.oid = c.conrelid
    JOIN pg_namespace n ON n.oid = t.relnamespace
   WHERE n.nspname = 'public'
     AND t.relname = 'alshrouq_dispatches'
     AND c.conname = 'alshrouq_dispatches_resolution_outcome_valid';

  IF def IS NULL THEN
    RAISE EXCEPTION 'alshrouq_dispatches_resolution_outcome_valid is missing after this migration';
  END IF;

  IF def NOT LIKE '%handled_manually%' THEN
    RAISE EXCEPTION
      'alshrouq_dispatches_resolution_outcome_valid does not admit handled_manually: %', def;
  END IF;

  -- The three that were already there must still be there. Widening a set is
  -- the intent; narrowing it by accident would orphan resolutions already
  -- recorded against the old values.
  IF def NOT LIKE '%delivered%' OR def NOT LIKE '%not_delivered%'
     OR def NOT LIKE '%undetermined%' THEN
    RAISE EXCEPTION
      'alshrouq_dispatches_resolution_outcome_valid dropped an existing outcome: %', def;
  END IF;
END;
$$;
