-- Where an AlShrouq delivery goes, and the removal of a branch mapping that was
-- wrong for 87 of 136 branches.
--
-- ===========================================================================
-- 1. The hardcoded branch mapping, and why it is being taken out
-- ===========================================================================
-- `20260820180000_alshrouq_dispatch.sql` froze a 137-row Shams-code → AlShrouq-id
-- mapping into `branches.alshrouq_branch_id`. Checked against the CRM's own
-- `GET /integrations/alshrouq/config`, which publishes that mapping live, it was:
--
--     49  correct
--     27  pointing at ANOTHER PHARMACY'S id  (P0101-P0127, shifted by 60 rows)
--     61  branch codes that do not exist in the CRM at all (P0041-P0100)
--     60  real branches left with no mapping
--
-- The 27 are the dangerous ones: a valid-looking dispatch that sends a real
-- delivery to the wrong shop. The seed assumed the branch codes ran contiguously
-- from P0001; they do not -- they jump P0040 → P0101 → P0201 → P0301 → P0401 →
-- P0501 → P0601 → P0701, and the workbook even orders P0503 before P0502.
--
-- The column is dropped rather than corrected. A second frozen copy would drift
-- for the same reason the first did -- the CRM's live list already differs from
-- the shipped workbook by one branch (P0005, which the CRM no longer lists) --
-- and it also cannot express `covered`, the flag that marks the 18 branches
-- AlShrouq does not serve. `branchCoverage()` in `src/lib/alshrouq/dispatch.ts`
-- now reads both from the CRM on every dispatch, cached for five minutes.
--
-- No data is lost that anyone would want back: every value in the column was
-- either wrong or reproducible from the CRM in one request.

BEGIN;

DROP INDEX IF EXISTS public.branches_alshrouq_branch_id_key;
ALTER TABLE public.branches DROP COLUMN IF EXISTS alshrouq_branch_id;

-- ===========================================================================
-- 2. The customer's location, on the order
-- ===========================================================================
-- `orders` records who ordered and which branch fills it, and nothing about
-- where the customer is -- correct while every delivery was arranged by a person
-- on a phone call, and insufficient the moment the courier is an API.
--
-- Deliberately *not* an address system: no city, district or street. The portal
-- stores what the customer already sends -- a Google Maps link -- plus the point
-- read out of it. Both halves are kept because they are not interchangeable: the
-- link names the building a driver is looking for, the point is what routing
-- consumes. The CRM's own dispatch records carry exactly this pair, which is why
-- `customer_address` on the wire is a URL and not a street address.
--
-- `numeric(10,7)` matches `branches.latitude`/`longitude`, so a customer point
-- and a branch point are the same kind of number. 7 decimal places is ~1cm.

ALTER TABLE public.orders
  ADD COLUMN IF NOT EXISTS alshrouq_map_url      text,
  ADD COLUMN IF NOT EXISTS alshrouq_lat          numeric(10, 7),
  ADD COLUMN IF NOT EXISTS alshrouq_lng          numeric(10, 7),
  ADD COLUMN IF NOT EXISTS alshrouq_payment_type integer;

-- A point is both numbers or neither. Nothing here ties the columns to
-- `delivery_type`: every AlShrouq order created before today has no location and
-- never will, and a CHECK would make those rows invalid and every UPDATE to one
-- fail -- including the invoice triggers that touch orders nobody is editing.
-- "Required when the method is AlShrouq" is a rule about what an agent must type
-- now, so it lives in `orderFormSchema`, not here.
ALTER TABLE public.orders
  DROP CONSTRAINT IF EXISTS orders_alshrouq_point_complete;
ALTER TABLE public.orders
  ADD CONSTRAINT orders_alshrouq_point_complete
  CHECK ((alshrouq_lat IS NULL) = (alshrouq_lng IS NULL));

-- The CRM's payment ids: 1 COD, 2 SPAN Machine, 3 Paid, 4 AlshrouqPay. Bounded
-- rather than enumerated -- the list is the CRM's to change, and a CHECK naming
-- four values would have to be migrated the day it adds a fifth.
ALTER TABLE public.orders
  DROP CONSTRAINT IF EXISTS orders_alshrouq_payment_type_positive;
ALTER TABLE public.orders
  ADD CONSTRAINT orders_alshrouq_payment_type_positive
  CHECK (alshrouq_payment_type IS NULL OR alshrouq_payment_type > 0);

COMMENT ON COLUMN public.orders.alshrouq_map_url IS
  'Google Maps link to the customer''s delivery location, as pasted or resolved. Sent to the CRM as customer_address. Names the place; alshrouq_lat/lng are what a courier routes to.';
COMMENT ON COLUMN public.orders.alshrouq_lat IS
  'Customer delivery latitude, numeric(10,7) to match branches.latitude. Null except on AlShrouq orders created after this migration.';
COMMENT ON COLUMN public.orders.alshrouq_lng IS
  'Customer delivery longitude. Constrained to be set exactly when alshrouq_lat is.';
COMMENT ON COLUMN public.orders.alshrouq_payment_type IS
  'The CRM''s numeric payment id from GET /integrations/alshrouq/config. Not an enum here: the list belongs to the CRM.';

-- ===========================================================================
-- 3. What the courier gave back
-- ===========================================================================
-- `local_id` is the CRM's own row id -- what refresh and cancel take. It is not
-- the number a supervisor quotes to AlShrouq on the phone; that is
-- `external_order_id` (5648616 in the verified record), which had nowhere to be
-- stored. Both are kept because neither substitutes for the other.

ALTER TABLE public.alshrouq_dispatches
  ADD COLUMN IF NOT EXISTS external_order_id text,
  ADD COLUMN IF NOT EXISTS tracking_url      text,
  -- The map link actually sent, so the dispatch record shows what the courier
  -- was told rather than what the order says now.
  ADD COLUMN IF NOT EXISTS customer_address  text;

COMMENT ON COLUMN public.alshrouq_dispatches.external_order_id IS
  'AlShrouq''s own order number, as opposed to local_id which is the CRM''s. The reference quoted when chasing a delivery.';
COMMENT ON COLUMN public.alshrouq_dispatches.tracking_url IS
  'Customer-facing tracking page returned by the CRM, when it returns one.';

CREATE INDEX IF NOT EXISTS alshrouq_dispatches_external_order_idx
  ON public.alshrouq_dispatches (external_order_id)
  WHERE external_order_id IS NOT NULL;

-- payment_type was text; the CRM's contract is numeric. Cast rather than
-- recreate so the unique indexes and the FK survive. Anything non-numeric
-- becomes NULL rather than failing the migration -- there is no such row today,
-- and a stuck migration is worse than a dispatch record with an unknown method.
ALTER TABLE public.alshrouq_dispatches
  ALTER COLUMN payment_type DROP NOT NULL;
ALTER TABLE public.alshrouq_dispatches
  ALTER COLUMN payment_type TYPE integer
  USING (NULLIF(regexp_replace(payment_type::text, '\D', '', 'g'), '')::integer);

COMMIT;