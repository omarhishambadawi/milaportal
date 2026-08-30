import { Store, Truck } from "lucide-react";

import { cn } from "@/lib/utils";
import { classifyFulfillment } from "../fulfillment";

/**
 * How the order reached the customer, as one small chip in the row.
 *
 * `delivery_type` records the *method* — "AlShrouq", "Azman", "Branch Scooter",
 * "Store Pickup" — and `classifyFulfillment` is the one definition of which side
 * of the delivery/pickup cut a method falls on. Reading it rather than testing
 * the string here is the whole point of that module: the badge, the Delivery &
 * Pickup filter, the KPI RPC and the Dashboard mix all answer from it, so they
 * cannot come to disagree about what a delivery is.
 *
 * Geometry is `TeamBadge`'s, class for class, because that is the row's existing
 * small-badge pattern and two shapes for the same kind of thing is how a table
 * stops looking designed. Neutral chip with a coloured 12px glyph rather than a
 * coloured chip: the row already spends its colour on the status pill and the
 * verification rail, and the truck/storefront pair carries the distinction on
 * its own. The stored method is on `title`, for an agent chasing one courier.
 *
 * An order with no method recorded renders nothing at all. A third badge saying
 * "unknown" would add a row of chips to the table for the absence of a fact.
 */
export function FulfillmentBadge({ deliveryType }: { deliveryType: string | null | undefined }) {
  const kind = classifyFulfillment(deliveryType);
  if (!kind) return null;

  const Icon = kind === "delivery" ? Truck : Store;
  const label = kind === "delivery" ? "Delivery" : "Pickup";
  const method = deliveryType?.trim();

  return (
    <span
      title={method && method !== label ? `${label} · ${method}` : label}
      className={cn(
        "inline-flex shrink-0 items-center gap-1 whitespace-nowrap rounded-md border",
        "border-border bg-muted/60 px-1.5 py-0.5 text-[10px] font-medium leading-none",
        "text-foreground/80",
      )}
    >
      <Icon
        aria-hidden
        className={cn("h-3 w-3 shrink-0", kind === "delivery" ? "text-chart-2" : "text-chart-3")}
      />
      {label}
    </span>
  );
}
