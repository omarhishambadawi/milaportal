-- Security verification -- run against the live database after deploying.
--
-- Read-only. Emits one row per invariant introduced by the security sprints
-- with a PASS/FAIL verdict, so deployment can be confirmed without reading
-- every migration by hand.
--
--   psql "$DATABASE_URL" -f supabase/verify/security_verification.sql
--   -- or paste into the Supabase SQL editor
--
-- Every FAIL means the corresponding migration has not been applied (or was
-- reverted). Nothing here writes.

\echo '=== MilaServ security verification ==='

WITH checks AS (

  -- 1. RLS enabled on every application table -----------------------------
  SELECT
    'RLS enabled: ' || c.relname AS check_name,
    c.relrowsecurity AS passed,
    CASE WHEN c.relrowsecurity THEN 'on' ELSE 'RLS IS OFF' END AS detail
  FROM pg_class c
  JOIN pg_namespace n ON n.oid = c.relnamespace
  WHERE n.nspname = 'public'
    AND c.relkind = 'r'
    AND c.relname IN (
      'profiles','user_roles','orders','complaints','branches','notifications',
      'order_activity','complaint_activity','satisfaction_surveys',
      'admin_activity',
      'cdr_progress','yeastar_token_cache','yeastar_extension_map'
    )

  UNION ALL

  -- 2. anon must NOT hold EXECUTE on the authorization RPCs ---------------
  --    (Sprint 2: unauthenticated authorization oracle)
  SELECT
    'anon cannot execute ' || p.proname,
    NOT has_function_privilege('anon', p.oid, 'EXECUTE'),
    CASE WHEN has_function_privilege('anon', p.oid, 'EXECUTE')
         THEN 'ANON CAN EXECUTE -- oracle is open'
         ELSE 'revoked' END
  FROM pg_proc p
  JOIN pg_namespace n ON n.oid = p.pronamespace
  WHERE n.nspname = 'public'
    AND p.proname IN ('has_role','has_permission','is_active','is_administrator','is_owner')

  UNION ALL

  -- 3. profiles: authenticated UPDATE limited to safe columns -------------
  --    (Sprint 2: yeastar_ext horizontal privilege escalation)
  SELECT
    'profiles UPDATE not granted table-wide to authenticated',
    NOT has_table_privilege('authenticated', 'public.profiles', 'UPDATE'),
    CASE WHEN has_table_privilege('authenticated', 'public.profiles', 'UPDATE')
         THEN 'TABLE-WIDE UPDATE STILL GRANTED'
         ELSE 'table-wide revoked (column grants apply)' END

  UNION ALL

  SELECT
    'profiles UPDATE(' || col || ') granted to authenticated',
    has_column_privilege('authenticated', 'public.profiles', col, 'UPDATE'),
    CASE WHEN has_column_privilege('authenticated', 'public.profiles', col, 'UPDATE')
         THEN 'granted' ELSE 'MISSING -- self profile edit will fail' END
  FROM unnest(ARRAY['full_name','avatar_url']) AS col

  UNION ALL

  SELECT
    'profiles UPDATE(yeastar_ext) NOT granted to authenticated',
    NOT has_column_privilege('authenticated', 'public.profiles', 'yeastar_ext', 'UPDATE'),
    CASE WHEN has_column_privilege('authenticated', 'public.profiles', 'yeastar_ext', 'UPDATE')
         THEN 'ESCALATION OPEN -- agents can retarget their PBX extension'
         ELSE 'revoked' END

  UNION ALL

  -- 3b. profiles: sensitive columns unreadable by authenticated ------------
  --     The real confidentiality boundary on this table -- the SELECT policy is
  --     intentionally open at row level (20260725200000).
  SELECT
    'profiles SELECT(' || col || ') NOT granted to authenticated',
    NOT has_column_privilege('authenticated', 'public.profiles', col, 'SELECT'),
    CASE WHEN has_column_privilege('authenticated', 'public.profiles', col, 'SELECT')
         THEN 'COLUMN IS READABLE -- the directory grant has been widened'
         ELSE 'not granted' END
  FROM unnest(ARRAY['permissions','yeastar_ext','must_change_password']) AS col

  UNION ALL

  -- 3c. profiles: exactly one SELECT policy --------------------------------
  --     Two existed until 20260725200000, and because policies are OR-ed the
  --     open one shadowed the scoped one entirely. A second policy reappearing
  --     means someone has added a row-scoping predicate that cannot take effect.
  SELECT
    'profiles has exactly one SELECT policy',
    (SELECT count(*) FROM pg_policy pol
      WHERE pol.polrelid = 'public.profiles'::regclass AND pol.polcmd = 'r') = 1,
    'select policies = ' || (SELECT count(*)::text FROM pg_policy pol
      WHERE pol.polrelid = 'public.profiles'::regclass AND pol.polcmd = 'r')

  UNION ALL

  -- 3d. admin_activity is append-only --------------------------------------
  --     An audit trail that can be rewritten afterwards is worth little. No
  --     UPDATE or DELETE grant exists for anyone, service_role included.
  SELECT
    'admin_activity: ' || role_name || ' cannot ' || priv,
    NOT has_table_privilege(role_name, 'public.admin_activity', priv),
    CASE WHEN has_table_privilege(role_name, 'public.admin_activity', priv)
         THEN 'GRANTED -- the audit trail is rewritable'
         ELSE 'revoked' END
  FROM unnest(ARRAY['authenticated','service_role']) AS role_name,
       unnest(ARRAY['UPDATE','DELETE']) AS priv

  UNION ALL

  -- 4. Triggers that enforce the security invariants ----------------------
  SELECT
    'trigger active: ' || t.tgname,
    NOT t.tgisinternal AND t.tgenabled <> 'D',
    CASE WHEN t.tgenabled = 'D' THEN 'DISABLED' ELSE 'enabled' END
  FROM pg_trigger t
  WHERE t.tgname IN (
    'trg_prevent_profile_escalation',
    'trg_prevent_order_reassignment',
    'trg_protect_last_owner',
    'trg_protect_owner_profile'
  )

  UNION ALL

  -- 5. supervisor exists in the role enum ---------------------------------
  SELECT
    'app_role contains supervisor',
    EXISTS (
      SELECT 1 FROM pg_enum e
      JOIN pg_type ty ON ty.oid = e.enumtypid
      WHERE ty.typname = 'app_role' AND e.enumlabel = 'supervisor'
    ),
    'enum value'

  UNION ALL

  -- 6. Exactly-at-least-one Owner ----------------------------------------
  SELECT
    'at least one Owner exists',
    (SELECT count(*) FROM public.user_roles WHERE role = 'owner') >= 1,
    'owners = ' || (SELECT count(*)::text FROM public.user_roles WHERE role = 'owner')

  UNION ALL

  -- 7. avatars bucket is private and constrained --------------------------
  SELECT
    'avatars bucket private',
    NOT COALESCE(b.public, true),
    CASE WHEN COALESCE(b.public, true) THEN 'BUCKET IS PUBLIC' ELSE 'private' END
  FROM storage.buckets b WHERE b.id = 'avatars'

  UNION ALL

  SELECT
    'avatars bucket has size + MIME limits',
    b.file_size_limit IS NOT NULL AND b.allowed_mime_types IS NOT NULL,
    'size=' || COALESCE(b.file_size_limit::text, 'unset') ||
    ' mime=' || COALESCE(array_to_string(b.allowed_mime_types, ','), 'unset')
  FROM storage.buckets b WHERE b.id = 'avatars'
)
SELECT
  CASE WHEN passed THEN 'PASS' ELSE '*** FAIL ***' END AS verdict,
  check_name,
  detail
FROM checks
ORDER BY passed, check_name;

\echo ''
\echo '=== Applied migrations (expect the 20260721* security set) ==='
SELECT version, name
FROM supabase_migrations.schema_migrations
WHERE version >= '20260720'
ORDER BY version;

\echo ''
\echo '=== SECURITY DEFINER functions missing a pinned search_path (expect 0 rows) ==='
SELECT n.nspname || '.' || p.proname AS function
FROM pg_proc p
JOIN pg_namespace n ON n.oid = p.pronamespace
WHERE n.nspname = 'public'
  AND p.prosecdef
  AND NOT EXISTS (
    SELECT 1 FROM unnest(COALESCE(p.proconfig, '{}')) cfg
    WHERE cfg LIKE 'search_path=%'
  );

\echo ''
\echo '=== Tables with RLS enabled but ZERO policies (deny-all -- intentional for service_role-only tables) ==='
SELECT c.relname,
       CASE WHEN c.relname IN ('cdr_progress','yeastar_token_cache')
            THEN 'expected: service_role only'
            ELSE 'REVIEW: no policy means no authenticated access' END AS note
FROM pg_class c
JOIN pg_namespace n ON n.oid = c.relnamespace
WHERE n.nspname = 'public' AND c.relkind = 'r' AND c.relrowsecurity
  AND NOT EXISTS (SELECT 1 FROM pg_policy pol WHERE pol.polrelid = c.oid)
ORDER BY c.relname;
