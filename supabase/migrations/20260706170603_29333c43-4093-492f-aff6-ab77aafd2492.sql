ALTER TABLE public.profiles ADD COLUMN IF NOT EXISTS yeastar_ext text;
CREATE INDEX IF NOT EXISTS profiles_yeastar_ext_idx ON public.profiles(yeastar_ext);
COMMENT ON COLUMN public.profiles.yeastar_ext IS 'Yeastar PBX extension number used to attribute CDRs to this agent';