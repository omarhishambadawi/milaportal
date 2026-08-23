DROP POLICY IF EXISTS "Orders visible by scope" ON public.orders;

CREATE POLICY "Orders visible by permission"
  ON public.orders
  FOR SELECT
  TO authenticated
  USING (public.has_permission(auth.uid(), 'view_orders'));
