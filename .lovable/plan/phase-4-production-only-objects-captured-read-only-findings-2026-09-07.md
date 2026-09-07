# Phase 4 — Production-only objects captured (read-only findings)

Nothing was modified, fixed, committed or published. No secret value, no row of user data and no credential is reproduced below.

## 1. The two production-only email queue functions

Both are `SECURITY DEFINER`, `SET search_path TO ''`, and both call out to a Lovable-hosted endpoint using a Vault-stored key. The key lookup is shown as-is (name only, never the value); the endpoint URL is Lovable-specific and marked for replacement.

```sql
CREATE OR REPLACE FUNCTION public.email_queue_dispatch()
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pgmq.q_auth_emails)
     AND NOT EXISTS (SELECT 1 FROM pgmq.q_transactional_emails) THEN
    BEGIN
      -- Serialize disarm against email_queue_wake on a shared advisory lock, then
      -- re-read under it: an enqueue racing the unschedule either committed (we
      -- see its row and leave the cron) or waits and re-arms after we commit.
      PERFORM pg_catalog.pg_advisory_xact_lock(7700000000000001);
      IF EXISTS (SELECT 1 FROM pgmq.q_auth_emails)
         OR EXISTS (SELECT 1 FROM pgmq.q_transactional_emails) THEN
        RETURN;
      END IF;
      PERFORM cron.unschedule('process-email-queue');
    EXCEPTION WHEN OTHERS THEN
      RAISE WARNING 'email_queue_dispatch: cron unschedule failed: %', SQLERRM;
    END;
    RETURN;
  END IF;

  IF (SELECT retry_after_until FROM public.email_send_state WHERE id = 1) > now() THEN
    RETURN;
  END IF;

  PERFORM net.http_post(
    url := '<<REDACTED:host-specific email queue endpoint — replace with the self-hosted /lovable/email/queue/process equivalent>>',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'Lovable-Context', 'cron',
      'Authorization', 'Bearer ' || (
        SELECT decrypted_secret FROM vault.decrypted_secrets WHERE name = 'email_queue_service_role_key'
      )
    ),
    body := '{}'::jsonb
  );
END;
$function$
```

```sql
CREATE OR REPLACE FUNCTION public.email_queue_wake()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
BEGIN
  -- Runs inside the enqueue transaction; the outer handler guarantees nothing
  -- below can roll back the customer's email. Shared advisory lock serializes
  -- arming against email_queue_dispatch's disarm.
  PERFORM pg_catalog.pg_advisory_xact_lock(7700000000000001);
  IF NOT EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'process-email-queue') THEN
    BEGIN
      PERFORM cron.schedule('process-email-queue', '5 seconds', $cron$ SELECT public.email_queue_dispatch(); $cron$);
    EXCEPTION WHEN OTHERS THEN
      RAISE WARNING 'email_queue_wake: cron schedule failed: %', SQLERRM;
    END;
  END IF;

  BEGIN
    PERFORM net.http_post(
      url := '<<REDACTED:host-specific email queue endpoint — same replacement as above>>',
      headers := jsonb_build_object(
        'Content-Type', 'application/json',
        'Lovable-Context', 'cron',
        'Authorization', 'Bearer ' || (
          SELECT decrypted_secret FROM vault.decrypted_secrets WHERE name = 'email_queue_service_role_key'
        )
      ),
      body := '{}'::jsonb
    );
  EXCEPTION WHEN OTHERS THEN NULL;
  END;

  RETURN NULL;
EXCEPTION WHEN OTHERS THEN
  RAISE WARNING 'email_queue_wake failed (enqueue preserved): %', SQLERRM;
  RETURN NULL;
END;
$function$
```

Dependencies to recreate on the new server: the `pgmq` queues `auth_emails` / `transactional_emails`, the `public.email_send_state` row with `id = 1`, the dynamic `process-email-queue` cron entry (created and removed by these functions themselves, so it must not be pre-seeded), and the Vault secret `email_queue_service_role_key` (name only — the value must be re-entered by hand).

## 2. Current avatar storage access rules

Four policies on `storage.objects`, exactly as they stand in production:

```sql
CREATE POLICY avatars_public_read ON storage.objects
  FOR SELECT TO public
  USING (bucket_id = 'avatars');

CREATE POLICY avatars_owner_insert ON storage.objects
  FOR INSERT TO authenticated
  WITH CHECK (bucket_id = 'avatars' AND (storage.foldername(name))[1] = auth.uid()::text);

CREATE POLICY avatars_owner_update ON storage.objects
  FOR UPDATE TO authenticated
  USING (bucket_id = 'avatars' AND (storage.foldername(name))[1] = auth.uid()::text)
  WITH CHECK (bucket_id = 'avatars' AND (storage.foldername(name))[1] = auth.uid()::text);

CREATE POLICY avatars_owner_delete ON storage.objects
  FOR DELETE TO authenticated
  USING (bucket_id = 'avatars' AND (storage.foldername(name))[1] = auth.uid()::text);
```

Two observations, recorded and not changed:

- Writes are correctly confined to each user's own `<uid>/` folder, matching the path convention in `src/lib/avatar.ts`.
- The read rule is granted to `public`, i.e. any caller including anonymous ones, for every object in the bucket. The bucket itself is private, so reads still require a signed URL, but the row-level rule is wider than the "server boundary only" intent described in the verification script.

## 3. Missing database-level last-Owner protection

Confirmed absent. The only user-facing triggers present are:

- `profiles` → `profiles_prevent_escalation` (`prevent_profile_escalation`), `profiles_updated` (`set_updated_at`)
- `user_roles` → `reject_retired_roles_trg` (`reject_retired_roles`)

`supabase/verify/security_verification.sql` expects `trg_protect_last_owner` and `trg_protect_owner_profile`; neither exists in production, and no `protect_last_owner` function exists either. `public.is_owner()` exists, but it only reads a role — it enforces nothing. There is currently exactly **one** Owner in `user_roles`, so a single delete, role change, or profile deactivation would leave the portal with no Owner and no way back in through the UI.

Required safeguard (description only, not implemented): a `BEFORE DELETE OR UPDATE` trigger on `public.user_roles` that raises an exception when the statement would remove or rewrite the last remaining `owner` row — counting owners excluding the affected row and refusing when the count reaches zero — plus a companion `BEFORE UPDATE` trigger on `public.profiles` that refuses to set `active = false` for a user who is the last Owner. Both must be `SECURITY DEFINER` with a pinned `search_path`, and must apply to `service_role` as well, since admin server functions run under it.

## 4. Ad-hoc August invoice backfill table — exclude from migration

- Name: `public.orders_verification_snapshot_20260815`
- Kind: ordinary table, RLS enabled, **zero policies** (so effectively unreachable except by `service_role`), **zero indexes**, no primary key
- Rows: 3,837 — a point-in-time copy taken during the 15 August invoice-flag backfill
- Columns (17): `order_id uuid`, `display_no text`, `order_date date`, `invoice_no text`, `status text`, `agent_id uuid`, `team app_role`, `snapshot_call_center_verified boolean`, `snapshot_invoices_verified boolean`, `snapshot_invoice_value numeric(12,2)`, `created_at timestamptz`, `updated_at timestamptz`, `last_manual_verified boolean`, `last_manual_at timestamptz`, `last_manual_actor uuid`, `has_manual_history boolean`, `captured_at timestamptz` — all nullable

It is a one-off audit artefact of a completed backfill, not application state: nothing in the codebase reads it. Exclude both its definition and its rows from the self-hosted migration; if the audit trail is worth keeping, archive it to a file rather than recreating the table.

No further action is proposed in this phase.
