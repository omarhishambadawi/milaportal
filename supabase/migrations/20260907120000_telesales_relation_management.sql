-- Telesales CRM: make cross-sell configuration writable, safely.
--
-- ===========================================================================
-- What was already right
-- ===========================================================================
-- `20260905120000` created `telesales_product_relations` with the two
-- constraints that matter and they are kept exactly as they are:
--
--   UNIQUE (from_item_code, to_item_code)   one pair, configured once
--   CHECK  (from_item_code <> to_item_code) a product is not its own companion
--
-- The unique key deliberately ignores `active`, so re-configuring a pair
-- somebody switched off is a *reactivation* rather than a second row. That is
-- the behaviour the management screen relies on: the history of a relationship
-- survives being turned off and on again.
--
-- ===========================================================================
-- The one column being added
-- ===========================================================================
-- `created_by` existed; `updated_by` did not, so "who turned this off" had no
-- answer. Configuration that decides what an agent offers a patient should say
-- who changed it, and the table already carries `updated_at` with nobody
-- attached to it.
--
-- One column, nullable, matching `created_by` exactly -- same type, same
-- reference, same ON DELETE SET NULL, so a departed employee's rows keep their
-- configuration and lose only the name.

ALTER TABLE public.telesales_product_relations
  ADD COLUMN IF NOT EXISTS updated_by uuid REFERENCES auth.users(id) ON DELETE SET NULL;

COMMENT ON COLUMN public.telesales_product_relations.updated_by IS
  'Who last changed this relationship, including switching it on or off. '
  'Paired with updated_at, which existed without an actor.';

-- ===========================================================================
-- Writes
-- ===========================================================================
-- No INSERT/UPDATE/DELETE policy is added, and that is the design rather than
-- an omission. RLS is enabled with a SELECT policy only, so every write through
-- PostgREST is refused for `anon` and `authenticated` alike, and configuration
-- can only change through a server function running as `service_role` that
-- checks `manage_telesales` itself. That is the same shape every other write in
-- this module uses.
--
-- The project's default privileges hand each new table to `anon` with full
-- write grants -- the trap that left four functions callable by anon in
-- `20260903150000` and put write grants on the lifecycle view in
-- `20260906120000`. RLS already refuses those writes, but a DELETE grant to
-- anonymous users on a configuration table is not something an access audit
-- should have to reason about. Take them back.
REVOKE ALL ON public.telesales_product_relations FROM anon;
REVOKE INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER
  ON public.telesales_product_relations FROM authenticated;
GRANT SELECT ON public.telesales_product_relations TO authenticated;

-- Reading configuration is part of reading a recommendation: the agent is shown
-- the relationship's own product name and note as the explanation for why a
-- cross-sell appeared. Unchanged from `20260905120000`, restated here so the
-- final grant state of this table is legible in one migration.
COMMENT ON TABLE public.telesales_product_relations IS
  'Explicitly configured cross-sell pairs, directional: A -> B does not imply '
  'B -> A. Business configuration, never inference -- the co-purchase data was '
  'measured and does not support deriving relationships. Read by anyone with '
  'view_telesales; written only by a server function checking manage_telesales.';
