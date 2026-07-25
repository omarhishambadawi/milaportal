CREATE TEMP TABLE _call_center_migration ON COMMIT DROP AS
SELECT ur.user_id,
       COUNT(o.id) FILTER (WHERE o.team = 'telesales'::public.app_role)     AS telesales_orders,
       COUNT(o.id) FILTER (WHERE o.team = 'customer_care'::public.app_role) AS customer_care_orders,
       CASE
         WHEN COUNT(o.id) FILTER (WHERE o.team = 'telesales'::public.app_role)
            > COUNT(o.id) FILTER (WHERE o.team = 'customer_care'::public.app_role)
         THEN 'telesales'::public.app_role
         ELSE 'customer_care'::public.app_role
       END AS target_role
  FROM public.user_roles ur
  LEFT JOIN public.orders o ON o.agent_id = ur.user_id
 WHERE ur.role = 'call_center'::public.app_role
 GROUP BY ur.user_id;

UPDATE public.user_roles ur
   SET role = m.target_role
  FROM _call_center_migration m
 WHERE ur.user_id = m.user_id
   AND ur.role = 'call_center'::public.app_role;

CREATE OR REPLACE FUNCTION public.has_permission(_user_id uuid, _permission text)
 RETURNS boolean
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  _role public.app_role;
  _perms text[];
  _auditor_safe text[] := ARRAY[
    'view_orders','view_complaints','view_dashboard','view_team_analytics',
    'view_all_agents','view_invoice_analytics','view_reports','export_reports',
    'view_call_center','view_branches'
  ];
  _allowed text[];
  _defaults text[];
BEGIN
  IF _user_id IS NULL OR _permission IS NULL THEN RETURN false; END IF;
  SELECT role INTO _role FROM public.user_roles WHERE user_id = _user_id LIMIT 1;
  IF _role IS NULL THEN RETURN false; END IF;
  IF _role IN ('admin'::public.app_role, 'owner'::public.app_role) THEN RETURN true; END IF;
  SELECT permissions INTO _perms FROM public.profiles WHERE id = _user_id;

  IF _role = 'auditor' THEN
    _allowed := _auditor_safe;
    _defaults := _auditor_safe;
  ELSIF _role = 'supervisor' THEN
    _allowed := ARRAY[
      'view_orders','create_orders','edit_orders','edit_all_orders',
      'view_complaints','create_complaints','edit_complaints','edit_all_complaints',
      'resolve_complaints','resolve_all_complaints',
      'view_dashboard','view_team_analytics','view_all_agents','view_call_center',
      'verify_own_orders','verify_all_orders','view_invoice_analytics',
      'view_branches','export_reports',
      'view_reports','manage_users','admin_access'
    ];
    _defaults := ARRAY[
      'view_orders','create_orders','edit_orders','edit_all_orders',
      'view_complaints','create_complaints','edit_complaints','edit_all_complaints',
      'resolve_complaints','resolve_all_complaints',
      'view_dashboard','view_team_analytics','view_all_agents','view_call_center',
      'verify_own_orders','verify_all_orders','view_invoice_analytics',
      'view_branches','export_reports',
      'view_reports','manage_users','admin_access'
    ];
  ELSIF _role = 'customer_care' THEN
    _allowed := ARRAY[
      'view_orders','create_orders','edit_orders',
      'view_complaints','create_complaints','edit_complaints','resolve_complaints',
      'view_dashboard','view_team_analytics','view_branches',
      'verify_own_orders','view_invoice_analytics','export_reports'
    ];
    _defaults := ARRAY[
      'view_orders','create_orders','edit_orders',
      'view_complaints','create_complaints','edit_complaints','resolve_complaints',
      'view_dashboard','view_team_analytics','view_branches','verify_own_orders'
    ];
  ELSIF _role = 'telesales' THEN
    _allowed := ARRAY[
      'view_orders','create_orders','edit_orders',
      'view_dashboard','view_team_analytics','view_branches',
      'verify_own_orders','view_invoice_analytics','export_reports'
    ];
    _defaults := ARRAY[
      'view_orders','create_orders','edit_orders','view_dashboard','view_branches','verify_own_orders'
    ];
  ELSE
    RETURN false;
  END IF;

  IF NOT (_permission = ANY(_allowed)) THEN RETURN false; END IF;
  IF COALESCE(array_length(_perms, 1), 0) > 0 THEN RETURN _permission = ANY(_perms); END IF;
  RETURN _permission = ANY(_defaults);
END;
$function$;

GRANT EXECUTE ON FUNCTION public.has_permission(uuid, text) TO authenticated, service_role;
REVOKE EXECUTE ON FUNCTION public.has_permission(uuid, text) FROM anon;

CREATE OR REPLACE FUNCTION public.reject_retired_roles()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
BEGIN
  IF NEW.role = 'call_center'::public.app_role THEN
    RAISE EXCEPTION 'The call_center role has been retired; assign customer_care instead';
  END IF;
  RETURN NEW;
END;
$function$;

DROP TRIGGER IF EXISTS reject_retired_roles_trg ON public.user_roles;
CREATE TRIGGER reject_retired_roles_trg
  BEFORE INSERT OR UPDATE OF role ON public.user_roles
  FOR EACH ROW EXECUTE FUNCTION public.reject_retired_roles();