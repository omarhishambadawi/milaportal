/**
 * What an agent must supply on the order form once AlShrouq is the method, and
 * how each answer reads back. Pure, no I/O, no React.
 *
 * ## Why this moved onto the form
 *
 * The payment method and the delivery location used to be asked for inside the
 * approval dialog, which made that dialog a second order form: the agent had
 * finished the order, pressed *Create order*, and was then asked for three more
 * things before anything could be created. A confirmation that collects data is
 * not a confirmation. So the fields live beside the rest of the order, where an
 * agent fills them in while the customer is still on the phone, and the dialog
 * confirms what is already there.
 *
 * ## Why it is still not in `orderFormSchema`
 *
 * The reverted integration put conditional AlShrouq rules inside that schema,
 * and that is the mechanism behind the "agents cannot save orders" outage:
 * anything in there is on the save path for *every* delivery method. The rules
 * here gate **the AlShrouq handover** and nothing else — an ordinary save is
 * untouched, and so is saving an AlShrouq order without handing it over. The
 * schema stays byte-identical and a test pins that.
 *
 * See `order-fields.ts`, which owns the field-level requirements this reuses;
 * this module adds the two the courier needs that no order column holds — the
 * payment method and a resolvable location — and the branch's coverage.
 */

import { parseCoordinatePair } from "@/lib/geo/coordinates";
import { parseMapsUrl } from "@/lib/geo/maps-url";
import type { AlShrouqBranchResolution } from "@/lib/shams-crm/alshrouq-branches";
import { ALSHROUQ } from "./constants";
import { validateAlShrouqOrderFields, type AlShrouqFieldIssue } from "./order-fields";

/* -------------------------------------------------------------------------- */
/* The delivery location                                                      */
/* -------------------------------------------------------------------------- */

/**
 * What a pasted link amounts to.
 *
 * `needs_check` is deliberately not a failure. A `maps.app.goo.gl` link is a
 * perfectly good location that this browser cannot read — the shortener sends no
 * CORS headers — and the honest answer is "ask the server", not "that link is
 * wrong". Nothing here ever produces a coordinate it did not read.
 */
export type LocationReading =
  | { kind: "empty" }
  | { kind: "resolved"; latitude: number; longitude: number }
  /**
   * A Google shortener. `url` is the absolute HTTPS form to hand the resolver —
   * the raw text may have arrived without a scheme, and the resolver takes
   * absolute HTTPS only.
   */
  | { kind: "needs_check"; url: string }
  | { kind: "out_of_range" }
  /**
   * Something is in the two coordinate boxes, and it is not a point.
   *
   * Distinct from `unsupported`, which is about a *link*. Once the boxes accept
   * typing, "that link carries no location" and "those numbers are not a
   * location" are two different mistakes with two different fixes, and one
   * sentence covering both would name neither.
   */
  | { kind: "invalid_pair" }
  | { kind: "unsupported" };

/**
 * Read a location out of what the agent typed, without asking anybody.
 *
 * `parseMapsUrl` is pure and keyless and already handles every shape a shared
 * Maps link takes — the `/data=…!3d…!4d…` dropped pin, `?q=`/`?ll=`/`?destination=`,
 * the `@lat,lng` camera, a `geo:` share and a bare pair. It was previously only
 * ever called on the server; there is no reason for a browser to spend a round
 * trip reading numbers that are already sitting in the URL bar.
 */
export function readLocation(raw: string | null | undefined): LocationReading {
  const text = raw?.trim() ?? "";
  if (text === "") return { kind: "empty" };

  const parsed = parseMapsUrl(text);
  if (parsed.point) {
    return { kind: "resolved", latitude: parsed.point.lat, longitude: parsed.point.lng };
  }
  if (parsed.outOfRange) return { kind: "out_of_range" };
  // `normalizedUrl` is always present alongside `needsResolution`; the guard is
  // the type's, not a doubt about the parser.
  if (parsed.needsResolution && parsed.normalizedUrl) {
    return { kind: "needs_check", url: parsed.normalizedUrl };
  }
  return { kind: "unsupported" };
}

/**
 * Read the pair the agent typed, held to exactly the bounds a pasted link is.
 *
 * `parseCoordinatePair` is the same function `parseMapsUrl` delegates its range
 * check to, so a typed point and a parsed one are judged identically — a hand-
 * entered pair cannot reach a courier through a gap the link path would close.
 * Half a pair is not a location, which is the rule `orders` enforces with
 * `CHECK ((alshrouq_lat IS NULL) = (alshrouq_lng IS NULL))`.
 */
export function readCoordinates(
  latitude: string | null | undefined,
  longitude: string | null | undefined,
): LocationReading {
  const lat = latitude?.trim() ?? "";
  const lng = longitude?.trim() ?? "";
  if (lat === "" && lng === "") return { kind: "empty" };
  if (lat === "" || lng === "") return { kind: "invalid_pair" };

  const { point, outOfRange } = parseCoordinatePair(lat, lng);
  if (point) return { kind: "resolved", latitude: point.lat, longitude: point.lng };
  return outOfRange ? { kind: "out_of_range" } : { kind: "invalid_pair" };
}

/**
 * One coordinate, as a consumer that is about to `Number()` it should receive.
 *
 * `readCoordinates` above delegates to the geo module's reader, which tolerates
 * the stray characters a pasted coordinate arrives with — a trailing comma left
 * by splitting "24.53738, 46.64555", a direction letter, the invisible bidi mark
 * a WhatsApp copy carries. Everything downstream re-read the raw text with a
 * bare `Number()`, which is NaN for all three, so the form showed a good
 * latitude while the confirmation read **NaN, 46.64555** and
 * `validateAlShrouqOrderFields` reported the latitude missing. Two readers
 * disagreeing about one field.
 *
 * Deliberately conservative: text that already parses on its own is returned
 * untouched, so this can only ever repair a value that would have become NaN and
 * can never alter one that would not have. A link-supplied coordinate is passed
 * through exactly as it was parsed, down to the last digit.
 */
export function canonicalCoordinate(
  raw: string,
  location: LocationReading,
  axis: "latitude" | "longitude",
): string {
  const text = raw.trim();
  if (text === "" || Number.isFinite(Number(text))) return raw;
  return location.kind === "resolved" ? String(location[axis]) : raw;
}

/** What to tell the agent about a reading. `null` when nothing needs saying. */
export function describeLocationReading(reading: LocationReading): string | null {
  switch (reading.kind) {
    case "empty":
    case "resolved":
      return null;
    case "needs_check":
      return "This is a shortened Google Maps link. Check the location to read its coordinates.";
    case "out_of_range":
      return "Those coordinates fall outside Saudi Arabia. Check the link points at the delivery address, or correct the latitude and longitude below.";
    case "invalid_pair":
      return "Those are not a usable latitude and longitude. Enter both, as decimal degrees — for example 24.71360 and 46.67530.";
    case "unsupported":
      return "The coordinates could not be read from this link. Ask the customer to drop a pin on the delivery spot and share that Google Maps link, or enter the latitude and longitude below by hand.";
  }
}

/**
 * What AlShrouq is told the order is worth.
 *
 * `order_value` is the figure the driver is asked to collect at the door, not
 * what the pharmacy invoiced. On a method that means the customer has already
 * paid, those two are different numbers and sending the invoice would have
 * somebody pay twice — so it is nothing, and the order's own `invoice_value` is
 * left exactly as it is for every other purpose that reads it.
 *
 * The screens use this so the card, the confirmation and the payload cannot
 * disagree; the payload builder applies the same rule again on the server,
 * because that is the only copy a request bypassing these screens must obey.
 */
export function alshrouqOrderValue(invoiceValue: string, paidPayment: boolean): string {
  return paidPayment ? "0" : invoiceValue;
}

/** `24.53728` — five places is roughly a metre, and it fits a narrow column. */
export function formatCoordinate(value: number): string {
  return value.toFixed(5);
}

/* -------------------------------------------------------------------------- */
/* Branch coverage                                                            */
/* -------------------------------------------------------------------------- */

export type BranchCoverage =
  /** AlShrouq serves this branch and published an id for it. */
  | { kind: "covered"; branchName: string | null }
  /** AlShrouq does not serve it. Not an error, and not fixable by the agent. */
  | { kind: "not_covered"; branchName: string | null; note: string | null }
  /** No branch chosen yet — nothing to say. */
  | { kind: "no_branch" }
  /** Something to raise with whoever maintains the branch list. */
  | { kind: "unlisted"; reason: "not_in_crm" | "no_id_published" }
  /**
   * The coverage check could not be completed — the CRM could not be reached,
   * or the request for the list failed.
   *
   * **Terminal, and distinct from `unknown` on purpose.** `unknown` means "the
   * answer has not arrived yet" and is a state the screen may sit in while a
   * request is in flight. This means "the answer is not coming", and it is the
   * state whose absence caused the incident: a failed options request was
   * indistinguishable from a pending one, so the form said *"Checking AlShrouq
   * coverage for this branch…"* indefinitely and never reached a final answer.
   *
   * It is also what stops a CRM outage being reported as a branch-list problem.
   * Resolving a branch against a list that failed to load yields `not_in_crm`,
   * and that was shown to agents as *"This branch is not in AlShrouq's list…
   * Report it to whoever maintains the branch list"* — a false statement about
   * the branch, and an errand for somebody who cannot fix it.
   *
   * `errorKind` is the `ShamsCrmError.kind` when there is one. An identifier,
   * never a message from the CRM and never a credential.
   */
  | { kind: "unavailable"; errorKind: string | null }
  /** The list has not arrived, so coverage is not yet known. */
  | { kind: "unknown" };

/**
 * Turn a branch resolution into the thing the form shows.
 *
 * The resolution itself comes from `resolveAlShrouqBranch` against the CRM's
 * live `branch_options` — the only list that carries `covered`, the flag marking
 * the branches AlShrouq does not serve. This adds no branch ids of its own and
 * freezes no copy of the mapping: a shipped copy is what the reverted
 * integration did, and a frozen list cannot learn that a branch stopped being
 * served.
 */
export function branchCoverage(
  resolution: AlShrouqBranchResolution | null | undefined,
): BranchCoverage {
  if (!resolution) return { kind: "unknown" };
  if (resolution.kind === "resolved") {
    return { kind: "covered", branchName: resolution.branchName };
  }
  if (resolution.kind === "not_covered") {
    return {
      kind: "not_covered",
      branchName: resolution.branchName,
      note: resolution.note,
    };
  }
  if (resolution.reason === "no_branch_on_order") return { kind: "no_branch" };
  return { kind: "unlisted", reason: resolution.reason };
}

/**
 * What the coverage line says.
 *
 * The uncovered sentence names the consequence rather than the state, because
 * "not covered" alone reads as something the agent typed wrong — it is not, and
 * the only useful next step is to send the order another way.
 */
export function describeBranchCoverage(coverage: BranchCoverage): string {
  switch (coverage.kind) {
    case "covered":
      return "AlShrouq delivers from this branch.";
    case "not_covered":
      return "AlShrouq does not cover this branch. This order cannot be handed over to AlShrouq from here — choose another delivery method.";
    case "no_branch":
      return "Choose a branch to check AlShrouq coverage.";
    case "unlisted":
      return coverage.reason === "no_id_published"
        ? "This branch has no AlShrouq id, so it cannot be handed over. Report it to whoever maintains the branch list."
        : "This branch is not in AlShrouq's list, so it cannot be handed over. Report it to whoever maintains the branch list.";
    case "unavailable":
      // The same sentence `explainAlShrouqReadiness("unverified")` gives on the
      // order page, so both journeys say one thing about one situation. It
      // blames nobody: the branch may well be covered, and the only honest
      // report is that we could not find out.
      return "Branch coverage could not be checked, so this order cannot be handed over yet. Create the order and hand it over from the order page once the connection is back.";
    case "unknown":
      return "Checking AlShrouq coverage for this branch…";
  }
}

/** Whether a handover may be offered at all for this branch. */
export function coverageAllowsDispatch(coverage: BranchCoverage): boolean {
  return coverage.kind === "covered";
}

/* -------------------------------------------------------------------------- */
/* Everything the handover needs                                              */
/* -------------------------------------------------------------------------- */

/** The AlShrouq-only values the order form now collects. */
export interface AlShrouqOrderInput {
  deliveryType: string;
  customerName: string;
  customerPhone: string;
  /** The link exactly as the customer sent it. Never rewritten. */
  mapUrl: string;
  /** Read out of the link, or resolved from it. Never typed. */
  latitude: string;
  longitude: string;
  /** The CRM's own payment id, as a string. There is no enum in this codebase. */
  paymentType: string;
}

/** One thing still missing, named by the control an agent would go and fix. */
export interface AlShrouqRequirement {
  field: AlShrouqFieldIssue["field"] | "payment_type" | "branch_coverage";
  message: string;
}

/**
 * Everything standing between this order and a courier.
 *
 * Returns `[]` for every other delivery method — the same early exit
 * `validateAlShrouqOrderFields` makes, and for the same reason: an ordinary
 * order must not be reachable by any rule below it.
 *
 * It **returns** problems rather than throwing, so nothing here can escape into
 * a submit handler and surface as a failed save.
 */
export function alshrouqRequirements(
  input: AlShrouqOrderInput,
  coverage: BranchCoverage,
): AlShrouqRequirement[] {
  if (input.deliveryType !== ALSHROUQ) return [];

  const issues: AlShrouqRequirement[] = validateAlShrouqOrderFields({
    deliveryType: input.deliveryType,
    customerName: input.customerName,
    customerPhone: input.customerPhone,
    customerLocation: input.mapUrl,
    latitude: input.latitude,
    longitude: input.longitude,
  });

  if (input.paymentType.trim() === "") {
    issues.push({
      field: "payment_type",
      message: "Choose how the customer pays before handing this to AlShrouq.",
    });
  }

  if (!coverageAllowsDispatch(coverage)) {
    issues.push({ field: "branch_coverage", message: describeBranchCoverage(coverage) });
  }

  return issues;
}

/** True when the order carries everything a handover needs. */
export function readyForAlShrouq(input: AlShrouqOrderInput, coverage: BranchCoverage): boolean {
  return alshrouqRequirements(input, coverage).length === 0;
}
