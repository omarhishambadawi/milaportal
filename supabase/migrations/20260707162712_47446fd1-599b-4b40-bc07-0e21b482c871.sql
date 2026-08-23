CREATE TABLE IF NOT EXISTS public.cdr_progress (
  job_id         text PRIMARY KEY,
  status         text NOT NULL DEFAULT 'pending',
  page           int  NOT NULL DEFAULT 0,
  total_pages    int,
  records        int  NOT NULL DEFAULT 0,
  total_reported int,
  message        text NOT NULL DEFAULT '',
  error          text,
  updated_at     timestamptz NOT NULL DEFAULT now()
);
GRANT ALL ON public.cdr_progress TO service_role;
ALTER TABLE public.cdr_progress ENABLE ROW LEVEL SECURITY;
CREATE INDEX IF NOT EXISTS cdr_progress_updated_at_idx ON public.cdr_progress (updated_at);