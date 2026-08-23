
DROP POLICY IF EXISTS "Activity insert by authenticated" ON public.order_activity;

REVOKE ALL ON FUNCTION public.log_order_activity() FROM PUBLIC, anon, authenticated;
