import { z } from "zod";

/** Validation schema for the order create/edit form. */
export const orderFormSchema = z.object({
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

  /* ---------------------------------------------------------------------- */
  /* Where the customer is, and how they pay — the AlShrouq half of an order */
  /* ---------------------------------------------------------------------- */
  /*
   * These four are **order data**, not dispatch data, and the columns for them
   * have existed on `orders` since the 20260820185447 migration:
   * `alshrouq_map_url`, `alshrouq_lat`, `alshrouq_lng`, `alshrouq_payment_type`.
   * Nothing ever wrote them. The values lived in `useAlShrouqOrder`'s own
   * `useState` and travelled only as far as the dispatch request, so an agent
   * who filled them in, saved, and reopened the order found the location, the
   * coordinates and the payment method gone — and was asked for them again.
   *
   * They are optional here for the reason that migration gives for putting no
   * CHECK on them: every AlShrouq order created before it has none and never
   * will, and a required rule would make those rows unsavable — including by the
   * invoice triggers that touch orders nobody is editing. "Required when the
   * method is AlShrouq" is enforced where it belongs, in
   * `alshrouqRequirements`, which gates the handover rather than the save.
   */

  /** The customer's own Google Maps link, as pasted or resolved. */
  alshrouq_map_url: z.string().trim().max(2048).optional().nullable(),
  /**
   * The delivery point.
   *
   * Bounded to real coordinates, and paired: `buildOrderPayload` sends both or
   * neither, which is what `orders_alshrouq_point_complete` requires.
   */
  alshrouq_lat: z.preprocess(
    (v) => (v === "" || v == null ? null : Number(v)),
    z.number().min(-90).max(90).nullable(),
  ),
  alshrouq_lng: z.preprocess(
    (v) => (v === "" || v == null ? null : Number(v)),
    z.number().min(-180).max(180).nullable(),
  ),
  /**
   * The CRM's numeric payment id. Not an enum: the list belongs to the CRM, and
   * `orders_alshrouq_payment_type_positive` only requires it to be positive.
   */
  alshrouq_payment_type: z.preprocess(
    (v) => (v === "" || v == null ? null : Number(v)),
    z.number().int().positive().nullable(),
  ),
});
