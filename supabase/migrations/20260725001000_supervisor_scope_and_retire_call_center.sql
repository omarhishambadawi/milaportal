-- Supervisor becomes a near-administrator, and the `call_center` ROLE is retired.
--
-- Two changes, one function, because both live inside has_permission() and
-- splitting them would leave an intermediate state where call_center users have
-- no rules at all.
--
-- 1. SUPERVISOR gains manage_users, admin_access and view_reports.
--    Previously Supervisor was deliberately an operational-only role. The product
--    decision is now that a Supervisor administers the platform, held back on
--    exactly three things:
--      - no delete_orders / delete_complaints (absent from _allowed below);
--      - cannot delete a USER: adminDeleteUser requires is_administrator(), which
--        returns true only for owner/admin, and Supervisor is neither;
--      - no Yeastar access: that page and its server functions also gate on
--        is_administrator().
--    Because Supervisor can now manage users, WHO it may administer is capped in
--    the application layer by ROLE_ASSIGNABLE_BY in src/lib/roles.ts: a Supervisor
--    may create and manage agents and auditors only, and cannot create, promote to,
--    or modify supervisor, admin or owner. Without that cap, manage_users would be
--    a self-promotion path to admin.
--
-- 2. The `call_center` ROLE is retired. Note this is the ROLE only: the
--    `view_call_center` PERMISSION and the Call Center Analytics page are
--    unrelated and unchanged -- supervisor, auditor and the agent roles keep
--    view_call_center exactly as before.
--
--    Postgres cannot DROP a value from an enum without recreating the type, and
--    public.app_role is referenced by user_roles.role plus numerous policies,
--    triggers and functions. Recreating it would mean rebuilding the entire
--    authorization surface in one migration, which is not worth the risk for a
--    cosmetic cleanup. Instead the value is left orphaned and made unreachable:
--      - every user holding it is reassigned (below);
--      - its branch in has_permission() is deleted, so the ELSE arm returns false
--        for it -- deny-by-default rather than a stale permission set;
--      - the application rejects it at the API boundary (RETIRED_ROLES).
--
-- Unchanged: owner/admin still short-circuit to true; auditor stays read-only;
-- customer_care and telesales keep byte-identical rule sets.

-- ---------------------------------------------------------------------------
-- 1. Move anyone still on `call_center` onto the role their work actually matches.
--
-- Not a blanket reassignment: a Call Center account doing telesales work would be
-- mis-filed as Customer Care, losing the team its numbers belong to. So the
-- target role is inferred per user from the evidence in their own order history.
--
-- The signal is `orders.team`, which records the team each order was booked
-- under. It is stored per order and editable, so it reflects the work that was
-- actually done rather than the role the account happened to carry.
--
--   telesales orders > customer_care orders  -> telesales
--   otherwise                                -> customer_care
--
-- Ties resolve to customer_care, as does an account with no orders at all: it is
-- the broader role (it owns the complaint workflow), so it is the safer default
-- when the evidence does not point anywhere. The NOTICE at the end reports how
-- many landed in each bucket, and how many had no history to judge by, so those
-- can be reviewed by hand.
--
-- Two consequences of leaving `call_center` behind, whichever role a user lands
-- on. Neither can be avoided without altering a role that is meant to stay as-is:
--
--   GAINED: create_orders / edit_orders. call_center was read-only on orders.
--   LOST:   view_call_center. It is in neither agent role's ceiling, so it cannot
--           be restored per-user either -- has_permission() checks _allowed
--           before it ever looks at profiles.permissions, so writing the
--           permission into that array would evaluate to false and be dead data.
--
-- If a reassigned user genuinely needs Call Center Analytics, the intended answer
-- is `supervisor` (which does hold view_call_center), granted deliberately by an
-- administrator -- not a permission poked into an array where the role ceiling
-- will ignore it.
-- ---------------------------------------------------------------------------

-- Snapshot the decision before applying it, so the reassignment and the report
-- below cannot disagree about what happened.
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

DO $$
DECLARE
  _to_telesales int;
  _to_customer_care int;
  _no_history int;
BEGIN
  SELECT COUNT(*) FILTER (WHERE target_role = 'telesales'::public.app_role),
         COUNT(*) FILTER (WHERE target_role = 'customer_care'::public.app_role),
         COUNT(*) FILTER (WHERE telesales_orders = 0 AND customer_care_orders = 0)
    INTO _to_telesales, _to_customer_care, _no_history
    FROM _call_center_migration;

  IF _to_telesales + _to_customer_care = 0 THEN
    RAISE NOTICE '[retire call_center] no accounts held the role; nothing to migrate';
  ELSE
    RAISE NOTICE '[retire call_center] migrated % account(s): % -> telesales, % -> customer_care',
      _to_telesales + _to_customer_care, _to_telesales, _to_customer_care;
    IF _no_history > 0 THEN
      RAISE NOTICE '[retire call_center] % of those had no order history and defaulted to customer_care -- worth reviewing by hand',
        _no_history;
    END IF;
  END IF;
END $$;

-- ---------------------------------------------------------------------------
-- 2. has_permission(): expand supervisor, delete the call_center branch.
-- ---------------------------------------------------------------------------

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
    -- Mirrored by SUPERVISOR_ALLOWED_PERMS in src/lib/permissions.ts.
    -- delete_orders and delete_complaints are intentionally absent.
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
    -- Retired `call_center` lands here, as does any enum value added but not yet
    -- given rules. Deny by default.
    RETURN false;
  END IF;

  IF NOT (_permission = ANY(_allowed)) THEN RETURN false; END IF;
  IF COALESCE(array_length(_perms, 1), 0) > 0 THEN RETURN _permission = ANY(_perms); END IF;
  RETURN _permission = ANY(_defaults);
END;
$function$;

-- CREATE OR REPLACE preserves the existing ACL, so the anon revoke from
-- 20260721000200 survives. Restated explicitly so a future edit to this
-- function cannot silently hand the authorization oracle back to anon.
GRANT EXECUTE ON FUNCTION public.has_permission(uuid, text) TO authenticated, service_role;
REVOKE EXECUTE ON FUNCTION public.has_permission(uuid, text) FROM anon;

-- ---------------------------------------------------------------------------
-- 3. Make the retired role unassignable at the database level too.
--
-- The application already refuses it, but the API is not the only writer:
-- service_role code and manual SQL bypass it. This trigger is the backstop that
-- keeps the value orphaned for good.
-- ---------------------------------------------------------------------------

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
