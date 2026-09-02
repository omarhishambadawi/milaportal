-- Telesales CRM: one canonical phone format.
--
-- ===========================================================================
-- What changes
-- ===========================================================================
-- The module was written storing E.164 (`+966504630565`) in a column called
-- `phone_e164`. The desk, the pharmacy's own systems and every one of the three
-- source workbooks use the Saudi national format instead:
--
--     0504630565
--
-- Ten digits, leading zero, no separators. That is now the CRM's one stored
-- representation, so the column is renamed to `phone` — leaving a column called
-- `phone_e164` holding `0504630565` would be a lie that every future reader has
-- to discover for themselves.
--
--   telesales_source_records.phone_e164   -> phone       (+ phone_rejection,
--                                                          phone_alternates)
--   telesales_leads.phone_e164            -> phone       (+ phone_alternates)
--   telesales_patient_contacts.phone_e164 -> phone
--
-- `phone_raw` is untouched and keeps doing its job: the cell exactly as it
-- arrived, for audit. It is never the CRM's phone value.
--
-- ===========================================================================
-- Whether there is any data to migrate
-- ===========================================================================
-- Checked rather than assumed. `src/integrations/supabase/types.ts` is
-- regenerated from the live schema and contains no `telesales_` table at all,
-- while every other table in this database is present in it — so the migrations
-- that create these tables had not been applied when this one was written, and
-- there are no rows to convert.
--
-- This migration does not depend on that being true. Everything below is
-- guarded and idempotent, and the backfill converts whatever it finds:
--
--   * A value already in the canonical form is left alone.
--   * `+9665XXXXXXXX` / `9665XXXXXXXX` / `5XXXXXXXX` become `05XXXXXXXX`.
--   * Anything that is not a Saudi mobile is set to NULL, with `phone_raw`
--     preserving what it was. Nothing is invented, and nothing that was never a
--     phone number becomes one.
--
-- ===========================================================================
-- Why the validation lives in SQL as well as in TypeScript
-- ===========================================================================
-- `src/lib/phone.ts` is the one implementation and every application path goes
-- through it. This function exists only to convert rows that predate it — it is
-- a migration tool, not a second definition, and nothing in the application
-- calls it. It is dropped at the end of this migration for exactly that reason:
-- an unused SQL copy of a business rule is the thing that drifts.

-- ===========================================================================
-- 1. New columns
-- ===========================================================================

ALTER TABLE public.telesales_source_records
  -- Why `phone` is NULL, so the import summary can group the reasons instead of
  -- reporting one undifferentiated count. Mirrors `PhoneRejection`.
  ADD COLUMN IF NOT EXISTS phone_rejection text,
  -- Numbers found on the row that are not the customer's own.
  --
  -- No phone *cell* in any of the three workbooks holds two numbers — that was
  -- measured, not assumed. The note columns hold 448: 167 on the four per-city
  -- Wasfaty sheets, which have no phone column at all and where agents wrote the
  -- number into the note, and 281 more on `Wasfaty Aug`, which does have one.
  --
  -- They are kept and never promoted. The Retention sheet's single example is
  -- `0509736898 رقم زوجه العميل اللي تستخدم الابر` — the customer's *wife's*
  -- number — which is the whole argument: "a number appears on this row" and
  -- "this is the customer's number" are different claims.
  ADD COLUMN IF NOT EXISTS phone_alternates text[] NOT NULL DEFAULT '{}';

ALTER TABLE public.telesales_leads
  ADD COLUMN IF NOT EXISTS phone_alternates text[] NOT NULL DEFAULT '{}';

-- ===========================================================================
-- 2. Rename to the canonical name
-- ===========================================================================
-- Guarded so this migration is idempotent and so it does not care whether it
-- runs against a database where the creating migrations have already been
-- applied or one where they are applied in the same push.
DO $do$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
     WHERE table_schema = 'public' AND table_name = 'telesales_source_records'
       AND column_name = 'phone_e164'
  ) THEN
    ALTER TABLE public.telesales_source_records RENAME COLUMN phone_e164 TO phone;
  END IF;

  IF EXISTS (
    SELECT 1 FROM information_schema.columns
     WHERE table_schema = 'public' AND table_name = 'telesales_leads'
       AND column_name = 'phone_e164'
  ) THEN
    ALTER TABLE public.telesales_leads RENAME COLUMN phone_e164 TO phone;
  END IF;

  IF EXISTS (
    SELECT 1 FROM information_schema.columns
     WHERE table_schema = 'public' AND table_name = 'telesales_patient_contacts'
       AND column_name = 'phone_e164'
  ) THEN
    ALTER TABLE public.telesales_patient_contacts RENAME COLUMN phone_e164 TO phone;
  END IF;
END;
$do$;

-- ===========================================================================
-- 3. The one-shot converter
-- ===========================================================================
-- Deliberately mirrors `normalizeSaudiPhone` in `src/lib/phone.ts`, including
-- its refusals: `051` and `052` are not assigned to Saudi mobile and are not
-- coerced into something that looks valid.
CREATE OR REPLACE FUNCTION pg_temp.telesales_canonical_phone(_value text)
RETURNS text
LANGUAGE plpgsql
IMMUTABLE
AS $$
DECLARE
  _digits text;
BEGIN
  IF _value IS NULL THEN RETURN NULL; END IF;

  -- Rendered scientific notation has already lost its digits; `9.66555E+11`
  -- would otherwise become a well-formed number belonging to somebody else.
  IF _value ~* '\d[eE][+-]?\d' THEN RETURN NULL; END IF;
  -- A bare decimal is an Excel time serial, not a phone number.
  IF _value ~ '^\d*\.\d+$' THEN RETURN NULL; END IF;

  _digits := regexp_replace(_value, '\D', '', 'g');
  IF _digits = '' THEN RETURN NULL; END IF;

  IF left(_digits, 5) = '00966' THEN
    _digits := substr(_digits, 6);
  ELSIF left(_digits, 2) = '00' AND length(_digits) >= 10 THEN
    RETURN NULL;                              -- a different country
  ELSIF left(_digits, 3) = '966' THEN
    _digits := substr(_digits, 4);
  END IF;

  _digits := regexp_replace(_digits, '^0+', '');

  IF _digits ~ '^5[03-9]\d{7}$' THEN
    RETURN '0' || _digits;
  END IF;

  RETURN NULL;
END;
$$;

-- ===========================================================================
-- 4. Backfill, and say what happened
-- ===========================================================================
DO $do$
DECLARE
  _converted integer := 0;
  _cleared   integer := 0;
  _total     integer := 0;
BEGIN
  -- ---- source records --------------------------------------------------
  SELECT count(*) INTO _total FROM public.telesales_source_records WHERE phone IS NOT NULL;

  WITH updated AS (
    UPDATE public.telesales_source_records
       SET phone = pg_temp.telesales_canonical_phone(phone),
           phone_rejection = CASE
             WHEN pg_temp.telesales_canonical_phone(phone) IS NULL THEN 'migrated_unusable'
             ELSE NULL
           END
     WHERE phone IS NOT NULL
       AND phone IS DISTINCT FROM pg_temp.telesales_canonical_phone(phone)
    RETURNING phone
  )
  SELECT count(*) FILTER (WHERE phone IS NOT NULL),
         count(*) FILTER (WHERE phone IS NULL)
    INTO _converted, _cleared
    FROM updated;

  RAISE NOTICE 'telesales_source_records: % had a phone, % converted, % cleared as unusable',
    _total, _converted, _cleared;

  -- ---- leads -----------------------------------------------------------
  SELECT count(*) INTO _total FROM public.telesales_leads WHERE phone IS NOT NULL;

  WITH updated AS (
    UPDATE public.telesales_leads
       SET phone = pg_temp.telesales_canonical_phone(phone)
     WHERE phone IS NOT NULL
       AND phone IS DISTINCT FROM pg_temp.telesales_canonical_phone(phone)
    RETURNING phone
  )
  SELECT count(*) FILTER (WHERE phone IS NOT NULL),
         count(*) FILTER (WHERE phone IS NULL)
    INTO _converted, _cleared
    FROM updated;

  RAISE NOTICE 'telesales_leads: % had a phone, % converted, % cleared as unusable',
    _total, _converted, _cleared;

  /*
   * ---- patient contacts ------------------------------------------------
   *
   * `phone` is NOT NULL here, so a value that cannot be normalised cannot be
   * blanked in place. Those rows are *superseded* instead — the same mechanism a
   * correction uses — which keeps the number visible as history while removing
   * it from the one-current-number-per-patient index. Nothing is deleted and
   * nothing is invented.
   */
  UPDATE public.telesales_patient_contacts
     SET phone = pg_temp.telesales_canonical_phone(phone)
   WHERE pg_temp.telesales_canonical_phone(phone) IS NOT NULL
     AND phone IS DISTINCT FROM pg_temp.telesales_canonical_phone(phone);

  UPDATE public.telesales_patient_contacts
     SET superseded_at = COALESCE(superseded_at, now()),
         notes = COALESCE(notes || ' · ', '')
                 || 'Superseded by the canonical-phone migration: not a Saudi mobile number.'
   WHERE superseded_at IS NULL
     AND pg_temp.telesales_canonical_phone(phone) IS NULL;
END;
$do$;

DROP FUNCTION IF EXISTS pg_temp.telesales_canonical_phone(text);

-- ===========================================================================
-- 5. The shape is now enforced by the database
-- ===========================================================================
-- The application normalises on every path, and this is the backstop that makes
-- "the CRM has one phone format" a property of the data rather than a promise
-- about the code. A future import path, a manual `UPDATE`, or a server function
-- somebody adds without reading this file all fail loudly instead of quietly
-- reintroducing `+966…`.
--
-- NOT VALID on the two large tables: it applies to every future write while
-- skipping the full-table scan on a source table that will hold millions of
-- rows. The backfill above has already made the existing rows conform, and the
-- constraint can be validated later without blocking writes.
DO $do$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'telesales_source_records_phone_canonical'
  ) THEN
    ALTER TABLE public.telesales_source_records
      ADD CONSTRAINT telesales_source_records_phone_canonical
      CHECK (phone IS NULL OR phone ~ '^05[03-9][0-9]{7}$') NOT VALID;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'telesales_leads_phone_canonical'
  ) THEN
    ALTER TABLE public.telesales_leads
      ADD CONSTRAINT telesales_leads_phone_canonical
      CHECK (phone IS NULL OR phone ~ '^05[03-9][0-9]{7}$') NOT VALID;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'telesales_patient_contacts_phone_canonical'
  ) THEN
    ALTER TABLE public.telesales_patient_contacts
      ADD CONSTRAINT telesales_patient_contacts_phone_canonical
      CHECK (phone ~ '^05[03-9][0-9]{7}$') NOT VALID;
  END IF;
END;
$do$;

-- ===========================================================================
-- 6. Index the canonical column
-- ===========================================================================
-- The queue searches on the phone (`ilike`), and the Wasfaty generator looks up
-- every known patient number on each run.
CREATE INDEX IF NOT EXISTS telesales_leads_phone_idx
  ON public.telesales_leads (phone) WHERE phone IS NOT NULL;

COMMENT ON COLUMN public.telesales_leads.phone IS
  'Canonical Saudi mobile number, 05XXXXXXXX. Normalised by src/lib/phone.ts on '
  'every write path; the CHECK constraint is the backstop. NULL means no usable '
  'number, which is the normal state of a Wasfaty lead before the agent looks it up.';

COMMENT ON COLUMN public.telesales_source_records.phone_raw IS
  'The cell exactly as it arrived, for audit. Never the CRM phone value -- read '
  'phone instead.';
