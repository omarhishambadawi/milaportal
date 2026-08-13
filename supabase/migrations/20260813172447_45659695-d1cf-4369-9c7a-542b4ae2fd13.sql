-- Shams MIS page permission.
--
-- Adds one page-level key, `view_shams_mis`, and separates the auditor's
-- *allowed* list from its *defaults* so the key can be granted to an individual
-- auditor without granting it to the role.
--
-- Until now the auditor branch assigned `_allowed := _auditor_safe` and
-- `_defaults := _auditor_safe` — the same array — which made "an auditor may
-- hold this only if an administrator grants it" impossible to express: anything
-- grantable was also automatic. `_auditor_defaults` is that list minus the new
-- key. Every other role's sets are unchanged.
--
-- No schema change: this replaces one function body. Nothing is added to,
-- removed from or altered in any table, and no RLS policy is touched.
--
-- Mirrored by src/lib/permissions.ts; `npm run check:permissions` fails if the
-- two drift.

CREATE OR REPLACE FUNCTION public.has_permission(_user_id uuid, _permission text)
 RETURNS boolean
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  _role public.app_role;
  _perms text[];
  -- What an auditor MAY be granted.
  _auditor_safe text[] := ARRAY[
    'view_orders','view_complaints','view_dashboard','view_team_analytics',
    'view_all_agents','view_invoice_analytics','view_reports','export_reports',
    'view_call_center','view_branches','view_shams_mis'
  ];
  -- What an auditor GETS without an explicit per-user grant. Deliberately
  -- excludes 'view_shams_mis'.
  _auditor_defaults text[] := ARRAY[
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
    _defaults := _auditor_defaults;
  ELSIF _role = 'supervisor' THEN
    _allowed := ARRAY[
      'view_orders','create_orders','edit_orders','edit_all_orders',
      'view_complaints','create_complaints','edit_complaints','edit_all_complaints',
      'resolve_complaints','resolve_all_complaints',
      'view_dashboard','view_team_analytics','view_all_agents','view_call_center',
      'verify_own_orders','verify_all_orders','view_invoice_analytics',
      'view_branches','export_reports',
      'view_reports','manage_users','admin_access','view_shams_mis'
    ];
    _defaults := ARRAY[
      'view_orders','create_orders','edit_orders','edit_all_orders',
      'view_complaints','create_complaints','edit_complaints','edit_all_complaints',
      'resolve_complaints','resolve_all_complaints',
      'view_dashboard','view_team_analytics','view_all_agents','view_call_center',
      'verify_own_orders','verify_all_orders','view_invoice_analytics',
      'view_branches','export_reports',
      'view_reports','manage_users','admin_access','view_shams_mis'
    ];
  ELSIF _role = 'customer_care' THEN
    _allowed := ARRAY[
      'view_orders','create_orders','edit_orders',
      'view_complaints','create_complaints','edit_complaints','resolve_complaints',
      'view_dashboard','view_team_analytics','view_branches',
      'verify_own_orders','view_invoice_analytics','export_reports','view_shams_mis'
    ];
    _defaults := ARRAY[
      'view_orders','create_orders','edit_orders',
      'view_complaints','create_complaints','edit_complaints','resolve_complaints',
      'view_dashboard','view_team_analytics','view_branches','verify_own_orders',
      'view_shams_mis'
    ];
  ELSIF _role = 'telesales' THEN
    _allowed := ARRAY[
      'view_orders','create_orders','edit_orders',
      'view_dashboard','view_team_analytics','view_branches',
      'verify_own_orders','view_invoice_analytics','export_reports','view_shams_mis'
    ];
    _defaults := ARRAY[
      'view_orders','create_orders','edit_orders','view_dashboard','view_branches',
      'verify_own_orders','view_shams_mis'
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