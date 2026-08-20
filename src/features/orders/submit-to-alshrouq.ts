import { toast } from "sonner";
import { ALSHROUQ } from "@/lib/branches";
import { alshrouqAutoSubmit } from "@/lib/alshrouq.functions";

/**
 * Hand a just-saved order to AlShrouq.
 *
 * The whole point of the integration: an agent picks AlShrouq, fills in the
 * delivery fields, saves — and the courier order exists. Nobody opens AlShrouq's
 * dashboard to retype it.
 *
 * ## Never fatal, deliberately
 *
 * Modelled on `recordInvoiceVerification`, which runs at the same point in the
 * same handler for the same reason. The order is saved and valid whether or not
 * the courier leg completed, so a failure here is a warning and a timeline
 * entry, never a rolled-back save or an error that implies the order was lost.
 * The dispatch panel on the order offers the retry.
 *
 * ## Why it is safe to call on every save
 *
 * `alshrouqAutoSubmit` returns the existing delivery when one is already live,
 * so re-saving an order that has been dispatched does not send a second courier.
 * Editing a five-month-old AlShrouq order does not dispatch it either: it has no
 * location and no payment method, so it fails validation server-side and is
 * refused before anything is sent. Historical orders stay exactly as they are.
 */
export async function submitToAlShrouq(
  orderId: string,
  deliveryType: string | null | undefined,
): Promise<void> {
  if (deliveryType !== ALSHROUQ) return;
  try {
    const result = await alshrouqAutoSubmit({ data: { orderId } });
    if (result.ok) {
      const reference = result.dispatch.externalOrderId ?? result.dispatch.localId;
      toast.success(reference ? `Sent to AlShrouq — reference ${reference}` : "Sent to AlShrouq");
    } else {
      toast.warning(`Order saved, but AlShrouq did not accept it: ${result.message}`);
    }
  } catch (error: any) {
    // The server function itself failed to run — a network drop between the
    // browser and the Portal, not between the Portal and the courier. Whether
    // the delivery was created is unknown from here, so this says so rather
    // than inviting a retry that the server would in any case de-duplicate.
    toast.warning(
      error?.message
        ? `Order saved. The AlShrouq submission could not be confirmed: ${error.message}`
        : "Order saved. The AlShrouq submission could not be confirmed — open the order to check.",
    );
  }
}
