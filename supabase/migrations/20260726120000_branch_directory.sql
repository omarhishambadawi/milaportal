-- Branch Directory
--
-- `public.branches` was a two-column lookup (branch_no -> city) whose only job
-- was to resolve a city name for order analytics. The Branch Directory turns it
-- into the operational record agents search during a call, so every field the
-- master sheet carries lands here as a column.
--
-- Two constraints shape the design:
--
--   1. `orders.branch_no` REFERENCES branches(branch_no). A branch that has ever
--      taken an order can therefore never be DELETEd. Every "remove" in this
--      feature is `active = false` instead -- see the `active` column below and
--      the import server functions, which deactivate rather than delete. Making
--      Replace All a real DELETE would fail on the first referenced row and
--      abort the whole import.
--
--   2. `branch_no` stays the primary key. The sheet's Branch Code is the natural
--      key operators already use ("P0021"), it is what orders store, and
--      re-keying to a surrogate id would rewrite the orders FK for no gain.
--
-- Everything added here is nullable. The master sheet is a hand-maintained
-- workbook: 3 of its 145 rows have no email, 4 have no phone, and four rows are
-- facilities rather than pharmacies ("المستودع", "الادارة العامة") that carry a
-- dash in most columns. Rejecting those at the column level would mean the
-- directory could not represent the data the business actually has, so
-- completeness is reported by the import preview as warnings instead.

ALTER TABLE public.branches
  ADD COLUMN IF NOT EXISTS phone            text,
  ADD COLUMN IF NOT EXISTS area_manager     text,
  ADD COLUMN IF NOT EXISTS area_manager_phone text,
  ADD COLUMN IF NOT EXISTS email            text,
  ADD COLUMN IF NOT EXISTS address          text,
  ADD COLUMN IF NOT EXISTS maps_url         text,
  ADD COLUMN IF NOT EXISTS latitude         numeric(10, 7),
  ADD COLUMN IF NOT EXISTS longitude        numeric(10, 7),
  -- Both halves of the scooter question are kept. `scooter` is the normalized
  -- boolean the filter chips and stat cards read; `scooter_note` preserves the
  -- sheet's original wording, which is not a yes/no in Arabic -- it ranges over
  -- "سكوتر", "توصيل مجاني", "سكوتر العامل", "مع فرع 8" and "N/A". Collapsing
  -- that to a bit and discarding the text would lose the distinction between
  -- "no scooter" and "delivery is free anyway", which agents act on.
  ADD COLUMN IF NOT EXISTS scooter          boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS scooter_note     text,
  -- Free text, straight from the sheet: "07 AM - 03 AM", and for the branches
  -- running split shifts "06 AM - 02 PM & 10 AM - 06 PM & 06 PM - 04 AM".
  -- Not parsed into time columns because the multi-shift rows have no single
  -- open/close pair to store.
  ADD COLUMN IF NOT EXISTS working_hours    text,
  ADD COLUMN IF NOT EXISTS friday_hours     text,
  -- Daily open duration in hours, derived from working_hours at import time.
  -- Stored rather than computed on read because it is what the "20 Hours" /
  -- "24 Hours" filter chips match on, and parsing 1000 free-text ranges on
  -- every keystroke is exactly the lag this feature exists to avoid.
  ADD COLUMN IF NOT EXISTS duty_hours       numeric(4, 1),
  -- Soft delete. See note 1 above: this is what "removed" means for a branch.
  -- Existing rows default to active, so the pre-import directory keeps working.
  ADD COLUMN IF NOT EXISTS active           boolean NOT NULL DEFAULT true,
  ADD COLUMN IF NOT EXISTS updated_at       timestamptz NOT NULL DEFAULT now();

-- The directory's own listing is `active` + ordered by code; analytics joins
-- still go through the primary key. City drives both a filter chip and the
-- Cities stat card.
CREATE INDEX IF NOT EXISTS branches_active_idx ON public.branches (active);
CREATE INDEX IF NOT EXISTS branches_city_idx   ON public.branches (city);

-- ---------------------------------------------------------------------------
-- Import history
-- ---------------------------------------------------------------------------
-- One row per applied import, carrying a full snapshot of the branches table as
-- it stood *before* that import ran. Rollback restores the snapshot.
--
-- A snapshot rather than a diff: the four import modes (replace/merge/update/
-- add) each touch a different subset, and reversing a diff correctly across all
-- of them means reconstructing deletes, partial column updates and the rows a
-- merge left alone. Storing the prior state makes rollback a single deterministic
-- restore regardless of which mode produced it. At ~1000 rows of short text the
-- snapshot is a few hundred KB, which is worth paying once per import for an
-- undo an operator can actually trust.

CREATE TABLE IF NOT EXISTS public.branch_imports (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  -- ON DELETE SET NULL, not CASCADE: the record of an import must outlive the
  -- account that ran it. Same reasoning as admin_activity.
  imported_by   uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  imported_at   timestamptz NOT NULL DEFAULT now(),
  -- The actor's role AT THE TIME OF THE IMPORT, denormalized on purpose.
  -- `imported_by` resolves to today's role, which is the wrong answer to the
  -- question an audit asks: a Supervisor who was later promoted must still show
  -- as a Supervisor on the import they ran last month.
  actor_role    text,
  mode          text NOT NULL CHECK (mode IN ('replace', 'merge', 'update', 'add', 'rollback')),
  file_name     text,
  rows_total    integer NOT NULL DEFAULT 0,
  rows_added    integer NOT NULL DEFAULT 0,
  rows_updated  integer NOT NULL DEFAULT 0,
  -- "Removed" means deactivated -- see the note at the top of this file.
  rows_removed  integer NOT NULL DEFAULT 0,
  -- Rows the file carried that this MODE deliberately skipped: new codes under
  -- "Update Existing Only", existing codes under "Add New Only". Distinct from
  -- rows_failed, which is the count that could not be imported at all.
  rows_ignored  integer NOT NULL DEFAULT 0,
  rows_failed   integer NOT NULL DEFAULT 0,
  -- Counts by severity plus the issues themselves, so the history answers
  -- "what was wrong with the file we imported" months later, when the
  -- spreadsheet that produced it has been overwritten twice.
  validation_summary jsonb NOT NULL DEFAULT '{}'::jsonb,
  -- Prior state of public.branches, as an array of row objects.
  snapshot      jsonb   NOT NULL DEFAULT '[]'::jsonb,
  -- Row count of `snapshot`, denormalized so the history list can say whether an
  -- entry is restorable without transferring every snapshot it renders. The
  -- history page shows ten entries; pulling ten full table copies to display ten
  -- "Roll back" buttons would make the page cost megabytes.
  snapshot_rows integer NOT NULL DEFAULT 0,
  -- Set on the entry created BY a rollback, pointing at the entry it restored,
  -- so the history reads as a chain rather than as an unexplained bulk edit.
  reverted_from uuid REFERENCES public.branch_imports(id) ON DELETE SET NULL,
  notes         text
);

CREATE INDEX IF NOT EXISTS branch_imports_imported_at_idx
  ON public.branch_imports (imported_at DESC);

GRANT SELECT, INSERT ON public.branch_imports TO authenticated;
GRANT ALL ON public.branch_imports TO service_role;

ALTER TABLE public.branch_imports ENABLE ROW LEVEL SECURITY;

-- Reading history means reading `snapshot`, which is a complete copy of the
-- branch table including every area manager's mobile number. Gated on the same
-- permission that lets someone change branches in the first place -- an agent
-- with view_branches sees the directory, not its edit history.
--
-- The writes themselves go through server functions on service_role (they need
-- to snapshot, upsert and record atomically), so these policies are the
-- defence-in-depth floor rather than the path the app takes.
DROP POLICY IF EXISTS "Branch imports readable by branch managers" ON public.branch_imports;
CREATE POLICY "Branch imports readable by branch managers"
ON public.branch_imports
FOR SELECT
TO authenticated
USING (public.has_permission(auth.uid(), 'admin_access'));

DROP POLICY IF EXISTS "Branch imports writable by branch managers" ON public.branch_imports;
CREATE POLICY "Branch imports writable by branch managers"
ON public.branch_imports
FOR INSERT
TO authenticated
WITH CHECK (public.has_permission(auth.uid(), 'admin_access'));

-- History is append-only for everyone below service_role: no UPDATE or DELETE
-- policy exists, so an operator cannot quietly edit away the record of an
-- import they later regret. Rollback appends a new entry; it never rewrites one.
