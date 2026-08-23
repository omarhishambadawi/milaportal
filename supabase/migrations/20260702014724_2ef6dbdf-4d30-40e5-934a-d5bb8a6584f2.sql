-- Persistent Yeastar token cache (single row, service-role only).
-- Used by the server-side auth flow as the second-tier cache across
-- Cloudflare Worker isolates. RLS blocks all direct client access; only
-- service_role (used via supabaseAdmin inside server functions) can read/write.

CREATE TABLE public.yeastar_token_cache (
  id                    text PRIMARY KEY DEFAULT 'singleton',
  access_token          text        NOT NULL,
  refresh_token         text,
  expires_at            timestamptz NOT NULL,
  refresh_expires_at    timestamptz,
  cred_fingerprint      text        NOT NULL,
  auth_blocked_until    timestamptz,
  last_error            text,
  updated_at            timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT yeastar_token_cache_singleton CHECK (id = 'singleton')
);

GRANT ALL ON public.yeastar_token_cache TO service_role;

ALTER TABLE public.yeastar_token_cache ENABLE ROW LEVEL SECURITY;

-- No policies for anon/authenticated → RLS denies all Data-API access.
-- Only server functions using supabaseAdmin (service_role) can read/write.

CREATE TRIGGER yeastar_token_cache_set_updated_at
  BEFORE UPDATE ON public.yeastar_token_cache
  FOR EACH ROW
  EXECUTE FUNCTION public.set_updated_at();