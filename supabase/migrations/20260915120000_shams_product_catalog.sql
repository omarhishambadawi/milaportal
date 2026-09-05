-- The Shams product catalogue, held locally so search never waits on a CRM.
--
-- ===========================================================================
-- The problem this exists to remove
-- ===========================================================================
-- Branch Stock's product search matched against the Shams CRM catalogue, which
-- the Worker downloaded whole from `GET /products/names` -- ~8,484 rows, ~700 KB,
-- no pagination -- and held in an in-memory, per-isolate cache for six hours.
--
-- That cache is cold on every deploy, on every new isolate, and every six hours.
-- When it was cold the first agent to type into the box paid a CRM login plus a
-- 700 KB download before a single result appeared, and if `shams-crm.cloud` was
-- slow or down they got nothing at all. On a live call that is AHT and FCR spent
-- on a reference list that changes by roughly 0.3 % a day
-- (`docs/shams/api-discovery.md` §10.6).
--
-- So the catalogue moves here. Search reads Postgres; nothing on the agent's
-- path contacts Shams CRM at all. A refresh job fills this table from the CRM in
-- the background, and a refresh that fails leaves the previous rows exactly
-- where they are.
--
-- This is precisely what PharmacyCRM Desktop does: it keeps the whole catalogue
-- in a local SQLite table, searches that, refreshes it when a stock-sync marker
-- changes, and ships a cold-start seed so the very first launch can search
-- offline. The seed lands in the migration that follows this one.
--
-- ===========================================================================
-- What is NOT here
-- ===========================================================================
-- Stock. The live MIS `product/stock` read is unchanged and still happens only
-- after an agent selects a product -- a quantity is the one thing on this screen
-- that must never be served from a cache measured in hours.

BEGIN;

-- `LIKE '%needle%'` is the shape of every name search on this table, and a
-- leading `%` is unindexable by btree. Same extension, same schema and the same
-- reasoning as `20260818120000_search_trigram_indexes.sql`.
CREATE EXTENSION IF NOT EXISTS pg_trgm WITH SCHEMA extensions;

-- ===========================================================================
-- 1. The catalogue
-- ===========================================================================
-- Six columns, and no more. `GET /products/names` returns exactly three fields
-- -- code, name, price -- and inventing columns the source cannot fill would
-- invite a consumer to depend on them. Barcode, pack size, generic name,
-- category and VAT rate are all absent upstream; see `src/lib/shams/types.ts`.

CREATE TABLE IF NOT EXISTS public.shams_product_catalog (
  -- The Shams item code, e.g. `10400746`. The natural key: it is the identifier
  -- the MIS stock, info and invoice endpoints all take, and the CRM never
  -- returns two rows for one code. A surrogate id would add a column and buy
  -- nothing, and the uniqueness is the point -- a refresh upserts on it.
  item_code          text PRIMARY KEY CHECK (btrim(item_code) <> ''),

  -- Verbatim from the CRM, apart from trimming. This is what an agent reads.
  item_name          text NOT NULL CHECK (btrim(item_name) <> ''),

  -- `item_name`, lowercased with runs of whitespace collapsed to one space.
  --
  -- Written by the application, not by a trigger or a generated column, because
  -- the authority on this transformation is `normalizeForSearch` in
  -- `src/lib/shams/search.ts` -- the same function the in-process matcher
  -- applies to both sides of every comparison. A second implementation in SQL
  -- would be a second thing to keep in step, and the day the two disagreed the
  -- symptom would be a product that cannot be found rather than an error.
  --
  -- Denormalised on purpose: `lower(item_name)` in the query would work but
  -- could not use a plain trigram index on the column, and the whitespace
  -- collapsing is not expressible as a cheap immutable expression anyone would
  -- want to index twice.
  search_name        text NOT NULL,

  -- SAR. Reference only -- the price an agent acts on comes from the live MIS
  -- read for the selected product, so a few hours of drift here costs nothing.
  retail_price       numeric(12, 3) NOT NULL DEFAULT 0 CHECK (retail_price >= 0),

  -- When this row's *values* last changed at the source.
  --
  -- Deliberately not "when the catalogue was last refreshed": a refresh that
  -- finds a row unchanged does not touch it, so this column answers "how old is
  -- this product's price" rather than "when did we last talk to the CRM". The
  -- second question is `shams_catalog_state.last_success_at`, below.
  source_updated_at  timestamptz,

  updated_at         timestamptz NOT NULL DEFAULT now()
);

-- ---------------------------------------------------------------------------
-- Indexes -- one per branch of the search's OR
-- ---------------------------------------------------------------------------
-- The planner turns a disjunction into a BitmapOr only when *every* branch is
-- indexable; leave one out and the whole thing falls back to a sequential scan.
-- The search issues, at most:
--
--   search_name LIKE '%mounjaro%'          -- name substring, and the ordered
--                                             wildcard form '%mou%n%j%2.5%'
--   item_code   LIKE '104%'                -- exact and partial item code
--   item_code   LIKE '%104%746%'           -- a wildcard written against a code
--
-- so there are three index shapes to provide.

-- Name substring and ordered-fragment wildcards.
CREATE INDEX IF NOT EXISTS shams_product_catalog_search_name_trgm_idx
  ON public.shams_product_catalog USING gin (search_name extensions.gin_trgm_ops);

-- A wildcard written against the item code -- `104*746`. Trigram, because this
-- pattern has no anchored prefix either.
CREATE INDEX IF NOT EXISTS shams_product_catalog_item_code_trgm_idx
  ON public.shams_product_catalog USING gin (item_code extensions.gin_trgm_ops);

-- Partial item code -- `LIKE '104%'`. The primary key answers `=` but not a
-- prefix pattern, because the default btree opclass for text uses the database
-- collation and `LIKE` needs `text_pattern_ops` to be able to use an index.
CREATE INDEX IF NOT EXISTS shams_product_catalog_item_code_prefix_idx
  ON public.shams_product_catalog (item_code text_pattern_ops);

ALTER TABLE public.shams_product_catalog ENABLE ROW LEVEL SECURITY;

-- ---------------------------------------------------------------------------
-- No policies. That is the access control, not an omission.
-- ---------------------------------------------------------------------------
-- RLS is on and nothing grants SELECT through it, so no browser session can
-- read this table however it authenticates. Every read goes through
-- `shamsSearchProducts`, which is behind `requireSupabaseAuth` and an explicit
-- `view_shams_mis` check, runs on the server as the service role, and returns at
-- most `MAX_SEARCH_RESULTS` matched rows.
--
-- A policy granting `view_shams_mis` holders a read would look reasonable and
-- would quietly undo the thing this design is for: `select * from
-- shams_product_catalog` from the browser is the 700 KB download all over again,
-- served from a different host. The full catalogue never crosses to a client.
COMMENT ON TABLE public.shams_product_catalog IS
  'The Shams CRM product catalogue (~8,484 rows), held locally so Branch Stock search '
  'never contacts shams-crm.cloud. Filled by the catalogue refresh job; a failed refresh '
  'leaves the previous rows untouched. RLS is enabled with no policies on purpose: reads '
  'happen only through the server-side search, as the service role.';

COMMENT ON COLUMN public.shams_product_catalog.search_name IS
  'item_name lowercased with whitespace runs collapsed. Written by the application so it '
  'matches normalizeForSearch() in src/lib/shams/search.ts exactly; never derived in SQL.';

COMMENT ON COLUMN public.shams_product_catalog.source_updated_at IS
  'When this row''s values last changed at the CRM. Not the last refresh time -- an '
  'unchanged row is left alone. For refresh freshness read shams_catalog_state.';

-- ===========================================================================
-- 2. The staging table
-- ===========================================================================
-- A refresh arrives as ~8,484 rows. They are inserted here in chunks and then
-- promoted into the live table in one statement, which is what makes the whole
-- replacement atomic without pushing a 700 KB body through a single RPC call.
--
-- The live catalogue is untouched until `shams_promote_product_catalog` runs, so
-- every way a refresh can fail -- the CRM being down, a partial download, the
-- Worker being killed mid-chunk -- leaves the last known good catalogue serving
-- searches. That is the whole reason for the indirection.

CREATE TABLE IF NOT EXISTS public.shams_product_catalog_staging (
  -- One refresh attempt. Rows from an abandoned attempt are recognisable by
  -- their batch and are cleared by the next one.
  batch_id           uuid NOT NULL,
  item_code          text NOT NULL,
  item_name          text NOT NULL,
  search_name        text NOT NULL,
  retail_price       numeric(12, 3) NOT NULL DEFAULT 0,
  staged_at          timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (batch_id, item_code)
);

CREATE INDEX IF NOT EXISTS shams_product_catalog_staging_staged_idx
  ON public.shams_product_catalog_staging (staged_at);

ALTER TABLE public.shams_product_catalog_staging ENABLE ROW LEVEL SECURITY;

COMMENT ON TABLE public.shams_product_catalog_staging IS
  'Scratch space for one catalogue refresh. Filled in chunks, promoted atomically by '
  'shams_promote_product_catalog(), then emptied. RLS on with no policies, as for the '
  'catalogue itself.';

-- ===========================================================================
-- 3. Refresh state
-- ===========================================================================
-- One row, id = 1, the same shape and for the same reason as
-- `shams_sync_scheduler_state`: what matters operationally is the *current*
-- answer to "is the catalogue fresh, and did the last refresh work", and a row
-- overwritten each attempt answers it without growing forever.

CREATE TABLE IF NOT EXISTS public.shams_catalog_state (
  id                   integer PRIMARY KEY DEFAULT 1 CHECK (id = 1),

  -- Rows in the live catalogue as of the last promotion. Denormalised so a
  -- health check is one indexed read of one row rather than a count over 8,484.
  row_count            integer NOT NULL DEFAULT 0 CHECK (row_count >= 0),

  -- The stock-sync success marker the current rows were fetched against.
  --
  -- PharmacyCRM Desktop's rule, transcribed: re-fetch when the marker changes,
  -- not on a clock (`docs/shams/api-discovery.md` §10.6). It is a timestamp
  -- string the CRM already publishes, and carries nothing sensitive.
  source_marker        text,

  -- Every attempt, whether or not it changed anything. Staleness here means the
  -- refresh job itself has stopped, which no other field reveals.
  last_attempt_at      timestamptz,
  -- Only a promotion that actually landed.
  last_success_at      timestamptz,

  -- success | unchanged | not_configured | failed
  last_outcome         text CHECK (last_outcome IN
                         ('success', 'unchanged', 'not_configured', 'failed')),

  -- Operator copy, one sentence. Never an upstream body, header or credential --
  -- the application reduces a failure to a short line before it reaches here.
  last_error           text,

  -- When the job should next look. Null means "now", which is what makes a
  -- freshly deployed database refresh on the first tick.
  next_refresh_due_at  timestamptz,

  updated_at           timestamptz NOT NULL DEFAULT now()
);

INSERT INTO public.shams_catalog_state (id) VALUES (1) ON CONFLICT (id) DO NOTHING;

ALTER TABLE public.shams_catalog_state ENABLE ROW LEVEL SECURITY;

-- Administrators read this one -- unlike the catalogue, it is six scalars of
-- telemetry rather than the data itself, and it is what the diagnostics page
-- shows. Nobody writes through RLS; the refresh job writes as the service role.
DROP POLICY IF EXISTS "Administrators can read Shams catalogue state"
  ON public.shams_catalog_state;
CREATE POLICY "Administrators can read Shams catalogue state"
  ON public.shams_catalog_state
  FOR SELECT TO authenticated
  USING (public.is_administrator(auth.uid()));

COMMENT ON TABLE public.shams_catalog_state IS
  'One row (id=1) recording the local Shams product catalogue''s size, freshness and last '
  'refresh outcome. next_refresh_due_at NULL means due now.';

-- ===========================================================================
-- 4. Search
-- ===========================================================================
-- Candidate retrieval only. Matching and ranking stay in TypeScript.
--
-- This function does not score, does not order by relevance and does not cap at
-- the result count the UI shows. It answers one question -- which rows could
-- possibly match these patterns -- and hands them to `rankProducts` in
-- `src/lib/shams/search.ts`, which is the existing, tested authority on ordering
-- and on `MAX_SEARCH_RESULTS`. Reimplementing that scoring here would be a
-- second copy of a business rule, in a language where it cannot be unit tested.
--
-- The patterns are built by the caller (`escapeLikePattern` +
-- `parseWildcardQuery`), which is why they arrive as `LIKE` patterns rather than
-- as a raw query string: `%` and `_` in whatever an agent typed are escaped
-- there, before they can mean anything to Postgres.
--
-- `LIKE '%a%b%'` is exactly `matchesWildcard`'s rule -- each fragment found
-- after the previous one ended, no overlap -- so the SQL and the TypeScript
-- agree by construction rather than by approximation.

CREATE OR REPLACE FUNCTION public.shams_search_product_catalog(
  p_name_pattern text DEFAULT NULL,
  p_code_pattern text DEFAULT NULL,
  p_max_rows     integer DEFAULT 2000
)
RETURNS TABLE (item_code text, item_name text, retail_price numeric)
LANGUAGE sql
STABLE
SET search_path = public, extensions
AS $$
  SELECT c.item_code, c.item_name, c.retail_price
    FROM public.shams_product_catalog c
   WHERE (p_name_pattern IS NOT NULL AND c.search_name LIKE p_name_pattern)
      OR (p_code_pattern IS NOT NULL AND c.item_code   LIKE p_code_pattern)
   -- Deterministic, so two runs of the same search hand the ranker the same
   -- list in the same order and its stable sort produces the same answer.
   ORDER BY c.item_code
   LIMIT greatest(1, least(coalesce(p_max_rows, 2000), 10000));
$$;

-- Callable by the service role only, which is the same boundary the table has.
-- SECURITY INVOKER (the default) is deliberate: the function must not become a
-- way around the table's RLS for a session that could not read it directly.
REVOKE ALL ON FUNCTION public.shams_search_product_catalog(text, text, integer)
  FROM PUBLIC, anon, authenticated;

COMMENT ON FUNCTION public.shams_search_product_catalog(text, text, integer) IS
  'Candidate rows for one product search. Matching, ranking and MAX_SEARCH_RESULTS stay '
  'in src/lib/shams/search.ts; this only narrows 8,484 rows to the ones that could match. '
  'Service role only.';

-- ===========================================================================
-- 5. Promotion
-- ===========================================================================
-- The atomic swap, and the guard that makes a bad refresh a no-op.

CREATE OR REPLACE FUNCTION public.shams_promote_product_catalog(
  p_batch_id          uuid,
  p_min_rows          integer DEFAULT 1000,
  p_source_updated_at timestamptz DEFAULT now(),
  p_source_marker     text DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SET search_path = public
AS $$
DECLARE
  staged_rows   integer;
  changed_rows  integer;
  removed_rows  integer;
  total_rows    integer;
  floor_rows    integer := greatest(coalesce(p_min_rows, 1000), 1);
BEGIN
  SELECT count(*) INTO staged_rows
    FROM public.shams_product_catalog_staging WHERE batch_id = p_batch_id;

  /*
   * The floor is the whole safety story.
   *
   * A truncated download, a CRM that answered with an empty array, or a Worker
   * killed halfway through staging all present as "fewer rows than a catalogue
   * has". Replacing 8,484 good products with 40 -- or with none -- would break
   * search far more thoroughly than a stale price ever could, so it raises and
   * the caller records a failure against a catalogue that is still intact.
   *
   * Raising rather than returning a verdict is intentional: this runs inside the
   * caller's transaction, and an exception is what guarantees the swap below
   * cannot have half happened.
   */
  IF staged_rows < floor_rows THEN
    RAISE EXCEPTION
      'shams_promote_product_catalog: refused -- % staged rows is below the floor of %',
      staged_rows, floor_rows
      USING ERRCODE = 'data_exception';
  END IF;

  WITH incoming AS (
    SELECT s.item_code, s.item_name, s.search_name, s.retail_price
      FROM public.shams_product_catalog_staging s
     WHERE s.batch_id = p_batch_id
  ),
  upserted AS (
    INSERT INTO public.shams_product_catalog AS c
      (item_code, item_name, search_name, retail_price, source_updated_at, updated_at)
    SELECT i.item_code, i.item_name, i.search_name, i.retail_price, p_source_updated_at, now()
      FROM incoming i
    ON CONFLICT (item_code) DO UPDATE
      SET item_name         = EXCLUDED.item_name,
          search_name       = EXCLUDED.search_name,
          retail_price      = EXCLUDED.retail_price,
          source_updated_at = EXCLUDED.source_updated_at,
          updated_at        = now()
      /*
       * Untouched when nothing changed. Without this every refresh would rewrite
       * all 8,484 rows and both GIN indexes nightly, and `source_updated_at`
       * would degrade into a copy of the refresh time -- losing the one thing it
       * is for, which is knowing how old a particular price is.
       */
      WHERE c.item_name    IS DISTINCT FROM EXCLUDED.item_name
         OR c.search_name  IS DISTINCT FROM EXCLUDED.search_name
         OR c.retail_price IS DISTINCT FROM EXCLUDED.retail_price
    RETURNING 1
  ),
  removed AS (
    /*
     * Products the CRM no longer lists. Safe alongside the insert above: both
     * CTEs read the same snapshot, so rows this refresh is adding are invisible
     * here and cannot be deleted by it.
     */
    DELETE FROM public.shams_product_catalog c
     WHERE NOT EXISTS (SELECT 1 FROM incoming i WHERE i.item_code = c.item_code)
    RETURNING 1
  )
  SELECT (SELECT count(*) FROM upserted), (SELECT count(*) FROM removed)
    INTO changed_rows, removed_rows;

  SELECT count(*) INTO total_rows FROM public.shams_product_catalog;

  DELETE FROM public.shams_product_catalog_staging WHERE batch_id = p_batch_id;

  UPDATE public.shams_catalog_state
     SET row_count       = total_rows,
         source_marker   = coalesce(p_source_marker, source_marker),
         last_success_at = now(),
         last_outcome    = 'success',
         last_error      = NULL,
         updated_at      = now()
   WHERE id = 1;

  RETURN jsonb_build_object(
    'staged',  staged_rows,
    'changed', changed_rows,
    'removed', removed_rows,
    'total',   total_rows
  );
END;
$$;

REVOKE ALL ON FUNCTION public.shams_promote_product_catalog(uuid, integer, timestamptz, text)
  FROM PUBLIC, anon, authenticated;

COMMENT ON FUNCTION public.shams_promote_product_catalog(uuid, integer, timestamptz, text) IS
  'Atomically swaps a staged batch into shams_product_catalog and records the result in '
  'shams_catalog_state. Raises, changing nothing, when the batch holds fewer than p_min_rows '
  'rows -- so a truncated or empty download can never replace a good catalogue. Service role only.';

-- ===========================================================================
-- 6. The tick learns about the catalogue
-- ===========================================================================
-- `shams_sync_tick()` runs every minute and pokes the application only when
-- there is something to do. It gains a third reason: the catalogue is due a
-- look.
--
-- Deliberately *not* gated on `shams_sync_settings.automation_enabled`. That
-- switch governs starting synchronisation runs on Shams' own infrastructure --
-- work that costs the CRM ~840 page fetches and that an operator may well want
-- to hold. Refreshing the catalogue starts nothing at Shams: it reads a small
-- status document and, only when that says something changed, one list. Tying
-- product search's freshness to a switch about remote job scheduling would mean
-- an operator pausing the nightly sync silently froze the agents' catalogue.
--
-- Everything else about this function is unchanged from
-- `20260829120000_shams_sync_control_center.sql`; it is restated whole because
-- CREATE OR REPLACE takes the entire body.

CREATE OR REPLACE FUNCTION public.shams_sync_tick()
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, net, vault
AS $$
DECLARE
  open_count    integer;
  due_count     integer;
  catalog_due   integer;
  endpoint      text;
  secret        text;
  prior_id      bigint;
  prior_code    integer;
  prior_err     text;
  note          text;
  request_id    bigint;
BEGIN
  SELECT count(*) INTO open_count
    FROM public.shams_sync_runs
   WHERE status IN ('triggered', 'running');

  SELECT count(*) INTO due_count
    FROM public.shams_sync_schedule_slots s
   WHERE s.enabled
     AND (s.sync_stock OR s.sync_promotions)
     AND (s.next_due_at IS NULL OR s.next_due_at <= now())
     AND EXISTS (SELECT 1 FROM public.shams_sync_settings g
                  WHERE g.id = 1 AND g.automation_enabled);

  SELECT count(*) INTO catalog_due
    FROM public.shams_catalog_state c
   WHERE c.id = 1
     AND (c.next_refresh_due_at IS NULL OR c.next_refresh_due_at <= now());

  /*
   * Read the previous tick's reply before deciding anything.
   *
   * pg_net answers asynchronously, so a 401 -- the exact shape of a credential
   * drifting apart between the vault and the deployment -- can only ever be
   * observed here, one tick later. Without this the job would fire into a
   * rejecting endpoint indefinitely and report success every time.
   */
  SELECT last_request_id INTO prior_id
    FROM public.shams_sync_scheduler_state WHERE id = 1;

  IF prior_id IS NOT NULL THEN
    SELECT status_code, error_msg INTO prior_code, prior_err
      FROM net._http_response WHERE id = prior_id;

    IF prior_err IS NOT NULL THEN
      note := 'The Shams sync scheduler could not be reached on its last attempt.';
    ELSIF prior_code IS NOT NULL AND (prior_code < 200 OR prior_code > 299) THEN
      note := 'The Shams sync scheduler was refused by the application (HTTP '
              || prior_code || ') on its last attempt.';
    END IF;

    IF note IS NOT NULL THEN
      RAISE WARNING 'shams_sync_tick: previous poll failed (status %, %)',
        prior_code, coalesce(prior_err, 'no transport error');
    END IF;
  END IF;

  UPDATE public.shams_sync_scheduler_state
     SET last_poll_at = now(), updated_at = now()
   WHERE id = 1;

  IF open_count = 0 AND due_count = 0 AND catalog_due = 0 THEN
    -- Still the overwhelmingly common case: the catalogue is checked hourly, so
    -- this branch is taken on all but a couple of minutes an hour.
    UPDATE public.shams_sync_scheduler_state
       SET last_outcome = 'idle', last_task = 'tick', last_error = note, updated_at = now()
     WHERE id = 1;
    RETURN 0;
  END IF;

  SELECT decrypted_secret INTO endpoint
    FROM vault.decrypted_secrets WHERE name = 'shams_sync_scheduler_url';

  /*
   * The platform's own service role key -- the same vault entry
   * `email_queue_dispatch()` and `alshrouq_dispatch_due()` read. Not a new
   * credential, and deliberately not a hand-maintained one.
   */
  SELECT decrypted_secret INTO secret
    FROM vault.decrypted_secrets WHERE name = 'email_queue_service_role_key';

  IF endpoint IS NULL OR secret IS NULL THEN
    RAISE WARNING
      'shams_sync_tick: work is due but the scheduler is not configured '
      '(vault entry shams_sync_scheduler_url is absent)';

    note := 'The Shams sync scheduler is not connected on this deployment, so no '
            'synchronisation has been started. An administrator needs to complete the setup.';

    UPDATE public.shams_sync_scheduler_state
       SET last_outcome = 'unconfigured', last_task = 'tick', last_error = note, updated_at = now()
     WHERE id = 1;

    /*
     * The catalogue is unaffected by this. It is already populated -- from the
     * shipped seed if nothing else -- and search reads it directly, so an
     * unconfigured scheduler means the rows stop being refreshed, not that
     * anyone stops being able to search.
     */
    RETURN -1;
  END IF;

  SELECT net.http_post(
    url     := endpoint,
    headers := jsonb_build_object(
                 'content-type', 'application/json',
                 'Authorization', 'Bearer ' || secret
               ),
    body    := jsonb_build_object(
                 'task', 'tick', 'open', open_count, 'due', due_count, 'catalog', catalog_due
               ),
    timeout_milliseconds := 60000
  ) INTO request_id;

  UPDATE public.shams_sync_scheduler_state
     SET last_outcome    = 'poked',
         last_task       = 'tick',
         last_poke_at    = now(),
         last_request_id = request_id,
         last_error      = note,
         updated_at      = now()
   WHERE id = 1;

  RETURN open_count + due_count + catalog_due;
END;
$$;

REVOKE ALL ON FUNCTION public.shams_sync_tick() FROM PUBLIC, anon, authenticated;

COMMENT ON FUNCTION public.shams_sync_tick() IS
  'pg_cron entry point for Shams CRM. Pokes the application when a schedule slot is due, '
  'a run is open, or the local product catalogue is due a refresh; otherwise does nothing. '
  'Contacts Shams itself never.';

COMMIT;
