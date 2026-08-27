/**
 * The AlShrouq half of an order, while it is being taken.
 *
 * One hook so that the form section that collects these values and the dialog
 * that confirms them read the same object. They used to be two: the form knew
 * the customer and the branch, the dialog kept its own payment method and its
 * own location, and the agent was asked for the second set after pressing
 * *Create order*. A confirmation that owns state is a second form.
 *
 * ## What it does not do
 *
 * It does not save, dispatch, schedule or contact anybody. It holds four values,
 * reads a link, and asks the CRM which branches AlShrouq serves. The handover
 * itself is still `alshrouqDispatchOrder`, on the server, behind the same safety
 * gate.
 *
 * ## Coverage comes from the CRM, every time
 *
 * `alshrouqDeliveryOptions` reads the live `branch_options`, which is the only
 * list carrying `covered`. Nothing is cached in this repository and no branch id
 * is written down here — the workbook that maps `P0217` to an AlShrouq id is
 * reference material, not a source this code reads, precisely because a frozen
 * copy cannot learn that a branch stopped being served.
 */

import { useCallback, useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { alshrouqDeliveryOptions } from "@/lib/shams.functions";
import type { AlShrouqOrderFormOptions } from "@/lib/shams.functions";
import { resolveAlShrouqBranch } from "@/lib/shams-crm/alshrouq-branches";
import { isPaidPaymentType } from "@/lib/shams-crm/alshrouq-payload";
import { ALSHROUQ } from "./constants";
import { alshrouqPaymentLabel } from "./payment-methods";
import {
  alshrouqRequirements,
  branchCoverage,
  canonicalCoordinate,
  readCoordinates,
  readLocation,
  type AlShrouqOrderInput,
  type AlShrouqRequirement,
  type BranchCoverage,
  type LocationReading,
} from "./order-requirements";

export interface AlShrouqOrderState {
  /** True while AlShrouq is the chosen delivery method. */
  active: boolean;
  /** The link exactly as the customer sent it. */
  mapUrl: string;
  setMapUrl: (value: string) => void;
  /**
   * Read out of the link when one can be read, typed when it cannot.
   *
   * The link remains the preferred source — it is the customer's own — but a
   * link that carries no point used to leave an agent with a blocked order and
   * no control to unblock it. Typing is the escape hatch, not the happy path.
   */
  latitude: string;
  longitude: string;
  /**
   * The same two values exactly as the boxes hold them.
   *
   * Only the two inputs should bind to these. `latitude`/`longitude` above are
   * what a consumer about to parse the value wants; these are what a person is
   * currently typing, half-finished decimal point and all.
   */
  latitudeText: string;
  longitudeText: string;
  setLatitude: (value: string) => void;
  setLongitude: (value: string) => void;
  /** Set by the server after following a short link. Clears when the link changes. */
  applyResolved: (latitude: number, longitude: number) => void;
  /**
   * True while the pair on screen was typed rather than read from a link.
   *
   * Provenance, not validity — it is what stops a later unreadable link from
   * discarding coordinates the agent entered on purpose.
   */
  manualCoordinates: boolean;
  location: LocationReading;
  paymentType: string;
  setPaymentType: (value: string) => void;
  paymentLabel: string | null;
  /**
   * The chosen method means the customer has already paid.
   *
   * Read from the CRM's live `payment_options` labels, never from an id written
   * down here. Drives the order value the courier is told to collect.
   */
  paidPayment: boolean;
  coverage: BranchCoverage;
  options: AlShrouqOrderFormOptions;
  optionsPending: boolean;
  /**
   * Whether this deployment can actually reach a courier.
   *
   * Server-reported and read-only. The create dialog has no order id, so this
   * is the only place the create journey can learn the gate is shut — which is
   * exactly the journey that used to promise "Create order + AlShrouq
   * delivery" and then contact nobody.
   *
   * Optimistic while the query is in flight: the dialog must not flash
   * "unavailable" before the server has answered.
   */
  dispatchAvailable: boolean;
  /** Everything still standing between this order and a courier. */
  requirements: AlShrouqRequirement[];
  ready: boolean;
  /** The shape the requirement rules and the approval plan both take. */
  input: AlShrouqOrderInput;
}

/**
 * The order's AlShrouq columns, as the form holds them.
 *
 * Named for the columns rather than for the hook so there is no translation
 * layer between what is on screen, what is validated and what is stored.
 */
export interface AlShrouqOrderFields {
  alshrouq_map_url: string;
  alshrouq_lat: string;
  alshrouq_lng: string;
  alshrouq_payment_type: string;
}

export function useAlShrouqOrder(
  deliveryType: string,
  branchNo: string | null,
  customerName: string,
  customerPhone: string,
  fields: AlShrouqOrderFields,
  patch: (next: Partial<AlShrouqOrderFields>) => void,
): AlShrouqOrderState {
  const active = deliveryType === ALSHROUQ;

  /*
   * The values are the *form's*, not this hook's.
   *
   * They used to be three `useState`s here — the link, the payment method and
   * the coordinates a short-link resolution produced — and that is precisely why
   * they did not survive a reopen: nothing outside this hook could see them, so
   * `buildOrderPayload` never wrote them and the rehydration effect had nothing
   * to fill. They are order columns, so they live in the order form's state and
   * are saved and reloaded with every other field.
   */
  const mapUrl = fields.alshrouq_map_url;
  const paymentType = fields.alshrouq_payment_type;

  /**
   * Where the pair on screen came from.
   *
   * The one piece of genuinely local state, and deliberately so: it is not an
   * order column. Nothing about the *values* is kept here — they stay the form's,
   * for the reason above — only the answer to "did a person type these?", which
   * is a fact about this editing session and has no meaning once the order is
   * reopened. A reopened order starts `false`: its coordinates came from
   * whatever produced them originally, and the link is still the authority.
   */
  const [manualCoordinates, setManualCoordinates] = useState(false);

  /**
   * Editing the link discards the point that belonged to it — unless a person
   * put that point there.
   *
   * The discard rule is the original one and it is a safety rule: a point is
   * only ever valid for the link it came from, and carrying it onto a different
   * link is how a driver is sent to the previous customer's address. Re-reading
   * the new text immediately is what keeps a full Maps URL filling the
   * coordinates in as it is pasted, with no round trip.
   *
   * The exception is narrow and it is the whole point of manual entry. A typed
   * pair was not derived from the old link, so the argument for discarding it
   * does not apply; and an agent who typed coordinates precisely *because* no
   * link would parse would otherwise watch them vanish the moment they tidied
   * the link box. A link that does parse still wins outright — the customer's
   * own pin beats a typed one, and accepting it clears the manual mark.
   */
  const setMapUrl = useCallback(
    (value: string) => {
      const reading = readLocation(value);
      if (reading.kind === "resolved") {
        setManualCoordinates(false);
        patch({
          alshrouq_map_url: value,
          alshrouq_lat: String(reading.latitude),
          alshrouq_lng: String(reading.longitude),
        });
        return;
      }
      if (manualCoordinates) {
        patch({ alshrouq_map_url: value });
        return;
      }
      patch({ alshrouq_map_url: value, alshrouq_lat: "", alshrouq_lng: "" });
    },
    [patch, manualCoordinates],
  );

  /**
   * What the server established by following a short link.
   *
   * A read point, so it clears the manual mark and overwrites — this is the
   * "Check location" button succeeding, which is the authoritative answer for
   * the link currently in the box.
   */
  const applyResolved = useCallback(
    (latitude: number, longitude: number) => {
      setManualCoordinates(false);
      patch({ alshrouq_lat: String(latitude), alshrouq_lng: String(longitude) });
    },
    [patch],
  );

  /** A coordinate the agent typed. Marked as theirs, so no later parse drops it. */
  const setLatitude = useCallback(
    (value: string) => {
      setManualCoordinates(true);
      patch({ alshrouq_lat: value });
    },
    [patch],
  );

  const setLongitude = useCallback(
    (value: string) => {
      setManualCoordinates(true);
      patch({ alshrouq_lng: value });
    },
    [patch],
  );

  /** Exactly what is in the two boxes. Only the boxes themselves should read it. */
  const latitudeText = fields.alshrouq_lat;
  const longitudeText = fields.alshrouq_lng;

  /**
   * The point, and why there isn't one.
   *
   * A stored pair is the answer whatever the link says — it is what was saved,
   * and on a reopened order the link may be a short one this browser cannot
   * read. Only when there is no pair does the link get re-read, which is what
   * still produces "this is a short link, check it" and the unsupported-link
   * wording for an order being typed.
   *
   * The pair goes through `readCoordinates` rather than straight into a
   * `resolved` reading. It used to be trusted as-is, which was safe while the
   * boxes were read-only and the only writer was a parser; now that a person can
   * type in them, `Number("")`-style nonsense would otherwise read back as a
   * *verified* location. The bounds are the same ones a pasted link is held to.
   */
  const location: LocationReading = useMemo(() => {
    if (latitudeText !== "" || longitudeText !== "") {
      return readCoordinates(latitudeText, longitudeText);
    }
    return readLocation(mapUrl);
  }, [latitudeText, longitudeText, mapUrl]);

  /**
   * The pair as everything except the two boxes should read it.
   *
   * `readCoordinates` above delegates to the geo module's own reader, which
   * tolerates the stray characters a pasted coordinate arrives with: a trailing
   * comma left by splitting "24.53738, 46.64555", a direction letter, the
   * invisible bidi mark a WhatsApp copy carries. Every consumer downstream —
   * the confirmation's summary line, `validateAlShrouqOrderFields`, the dispatch
   * payload — re-read the raw text with a bare `Number()`, which is NaN for all
   * three. So the box displayed a perfectly good latitude (it was showing the
   * *parsed* value) while the confirmation read **NaN, 46.64555** and the
   * validator reported the latitude missing. Two readers, one field.
   *
   * There is one reader now. The raw text is kept whenever it already parses on
   * its own, so nothing that works today changes by so much as a rounded digit —
   * a link-supplied coordinate is still passed through exactly as parsed. Only
   * the case that was broken is repaired, by substituting the value the rest of
   * the location system had already read successfully.
   */
  const latitude = canonicalCoordinate(latitudeText, location, "latitude");
  const longitude = canonicalCoordinate(longitudeText, location, "longitude");

  const setPaymentType = useCallback(
    (value: string) => patch({ alshrouq_payment_type: value }),
    [patch],
  );

  /**
   * The CRM's branch coverage and payment methods.
   *
   * Only while AlShrouq is the method, so every other order costs no call. One
   * query key, so a page holding the form and the dispatch card fetches once.
   */
  const load = useServerFn(alshrouqDeliveryOptions);
  const {
    data: options,
    isPending: optionsPending,
    isError: optionsFailed,
  } = useQuery<AlShrouqOrderFormOptions>({
    queryKey: ["alshrouq", "delivery-options"],
    enabled: active,
    staleTime: 5 * 60_000,
    /*
     * Two attempts, not none.
     *
     * `retry: false` meant a single transient failure — a dropped connection, a
     * session refreshing underneath the request — was permanent for the life of
     * the query. The agent had no control that would ask again, so the form sat
     * in its unresolved state until the page was reloaded. A bounded retry lets
     * a blip heal itself; it stays bounded because this is a read on the order
     * form's critical path and an unbounded retry would hold the coverage line
     * in "checking" for as long as the CRM stayed down, which is the very state
     * this change exists to make unreachable.
     *
     * Safe to repeat at all because it is a GET: `alshrouqDeliveryOptions`
     * reads `GET /integrations/alshrouq/config` and dispatches nothing.
     */
    retry: 2,
    queryFn: () => load({ data: undefined }),
  });

  /**
   * Coverage, with a final answer guaranteed.
   *
   * The order of these checks is the fix. `unknown` — the state that renders as
   * *"Checking AlShrouq coverage for this branch…"* — is now reachable **only
   * while a request is genuinely in flight**. Every way the check can end
   * lands on a terminal state:
   *
   *   * the query rejected (`optionsFailed`) — the server function itself could
   *     not be reached or refused;
   *   * it resolved but the CRM could not be read (`options.optionsError`);
   *   * it resolved with a list, and the branch is covered, uncovered or absent.
   *
   * Before this, both failures fell through to `!options` or to a lookup
   * against an empty list. The first left the form reporting "Checking…"
   * forever with no request outstanding — the reported incident — and the
   * second reported a CRM outage as a missing branch.
   */
  const coverage = useMemo<BranchCoverage>(() => {
    if (!active) return { kind: "no_branch" };
    if (optionsFailed) return { kind: "unavailable", errorKind: null };
    if (!options) return { kind: "unknown" };
    if (options.optionsError) return { kind: "unavailable", errorKind: options.optionsError };
    return branchCoverage(resolveAlShrouqBranch(options.branchOptions, branchNo));
  }, [active, options, optionsFailed, branchNo]);

  /**
   * The method's name. Never its id.
   *
   * This used to end `?? paymentType`, which put a bare `3` on screen for the
   * whole of any session the CRM config did not arrive in — including the first
   * render of every page, before it has been asked for. `alshrouqPaymentLabel`
   * still prefers the live list and only falls back to the CRM's own published
   * names when there is no list to consult.
   */
  const paymentLabel = useMemo(
    () => alshrouqPaymentLabel(paymentType, options?.paymentOptions),
    [paymentType, options?.paymentOptions],
  );

  /**
   * Whether the customer has already paid.
   *
   * Off until the option list has arrived, which is the safe way round: an
   * unknown method is treated as one the driver collects for, so a list that has
   * not loaded can only ever fail towards asking for money that is owed rather
   * than towards waiving money that is not.
   */
  const paidPayment = useMemo(
    () => isPaidPaymentType(paymentType, options?.paymentOptions),
    [paymentType, options?.paymentOptions],
  );

  const input = useMemo<AlShrouqOrderInput>(
    () => ({
      deliveryType,
      customerName,
      customerPhone,
      mapUrl,
      latitude,
      longitude,
      paymentType,
    }),
    [deliveryType, customerName, customerPhone, mapUrl, latitude, longitude, paymentType],
  );

  const requirements = useMemo(() => alshrouqRequirements(input, coverage), [input, coverage]);

  return {
    active,
    mapUrl,
    setMapUrl,
    latitude,
    longitude,
    latitudeText,
    longitudeText,
    setLatitude,
    setLongitude,
    applyResolved,
    manualCoordinates,
    location,
    paymentType,
    setPaymentType,
    paymentLabel,
    paidPayment,
    coverage,
    options: options ?? {
      branchOptions: [],
      paymentOptions: [],
      dispatchAvailable: true,
      optionsError: null,
    },
    optionsPending,
    dispatchAvailable: options?.dispatchAvailable !== false,
    requirements,
    ready: requirements.length === 0,
    input,
  };
}
