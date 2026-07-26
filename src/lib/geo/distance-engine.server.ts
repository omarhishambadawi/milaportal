import { straightLineDistance } from "./distance";
import type { LatLng, NearbyBranch, RankedBranch, TravelMode } from "./types";

/**
 * The Distance Engine.
 *
 * The single answer in the portal to "how far, how long, and which is nearest".
 * Every future module — Smart Branch Finder, delivery coverage, order entry,
 * the AI assistant, workload balancing — asks this rather than computing its
 * own, so the ranking rules and the fallback behaviour exist once.
 *
 * It runs in two stages, and the split is the whole point:
 *
 *   1. **Narrow, in the database.** `branches_nearby` uses the PostGIS GiST
 *      index to return the handful of branches near the customer. This is what
 *      stops the feature from degrading as the network grows: it is a bounded
 *      index lookup at 145 branches and at 5,000.
 *
 *   2. **Rank, with road distance.** Only those candidates are sent to the
 *      Routes API. Asking Google about every branch would be both slow and
 *      billed per element; asking about eight is one cheap call.
 *
 * If step 2 is unavailable — no key, quota exhausted, network down — the
 * straight-line ordering from step 1 stands. That ordering is not arbitrary:
 * road distance is monotonic in straight-line distance often enough that the
 * nearest few branches are still the nearest few, and the result is labelled
 * `straight-line` so the UI can hedge the wording rather than overstate it.
 */

/** How many spatial candidates to route-check. */
const DEFAULT_CANDIDATES = 8;

/** Default search radius, metres. Wide enough to cross a Saudi metro area. */
const DEFAULT_RADIUS_M = 50_000;

/**
 * How the engine reaches the spatial index.
 *
 * A plain callback rather than a Supabase client, so this module depends on
 * neither Supabase nor the generated database types. That keeps it unit-testable
 * with a two-line stub, and it means a future caller running under service_role,
 * an edge function, or a different data source satisfies the contract without
 * the engine knowing.
 */
export type NearbyQuery = (args: {
  lat: number;
  lng: number;
  radiusM: number;
  limit: number;
  scooterOnly: boolean;
}) => Promise<NearbyBranch[]>;

export interface NearestOptions {
  /** How many branches to return. */
  limit?: number;
  /** Search radius in metres. */
  radiusM?: number;
  /** Restrict to branches that can deliver by scooter. */
  scooterOnly?: boolean;
  /** How many candidates to ask the routing API about. */
  candidates?: number;
  mode?: TravelMode;
}

/**
 * Rank branches near a point, cheapest-correct answer first.
 *
 * @param query Reaches the spatial index. See {@link NearbyQuery}.
 */
export async function nearestBranches(
  query: NearbyQuery,
  origin: LatLng,
  options: NearestOptions = {},
): Promise<RankedBranch[]> {
  const limit = Math.max(1, options.limit ?? 5);
  const candidateCount = Math.max(limit, options.candidates ?? DEFAULT_CANDIDATES);

  const candidates = await query({
    lat: origin.lat,
    lng: origin.lng,
    radiusM: options.radiusM ?? DEFAULT_RADIUS_M,
    limit: candidateCount,
    scooterOnly: options.scooterOnly ?? false,
  });
  if (candidates.length === 0) return [];

  // Straight-line ranking, always computed. This is the answer that ships if
  // routing is unavailable, so it is built first and only then improved upon.
  const ranked: RankedBranch[] = candidates.map((branch) => ({
    ...branch,
    distance: {
      metres: branch.distance_m,
      seconds: null,
      source: "straight-line" as const,
    },
  }));

  const { isServerMapsConfigured, routeMatrix } = await import("@/lib/maps/google.server");
  if (!isServerMapsConfigured()) return ranked.slice(0, limit);

  const road = await routeMatrix(
    origin,
    candidates.map((branch) => ({ lat: branch.latitude, lng: branch.longitude })),
    options.mode ?? "driving",
  );

  // Re-sort on road distance: the nearest branch as the crow flies is routinely
  // not the nearest to drive to, which is the entire reason for step 2.
  return ranked
    .map((branch, index) => ({ ...branch, distance: road[index] ?? branch.distance }))
    .sort((a, b) => a.distance.metres - b.distance.metres)
    .slice(0, limit);
}

/** The single nearest branch, or null when nothing is in range. */
export async function nearestBranch(
  query: NearbyQuery,
  origin: LatLng,
  options: Omit<NearestOptions, "limit"> = {},
): Promise<RankedBranch | null> {
  const [first] = await nearestBranches(query, origin, { ...options, limit: 1 });
  return first ?? null;
}

/**
 * Driving distance and time between two arbitrary points.
 *
 * Falls back to straight-line, same as everything else here, so callers can
 * render the result unconditionally and read `.source` to decide how to phrase
 * it.
 */
export async function travelDistance(
  origin: LatLng,
  destination: LatLng,
  mode: TravelMode = "driving",
) {
  const { isServerMapsConfigured, roadDistance } = await import("@/lib/maps/google.server");
  if (!isServerMapsConfigured()) return straightLineDistance(origin, destination);
  return roadDistance(origin, destination, mode);
}
