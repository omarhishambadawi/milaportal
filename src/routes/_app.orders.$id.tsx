import { createFileRoute } from "@tanstack/react-router";
import { OrderForm } from "@/features/orders/components/order-form";

export const Route = createFileRoute("/_app/orders/$id")({
  head: () => ({ meta: [{ title: "Edit Order" }] }),
  component: () => <OrderForm mode="edit" />,
});
