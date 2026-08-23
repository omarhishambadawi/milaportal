/**
 * The AlShrouq create-order payload, built from an order. Pure, no I/O.
 *
 * Offline by construction: no `crmFetch`, no HTTP, no Supabase, no React, no
 * clock, no randomness. Give it the same order twice and it returns the same
 * payload. Nothing here sends anything — connecting this to the CRM is a
 * separate, later phase.
 *
 * ## Where the field list comes from
 *
 * The eleven keys below are the ones the CRM's own stored AlShrouq orders carry,
 * read from the PharmacyCRM Desktop package's cached
 * `GET /integrations/alshrouq/orders` response (127 real deliveries). No field is
 * invented, and none is added "for completeness" — an unrecognised key is a
 * request the CRM may reject outright, which is how the previous attempt failed
 * when it sent `value` instead of `order_value`.
 *
 * ## The rules that come from real data, not intuition
 *
 * Three of these look wrong until you check the CRM's own records:
 *
 *   - **`order_value: 0` is valid and ordinary.** 107 of those 127 deliveries
 *     carry `0.0`, COD and SPAN jobs included. A `> 0` rule would refuse orders
 *     the Desktop creates every day.
 *   - **`client_order_id` is a string, never a number.** One real value is
 *     `"9396####"`. Parsing it as a number would corrupt it, and prefixing it
 *     `CC-`/`TS-` would make Portal orders unmatchable against Desktop ones.
 *   - **`customer_address` is a Google Maps *link*, not a street address**, and
 *     104 of 126 are unresolved `maps.app.goo.gl` short links. It is passed
 *     through exactly as stored; resolving it is not this module's business and
 *     may not be anyone's.
 *
 * ## What is deliberately not defaulted
 *
 * `preparation_time` is `10` on 122 of 127 records, but whether the Desktop
 * sends that or the CRM fills it in is **not established**. So it is passed
 * through when a caller has one and the key is omitted otherwise — a default of
 * 10 here would be this repository inventing a number and calling it a fact.
 *
 * Likewise the payment ids: the valid set arrives in `context.paymentOptionIds`,
 * read live from `GET /integrations/alshrouq/config`. There is no enum here. The
 * list belongs to the CRM, and a deployment that gains a fifth method should not
 * need this file edited.
 *
 * The branch id arrives resolved, for the same reason: the 136-row mapping is
 * the CRM's to publish and is the only source that also carries `covered`.
 * Resolving it is a later phase.
 */

import { stripOrderPrefix } from "@/lib/branches";

/**
 * Exactly the keys the CRM's stored orders carry. Optional keys are **omitted**
 * rather than sent as null: the one field observed null in real data is
 * `customer_address`, and an absent key is the honest encoding of "we do not
 * have this" for a contract whose null-handling is not documented.
 */
export interface AlShrouqCreatePayload {
  branch_id: string;
  client_order_id: string;
  customer_name: string;
  customer_phone: string;
  payment_type: number;
  order_value: number;
  customer_address?: string;
  customer_lat?: number;
  customer_lng?: number;
  details?: string;
  preparation_time?: number;
}

/** The order, in the shape this module needs. Deliberately not a Supabase row type. */
export interface AlShrouqOrderSource {
  /** As stored — with its leading `#`. See `client_order_id` below. */
  display_no: string | null | undefined;
  customer_name: string | null | undefined;
  customer_phone: string | null | undefined;
  /** The customer's Google Maps link. Never a street address. */
  alshrouq_map_url?: string | null;
  /** Supabase returns `numeric` as a string, so both are accepted. */
  alshrouq_lat?: number | string | null;
  alshrouq_lng?: number | string | null;
  alshrouq_payment_type?: number | string | null;
  invoice_value?: number | string | null;
  notes?: string | null;
}

/** Enough of a payment option to recognise one. Structural, so nothing server-only is imported. */
export interface AlShrouqPaymentOptionLike {
  id: number;
  label: string;
}

/**
 * The CRM's already-paid method, recognised by its published label.
 *
 * Anchored and whole-word: `AlshrouqPay` is a *different* method — the courier
 * collects through AlShrouq's own wallet — and matching it here would tell a
 * driver to collect nothing on a job where they must. No id is written down;
 * the label is what the CRM publishes and what an agent reads in the picker, so
 * the two cannot drift.
 */
const PAID_PAYMENT_LABEL = /^\s*paid\s*$/i;

/** The live ids whose label means the customer has already paid. */
export function paidPaymentTypeIds(
  options: readonly AlShrouqPaymentOptionLike[] | null | undefined,
): number[] {
  if (!options) return [];
  return options.filter((option) => PAID_PAYMENT_LABEL.test(option.label)).map((o) => o.id);
}

/**
 * Whether the chosen method is one of them.
 *
 * Takes the id as the form holds it — text — because that is what every caller
 * has. An unparseable or unchosen value is simply not paid.
 */
export function isPaidPaymentType(
  paymentType: number | string | null | undefined,
  options: readonly AlShrouqPaymentOptionLike[] | null | undefined,
): boolean {
  const id = numeric(paymentType);
  return id !== null && paidPaymentTypeIds(options).includes(id);
}

export interface AlShrouqBuildContext {
  /**
   * The branch's AlShrouq id, already resolved against the CRM's
   * `branch_options`. `null` means "not resolved yet", which is reported as its
   * own outcome rather than as a bad order — an uncovered branch is not the
   * agent having typed something wrong.
   */
  alshrouqBranchId: string | null | undefined;
  /** The CRM's live payment ids. No enum is kept in this repository. */
  paymentOptionIds: readonly number[];
  /**
   * Which of those ids mean the customer has already paid.
   *
   * Supplied by the caller from the same live `payment_options`, via
   * {@link paidPaymentTypeIds} — so this file still writes down no id and no
   * label, and a deployment that renames or renumbers the method needs no edit
   * here. Omitted means "nothing is known to be prepaid", which leaves
   * `order_value` exactly as it was.
   */
  paidPaymentTypeIds?: readonly number[];
  /** Minutes, when the caller has a value. Omitted from the payload otherwise. */
  preparationTime?: number | null;
}

export interface AlShrouqFieldError {
  field: string;
  message: string;
}

export type AlShrouqPayloadResult =
  | { ok: true; payload: AlShrouqCreatePayload }
  /** The order may be perfectly good; the branch simply has no AlShrouq id yet. */
  | { ok: false; reason: "branch_unresolved" }
  | { ok: false; reason: "invalid"; errors: AlShrouqFieldError[] };

/** Trimmed, or null. Blank and whitespace-only are the same thing: absent. */
function text(value: string | null | undefined): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

/**
 * A finite number, or null.
 *
 * Strings are accepted because Supabase hands back `numeric` columns as strings,
 * but only when they parse cleanly — `Number("")` is 0 and `Number("abc")` is
 * NaN, and neither is a value anybody typed. `0` passes, which is the whole
 * point for `order_value`.
 */
function numeric(value: number | string | null | undefined): number | null {
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (trimmed.length === 0) return null;
  const parsed = Number(trimmed);
  return Number.isFinite(parsed) ? parsed : null;
}

/**
 * Build the create payload, or say why it cannot be built.
 *
 * Never throws and never mutates its arguments. Every problem is returned, so a
 * caller can show an agent all of them at once rather than one per attempt.
 */
export function buildAlshrouqOrderPayload(
  order: AlShrouqOrderSource,
  context: AlShrouqBuildContext,
): AlShrouqPayloadResult {
  // Checked before the field rules: "AlShrouq does not cover this branch" is a
  // different conversation from "this order is missing a phone number", and
  // collapsing them into one error list would make the first unactionable.
  const branchId = text(context.alshrouqBranchId);
  if (!branchId) return { ok: false, reason: "branch_unresolved" };

  const errors: AlShrouqFieldError[] = [];
  const fail = (field: string, message: string) => errors.push({ field, message });

  /**
   * The order's number, bare.
   *
   * `display_no` is stored as `#9540`; `stripOrderPrefix` removes the leading
   * `#` (and a `CC-`/`TS-` if one is ever stored) and nothing else — which is
   * exactly what the CRM holds, right down to `"9396####"` keeping its trailing
   * hashes. The team prefix is a *display* rendering and must not go on the wire.
   */
  const rawDisplayNo = text(order.display_no);
  const clientOrderId = rawDisplayNo ? text(stripOrderPrefix(rawDisplayNo)) : null;
  if (!clientOrderId) fail("client_order_id", "The order has no order number.");

  const customerName = text(order.customer_name);
  if (!customerName) fail("customer_name", "The customer's name is required.");

  const customerPhone = text(order.customer_phone);
  if (!customerPhone) fail("customer_phone", "The customer's phone number is required.");

  // Membership against the CRM's own list. An unrecognised id is refused by
  // name — never quietly rewritten to COD, which would send a driver to collect
  // money from someone who has already paid.
  const paymentType = numeric(order.alshrouq_payment_type);
  if (paymentType === null) {
    fail("payment_type", "A payment method is required.");
  } else if (!context.paymentOptionIds.includes(paymentType)) {
    fail("payment_type", `The CRM does not offer payment method ${paymentType}.`);
  }

  /**
   * Required, and `0` passes.
   *
   * Absent is not the same as zero: every one of the 127 real records carries a
   * number, so the key is not optional on the wire, and defaulting a blank to 0
   * would invent a "collect nothing" instruction for a COD job. An explicit 0 is
   * a statement and is honoured.
   *
   * **Unless the method says the customer already paid.** `order_value` is what
   * the driver is told to collect at the door, not what the pharmacy invoiced —
   * the invoice stays on the order untouched. Sending the invoice figure on a
   * prepaid job is how somebody is asked to pay twice, so a paid method fixes it
   * at 0 and a blank invoice stops being a problem: there is nothing to collect,
   * which is a complete answer rather than a missing one.
   *
   * Decided here rather than in the two screens above it, because this is the
   * only place the wire value is built and a rule enforced anywhere else could
   * be bypassed by a request that did not come from those screens.
   */
  const paid = paymentType !== null && (context.paidPaymentTypeIds ?? []).includes(paymentType);
  const orderValue = paid ? 0 : numeric(order.invoice_value);
  if (orderValue === null) fail("order_value", "The order value is required.");

  /**
   * Both coordinates or neither — the same rule the `orders` table enforces with
   * `CHECK ((alshrouq_lat IS NULL) = (alshrouq_lng IS NULL))`. Absent is fine;
   * half a point is not, and nothing is manufactured to complete it.
   */
  const lat = numeric(order.alshrouq_lat);
  const lng = numeric(order.alshrouq_lng);
  if ((lat === null) !== (lng === null)) {
    fail("customer_lat", "A delivery location needs both a latitude and a longitude.");
  }

  if (errors.length > 0) return { ok: false, reason: "invalid", errors };

  const payload: AlShrouqCreatePayload = {
    branch_id: branchId,
    client_order_id: clientOrderId as string,
    customer_name: customerName as string,
    customer_phone: customerPhone as string,
    payment_type: paymentType as number,
    order_value: orderValue as number,
  };

  // Optional keys are added only when there is something to say.
  const mapUrl = text(order.alshrouq_map_url);
  if (mapUrl) payload.customer_address = mapUrl;
  if (lat !== null && lng !== null) {
    payload.customer_lat = lat;
    payload.customer_lng = lng;
  }
  const details = text(order.notes);
  if (details) payload.details = details;
  const preparationTime = numeric(context.preparationTime);
  if (preparationTime !== null) payload.preparation_time = preparationTime;

  return { ok: true, payload };
}
