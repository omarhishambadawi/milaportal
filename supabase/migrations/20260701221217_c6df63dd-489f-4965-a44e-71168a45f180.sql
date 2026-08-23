
-- 1) Notifications: only notify the owner (agent_id) — remove admin fan-out.
CREATE OR REPLACE FUNCTION public.notify_on_order_change()
 RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public'
AS $function$
DECLARE title text; body text; kind text;
BEGIN
  IF TG_OP = 'INSERT' THEN
    kind := 'order_created';
    title := 'New order ' || COALESCE(NEW.display_no, '');
    body := 'You created a new order';
    PERFORM public.notify_users(ARRAY[NEW.agent_id], kind, title, body, '/orders/' || NEW.id::text, 'order', NEW.id);
    RETURN NEW;
  END IF;
  IF TG_OP = 'UPDATE' THEN
    IF NEW.status IS DISTINCT FROM OLD.status THEN
      kind := 'order_status';
      title := 'Order ' || COALESCE(NEW.display_no, '') || ' → ' || NEW.status;
      body := 'Status changed from ' || OLD.status || ' to ' || NEW.status;
    ELSE
      kind := 'order_updated';
      title := 'Order ' || COALESCE(NEW.display_no, '') || ' updated';
      body := 'Order details were edited';
    END IF;
    PERFORM public.notify_users(ARRAY[NEW.agent_id], kind, title, body, '/orders/' || NEW.id::text, 'order', NEW.id);
    RETURN NEW;
  END IF;
  RETURN NEW;
END; $function$;

CREATE OR REPLACE FUNCTION public.notify_on_complaint_change()
 RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public'
AS $function$
DECLARE title text; body text; kind text;
BEGIN
  IF TG_OP = 'INSERT' THEN
    kind := 'complaint_created';
    title := 'New complaint ' || COALESCE(NEW.display_no, '');
    body := 'A complaint was logged';
    PERFORM public.notify_users(ARRAY[NEW.agent_id], kind, title, body, '/complaints/' || NEW.id::text, 'complaint', NEW.id);
    RETURN NEW;
  END IF;
  IF TG_OP = 'UPDATE' THEN
    IF NEW.status IS DISTINCT FROM OLD.status THEN
      kind := 'complaint_status';
      title := 'Complaint ' || COALESCE(NEW.display_no, '') || ' → ' || NEW.status;
      body := 'Status changed from ' || OLD.status || ' to ' || NEW.status;
    ELSE
      kind := 'complaint_updated';
      title := 'Complaint ' || COALESCE(NEW.display_no, '') || ' updated';
      body := 'Complaint details were edited';
    END IF;
    PERFORM public.notify_users(ARRAY[NEW.agent_id], kind, title, body, '/complaints/' || NEW.id::text, 'complaint', NEW.id);
    RETURN NEW;
  END IF;
  RETURN NEW;
END; $function$;

-- 2) Complaint activity timeline (mirror of order_activity)
CREATE TABLE IF NOT EXISTS public.complaint_activity (
  id uuid NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  complaint_id uuid NOT NULL REFERENCES public.complaints(id) ON DELETE CASCADE,
  actor_id uuid,
  action text NOT NULL,
  details jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);
GRANT SELECT, INSERT ON public.complaint_activity TO authenticated;
GRANT ALL ON public.complaint_activity TO service_role;
ALTER TABLE public.complaint_activity ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "read complaint activity" ON public.complaint_activity;
CREATE POLICY "read complaint activity" ON public.complaint_activity FOR SELECT TO authenticated
USING (
  public.has_role(auth.uid(), 'admin')
  OR public.has_role(auth.uid(), 'auditor')
  OR EXISTS (SELECT 1 FROM public.complaints c WHERE c.id = complaint_id AND c.agent_id = auth.uid())
);
CREATE INDEX IF NOT EXISTS idx_complaint_activity_cid ON public.complaint_activity(complaint_id, created_at DESC);

CREATE OR REPLACE FUNCTION public.log_complaint_activity()
 RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public'
AS $function$
DECLARE uid uuid := auth.uid(); changed jsonb := '{}'::jsonb;
BEGIN
  IF TG_OP = 'INSERT' THEN
    INSERT INTO public.complaint_activity(complaint_id, actor_id, action, details)
    VALUES (NEW.id, uid, 'created', jsonb_build_object('status', NEW.status));
    RETURN NEW;
  END IF;
  IF TG_OP = 'UPDATE' THEN
    IF NEW.status IS DISTINCT FROM OLD.status THEN
      INSERT INTO public.complaint_activity(complaint_id, actor_id, action, details)
      VALUES (NEW.id, uid, 'status_changed', jsonb_build_object('from', OLD.status, 'to', NEW.status));
    END IF;
    IF NEW.customer_name IS DISTINCT FROM OLD.customer_name THEN changed := changed || jsonb_build_object('customer_name', NEW.customer_name); END IF;
    IF NEW.customer_phone IS DISTINCT FROM OLD.customer_phone THEN changed := changed || jsonb_build_object('customer_phone', NEW.customer_phone); END IF;
    IF NEW.branch_no IS DISTINCT FROM OLD.branch_no THEN changed := changed || jsonb_build_object('branch_no', NEW.branch_no); END IF;
    IF NEW.description IS DISTINCT FROM OLD.description THEN changed := changed || jsonb_build_object('description', NEW.description); END IF;
    IF NEW.complaint_date IS DISTINCT FROM OLD.complaint_date THEN changed := changed || jsonb_build_object('complaint_date', NEW.complaint_date); END IF;
    IF changed <> '{}'::jsonb THEN
      INSERT INTO public.complaint_activity(complaint_id, actor_id, action, details)
      VALUES (NEW.id, uid, 'edited', changed);
    END IF;
    RETURN NEW;
  END IF;
  RETURN NEW;
END; $function$;

DROP TRIGGER IF EXISTS trg_log_complaint_activity ON public.complaints;
CREATE TRIGGER trg_log_complaint_activity
AFTER INSERT OR UPDATE ON public.complaints
FOR EACH ROW EXECUTE FUNCTION public.log_complaint_activity();
