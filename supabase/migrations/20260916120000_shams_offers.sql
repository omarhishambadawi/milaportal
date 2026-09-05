-- ===========================================================================
-- Shams CRM offers, held locally
-- ===========================================================================
--
-- Branch Stock reads offers from MilaPortal's own tables instead of asking
-- shams-crm.cloud when an agent opens a product. Same destination as
-- `20260915120000_shams_product_catalog.sql` reached for product search, same
-- machinery -- staging, an atomic promotion, one state row, a floor that
-- refuses to replace good data with bad -- and one structural difference that
-- the upstream API forces.
--
-- ## Why this cannot be a straight copy of the catalogue
--
-- The catalogue is one request. `GET /products/names` answers with all ~8,484
-- products, so a refresh downloads the world, stages it and swaps it in; the
-- promotion can delete anything the response did not mention because the
-- response is complete by construction.
--
-- Offers have no such endpoint. `docs/shams/api-discovery.md` §11.1 records
-- that there is no `/offers`, no promotions list and no feed; §11.2 that an
-- offer is a per-branch field on `GET /products/{item_code}/available-branches`,
-- ~62 KB for one item; and §11.5/§11.6 that there is no bulk form, no
-- pagination and no way to ask about many items at once. §11.6 states plainly
-- that a cached offers index is "not possible against the API as it stands".
--
-- It is possible, but only as a **sweep**: the catalogue is walked in bounded
-- slices, one request per item, across many scheduler ticks, and each slice
-- promotes what it covered. That makes every promotion **partial** -- and a
-- partial promotion that deleted rows it did not cover would erase the other
-- 8,300 products' offers on every run.
--
-- So the one real change from the catalogue's promotion is that this one is
-- **scoped to the item codes in the batch**. Nothing outside them is read,
-- written or deleted. A slice that fails leaves every other item exactly as it
-- was, and so does a sweep that is abandoned half way.
--
-- ## The two live tables
--
--   shams_offers           one row per (item, branch) that actually has an offer
--   shams_offer_products   one row per item the sweep has CHECKED, offer or not
--
-- The second is not redundant. It is the only thing that can tell "we asked and
-- there is no promotion" apart from "we have not asked yet" -- and rendering the
-- second as the first would state something nobody established, about money, on
-- a live call. An item with no row is `unknown`; an item with a row and
-- `scope = 'none'` is a fact.
--
-- ## What is deliberately not stored
--
-- `available_qty`. The CRM's availability figure is read during the sweep to
-- classify coverage (§11.6 -- the response lists every branch in the chain, so
-- row count would answer the wrong question) and is dropped there. Only the two
-- derived **counts** are persisted. Shams Portal/MIS `product/stock` remains the
-- one source of every quantity an agent reads, and no column here could be
-- mistaken for one.

BEGIN;

SET LOCAL search_path = public;

-- ===========================================================================
-- 1. Per-branch offers
-- ===========================================================================
-- Only rows that carry a promotion. `normalizeOffers` already drops a branch
-- whose `offer_percent` is absent, zero or negative, and the same rule holds
-- here: a zero-percent row is not an offer and must never reach a screen that
-- could render it as "0% off".

CREATE TABLE IF NOT EXISTS public.shams_offers (
  -- The Shams item code. The same identifier the catalogue, the MIS stock read
  -- and the invoice lines all use -- no new identifier and no mapping table
  -- (`api-discovery.md` §11.4).
  item_code          text NOT NULL CHECK (btrim(item_code) <> ''),

  -- `P` + 4 digits, directly comparable to `branches.branch_no` and to the
  -- `branchCode` on an MIS stock row. The join Branch Stock makes.
  branch_code        text NOT NULL CHECK (btrim(branch_code) <> ''),

  -- List price at this branch, before the offer. Kept beside the discounted one
  -- because they came off the same response row: a pair read from one row
  -- cannot disagree about what is being discounted, and a pair assembled from
  -- two sources eventually will.
  price              numeric(12, 3) NOT NULL CHECK (price >= 0),

  -- The discount. Stored as the API reports it and never applied to anything:
  -- `after_offer_price` below is the figure an agent quotes.
  offer_percent      numeric(6, 3) NOT NULL CHECK (offer_percent > 0),

  -- Preformatted by the API, e.g. `25.00%`. Rendered verbatim.
  offer_display      text NOT NULL CHECK (btrim(offer_display) <> ''),

  -- The price to charge, verbatim from the CRM. Never recomputed from
  -- `price` and `offer_percent` -- rounding is Shams's to decide.
  after_offer_price  numeric(12, 3) NOT NULL CHECK (after_offer_price >= 0),

  -- When this row's *values* last changed at the source. Not "when the sweep
  -- last ran": an unchanged row is left alone, so this answers "how old is this
  -- branch's promotional price". For sweep freshness read
  -- shams_offer_sync_state.
  source_updated_at  timestamptz,

  updated_at         timestamptz NOT NULL DEFAULT now(),

  PRIMARY KEY (item_code, branch_code)
);

-- The Branch Stock lookup: every branch's offer for one opened product. The
-- primary key's leading column already serves it, and this is that index.
CREATE INDEX IF NOT EXISTS shams_offers_item_code_idx
  ON public.shams_offers (item_code);

ALTER TABLE public.shams_offers ENABLE ROW LEVEL SECURITY;

COMMENT ON TABLE public.shams_offers IS
  'Per-branch Shams CRM promotional pricing, held locally so Branch Stock never contacts '
  'shams-crm.cloud when an agent opens a product. Only branches that actually carry an offer '
  'have a row. RLS enabled with no policies on purpose: reads happen server-side as the '
  'service role, behind requireSupabaseAuth + view_shams_mis.';

COMMENT ON COLUMN public.shams_offers.after_offer_price IS
  'The price to charge, verbatim from the CRM. Never derived from price and offer_percent.';

-- ===========================================================================
-- 2. Per-item summary -- the row that makes "no offer" sayable
-- ===========================================================================

CREATE TABLE IF NOT EXISTS public.shams_offer_products (
  item_code           text PRIMARY KEY CHECK (btrim(item_code) <> ''),

  -- `classifyOfferScope`'s verdict, computed in TypeScript at sync time so the
  -- badge, the stored summary and the Branch Stock header all trace back to one
  -- comparison. `unknown` is absent on purpose: it means "nobody asked", and a
  -- row exists precisely because somebody did.
  scope               text NOT NULL CHECK (scope IN ('all', 'some', 'none')),

  -- Branches holding the item, and how many of those carry the offer. Counts,
  -- not quantities: derived from the CRM's availability rows and already sent to
  -- the browser today inside ShamsOfferScope. Nothing renders either as stock.
  branches_available  integer NOT NULL DEFAULT 0 CHECK (branches_available >= 0),
  branches_with_offer integer NOT NULL DEFAULT 0 CHECK (branches_with_offer >= 0),

  -- One figure only when every offering branch agrees on it. NULL when they
  -- disagree -- §11.4 records that whether offers vary by branch is NOT
  -- VERIFIED, so disagreement is handled rather than assumed impossible.
  offer_display       text,

  -- A product-level price pair, and the whole reason this table has price
  -- columns at all: a search result can show "60.62 -> 48.50" without opening
  -- anything.
  --
  -- Both NULL unless the data proves a single figure is safe -- the offer
  -- reaches every stocking branch AND every offering branch quotes the same
  -- list price AND the same offer price. See `summariseProductOffer`. They are
  -- written and cleared together; one without the other invites the reader to
  -- infer the missing half.
  unit_price          numeric(12, 3) CHECK (unit_price IS NULL OR unit_price >= 0),
  offer_price         numeric(12, 3) CHECK (offer_price IS NULL OR offer_price >= 0),
  CONSTRAINT shams_offer_products_price_pair
    CHECK ((unit_price IS NULL) = (offer_price IS NULL)),

  -- When the sweep last looked at this item, whatever it found. This is what
  -- makes a `none` trustworthy: it is a fact with a date on it.
  checked_at          timestamptz NOT NULL DEFAULT now(),

  source_updated_at   timestamptz,
  updated_at          timestamptz NOT NULL DEFAULT now()
);

-- The sweep walks the catalogue in item-code order and needs to know where it
-- got to; the lookup for a search result set is `item_code = ANY(...)`, which
-- the primary key serves.
CREATE INDEX IF NOT EXISTS shams_offer_products_checked_idx
  ON public.shams_offer_products (checked_at);

ALTER TABLE public.shams_offer_products ENABLE ROW LEVEL SECURITY;

COMMENT ON TABLE public.shams_offer_products IS
  'One row per item the offer sweep has checked, whether or not it found a promotion. The '
  'only thing that distinguishes "asked, no offer" (scope = none) from "not asked yet" (no '
  'row) -- a distinction the UI must never collapse.';

COMMENT ON COLUMN public.shams_offer_products.offer_price IS
  'A product-level offer price, set only when the offer reaches every stocking branch and all '
  'of them quote the same figure. NULL means a search row must show the catalogue price.';

-- ===========================================================================
-- 3. Staging
-- ===========================================================================
-- Two staging tables because a slice promotes two things: the branch rows it
-- found, and the per-item verdicts it reached. The verdict table is the
-- authority on *what the slice covered* -- an item with no offer produces no
-- branch rows at all, and without a verdict row the promotion could not tell
-- "checked, nothing found" from "not in this slice".

CREATE TABLE IF NOT EXISTS public.shams_offers_staging (
  batch_id           uuid NOT NULL,
  item_code          text NOT NULL,
  branch_code        text NOT NULL,
  price              numeric(12, 3) NOT NULL DEFAULT 0,
  offer_percent      numeric(6, 3) NOT NULL DEFAULT 0,
  offer_display      text NOT NULL,
  after_offer_price  numeric(12, 3) NOT NULL DEFAULT 0,
  staged_at          timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (batch_id, item_code, branch_code)
);

CREATE INDEX IF NOT EXISTS shams_offers_staging_staged_idx
  ON public.shams_offers_staging (staged_at);

ALTER TABLE public.shams_offers_staging ENABLE ROW LEVEL SECURITY;

CREATE TABLE IF NOT EXISTS public.shams_offer_products_staging (
  batch_id            uuid NOT NULL,
  item_code           text NOT NULL,
  scope               text NOT NULL,
  branches_available  integer NOT NULL DEFAULT 0,
  branches_with_offer integer NOT NULL DEFAULT 0,
  offer_display       text,
  unit_price          numeric(12, 3),
  offer_price         numeric(12, 3),
  staged_at           timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (batch_id, item_code)
);

CREATE INDEX IF NOT EXISTS shams_offer_products_staging_staged_idx
  ON public.shams_offer_products_staging (staged_at);

ALTER TABLE public.shams_offer_products_staging ENABLE ROW LEVEL SECURITY;

COMMENT ON TABLE public.shams_offers_staging IS
  'Scratch space for one offer sweep slice. Promoted atomically by shams_promote_offers(), '
  'then emptied. RLS on with no policies, as for the live tables.';

COMMENT ON TABLE public.shams_offer_products_staging IS
  'The per-item verdicts of one sweep slice. Also the authority on which items the slice '
  'covered, which is what scopes the promotion''s deletes.';

-- ===========================================================================
-- 4. Sync state
-- ===========================================================================
-- One row, mirroring `shams_catalog_state`, plus the two things a sweep has
-- that a single download does not: a cursor, and per-run metrics an
-- administrator can read without a log.

CREATE TABLE IF NOT EXISTS public.shams_offer_sync_state (
  id                     integer PRIMARY KEY DEFAULT 1 CHECK (id = 1),

  -- Live rows, denormalised so the admin panel is one indexed read of one row.
  offer_row_count        integer NOT NULL DEFAULT 0 CHECK (offer_row_count >= 0),
  product_row_count      integer NOT NULL DEFAULT 0 CHECK (product_row_count >= 0),
  -- Of the items checked, how many carry a promotion. The figure an operator
  -- actually wants: "8,484 checked, 74 on offer".
  items_with_offers      integer NOT NULL DEFAULT 0 CHECK (items_with_offers >= 0),

  -- The promotions-sync success marker the current rows were fetched against.
  -- The same rule the catalogue follows against `/stock/sync/status`
  -- (`api-discovery.md` §10.6): re-sweep when the marker moves, not on a clock.
  source_marker          text,

  -- Where the sweep has got to, in item-code order. NULL means "start at the
  -- beginning". This is what makes an 8,484-request sweep survive a worker being
  -- killed: the next slice resumes rather than restarting.
  cursor_item_code       text,
  sweep_started_at       timestamptz,
  sweep_completed_at     timestamptz,
  -- Items covered so far in the sweep currently in progress. Reset when a new
  -- sweep starts, so it reads as progress rather than as a running total.
  sweep_items_done       integer NOT NULL DEFAULT 0 CHECK (sweep_items_done >= 0),

  -- Every attempt, whether or not it changed anything. Staleness here means the
  -- sweep itself has stopped, which no other field reveals.
  last_attempt_at        timestamptz,
  -- Only a promotion that actually landed.
  last_success_at        timestamptz,
  -- Only a sweep that reached the end of the catalogue. The freshness figure
  -- that matters: a sweep half done has looked at half the products.
  last_full_sweep_at     timestamptz,

  last_outcome           text CHECK (last_outcome IN
                           ('success', 'unchanged', 'not_configured', 'failed')),
  last_error             text,

  -- Metrics for the last slice that promoted anything. `rows_changed` is
  -- inserted + updated + deleted -- rows whose values actually moved -- and is
  -- deliberately NOT `items_processed`, which counts what was looked at.
  last_items_processed   integer NOT NULL DEFAULT 0 CHECK (last_items_processed >= 0),
  last_rows_inserted     integer NOT NULL DEFAULT 0 CHECK (last_rows_inserted >= 0),
  last_rows_updated      integer NOT NULL DEFAULT 0 CHECK (last_rows_updated >= 0),
  last_rows_deleted      integer NOT NULL DEFAULT 0 CHECK (last_rows_deleted >= 0),
  last_rows_changed      integer NOT NULL DEFAULT 0 CHECK (last_rows_changed >= 0),
  last_started_at        timestamptz,
  last_finished_at       timestamptz,

  next_refresh_due_at    timestamptz,
  updated_at             timestamptz NOT NULL DEFAULT now()
);

INSERT INTO public.shams_offer_sync_state (id) VALUES (1) ON CONFLICT (id) DO NOTHING;

ALTER TABLE public.shams_offer_sync_state ENABLE ROW LEVEL SECURITY;

-- Administrators may read it directly; everyone else reaches it through the
-- server function, which is gated on view_shams_mis. Exactly the catalogue
-- state row's policy.
DROP POLICY IF EXISTS "Administrators can read Shams offer sync state"
  ON public.shams_offer_sync_state;
CREATE POLICY "Administrators can read Shams offer sync state"
  ON public.shams_offer_sync_state
  FOR SELECT TO authenticated
  USING (public.is_administrator(auth.uid()));

COMMENT ON TABLE public.shams_offer_sync_state IS
  'One row (id=1) recording the local Shams offer dataset''s size, freshness, sweep cursor '
  'and last slice''s metrics. next_refresh_due_at NULL means due now.';

COMMENT ON COLUMN public.shams_offer_sync_state.cursor_item_code IS
  'Where the sweep has reached, in item_code order. NULL restarts from the beginning. Offers '
  'have no bulk endpoint, so a full pass is thousands of requests and must be resumable.';

COMMENT ON COLUMN public.shams_offer_sync_state.last_rows_changed IS
  'Rows whose values actually moved: inserted + updated + deleted. Never items processed.';

-- ===========================================================================
-- 5. The sweep cursor -- which items to ask about next
-- ===========================================================================
-- The catalogue drives the sweep, and it stays server-side: this hands back a
-- bounded page of item codes after a cursor, never the catalogue itself.

CREATE OR REPLACE FUNCTION public.shams_offer_sweep_slice(
  p_after text DEFAULT NULL,
  p_limit integer DEFAULT 150
)
RETURNS TABLE (item_code text)
LANGUAGE sql
STABLE
SET search_path = public
AS $$
  SELECT c.item_code
    FROM public.shams_product_catalog c
   WHERE p_after IS NULL OR c.item_code > p_after
   -- Item-code order, so a cursor is a total order and a resumed sweep cannot
   -- skip or repeat an item.
   ORDER BY c.item_code
   LIMIT greatest(1, least(coalesce(p_limit, 150), 1000));
$$;

REVOKE ALL ON FUNCTION public.shams_offer_sweep_slice(text, integer)
  FROM PUBLIC, anon, authenticated;

COMMENT ON FUNCTION public.shams_offer_sweep_slice(text, integer) IS
  'The next page of catalogue item codes for the offer sweep to ask the CRM about. Service '
  'role only.';

-- ===========================================================================
-- 6. Promotion -- atomic, and scoped to the slice
-- ===========================================================================

CREATE OR REPLACE FUNCTION public.shams_promote_offers(
  p_batch_id          uuid,
  p_source_updated_at timestamptz DEFAULT now(),
  p_source_marker     text DEFAULT NULL,
  p_cursor            text DEFAULT NULL,
  p_sweep_complete    boolean DEFAULT false,
  p_started_at        timestamptz DEFAULT now()
)
RETURNS jsonb
LANGUAGE plpgsql
SET search_path = public
AS $$
DECLARE
  items_processed  integer;
  rows_inserted    integer;
  rows_updated     integer;
  rows_deleted     integer;
  summaries_changed integer;
  offer_rows       integer;
  product_rows     integer;
  with_offers      integer;
BEGIN
  SELECT count(*) INTO items_processed
    FROM public.shams_offer_products_staging WHERE batch_id = p_batch_id;

  /*
   * An empty slice is refused, and this is the offers equivalent of the
   * catalogue's row floor.
   *
   * The catalogue can insist on a thousand rows because its download is
   * complete by construction. A slice cannot: it legitimately covers 150 items
   * of which perhaps none has an offer. What it can never legitimately be is
   * *zero items covered* -- that is a sweep that fetched nothing, and promoting
   * it would advance the cursor past items it never looked at, silently leaving
   * a hole in the dataset that no later run would revisit.
   *
   * Raising rather than returning a verdict is intentional: this runs inside the
   * caller's transaction, so an exception guarantees the writes below cannot
   * have half happened.
   */
  IF items_processed = 0 THEN
    RAISE EXCEPTION
      'shams_promote_offers: refused -- the batch covered no items'
      USING ERRCODE = 'data_exception';
  END IF;

  /*
   * Per-branch offers: how many rows this slice adds, and how many it moves.
   *
   * `pre` reads the current rows *before* anything is written, which is what
   * makes inserted and updated separable at all -- an upsert cannot tell you
   * afterwards which of the two it did.
   *
   * The join is against this batch's staged rows only, so a row belonging to an
   * item the slice did not ask about is never even read. The scoping that
   * matters is on the DELETE below, where it is spelled out.
   */
  WITH incoming AS (
    SELECT s.item_code, s.branch_code, s.price, s.offer_percent,
           s.offer_display, s.after_offer_price
      FROM public.shams_offers_staging s
     WHERE s.batch_id = p_batch_id
  ),
  pre AS (
    SELECT (o.item_code IS NULL) AS is_new,
           (o.item_code IS NOT NULL AND (
              o.price             IS DISTINCT FROM i.price
           OR o.offer_percent     IS DISTINCT FROM i.offer_percent
           OR o.offer_display     IS DISTINCT FROM i.offer_display
           OR o.after_offer_price IS DISTINCT FROM i.after_offer_price
           )) AS is_changed
      FROM incoming i
      LEFT JOIN public.shams_offers o
             ON o.item_code = i.item_code AND o.branch_code = i.branch_code
  )
  SELECT count(*) FILTER (WHERE is_new), count(*) FILTER (WHERE is_changed)
    INTO rows_inserted, rows_updated
    FROM pre;

  INSERT INTO public.shams_offers AS o
    (item_code, branch_code, price, offer_percent, offer_display,
     after_offer_price, source_updated_at, updated_at)
  SELECT s.item_code, s.branch_code, s.price, s.offer_percent, s.offer_display,
         s.after_offer_price, p_source_updated_at, now()
    FROM public.shams_offers_staging s
   WHERE s.batch_id = p_batch_id
  ON CONFLICT (item_code, branch_code) DO UPDATE
    SET price             = EXCLUDED.price,
        offer_percent     = EXCLUDED.offer_percent,
        offer_display     = EXCLUDED.offer_display,
        after_offer_price = EXCLUDED.after_offer_price,
        source_updated_at = EXCLUDED.source_updated_at,
        updated_at        = now()
    /*
     * Untouched when nothing changed, exactly as the catalogue's promotion does
     * it. Without this, `source_updated_at` would degrade into a copy of the
     * sweep time and stop answering "how old is this branch's price" -- and
     * every slice would rewrite rows that had not moved.
     */
    WHERE o.price             IS DISTINCT FROM EXCLUDED.price
       OR o.offer_percent     IS DISTINCT FROM EXCLUDED.offer_percent
       OR o.offer_display     IS DISTINCT FROM EXCLUDED.offer_display
       OR o.after_offer_price IS DISTINCT FROM EXCLUDED.after_offer_price;

  /*
   * Offers that have ended.
   *
   * Scoped to the covered items and to them only. A branch that no longer
   * appears in this slice's staged rows for an item this slice *did* ask about
   * has genuinely lost its promotion; a branch belonging to any other item is
   * invisible here and cannot be deleted by this statement.
   */
  WITH covered AS (
    SELECT DISTINCT s.item_code
      FROM public.shams_offer_products_staging s
     WHERE s.batch_id = p_batch_id
  ),
  gone AS (
    DELETE FROM public.shams_offers o
     WHERE o.item_code IN (SELECT item_code FROM covered)
       AND NOT EXISTS (
             SELECT 1 FROM public.shams_offers_staging s
              WHERE s.batch_id = p_batch_id
                AND s.item_code = o.item_code
                AND s.branch_code = o.branch_code
           )
    RETURNING 1
  )
  SELECT count(*) INTO rows_deleted FROM gone;

  /*
   * Per-item verdicts.
   *
   * `checked_at` moves on every slice -- it is the record that we asked -- but
   * the rest of the row is left alone when nothing moved, so `updated_at` and
   * `source_updated_at` keep meaning "when this verdict last changed".
   */
  WITH incoming AS (
    SELECT s.item_code, s.scope, s.branches_available, s.branches_with_offer,
           s.offer_display, s.unit_price, s.offer_price
      FROM public.shams_offer_products_staging s
     WHERE s.batch_id = p_batch_id
  ),
  pre AS (
    SELECT (p.item_code IS NULL OR (
              p.scope               IS DISTINCT FROM i.scope
           OR p.branches_available  IS DISTINCT FROM i.branches_available
           OR p.branches_with_offer IS DISTINCT FROM i.branches_with_offer
           OR p.offer_display       IS DISTINCT FROM i.offer_display
           OR p.unit_price          IS DISTINCT FROM i.unit_price
           OR p.offer_price         IS DISTINCT FROM i.offer_price
           )) AS moved
      FROM incoming i
      LEFT JOIN public.shams_offer_products p ON p.item_code = i.item_code
  )
  SELECT count(*) FILTER (WHERE moved) INTO summaries_changed FROM pre;

  INSERT INTO public.shams_offer_products AS p
    (item_code, scope, branches_available, branches_with_offer, offer_display,
     unit_price, offer_price, checked_at, source_updated_at, updated_at)
  SELECT s.item_code, s.scope, s.branches_available, s.branches_with_offer,
         s.offer_display, s.unit_price, s.offer_price,
         now(), p_source_updated_at, now()
    FROM public.shams_offer_products_staging s
   WHERE s.batch_id = p_batch_id
  ON CONFLICT (item_code) DO UPDATE
    SET scope               = EXCLUDED.scope,
        branches_available  = EXCLUDED.branches_available,
        branches_with_offer = EXCLUDED.branches_with_offer,
        offer_display       = EXCLUDED.offer_display,
        unit_price          = EXCLUDED.unit_price,
        offer_price         = EXCLUDED.offer_price,
        -- Always: this is the "we looked" stamp, and a verdict that has not
        -- changed for a week is still a verdict from this morning.
        checked_at          = now(),
        source_updated_at   = CASE
          WHEN p.scope               IS DISTINCT FROM EXCLUDED.scope
            OR p.branches_available  IS DISTINCT FROM EXCLUDED.branches_available
            OR p.branches_with_offer IS DISTINCT FROM EXCLUDED.branches_with_offer
            OR p.offer_display       IS DISTINCT FROM EXCLUDED.offer_display
            OR p.unit_price          IS DISTINCT FROM EXCLUDED.unit_price
            OR p.offer_price         IS DISTINCT FROM EXCLUDED.offer_price
          THEN EXCLUDED.source_updated_at ELSE p.source_updated_at END,
        updated_at          = CASE
          WHEN p.scope               IS DISTINCT FROM EXCLUDED.scope
            OR p.branches_available  IS DISTINCT FROM EXCLUDED.branches_available
            OR p.branches_with_offer IS DISTINCT FROM EXCLUDED.branches_with_offer
            OR p.offer_display       IS DISTINCT FROM EXCLUDED.offer_display
            OR p.unit_price          IS DISTINCT FROM EXCLUDED.unit_price
            OR p.offer_price         IS DISTINCT FROM EXCLUDED.offer_price
          THEN now() ELSE p.updated_at END;

  SELECT count(*) INTO offer_rows   FROM public.shams_offers;
  SELECT count(*) INTO product_rows FROM public.shams_offer_products;
  SELECT count(*) INTO with_offers  FROM public.shams_offer_products WHERE scope <> 'none';

  DELETE FROM public.shams_offers_staging          WHERE batch_id = p_batch_id;
  DELETE FROM public.shams_offer_products_staging  WHERE batch_id = p_batch_id;

  UPDATE public.shams_offer_sync_state
     SET offer_row_count      = offer_rows,
         product_row_count    = product_rows,
         items_with_offers    = with_offers,
         source_marker        = coalesce(p_source_marker, source_marker),
         cursor_item_code     = CASE WHEN p_sweep_complete THEN NULL ELSE p_cursor END,
         sweep_items_done     = CASE WHEN p_sweep_complete THEN 0
                                     ELSE sweep_items_done + items_processed END,
         sweep_completed_at   = CASE WHEN p_sweep_complete THEN now() ELSE sweep_completed_at END,
         last_full_sweep_at   = CASE WHEN p_sweep_complete THEN now() ELSE last_full_sweep_at END,
         last_success_at      = now(),
         last_outcome         = 'success',
         last_error           = NULL,
         last_items_processed = items_processed,
         last_rows_inserted   = rows_inserted,
         last_rows_updated    = rows_updated,
         last_rows_deleted    = rows_deleted,
         -- Rows whose values actually moved. Summary rows count too: a product
         -- whose coverage went from `all` to `some` changed, even though no
         -- per-branch price did.
         last_rows_changed    = rows_inserted + rows_updated + rows_deleted + summaries_changed,
         last_started_at      = p_started_at,
         last_finished_at     = now(),
         updated_at           = now()
   WHERE id = 1;

  RETURN jsonb_build_object(
    'items',            items_processed,
    'inserted',         rows_inserted,
    'updated',          rows_updated,
    'deleted',          rows_deleted,
    'summariesChanged', summaries_changed,
    'changed',          rows_inserted + rows_updated + rows_deleted + summaries_changed,
    'offerRows',        offer_rows,
    'productRows',      product_rows,
    'itemsWithOffers',  with_offers,
    'sweepComplete',    p_sweep_complete
  );
END;
$$;

REVOKE ALL ON FUNCTION
  public.shams_promote_offers(uuid, timestamptz, text, text, boolean, timestamptz)
  FROM PUBLIC, anon, authenticated;

COMMENT ON FUNCTION
  public.shams_promote_offers(uuid, timestamptz, text, text, boolean, timestamptz) IS
  'Atomically promotes one offer sweep slice and records its metrics in '
  'shams_offer_sync_state. Scoped to the item codes the slice covered: no row belonging to '
  'any other item is read, written or deleted, so a partial sweep can never erase the rest '
  'of the dataset. Raises, changing nothing, on a slice that covered no items. Service role '
  'only.';

-- ===========================================================================
-- 7. The tick learns about offers
-- ===========================================================================
-- `shams_sync_tick()` gains a fourth reason to poke the application. Restated
-- whole because CREATE OR REPLACE takes the entire body; the only change from
-- `20260915120000_shams_product_catalog.sql` is `offers_due`.
--
-- Deliberately not gated on `shams_sync_settings.automation_enabled`, for the
-- same reason the catalogue is not: that switch governs starting work on Shams'
-- own infrastructure. Sweeping offers starts nothing there -- it reads a small
-- status document and, only when that says something changed, a bounded page of
-- per-item responses. It must never be able to POST /promotions/sync, which is a
-- 24-minute job on their side (`api-discovery.md` §11.3), and nothing in this
-- migration or the application can.

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
  offers_due    integer;
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

  SELECT count(*) INTO offers_due
    FROM public.shams_offer_sync_state o
   WHERE o.id = 1
     AND (o.next_refresh_due_at IS NULL OR o.next_refresh_due_at <= now());

  /*
   * Read the previous tick's reply before deciding anything.
   *
   * pg_net answers asynchronously, so a 401 -- the exact shape of a credential
   * drifting apart between the vault and the deployment -- can only ever be
   * observed here, one tick later.
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

  IF open_count = 0 AND due_count = 0 AND catalog_due = 0 AND offers_due = 0 THEN
    UPDATE public.shams_sync_scheduler_state
       SET last_outcome = 'idle', last_task = 'tick', last_error = note, updated_at = now()
     WHERE id = 1;
    RETURN 0;
  END IF;

  SELECT decrypted_secret INTO endpoint
    FROM vault.decrypted_secrets WHERE name = 'shams_sync_scheduler_url';

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
     * Neither the catalogue nor the offer dataset is harmed by this. Both are
     * read directly by the application, so an unconfigured scheduler means the
     * rows stop being refreshed, not that anyone stops being able to work.
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
                 'task', 'tick', 'open', open_count, 'due', due_count,
                 'catalog', catalog_due, 'offers', offers_due
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

  RETURN open_count + due_count + catalog_due + offers_due;
END;
$$;

REVOKE ALL ON FUNCTION public.shams_sync_tick() FROM PUBLIC, anon, authenticated;

COMMENT ON FUNCTION public.shams_sync_tick() IS
  'pg_cron entry point for Shams CRM. Pokes the application when a schedule slot is due, a '
  'run is open, the local product catalogue is due a refresh, or the local offer dataset is '
  'due a sweep slice; otherwise does nothing. Contacts Shams itself never.';

COMMIT;
