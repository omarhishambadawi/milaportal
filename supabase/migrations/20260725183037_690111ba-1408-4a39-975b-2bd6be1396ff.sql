ALTER TABLE public.profiles
  ADD COLUMN IF NOT EXISTS must_change_password boolean NOT NULL DEFAULT false;

ALTER TABLE public.profiles
  ADD COLUMN IF NOT EXISTS must_change_password_expires_at timestamptz;

CREATE OR REPLACE FUNCTION public.prevent_profile_escalation()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
BEGIN
  IF auth.uid() IS NULL OR public.has_role(auth.uid(), 'admin') THEN
    RETURN NEW;
  END IF;
  IF NEW.agent_code IS DISTINCT FROM OLD.agent_code THEN
    RAISE EXCEPTION 'Not allowed to change agent_code';
  END IF;
  IF NEW.active IS DISTINCT FROM OLD.active THEN
    RAISE EXCEPTION 'Not allowed to change active flag';
  END IF;
  IF NEW.permissions IS DISTINCT FROM OLD.permissions THEN
    RAISE EXCEPTION 'Not allowed to change permissions';
  END IF;
  IF NEW.yeastar_ext IS DISTINCT FROM OLD.yeastar_ext THEN
    RAISE EXCEPTION 'Not allowed to change yeastar_ext';
  END IF;
  IF NEW.must_change_password IS DISTINCT FROM OLD.must_change_password THEN
    RAISE EXCEPTION 'Not allowed to change must_change_password';
  END IF;
  IF NEW.must_change_password_expires_at IS DISTINCT FROM OLD.must_change_password_expires_at THEN
    RAISE EXCEPTION 'Not allowed to change must_change_password_expires_at';
  END IF;
  IF NEW.id IS DISTINCT FROM OLD.id THEN
    RAISE EXCEPTION 'Not allowed to change id';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TABLE IF NOT EXISTS public.admin_activity (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  actor_id uuid,
  target_user_id uuid,
  action text NOT NULL,
  details jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS admin_activity_created_at_idx
  ON public.admin_activity(created_at DESC);
CREATE INDEX IF NOT EXISTS admin_activity_target_idx
  ON public.admin_activity(target_user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS admin_activity_actor_idx
  ON public.admin_activity(actor_id, created_at DESC);

GRANT SELECT ON public.admin_activity TO authenticated;
GRANT SELECT, INSERT ON public.admin_activity TO service_role;
REVOKE UPDATE, DELETE ON public.admin_activity FROM authenticated, service_role;

ALTER TABLE public.admin_activity ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Admin activity readable by administrators" ON public.admin_activity;
CREATE POLICY "Admin activity readable by administrators"
  ON public.admin_activity FOR SELECT TO authenticated
  USING (public.is_administrator(auth.uid()));

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

REVOKE INSERT ON public.order_activity FROM authenticated;
REVOKE INSERT ON public.complaint_activity FROM authenticated;
REVOKE UPDATE, DELETE ON public.order_activity FROM service_role;
REVOKE UPDATE, DELETE ON public.complaint_activity FROM service_role;