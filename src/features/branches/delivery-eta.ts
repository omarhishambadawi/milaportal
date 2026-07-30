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
 * which is what Saudi cities largely are.
 *
 * It is *reported* rather than applied to the banding, and that is a deliberate
 * change. The bands are keyed on the same straight-line kilometres the row
 * prints and the coverage rule tests, because the alternative desynchronizes two
 * numbers an agent reads side by side: multiply by 1.3 before banding and a
 * branch at 9.8 km sits in the "10–15 km" band while the badge beside it still
 * says it is inside the 10 km coverage. The road factor's real job is explaining
 * why 4 km is worth 25 minutes, so it lives in the tooltip where that question
 * gets asked.
 */
const ROAD_FACTOR = 1.3;

/**
 * Normal delivery coverage, in metres.
 *
 * The operational rule, not a display threshold: past this the order is outside
 * what the contracted partner and the branch scooters are expected to serve, so
 * the row warns rather than quietly quoting a longer estimate. Exported because
 * the ranker sorts on it, the panel badges it and the map draws it — one number,
 * three consumers, and they must not drift apart.
 */
export const COVERAGE_RADIUS_METRES = 10_000;

/** Whether a branch is inside normal delivery coverage of the customer. */
export function isWithinCoverage(metres: number): boolean {
  return metres <= COVERAGE_RADIUS_METRES;
}

/**
 * Where the last kilometre of coverage begins.
 *
 * Purely a *display* threshold, and it is worth being explicit about why that is
 * not a business-rule change. The rule is unchanged: coverage ends at 10 km, and
 * `isWithinCoverage` — the boolean the ranker sorts on and the map colours by —
 * still answers exactly as before. This only splits the "inside" half of that
 * answer in two for the badge, because 9.6 km and 1.2 km are both "available" and
 * an agent quoting the first one should know it is close to the edge.
 */
const NEAR_LIMIT_METRES = 8_000;

/** How a branch's distance reads against the coverage rule. */
export type CoverageTier = "available" | "near-limit" | "outside";

/**
 * The badge tier for a distance.
 *
 * Derived from the same numbers as `isWithinCoverage` rather than stored, so the
 * two can never disagree: everything at or under 10 km is inside, and the top
 * fifth of that range is flagged as approaching the edge.
 */
export function coverageTier(metres: number): CoverageTier {
  if (!isWithinCoverage(metres)) return "outside";
  return metres >= NEAR_LIMIT_METRES ? "near-limit" : "available";
}

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
 * Bands by straight-line distance, in kilometres.
 *
 * The three upper bands are the operational rules verbatim: 8–10 km is 35–45,
 * 10–15 is 45–60, beyond 15 is open-ended. Note that the 10 km boundary is also
 * the coverage boundary, so a branch that crosses into "45–60 min" is exactly the
 * one that has crossed out of normal coverage — the two signals agree by
 * construction rather than by coincidence.
 *
 * Below 8 km the rules speak in terms of locality instead of kilometres, so the
 * two fastest bands exist to give `estimateDelivery` something to refine: "same
 * neighbourhood: 20–30" is only reachable if a short trip has a band that fast,
 * and a single flat "under 8 km" band would have swallowed it.
 */
function distanceBand(km: number): Band {
  if (km < 3) return { min: 20, max: 30, basis: "near" };
  if (km < 8) return { min: 25, max: 40, basis: "near" };
  if (km < 10) return { min: 35, max: 45, basis: "medium" };
  if (km < 15) return { min: 45, max: 60, basis: "far" };
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
  const km = Math.max(0, input.metres) / 1000;
  const byDistance = distanceBand(km);

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

  const roadKm = km * ROAD_FACTOR;
  const coverage = isWithinCoverage(input.metres)
    ? "within the 10 km delivery coverage"
    : "beyond the 10 km delivery coverage";

  return {
    minMinutes: band.min,
    maxMinutes: band.max,
    label: formatDeliveryBand(band.min, band.max),
    basis: input.sameDistrict ? "same-district" : band.basis,
    detail: `${detail} · ~${roadKm.toFixed(1)} km by road, ${coverage} · estimated under normal conditions, never exact`,
  };
}

/** "≈ 25–30 min", or "≈ 60+ min" for the open-ended band. */
export function formatDeliveryBand(min: number, max: number | null): string {
  return max == null ? `≈ ${min}+ min` : `≈ ${min}–${max} min`;
}
