
-- 1) Normalize order statuses
UPDATE public.orders SET status = 'Pending'
WHERE status NOT IN ('Pending','Completed','Cancelled');

-- 2) Activity log
CREATE TABLE IF NOT EXISTS public.order_activity (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  order_id uuid NOT NULL REFERENCES public.orders(id) ON DELETE CASCADE,
  actor_id uuid,
  action text NOT NULL,
  details jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS order_activity_order_id_idx ON public.order_activity(order_id, created_at DESC);

GRANT SELECT, INSERT ON public.order_activity TO authenticated;
GRANT ALL ON public.order_activity TO service_role;

ALTER TABLE public.order_activity ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Activity readable by admin or order owner" ON public.order_activity;
CREATE POLICY "Activity readable by admin or order owner"
  ON public.order_activity FOR SELECT TO authenticated
  USING (
    public.has_role(auth.uid(), 'admin')
    OR EXISTS (SELECT 1 FROM public.orders o WHERE o.id = order_activity.order_id AND o.agent_id = auth.uid())
  );

DROP POLICY IF EXISTS "Activity insert by authenticated" ON public.order_activity;
CREATE POLICY "Activity insert by authenticated"
  ON public.order_activity FOR INSERT TO authenticated
  WITH CHECK (true);

-- 3) Trigger: log creation, status changes, verification toggles, and edits
CREATE OR REPLACE FUNCTION public.log_order_activity()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  uid uuid := auth.uid();
  changed jsonb := '{}'::jsonb;
BEGIN
  IF TG_OP = 'INSERT' THEN
    INSERT INTO public.order_activity(order_id, actor_id, action, details)
    VALUES (NEW.id, uid, 'created',
      jsonb_build_object('status', NEW.status, 'invoice_value', NEW.invoice_value));
    RETURN NEW;
  END IF;

  IF TG_OP = 'UPDATE' THEN
    IF NEW.status IS DISTINCT FROM OLD.status THEN
      INSERT INTO public.order_activity(order_id, actor_id, action, details)
      VALUES (NEW.id, uid, 'status_changed',
        jsonb_build_object('from', OLD.status, 'to', NEW.status));
    END IF;
    IF NEW.call_center_verified IS DISTINCT FROM OLD.call_center_verified THEN
      INSERT INTO public.order_activity(order_id, actor_id, action, details)
      VALUES (NEW.id, uid, 'verification_changed',
        jsonb_build_object('verified', NEW.call_center_verified));
    END IF;
    -- Track field edits (excluding status/verified which have their own events)
    IF NEW.customer_name IS DISTINCT FROM OLD.customer_name THEN changed := changed || jsonb_build_object('customer_name', NEW.customer_name); END IF;
    IF NEW.customer_phone IS DISTINCT FROM OLD.customer_phone THEN changed := changed || jsonb_build_object('customer_phone', NEW.customer_phone); END IF;
    IF NEW.branch_no IS DISTINCT FROM OLD.branch_no THEN changed := changed || jsonb_build_object('branch_no', NEW.branch_no); END IF;
    IF NEW.delivery_type IS DISTINCT FROM OLD.delivery_type THEN changed := changed || jsonb_build_object('delivery_type', NEW.delivery_type); END IF;
    IF NEW.invoice_no IS DISTINCT FROM OLD.invoice_no THEN changed := changed || jsonb_build_object('invoice_no', NEW.invoice_no); END IF;
    IF NEW.invoice_value IS DISTINCT FROM OLD.invoice_value THEN changed := changed || jsonb_build_object('invoice_value', NEW.invoice_value); END IF;
    IF NEW.order_type IS DISTINCT FROM OLD.order_type THEN changed := changed || jsonb_build_object('order_type', NEW.order_type); END IF;
    IF NEW.notes IS DISTINCT FROM OLD.notes THEN changed := changed || jsonb_build_object('notes', NEW.notes); END IF;
    IF NEW.order_date IS DISTINCT FROM OLD.order_date THEN changed := changed || jsonb_build_object('order_date', NEW.order_date); END IF;
    IF changed <> '{}'::jsonb THEN
      INSERT INTO public.order_activity(order_id, actor_id, action, details)
      VALUES (NEW.id, uid, 'edited', changed);
    END IF;
    RETURN NEW;
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_log_order_activity ON public.orders;
CREATE TRIGGER trg_log_order_activity
AFTER INSERT OR UPDATE ON public.orders
FOR EACH ROW EXECUTE FUNCTION public.log_order_activity();
