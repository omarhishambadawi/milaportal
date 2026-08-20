import { z } from "zod";
import { ALSHROUQ } from "@/lib/branches";
import { KSA_BOUNDS } from "@/lib/geo";

/** Validation schema for the order create/edit form. */
export const orderFormSchema = z
  .object({
    order_date: z.string().min(1),
    team: z.enum(["customer_care", "telesales"]),
    order_type: z.string().min(1, "Order type is required"),
    customer_name: z.string().trim().max(120).optional().nullable(),
    customer_phone: z.string().trim().max(40).optional().nullable(),
    branch_no: z.string().min(1, "Branch number is required"),
    delivery_type: z.string().min(1, "Delivery / pickup method is required"),
    invoice_no: z.string().max(50).optional().nullable(),
    invoice_value: z.preprocess(
      (v) => (v === "" || v == null ? null : Number(v)),
      z.number().nonnegative().nullable(),
    ),
    notes: z.string().max(500).optional().nullable(),
    status: z.string().min(1),
    /**
     * Who the order belongs to.
     *
     * Optional because only the assignment control sets it, and only in edit mode:
     * on insert, RLS requires `auth.uid() = agent_id`, so a new order is always
     * the creator's. `prevent_order_reassignment` is what allows it to move later,
     * and only for callers holding `edit_all_orders`.
     */
    agent_id: z.string().uuid().optional(),
    /**
     * Call Center Invoice.
     *
     * Optional, and left out entirely rather than sent as `false` whenever the
     * caller may not verify or the portal has already established the flag from a
     * verified call-centre invoice — an omitted column keeps whatever the row
     * holds, which is what stops a save unticking an automated verification.
     */
    call_center_verified: z.boolean().optional(),

    /* ---- Where an AlShrouq delivery goes ---- */

    /**
     * The customer's location, as three fields rather than an address.
     *
     * Only AlShrouq orders carry one, and only ones created since the delivery
     * location was added — hence nullable here, with the requirement expressed
     * conditionally below rather than as `.min(1)`. Editing a five-month-old
     * pickup order must not start failing because it has no coordinates.
     *
     * The bounds are `KSA_BOUNDS`, the same check `parseCoordinatePair` applies,
     * so a location cannot enter through the form under looser rules than one
     * read out of a pasted link.
     */
    alshrouq_map_url: z.string().trim().max(2000).optional().nullable(),
    alshrouq_lat: z.preprocess(
      (v) => (v === "" || v == null ? null : Number(v)),
      z.number().min(KSA_BOUNDS.south).max(KSA_BOUNDS.north).nullable(),
    ),
    alshrouq_lng: z.preprocess(
      (v) => (v === "" || v == null ? null : Number(v)),
      z.number().min(KSA_BOUNDS.west).max(KSA_BOUNDS.east).nullable(),
    ),
    /**
     * How the customer pays the driver.
     *
     * The CRM's own numeric id, not a label and not an enum of ours: the list
     * comes from `GET /integrations/alshrouq/config` (1 COD, 2 SPAN Machine,
     * 3 Paid, 4 AlshrouqPay today) and belongs to the CRM. Validated only as
     * "a positive integer" here so that a method AlShrouq adds next month works
     * without a Portal release.
     */
    alshrouq_payment_type: z.preprocess(
      (v) => (v === "" || v == null ? null : Number(v)),
      z.number().int().positive().nullable(),
    ),
  })
  /**
   * What AlShrouq needs, required only when AlShrouq is the method.
   *
   * A courier API cannot be handed a nameless, unreachable order with no
   * destination, so these three become mandatory the moment an agent picks
   * AlShrouq — and stay optional for Store Pickup, Azman and Branch Scooter,
   * which are still arranged by a person and whose forms do not change.
   *
   * Expressed here rather than as a database CHECK because it is a rule about
   * what an agent must type today, not a fact about every row ever stored; see
   * the migration for why the two must not be the same thing.
   */
  .superRefine((value, ctx) => {
    if (value.delivery_type !== ALSHROUQ) return;

    const require = (path: string, ok: boolean, message: string) => {
      if (!ok) ctx.addIssue({ code: z.ZodIssueCode.custom, path: [path], message });
    };

    const hasName = Boolean(value.customer_name?.trim());
    const hasPhone = Boolean(value.customer_phone?.trim());
    // One issue on `alshrouq_lat` rather than one on each: the form shows a
    // single location control, so two errors would point at one field twice.
    const hasPoint = value.alshrouq_lat != null && value.alshrouq_lng != null;
    const hasPayment = value.alshrouq_payment_type != null;

    require("customer_name", hasName, "AlShrouq needs a customer name");
    require("customer_phone", hasPhone, "AlShrouq needs a customer phone number");
    require("alshrouq_lat", hasPoint, "AlShrouq needs the delivery location");
    require("alshrouq_payment_type", hasPayment, "AlShrouq needs a payment method");
  });
