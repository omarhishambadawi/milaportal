import { KSA_BOUNDS, isWithin, roundCoordinate, type LatLng } from "@/lib/geo";
import type { Geocoder } from "./locator";
import { normalizePlace } from "./location-index";

/**
 * OpenStreetMap, as the last resort only.
 *
 * This fills the `Geocoder` seam `resolveOrigin` has always had. It is reached
 * *only* when the local gazetteer — cities, districts, areas, branch codes and
 * addresses, all built from the uploaded dataset — has no answer, which is the
 * ordering `resolveOrigin` enforces rather than something this module could
 * guarantee about itself.
 *
 * Three things follow from Nominatim being a free, donation-funded service with
 * a published usage policy rather than a paid API:
 *
 *   - **One request per second, globally.** Requests are serialized through a
 *     single promise chain with a minimum gap. A locator used by six agents at
 *     once must not turn into six parallel calls.
 *   - **Cache everything that succeeds, forever.** Saudi districts do not move.
 *     A resolved query is written to localStorage and reused on every later
 *     search, in this session and in the next one — so the second agent to ask
 *     about a district costs nothing.
 *   - **Never a hard dependency.** Offline, blocked, rate-limited or slow, this
 *     returns null and the caller reports "not found" exactly as it did before
 *     the fallback existed. Nothing here can fail a search that the local
 *     resolver could have answered.
 *
 * Results are constrained to Saudi Arabia at the API (`countrycodes=sa`) and
 * checked against KSA_BOUNDS on the way back, because a geocoder asked for
 * "الروضة" with no country hint will happily answer with somewhere in Egypt.
 */

const ENDPOINT = "https://nominatim.openstreetmap.org/search";

/** Nominatim's published limit is 1 req/s; the extra 100ms is margin for clock skew. */
const MIN_INTERVAL_MS = 1100;

/** Long enough for a cold lookup, short enough that an agent does not give up. */
const TIMEOUT_MS = 5000;

const CACHE_KEY = "milaserv.geocode.osm.v1";

/** Entries kept in localStorage. Bounded so the key cannot grow without limit. */
const MAX_CACHED = 500;

type CacheShape = Record<string, { lat: number; lng: number }>;

/* -------------------------------------------------------------------------- */
/* Cache                                                                       */
/* -------------------------------------------------------------------------- */

let memory: Map<string, LatLng> | null = null;

/**
 * Queries that came back empty, for this session only.
 *
 * Not persisted: a miss usually means the place is genuinely unknown to OSM,
 * but it can also mean the request timed out — and a timeout written to
 * localStorage would poison that query on this machine permanently.
 */
const misses = new Set<string>();

function cache(): Map<string, LatLng> {
  if (memory) return memory;
  memory = new Map();
  if (typeof localStorage === "undefined") return memory;
  try {
    const raw = localStorage.getItem(CACHE_KEY);
    if (!raw) return memory;
    const parsed = JSON.parse(raw) as CacheShape;
    for (const [key, point] of Object.entries(parsed)) {
      if (typeof point?.lat === "number" && typeof point?.lng === "number") {
        memory.set(key, { lat: point.lat, lng: point.lng });
      }
    }
  } catch {
    // A corrupt or foreign value is not worth a diagnostic; an empty cache is
    // correct behaviour, just slower.
  }
  return memory;
}

function remember(key: string, point: LatLng): void {
  const store = cache();
  store.set(key, point);
  if (typeof localStorage === "undefined") return;
  try {
    // Oldest-first eviction: Map preserves insertion order, so the tail is the
    // most recently useful.
    const entries = [...store.entries()].slice(-MAX_CACHED);
    memory = new Map(entries);
    localStorage.setItem(CACHE_KEY, JSON.stringify(Object.fromEntries(entries)));
  } catch {
    // Quota exceeded or storage disabled. The in-memory map still works for
    // the rest of the session, which is the case that matters.
  }
}

/** Drop the persisted cache. Exposed for tests and for a future admin control. */
export function clearGeocodeCache(): void {
  memory = null;
  misses.clear();
  try {
    localStorage?.removeItem(CACHE_KEY);
  } catch {
    /* nothing to do */
  }
}

/* -------------------------------------------------------------------------- */
/* Rate limiting                                                               */
/* -------------------------------------------------------------------------- */

let chain: Promise<unknown> = Promise.resolve();
let lastCall = 0;

/**
 * Run `task` no sooner than MIN_INTERVAL_MS after the previous one.
 *
 * A chain rather than a token bucket because the requirement is a *minimum gap*
 * between calls, not an average rate — bursting three requests and then waiting
 * three seconds would still breach the policy.
 */
function serialize<T>(task: () => Promise<T>): Promise<T> {
  const run = chain.then(async () => {
    const wait = Math.max(0, MIN_INTERVAL_MS - (Date.now() - lastCall));
    if (wait > 0) await new Promise((resolve) => setTimeout(resolve, wait));
    lastCall = Date.now();
    return task();
  });
  // The chain must survive a rejection, or one failed lookup blocks every
  // later one for the lifetime of the page.
  chain = run.then(
    () => undefined,
    () => undefined,
  );
  return run;
}

/* -------------------------------------------------------------------------- */
/* The provider                                                                */
/* -------------------------------------------------------------------------- */

interface NominatimHit {
  lat?: string;
  lon?: string;
}

/**
 * The `Geocoder` implementation. Returns null for anything it cannot place,
 * which the caller already treats as "fall through to the error message".
 */
export const geocodeWithOpenStreetMap: Geocoder = async (text) => {
  const key = normalizePlace(text);
  if (!key) return null;

  const cached = cache().get(key);
  if (cached) return cached;
  if (misses.has(key)) return null;

  if (typeof fetch !== "function") return null;

  const params = new URLSearchParams({
    q: text.trim(),
    format: "jsonv2",
    limit: "1",
    addressdetails: "0",
    // The whole feature is Saudi-only; asking globally invites an answer in the
    // wrong country that looks perfectly reasonable in the UI.
    countrycodes: "sa",
  });

  try {
    const point = await serialize(async () => {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
      try {
        const response = await fetch(`${ENDPOINT}?${params.toString()}`, {
          signal: controller.signal,
          headers: { Accept: "application/json" },
        });
        if (!response.ok) return null;
        const payload = (await response.json()) as NominatimHit[];
        const hit = Array.isArray(payload) ? payload[0] : undefined;
        if (!hit?.lat || !hit?.lon) return null;
        const candidate = { lat: Number(hit.lat), lng: Number(hit.lon) };
        if (!Number.isFinite(candidate.lat) || !Number.isFinite(candidate.lng)) return null;
        return candidate;
      } finally {
        clearTimeout(timer);
      }
    });

    // `countrycodes` is a hint the API mostly honours; the bounds check is what
    // actually guarantees it.
    if (!point || !isWithin(point, KSA_BOUNDS)) {
      misses.add(key);
      return null;
    }

    const rounded = { lat: roundCoordinate(point.lat), lng: roundCoordinate(point.lng) };
    remember(key, rounded);
    return rounded;
  } catch {
    // Offline, aborted, blocked by CSP, or malformed JSON. All the same to the
    // caller: no answer, and the local result stands.
    misses.add(key);
    return null;
  }
};
