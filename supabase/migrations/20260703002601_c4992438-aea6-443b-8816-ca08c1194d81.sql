CREATE TABLE public.yeastar_extension_map (
  ext_num TEXT PRIMARY KEY,
  agent_name TEXT NOT NULL,
  team TEXT NOT NULL CHECK (team IN ('customer_care','telesales')),
  agent_code TEXT,
  active BOOLEAN NOT NULL DEFAULT true,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
GRANT SELECT ON public.yeastar_extension_map TO authenticated;
GRANT ALL ON public.yeastar_extension_map TO service_role;
ALTER TABLE public.yeastar_extension_map ENABLE ROW LEVEL SECURITY;
CREATE POLICY "auth can read yeastar map"
  ON public.yeastar_extension_map FOR SELECT
  TO authenticated USING (true);
CREATE POLICY "admins manage yeastar map"
  ON public.yeastar_extension_map FOR ALL
  TO authenticated
  USING (public.is_administrator(auth.uid()))
  WITH CHECK (public.is_administrator(auth.uid()));
CREATE TRIGGER yeastar_extension_map_updated
  BEFORE UPDATE ON public.yeastar_extension_map
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();