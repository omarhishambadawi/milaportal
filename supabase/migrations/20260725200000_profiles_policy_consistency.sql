-- Sprint E follow-up: the two profiles findings the audit reported but did not
-- change, plus one inconsistency in the escalation trigger.
--
-- Neither of these was a hole. Both were places where the schema *stated* a
-- protection it did not provide, which is the failure mode that produces the next
-- real hole: someone reads the policy, believes the row is scoped, and builds on
-- that belief.

-- ---------------------------------------------------------------------------
-- 1. profiles: one honest SELECT policy instead of two, one of them inert
-- ---------------------------------------------------------------------------
--
-- profiles carried two SELECT policies:
--
--   "Users view own profile or managed profiles"  (20260701224822)
--       USING (id = auth.uid() OR has_permission(…,'manage_users')
--                               OR has_permission(…,'view_all_agents'))
--   "Authenticated can view agent directory"      (20260702033343)
--       USING (true)
--
-- Policies are OR-ed, so the second admits every row the first would have
-- excluded and the first can never deny anything. The scoped policy has been
-- dead since the day after it was written.
--
-- The row-level openness is intentional and stays: the agent directory (order
-- forms, complaint forms, dashboards, activity timelines) needs to resolve every
-- agent's name, and `useAgentDirectory` reads the table directly. What actually
-- limits the exposure is the COLUMN-level grant from 20260707161549 —
-- `authenticated` may select only (id, full_name, agent_code, active,
-- created_at). permissions, yeastar_ext, avatar_url and the two
-- must_change_password columns are unreadable at PostgREST regardless of policy;
-- a user reads their own copy of those through get_my_profile(), which is
-- SECURITY DEFINER.
--
-- So the fix is to drop the policy that protects nothing and say plainly, on the
-- one that remains, where the real boundary is.
--
-- The one behavioural change: the surviving policy now carries
-- `is_active(auth.uid())`, which 20260725004000 applied to orders, complaints,
-- both activity timelines and surveys but not to profiles. A deactivated
-- account — someone who has left, or whose account was disabled because it was
-- compromised — could still enumerate every colleague's name and agent code for
-- as long as its token lasted. Deactivation now withholds this read too, which is
-- what it already means everywhere else.
--
-- Own-row reads are unaffected: get_my_profile() is SECURITY DEFINER and does not
-- consult this policy, so the deactivated-account screen still renders (it needs
-- profile.active, which is exactly what it reads).
--
-- Known and deliberately left alone: public.profile_directory is a plain
-- (non-security_invoker) view, so it runs as its owner and bypasses this policy
-- entirely. Nothing in the application reads it — it is a leftover from
-- 20260701224822 — so it is not a live bypass, and removing it is a separate
-- decision from this one.

DROP POLICY IF EXISTS "Users view own profile or managed profiles" ON public.profiles;

DROP POLICY IF EXISTS "Authenticated can view agent directory" ON public.profiles;
CREATE POLICY "Authenticated can view agent directory"
ON public.profiles
FOR SELECT
TO authenticated
USING (public.is_active(auth.uid()));

COMMENT ON POLICY "Authenticated can view agent directory" ON public.profiles IS
  'Row-level visibility is intentionally open to every ACTIVE authenticated user: '
  'the agent directory has to resolve any agent name. The confidentiality boundary '
  'on this table is the COLUMN-level SELECT grant (id, full_name, agent_code, '
  'active, created_at), not this policy. Sensitive columns (permissions, '
  'yeastar_ext, must_change_password*) are readable only via get_my_profile() for '
  'one''s own row, or by service_role. Do not add a row-scoping predicate here '
  'expecting it to hide columns -- widen or narrow the grant instead.';

-- ---------------------------------------------------------------------------
-- 2. prevent_profile_escalation: drop the admin bypass
-- ---------------------------------------------------------------------------
--
-- The guard opened with:
--
--   IF auth.uid() IS NULL OR public.has_role(auth.uid(), 'admin') THEN RETURN NEW;
--
-- Two problems, one cosmetic and one real.
--
-- Cosmetic: `has_role(…, 'admin')` is not the platform's administrator check.
-- Everything else — is_administrator(), isAdministrator(), has_permission()'s
-- short-circuit — treats owner and admin as equivalent, and this line did not, so
-- an Owner was the one administrator the trigger considered ordinary.
--
-- Real: the bypass has had no caller since privileged writes moved to
-- service_role. adminUpdateProfile, adminSetActive, adminSetPassword,
-- adminCreateUser and clearMustChangePassword all write through supabaseAdmin,
-- where auth.uid() IS NULL and the first clause already returns early. The only
-- profile write that still runs under a user session is updateMyProfile(), which
-- patches full_name/avatar_url — neither of them guarded here, and the only two
-- columns `authenticated` holds an UPDATE grant on (20260721000100).
--
-- So the correct repair is to remove the bypass rather than widen it to Owner:
-- widening would weaken a defence-in-depth layer to fix a naming inconsistency,
-- while removing it makes the trigger state what it now means — no session-based
-- caller may touch these columns, and privileged edits go through the admin
-- server functions. If an administrator path ever does need a direct session
-- write, it should re-enter through is_administrator(), never has_role().

CREATE OR REPLACE FUNCTION public.prevent_profile_escalation()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
BEGIN
  -- service_role (the admin server functions) only. Every other caller is
  -- checked, including owner and admin sessions.
  IF auth.uid() IS NULL THEN
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
  IF NEW.yeastar_ext IS DISTINCT FROM OLD.yeastar_ext THEN
    RAISE EXCEPTION 'Not allowed to change yeastar_ext';
  END IF;
  IF NEW.must_change_password IS DISTINCT FROM OLD.must_change_password THEN
    RAISE EXCEPTION 'Not allowed to change must_change_password';
  END IF;
  IF NEW.must_change_password_expires_at IS DISTINCT FROM OLD.must_change_password_expires_at THEN
    RAISE EXCEPTION 'Not allowed to change must_change_password_expires_at';
  END IF;
  IF NEW.id IS DISTINCT FROM OLD.id THEN
    RAISE EXCEPTION 'Not allowed to change id';
  END IF;
  RETURN NEW;
END;
$$;
