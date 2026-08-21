import { createFileRoute } from "@tanstack/react-router";
import { OrderForm } from "@/features/orders/components/order-form";

/**
 * The order page.
 *
 * The AlShrouq section is no longer rendered here. It now lives inside the
 * form's contextual column beside the branch and invoice panels, so it can
 * reflect the live form state and appears on a new order as well as a saved
 * one — and so there is exactly one AlShrouq surface rather than a second card
 * stranded at the bottom of the page.
 */
export const Route = createFileRoute("/_app/orders/$id")({
  head: () => ({ meta: [{ title: "Edit Order" }] }),
  component: () => <OrderForm mode="edit" />,
});
