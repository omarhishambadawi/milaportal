-- Sprint D: administrator-issued passwords.
--
-- Until now an admin reset (adminSetPassword) produced a password that was
-- permanently the user's password: the administrator who typed it knew it, and
-- nothing ever asked the user to replace it. That is a shared credential, and it
-- silently defeats the self-service change flow added in Sprint B -- the user has
-- no reason to visit it, because the password they were handed keeps working.
--
-- This adds the one piece of state needed to treat an admin-issued password as a
-- *handover* credential rather than a permanent one: a flag saying "the password
-- on this account was set by someone else, and must be replaced before the
-- account is usable". The app blocks the entire authenticated surface on it (see
-- src/routes/_app.tsx) until the user sets their own.
--
-- Writability, deliberately narrow:
--   * No column-level UPDATE grant. 20260721000100 revoked the table-wide UPDATE
--     from `authenticated` and re-granted only (full_name, avatar_url), so a new
--     column is unwritable from a user session by construction -- a user cannot
--     clear their own flag with a direct PostgREST call. Only service_role (the
--     admin server functions) writes it.
--   * The escalation trigger below is the second layer, so the guard survives the
--     grant ever being widened again.
--
-- Readability: no SELECT grant either. `authenticated` may read only
-- (id, full_name, agent_code, active, created_at) on profiles; a user reads their
-- own flag through get_my_profile(), which is SECURITY DEFINER and so returns the
-- whole row -- including this column, automatically, since it is declared
-- RETURNS public.profiles and selects *.

ALTER TABLE public.profiles
  ADD COLUMN IF NOT EXISTS must_change_password boolean NOT NULL DEFAULT false;

COMMENT ON COLUMN public.profiles.must_change_password IS
  'True when the current password was issued by an administrator and has not yet '
  'been replaced by the account holder. Set by adminSetPassword when the reset is '
  'marked temporary; cleared by changeMyPassword and by the recovery flow. Written '
  'only via service_role -- authenticated holds no UPDATE grant on this column.';

-- Second layer: the escalation trigger. Reproduced in full (CREATE OR REPLACE
-- takes the whole body) with must_change_password added to the guarded set.
-- Admin paths are unaffected: they write through service_role, where auth.uid()
-- is NULL and the function returns early.
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
  IF NEW.id IS DISTINCT FROM OLD.id THEN
    RAISE EXCEPTION 'Not allowed to change id';
  END IF;
  RETURN NEW;
END;
$$;
