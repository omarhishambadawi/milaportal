import { straightLineDistance } from "./distance";
import type { DistanceResult, LatLng } from "./types";

/**
 * Ranking anything by how far it is from a point.
 *
 * This is the seam the Branch Locator is built on, and the reason it exists is
 * entirely about what happens *next*: today distances are Haversine, computed in
 * the browser with no key and no network; tomorrow they come from the Routes
 * API, over the wire, with a per-element cost. Those two have nothing in common
 * except their answer — so the answer is the interface, and the measurement is a
 * pluggable provider.
 *
 * Which is why `rankByDistance` is **async even though Haversine is not**. An
 * arithmetic function pretending to be a network call looks like ceremony until
 * you try the swap: a synchronous engine forces every caller above it to grow an
 * `await`, a loading state and a race guard on the day the provider changes, and
 * those are exactly the component-level changes this is supposed to prevent. The
 * cost of the pretence is one microtask.
 *
 * Deliberately generic over the item, and deliberately ignorant of branches:
 * delivery coverage, order routing and the customer-address lookup all rank
 * different things against the same rules.
 */

export interface Ranked<T> {
  item: T;
  distance: DistanceResult;
}

/**
 * Measures one origin against many destinations, in order.
 *
 * The contract that makes the future swap safe: **one result per destination,
 * in the order given.** A provider that cannot measure a destination returns a
 * straight-line result for it rather than dropping it, so indices never shift.
 */
export type DistanceProvider = (
  origin: LatLng,
  destinations: readonly LatLng[],
) => Promise<DistanceResult[]>;

/** The default, and the whole of Phase 1: great-circle, in the browser. */
export const straightLineProvider: DistanceProvider = (origin, destinations) =>
  Promise.resolve(destinations.map((destination) => straightLineDistance(origin, destination)));

export interface RankOptions {
  /** How many to return, nearest first. */
  limit?: number;
  provider?: DistanceProvider;
}

/**
 * Nearest `limit` items to `origin`.
 *
 * Items `locate` returns null for are skipped rather than sorted to the end — a
 * branch with no coordinates is not "very far away", it is unrankable, and
 * showing it last would invite an agent to read it as the worst option rather
 * than as an absent one.
 */
export async function rankByDistance<T>(
  origin: LatLng,
  items: readonly T[],
  locate: (item: T) => LatLng | null,
  options: RankOptions = {},
): Promise<Ranked<T>[]> {
  const limit = Math.max(1, options.limit ?? 5);
  const measure = options.provider ?? straightLineProvider;

  const located: { item: T; position: LatLng }[] = [];
  for (const item of items) {
    const position = locate(item);
    if (position) located.push({ item, position });
  }
  if (located.length === 0) return [];

  const distances = await measure(
    origin,
    located.map((entry) => entry.position),
  );

  return located
    .map((entry, index) => ({
      item: entry.item,
      // A provider that returned a short array would otherwise produce
      // `undefined.metres` inside the sort. Falling back per element keeps a
      // partial provider failure to a downgraded row rather than a crash.
      distance: distances[index] ?? straightLineDistance(origin, entry.position),
    }))
    .sort((a, b) => a.distance.metres - b.distance.metres)
    .slice(0, limit);
}
