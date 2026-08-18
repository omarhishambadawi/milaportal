import { createFileRoute } from "@tanstack/react-router";
import { OrderForm } from "@/features/orders/components/order-form";

export const Route = createFileRoute("/_app/orders/new")({
  head: () => ({ meta: [{ title: "New Order" }] }),
  component: () => <OrderForm mode="create" />,
});
