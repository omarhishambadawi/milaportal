-- Bootstrap the platform's first Owner.
--
-- WHY THIS IS NEEDED
--
-- The Owner model is self-perpetuating by design: adminSetRole and
-- adminCreateUser both refuse `owner` unless the caller is already an Owner
-- (admin.functions.ts), and the "Grant Owner..." menu item is gated on
-- `callerIsOwner`. The genesis case was never implemented -- there is no seed,
-- script, CLI or endpoint anywhere in the repository that can mint the first
-- Owner, and `promote_to_owner()` is referenced in code comments but was never
-- written. The project has run with `owner_accounts = 0` since inception, which
-- is why every Owner-tier protection has been dormant.
--
-- This migration performs that one act, once, for one named account.
--
-- SAFETY PROPERTIES
--
--   * Idempotent. Re-running is a no-op: if the account already holds `owner`
--     the block returns before touching anything, and writes no audit row.
--   * Scoped to exactly one account, resolved by email. No other user's rows are
--     read for modification or written.
--   * Replaces rather than adds. The account's existing non-owner role rows are
--     deleted in the same statement block before `owner` is inserted, so it ends
--     with exactly one role row. This matters: has_permission() resolves the
--     role with `SELECT ... LIMIT 1` and no ORDER BY, so an account holding two
--     rows gets a nondeterministic answer, and getRole() in admin.functions.ts
--     reads with .maybeSingle(), which turns a second row into an error
--     surfaced as "Forbidden: authorization check failed".
--   * Creates no user. The account must already exist in auth.users; if it does
--     not, the migration reports and exits rather than failing, so it is safe to
--     run against an environment where this person has no account.
--   * Touches no other table. profiles, orders, complaints and every
--     relationship are untouched.
--   * Auditable. Records the grant in admin_activity under the same
--     `user.owner_granted` action adminSetRole uses, so one predicate finds
--     every Owner grant including this one. actor_id is NULL -- the column is
--     nullable precisely so a system action can be recorded -- and details mark
--     it as the bootstrap.
--
-- Deliberately NOT included: the owner-protection triggers. trg_protect_last_owner
-- and trg_protect_owner_profile come from 20260721001200 and are a separate
-- decision; enabling them is what makes this grant irreversible.

DO $$
DECLARE
  _email    text := 'omarhishambadawi@gmail.com';
  _user_id  uuid;
  _previous text;
BEGIN
  SELECT id INTO _user_id
  FROM auth.users
  WHERE lower(email) = lower(_email)
  LIMIT 1;

  IF _user_id IS NULL THEN
    RAISE NOTICE 'Owner bootstrap skipped: no account found for %', _email;
    RETURN;
  END IF;

  -- Already an Owner: nothing to do. This is the idempotency guard.
  IF EXISTS (
    SELECT 1 FROM public.user_roles
    WHERE user_id = _user_id AND role = 'owner'::public.app_role
  ) THEN
    RAISE NOTICE 'Owner bootstrap skipped: % is already an Owner', _email;
    RETURN;
  END IF;

  SELECT string_agg(role::text, ',' ORDER BY role::text) INTO _previous
  FROM public.user_roles WHERE user_id = _user_id;

  -- Replace, do not accumulate. UNIQUE(user_id, role) would stop a duplicate
  -- `owner` row, but nothing stops an account carrying owner AND admin, which is
  -- the state that breaks role resolution.
  DELETE FROM public.user_roles
  WHERE user_id = _user_id AND role <> 'owner'::public.app_role;

  INSERT INTO public.user_roles (user_id, role)
  VALUES (_user_id, 'owner'::public.app_role)
  ON CONFLICT (user_id, role) DO NOTHING;

  -- Best-effort audit. Guarded on the table existing so this migration stays
  -- runnable against an environment that predates 20260725183037.
  IF to_regclass('public.admin_activity') IS NOT NULL THEN
    INSERT INTO public.admin_activity (actor_id, target_user_id, action, details)
    VALUES (
      NULL,
      _user_id,
      'user.owner_granted',
      jsonb_build_object(
        'targetEmail', _email,
        'from', _previous,
        'to', 'owner',
        'bootstrap', true,
        'migration', '20260726001000_bootstrap_first_owner'
      )
    );
  END IF;

  RAISE NOTICE 'Owner bootstrap complete: % promoted from % to owner', _email, COALESCE(_previous, '(no role)');
END;
$$;
