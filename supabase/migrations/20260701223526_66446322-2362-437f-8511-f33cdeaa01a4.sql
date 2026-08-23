CREATE OR REPLACE FUNCTION public.has_permission(_user_id uuid, _permission text)
RETURNS boolean
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  _role public.app_role;
  _perms text[];
  _safe_read text[] := ARRAY[
    'view_orders',
    'view_complaints',
    'view_dashboard',
    'view_team_analytics',
    'view_all_agents',
    'view_invoice_analytics',
    'view_reports',
    'export_reports',
    'view_workforce'
  ];
BEGIN
  IF _user_id IS NULL OR _permission IS NULL THEN
    RETURN false;
  END IF;

  SELECT role INTO _role
  FROM public.user_roles
  WHERE user_id = _user_id
  LIMIT 1;

  IF _role IS NULL THEN
    RETURN false;
  END IF;

  IF _role = 'admin' THEN
    RETURN true;
  END IF;

  SELECT permissions INTO _perms
  FROM public.profiles
  WHERE id = _user_id;

  IF _role = 'auditor' THEN
    IF NOT (_permission = ANY(_safe_read)) THEN
      RETURN false;
    END IF;
    IF COALESCE(array_length(_perms, 1), 0) > 0 THEN
      RETURN _permission = ANY(_perms);
    END IF;
    RETURN _permission = ANY(ARRAY[
      'view_orders',
      'view_complaints',
      'view_dashboard',
      'view_team_analytics',
      'view_all_agents',
      'view_invoice_analytics',
      'view_reports',
      'export_reports'
    ]);
  END IF;

  IF COALESCE(array_length(_perms, 1), 0) > 0 THEN
    RETURN _permission = ANY(_perms);
  END IF;

  IF _role = 'customer_care' THEN
    RETURN _permission = ANY(ARRAY[
      'view_orders', 'create_orders', 'edit_orders',
      'view_complaints', 'create_complaints', 'edit_complaints', 'resolve_complaints',
      'view_dashboard', 'view_team_analytics',
      'verify_own_orders',
      'view_workforce'
    ]);
  END IF;

  IF _role = 'telesales' THEN
    RETURN _permission = ANY(ARRAY[
      'view_orders', 'create_orders', 'edit_orders',
      'view_dashboard',
      'verify_own_orders',
      'view_workforce'
    ]);
  END IF;

  RETURN false;
END;
$$;

REVOKE ALL ON FUNCTION public.has_permission(uuid, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.has_permission(uuid, text) TO authenticated, service_role;

CREATE OR REPLACE FUNCTION public.is_active(_user_id uuid)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY INVOKER
SET search_path = public
AS $$
  SELECT COALESCE((SELECT active FROM public.profiles WHERE id = _user_id), false)
$$;

REVOKE ALL ON FUNCTION public.is_active(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.is_active(uuid) TO authenticated, service_role;

CREATE OR REPLACE FUNCTION public.prevent_order_reassignment()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  uid uuid := auth.uid();
  only_verification_changed boolean;
BEGIN
  IF uid IS NULL THEN
    RAISE EXCEPTION 'Not authorized';
  END IF;

  IF public.has_permission(uid, 'edit_all_orders') THEN
    RETURN NEW;
  END IF;

  IF public.has_role(uid, 'auditor') THEN
    RAISE EXCEPTION 'Auditor accounts are read-only';
  END IF;

  IF NEW.agent_id IS DISTINCT FROM OLD.agent_id THEN
    RAISE EXCEPTION 'Not allowed to change agent_id';
  END IF;

  IF NEW.team IS DISTINCT FROM OLD.team THEN
    RAISE EXCEPTION 'Not allowed to change team';
  END IF;

  IF OLD.agent_id = uid AND public.has_permission(uid, 'edit_orders') THEN
    RETURN NEW;
  END IF;

  only_verification_changed := (to_jsonb(NEW) - 'call_center_verified' - 'updated_at') = (to_jsonb(OLD) - 'call_center_verified' - 'updated_at')
    AND NEW.call_center_verified IS DISTINCT FROM OLD.call_center_verified;

  IF only_verification_changed AND (public.has_permission(uid, 'verify_all_orders') OR (OLD.agent_id = uid AND public.has_permission(uid, 'verify_own_orders'))) THEN
    RETURN NEW;
  END IF;

  RAISE EXCEPTION 'You do not have permission to update this order';
END;
$$;

REVOKE ALL ON FUNCTION public.prevent_order_reassignment() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.prevent_order_reassignment() TO service_role;

DROP POLICY IF EXISTS "Authenticated users view all orders" ON public.orders;
DROP POLICY IF EXISTS "Active agents insert own orders" ON public.orders;
DROP POLICY IF EXISTS "Agents update own orders or admin" ON public.orders;
DROP POLICY IF EXISTS "Admins delete orders" ON public.orders;

CREATE POLICY "Orders visible by permission"
ON public.orders
FOR SELECT
TO authenticated
USING (
  public.has_permission(auth.uid(), 'view_orders')
  OR public.has_permission(auth.uid(), 'view_dashboard')
  OR public.has_permission(auth.uid(), 'view_reports')
  OR public.has_permission(auth.uid(), 'view_invoice_analytics')
);

CREATE POLICY "Orders created by permitted active users"
ON public.orders
FOR INSERT
TO authenticated
WITH CHECK (
  auth.uid() = agent_id
  AND public.is_active(auth.uid())
  AND public.has_permission(auth.uid(), 'create_orders')
);

CREATE POLICY "Orders updated by permitted users"
ON public.orders
FOR UPDATE
TO authenticated
USING (
  public.is_active(auth.uid())
  AND (
    public.has_permission(auth.uid(), 'edit_all_orders')
    OR (auth.uid() = agent_id AND public.has_permission(auth.uid(), 'edit_orders'))
    OR public.has_permission(auth.uid(), 'verify_all_orders')
    OR (auth.uid() = agent_id AND public.has_permission(auth.uid(), 'verify_own_orders'))
  )
)
WITH CHECK (
  public.is_active(auth.uid())
  AND (
    public.has_permission(auth.uid(), 'edit_all_orders')
    OR (auth.uid() = agent_id AND public.has_permission(auth.uid(), 'edit_orders'))
    OR public.has_permission(auth.uid(), 'verify_all_orders')
    OR (auth.uid() = agent_id AND public.has_permission(auth.uid(), 'verify_own_orders'))
  )
);

CREATE POLICY "Orders deleted by permitted users"
ON public.orders
FOR DELETE
TO authenticated
USING (public.has_permission(auth.uid(), 'delete_orders'));

DROP POLICY IF EXISTS "Activity readable by admin or order owner" ON public.order_activity;

CREATE POLICY "Order activity visible by permission"
ON public.order_activity
FOR SELECT
TO authenticated
USING (
  public.has_permission(auth.uid(), 'view_orders')
  OR public.has_permission(auth.uid(), 'view_dashboard')
  OR public.has_permission(auth.uid(), 'view_reports')
  OR public.has_permission(auth.uid(), 'view_invoice_analytics')
  OR EXISTS (
    SELECT 1 FROM public.orders o
    WHERE o.id = order_activity.order_id AND o.agent_id = auth.uid()
  )
);

DROP POLICY IF EXISTS "Authenticated users view all complaints" ON public.complaints;
DROP POLICY IF EXISTS "CC and admins create complaints" ON public.complaints;
DROP POLICY IF EXISTS "Owners or admins update complaints" ON public.complaints;
DROP POLICY IF EXISTS "Admins delete complaints" ON public.complaints;

CREATE POLICY "Complaints visible by permission"
ON public.complaints
FOR SELECT
TO authenticated
USING (
  public.has_permission(auth.uid(), 'view_complaints')
  OR public.has_permission(auth.uid(), 'view_dashboard')
  OR public.has_permission(auth.uid(), 'view_reports')
);

CREATE POLICY "Complaints created by permitted active users"
ON public.complaints
FOR INSERT
TO authenticated
WITH CHECK (
  auth.uid() = agent_id
  AND public.is_active(auth.uid())
  AND public.has_permission(auth.uid(), 'create_complaints')
);

CREATE POLICY "Complaints updated by permitted users"
ON public.complaints
FOR UPDATE
TO authenticated
USING (
  public.is_active(auth.uid())
  AND (
    public.has_permission(auth.uid(), 'edit_all_complaints')
    OR (auth.uid() = agent_id AND public.has_permission(auth.uid(), 'edit_complaints'))
    OR public.has_permission(auth.uid(), 'resolve_all_complaints')
    OR (auth.uid() = agent_id AND public.has_permission(auth.uid(), 'resolve_complaints'))
  )
)
WITH CHECK (
  public.is_active(auth.uid())
  AND (
    public.has_permission(auth.uid(), 'edit_all_complaints')
    OR (auth.uid() = agent_id AND public.has_permission(auth.uid(), 'edit_complaints'))
    OR public.has_permission(auth.uid(), 'resolve_all_complaints')
    OR (auth.uid() = agent_id AND public.has_permission(auth.uid(), 'resolve_complaints'))
  )
);

CREATE POLICY "Complaints deleted by permitted users"
ON public.complaints
FOR DELETE
TO authenticated
USING (public.has_permission(auth.uid(), 'delete_complaints'));

DROP POLICY IF EXISTS "read complaint activity" ON public.complaint_activity;

CREATE POLICY "Complaint activity visible by permission"
ON public.complaint_activity
FOR SELECT
TO authenticated
USING (
  public.has_permission(auth.uid(), 'view_complaints')
  OR public.has_permission(auth.uid(), 'view_dashboard')
  OR public.has_permission(auth.uid(), 'view_reports')
  OR EXISTS (
    SELECT 1 FROM public.complaints c
    WHERE c.id = complaint_activity.complaint_id AND c.agent_id = auth.uid()
  )
);

REVOKE ALL ON FUNCTION public.log_complaint_activity() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.log_order_activity() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.notify_on_complaint_change() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.notify_on_order_change() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.notify_users(uuid[], text, text, text, text, text, uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.log_complaint_activity() TO service_role;
GRANT EXECUTE ON FUNCTION public.log_order_activity() TO service_role;
GRANT EXECUTE ON FUNCTION public.notify_on_complaint_change() TO service_role;
GRANT EXECUTE ON FUNCTION public.notify_on_order_change() TO service_role;
GRANT EXECUTE ON FUNCTION public.notify_users(uuid[], text, text, text, text, text, uuid) TO service_role;