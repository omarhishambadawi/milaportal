-- Single-round-trip reads for the CDR mirror.
--
-- ---------------------------------------------------------------------------
-- What was slow
-- ---------------------------------------------------------------------------
-- `cdr-store.server.ts` read a window through PostgREST with `.in(business_day,
-- …)` + `.order(row_id)` + `.range(offset, offset+999)`. PostgREST caps a
-- response at 1,000 rows, so a full month (~14,000 mirrored legs) was ~16 paged
-- requests, and every one of them re-executed the SAME query from scratch:
--
--   * the `ORDER BY row_id` is not satisfiable from `cdr_records_business_day_idx`,
--     so each page re-scanned and re-sorted the whole day group — and the sort
--     carries the `raw` jsonb payload (~600 bytes/row), which is the expensive
--     part to detoast and to sort;
--   * `OFFSET n` then threw away the first n rows it had just materialised, so
--     page 4 did four pages' worth of work to return one page;
--   * the ordering itself was never wanted. It existed ONLY to make `.range()`
--     paging stable. The caller buckets rows by `business_day` and hands them to
--     `classifyRecords`, which groups by `call_id` — neither cares what order the
--     legs arrive in.
--
-- ---------------------------------------------------------------------------
-- What these functions do instead
-- ---------------------------------------------------------------------------
-- Return the window in ONE request, aggregated per business day, so the row
-- count of the response is the number of DAYS (at most a few hundred) rather
-- than the number of legs. That removes the 1,000-row cap as a constraint, so
-- there is no paging, no OFFSET and no ORDER BY left to pay for — one index scan
-- on `cdr_records_business_day_idx` per call.
--
-- `json_agg` rather than `jsonb_agg` deliberately: the input is already jsonb, so
-- json_agg serialises each element straight to text instead of building a second
-- ~10 MB binary jsonb container only to serialise that. The bytes on the wire are
-- identical either way, and identical to what the paged path returned — these
-- functions re-shape the response envelope, never the rows inside it. Yeastar
-- remains the source of truth and `raw` is still handed back exactly as stored.
--
-- ---------------------------------------------------------------------------
-- Access
-- ---------------------------------------------------------------------------
-- Service-role only, matching `cdr_records` itself (RLS enabled, no policies).
-- These rows carry customer phone numbers, and the rules that govern who may see
-- which calls live in the Calls server functions — a function reachable by
-- `authenticated` would bypass every one of them. SECURITY INVOKER, so the
-- caller's own privileges still apply and the function grants nothing the caller
-- did not already have.

-- ---------------------------------------------------------------------------
-- cdr_window_rows — the mirrored legs for a set of business days.
-- ---------------------------------------------------------------------------
-- Takes an explicit day ARRAY rather than a range because the caller asks for
-- exactly the days it could not answer from memory, and those need not be
-- contiguous. Days with no calls are simply absent from the result; the caller
-- already treats a requested-but-absent day as "mirrored and empty", which is
-- what `cdr_sync_days` is for.
CREATE OR REPLACE FUNCTION public.cdr_window_rows(p_days date[])
RETURNS TABLE (business_day date, rows json)
LANGUAGE sql
STABLE
SECURITY INVOKER
SET search_path = public
AS $$
  SELECT r.business_day, json_agg(r.raw) AS rows
  FROM public.cdr_records r
  WHERE r.business_day = ANY(p_days)
  GROUP BY r.business_day
$$;

REVOKE ALL ON FUNCTION public.cdr_window_rows(date[]) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.cdr_window_rows(date[]) TO service_role;

COMMENT ON FUNCTION public.cdr_window_rows(date[]) IS
  'Mirrored CDR legs for the given business days, grouped by day, in one round '
  'trip. Replaces PostgREST offset paging over cdr_records. Service-role only.';

-- ---------------------------------------------------------------------------
-- cdr_rows_by_number — one subscriber's legs over a window (Call Lookup).
-- ---------------------------------------------------------------------------
-- The old path ran TWO paged walks, one per number column, and de-duplicated the
-- union client-side. One predicate lets the planner BitmapOr the two existing
-- `(call_from_number, business_day)` / `(call_to_number, business_day)` indexes,
-- and since `row_id` is the primary key a row can only appear once — so the
-- de-duplication has nothing left to do.
--
-- Returns a single json value, not a set, so the response can never be clipped by
-- a row cap however much history a number has. As on the PBX path this is only a
-- PRE-filter: the caller re-applies its own authoritative suffix match.
CREATE OR REPLACE FUNCTION public.cdr_rows_by_number(
  p_from date,
  p_to date,
  p_numbers text[]
)
RETURNS json
LANGUAGE sql
STABLE
SECURITY INVOKER
SET search_path = public
AS $$
  SELECT COALESCE(json_agg(r.raw), '[]'::json)
  FROM public.cdr_records r
  WHERE r.business_day BETWEEN p_from AND p_to
    AND (r.call_from_number = ANY(p_numbers) OR r.call_to_number = ANY(p_numbers))
$$;

REVOKE ALL ON FUNCTION public.cdr_rows_by_number(date, date, text[]) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.cdr_rows_by_number(date, date, text[]) TO service_role;

COMMENT ON FUNCTION public.cdr_rows_by_number(date, date, text[]) IS
  'Mirrored CDR legs for one subscriber over a window, in one round trip. '
  'Pre-filter only — the caller re-applies its own suffix match. Service-role only.';

-- No new indexes. Both functions are driven by indexes this table already has:
-- `cdr_records_business_day_idx` for the window read, and the two
-- `(number, business_day)` indexes for the lookup. What was slow was the offset
-- paging and the sort it required, not the row selection.