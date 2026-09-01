-- The Telesales CRM module.
--
-- ===========================================================================
-- What this replaces
-- ===========================================================================
-- The Shams Pharmacies telesales desk runs on three Excel workbooks. Pharmacy
-- management sends an extract; operations filter it by date and product, paste
-- the survivors into a per-batch working sheet, and agents type their name and
-- an outcome into two columns beside each row.
--
-- The workbooks were read before this schema was written, and several things in
-- them are not what their column headers claim:
--
--   * "Days to refill" is not a refill interval. All three workbooks compute it
--     as `=TODAY()-<date to be called>`, so it is a countdown to a *scheduled
--     callback*, rendered through a number format that prints "Overdue" for
--     positives and "Remaining" for negatives. The `46266 Days Overdue` filling
--     most rows is that subtraction against an empty cell (Excel's day zero),
--     not a data point. It is modelled here as what it is -- a follow-up due
--     date -- and never stored as a number.
--
--   * "Main Database" in July Leads holds 173,008 rows covering 21-31 July only,
--     while the working sheets beside it cover 3-31 July. The source tab is
--     overwritten each time a new extract arrives; the derived sheets are not.
--     Nothing in the workbook can say which extract produced a given lead. That
--     is the strongest argument for `telesales_imports` and
--     `telesales_source_records` below: the raw drop is kept, and every lead
--     points back at the row that created it.
--
--   * The Wasfaty workbook carries three different column layouts across eight
--     sheets (a per-city generation, a "Riyadh" generation, and the current
--     "Wasfaty Aug"/"Wasfaty Sep" generation). Dates appear as dd/mm/yy,
--     mm/dd/yyyy, ISO, Excel serials, and free text ("no record"). The importer
--     normalises; this schema stores dates as `date` and keeps the untouched row
--     in `raw` so a misparse can be found and re-run.
--
-- ===========================================================================
-- Shape
-- ===========================================================================
--   telesales_products          eligible SKUs, by explicit code
--   telesales_product_patterns  name rules that classify SKUs not yet listed
--   telesales_settings          the singleton that holds the date windows
--   telesales_imports           one uploaded workbook
--   telesales_source_records    normalised rows from an import, kept forever
--   telesales_generation_runs   one execution of the lead generator
--   telesales_leads             the operational CRM opportunity
--   telesales_lead_activities   append-only history
--   telesales_followups         scheduled future contact
--   telesales_patient_contacts  Wasfaty phone numbers, with provenance
--
-- There is deliberately no accounts/clients table. MilaPortal has never had one:
-- it is one company's portal, Shams Pharmacies is an upstream system it
-- integrates with, and `branches.branch_no` already *is* the Shams warehouse
-- code (`P0001`) that every one of these workbooks keys on. Inventing a tenant
-- table to hold a single constant row would add a join to every query in the
-- module and isolate nothing.

-- ===========================================================================
-- 1. Product eligibility
-- ===========================================================================
-- Configuration, not code. The brief names six product families; the workbooks
-- contain 25 distinct eligible SKUs across them, plus three insulins the team
-- worked anyway and two FreeStyle products they never touched. Encoding any of
-- that in TypeScript would mean a deployment every time the pharmacy adds a
-- strength.

CREATE TABLE IF NOT EXISTS public.telesales_products (
  -- The Shams item code (`Itm_Cd`). Text, not integer: it is an identifier that
  -- is only ever compared, and the upstream is free to widen it.
  item_code       text PRIMARY KEY,

  -- Last name seen for this code, for display. Not authoritative -- the same
  -- code carried one spelling throughout the workbooks, but that is an
  -- observation, not a guarantee.
  item_name       text NOT NULL,

  -- The commercial family the desk thinks in: 'mounjaro', 'ozempic', 'wegovy',
  -- 'rybelsus', 'freestyle_libre', 'dexcom', plus 'insulin'/'other' for what is
  -- seeded only so it can be excluded on purpose. Free text rather than an enum
  -- so adding a family is an INSERT.
  family          text NOT NULL,

  -- "12.5 MG", "1.7 MG", "3 PLUS SENSOR". Display only; never parsed.
  strength        text,

  -- Shams' own `sub Categ` where the workbook carried it.
  category        text,

  -- Eligibility is per lead type because they are different questions. A
  -- FreeStyle reader is a legitimate Cash lead and a meaningless retention one:
  -- a sensor is consumed and re-ordered, a reader is bought once.
  eligible_cash       boolean NOT NULL DEFAULT false,
  eligible_retention  boolean NOT NULL DEFAULT false,

  -- Nominal refill interval in days, used to propose a retention follow-up date
  -- when an agent records an order without choosing one. NULL means "the agent
  -- must say", which is the honest default for everything the workbooks did not
  -- evidence.
  refill_days     integer CHECK (refill_days IS NULL OR refill_days > 0),

  -- Why this row is configured the way it is. Read by the person who will one
  -- day wonder why FreeStyle Optium is present and switched off.
  notes           text,

  active          boolean NOT NULL DEFAULT true,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS telesales_products_family_idx
  ON public.telesales_products (family) WHERE active;
CREATE INDEX IF NOT EXISTS telesales_products_cash_idx
  ON public.telesales_products (item_code) WHERE active AND eligible_cash;

-- ---------------------------------------------------------------------------
-- Name patterns, for codes not yet listed
-- ---------------------------------------------------------------------------
-- A new Mounjaro strength arrives with a code nobody has seen. Matching on the
-- name gets it into the queue the same day; the alternative is that it is
-- silently invisible until somebody notices.
--
-- `priority` exists because the rules must be able to contradict each other in a
-- defined order. FreeStyle Optium is the case that forced it: "FREESTYLE" is a
-- correct positive rule for Libre and a wrong one for Optium test strips, which
-- appear 42 times in the July extract and never once in a working sheet. A
-- lower-priority exclusion is evaluated first and wins.
CREATE TABLE IF NOT EXISTS public.telesales_product_patterns (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),

  -- Case-insensitive regular expression matched against the item name after
  -- whitespace collapsing. Not `LIKE`: the names carry punctuation
  -- ("MOUNJARO KWIKPEN 12.5 MG/0.6ML 2.4ML*1 QR") that makes anchoring by hand
  -- unreadable.
  pattern     text NOT NULL,

  family      text NOT NULL,

  -- false makes this an exclusion: a match means "not eligible", and stops the
  -- scan. This is how FreeStyle Optium is kept out of a FreeStyle rule.
  eligible    boolean NOT NULL DEFAULT true,

  -- Lower runs first.
  priority    integer NOT NULL DEFAULT 100,

  notes       text,
  active      boolean NOT NULL DEFAULT true,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS telesales_product_patterns_order_idx
  ON public.telesales_product_patterns (priority, id) WHERE active;

-- ===========================================================================
-- 2. Settings -- the date windows, in one row
-- ===========================================================================
-- The most consequential thing in this module is which dates count, and the
-- workbooks do not agree with the brief about it.
--
-- The brief says: on 1 August the Cash desk checks 1, 2 and 3 July. The
-- workbooks say: each working sheet covers at most three *consecutive* invoice
-- dates (`3-4`, `15-17`, `24-26`, `27-29`). Both are true, and the reason is
-- that the extract arrives monthly, so during August the team was walking a
-- three-day window through July.
--
-- Encoding "three days ago" would therefore be encoding an accident of file
-- delivery. What is invariant is the shape: a window of N consecutive days,
-- ending some lag before the date being worked. Both numbers live here, and a
-- generation run may also be given an explicit anchor date -- which is exactly
-- what the team was doing by hand.
CREATE TABLE IF NOT EXISTS public.telesales_settings (
  -- Singleton. The CHECK is the whole point of the column.
  id                          boolean PRIMARY KEY DEFAULT true CHECK (id),

  -- Cash: how many consecutive invoice dates one run covers. 3, from the branch
  -- reservation period and confirmed by the widest working sheets.
  cash_window_days            integer NOT NULL DEFAULT 3
                              CHECK (cash_window_days BETWEEN 1 AND 31),

  -- Cash: how far behind the anchor date the window ends. 1 = the window ends
  -- yesterday, so an anchor of 1 August covers 29, 30 and 31 July. Zero would
  -- include the anchor day itself, which the desk does not do -- an invoice
  -- written this morning is not a lead this afternoon.
  cash_window_lag_days        integer NOT NULL DEFAULT 1
                              CHECK (cash_window_lag_days BETWEEN 0 AND 60),

  -- Wasfaty: how many days forward from the anchor, inclusive. 2 = today and
  -- tomorrow. The second day is the pre-opening allowance -- some prescriptions
  -- become dispensable a day before their nominal next-dispense date.
  wasfaty_window_days         integer NOT NULL DEFAULT 2
                              CHECK (wasfaty_window_days BETWEEN 1 AND 31),

  -- Retention: how many days past due a follow-up may be and still be raised
  -- automatically. Beyond it the follow-up is overdue and shown as such, but the
  -- generator stops re-raising it; somebody has to decide.
  retention_overdue_grace_days integer NOT NULL DEFAULT 14
                              CHECK (retention_overdue_grace_days BETWEEN 0 AND 365),

  -- The master switch for scheduled generation. Manual generation ignores it.
  automation_enabled          boolean NOT NULL DEFAULT false,

  -- Riyadh-local hour at which the daily run fires (0-23).
  generation_hour             integer NOT NULL DEFAULT 7
                              CHECK (generation_hour BETWEEN 0 AND 23),

  updated_by                  uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  updated_at                  timestamptz NOT NULL DEFAULT now()
);

INSERT INTO public.telesales_settings (id) VALUES (true) ON CONFLICT (id) DO NOTHING;

-- ===========================================================================
-- 3. Imports -- the raw drop
-- ===========================================================================
CREATE TABLE IF NOT EXISTS public.telesales_imports (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),

  -- 'cash', 'wasfaty' or 'retention'.
  --
  -- Retention is normally *generated*, not imported: a retention lead is the
  -- next cycle of a conversion this system recorded. The import path exists for
  -- one reason -- on the day the desk switches over, the Retention workbook
  -- holds 745 live rows, 328 of them carrying a scheduled callback date. A
  -- cutover that dropped those would lose every customer the team had already
  -- promised to ring back, which is the exact failure this module is meant to
  -- end. It is a one-time backlog path, and it is recorded as an import so those
  -- leads are visibly seeded rather than indistinguishable from generated ones.
  source_type       text NOT NULL CHECK (source_type IN ('cash', 'wasfaty', 'retention')),

  file_name         text NOT NULL,
  file_size         bigint,
  sheet_name        text,

  -- Digest of the parsed rows. A second upload of an identical workbook is
  -- recognised and reported rather than silently reprocessed.
  content_digest    text,

  status            text NOT NULL DEFAULT 'completed'
                    CHECK (status IN ('parsing', 'completed', 'failed')),

  rows_total        integer NOT NULL DEFAULT 0,
  rows_stored       integer NOT NULL DEFAULT 0,
  rows_duplicate    integer NOT NULL DEFAULT 0,
  rows_rejected     integer NOT NULL DEFAULT 0,

  -- Per-issue counts and a bounded sample of offending row numbers. Never
  -- customer data: the sample is row numbers and a reason string.
  issues            jsonb NOT NULL DEFAULT '{}'::jsonb,

  error_summary     text,

  imported_by       uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  -- The role held at import time, denormalised so a later promotion does not
  -- rewrite history. Same reasoning as `branch_imports.actor_role`.
  actor_role        text,
  imported_at       timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS telesales_imports_recent_idx
  ON public.telesales_imports (imported_at DESC);
CREATE INDEX IF NOT EXISTS telesales_imports_digest_idx
  ON public.telesales_imports (source_type, content_digest)
  WHERE content_digest IS NOT NULL;

-- ===========================================================================
-- 4. Source records -- normalised, never overwritten
-- ===========================================================================
-- One table for both source types rather than two. They share customer,
-- product, branch, date and document; they differ in five columns. Two tables
-- would mean two importers, two generators and a UNION in every management
-- query, to avoid five nullable columns.
CREATE TABLE IF NOT EXISTS public.telesales_source_records (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  import_id       uuid NOT NULL REFERENCES public.telesales_imports(id) ON DELETE CASCADE,
  source_type     text NOT NULL CHECK (source_type IN ('cash', 'wasfaty', 'retention')),

  -- 1-based position in the sheet, so an operator can be told "row 412".
  row_number      integer NOT NULL,

  -- Identity of the row's content, independent of which file it arrived in.
  -- Two imports that overlap store both rows -- history is never destroyed --
  -- but the generator uses this to recognise the second as the same fact.
  content_hash    text NOT NULL,

  -- --- customer ------------------------------------------------------------
  customer_ref    text,          -- Shams `Id`
  customer_name   text,
  phone_raw       text,          -- exactly as the cell read
  phone_e164      text,          -- normalised, NULL when unusable

  -- --- where ---------------------------------------------------------------
  -- The Shams warehouse code. Intentionally NOT a foreign key to `branches`:
  -- the extracts contain codes the directory does not carry (124 distinct codes
  -- in July alone, including P0503), and refusing a row because a branch is
  -- missing from a hand-maintained directory would lose a real lead.
  branch_no       text,
  city            text,
  facility        text,

  -- --- what ----------------------------------------------------------------
  item_code       text,
  item_name       text,
  quantity        numeric(12,3),
  unit_price      numeric(12,2),
  total_value     numeric(12,2),

  -- --- when ----------------------------------------------------------------
  -- The operative date for this row's lead type: the invoice date for Cash, the
  -- next-dispense date for Wasfaty. Normalised at import; NULL when the cell was
  -- unparseable, which is recorded as an issue rather than guessed.
  source_date     date,
  -- Older Wasfaty sheets carry a fill date instead of a next-dispense date.
  fill_date       date,
  dispense_time   text,
  -- The workbooks' "Date to be called": a callback somebody has already promised
  -- a customer. Only populated by the retention backlog import, and turned into
  -- a real follow-up row rather than left sitting here as a column.
  callback_date   date,

  -- --- identifiers ---------------------------------------------------------
  document_no     text,          -- Cash `InvNo`
  channel         text,          -- Cash `Customer`: CASH IN BOX / TAMARA / ...
  patient_id      text,          -- Wasfaty
  prescription_no text,          -- Wasfaty

  -- The untouched row, so a parsing decision can always be audited against what
  -- the cell actually said.
  raw             jsonb NOT NULL DEFAULT '{}'::jsonb,

  created_at      timestamptz NOT NULL DEFAULT now()
);

-- A given import stores a given row once. Re-running the parse of one upload is
-- then idempotent, while two *different* uploads still each keep their own copy.
CREATE UNIQUE INDEX IF NOT EXISTS telesales_source_records_import_row_uidx
  ON public.telesales_source_records (import_id, row_number);

CREATE INDEX IF NOT EXISTS telesales_source_records_hash_idx
  ON public.telesales_source_records (source_type, content_hash);
-- The generator's read: eligible rows in a date window.
CREATE INDEX IF NOT EXISTS telesales_source_records_window_idx
  ON public.telesales_source_records (source_type, source_date)
  WHERE source_date IS NOT NULL;
CREATE INDEX IF NOT EXISTS telesales_source_records_import_idx
  ON public.telesales_source_records (import_id);

-- ===========================================================================
-- 5. Generation runs
-- ===========================================================================
CREATE TABLE IF NOT EXISTS public.telesales_generation_runs (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),

  lead_type         text NOT NULL CHECK (lead_type IN ('cash', 'retention', 'wasfaty')),
  execution_source  text NOT NULL DEFAULT 'scheduled'
                    CHECK (execution_source IN ('scheduled', 'manual')),

  -- The Riyadh-local date the run was anchored to. Not `now()::date`: a run may
  -- deliberately be anchored to a past date to reproduce or backfill a day, and
  -- the point of recording it is that the two can differ.
  anchor_date       date NOT NULL,
  -- The window the anchor and settings produced, stored rather than recomputed,
  -- because the settings may since have changed.
  window_from       date,
  window_to         date,

  status            text NOT NULL DEFAULT 'running'
                    CHECK (status IN ('running', 'completed', 'failed')),

  candidates        integer NOT NULL DEFAULT 0,
  leads_created     integer NOT NULL DEFAULT 0,
  skipped_duplicate integer NOT NULL DEFAULT 0,
  skipped_ineligible integer NOT NULL DEFAULT 0,
  errors            integer NOT NULL DEFAULT 0,
  error_summary     text,

  actor_id          uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  started_at        timestamptz NOT NULL DEFAULT now(),
  completed_at      timestamptz
);

CREATE INDEX IF NOT EXISTS telesales_generation_runs_recent_idx
  ON public.telesales_generation_runs (started_at DESC);
-- Backs the "has this anchor already been generated" check.
CREATE INDEX IF NOT EXISTS telesales_generation_runs_anchor_idx
  ON public.telesales_generation_runs (lead_type, anchor_date, status);

-- ===========================================================================
-- 6. Leads
-- ===========================================================================
CREATE TABLE IF NOT EXISTS public.telesales_leads (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),

  lead_type         text NOT NULL CHECK (lead_type IN ('cash', 'retention', 'wasfaty')),

  -- The row this lead came from. NULL for retention, which is generated from a
  -- previous lead rather than from a file. ON DELETE SET NULL rather than
  -- CASCADE: deleting an import must never delete the work done on its leads.
  source_record_id  uuid REFERENCES public.telesales_source_records(id) ON DELETE SET NULL,
  -- The run that created it, for "why did this appear today".
  generation_run_id uuid REFERENCES public.telesales_generation_runs(id) ON DELETE SET NULL,

  -- ---------------------------------------------------------------------
  -- Deduplication
  -- ---------------------------------------------------------------------
  -- The one rule that decides whether re-importing a file doubles the desk's
  -- workload. Composed per lead type by `src/lib/telesales/dedup.ts`; the
  -- database enforces it rather than trusting the generator, because the
  -- generator will one day be run twice concurrently.
  dedup_key         text NOT NULL,

  status            text NOT NULL DEFAULT 'new'
                    CHECK (status IN ('new', 'assigned', 'in_progress',
                                      'follow_up', 'converted',
                                      'closed_lost', 'closed_unreachable',
                                      'closed_duplicate')),

  -- The last outcome an agent recorded, in the desk's own vocabulary. Kept
  -- beside `status` rather than folded into it because the workbooks prove they
  -- are different questions: "No Answer or Busy" is an outcome that leaves the
  -- lead open, "Answered - No Order" is an outcome that closes it, and both are
  -- worth counting separately from the state they produced.
  last_outcome      text,

  -- 0 is normal. Higher sorts first in the queue.
  priority          integer NOT NULL DEFAULT 0,

  -- --- ownership -----------------------------------------------------------
  assigned_to       uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  assigned_at       timestamptz,
  assigned_by       uuid REFERENCES auth.users(id) ON DELETE SET NULL,

  -- --- denormalised customer/product face ----------------------------------
  -- Copied from the source record on purpose. A queue that renders 50 rows must
  -- not join four tables, and a lead is a *snapshot* of an opportunity: if a
  -- later import spells the customer's name differently, the lead the agent
  -- worked should still say what it said.
  customer_ref      text,
  customer_name     text,
  phone_e164        text,
  branch_no         text,
  city              text,
  facility          text,
  channel           text,

  item_code         text,
  item_name         text,
  product_family    text,
  product_strength  text,
  quantity          numeric(12,3),
  total_value       numeric(12,2),

  document_no       text,
  patient_id        text,
  prescription_no   text,

  -- The date from the source that made this eligible.
  source_date       date,

  -- Why this lead exists, in a sentence, e.g. "Cash window 29-31 Jul 2026".
  -- Written once, shown on the detail page.
  generation_reason text,

  -- --- retention cycles ----------------------------------------------------
  -- A retention lead is the next cycle of a previous lead, so the chain is a
  -- self-reference rather than a separate `retention_cycles` table. That keeps
  -- one activity log, one follow-up table and one queue for the agent, and it
  -- makes "never overwrite the previous cycle" structural: a new cycle is a new
  -- row that points at the old one, which is untouched.
  cycle_number      integer NOT NULL DEFAULT 1 CHECK (cycle_number >= 1),
  parent_lead_id    uuid REFERENCES public.telesales_leads(id) ON DELETE SET NULL,

  -- --- contact state -------------------------------------------------------
  contact_attempts  integer NOT NULL DEFAULT 0,
  first_contacted_at timestamptz,
  last_contacted_at timestamptz,
  -- Maintained by trigger from the open follow-up, so the queue can sort and
  -- filter on it without a correlated subquery.
  next_followup_on  date,

  -- --- closure -------------------------------------------------------------
  converted_at      timestamptz,
  -- The MilaPortal order this lead became, when the agent creates one. Nullable
  -- and ON DELETE SET NULL: a lead outlives the order it produced.
  order_id          uuid REFERENCES public.orders(id) ON DELETE SET NULL,
  converted_value   numeric(12,2),
  closed_at         timestamptz,
  closed_reason     text,

  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now()
);

-- The duplicate guard. One operational lead per identity per type -- this is the
-- index that makes re-importing an overlapping file a no-op.
CREATE UNIQUE INDEX IF NOT EXISTS telesales_leads_dedup_uidx
  ON public.telesales_leads (lead_type, dedup_key);

-- The agent queue's read: open work, highest priority, oldest first.
CREATE INDEX IF NOT EXISTS telesales_leads_queue_idx
  ON public.telesales_leads (lead_type, status, priority DESC, created_at)
  WHERE status IN ('new', 'assigned', 'in_progress', 'follow_up');
CREATE INDEX IF NOT EXISTS telesales_leads_assigned_idx
  ON public.telesales_leads (assigned_to, status)
  WHERE assigned_to IS NOT NULL;
CREATE INDEX IF NOT EXISTS telesales_leads_unassigned_idx
  ON public.telesales_leads (lead_type, created_at)
  WHERE assigned_to IS NULL AND status = 'new';
CREATE INDEX IF NOT EXISTS telesales_leads_followup_idx
  ON public.telesales_leads (next_followup_on)
  WHERE next_followup_on IS NOT NULL;
CREATE INDEX IF NOT EXISTS telesales_leads_branch_idx ON public.telesales_leads (branch_no);
CREATE INDEX IF NOT EXISTS telesales_leads_created_idx ON public.telesales_leads (created_at DESC);
CREATE INDEX IF NOT EXISTS telesales_leads_parent_idx
  ON public.telesales_leads (parent_lead_id) WHERE parent_lead_id IS NOT NULL;
-- Retention generation asks "which converted leads are due another cycle".
CREATE INDEX IF NOT EXISTS telesales_leads_retention_source_idx
  ON public.telesales_leads (status, converted_at)
  WHERE status = 'converted';

-- ===========================================================================
-- 7. Activity -- append only
-- ===========================================================================
CREATE TABLE IF NOT EXISTS public.telesales_lead_activities (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  lead_id       uuid NOT NULL REFERENCES public.telesales_leads(id) ON DELETE CASCADE,

  activity_type text NOT NULL,
  outcome       text,
  note          text,

  -- The transition this activity caused, so the timeline can be read without
  -- replaying every rule. NULL/NULL for a note.
  from_status   text,
  to_status     text,

  actor_id      uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  -- Denormalised for the same reason as `telesales_imports.actor_role`, and
  -- because `ON DELETE SET NULL` above means a deleted user must still leave a
  -- legible trail.
  actor_name    text,
  actor_role    text,

  metadata      jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at    timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS telesales_lead_activities_lead_idx
  ON public.telesales_lead_activities (lead_id, created_at DESC);
CREATE INDEX IF NOT EXISTS telesales_lead_activities_actor_idx
  ON public.telesales_lead_activities (actor_id, created_at DESC);

-- ===========================================================================
-- 8. Follow-ups
-- ===========================================================================
CREATE TABLE IF NOT EXISTS public.telesales_followups (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  lead_id       uuid NOT NULL REFERENCES public.telesales_leads(id) ON DELETE CASCADE,

  assigned_to   uuid REFERENCES auth.users(id) ON DELETE SET NULL,

  -- Riyadh-local calendar date. `date`, not `timestamptz`: "call them Thursday"
  -- is a day, and storing it as an instant would make it drift across midnight
  -- for anybody reading it from another zone.
  due_on        date NOT NULL,
  -- Optional, for "after 6pm". Also local wall-clock, also deliberately not an
  -- instant.
  due_time      time,

  reason        text,

  status        text NOT NULL DEFAULT 'scheduled'
                CHECK (status IN ('scheduled', 'completed', 'cancelled')),

  completed_at  timestamptz,
  completed_by  uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  result        text,
  notes         text,

  created_by    uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now()
);

-- At most one open follow-up per lead. Two would mean two agents each told to
-- call the same customer on a different day, which is the failure the module
-- exists to remove.
CREATE UNIQUE INDEX IF NOT EXISTS telesales_followups_one_open_uidx
  ON public.telesales_followups (lead_id) WHERE status = 'scheduled';
CREATE INDEX IF NOT EXISTS telesales_followups_due_idx
  ON public.telesales_followups (due_on, assigned_to) WHERE status = 'scheduled';
CREATE INDEX IF NOT EXISTS telesales_followups_lead_idx
  ON public.telesales_followups (lead_id, created_at DESC);

-- ===========================================================================
-- 9. Wasfaty phone numbers
-- ===========================================================================
-- 2,774 of the 3,952 rows in `Wasfaty Aug` have no phone number, and the five
-- per-city sheets have none at all. The number is obtained by an agent looking
-- the patient up in the Wasfaty system by Patient ID and Prescription No.
--
-- There is no Wasfaty API here and none is assumed. This table is the manual
-- workflow done once: the number is recorded against the patient, with who
-- found it and when, and every later prescription for that patient is answered
-- from it instead of sending the agent back to the portal.
CREATE TABLE IF NOT EXISTS public.telesales_patient_contacts (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  patient_id      text NOT NULL,

  phone_e164      text NOT NULL,
  phone_raw       text,

  -- 'agent' (looked up in the Wasfaty portal) or 'import' (the file carried it).
  -- Distinct because an imported number has never been confirmed by anyone.
  source          text NOT NULL DEFAULT 'agent'
                  CHECK (source IN ('agent', 'import')),

  -- The prescription the agent was working when they found it. Provenance, not
  -- a key -- the number belongs to the patient.
  prescription_no text,

  added_by        uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  added_at        timestamptz NOT NULL DEFAULT now(),

  -- Correction history. A replaced number is kept, never updated in place, so
  -- "the number we called last month" remains answerable.
  superseded_at   timestamptz,
  superseded_by   uuid REFERENCES auth.users(id) ON DELETE SET NULL,

  notes           text
);

-- One current number per patient. Corrections supersede rather than overwrite.
CREATE UNIQUE INDEX IF NOT EXISTS telesales_patient_contacts_current_uidx
  ON public.telesales_patient_contacts (patient_id) WHERE superseded_at IS NULL;
CREATE INDEX IF NOT EXISTS telesales_patient_contacts_patient_idx
  ON public.telesales_patient_contacts (patient_id, added_at DESC);
