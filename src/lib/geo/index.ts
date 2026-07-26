/**
 * The Geo Service — the portal's single home for geographic operations.
 *
 * Import from `@/lib/geo`, not from the files beneath it, so the internal
 * layout can change without touching consumers. Anything provider-specific
 * (SDK loading, geocoding, routing) lives in `@/lib/maps`; everything here is
 * pure and runs identically on the server, in the browser, and in a test.
 */

export type {
  Bounds,
  DistanceResult,
  DistanceSource,
  GeoAddress,
  LatLng,
  NearbyBranch,
  RankedBranch,
  TravelMode,
} from "./types";

export {
  KSA_BOUNDS,
  KSA_CENTER,
  boundsOf,
  centerOf,
  formatLatLng,
  isValidLatLng,
  isWithin,
  normalizeAddress,
  padBounds,
  parseCoordinatePair,
  roundCoordinate,
  type CoordinateParse,
} from "./coordinates";

export {
  describeDistance,
  formatDistance,
  formatDuration,
  haversineMetres,
  straightLineDistance,
} from "./distance";

export {
  MAX_WAYPOINTS,
  directionsUrl,
  mapSearchUrl,
  multiStopUrl,
  navigationUrl,
  resolveMapUrl,
  resolveNavUrl,
} from "./maps-url";
