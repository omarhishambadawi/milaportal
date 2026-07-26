-- Spatial foundation for the Branch Directory and everything that will be built
-- on top of it (Smart Branch Finder, delivery coverage, nearest-branch routing).
--
-- The requirement this satisfies: a future "which branch is nearest to this
-- customer" query must not read every branch and sort in application code. At
-- 145 branches a sequential scan is invisible; at several thousand, with a
-- lookup on every inbound call, it is the whole latency budget. An index that
-- can answer "within N metres of this point" is the difference, and it has to
-- exist before the modules that assume it.
--
-- PostGIS is used rather than a hand-rolled bounding-box approximation because
-- it is available on this Supabase instance (3.3.7) and because the naive
-- alternative -- degrees-of-latitude arithmetic -- is wrong in exactly the way
-- that matters here: a degree of longitude is 111km at the equator and 96km at
-- Tabuk, so a "50km" box drawn in degrees is neither 50km nor square.

CREATE EXTENSION IF NOT EXISTS postgis;

-- Geography, not geometry: geography measures in metres on a spheroid, so
-- ST_Distance returns metres and ST_DWithin takes metres, with no projection to
-- choose and no per-region SRID to get wrong. For a country-sized dataset the
-- extra cost over a projected geometry is not measurable, and the correctness
-- is free.
--
-- A GENERATED column rather than a trigger: latitude/longitude remain the
-- writable source of truth that the importer and the UI already deal in, and
-- `location` cannot drift out of step with them because Postgres recomputes it
-- on every write. Nothing in the application layer has to remember to maintain
-- it.
ALTER TABLE public.branches
  ADD COLUMN IF NOT EXISTS location geography(Point, 4326)
  GENERATED ALWAYS AS (
    CASE
      WHEN latitude IS NULL OR longitude IS NULL THEN NULL
      ELSE ST_SetSRID(ST_MakePoint(longitude::double precision, latitude::double precision), 4326)::geography
    END
  ) STORED;

-- The index the nearest-branch query rides on. Partial, because a branch with
-- no coordinates can never satisfy a spatial predicate and there is no reason
-- to carry it in the tree.
CREATE INDEX IF NOT EXISTS branches_location_gix
  ON public.branches USING GIST (location)
  WHERE location IS NOT NULL;

-- ---------------------------------------------------------------------------
-- Nearest-branch lookup
-- ---------------------------------------------------------------------------
-- The single spatial entry point. Every "nearest branch" caller -- the Smart
-- Branch Finder, order entry, delivery coverage, the AI assistant -- goes
-- through this rather than through its own query, so the ordering, the active
-- filter and the radius semantics are defined once.
--
-- Returns great-circle metres. That is deliberately NOT the final answer for a
-- driver: road distance is longer and traffic-dependent, and the Distance
-- Engine layers Google Routes on top. What this provides is the *candidate set*
-- -- the handful of branches worth asking a routing API about -- which is
-- precisely the part that must not be a full scan, and which is also the part
-- that still works when the routing API is unavailable.
CREATE OR REPLACE FUNCTION public.branches_nearby(
  _lat        double precision,
  _lng        double precision,
  _radius_m   double precision DEFAULT 50000,
  _limit      integer DEFAULT 10,
  _scooter_only boolean DEFAULT false
)
RETURNS TABLE (
  branch_no   text,
  city        text,
  address     text,
  phone       text,
  latitude    numeric,
  longitude   numeric,
  scooter     boolean,
  working_hours text,
  duty_hours  numeric,
  distance_m  double precision
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, extensions
AS $$
  SELECT b.branch_no,
         b.city,
         b.address,
         b.phone,
         b.latitude,
         b.longitude,
         b.scooter,
         b.working_hours,
         b.duty_hours,
         ST_Distance(b.location, ST_SetSRID(ST_MakePoint(_lng, _lat), 4326)::geography) AS distance_m
  FROM public.branches b
  WHERE b.active
    AND b.location IS NOT NULL
    -- ST_DWithin is the index-using predicate. ORDER BY ST_Distance alone would
    -- also use the index via KNN, but pairing them bounds the work when the
    -- caller genuinely means "within this radius" and returns nothing rather
    -- than silently offering a branch 400km away.
    AND ST_DWithin(b.location, ST_SetSRID(ST_MakePoint(_lng, _lat), 4326)::geography, _radius_m)
    AND (NOT _scooter_only OR b.scooter)
  ORDER BY b.location <-> ST_SetSRID(ST_MakePoint(_lng, _lat), 4326)::geography
  LIMIT GREATEST(_limit, 1);
$$;

-- SECURITY DEFINER with an explicit grant to `authenticated` only. The function
-- exposes strictly less than the table's own SELECT policy already allows every
-- signed-in user, so it widens nothing; it is DEFINER so the planner can use the
-- index without RLS re-checking each candidate row.
REVOKE ALL ON FUNCTION public.branches_nearby(double precision, double precision, double precision, integer, boolean) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.branches_nearby(double precision, double precision, double precision, integer, boolean) TO authenticated;

COMMENT ON FUNCTION public.branches_nearby IS
  'Spatial candidate set for nearest-branch lookups. Great-circle metres; road distance is layered on by the Distance Engine.';

COMMENT ON COLUMN public.branches.location IS
  'Generated from latitude/longitude. Do not write directly -- update the coordinates instead.';
