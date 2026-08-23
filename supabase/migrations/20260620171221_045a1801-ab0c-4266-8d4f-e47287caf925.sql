
-- 1. Orders: remove order_no, add customer fields
ALTER TABLE public.orders DROP COLUMN IF EXISTS order_no;
ALTER TABLE public.orders ADD COLUMN IF NOT EXISTS customer_name text NOT NULL DEFAULT '';
ALTER TABLE public.orders ADD COLUMN IF NOT EXISTS customer_phone text NOT NULL DEFAULT '';

-- 2. Profile permissions
ALTER TABLE public.profiles ADD COLUMN IF NOT EXISTS permissions text[] NOT NULL DEFAULT '{}';

-- Allow admins to change permissions via the existing escalation trigger
CREATE OR REPLACE FUNCTION public.prevent_profile_escalation()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
BEGIN
  IF auth.uid() IS NULL OR public.has_role(auth.uid(), 'admin') THEN
    RETURN NEW;
  END IF;
  IF NEW.agent_code IS DISTINCT FROM OLD.agent_code THEN
    RAISE EXCEPTION 'Not allowed to change agent_code';
  END IF;
  IF NEW.active IS DISTINCT FROM OLD.active THEN
    RAISE EXCEPTION 'Not allowed to change active flag';
  END IF;
  IF NEW.permissions IS DISTINCT FROM OLD.permissions THEN
    RAISE EXCEPTION 'Not allowed to change permissions';
  END IF;
  IF NEW.id IS DISTINCT FROM OLD.id THEN
    RAISE EXCEPTION 'Not allowed to change id';
  END IF;
  RETURN NEW;
END;
$$;

-- 3. Complaints table
CREATE SEQUENCE IF NOT EXISTS public.complaint_display_seq START 7000;

CREATE TABLE IF NOT EXISTS public.complaints (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  display_no text NOT NULL DEFAULT ('#C-' || nextval('public.complaint_display_seq')::text),
  complaint_date date NOT NULL DEFAULT CURRENT_DATE,
  agent_id uuid NOT NULL,
  customer_name text NOT NULL DEFAULT '',
  customer_phone text NOT NULL DEFAULT '',
  branch_no text,
  category text,
  description text NOT NULL DEFAULT '',
  resolution text,
  status text NOT NULL DEFAULT 'Open',
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

GRANT SELECT, INSERT, UPDATE, DELETE ON public.complaints TO authenticated;
GRANT ALL ON public.complaints TO service_role;
GRANT USAGE ON SEQUENCE public.complaint_display_seq TO authenticated, service_role;

ALTER TABLE public.complaints ENABLE ROW LEVEL SECURITY;

CREATE POLICY "View complaints"
  ON public.complaints FOR SELECT TO authenticated USING (true);

CREATE POLICY "CC and admins create complaints"
  ON public.complaints FOR INSERT TO authenticated
  WITH CHECK (
    auth.uid() = agent_id
    AND public.is_active(auth.uid())
    AND (public.has_role(auth.uid(), 'admin') OR public.has_role(auth.uid(), 'customer_care'))
  );

CREATE POLICY "Owners or admins update complaints"
  ON public.complaints FOR UPDATE TO authenticated
  USING (auth.uid() = agent_id OR public.has_role(auth.uid(), 'admin'))
  WITH CHECK (auth.uid() = agent_id OR public.has_role(auth.uid(), 'admin'));

CREATE POLICY "Admins delete complaints"
  ON public.complaints FOR DELETE TO authenticated
  USING (public.has_role(auth.uid(), 'admin'));

CREATE TRIGGER trg_complaints_updated_at
  BEFORE UPDATE ON public.complaints
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();
