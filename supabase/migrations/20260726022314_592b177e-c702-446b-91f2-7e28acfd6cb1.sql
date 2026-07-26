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

  IF EXISTS (
    SELECT 1 FROM public.user_roles
    WHERE user_id = _user_id AND role = 'owner'::public.app_role
  ) THEN
    RAISE NOTICE 'Owner bootstrap skipped: % is already an Owner', _email;
    RETURN;
  END IF;

  SELECT string_agg(role::text, ',' ORDER BY role::text) INTO _previous
  FROM public.user_roles WHERE user_id = _user_id;

  DELETE FROM public.user_roles
  WHERE user_id = _user_id AND role <> 'owner'::public.app_role;

  INSERT INTO public.user_roles (user_id, role)
  VALUES (_user_id, 'owner'::public.app_role)
  ON CONFLICT (user_id, role) DO NOTHING;

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