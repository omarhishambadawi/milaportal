-- Sprint E: fixes from the RBAC and security audit.
--
-- Two findings from the audit are deliberately NOT addressed here, because both
-- would change what users see rather than close a hole, and that is a product
-- decision rather than a security one. They are written up in full for whoever
-- makes that call:
--
--   1. Orders and complaints are readable by every user holding `view_orders` /
--      `view_complaints`, with no per-agent scoping. An agent can read every
--      other agent's customer names and phone numbers through the API, the MCP
--      `list_orders` tool, or a direct PostgREST query. 20260707161549 scoped
--      orders to `agent_id = auth.uid()` unless the caller held `view_all_agents`;
--      20260709171928 dropped that two days later and restored the unscoped
--      policy, which is the state today. Everything else in the permission model
--      treats `view_all_agents` as the cross-agent gate, so either the RLS or the
--      model is wrong — but scoping reads would visibly change the Orders list
--      for every agent, so it is left alone pending that decision.
--
--   2. profiles has two SELECT policies: a scoped one (own row, or
--      `manage_users` / `view_all_agents`) and "Authenticated can view agent
--      directory" USING (true). Policies are OR-ed, so the second fully shadows
--      the first and the real control is the column-level SELECT grant, which
--      exposes only (id, full_name, agent_code, active, created_at). That is
--      working as intended — the agent directory needs it — but the scoped
--      policy is inert and reads like a protection that is not one.

-- ---------------------------------------------------------------------------
-- 1. Deactivation now withholds reads, not just writes
-- ---------------------------------------------------------------------------
--
-- `is_active(auth.uid())` gates every INSERT and UPDATE policy on orders and
-- complaints, and the app shows a deactivated user nothing but "Account
-- deactivated. Please contact an administrator." But no SELECT policy ever
-- checked it, and deactivating an account does not invalidate its Supabase
-- session or password. So a deactivated user — someone who has left the company,
-- or whose account was disabled precisely because it was compromised — kept full
-- read access to every order and complaint in the system through the API, for as
-- long as the token lasted and indefinitely by re-authenticating.
--
-- This makes deactivation mean at the data layer what it already means
-- everywhere else. It is the one change in this migration that alters
-- behaviour: a deactivated account's queries now return nothing.
--
-- Owner accounts cannot be deactivated (protect_owner_profile), so this cannot
-- lock the platform's Owner out.

DROP POLICY IF EXISTS "Orders visible by permission" ON public.orders;
CREATE POLICY "Orders visible by permission"
ON public.orders
FOR SELECT
TO authenticated
USING (
  public.is_active(auth.uid())
  AND (
    public.has_permission(auth.uid(), 'view_orders')
    OR public.has_permission(auth.uid(), 'view_dashboard')
    OR public.has_permission(auth.uid(), 'view_reports')
    OR public.has_permission(auth.uid(), 'view_invoice_analytics')
  )
);

DROP POLICY IF EXISTS "Complaints visible by permission" ON public.complaints;
CREATE POLICY "Complaints visible by permission"
ON public.complaints
FOR SELECT
TO authenticated
USING (
  public.is_active(auth.uid())
  AND (
    public.has_permission(auth.uid(), 'view_complaints')
    OR public.has_permission(auth.uid(), 'view_dashboard')
    OR public.has_permission(auth.uid(), 'view_reports')
  )
);

-- The activity timelines carry the same customer data in their `details` payload
-- (customer_name, customer_phone are recorded on every edit), so leaving them
-- open would reopen the door this just closed.
DROP POLICY IF EXISTS "Order activity visible by permission" ON public.order_activity;
CREATE POLICY "Order activity visible by permission"
ON public.order_activity
FOR SELECT
TO authenticated
USING (
  public.is_active(auth.uid())
  AND (
    public.has_permission(auth.uid(), 'view_orders')
    OR public.has_permission(auth.uid(), 'view_dashboard')
    OR public.has_permission(auth.uid(), 'view_reports')
    OR public.has_permission(auth.uid(), 'view_invoice_analytics')
    OR EXISTS (
      SELECT 1 FROM public.orders o
      WHERE o.id = order_activity.order_id AND o.agent_id = auth.uid()
    )
  )
);

DROP POLICY IF EXISTS "Complaint activity visible by permission" ON public.complaint_activity;
CREATE POLICY "Complaint activity visible by permission"
ON public.complaint_activity
FOR SELECT
TO authenticated
USING (
  public.is_active(auth.uid())
  AND (
    public.has_permission(auth.uid(), 'view_complaints')
    OR public.has_permission(auth.uid(), 'view_dashboard')
    OR public.has_permission(auth.uid(), 'view_reports')
    OR EXISTS (
      SELECT 1 FROM public.complaints c
      WHERE c.id = complaint_activity.complaint_id AND c.agent_id = auth.uid()
    )
  )
);

-- Satisfaction surveys carry per-agent performance data and free-text customer
-- comments; same reasoning.
DROP POLICY IF EXISTS "Surveys visible by scope" ON public.satisfaction_surveys;
CREATE POLICY "Surveys visible by scope" ON public.satisfaction_surveys
  FOR SELECT
  TO authenticated
  USING (
    public.is_active(auth.uid())
    AND (
      public.is_administrator(auth.uid())
      OR public.has_permission(auth.uid(), 'view_all_agents')
      OR agent_id = auth.uid()
    )
  );

-- ---------------------------------------------------------------------------
-- 2. Withdraw the dangling INSERT grants on the activity timelines
-- ---------------------------------------------------------------------------
--
-- Both tables were created with `GRANT SELECT, INSERT ... TO authenticated`
-- alongside an "insert by authenticated" policy carrying `WITH CHECK (true)`.
-- That policy was dropped on order_activity (20260624110517) and never created
-- for complaint_activity, so forged entries are refused today — but only because
-- RLS denies what no policy allows. The privilege is still sitting there, and it
-- is the kind of thing a later "fix the activity feed" migration re-enables
-- without anyone noticing that it makes the timeline forgeable.
--
-- Nothing legitimate needs it: rows are written exclusively by
-- log_order_activity() / log_complaint_activity(), which are SECURITY DEFINER
-- triggers and therefore insert as the function owner, not as the caller.
REVOKE INSERT ON public.order_activity FROM authenticated;
REVOKE INSERT ON public.complaint_activity FROM authenticated;

-- ---------------------------------------------------------------------------
-- 3. Make the activity timelines append-only
-- ---------------------------------------------------------------------------
--
-- `GRANT ALL ... TO service_role` on both tables includes UPDATE and DELETE.
-- No code path uses them, and a record of what changed is worth little if it can
-- be quietly rewritten afterwards. Matches admin_activity, which was created
-- append-only in 20260725003000.
--
-- Rows still disappear with their parent: both tables cascade from
-- orders/complaints, and a cascade is a referential action rather than a DELETE
-- privilege check, so this does not block deleting an order.
REVOKE UPDATE, DELETE ON public.order_activity FROM service_role;
REVOKE UPDATE, DELETE ON public.complaint_activity FROM service_role;
