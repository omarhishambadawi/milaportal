DROP POLICY IF EXISTS "View complaints" ON public.complaints;
CREATE POLICY "View complaints" ON public.complaints FOR SELECT TO authenticated
USING ((auth.uid() = agent_id) OR public.has_role(auth.uid(), 'admin'::public.app_role));