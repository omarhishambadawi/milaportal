-- Hotfix: restore public.is_owner(uuid).
--
-- WHY THIS EXISTS SEPARATELY FROM 20260721001200_owner_protection.sql
--
-- That migration declares three objects: is_owner(), trg_protect_last_owner and
-- trg_protect_owner_profile (plus a redefinition of prevent_profile_escalation
-- that 20260725200000 later supersedes). It was committed
-- in c28f3f7 alongside the application code that depends on it, but it was never
-- applied to this project -- `supabase_migrations.schema_migrations` jumps from
-- 20260709174246 to 20260723022830, and the only later entries are the three
-- Lovable snapshots (20260725183037 / 183130 / 183210), none of which define
-- is_owner under any name.
--
-- The consequence is a total outage of the admin write paths. `isOwner()` in
-- src/lib/admin.functions.ts calls `supabase.rpc("is_owner", ...)`; PostgREST
-- answers with an error for an undefined function; the helper treats ANY error
-- as a failed check and throws "Forbidden: authorization check failed". Because
-- `assertMayActOnTarget()` runs at the head of adminUpdateProfile, adminSetRole,
-- adminSetPassword and adminSendPasswordReset, every one of them fails for every
-- caller and every target -- not only for legacy accounts.
--
-- Only the FUNCTION is extracted here, deliberately. The two triggers in the
-- original migration enforce "at least one Owner must always remain" and "an
-- Owner cannot be deactivated or deleted". This project currently has
-- `owner_accounts = 0`, so creating trg_protect_last_owner against that state is
-- an unverified interaction and a separate decision. Nothing here creates an
-- Owner, protects an Owner, or touches a single row.
--
-- Verified before writing this: the body depends only on public.user_roles
-- (present), its user_id uuid / role app_role columns (present), the app_role
-- enum label 'owner' (present, sortorder 5), and the authenticated / service_role
-- / anon roles (all present). The name public.is_owner is unused, and no policy,
-- function, view or check constraint in the database references it -- so this is
-- a pure addition that cannot alter the behaviour of any existing object.
--
-- The function definition below is copied byte-for-byte from
-- 20260721001200_owner_protection.sql.
--
-- Do not modify the function body in this migration.
-- Security grants are documented separately below.

-- NOTE:
-- One additional statement is intentionally included:
--
--   REVOKE EXECUTE ON FUNCTION public.is_owner(uuid) FROM PUBLIC;
--
-- PostgreSQL grants EXECUTE on new functions to PUBLIC by default.
-- The original migration revoked only FROM anon, which does not remove
-- inherited PUBLIC privileges.
--
-- This follows the existing secure pattern used by public.get_my_profile().

-- Convenience predicate, mirroring is_administrator().
CREATE OR REPLACE FUNCTION public.is_owner(_user_id uuid)
RETURNS boolean
LANGUAGE sql
STABLE SECURITY DEFINER
SET search_path = public
AS $$
  SELECT EXISTS (
    SELECT 1 FROM public.user_roles
    WHERE user_id = _user_id AND role = 'owner'::public.app_role
  )
$$;

GRANT EXECUTE ON FUNCTION public.is_owner(uuid) TO authenticated, service_role;
REVOKE EXECUTE ON FUNCTION public.is_owner(uuid) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.is_owner(uuid) FROM anon;
