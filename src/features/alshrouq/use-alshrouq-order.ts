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

import { useCallback, useMemo } from "react";
import { useQuery } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { alshrouqDeliveryOptions } from "@/lib/shams.functions";
import type { AlShrouqOrderFormOptions } from "@/lib/shams.functions";
import { resolveAlShrouqBranch } from "@/lib/shams-crm/alshrouq-branches";
import { ALSHROUQ } from "./constants";
import {
  alshrouqRequirements,
  branchCoverage,
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
  /** Read out of the link, never typed. Empty until one is readable. */
  latitude: string;
  longitude: string;
  /** Set by the server after following a short link. Clears when the link changes. */
  applyResolved: (latitude: number, longitude: number) => void;
  location: LocationReading;
  paymentType: string;
  setPaymentType: (value: string) => void;
  paymentLabel: string | null;
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
   * Editing the link discards the point that belonged to it.
   *
   * The same rule the separate `resolved` state used to enforce: a point is only
   * ever valid for the link it came from, and carrying it onto a different link
   * is how a driver is sent to the previous customer's address. Re-reading the
   * new text immediately is what keeps a full Maps URL filling the coordinates
   * in as it is pasted, with no round trip.
   */
  const setMapUrl = useCallback(
    (value: string) => {
      const reading = readLocation(value);
      patch({
        alshrouq_map_url: value,
        alshrouq_lat: reading.kind === "resolved" ? String(reading.latitude) : "",
        alshrouq_lng: reading.kind === "resolved" ? String(reading.longitude) : "",
      });
    },
    [patch],
  );

  /** What the server established by following a short link. */
  const applyResolved = useCallback(
    (latitude: number, longitude: number) => {
      patch({ alshrouq_lat: String(latitude), alshrouq_lng: String(longitude) });
    },
    [patch],
  );

  const latitude = fields.alshrouq_lat;
  const longitude = fields.alshrouq_lng;

  /**
   * The point, and why there isn't one.
   *
   * A stored pair is the answer whatever the link says — it is what was saved,
   * and on a reopened order the link may be a short one this browser cannot
   * read. Only when there is no pair does the link get re-read, which is what
   * still produces "this is a short link, check it" and the unsupported-link
   * wording for an order being typed.
   */
  const location: LocationReading = useMemo(() => {
    if (latitude !== "" && longitude !== "") {
      return { kind: "resolved", latitude: Number(latitude), longitude: Number(longitude) };
    }
    return readLocation(mapUrl);
  }, [latitude, longitude, mapUrl]);

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
  const { data: options, isPending: optionsPending } = useQuery<AlShrouqOrderFormOptions>({
    queryKey: ["alshrouq", "delivery-options"],
    enabled: active,
    staleTime: 5 * 60_000,
    retry: false,
    queryFn: () => load({ data: undefined }),
  });

  const coverage = useMemo<BranchCoverage>(() => {
    if (!active) return { kind: "no_branch" };
    if (!options) return { kind: "unknown" };
    return branchCoverage(resolveAlShrouqBranch(options.branchOptions, branchNo));
  }, [active, options, branchNo]);

  const paymentLabel = useMemo(() => {
    if (!paymentType) return null;
    const hit = (options?.paymentOptions ?? []).find((p) => String(p.id) === paymentType);
    return hit?.label ?? paymentType;
  }, [paymentType, options?.paymentOptions]);

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
    applyResolved,
    location,
    paymentType,
    setPaymentType,
    paymentLabel,
    coverage,
    options: options ?? { branchOptions: [], paymentOptions: [], dispatchAvailable: true },
    optionsPending,
    dispatchAvailable: options?.dispatchAvailable !== false,
    requirements,
    ready: requirements.length === 0,
    input,
  };
}
