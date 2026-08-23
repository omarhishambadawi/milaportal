DROP POLICY IF EXISTS "Admins manage branches" ON public.branches;
DROP POLICY IF EXISTS "Admins manage profiles" ON public.profiles;
DROP POLICY IF EXISTS "Admins manage roles" ON public.user_roles;
DROP POLICY IF EXISTS "Users view own roles" ON public.user_roles;

CREATE POLICY "Branches managed by permitted users"
ON public.branches
FOR ALL
TO authenticated
USING (public.has_permission(auth.uid(), 'admin_access'))
WITH CHECK (public.has_permission(auth.uid(), 'admin_access'));

CREATE POLICY "Users view own roles"
ON public.user_roles
FOR SELECT
TO authenticated
USING (user_id = auth.uid());

REVOKE ALL ON FUNCTION public.has_role(uuid, public.app_role) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.has_role(uuid, public.app_role) TO service_role;