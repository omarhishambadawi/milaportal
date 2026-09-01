-- Telesales CRM permissions.
--
-- Adds three keys and rewires four roles. No schema change: this replaces one
-- function body, exactly as `20260813172447` did for `view_shams_mis`.
--
-- ===========================================================================
-- Why three keys and not one
-- ===========================================================================
-- Because the module has three genuinely different audiences, and collapsing
-- them would either hand an agent the import screen or withhold the queue from
-- the team lead.
--
--   view_telesales    See the queue, a lead, its history and its follow-ups.
--                     This is also the RLS read boundary on every table in the
--                     module -- the policies check this key, so the page and the
--                     database agree by construction.
--
--   work_telesales    Claim a lead, record a call outcome, add a note, schedule
--                     a follow-up, record an order. The verbs an agent performs.
--                     Separate from `view_` so an auditor or a manager can be
--                     given the board without becoming a caller on it, and so a
--                     read-only handover is expressible.
--
--   manage_telesales  Import a workbook, run the generator, assign or reassign
--                     somebody else's lead, edit product eligibility and the
--                     date windows. Everything whose blast radius is the whole
--                     desk rather than one call.
--
-- The alternative -- reusing `admin_access` for the third -- was rejected: that
-- key currently means "edit branches and system settings", it is held by exactly
-- the roles that also administer users, and overloading it would make "may run
-- the telesales importer" ungrantable without also granting the branch
-- directory.
--
-- ===========================================================================
-- Who gets what
-- ===========================================================================
--   owner / admin   everything, by the existing short circuit.
--   supervisor      all three, by default. The supervisor already runs the
--                   agent-facing desks (it holds manage_users and admin_access),
--                   and somebody other than an administrator has to be able to
--                   press Import on a Monday morning.
--   telesales       view + work, by default. This is the role the module is for.
--                   `manage_telesales` is deliberately absent from its *allowed*
--                   ceiling too, so it cannot be granted per user: an agent who
--                   could reassign leads to themselves is the ownership problem
--                   the module exists to remove.
--   customer_care   view, grantable but off by default. The two agent teams
--                   already cover for one another on the phones; being able to
--                   read a lead's history without being able to act on it is the
--                   right shape for that, and it costs nothing until granted.
--   auditor         view, grantable but off by default -- the same gap
--                   `view_shams_mis` uses, and for the same reason.
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
    'view_call_center','view_branches','view_shams_mis','view_telesales'
  ];
  -- What an auditor GETS without an explicit per-user grant. Deliberately
  -- excludes 'view_shams_mis' and 'view_telesales'.
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
      'view_reports','manage_users','admin_access','view_shams_mis',
      'view_telesales','work_telesales','manage_telesales'
    ];
    _defaults := ARRAY[
      'view_orders','create_orders','edit_orders','edit_all_orders',
      'view_complaints','create_complaints','edit_complaints','edit_all_complaints',
      'resolve_complaints','resolve_all_complaints',
      'view_dashboard','view_team_analytics','view_all_agents','view_call_center',
      'verify_own_orders','verify_all_orders','view_invoice_analytics',
      'view_branches','export_reports',
      'view_reports','manage_users','admin_access','view_shams_mis',
      'view_telesales','work_telesales','manage_telesales'
    ];
  ELSIF _role = 'customer_care' THEN
    _allowed := ARRAY[
      'view_orders','create_orders','edit_orders',
      'view_complaints','create_complaints','edit_complaints','resolve_complaints',
      'view_dashboard','view_team_analytics','view_branches',
      'verify_own_orders','view_invoice_analytics','export_reports','view_shams_mis',
      'view_telesales'
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
      'verify_own_orders','view_invoice_analytics','export_reports','view_shams_mis',
      'view_telesales','work_telesales'
    ];
    _defaults := ARRAY[
      'view_orders','create_orders','edit_orders','view_dashboard','view_branches',
      'verify_own_orders','view_shams_mis',
      'view_telesales','work_telesales'
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
