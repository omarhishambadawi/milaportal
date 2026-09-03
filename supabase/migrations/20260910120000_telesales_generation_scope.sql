-- Telesales CRM: record what a generation run was scoped to.
--
-- ===========================================================================
-- Why
-- ===========================================================================
-- `telesales_generation_runs` already records what a run *did* -- candidates,
-- leads created, duplicates refused, the window it read. It does not record what
-- the run was *asked* to do, because until now there was only one answer: the
-- whole window, every row in it.
--
-- Generation can now be scoped to one import and narrowed by branch, city,
-- product or whether the row carries a phone. Without these two columns a
-- filtered run and a full run are indistinguishable afterwards, and "why did
-- Tuesday's run create 12 leads when Monday's created 400" has no answer.
--
-- Two columns, both nullable, both additive. Every existing row keeps its
-- meaning: NULL means "the whole window", which is exactly what those runs did.
--
-- ===========================================================================
-- Why one column and one jsonb rather than six columns
-- ===========================================================================
-- `import_id` is a real relationship -- it is the scope people ask about by
-- name, it is worth a foreign key, and "show me the runs for this import" is a
-- query the review screen makes. The rest are a variable set that nothing joins
-- on and that will grow as the desk asks for more filters, so they travel as
-- jsonb rather than as a column each and a migration every time.

ALTER TABLE public.telesales_generation_runs
  ADD COLUMN IF NOT EXISTS import_id uuid
    REFERENCES public.telesales_imports(id) ON DELETE SET NULL;

ALTER TABLE public.telesales_generation_runs
  ADD COLUMN IF NOT EXISTS filters jsonb;

-- The review screen's read: the runs for one import, newest first.
CREATE INDEX IF NOT EXISTS telesales_generation_runs_import_idx
  ON public.telesales_generation_runs (import_id, started_at DESC)
  WHERE import_id IS NOT NULL;

COMMENT ON COLUMN public.telesales_generation_runs.import_id IS
  'The import this run was scoped to, when it was scoped to one. NULL means the '
  'run read the whole window for its lead type, which is what every run did '
  'before generation could be scoped. ON DELETE SET NULL: a run is a historical '
  'fact and outlives the import it read.';

COMMENT ON COLUMN public.telesales_generation_runs.filters IS
  'The narrowing applied beyond the import -- branch_nos, cities, item_codes, '
  'has_phone, date_from, date_to. NULL means none. These only ever shrink the '
  'set of rows considered; they never relax an eligibility rule, and a filtered '
  'run can only produce a subset of what an unfiltered one would have.';

-- Grants and RLS are unchanged: this table already carries RLS with a SELECT
-- policy keyed on manage_telesales and no write policy, and adding a column
-- does not alter either. Restated as a check rather than re-granted, so
-- applying this migration cannot widen access by accident.
--
-- manage_telesales, not view_telesales, is also why the import review screen and
-- its diagnostic are supervisor-only: an agent calling them would read counts
-- derived from rows they cannot see anywhere else in the product, beside a run
-- list that would render empty.
REVOKE ALL ON public.telesales_generation_runs FROM anon;
REVOKE INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER
  ON public.telesales_generation_runs FROM authenticated;
GRANT SELECT ON public.telesales_generation_runs TO authenticated;

-- ===========================================================================
-- Also here: the default write grants on the two import tables
-- ===========================================================================
-- `telesales_imports` and `telesales_source_records` still carry the project's
-- default privileges -- INSERT, UPDATE, DELETE and TRUNCATE to `authenticated`.
-- RLS already refuses every one of those writes: both tables have a SELECT
-- policy keyed on `manage_telesales` and no write policy at all, and every
-- mutation goes through a server function running as `service_role`.
--
-- So this changes no behaviour. It closes the same gap `20260907120000` closed
-- for `telesales_product_relations` and `20260909120000` for
-- `telesales_product_aliases`, and for the same reason: a DELETE grant to
-- browser clients on the table holding every imported source row is not
-- something an access audit should have to reason its way past. `anon` holds
-- nothing on either table already; the REVOKE is restated so the final grant
-- state is legible in one place.
REVOKE ALL ON public.telesales_imports FROM anon;
REVOKE INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER
  ON public.telesales_imports FROM authenticated;
GRANT SELECT ON public.telesales_imports TO authenticated;

REVOKE ALL ON public.telesales_source_records FROM anon;
REVOKE INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER
  ON public.telesales_source_records FROM authenticated;
GRANT SELECT ON public.telesales_source_records TO authenticated;
