
-- Satisfaction surveys table
CREATE TABLE IF NOT EXISTS public.satisfaction_surveys (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  agent_id uuid REFERENCES public.profiles(id) ON DELETE SET NULL,
  call_id text,
  rating smallint NOT NULL CHECK (rating BETWEEN 1 AND 5),
  comment text,
  submitted_at timestamptz NOT NULL DEFAULT now(),
  created_at timestamptz NOT NULL DEFAULT now()
);

GRANT SELECT, INSERT ON public.satisfaction_surveys TO authenticated;
GRANT ALL ON public.satisfaction_surveys TO service_role;

ALTER TABLE public.satisfaction_surveys ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Authenticated can read surveys" ON public.satisfaction_surveys;
CREATE POLICY "Authenticated can read surveys" ON public.satisfaction_surveys
  FOR SELECT TO authenticated USING (true);

DROP POLICY IF EXISTS "Admins can insert surveys" ON public.satisfaction_surveys;
CREATE POLICY "Admins can insert surveys" ON public.satisfaction_surveys
  FOR INSERT TO authenticated WITH CHECK (public.is_administrator(auth.uid()));

CREATE INDEX IF NOT EXISTS idx_surveys_submitted_at ON public.satisfaction_surveys(submitted_at DESC);
CREATE INDEX IF NOT EXISTS idx_surveys_agent ON public.satisfaction_surveys(agent_id);

-- Extend has_permission to include the new call_center role
CREATE OR REPLACE FUNCTION public.has_permission(_user_id uuid, _permission text)
 RETURNS boolean
 LANGUAGE plpgsql
 STABLE
 SET search_path TO 'public'
AS $function$
DECLARE
  _role public.app_role;
  _perms text[];
  _auditor_safe text[] := ARRAY[
    'view_orders','view_complaints','view_dashboard','view_team_analytics',
    'view_all_agents','view_invoice_analytics','view_reports','export_reports',
    'view_call_center'
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
  ELSIF _role = 'customer_care' THEN
    _allowed := ARRAY[
      'view_orders','create_orders','edit_orders',
      'view_complaints','create_complaints','edit_complaints','resolve_complaints',
      'view_dashboard','view_team_analytics',
      'verify_own_orders','view_invoice_analytics','export_reports'
    ];
    _defaults := ARRAY[
      'view_orders','create_orders','edit_orders',
      'view_complaints','create_complaints','edit_complaints','resolve_complaints',
      'view_dashboard','view_team_analytics','verify_own_orders'
    ];
  ELSIF _role = 'telesales' THEN
    _allowed := ARRAY[
      'view_orders','create_orders','edit_orders',
      'view_dashboard','view_team_analytics',
      'verify_own_orders','view_invoice_analytics','export_reports'
    ];
    _defaults := ARRAY[
      'view_orders','create_orders','edit_orders','view_dashboard','verify_own_orders'
    ];
  ELSIF _role = 'call_center' THEN
    _allowed := ARRAY[
      'view_orders',
      'view_complaints','create_complaints','edit_complaints','resolve_complaints',
      'view_dashboard','view_team_analytics','view_call_center',
      'view_invoice_analytics','export_reports'
    ];
    _defaults := ARRAY[
      'view_orders',
      'view_complaints','create_complaints','edit_complaints','resolve_complaints',
      'view_dashboard','view_team_analytics','view_call_center'
    ];
  ELSE
    RETURN false;
  END IF;

  IF NOT (_permission = ANY(_allowed)) THEN RETURN false; END IF;
  IF COALESCE(array_length(_perms, 1), 0) > 0 THEN RETURN _permission = ANY(_perms); END IF;
  RETURN _permission = ANY(_defaults);
END;
$function$;
