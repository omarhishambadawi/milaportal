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
import type { AlShrouqDispatchOptions } from "@/lib/shams-crm/alshrouq-config.server";
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
  options: AlShrouqDispatchOptions;
  optionsPending: boolean;
  /** Everything still standing between this order and a courier. */
  requirements: AlShrouqRequirement[];
  ready: boolean;
  /** The shape the requirement rules and the approval plan both take. */
  input: AlShrouqOrderInput;
}

export function useAlShrouqOrder(
  deliveryType: string,
  branchNo: string | null,
  customerName: string,
  customerPhone: string,
): AlShrouqOrderState {
  const active = deliveryType === ALSHROUQ;

  const [mapUrl, setMapUrlRaw] = useState("");
  const [paymentType, setPaymentType] = useState("");
  /**
   * Coordinates the *server* established by following a short link.
   *
   * Kept apart from the ones read out of the URL so that editing the link can
   * discard them without ambiguity: a resolved point belongs to the link it came
   * from, and carrying it onto a different link is how a driver is sent to the
   * previous customer's address.
   */
  const [resolved, setResolved] = useState<{ lat: number; lng: number } | null>(null);

  const setMapUrl = useCallback((value: string) => {
    setMapUrlRaw(value);
    setResolved(null);
  }, []);

  const applyResolved = useCallback((latitude: number, longitude: number) => {
    setResolved({ lat: latitude, lng: longitude });
  }, []);

  /** Read without asking anybody — the numbers are usually in the URL already. */
  const parsed = useMemo(() => readLocation(mapUrl), [mapUrl]);

  /**
   * The point, from whichever source actually produced one.
   *
   * The link is preferred over a resolution because it is the newer answer: a
   * resolution is only ever kept for the link it was made against, and
   * `setMapUrl` drops it the moment the text changes.
   */
  const location: LocationReading = useMemo(() => {
    if (parsed.kind === "resolved") return parsed;
    if (resolved) return { kind: "resolved", latitude: resolved.lat, longitude: resolved.lng };
    return parsed;
  }, [parsed, resolved]);

  const latitude = location.kind === "resolved" ? String(location.latitude) : "";
  const longitude = location.kind === "resolved" ? String(location.longitude) : "";

  /**
   * The CRM's branch coverage and payment methods.
   *
   * Only while AlShrouq is the method, so every other order costs no call. One
   * query key, so a page holding the form and the dispatch card fetches once.
   */
  const load = useServerFn(alshrouqDeliveryOptions);
  const { data: options, isPending: optionsPending } = useQuery<AlShrouqDispatchOptions>({
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
    options: options ?? { branchOptions: [], paymentOptions: [] },
    optionsPending,
    requirements,
    ready: requirements.length === 0,
    input,
  };
}
