CREATE OR REPLACE FUNCTION public.has_permission(_user_id uuid, _permission text)
RETURNS boolean
LANGUAGE plpgsql
STABLE
SECURITY INVOKER
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