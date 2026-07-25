-- Sprint D follow-up: an audit trail for administrative actions, and an expiry
-- for administrator-issued passwords.
--
-- ---------------------------------------------------------------------------
-- 1. Temporary password expiry
-- ---------------------------------------------------------------------------
--
-- A temporary password with no deadline is a permanent shared credential that
-- merely *asks* to be replaced. The expiry is what makes it temporary.
--
-- The nullable timestamp encodes three states together with must_change_password.
-- The encoding is subtle enough to be worth writing down once, here, and is
-- implemented in exactly one place in the app layer
-- (`temporaryPasswordState()` in src/lib/password-policy.ts):
--
--   must_change_password = false                    -> no issued password outstanding
--   true,  expires_at IS NOT NULL, expires_at > now -> live temporary password
--   true,  expires_at IS NOT NULL, expires_at <= now-> expired, not yet rotated
--   true,  expires_at IS NULL                       -> expired AND rotated: the
--                                                      credential no longer exists
--                                                      and only a recovery email
--                                                      can restore the account
--
-- The last state is why expiry has teeth rather than being a rendering rule:
-- when the app sees an expired password it calls `expireTemporaryPassword`,
-- which replaces the credential with a random value nobody holds. Honest
-- limitation: that rotation happens the next time the account is used against
-- this app. An expired password that is never presented to the app is not
-- revoked at the auth layer until then -- closing that fully needs a scheduled
-- job (pg_cron) to sweep expired rows, which is deliberately not added here.

ALTER TABLE public.profiles
  ADD COLUMN IF NOT EXISTS must_change_password_expires_at timestamptz;

COMMENT ON COLUMN public.profiles.must_change_password_expires_at IS
  'Deadline for replacing an administrator-issued password. NULL while '
  'must_change_password is true means the password has already been rotated away '
  'and the account is recoverable only by email. Written only via service_role.';

-- Same two layers as must_change_password: `authenticated` holds UPDATE only on
-- (full_name, avatar_url), and the escalation trigger guards the column in case
-- that grant is ever widened. Without this an agent could push their own
-- deadline forward indefinitely.
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

-- ---------------------------------------------------------------------------
-- 2. Administrative audit log
-- ---------------------------------------------------------------------------
--
-- Until now the only trace of "who reset whose password" was a console.log line
-- in the server process. `order_activity` and `complaint_activity` cover records;
-- nothing covered *accounts*, which is where the actions that matter to an
-- investigation live -- password resets, role grants, deactivations, deletions.
--
-- Three deliberate differences from order_activity:
--
--   * No INSERT grant to `authenticated`. order_activity and complaint_activity
--     both still carry one (from 20260624110459 / 20260701221219); writes are
--     refused today only because no INSERT *policy* survives on either table, so
--     RLS denies by default. For an audit log, resting on the absence of a policy
--     is too thin — one permissive policy added later and entries become
--     forgeable. Here the privilege itself is withheld.
--     (20260725004000 revokes those two dangling grants for the same reason.)
--   * No UPDATE or DELETE grant to ANYONE, service_role included. The log is
--     append-only by privilege rather than by convention, so a compromised
--     service key can add noise but cannot quietly erase a trail.
--   * No foreign key on target_user_id, and a denormalized snapshot of the
--     target in `details`. Deleting a user is itself an audited event; a
--     cascade or SET NULL would erase (or blank) the very records describing
--     the deletion.

CREATE TABLE IF NOT EXISTS public.admin_activity (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  -- Who acted. Nullable only so a future system/automated action can be recorded.
  actor_id uuid,
  -- Whom it was done to. Unconstrained on purpose (see above); the display name
  -- and email at the time of the action are snapshotted into `details`.
  target_user_id uuid,
  action text NOT NULL,
  details jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS admin_activity_created_at_idx
  ON public.admin_activity(created_at DESC);
CREATE INDEX IF NOT EXISTS admin_activity_target_idx
  ON public.admin_activity(target_user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS admin_activity_actor_idx
  ON public.admin_activity(actor_id, created_at DESC);

ALTER TABLE public.admin_activity ENABLE ROW LEVEL SECURITY;

-- Read: administrators only. Supervisor holds manage_users and so *appears* in
-- this log; letting the audited party read the log is a different decision from
-- letting them act, and it is deliberately not granted.
DROP POLICY IF EXISTS "Admin activity readable by administrators" ON public.admin_activity;
CREATE POLICY "Admin activity readable by administrators"
  ON public.admin_activity FOR SELECT TO authenticated
  USING (public.is_administrator(auth.uid()));

-- No INSERT/UPDATE/DELETE policy exists, and none should: every write path is
-- service_role, which bypasses RLS but is still bound by the grants below.
GRANT SELECT ON public.admin_activity TO authenticated;
GRANT SELECT, INSERT ON public.admin_activity TO service_role;
REVOKE UPDATE, DELETE ON public.admin_activity FROM authenticated, service_role;
