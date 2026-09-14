-- Self-hosted `avatars` bucket creation — PREPARED, NOT APPLIED.
--
-- Run this during the cutover window (runbook step 9.1, checklist C4), against
-- the SELF-HOSTED database only:
--
--   docker exec -i supabase-db psql -U postgres -d postgres \
--     -f - < docs/migration/cutover-avatars-bucket.sql
--
-- DELIBERATELY NOT A MIGRATION FILE. `supabase/config.toml` still names the
-- Lovable Cloud project, so anything under `supabase/migrations/` can be pushed
-- to Cloud by the CLI. Cloud already has this bucket; this script must never
-- reach it. Keeping the statement outside the migrations directory is what makes
-- that impossible rather than merely unlikely.
--
-- WHY EVERY COLUMN IS SPELLED OUT. `20260721002100_avatars_bucket_limits.sql` is
-- an `UPDATE ... WHERE id = 'avatars'`. It ran on self-hosted while no such
-- bucket existed, so it was a no-op and is already recorded as applied — it will
-- not re-fire after the bucket appears. A bucket created without these five
-- columns set therefore silently loses BOTH server-side upload guards (size and
-- MIME type) while looking correct, leaving only the bypassable client-side
-- checks in `_app.profile.tsx`.
--
-- Values are fixed by code already in the repository, not by an open decision:
--   name               `AVATAR_BUCKET`, src/lib/avatar.ts
--   public = false     src/lib/avatar.ts mints short-lived signed URLs
--                      (`AVATAR_SIGNED_TTL`) instead of serving public objects,
--                      and the RLS policies are owner-scoped
--   file_size_limit    4 MB, allowed_mime_types — 20260721002100
--
-- The 4 owner-scoped RLS policies (`avatars_owner_insert` / `_read` / `_update`
-- / `_delete`) are already attached to `storage.objects` and need no change:
-- they key off `bucket_id = 'avatars'` and `(storage.foldername(name))[1] =
-- auth.uid()::text`, so they start enforcing the moment the bucket exists.

BEGIN;

INSERT INTO storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
VALUES (
  'avatars',
  'avatars',
  false,
  4194304,  -- 4 MB
  ARRAY['image/png', 'image/jpeg', 'image/webp', 'image/gif']
)
ON CONFLICT (id) DO NOTHING;

COMMIT;

-- Verification. Expect exactly one row:
--   avatars | avatars | f | 4194304 | {image/png,image/jpeg,image/webp,image/gif} | STANDARD
--
-- A row with NULL file_size_limit or NULL allowed_mime_types means the bucket
-- pre-existed this script and the ON CONFLICT skipped it — apply the limits with
-- the UPDATE in 20260721002100 before continuing, do not re-run this insert.
SELECT id, name, public, file_size_limit, allowed_mime_types, type
FROM storage.buckets
WHERE id = 'avatars';

-- Expect the 4 owner-scoped policies:
--   avatars_owner_delete, avatars_owner_insert, avatars_owner_read, avatars_owner_update
SELECT policyname, cmd
FROM pg_policies
WHERE schemaname = 'storage' AND tablename = 'objects'
ORDER BY policyname;

-- Rollback, valid ONLY while the bucket is still empty (it is created empty, and
-- object migration is a separate step). Deleting a bucket that holds objects is
-- refused by the FK; do not force it.
--
--   DELETE FROM storage.buckets WHERE id = 'avatars'
--     AND NOT EXISTS (SELECT 1 FROM storage.objects WHERE bucket_id = 'avatars');
