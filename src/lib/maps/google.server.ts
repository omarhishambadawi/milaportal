import { MAPS_REGION, MAPS_REST_BASE, ROUTES_API_URL } from "./config";
import { haversineMetres, straightLineDistance } from "@/lib/geo";
import type { DistanceResult, GeoAddress, LatLng, TravelMode } from "@/lib/geo";

/**
 * Server-side Google Maps Platform calls.
 *
 * `.server.ts`, so this module and the API key it reads can never be bundled
 * into the browser. Every function here follows the same contract: it returns a
 * useful answer or a documented fallback, and it never throws at the caller.
 * The reason is operational rather than stylistic — these calls sit on the path
 * of a live customer call, and a Google outage, an exhausted quota or a
 * mis-restricted key must degrade the answer, not fail the page.
 */

/** Server key. Never `VITE_`-prefixed; see config.ts for why the keys differ. */
function serverKey(): string | null {
  const key = process.env.GOOGLE_MAPS_API_KEY;
  return key && key.trim().length > 0 ? key.trim() : null;
}

export function isServerMapsConfigured(): boolean {
  return serverKey() != null;
}

/** Abort budget for any single Google call. */
const TIMEOUT_MS = 4000;

/**
 * Fetch with a hard timeout.
 *
 * Without this an unreachable endpoint hangs for the platform default — tens of
 * seconds — while an agent watches a spinner mid-call. Four seconds is longer
 * than a healthy Routes response and short enough that the Haversine fallback
 * still feels immediate.
 */
async function fetchWithTimeout(url: string, init?: RequestInit): Promise<Response | null> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } catch (error) {
    console.warn("[maps] request failed", {
      url: url.split("?")[0],
      error: error instanceof Error ? error.message : String(error),
    });
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/* -------------------------------------------------------------------------- */
/* Routes / Distance Matrix                                                    */
/* -------------------------------------------------------------------------- */

interface RouteMatrixEntry {
  originIndex?: number;
  destinationIndex?: number;
  distanceMeters?: number;
  duration?: string;
  condition?: string;
}

/** "1234s" → 1234. */
function parseProtoDuration(value: string | undefined): number | null {
  if (!value) return null;
  const match = value.match(/^([\d.]+)s$/);
  return match ? Number(match[1]) : null;
}

/**
 * Road distance and driving time from one origin to many destinations.
 *
 * Uses the Routes API's `computeRouteMatrix` rather than the legacy Distance
 * Matrix: it is the endpoint Google is investing in, it returns per-element
 * failure conditions instead of a single status for the whole matrix, and it
 * accepts `TRAFFIC_AWARE` — which is what the planned traffic-aware branch
 * recommendation needs, with no migration at that point.
 *
 * Returns one entry per destination, in the order given. Entries Google could
 * not route to fall back to straight-line rather than being dropped, so the
 * array always lines up with its input.
 */
export async function routeMatrix(
  origin: LatLng,
  destinations: readonly LatLng[],
  mode: TravelMode = "driving",
): Promise<DistanceResult[]> {
  const fallback = () => destinations.map((d) => straightLineDistance(origin, d));

  const key = serverKey();
  if (!key || destinations.length === 0) return fallback();

  const waypoint = (point: LatLng) => ({
    waypoint: { location: { latLng: { latitude: point.lat, longitude: point.lng } } },
  });

  const response = await fetchWithTimeout(ROUTES_API_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Goog-Api-Key": key,
      // A field mask is mandatory on this endpoint. Asking only for what is
      // used also keeps the response small and the billing tier lower.
      "X-Goog-FieldMask": "originIndex,destinationIndex,distanceMeters,duration,condition",
    },
    body: JSON.stringify({
      origins: [waypoint(origin)],
      destinations: destinations.map(waypoint),
      travelMode: mode.toUpperCase(),
      // TRAFFIC_AWARE is the cheaper of the two traffic-aware options and is
      // accepted only for DRIVING; anything else must omit the preference.
      ...(mode === "driving" ? { routingPreference: "TRAFFIC_AWARE" } : {}),
    }),
  });

  if (!response?.ok) {
    console.warn("[maps] routeMatrix unavailable, using straight-line", {
      status: response?.status ?? "network-error",
    });
    return fallback();
  }

  try {
    const payload = (await response.json()) as RouteMatrixEntry[];
    const byDestination = new Map<number, RouteMatrixEntry>();
    for (const entry of payload) {
      if (entry.destinationIndex != null) byDestination.set(entry.destinationIndex, entry);
    }
    return destinations.map((destination, index) => {
      const entry = byDestination.get(index);
      const metres = entry?.distanceMeters;
      // ROUTE_EXISTS is the only condition that means the numbers are real; an
      // unroutable island destination reports ROUTE_NOT_FOUND with no distance.
      if (entry?.condition !== "ROUTE_EXISTS" || metres == null) {
        return straightLineDistance(origin, destination);
      }
      return { metres, seconds: parseProtoDuration(entry.duration), source: "road" as const };
    });
  } catch (error) {
    console.warn("[maps] routeMatrix parse failed, using straight-line", {
      error: error instanceof Error ? error.message : String(error),
    });
    return fallback();
  }
}

/** Road distance between exactly two points. */
export async function roadDistance(
  origin: LatLng,
  destination: LatLng,
  mode: TravelMode = "driving",
): Promise<DistanceResult> {
  const [result] = await routeMatrix(origin, [destination], mode);
  return result ?? straightLineDistance(origin, destination);
}

/* -------------------------------------------------------------------------- */
/* Geocoding                                                                   */
/* -------------------------------------------------------------------------- */

interface GeocodeComponent {
  long_name: string;
  short_name: string;
  types: string[];
}

interface GeocodeResult {
  formatted_address?: string;
  place_id?: string;
  address_components?: GeocodeComponent[];
  geometry?: { location?: { lat: number; lng: number } };
}

function componentOf(components: GeocodeComponent[] | undefined, type: string): string | null {
  return components?.find((component) => component.types.includes(type))?.long_name ?? null;
}

function toGeoAddress(result: GeocodeResult): GeoAddress | null {
  const location = result.geometry?.location;
  if (!location) return null;
  return {
    formatted: result.formatted_address ?? "",
    // Riyadh and Jeddah come back as `locality`; the smaller towns in the branch
    // network are typed `administrative_area_level_2`, so both are consulted
    // before giving up on a city name.
    city:
      componentOf(result.address_components, "locality") ??
      componentOf(result.address_components, "administrative_area_level_2") ??
      componentOf(result.address_components, "administrative_area_level_1"),
    district: componentOf(result.address_components, "sublocality"),
    street: componentOf(result.address_components, "route"),
    country: componentOf(result.address_components, "country"),
    postalCode: componentOf(result.address_components, "postal_code"),
    location: { lat: location.lat, lng: location.lng },
    placeId: result.place_id ?? null,
  };
}

async function geocodeRequest(params: Record<string, string>): Promise<GeoAddress[]> {
  const key = serverKey();
  if (!key) return [];
  const query = new URLSearchParams({ ...params, key, region: MAPS_REGION, language: "ar" });
  const response = await fetchWithTimeout(`${MAPS_REST_BASE}/geocode/json?${query.toString()}`);
  if (!response?.ok) return [];
  try {
    const payload = (await response.json()) as { status?: string; results?: GeocodeResult[] };
    // ZERO_RESULTS is a legitimate answer, not a failure; anything else is worth
    // a log line, because OVER_QUERY_LIMIT and REQUEST_DENIED are configuration
    // problems that would otherwise present as "geocoding just doesn't work".
    if (payload.status && payload.status !== "OK" && payload.status !== "ZERO_RESULTS") {
      console.warn("[maps] geocode returned", { status: payload.status });
      return [];
    }
    return (payload.results ?? [])
      .map(toGeoAddress)
      .filter((address): address is GeoAddress => address != null);
  } catch {
    return [];
  }
}

/** Address text → candidate locations. Empty when unconfigured or unmatched. */
export function geocodeAddress(address: string): Promise<GeoAddress[]> {
  return geocodeRequest({ address });
}

/** Coordinates → structured address. Null when unconfigured or unmatched. */
export async function reverseGeocode(point: LatLng): Promise<GeoAddress | null> {
  const results = await geocodeRequest({ latlng: `${point.lat},${point.lng}` });
  return results[0] ?? null;
}

/**
 * Distance between two points without leaving the server.
 *
 * Exported so callers that only need a rough ordering — a report grouping
 * customers by nearest city, say — can skip the network entirely rather than
 * spending quota on precision they will not display.
 */
export { haversineMetres };
