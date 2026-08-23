-- Roles enum
CREATE TYPE public.app_role AS ENUM ('admin','customer_care','telesales');

CREATE TABLE public.profiles (
  id UUID PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
  full_name TEXT NOT NULL,
  agent_code TEXT,
  active BOOLEAN NOT NULL DEFAULT true,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
GRANT SELECT, INSERT, UPDATE, DELETE ON public.profiles TO authenticated;
GRANT ALL ON public.profiles TO service_role;
ALTER TABLE public.profiles ENABLE ROW LEVEL SECURITY;

CREATE TABLE public.user_roles (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  role public.app_role NOT NULL,
  UNIQUE(user_id, role)
);
GRANT SELECT ON public.user_roles TO authenticated;
GRANT ALL ON public.user_roles TO service_role;
ALTER TABLE public.user_roles ENABLE ROW LEVEL SECURITY;

CREATE OR REPLACE FUNCTION public.has_role(_user_id UUID, _role public.app_role)
RETURNS BOOLEAN LANGUAGE SQL STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT EXISTS (SELECT 1 FROM public.user_roles WHERE user_id=_user_id AND role=_role)
$$;

CREATE OR REPLACE FUNCTION public.is_active(_user_id UUID)
RETURNS BOOLEAN LANGUAGE SQL STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT COALESCE((SELECT active FROM public.profiles WHERE id=_user_id), false)
$$;

CREATE POLICY "Users can view all profiles" ON public.profiles FOR SELECT TO authenticated USING (true);
CREATE POLICY "Users update own profile" ON public.profiles FOR UPDATE TO authenticated USING (auth.uid()=id);
CREATE POLICY "Admins manage profiles" ON public.profiles FOR ALL TO authenticated
  USING (public.has_role(auth.uid(),'admin')) WITH CHECK (public.has_role(auth.uid(),'admin'));

CREATE POLICY "Users view own roles" ON public.user_roles FOR SELECT TO authenticated USING (user_id=auth.uid() OR public.has_role(auth.uid(),'admin'));
CREATE POLICY "Admins manage roles" ON public.user_roles FOR ALL TO authenticated
  USING (public.has_role(auth.uid(),'admin')) WITH CHECK (public.has_role(auth.uid(),'admin'));

CREATE TABLE public.branches (
  branch_no TEXT PRIMARY KEY,
  city TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
GRANT SELECT, INSERT, UPDATE, DELETE ON public.branches TO authenticated;
GRANT ALL ON public.branches TO service_role;
ALTER TABLE public.branches ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Auth view branches" ON public.branches FOR SELECT TO authenticated USING (true);
CREATE POLICY "Admins manage branches" ON public.branches FOR ALL TO authenticated
  USING (public.has_role(auth.uid(),'admin')) WITH CHECK (public.has_role(auth.uid(),'admin'));

INSERT INTO public.branches (branch_no, city) VALUES ('P0001','الرياض'),('P0002','الرياض'),('P0003','الرياض'),('P0004','الرياض'),('P0005','الرياض'),('P0006','الرياض'),('P0007','الرياض'),('P0008','الرياض'),('P0009','الرياض'),('P0010','الرياض'),('P0011','الرياض'),('P0012','الرياض'),('P0013','الرياض'),('P0014','الرياض'),('P0015','الرياض'),('P0016','الرياض'),('P0017','الرياض'),('P0018','الرياض'),('P0019','الرياض'),('P0020','الرياض'),('P0021','الرياض'),('P0022','الرياض'),('P0023','رفحاء'),('P0024','رفحاء'),('P0025','الرياض'),('P0026','الرياض'),('P0027','الرياض'),('P0028','الرياض'),('P0029','الرياض'),('P0030','الرياض'),('P0031','الرياض'),('P0032','الرياض'),('P0033','الخرج'),('P0034','الرياض'),('P0035','الرياض'),('P0036','الرياض'),('P0037','الرياض'),('P0038','الرياض'),('P0039','الرياض'),('P0040','الرياض'),('P0101','الطائف'),('P0102','الطائف'),('P0103','الطائف'),('P0104','الطائف'),('P0105','الطائف'),('P0106','الطائف'),('P0107','الطائف'),('P0108','الطائف'),('P0109','الطائف'),('P0110','الطائف'),('P0111','الطائف'),('P0112','الطائف'),('P0113','الطائف'),('P0114','الطائف'),('P0115','الطائف'),('P0116','الطائف'),('P0117','الطائف'),('P0118','الطائف'),('P0119','الطائف'),('P0120','الطائف'),('P0121','الطائف'),('P0122','الطائف'),('P0123','الطائف'),('P0124','الطائف'),('P0125','الطائف'),('P0126','الطائف'),('P0127','الطائف'),('P0128','الطائف'),('P0129','الطائف'),('P0130','الطائف'),('P0131','الطائف'),('P0132','الطائف'),('P0133','الطائف'),('P0134','الطائف'),('P0135','الطائف'),('P0136','الطائف'),('P0137','الطائف'),('P0138','الطائف'),('P0139','الطائف'),('P0140','الطائف'),('P0201','جدة'),('P0202','جدة'),('P0203','جدة'),('P0204','جدة'),('P0205','جدة'),('P0206','جدة'),('P0207','جدة'),('P0208','جدة'),('P0209','جدة'),('P0210','جدة'),('P0211','جدة'),('P0212','جدة'),('P0213','جدة'),('P0214','جدة'),('P0215','جدة'),('P0216','جدة'),('P0217','جدة'),('P0218','جدة'),('P0219','جدة'),('P0220','جدة'),('P0221','جدة'),('P0222','جدة'),('P0223','جدة'),('P0224','جدة'),('P0225','جدة'),('P0301','القصيم'),('P0302','القصيم'),('P0303','القصيم'),('P0304','القصيم'),('P0305','القصيم'),('P0306','القصيم'),('P0307','القصيم'),('P0308','القصيم'),('P0309','القصيم'),('P0401','مكة'),('P0402','مكة'),('P0403','مكة'),('P0404','مكة'),('P0501','المدينة'),('P0502','المدينة'),('P0503','المدينة'),('P0504','المدينة'),('P0505','المدينة'),('P0506','المدينة'),('P0507','المدينة'),('P0508','المدينة'),('P0509','المدينة'),('P0601','تبوك'),('P0602','تبوك'),('P0603','تبوك'),('P0604','تبوك'),('P0605','تبوك'),('P0606','تبوك'),('P0607','تبوك'),('P0608','تبوك'),('P0609','تبوك'),('P0701','الشرقية') ON CONFLICT DO NOTHING;

CREATE TABLE public.orders (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  order_date DATE NOT NULL DEFAULT CURRENT_DATE,
  team public.app_role NOT NULL CHECK (team IN ('customer_care','telesales')),
  agent_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE RESTRICT,
  order_type TEXT NOT NULL,
  branch_no TEXT REFERENCES public.branches(branch_no),
  delivery_type TEXT,
  order_no TEXT,
  invoice_no TEXT,
  invoice_value NUMERIC(12,2),
  notes TEXT,
  status TEXT NOT NULL DEFAULT 'Pending',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX orders_date_idx ON public.orders(order_date DESC);
CREATE INDEX orders_agent_idx ON public.orders(agent_id);
CREATE INDEX orders_branch_idx ON public.orders(branch_no);
CREATE INDEX orders_team_idx ON public.orders(team);

GRANT SELECT, INSERT, UPDATE, DELETE ON public.orders TO authenticated;
GRANT ALL ON public.orders TO service_role;
ALTER TABLE public.orders ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Agents view all orders" ON public.orders FOR SELECT TO authenticated USING (true);
CREATE POLICY "Active agents insert own orders" ON public.orders FOR INSERT TO authenticated
  WITH CHECK (auth.uid() = agent_id AND public.is_active(auth.uid()));
CREATE POLICY "Agents update own orders or admin" ON public.orders FOR UPDATE TO authenticated
  USING (auth.uid() = agent_id OR public.has_role(auth.uid(),'admin'))
  WITH CHECK (auth.uid() = agent_id OR public.has_role(auth.uid(),'admin'));
CREATE POLICY "Admins delete orders" ON public.orders FOR DELETE TO authenticated
  USING (public.has_role(auth.uid(),'admin'));

CREATE OR REPLACE FUNCTION public.set_updated_at() RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN NEW.updated_at = now(); RETURN NEW; END; $$;
CREATE TRIGGER orders_updated BEFORE UPDATE ON public.orders FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();
CREATE TRIGGER profiles_updated BEFORE UPDATE ON public.profiles FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

CREATE OR REPLACE FUNCTION public.handle_new_user() RETURNS TRIGGER LANGUAGE plpgsql SECURITY DEFINER SET search_path=public AS $$
BEGIN
  INSERT INTO public.profiles (id, full_name, agent_code, active)
  VALUES (
    NEW.id,
    COALESCE(NEW.raw_user_meta_data->>'full_name', split_part(NEW.email,'@',1)),
    NEW.raw_user_meta_data->>'agent_code',
    true
  );
  INSERT INTO public.user_roles (user_id, role)
  VALUES (NEW.id, COALESCE((NEW.raw_user_meta_data->>'role')::public.app_role, 'customer_care'));
  RETURN NEW;
END; $$;
CREATE TRIGGER on_auth_user_created AFTER INSERT ON auth.users
  FOR EACH ROW EXECUTE FUNCTION public.handle_new_user();