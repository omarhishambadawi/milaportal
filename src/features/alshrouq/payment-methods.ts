/**
 * AlShrouq payment methods — one place that turns an id into a name. Pure, no I/O.
 *
 * ## The problem this exists for
 *
 * `alshrouq_payment_type` is a CRM id: `1`, `2`, `3`. Every screen that showed
 * it did the same two lines inline —
 *
 *     const match = options.paymentOptions.find((p) => String(p.id) === stored);
 *     return match?.label ?? stored;
 *
 * — and that trailing `?? stored` is the bug. The live option list comes from
 * `GET /integrations/alshrouq/config`, so it is empty on the first render of
 * every page, empty for the whole session whenever the CRM cannot be reached,
 * and empty in any environment without CRM credentials. In all three the
 * fallback fires and an operations screen tells a person their delivery's
 * payment type is **3**.
 *
 * ## Why there is a written-down table here, and only here
 *
 * The live list is still the authority: {@link alshrouqPaymentLabel} consults it
 * first, and a deployment that renames a method or adds a fifth needs no edit
 * here. The table below is the *floor* — what to say when there is no list yet
 * rather than a bare integer.
 *
 * It is not invented. It is the mapping the PharmacyCRM Desktop build carries
 * for exactly the same purpose: `_load_local_alshrouq_mapping` builds
 * `payment_options` as `{'id': 1, 'label': 'Cash on Delivery (COD)'}`,
 * `{'id': 2, 'label': 'Span Machine'}`, `{'id': 3, 'label': 'Paid'}`,
 * `{'id': 4, 'label': 'AlshrouqPay'}` — read off the function's constants in the
 * disassembled PYZ, the same way the `value` vs `order_value` key was settled.
 * Production's `alshrouq_dispatches` carries ids 1, 2 and 3 and no others.
 *
 * **This is presentation only.** Nothing here reaches the wire: the payload
 * still sends `payment_type` as the CRM's own integer, chosen from the live
 * list, and {@link isPaidPaymentType} still decides the collect amount from the
 * live labels rather than from an id written down anywhere. Renaming a label
 * below changes what an agent reads and nothing else.
 */

import type { AlShrouqPaymentOptionLike } from "@/lib/shams-crm/alshrouq-payload";

/**
 * The CRM's methods as the Desktop build names them, for when the live list is
 * not there to ask.
 *
 * Frozen so a caller cannot edit the shared table, and exported as options
 * rather than as a bare map so it drops straight into anything already typed
 * against `payment_options`.
 */
export const ALSHROUQ_FALLBACK_PAYMENT_OPTIONS: readonly AlShrouqPaymentOptionLike[] =
  Object.freeze([
    Object.freeze({ id: 1, label: "Cash on Delivery (COD)" }),
    Object.freeze({ id: 2, label: "Span Machine" }),
    Object.freeze({ id: 3, label: "Paid" }),
    Object.freeze({ id: 4, label: "AlshrouqPay" }),
  ]) as readonly AlShrouqPaymentOptionLike[];

/** The id as a number, or null. Accepts the text every form and row holds. */
function id(value: number | string | null | undefined): number | null {
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (trimmed.length === 0) return null;
  const parsed = Number(trimmed);
  return Number.isFinite(parsed) ? parsed : null;
}

/**
 * What to call this payment method.
 *
 * Live list first, written-down table second, and a named last resort third —
 * `Payment method 7` rather than `7`, so an id this build has never heard of
 * still reads as an identifier and not as a quantity.
 *
 * Returns `null` only when there is genuinely no method: absent, blank, or
 * unparseable. A caller decides what to show for that, because "not chosen yet"
 * and "chosen" are different sentences on different screens.
 */
export function alshrouqPaymentLabel(
  paymentType: number | string | null | undefined,
  options?: readonly AlShrouqPaymentOptionLike[] | null,
): string | null {
  const numeric = id(paymentType);
  if (numeric === null) return null;

  const live = (options ?? []).find((option) => option.id === numeric);
  if (live?.label?.trim()) return live.label.trim();

  const known = ALSHROUQ_FALLBACK_PAYMENT_OPTIONS.find((option) => option.id === numeric);
  if (known) return known.label;

  return `Payment method ${numeric}`;
}

/**
 * The list a picker should offer.
 *
 * The live options when the CRM has answered — its list is the one the agent
 * must choose from, and offering a method this deployment does not have would
 * produce an order the payload builder then refuses by id.
 *
 * The fallback table only while that list is empty, which is the case that
 * matters for an order being *reopened*: a `Select` whose value matches none of
 * its items renders its placeholder, so a saved order with payment method 3 sat
 * there reading "How does the customer pay?" until the config request landed —
 * and forever if it never did.
 */
export function alshrouqPaymentOptions(
  options?: readonly AlShrouqPaymentOptionLike[] | null,
): readonly AlShrouqPaymentOptionLike[] {
  return options && options.length > 0 ? options : ALSHROUQ_FALLBACK_PAYMENT_OPTIONS;
}

/**
 * Which payment method this order actually has.
 *
 * ## The bug this is the fix for
 *
 * Reopening a dispatched AlShrouq order showed **no payment method**. Production
 * says why: of the AlShrouq orders that have been handed over, almost none carry
 * `orders.alshrouq_payment_type` — it is null — while their
 * `alshrouq_dispatches.payment_type` holds `3`. The two columns disagree because
 * only one of them is written by the handover.
 *
 * An agent on the order page picks the method and presses **Send to AlShrouq**.
 * That approval builds a dispatch request straight from form state and freezes
 * `payment_type` onto the dispatch row; the *order's* column is only written by
 * `buildOrderPayload`, which runs when somebody presses **Update order**. Nobody
 * does, because the delivery has just been arranged and the order looks done. So
 * the method reached AlShrouq, was recorded against the delivery, and was never
 * recorded against the order — and the next person to open it was asked for it
 * again.
 *
 * ## The order of the three sources
 *
 * 1. **The form.** What the agent has on screen wins outright, so changing the
 *    method still works and a fresh choice is never overruled by an older fact.
 * 2. **The order's own column.** The ordinary persisted answer.
 * 3. **The live dispatch row.** What AlShrouq was actually told. Last, and it is
 *    the entry that repairs the orders above: it is a fact about this order that
 *    the order itself failed to record, not a guess.
 *
 * This is not a frontend default. Every source is persisted; when all three are
 * empty the result is empty, and the field is asked for as it always was.
 */
export function resolveAlShrouqPaymentType(
  formValue: string | null | undefined,
  orderValue: number | string | null | undefined,
  dispatchValue?: number | string | null | undefined,
): string {
  const first = (value: number | string | null | undefined): string => {
    if (typeof value === "number") return Number.isFinite(value) ? String(value) : "";
    return typeof value === "string" && value.trim() !== "" ? value.trim() : "";
  };
  return first(formValue) || first(orderValue) || first(dispatchValue);
}
