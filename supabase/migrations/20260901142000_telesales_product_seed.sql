-- Telesales CRM: the product catalogue the desk actually worked.
--
-- ===========================================================================
-- Where these rows come from
-- ===========================================================================
-- Every code below was read out of the July Leads workbook, not transcribed from
-- the brief. The brief names six families; the workbook contains 25 distinct
-- item codes across them, three insulins the desk worked anyway, and two
-- FreeStyle products it pointedly never touched.
--
-- The counts in the `notes` column are occurrences in the twelve working sheets
-- (the rows agents were given), so a future reader can see the evidence for each
-- decision rather than take it on trust.
--
-- ===========================================================================
-- The two rows that matter most are the ones switched off
-- ===========================================================================
-- `FREESTYLE OPTIUM STRIPS 50's` (10300322) and `FREESTYLE OPTIUM GLUCOSE METER`
-- (10301412) appear 42 and 39 times in the July extract and **zero** times in any
-- working sheet. They are a fingerstick meter and its consumables; Libre and
-- Dexcom are continuous glucose monitors, which is a different product, a
-- different price and a different conversation.
--
-- Any implementation that decides eligibility by asking whether the item name
-- contains "FREESTYLE" puts 81 wrong rows a month into the queue. They are
-- seeded here, explicitly ineligible, so that the mistake is recorded as a
-- decision rather than waiting to be rediscovered.

INSERT INTO public.telesales_products
  (item_code, item_name, family, strength, category, eligible_cash, eligible_retention, refill_days, notes)
VALUES
  -- --- Mounjaro (tirzepatide) ---------------------------------------------
  -- Six KwikPen strengths plus the older 4-pen presentation. 387 working-sheet
  -- rows between them: the desk's single biggest product.
  ('10611027', 'MOUNJARO KWIKPEN 2.5 MG/0.6ML 2.4ML*1 AA',  'mounjaro', '2.5 MG',  'ANTI-DIABETIC', true, true, 28, 'July working sheets: 30 rows'),
  ('10611028', 'MOUNJARO KWIKPEN 5 MG/0.6ML 2.4ML*1 AA',    'mounjaro', '5 MG',    'ANTI-DIABETIC', true, true, 28, 'July working sheets: 74 rows'),
  ('10611029', 'MOUNJARO KWIKPEN 7.5 MG/0.6ML 2.4ML*1 AA',  'mounjaro', '7.5 MG',  'ANTI-DIABETIC', true, true, 28, 'July working sheets: 52 rows'),
  ('10611030', 'MOUNJARO KWIKPEN 10 MG/0.6ML 2.4ML*1 AA',   'mounjaro', '10 MG',   'ANTI-DIABETIC', true, true, 28, 'July working sheets: 63 rows'),
  ('10611031', 'MOUNJARO KWIKPEN 12.5 MG/0.6ML 2.4ML*1 QR', 'mounjaro', '12.5 MG', 'ANTI-DIABETIC', true, true, 28, 'July working sheets: 99 rows'),
  ('10611032', 'MOUNJARO KWIKPEN 15MG/0.6ML 2.4ML*1 QR',    'mounjaro', '15 MG',   'ANTI-DIABETIC', true, true, 28, 'July working sheets: 66 rows'),
  ('10609675', 'MOUNJARO 15 MG 0.5ML PEN 4''S',             'mounjaro', '15 MG',   'ANTI-DIABETIC', true, true, 28, 'Older 4-pen pack. July working sheets: 3 rows'),

  -- --- Ozempic (semaglutide, injectable) ----------------------------------
  ('10104195', 'OZEMPIC .25MG 1.5ML PEN, 1''S', 'ozempic', '0.25 MG', 'ANTI-DIABETIC', true, true, 28, 'July working sheets: 8 rows'),
  ('10104196', 'OZEMPIC .50MG 1.5ML PEN, 1''S', 'ozempic', '0.5 MG',  'ANTI-DIABETIC', true, true, 28, 'July working sheets: 25 rows'),
  ('10104198', 'OZEMPIC 1 MG 1.5ML PEN, 1''S',  'ozempic', '1 MG',    'ANTI-DIABETIC', true, true, 28, 'July working sheets: 121 rows'),

  -- --- Wegovy (semaglutide, weight management) ----------------------------
  ('10612030', 'WEGOVY 0.25 MG 1/1.5 ML PEN, 1''S', 'wegovy', '0.25 MG', 'ANTI-DIABETIC', true, true, 28, 'July working sheets: 15 rows'),
  ('10612031', 'WEGOVY 0.5 MG 1/1.5 ML PEN, 1''S',  'wegovy', '0.5 MG',  'ANTI-DIABETIC', true, true, 28, 'July working sheets: 24 rows'),
  ('10612032', 'WEGOVY 1 MG 1/1.5 ML PEN, 1''S',    'wegovy', '1 MG',    'ANTI-DIABETIC', true, true, 28, 'July working sheets: 32 rows'),
  ('10612033', 'WEGOVY 1.7 MG 1/1.5 ML PEN, 1''S',  'wegovy', '1.7 MG',  'ANTI-DIABETIC', true, true, 28, 'July working sheets: 21 rows'),
  ('10612034', 'WEGOVY 2.4MG 1/1.5 ML PEN, 1''S',   'wegovy', '2.4 MG',  'ANTI-DIABETIC', true, true, 28, 'July working sheets: 5 rows'),

  -- --- Rybelsus (semaglutide, oral) ---------------------------------------
  -- 30-tablet packs, so a 30-day nominal refill rather than 28.
  ('10602062', 'RYBELSUS 3MG TAB, 30''S',  'rybelsus', '3 MG',  'ANTI-DIABETIC', true, true, 30, 'July working sheets: 14 rows'),
  ('10602063', 'RYBELSUS 7MG TAB, 30''S',  'rybelsus', '7 MG',  'ANTI-DIABETIC', true, true, 30, 'July working sheets: 23 rows'),
  ('10602064', 'RYBELSUS 14MG TAB, 30''S', 'rybelsus', '14 MG', 'ANTI-DIABETIC', true, true, 30, 'July working sheets: 34 rows'),

  -- --- FreeStyle Libre (continuous glucose monitoring) --------------------
  -- Sensors are consumed on a 14-day wear cycle, so they are the clearest
  -- retention product in the catalogue. The reader is not: it is bought once and
  -- lasts, which is why `eligible_retention` is false for it alone.
  ('10607540', 'FREESTYLE LIBRE 2 SENSOR',       'freestyle_libre', '2 SENSOR',        'DIAGNOSTICS & MACHINES', true,  true,  14, 'July working sheets: 15 rows'),
  ('10613360', 'FREESTYLE LIBRE 3 PLUS SENSOR',  'freestyle_libre', '3 PLUS SENSOR',   'DIAGNOSTICS & MACHINES', true,  true,  14, 'July working sheets: 30 rows'),
  ('10613411', 'FREESTYLE LIBRE 3 PLUS READER',  'freestyle_libre', '3 PLUS READER',   'DIAGNOSTICS & MACHINES', true,  false, NULL, 'Hardware, bought once. Cash lead yes, refill cycle no. July working sheets: 2 rows'),

  -- --- Dexcom -------------------------------------------------------------
  ('10612388', 'DEXCOM ONE PLUS SENSOR 1 S',   'dexcom', 'ONE PLUS SENSOR',   'DIAGNOSTICS & MACHINES', true, true,  10,   'July working sheets: 15 rows'),
  ('10612389', 'DEXCOM ONE PLUS RECEIVER 1S',  'dexcom', 'ONE PLUS RECEIVER', 'DIAGNOSTICS & MACHINES', true, false, NULL, 'Hardware. Present in the July extract (2 rows), never in a working sheet; eligible for Cash by family, not for retention'),

  -- --- Insulins: worked in practice, absent from the brief -----------------
  -- These three appear in the working sheets 19 times, so the desk did call
  -- them, but the brief's product list does not include them. Recording them as
  -- known-and-disabled is the only honest resolution: the discrepancy is visible
  -- in the product screen, and turning them on is a checkbox rather than a
  -- deployment.
  ('10102123', 'NOVORAPID FLEXPEN 100 IU / ML, 5X3 ML, 5 ''S', 'insulin', '100 IU/ML', 'ANTI-DIABETIC', false, false, NULL, 'Worked 11 times in July sheets but outside the briefed product list. Enable here if the desk wants it back.'),
  ('10601746', 'RYZODEG FLEX TOUCH 100U 5*3ML',                'insulin', '100 U',     'ANTI-DIABETIC', false, false, NULL, 'Worked 7 times in July sheets but outside the briefed product list.'),
  ('10104211', 'TOUJEO 300 IUML SOLU FOR INJ PREFILLED 5',     'insulin', '300 IU/ML', 'ANTI-DIABETIC', false, false, NULL, 'Worked once in July sheets but outside the briefed product list.'),

  -- --- The FreeStyle name trap --------------------------------------------
  ('10300322', 'FREESTYLE OPTIUM STRIPS 50''s',   'other', 'STRIPS 50', 'DIAGNOSTICS & MACHINES', false, false, NULL, 'Fingerstick consumable, NOT a Libre CGM. 42 rows in the July extract, 0 in any working sheet. Seeded disabled so name matching on "FREESTYLE" cannot sweep it in.'),
  ('10301412', 'FREESTYLE OPTIUM GLUCOSE METER',  'other', 'METER',     'DIAGNOSTICS & MACHINES', false, false, NULL, 'Fingerstick meter, NOT a Libre CGM. 39 rows in the July extract, 0 in any working sheet.')
ON CONFLICT (item_code) DO NOTHING;

-- ===========================================================================
-- Name patterns
-- ===========================================================================
-- These classify an item code that is not in the table above -- a new strength,
-- a repackaged SKU. They are ordered, and the exclusions come first.
--
-- Written as POSIX regular expressions matched case-insensitively against the
-- whitespace-collapsed item name.
INSERT INTO public.telesales_product_patterns (pattern, family, eligible, priority, notes)
VALUES
  -- ---- exclusions, evaluated first ---------------------------------------
  ('FREESTYLE\s+OPTIUM', 'other', false, 10,
   'Must outrank the FREESTYLE LIBRE rule. Optium is a fingerstick meter/strip line; the desk has never called one.'),
  ('FREESTYLE\s+(PRECISION|NEO)', 'other', false, 11,
   'Same family of fingerstick products as Optium. Pre-emptive: not seen in the July extract, but it is the same mistake.'),

  -- ---- the six briefed families ------------------------------------------
  ('MOUNJARO',                'mounjaro',        true, 100, 'All strengths and presentations'),
  ('OZEMPIC',                 'ozempic',         true, 100, 'All strengths'),
  ('WEGOVY',                  'wegovy',          true, 100, 'All strengths'),
  ('RYBELSUS',                'rybelsus',        true, 100, 'All strengths'),
  ('FREESTYLE\s+LIBRE',       'freestyle_libre', true, 100, 'Sensors and readers; Optium is excluded above'),
  ('DEXCOM',                  'dexcom',          true, 100, 'All Dexcom CGM products'),

  -- ---- generic-name fallbacks --------------------------------------------
  -- The extracts are brand-named throughout, but a rebrand or a generic import
  -- would otherwise pass unnoticed. Lower priority so a brand rule always wins
  -- and sets the right family.
  ('TIRZEPATIDE',  'mounjaro', true, 200, 'Generic name for Mounjaro'),
  ('SEMAGLUTIDE',  'ozempic',  true, 200, 'Generic name shared by Ozempic/Wegovy/Rybelsus; family is a best guess and the code should be added to telesales_products when seen')
ON CONFLICT DO NOTHING;
