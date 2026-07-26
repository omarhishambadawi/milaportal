import type { DistanceResult, LatLng } from "./types";

/** Mean earth radius, metres (IUGG). */
const EARTH_RADIUS_M = 6_371_008.8;

const toRadians = (degrees: number) => (degrees * Math.PI) / 180;

/**
 * Great-circle distance in metres.
 *
 * The fallback the whole Distance Engine rests on: it needs no network, no key
 * and no quota, so a routing outage degrades the product from "12 km by road,
 * 18 minutes" to "9 km away" rather than to a spinner. It is a genuine lower
 * bound — road distance is always at least this — which is what makes it safe
 * to rank by when nothing better is available.
 */
export function haversineMetres(a: LatLng, b: LatLng): number {
  const dLat = toRadians(b.lat - a.lat);
  const dLng = toRadians(b.lng - a.lng);
  const lat1 = toRadians(a.lat);
  const lat2 = toRadians(b.lat);

  const sinLat = Math.sin(dLat / 2);
  const sinLng = Math.sin(dLng / 2);
  const h = sinLat * sinLat + Math.cos(lat1) * Math.cos(lat2) * sinLng * sinLng;
  return 2 * EARTH_RADIUS_M * Math.asin(Math.min(1, Math.sqrt(h)));
}

export function straightLineDistance(a: LatLng, b: LatLng): DistanceResult {
  return { metres: haversineMetres(a, b), seconds: null, source: "straight-line" };
}

/**
 * Human-readable distance.
 *
 * Below a kilometre it rounds to 50m: quoting "847 m" implies a precision that
 * a geocoded pin and a straight-line estimate do not have.
 */
export function formatDistance(metres: number): string {
  if (!Number.isFinite(metres)) return "—";
  if (metres < 1000) {
    const rounded = Math.round(metres / 50) * 50;
    return `${Math.max(rounded, 50)} m`;
  }
  const km = metres / 1000;
  // One decimal below 10 km, where it distinguishes 1.5 from 2 — but never a
  // trailing ".0", because "9.0 km" reads as false precision rather than as
  // more of it.
  if (km >= 10) return `${Math.round(km)} km`;
  const rounded = Math.round(km * 10) / 10;
  return `${Number.isInteger(rounded) ? rounded : rounded.toFixed(1)} km`;
}

/** "18 min", "1 h 05 min". */
export function formatDuration(seconds: number | null): string {
  if (seconds == null || !Number.isFinite(seconds)) return "—";
  const totalMinutes = Math.max(1, Math.round(seconds / 60));
  if (totalMinutes < 60) return `${totalMinutes} min`;
  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;
  return `${hours} h ${String(minutes).padStart(2, "0")} min`;
}

/**
 * Phrase a distance for an agent to read aloud, hedged when it is an estimate.
 *
 * The hedge is the point: "about 9 km away" is honest about a straight-line
 * figure in a way that "9 km" is not, and an agent who repeats the unhedged
 * number to a customer has made a promise the data never made.
 */
export function describeDistance(result: DistanceResult): string {
  const distance = formatDistance(result.metres);
  if (result.source === "road") {
    return result.seconds != null
      ? `${distance} by road · ${formatDuration(result.seconds)}`
      : `${distance} by road`;
  }
  return `about ${distance} away`;
}
