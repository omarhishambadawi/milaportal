
-- 1) Allow service_role (admin server fns) to edit agent_code/active via trigger bypass
CREATE OR REPLACE FUNCTION public.prevent_profile_escalation()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  -- Allow service role (no auth.uid) and admins
  IF auth.uid() IS NULL OR public.has_role(auth.uid(), 'admin') THEN
    RETURN NEW;
  END IF;
  IF NEW.agent_code IS DISTINCT FROM OLD.agent_code THEN
    RAISE EXCEPTION 'Not allowed to change agent_code';
  END IF;
  IF NEW.active IS DISTINCT FROM OLD.active THEN
    RAISE EXCEPTION 'Not allowed to change active flag';
  END IF;
  IF NEW.id IS DISTINCT FROM OLD.id THEN
    RAISE EXCEPTION 'Not allowed to change id';
  END IF;
  RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION public.prevent_order_reassignment()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF auth.uid() IS NULL OR public.has_role(auth.uid(), 'admin') THEN
    RETURN NEW;
  END IF;
  IF NEW.agent_id IS DISTINCT FROM OLD.agent_id THEN
    RAISE EXCEPTION 'Not allowed to change agent_id';
  END IF;
  IF NEW.team IS DISTINCT FROM OLD.team THEN
    RAISE EXCEPTION 'Not allowed to change team';
  END IF;
  RETURN NEW;
END;
$$;

-- 2) Sequential order display number starting at #4000
CREATE SEQUENCE IF NOT EXISTS public.order_display_seq START WITH 4000 INCREMENT BY 1;
GRANT USAGE, SELECT ON SEQUENCE public.order_display_seq TO authenticated, service_role;

ALTER TABLE public.orders ADD COLUMN IF NOT EXISTS display_no text;

CREATE OR REPLACE FUNCTION public.set_order_display_no()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public
AS $$
BEGIN
  IF NEW.display_no IS NULL THEN
    NEW.display_no := '#' || nextval('public.order_display_seq')::text;
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_set_order_display_no ON public.orders;
CREATE TRIGGER trg_set_order_display_no
BEFORE INSERT ON public.orders
FOR EACH ROW EXECUTE FUNCTION public.set_order_display_no();

REVOKE EXECUTE ON FUNCTION public.set_order_display_no() FROM PUBLIC, anon, authenticated;

-- Backfill existing rows in chronological order
DO $$
DECLARE r RECORD;
BEGIN
  FOR r IN SELECT id FROM public.orders WHERE display_no IS NULL ORDER BY created_at ASC LOOP
    UPDATE public.orders SET display_no = '#' || nextval('public.order_display_seq')::text WHERE id = r.id;
  END LOOP;
END $$;

ALTER TABLE public.orders ALTER COLUMN display_no SET NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS orders_display_no_key ON public.orders(display_no);
