-- Telesales CRM: correct the function grants.
--
-- ===========================================================================
-- `REVOKE ... FROM anon` never did anything
-- ===========================================================================
-- Every function in this module was written with the pair
--
--     GRANT  EXECUTE ON FUNCTION ... TO authenticated, service_role;
--     REVOKE EXECUTE ON FUNCTION ... FROM anon;
--
-- and the second line is a no-op. Postgres grants EXECUTE on a new function to
-- `PUBLIC` by default, and `anon` inherits that; revoking the role's *own*
-- grant leaves the inherited one untouched. Verified against the live database:
-- `has_function_privilege('anon', 'telesales_management_summary(date)',
-- 'EXECUTE')` returned true.
--
-- ---------------------------------------------------------------------------
-- Nothing was actually exposed
-- ---------------------------------------------------------------------------
-- Worth stating plainly rather than overstating the finding. All four callable
-- functions open with
--
--     IF NOT public.has_permission(auth.uid(), '…') THEN RAISE EXCEPTION
--
-- and an unauthenticated PostgREST request carries no JWT, so `auth.uid()` is
-- NULL, `has_permission` returns false on its first branch, and the call is
-- refused. The runtime behaviour was correct throughout.
--
-- What was wrong is the *declaration*: the catalogue said `anon` may execute
-- these, which is not what the module intends and not what a reviewer reading
-- the grants would conclude. The next function added without an internal guard
-- would have been genuinely reachable, and that is the failure this closes.
--
-- The three trigger functions are revoked from everyone: they take a trigger
-- context and calling them directly is meaningless.

REVOKE EXECUTE ON FUNCTION public.telesales_management_summary(date)       FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.telesales_agent_workload(date)           FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.telesales_contact_history(text, integer) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.telesales_import_summary(integer)        FROM PUBLIC;

GRANT EXECUTE ON FUNCTION public.telesales_management_summary(date)       TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.telesales_agent_workload(date)           TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.telesales_contact_history(text, integer) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.telesales_import_summary(integer)        TO authenticated, service_role;

-- SECURITY DEFINER with no guard of its own, reached only through a server
-- function that has already checked `manage_telesales`.
REVOKE EXECUTE ON FUNCTION public.telesales_archive_impact(uuid) FROM PUBLIC, authenticated;
GRANT  EXECUTE ON FUNCTION public.telesales_archive_impact(uuid) TO service_role;

REVOKE EXECUTE ON FUNCTION public.telesales_sync_next_followup()    FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.telesales_sync_last_contact()     FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.telesales_activity_is_immutable() FROM PUBLIC, anon, authenticated;
