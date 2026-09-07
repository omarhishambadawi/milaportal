-- Two branch corrections settled after the September duty-hours refresh
-- (`20260917120000_branch_duty_hours_refresh.sql`).
--
-- 1. P0309. The workbook stated 14 duty hours against its own "11 AM - 02 AM",
--    which spans 15, so the refresh left the row alone and asked operations to
--    resolve it. They confirmed 15 -- the figure `parseDutyHours` derives from
--    the hours string, and the one the directory already held. The statement
--    below is therefore an assertion rather than a change: it writes the agreed
--    pair only where a database does not already hold it, so an environment
--    that never received the hold converges on the same answer.
--
-- 2. P0509. `friday_hours` still carried "new", a placeholder typed when the
--    branch was added and left behind because the duty-hours workbook has no
--    Friday column to correct it with. Operations asked for the literal string
--    "none". It is stored as written, not as NULL: NULL in this column means
--    "nobody has told us", and this row is the other thing -- an answer.

UPDATE public.branches
   SET duty_hours    = 15,
       working_hours = '11 AM - 02 AM',
       updated_at    = now()
 WHERE branch_no = 'P0309'
   AND (duty_hours    IS DISTINCT FROM 15
     OR working_hours IS DISTINCT FROM '11 AM - 02 AM');

UPDATE public.branches
   SET friday_hours = 'none',
       updated_at   = now()
 WHERE branch_no = 'P0509'
   AND friday_hours IS DISTINCT FROM 'none';
