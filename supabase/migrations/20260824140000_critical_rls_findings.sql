-- Two critical RLS findings from the Lovable security scan.
--
-- Both are cases where a *narrow* policy already existed and a broader one sat
-- beside it, or where a policy checked the wrong thing. Neither table changes
-- shape and no application query is rewritten — the fix is entirely in who the
-- database will answer.

-- ---------------------------------------------------------------------------
-- 1. "All employee satisfaction survey data exposed to every logged-in user"
-- ---------------------------------------------------------------------------
--
-- `satisfaction_surveys` carried two SELECT policies:
--
--   "Surveys visible by scope"     is_active AND (administrator OR
--                                  view_all_agents OR agent_id = auth.uid())
--   "Authenticated can read surveys"   USING (true)
--
-- Permissive policies are OR-ed, so the second made the first decorative: every
-- authenticated user could read every agent's survey results, including agents
-- reading their colleagues'. The scoped policy is the intended model and is
-- already correct, so the fix is to remove the one that overrode it rather than
-- to write anything new.
DROP POLICY IF EXISTS "Authenticated can read surveys" ON public.satisfaction_surveys;

-- ---------------------------------------------------------------------------
-- 2. "Customer delivery details exposed to any authenticated user"
-- ---------------------------------------------------------------------------
--
-- `alshrouq_dispatches` holds the customer's address, coordinates and — inside
-- `payload_snapshot` — their name and phone. Its only SELECT policy was:
--
--   EXISTS (SELECT 1 FROM orders o WHERE o.id = alshrouq_dispatches.order_id)
--
-- which tests that the order *exists*, not that the reader may see it. The
-- subquery is itself RLS-bounded, so in practice it inherited the orders
-- policy — and that policy admits anyone holding `view_orders` OR
-- `view_dashboard` OR `view_reports` OR `view_invoice_analytics`. A user with
-- only `view_dashboard` could therefore read every customer's home address.
--
-- The replacement states the check instead of inheriting it:
--
--   * `is_active` — a deactivated account keeps no access. The old policy had
--     no such condition at all.
--   * `view_orders` — the permission that actually governs handling an order
--     and seeing the customer on it. Dashboard-, reports- and analytics-only
--     holders lose customer delivery data and keep everything they came for.
--     Auditors are unaffected: `view_orders` is already one of their defaults.
--   * the order is still visible — the EXISTS is kept, so the two surfaces
--     cannot disagree about which orders a person may look at.
--
-- The only browser read of this table is the order page's dispatch card
-- (`useOrderAlShrouqDispatch`), which is reached through a route that already
-- requires `view_orders`, so no existing screen loses data. Writes are
-- unaffected: there is no INSERT/UPDATE/DELETE policy, and every write goes
-- through the server function that called the courier.
DROP POLICY IF EXISTS "Dispatch visible with its order" ON public.alshrouq_dispatches;

CREATE POLICY "Dispatch visible with its order"
  ON public.alshrouq_dispatches
  FOR SELECT
  TO authenticated
  USING (
    is_active(auth.uid())
    AND has_permission(auth.uid(), 'view_orders')
    AND EXISTS (
      SELECT 1 FROM public.orders o
       WHERE o.id = alshrouq_dispatches.order_id
    )
  );

-- ---------------------------------------------------------------------------
-- 3. "RLS Disabled in Public" — public.spatial_ref_sys
-- ---------------------------------------------------------------------------
--
-- Deliberately not addressed here, because it cannot be.
--
-- The object is `public.spatial_ref_sys`, PostGIS's standard EPSG catalogue of
-- coordinate reference systems: 8,500 rows of published reference data with no
-- user, customer or business content in it. PostGIS is genuinely in use —
-- `branches.location` is a `geography(Point,4326)` generated column.
--
-- The table is owned by `supabase_admin` and by the `postgis` extension, so
-- `ALTER TABLE ... ENABLE ROW LEVEL SECURITY` raises `insufficient_privilege`
-- for the migration role. This was attempted and confirmed, not assumed.
-- Revoking SELECT from `authenticated` would not clear the finding either —
-- the finding is that RLS is off, which revoking does not change — and would
-- risk the two `SECURITY INVOKER` map functions (`orders_locations`,
-- `complaints_locations`) that call `ST_` helpers as the calling role.
--
-- So this one is resolved by marking it intentionally ignored in the Security
-- view, which is a decision for the project owner rather than a migration.
