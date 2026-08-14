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
});
