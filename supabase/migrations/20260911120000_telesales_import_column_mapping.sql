-- Telesales CRM: record how an import's columns were read.
--
-- ===========================================================================
-- Why
-- ===========================================================================
-- The importer maps a spreadsheet by matching header text against
-- `HEADER_ALIASES`, which is right for the three workbooks it was written
-- against and for any file built from a MilaPortal template. It has nothing to
-- say about a fourth file -- a pharmacy's own export, a renamed column, a sheet
-- whose `Mobile Number` the alias table has never seen. Until now the only
-- answers were "edit the spreadsheet until the importer likes it" or "do not
-- import it".
--
-- The import screen now offers a manual mapping for exactly that case. Auto
-- detection still runs first and stays the default; a field the operator does
-- not touch keeps what the headers said.
--
-- This column records the result, in the operator's own words -- `{"Phone":
-- {"column": "Mobile Number", "auto": false}}` -- so that "which column did
-- this import treat as the dispense date" stays answerable a month later. That
-- question matters most for precisely the file that needed a hand-made mapping.
--
-- Header text rather than column indices, because an index means nothing once
-- the file is gone. `auto` distinguishes what was detected from what a person
-- decided, which is the difference between a mapping nobody checked and one
-- somebody is accountable for.
--
-- ===========================================================================
-- Per import, and deliberately not reusable
-- ===========================================================================
-- Nothing reads this back to pre-fill a later upload. A saved, reapplied
-- mapping is a different feature with a worse failure mode: a stale mapping
-- applied silently to a file whose columns have moved, producing an import that
-- succeeds and is wrong. This is a record of what happened, not a template.
--
-- One column, nullable, additive. Every existing row keeps its meaning: NULL is
-- "nothing was recorded", which is what every import before this did.

ALTER TABLE public.telesales_imports
  ADD COLUMN IF NOT EXISTS column_mapping jsonb;

COMMENT ON COLUMN public.telesales_imports.column_mapping IS
  'How this import read the file''s columns, keyed by the MilaPortal field''s '
  'business label: {"Phone": {"column": "Mobile Number", "auto": false}}. '
  '"auto" false means an operator chose it rather than header detection. '
  'Header text, not indices, so it stays readable once the file is gone. '
  'Recorded per import and never reapplied to a later one.';

-- Grants and RLS are unchanged: the table already carries RLS with a SELECT
-- policy keyed on manage_telesales and no write policy, so every write goes
-- through a server function running as service_role. Adding a column alters
-- neither. Restated rather than re-granted, so applying this cannot widen
-- access by accident.
REVOKE ALL ON public.telesales_imports FROM anon;
REVOKE INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER
  ON public.telesales_imports FROM authenticated;
GRANT SELECT ON public.telesales_imports TO authenticated;
