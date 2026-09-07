-- Branch duty hours refresh — September 2026 "Duty Hours.xlsx".
--
-- Operations re-issued the duty roster for the 139 pharmacies. This is a data
-- update only: no column, index, policy or grant changes, and nothing outside
-- `duty_hours` and `working_hours` is touched. `friday_hours` is not in the
-- workbook and is deliberately left as it stands.
--
-- Shape follows the AlShrouq branch mapping in
-- `20260820180000_alshrouq_dispatch.sql`: a VALUES list joined on `branch_no`,
-- so the join itself is the validation. A code the directory has never heard of
-- updates nothing rather than inserting a branch, and `IS DISTINCT FROM` means
-- re-running the file is a no-op that does not churn `updated_at`.
--
-- Two rows in the workbook were NOT applied, and both are recorded here so the
-- next refresh does not have to rediscover them:
--
--   * P0309 — the workbook says 14 duty hours but its own "11 AM - 02 AM"
--     spans 15, which is what `parseDutyHours` derives and what the directory
--     already holds. A row that contradicts itself is not a source of truth, so
--     the branch is left untouched until operations resolve which is right.
--     Its hours string already matches the workbook, so nothing is lost.
--   * P0312 and P0313 are in the directory but absent from the workbook, as are
--     the three facility rows (الادارة العامة, الادارة الفرعية, المستودع).
--     Absent from the source means unchanged, not blanked.
--
-- The remaining 138 rows are carried below exactly as the workbook states them.
-- Of those, 28 move `duty_hours`, 44 move `working_hours` (P0311 and P0509 were
-- blank placeholders and are filled for the first time), and 94 already agreed
-- with the directory and are updated by nothing.

WITH roster(branch_no, duty_hours, working_hours) AS (
  VALUES
    ('P0001', 24, '06 AM - 06 AM'),
    ('P0002', 20, '07 AM - 03 AM'),
    ('P0003', 22, '06 AM - 04 AM'),
    ('P0004', 22, '06 AM - 04 AM'),
    ('P0005', 20, '07 AM - 03 AM'),
    ('P0006', 22, '06 AM - 04 AM'),
    ('P0007', 20, '07 AM - 03 AM'),
    ('P0008', 22, '06 AM - 04 AM'),
    ('P0009', 18, '09 AM - 03 AM'),
    ('P0010', 13, '09 AM - 02 PM THEN 04 PM - 12 AM'),
    ('P0011', 22, '06 AM - 04 AM'),
    ('P0012', 20, '07 AM - 03 AM'),
    ('P0013', 20, '06 AM - 02 AM'),
    ('P0014', 18, '09 AM - 03 AM'),
    ('P0015', 14, '11 AM - 01 AM'),
    ('P0016', 24, '05 AM - 05 AM'),
    ('P0017', 22, '06 AM - 04 AM'),
    ('P0018', 21, '06 AM - 03 AM'),
    ('P0019', 20, '07 AM - 03 AM'),
    ('P0020', 21, '06 AM - 03 AM'),
    ('P0021', 20, '06 AM - 02 AM'),
    ('P0022', 24, '06 AM - 06 AM'),
    ('P0023', 20, '07 AM - 03 AM'),
    ('P0024', 15, '10 AM - 01 AM'),
    ('P0025', 22, '06 AM - 04 AM'),
    ('P0026', 22, '06 AM - 04 AM'),
    ('P0027', 20, '07 AM - 03 AM'),
    ('P0028', 20, '07 AM - 03 AM'),
    ('P0029', 16, '09 AM - 02 PM & 02 PM - 05 PM & 05 PM - 01 AM'),
    ('P0030', 22, '06 AM - 04 AM'),
    ('P0031', 22, '06 AM - 04 AM'),
    ('P0032', 20, '07 AM - 03 AM'),
    ('P0033', 15, '10.30 AM - 01.30 AM'),
    ('P0034', 22, '06 AM - 04 AM'),
    ('P0035', 24, '05 AM - 05 AM & 09 AM -12 PM & 04 PM - 11 PM'),
    ('P0036', 20, '07 AM - 03 AM'),
    ('P0037', 21, '06 AM - 03 AM'),
    ('P0038', 20, '07 AM - 03 AM'),
    ('P0039', 22, '06 AM - 04 AM'),
    ('P0040', 21, '06 AM - 03 AM'),
    ('P0101', 19, '07 AM - 02 AM'),
    ('P0102', 19, '07 AM - 02 AM'),
    ('P0103', 18, '07 AM - 01 AM'),
    ('P0104', 18, '07 AM - 01 AM'),
    ('P0105', 14, '10 AM - 12 AM'),
    ('P0106', 20, '07 AM - 03 AM'),
    ('P0107', 19, '07 AM - 02 AM'),
    ('P0108', 22, '06 AM - 04 AM'),
    ('P0109', 21, '06 AM - 03 AM'),
    ('P0110', 24, '06 AM - 06 AM'),
    ('P0111', 19, '07 AM - 02 AM'),
    ('P0112', 20, '07 AM - 03 AM'),
    ('P0113', 19, '07 AM - 02 AM'),
    ('P0114', 24, '06 AM - 06 AM'),
    ('P0115', 20, '07 AM - 03 AM'),
    ('P0116', 21, '06 AM - 03 AM'),
    ('P0117', 19, '07 AM - 02 AM'),
    ('P0118', 19, '07 AM - 02 AM'),
    ('P0119', 20, '07 AM - 03 AM'),
    ('P0120', 24, '06 AM - 06 AM'),
    ('P0121', 19, '07 AM - 02 AM'),
    ('P0122', 19, '07 AM - 02 AM'),
    ('P0123', 19, '07 AM - 02 AM'),
    ('P0124', 19, '07 AM - 02 AM'),
    ('P0125', 22, '06 AM - 02 PM & 10 AM - 06 PM & 06 PM - 04 AM'),
    ('P0126', 24, '06 AM - 06 AM'),
    ('P0127', 14, '09 AM - 11 PM'),
    ('P0128', 24, '06 AM - 06 AM'),
    ('P0129', 22, '06 AM - 04 AM'),
    ('P0130', 20, '07 AM - 03 AM'),
    ('P0131', 19, '07 AM - 02 AM'),
    ('P0132', 20, '07 AM - 03 AM'),
    ('P0133', 24, '06 AM - 06 AM'),
    ('P0134', 19, '07 AM - 02 AM'),
    ('P0135', 19, '07 AM - 02 AM'),
    ('P0136', 19, '07 AM - 02 AM'),
    ('P0137', 19, '07 AM - 02 AM'),
    ('P0138', 19, '07 AM - 02 AM'),
    ('P0139', 14, '11 AM - 01 AM'),
    ('P0140', 19, '07 AM - 02 AM'),
    ('P0201', 14, '09 AM - 2.30 PM & 4.30 PM - 01 AM'),
    ('P0202', 16, '09 AM - 01 AM'),
    ('P0203', 22, '06 AM - 04 AM'),
    ('P0204', 18, '07 AM - 01 AM'),
    ('P0205', 20, '07 AM - 03 AM'),
    ('P0206', 20, '07 AM - 03 AM'),
    ('P0207', 20, '07 AM - 03 AM'),
    ('P0208', 20, '07 AM - 03 AM'),
    ('P0209', 15, '10 AM - 01 AM'),
    ('P0210', 14, '11 AM - 01 AM'),
    ('P0211', 14, '10.30 AM - 12.30 AM'),
    ('P0212', 12, '11 AM - 11 PM'),
    ('P0213', 22, '06 AM - 04 AM'),
    ('P0214', 20, '07 AM - 03 AM'),
    ('P0215', 15, '10 AM - 01 AM'),
    ('P0216', 18, '07 AM - 01 AM'),
    ('P0217', 22, '06 AM - 04 AM'),
    ('P0218', 20, '07 AM - 03 AM'),
    ('P0219', 20, '07 AM - 03 AM'),
    ('P0220', 24, '06 AM - 06 AM'),
    ('P0221', 17, '09 AM - 02AM'),
    ('P0222', 20, '07 AM - 03 AM'),
    ('P0223', 20, '06 AM - 02 AM'),
    ('P0224', 22, '06 AM - 04 AM'),
    ('P0225', 13, '12 PM - 01 AM'),
    ('P0301', 24, '06 AM - 06 AM'),
    ('P0302', 24, '06 AM - 06 AM'),
    ('P0303', 22, '06 AM - 04 AM'),
    ('P0304', 20, '07 AM - 03 AM'),
    ('P0305', 20, '07 AM - 03 AM'),
    ('P0306', 22, '06 AM - 04 AM'),
    ('P0307', 20, '07 AM - 03 AM'),
    ('P0308', 20, '07 AM - 03 AM'),
    ('P0310', 20, '07 AM - 03 AM'),
    ('P0311', 20, '07 AM - 03 AM'),
    ('P0401', 22, '06 AM - 04 AM'),
    ('P0402', 20, '07 AM - 03 AM'),
    ('P0403', 20, '07 AM - 03 AM'),
    ('P0404', 20, '07 AM - 03 AM'),
    ('P0501', 22, '06 AM - 04 AM'),
    ('P0502', 22, '06 AM - 04 AM'),
    ('P0503', 22, '06 AM - 04 AM'),
    ('P0504', 18, '09 AM - 03 AM'),
    ('P0505', 20, '07 AM - 03 AM'),
    ('P0506', 22, '06 AM - 04 AM'),
    ('P0507', 20, '07 AM - 03 AM'),
    ('P0508', 20, '07 AM - 03 AM'),
    ('P0509', 20, '07 AM - 03 AM'),
    ('P0601', 20, '07 AM - 03 AM'),
    ('P0602', 20, '07 AM - 03 AM'),
    ('P0603', 20, '07 AM - 03 AM'),
    ('P0604', 20, '07 AM - 03 AM'),
    ('P0605', 20, '07 AM - 03 AM'),
    ('P0606', 20, '07 AM - 03 AM'),
    ('P0607', 20, '07 AM - 03 AM'),
    ('P0608', 22, '06 AM - 04 AM'),
    ('P0609', 20, '07 AM - 03 AM'),
    ('P0701', 15, '10 AM - 01 AM')
)
UPDATE public.branches b
   SET duty_hours    = roster.duty_hours,
       working_hours = roster.working_hours,
       updated_at    = now()
  FROM roster
 WHERE b.branch_no = roster.branch_no
   AND (b.duty_hours    IS DISTINCT FROM roster.duty_hours
     OR b.working_hours IS DISTINCT FROM roster.working_hours);
