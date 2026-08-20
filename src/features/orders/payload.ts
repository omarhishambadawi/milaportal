/**
 * What actually gets written when an order is saved. Pure, no I/O.
 *
 * ## Why this is not just `{...form}`
 *
 * Editing an order and changing only its value failed validation with
 * `delivery_type: "Delivery / pickup method is required"` — on orders that have
 * a delivery method, every one of the 4344 rows in the database having a
 * non-empty one. The field was not missing in the database, it was missing from
 * the form state at the moment of submit.
 *
 * That can happen for more than one reason — a save attempted before the fetch
 * resolved, or a stale `setForm({...form})` closure captured on an earlier
 * render writing back over a field hydrated since — and chasing each one
 * individually leaves the class of bug open. So the rule here is about the
 * *shape* of an update rather than any single field:
 *
 *   **a required field that is blank in the form is never a user's intention.**
 *
 * The UI cannot produce one. `delivery_type`, `order_type` and `team` are
 * `Select`s with no empty option; `branch_no` is a picker with no clear button;
 * `order_date` is a required date input. A blank arriving at submit is a
 * hydration failure by definition, so for an existing order the persisted value
 * is used instead. Nothing is invented — the fallback is the row itself — and a
 * new order has nothing to fall back to and still fails validation, correctly.
 *
 * The optional fields deliberately do **not** work that way. Clearing a
 * customer name, a phone, a note or an invoice number is a legitimate edit, so
 * blank means blank and is sent as null. Falling those back would make them
 * impossible to clear, which is the mirror-image bug.
 */

import { authoritativeValue, type InvoiceSummary } from "./invoice-verification";

/** The form's own state, as the order form holds it. */
export interface OrderFormState {
  order_date: string;
  team: string;
  order_type: string;
  customer_name: string;
  customer_phone: string;
  branch_no: string | null;
  delivery_type: string;
  invoice_value: string;
  notes: string;
  status: string;
  agent_id: string;
  call_center_verified: boolean;
  /** Google Maps link to the customer, as pasted or as the map picker built it. */
  alshrouq_map_url: string;
  /** Held as text, like `invoice_value`, because that is what an input yields. */
  alshrouq_lat: string;
  alshrouq_lng: string;
  /** The CRM's numeric payment id, as the select yields it. */
  alshrouq_payment_type: string;
}

/** The persisted row, as far as this cares about it. */
export interface PersistedOrder {
  order_date?: string | null;
  team?: string | null;
  order_type?: string | null;
  branch_no?: string | null;
  delivery_type?: string | null;
  status?: string | null;
}

export interface BuildOrderPayloadArgs {
  mode: "create" | "edit";
  form: OrderFormState;
  /** The invoice numbers as typed, already joined; empty when there are none. */
  invoiceNo: string;
  /** The order as stored. Undefined while creating, or before the fetch lands. */
  persisted: PersistedOrder | null | undefined;
  /** The Shams position, which decides whether the typed value survives. */
  invoices: InvoiceSummary;
  /** May this caller name the assignee? */
  canAssign: boolean;
  /** May this caller tick Call Center Invoice by hand? */
  canVerify: boolean;
}

/**
 * The required fields, and the only ones the persisted row backs up.
 *
 * Named rather than inferred from the schema so the list is a decision someone
 * made and can be read: these are the fields the UI has no way of emptying.
 */
const REQUIRED_FROM_ROW = [
  "order_date",
  "team",
  "order_type",
  "branch_no",
  "delivery_type",
  "status",
] as const;

/** Blank-safe read: `""`, whitespace and null all count as absent. */
function present(value: unknown): string | null {
  return typeof value === "string" && value.trim() !== "" ? value : null;
}

/**
 * Build the object handed to `orderFormSchema.parse`.
 *
 * Every field the order has is present in the result — dropping one while
 * fixing another is precisely the failure mode this replaces, so the shape is
 * fixed and exhaustive rather than assembled conditionally.
 */
export function buildOrderPayload({
  mode,
  form,
  invoiceNo,
  persisted,
  invoices,
  canAssign,
  canVerify,
}: BuildOrderPayloadArgs): Record<string, unknown> {
  /** Form value, or the stored one when the form's is blank and one exists. */
  const required = (field: (typeof REQUIRED_FROM_ROW)[number]): string => {
    const typed = present(form[field as keyof OrderFormState]);
    if (typed !== null) return typed;
    // Only an existing order has anything to fall back to. A new one keeps the
    // blank and fails validation, which is the correct answer there.
    return present(persisted?.[field]) ?? "";
  };

  return {
    order_date: required("order_date"),
    team: required("team"),
    order_type: required("order_type"),
    branch_no: required("branch_no"),
    delivery_type: required("delivery_type"),
    // A new order is always Pending; an edit keeps whatever it holds.
    status: mode === "create" ? "Pending" : required("status"),

    // Optional, and blank means blank: these are clearable by design.
    customer_name: form.customer_name || null,
    customer_phone: form.customer_phone || null,
    notes: form.notes || null,
    invoice_no: invoiceNo || null,

    /**
     * The customer's location.
     *
     * Optional in the same sense as the fields above — blank means blank — even
     * though the schema requires it for AlShrouq. The two are not in conflict:
     * validation decides whether a blank may be *saved*, this decides what a
     * blank *means*, and it means cleared.
     *
     * Kept rather than nulled when the method changes away from AlShrouq. A
     * location is not wrong on a pickup order, only unused, and discarding it
     * would lose the customer's address the moment an agent corrected a
     * mis-picked method — then require re-entry to correct it back.
     */
    alshrouq_map_url: form.alshrouq_map_url || null,
    alshrouq_lat: form.alshrouq_lat || null,
    alshrouq_lng: form.alshrouq_lng || null,
    alshrouq_payment_type: form.alshrouq_payment_type ? Number(form.alshrouq_payment_type) : null,

    /**
     * The verified total wins over anything typed.
     *
     * Applied at the point of writing, not only in the box, so a manual figure
     * entered before the invoice was checked cannot go back over a verified
     * one. With nothing verified the typed value is kept untouched — an invoice
     * may still be an hour away.
     */
    invoice_value: authoritativeValue(
      invoices,
      form.invoice_value === "" ? null : Number(form.invoice_value),
    ),

    /**
     * Sent on create (the order needs an owner) and on edit only when this
     * caller may reassign; everyone else's update leaves `agent_id` out rather
     * than writing back the value it happens to be holding.
     */
    agent_id:
      mode === "create"
        ? form.agent_id || undefined
        : canAssign && form.agent_id
          ? form.agent_id
          : undefined,

    /**
     * The manual tick only, and never a `false` that could untick what the
     * portal set.
     *
     * Deliberately not raised to `true` from a verified call-centre invoice:
     * that transition belongs to `record_invoice_verification`, which writes
     * the automated timeline event beside it. Doing it here would set the flag
     * through the ordinary edit path and file a machine decision under whoever
     * pressed Save.
     */
    call_center_verified:
      canVerify && (form.call_center_verified || !invoices.callCentreVerified)
        ? form.call_center_verified
        : undefined,
  };
}
