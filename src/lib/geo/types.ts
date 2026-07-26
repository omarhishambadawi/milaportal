/**
 * Geographic vocabulary for the whole portal.
 *
 * Every module that deals in places — Branch Directory, Smart Branch Finder,
 * order entry, delivery coverage, reporting — speaks these types. They are
 * deliberately provider-agnostic: nothing here mentions Google, so swapping or
 * adding a provider is a change inside `@/lib/maps`, not a change to every
 * caller's type signatures.
 */

/** A point on the earth, in decimal degrees. */
export interface LatLng {
  lat: number;
  lng: number;
}

/** An axis-aligned bounding box. */
export interface Bounds {
  south: number;
  west: number;
  north: number;
  east: number;
}

/**
 * How a distance was arrived at.
 *
 * Carried alongside every distance the Distance Engine returns, because the two
 * are not interchangeable and the caller sometimes needs to know which it got:
 * `road` is what you quote to a customer, `straight-line` is a lower bound that
 * can be 40% short in a city with a river or a ring road through it. A UI that
 * shows "12 km" without knowing which it has is showing a number it cannot
 * defend.
 */
export type DistanceSource = "road" | "straight-line";

export type TravelMode = "driving" | "walking" | "bicycling" | "transit";

export interface DistanceResult {
  /** Metres. */
  metres: number;
  /** Seconds. Null when only a straight-line distance was available. */
  seconds: number | null;
  source: DistanceSource;
}

/** A structured address, as returned by geocoding. */
export interface GeoAddress {
  formatted: string;
  city: string | null;
  district: string | null;
  street: string | null;
  country: string | null;
  postalCode: string | null;
  location: LatLng;
  /** Provider's stable identifier for the place, when it has one. */
  placeId: string | null;
}

/** A branch as returned by the spatial `branches_nearby` RPC. */
export interface NearbyBranch {
  branch_no: string;
  city: string;
  address: string | null;
  phone: string | null;
  latitude: number;
  longitude: number;
  scooter: boolean;
  working_hours: string | null;
  duty_hours: number | null;
  /** Great-circle metres from the query point, straight from PostGIS. */
  distance_m: number;
}

/** A branch ranked by the Distance Engine, with road distance layered on. */
export interface RankedBranch extends NearbyBranch {
  distance: DistanceResult;
}
