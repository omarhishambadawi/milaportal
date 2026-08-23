DROP FUNCTION IF EXISTS public.yeastar_try_claim_auth_lease(text, integer);
DROP FUNCTION IF EXISTS public.yeastar_release_auth_lease(text);
DROP TABLE IF EXISTS public.yeastar_token_cache CASCADE;