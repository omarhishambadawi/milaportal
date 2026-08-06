-- CDR synchronization layer.
--
-- Yeastar remains the SOURCE OF TRUTH. These three tables are a MIRROR of what
-- the PBX already holds, maintained incrementally so the Calls dashboards can
-- read a window from Postgres instead of waiting on a live PBX sweep. Nothing
-- here derives a KPI: `cdr_records.raw` is the row exactly as the PBX emitted
-- it, so the existing normalization/metrics pipeline receives byte-identical
-- input whichever source answered.
--
-- Service-role only, exactly like `cdr_progress` and `yeastar_token_cache`:
-- RLS is enabled with NO policies, so `authenticated` and `anon` can read
-- nothing. Call records carry customer phone numbers, and the access rules that
-- govern them (per-team confinement, agent scoping) live in the Calls server
-- functions — a direct PostgREST read would bypass every one of them.

-- ---------------------------------------------------------------------------
-- cdr_records — the mirrored rows.
-- ---------------------------------------------------------------------------
-- A row is a LEG, not a call (see docs/project.md, "Yeastar Integration").
-- `row_id` is the PBX's own `new_id`, which is unique per ROW on this firmware
-- and is therefore the idempotency key: re-synchronizing an overlapping window
-- upserts the same ids and can never produce a duplicate. When a row arrives
-- without `new_id` the sync layer derives a deterministic composite key from
-- the fields that identify the leg, so the same leg still maps to the same id.
CREATE TABLE IF NOT EXISTS public.cdr_records (
  row_id           text PRIMARY KEY,
  -- Shared by every leg of one call. NOT unique.
  call_id          text,
  -- Epoch seconds, UTC — the PBX's own `timestamp`, authoritative for windows.
  ts               bigint NOT NULL,
  -- The business-timezone (Asia/Riyadh) day `ts` falls in. Computed by the sync
  -- layer with the same helper the in-memory day cache uses, so a day means the
  -- same thing in both tiers.
  business_day     date NOT NULL,
  -- Denormalized for Call Lookup, which queries by subscriber number.
  call_from_number text,
  call_to_number   text,
  -- The row as received. Nothing downstream reads the columns above.
  raw              jsonb NOT NULL,
  synced_at        timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS cdr_records_business_day_idx ON public.cdr_records (business_day);
CREATE INDEX IF NOT EXISTS cdr_records_ts_idx ON public.cdr_records (ts);
CREATE INDEX IF NOT EXISTS cdr_records_call_id_idx ON public.cdr_records (call_id);
-- Call Lookup filters on either end of the call over a trailing window, so both
-- number indexes carry the day to keep the window predicate on the index.
CREATE INDEX IF NOT EXISTS cdr_records_from_day_idx
  ON public.cdr_records (call_from_number, business_day);
CREATE INDEX IF NOT EXISTS cdr_records_to_day_idx
  ON public.cdr_records (call_to_number, business_day);

ALTER TABLE public.cdr_records ENABLE ROW LEVEL SECURITY;
GRANT ALL ON public.cdr_records TO service_role;

-- ---------------------------------------------------------------------------
-- cdr_sync_days — which business days the mirror actually covers.
-- ---------------------------------------------------------------------------
-- Without this a QUIET day is indistinguishable from an UNSYNCED day, and every
-- read would re-sweep the PBX for a day that genuinely had no calls — the same
-- reasoning that makes the in-memory day cache record empty days explicitly.
--
-- `synced_at` is also the freshness signal: a day that has ended is immutable
-- and can be served forever, while today is still accruing and is only served
-- from the mirror while the sync is recent.
CREATE TABLE IF NOT EXISTS public.cdr_sync_days (
  business_day date PRIMARY KEY,
  row_count    int NOT NULL DEFAULT 0,
  synced_at    timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS cdr_sync_days_synced_at_idx ON public.cdr_sync_days (synced_at);

ALTER TABLE public.cdr_sync_days ENABLE ROW LEVEL SECURITY;
GRANT ALL ON public.cdr_sync_days TO service_role;

-- ---------------------------------------------------------------------------
-- cdr_sync_state — one row, the incremental watermark and the run lease.
-- ---------------------------------------------------------------------------
-- `last_synced_epoch` is the high-water mark of `cdr_records.ts`. The next run
-- starts a fixed overlap BEFORE it rather than at it: a call that started before
-- the watermark but ended after the previous run is written to CDR late, so a
-- watermark-exact resume would skip it permanently. The overlap is free of
-- consequence because the upsert is idempotent.
--
-- `lease_until` is a single-writer lease. Cloudflare Worker isolates and a cron
-- trigger can fire concurrently; two overlapping sweeps would not corrupt
-- anything (the upsert makes them safe) but they would double the PBX load, and
-- PBX token issuance is rate-limited.
CREATE TABLE IF NOT EXISTS public.cdr_sync_state (
  id                smallint PRIMARY KEY DEFAULT 1 CHECK (id = 1),
  last_synced_epoch bigint,
  last_run_at       timestamptz,
  last_status       text NOT NULL DEFAULT 'idle',
  last_error        text,
  last_rows         int NOT NULL DEFAULT 0,
  last_days         int NOT NULL DEFAULT 0,
  lease_until       timestamptz,
  updated_at        timestamptz NOT NULL DEFAULT now()
);

INSERT INTO public.cdr_sync_state (id) VALUES (1) ON CONFLICT (id) DO NOTHING;

ALTER TABLE public.cdr_sync_state ENABLE ROW LEVEL SECURITY;
GRANT ALL ON public.cdr_sync_state TO service_role;

COMMENT ON TABLE public.cdr_records IS
  'Incremental mirror of Yeastar CDR rows. Yeastar remains the source of truth; '
  'this table exists so the Calls dashboards do not wait on a live PBX sweep. '
  'Service-role only — never exposed through PostgREST.';
COMMENT ON TABLE public.cdr_sync_days IS
  'Business days the CDR mirror covers, including days with zero calls.';
COMMENT ON TABLE public.cdr_sync_state IS
  'Single-row incremental watermark and single-writer lease for the CDR sync.';
