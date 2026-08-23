-- [H3] Force default role on new users; ignore any client-supplied role metadata
CREATE OR REPLACE FUNCTION public.handle_new_user()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
BEGIN
  INSERT INTO public.profiles (id, full_name, agent_code, active)
  VALUES (
    NEW.id,
    COALESCE(NEW.raw_user_meta_data->>'full_name', split_part(NEW.email,'@',1)),
    NEW.raw_user_meta_data->>'agent_code',
    true
  );
  INSERT INTO public.user_roles (user_id, role)
  VALUES (NEW.id, 'customer_care'::public.app_role)
  ON CONFLICT (user_id, role) DO NOTHING;
  RETURN NEW;
END; $function$;

-- [H4] Orders: scope reads to own rows unless supervisor/admin/owner
DROP POLICY IF EXISTS "Orders visible by permission" ON public.orders;

CREATE POLICY "Orders visible by scope"
  ON public.orders
  FOR SELECT
  TO authenticated
  USING (
    public.has_role(auth.uid(), 'admin'::public.app_role)
    OR public.has_role(auth.uid(), 'owner'::public.app_role)
    OR public.has_permission(auth.uid(), 'view_all_agents')
    OR agent_id = auth.uid()
  );

-- [H4] Profiles: hide sensitive columns from broad authenticated reads via
-- column-level GRANTs. RLS policies stay permissive for row visibility so
-- the directory (names) keeps working; column privileges block reads of
-- permissions / yeastar_ext at PostgREST.
REVOKE SELECT ON public.profiles FROM authenticated;
GRANT SELECT (id, full_name, agent_code, active, created_at) ON public.profiles TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.profiles TO service_role;

-- Self-read of the full row (permissions, yeastar_ext) via SECURITY DEFINER RPC.
CREATE OR REPLACE FUNCTION public.get_my_profile()
RETURNS public.profiles
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path TO 'public'
AS $$
  SELECT * FROM public.profiles WHERE id = auth.uid()
$$;

GRANT EXECUTE ON FUNCTION public.get_my_profile() TO authenticated;