-- ---------------------------------------------------------------------------
-- Keep the workbook that produced an import
-- ---------------------------------------------------------------------------
-- The working loop an administrator actually has is: download the current
-- sheet, edit it offline, map the columns, upload it again. Until now the first
-- step had no answer inside the portal — the file lived on whoever ran the last
-- import's laptop, and the next person to need it either asked them for it or
-- rebuilt one from an export, which is a different file with a different column
-- order and therefore a fresh round of mapping.
--
-- Storing the bytes rather than regenerating them is the point. A file rebuilt
-- from the current table is not the file that was uploaded: it has lost the
-- rows validation rejected, the columns the template does not carry, and any
-- notes the maintainer keeps in it. What an administrator wants back is *their*
-- spreadsheet.
--
-- Base64 in a text column, not Storage. A bucket would mean a second
-- authorization surface to keep in step with `admin_access`, a lifecycle to
-- manage, and an object that can outlive or predecease the row describing it.
-- These files are tens of kilobytes; the `snapshot` column beside them is
-- routinely larger.

ALTER TABLE public.branch_imports
  -- Base64 of the uploaded workbook, exactly as it arrived.
  ADD COLUMN IF NOT EXISTS source_file       text,
  -- Original filename and MIME type, so a download can hand back something the
  -- operating system opens rather than a blob with a guessed extension.
  ADD COLUMN IF NOT EXISTS source_file_type  text,
  -- Decoded size in bytes, denormalized: the import page needs to say how large
  -- the download is without transferring the file to find out.
  ADD COLUMN IF NOT EXISTS source_file_size  integer;

-- Partial, because only some entries carry a file at all: a rollback has no
-- upload behind it, and imports applied before this migration have none either.
-- This index is what makes "the newest import that still has its file" a single
-- ordered lookup rather than a scan of history.
CREATE INDEX IF NOT EXISTS branch_imports_with_source_idx
  ON public.branch_imports (imported_at DESC)
  WHERE source_file IS NOT NULL;

COMMENT ON COLUMN public.branch_imports.source_file IS
  'Base64 of the uploaded workbook. Read only through the branchImportLastFile '
  'server function, which gates on admin_access — never selected by the history '
  'list, which renders twenty rows.';
