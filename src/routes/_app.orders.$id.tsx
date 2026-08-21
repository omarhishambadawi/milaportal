import { createFileRoute } from "@tanstack/react-router";
import { OrderForm } from "@/features/orders/components/order-form";
import { AlShrouqDispatchCard } from "@/features/alshrouq/components/dispatch-card";

/**
 * The order page: the form, and — for an AlShrouq order — the dispatch card
 * beneath it.
 *
 * The card is deliberately a *sibling* of `OrderForm` rather than something
 * inside it. It shares no state with the form, cannot touch `orderFormSchema`
 * or the save path, and renders nothing at all unless the order's delivery
 * method is AlShrouq. That separation is the point: the previous integration
 * reached into the form and broke saving.
 */
export const Route = createFileRoute("/_app/orders/$id")({
  head: () => ({ meta: [{ title: "Edit Order" }] }),
  component: () => (
    <>
      <OrderForm mode="edit" />
      <AlShrouqDispatchCard />
    </>
  ),
});
