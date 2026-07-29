/**
 * How long a delivery is likely to take, from business rules rather than an API.
 *
 * The number an agent actually needs mid-call is "roughly when will this
 * arrive", and a straight-line kilometre figure does not answer it — nobody
 * converts 4.6 km into minutes in their head, and the conversion is not linear
 * anyway because the fixed costs (picking, packing, handing over to a rider)
 * dominate a short trip.
 *
 * Every number here is a stated band, never a point estimate, and the UI is
 * required to render it with a "≈". That is not hedging for its own sake: this
 * has no traffic data, no rider availability and no queue depth, so a single
 * figure would be a promise the model cannot keep. A band an agent reads aloud
 * as "about twenty-five to thirty minutes" is both more useful and more honest.
 *
 * Replacing this with the Routes API later is a matter of feeding real drive
 * times into `estimateDelivery` instead of a circuity multiplier — the band
 * structure and the labels stay, so the UI does not change.
 */

/**
 * Straight-line to road multiplier.
 *
 * Road distance always exceeds great-circle distance; the ratio is the "route
 * circuity factor", and 1.3 is the usual figure for a gridded urban network,
 * which is what Saudi cities largely are. It is applied before banding so a
 * 12 km straight line is treated as the ~15.6 km drive it really is rather than
 * landing an optimistic band lower.
 */
const ROAD_FACTOR = 1.3;

/** Which rule decided the band, for the tooltip and for tests. */
export type DeliveryBasis = "same-district" | "same-city" | "near" | "medium" | "far" | "very-far";

export interface DeliveryEstimate {
  minMinutes: number;
  /** Null on the open-ended top band, which reads "60+ min". */
  maxMinutes: number | null;
  /** Ready to render: "≈ 25–30 min". */
  label: string;
  basis: DeliveryBasis;
  /** One sentence explaining the band, for a `title`. */
  detail: string;
}

interface Band {
  min: number;
  max: number | null;
  basis: DeliveryBasis;
}

/**
 * Bands by approximate road distance.
 *
 * The two fastest are finer-grained than the brief's list because the brief's
 * locality rules imply them: "same neighbourhood: 20–30" is only reachable if a
 * sub-3km trip has a band that fast, and a flat "under 8 km" band would have
 * overridden it.
 */
function distanceBand(roadKm: number): Band {
  if (roadKm < 3) return { min: 20, max: 30, basis: "near" };
  if (roadKm < 8) return { min: 25, max: 40, basis: "near" };
  if (roadKm < 15) return { min: 35, max: 50, basis: "medium" };
  if (roadKm < 25) return { min: 45, max: 60, basis: "far" };
  return { min: 60, max: null, basis: "very-far" };
}

/** The slower of two bands. An open-ended band is always the slower one. */
function slower(a: Band, b: Band): Band {
  if (a.max == null) return a;
  if (b.max == null) return b;
  if (a.min !== b.min) return a.min > b.min ? a : b;
  return (a.max ?? 0) >= (b.max ?? 0) ? a : b;
}

export interface DeliveryInput {
  /** Straight-line metres from the customer to the branch. */
  metres: number;
  /** The customer's district is the branch's district. */
  sameDistrict?: boolean;
  /** Same city, whether or not the district matched or is even known. */
  sameCity?: boolean;
}

/**
 * The band for one branch.
 *
 * Locality refines distance rather than replacing it, and only ever downward in
 * optimism:
 *
 *   - **Same district** takes the distance band as-is. Being in the same
 *     neighbourhood is what makes the fast band credible, and a sprawling
 *     district still gets the slower band its kilometres earn.
 *   - **Same city, different district** floors the answer at 30–45, because a
 *     cross-neighbourhood delivery involves arterial roads and lights that
 *     three kilometres of straight line does not predict.
 *   - **Different city, or unknown** leaves distance to speak for itself.
 */
export function estimateDelivery(input: DeliveryInput): DeliveryEstimate {
  const roadKm = (Math.max(0, input.metres) / 1000) * ROAD_FACTOR;
  const byDistance = distanceBand(roadKm);

  let band = byDistance;
  let detail: string;

  if (input.sameDistrict) {
    detail = "Same neighbourhood as the branch";
  } else if (input.sameCity) {
    band = slower(byDistance, { min: 30, max: 45, basis: "same-city" });
    detail = "Same city, a different neighbourhood";
  } else {
    detail = "Estimated from distance alone";
  }

  return {
    minMinutes: band.min,
    maxMinutes: band.max,
    label: formatDeliveryBand(band.min, band.max),
    basis: input.sameDistrict ? "same-district" : band.basis,
    detail: `${detail} · ~${roadKm.toFixed(1)} km by road, estimated under normal conditions`,
  };
}

/** "≈ 25–30 min", or "≈ 60+ min" for the open-ended band. */
export function formatDeliveryBand(min: number, max: number | null): string {
  return max == null ? `≈ ${min}+ min` : `≈ ${min}–${max} min`;
}
