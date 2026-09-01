/**
 * What an AlShrouq order needs that an ordinary one does not. Pure, no I/O.
 *
 * ## Why this is not in `orderFormSchema`
 *
 * The reverted integration put its conditional rules inside `orderFormSchema` —
 * a `superRefine` that could refuse a save — and that is the mechanism behind
 * the "agents cannot save orders" outage. The rules themselves were not the
 * problem; their *position* was. Anything inside that schema is on the save path
 * for **every** delivery method, so a mistake in an AlShrouq branch, or a field
 * arriving blank from a hydration race, failed orders that had nothing to do
 * with AlShrouq.
 *
 * So this lives outside it and `orderFormSchema` is byte-identical to the
 * baseline. Three properties follow, and each is a test below:
 *
 *   1. **A non-AlShrouq order never reaches this code.** `requiredFor` returns
 *      an empty list for every other delivery method, so the ordinary save path
 *      is not merely unchanged in behaviour — it is unchanged in *shape*.
 *   2. **It returns errors, it does not throw.** No exception from here can
 *      escape into a submit handler and surface as a failed save.
 *   3. **Deleting this file would restore the previous behaviour exactly.** It
 *      adds a check; it does not alter one. That is the property the old design
 *      could not claim.
 *
 * ## Where it is used
 *
 * By the dispatch-approval flow, which is the point at which these fields are
 * actually needed — a courier has to be told who to call and where to go. It is
 * deliberately *not* wired into `useOrderForm.submit` in this phase: the modal
 * that collects the location does not exist yet, and enforcing a field the form
 * has no control for would block saving with no way to comply.
 */

/** The AlShrouq delivery method, as `orders.delivery_type` stores it. */
export { ALSHROUQ } from "./constants";
import { coordinateNumber } from "@/lib/geo/coordinates";
import { ALSHROUQ } from "./constants";

/** One problem, named by the field an agent would go and fix. */
export interface AlShrouqFieldIssue {
  field: "customer_name" | "customer_phone" | "customer_location" | "customer_lat" | "customer_lng";
  message: string;
}

/** The order fields AlShrouq depends on, as a form holds them: text. */
export interface AlShrouqOrderFields {
  deliveryType: string;
  customerName: string;
  customerPhone: string;
  /** The human-readable location, or the Maps link the customer sent. */
  customerLocation: string;
  /** Derived from the location, never typed by an agent. */
  latitude: string;
  longitude: string;
}

/** Which fields this delivery method makes mandatory. Empty for every other. */
export function requiredFor(deliveryType: string): readonly AlShrouqFieldIssue["field"][] {
  if (deliveryType !== ALSHROUQ) return [];
  return [
    "customer_name",
    "customer_phone",
    "customer_location",
    "customer_lat",
    "customer_lng",
  ] as const;
}

function blank(value: string | null | undefined): boolean {
  return typeof value !== "string" || value.trim().length === 0;
}

/**
 * A usable coordinate, or null.
 *
 * `Number(value.trim())` was here, and it disagreed with the reader the rest of
 * the location system uses: a latitude pasted as `"24.53738,"` — the comma left
 * over from splitting `"24.53738, 46.64555"` — or carrying the invisible mark a
 * WhatsApp copy brings, showed as a **Verified location** on the form and was
 * reported *missing* by this function at the same moment. `coordinateNumber` is
 * that same reader, so there is one answer to "is this a coordinate" and one
 * only.
 *
 * The bound is applied here rather than left to the database. A latitude of 95
 * is not a delivery location and the agent should hear so from the field they
 * typed it into, not from a constraint violation on save.
 */
function coordinate(value: string, limit: number): number | null {
  if (blank(value)) return null;
  const n = coordinateNumber(value);
  if (n === null || n < -limit || n > limit) return null;
  return n;
}

/**
 * Everything an AlShrouq order is missing, or an empty list.
 *
 * **Returns `[]` immediately for every other delivery method.** That early exit
 * is the safety property: an ordinary order cannot be failed by anything below
 * it, however wrong the rest of this function might one day be.
 */
export function validateAlShrouqOrderFields(fields: AlShrouqOrderFields): AlShrouqFieldIssue[] {
  if (fields.deliveryType !== ALSHROUQ) return [];

  const issues: AlShrouqFieldIssue[] = [];

  if (blank(fields.customerName)) {
    issues.push({
      field: "customer_name",
      message: "The customer's name is required for AlShrouq.",
    });
  }
  if (blank(fields.customerPhone)) {
    issues.push({
      field: "customer_phone",
      message: "The customer's phone number is required for AlShrouq.",
    });
  }
  if (blank(fields.customerLocation)) {
    issues.push({
      field: "customer_location",
      message: "A delivery location is required for AlShrouq.",
    });
  }

  /*
   * Both coordinates or neither — the same rule `orders` enforces with
   * `CHECK ((alshrouq_lat IS NULL) = (alshrouq_lng IS NULL))`, and the same rule
   * the payload builder applies. Half a point is not a location, and the message
   * names the half that is missing so the agent knows which one to look at.
   */
  const lat = coordinate(fields.latitude, 90);
  const lng = coordinate(fields.longitude, 180);
  if (lat === null) {
    issues.push({
      field: "customer_lat",
      message:
        "The delivery location has no usable latitude — reselect the location or correct it.",
    });
  }
  if (lng === null) {
    issues.push({
      field: "customer_lng",
      message:
        "The delivery location has no usable longitude — reselect the location or correct it.",
    });
  }

  return issues;
}

/** True when this order carries everything AlShrouq needs. */
export function isAlShrouqOrderComplete(fields: AlShrouqOrderFields): boolean {
  return validateAlShrouqOrderFields(fields).length === 0;
}
