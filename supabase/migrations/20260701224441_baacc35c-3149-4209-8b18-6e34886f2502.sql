DROP POLICY IF EXISTS "Users view own roles" ON public.user_roles;

CREATE POLICY "Signed-in users view role labels"
ON public.user_roles
FOR SELECT
TO authenticated
USING (auth.uid() IS NOT NULL);