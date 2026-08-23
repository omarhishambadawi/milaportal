ALTER TABLE public.branch_imports
  ADD COLUMN IF NOT EXISTS source_file text,
  ADD COLUMN IF NOT EXISTS source_file_type text,
  ADD COLUMN IF NOT EXISTS source_file_size bigint;