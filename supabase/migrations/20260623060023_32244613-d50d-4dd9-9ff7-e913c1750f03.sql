
-- Complaints: simplify form & statuses, widen visibility
ALTER TABLE public.complaints ALTER COLUMN customer_name DROP NOT NULL;
ALTER TABLE public.complaints ALTER COLUMN customer_phone DROP NOT NULL;
ALTER TABLE public.complaints ALTER COLUMN description DROP NOT NULL;

-- Migrate existing statuses to two-state model
UPDATE public.complaints SET status = 'In Progress' WHERE status IN ('Open','open','In Progress','in_progress');
UPDATE public.complaints SET status = 'Resolved' WHERE status IN ('Closed','closed','Resolved','resolved');
UPDATE public.complaints SET status = 'In Progress' WHERE status NOT IN ('In Progress','Resolved');

-- Allow all authenticated users to view complaints (for analytics & dashboards)
DROP POLICY IF EXISTS "View complaints" ON public.complaints;
CREATE POLICY "Authenticated users view all complaints"
  ON public.complaints FOR SELECT
  USING (auth.uid() IS NOT NULL);
