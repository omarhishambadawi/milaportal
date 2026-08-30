import { Store, Truck } from "lucide-react";

import { cn } from "@/lib/utils";
import { classifyFulfillment } from "../fulfillment";

/**
 * How the order reached the customer, as one compact chip in the row.
 *
 * The fact was already on the order and already filterable, but the list did not
 * show it: an agent narrowing to Pickup could see *that* the list was narrowed
 * and never which side of the cut any single row was on. Reading `delivery_type`
 * through `classifyFulfillment` rather than testing the string here is the whole
 * point of that module — the badge, the filter, the KPI cards and the Dashboard
 * mix agree because there is one definition of "is this a delivery".
 *
 * ## Why the colour is on the icon and not the chip
 *
 * Delivery and pickup are *categories*, not states. The row already spends its
 * colour budget on things that need it — the status pill, the verification rail
 * — and a third coloured chip beside them turns a scan for "which of these
 * orders is cancelled" into a hunt. So the chip is neutral and the 12px glyph
 * carries the hue; icon contrast only has 3:1 to clear, which both tones do in
 * both themes, and the shape does most of the work anyway.
 *
 * ## Two callers, two widths
 *
 * In the **column** (`lg`–`xl`) there are 44px, so the label waits for `2xl`
 * where the column grows to 104. In the **meta line** under the customer — the
 * badge's home below `lg`, where the row is stacked rather than columnar — there
 * is room for the word and no header above it to explain the glyph, so `showLabel`
 * asks for it outright. The word reaches a screen reader either way.
 *
 * Truck and storefront are unmistakable at 12px in a way two abbreviations of
 * "delivery" and "pickup" would not be, which is what makes the narrow form
 * legible at all.
 */
export function FulfillmentBadge({
  deliveryType,
  showLabel = false,
}: {
  deliveryType: string | null | undefined;
  /** Show the word at every width, for the stacked row rather than the column. */
  showLabel?: boolean;
}) {
  const kind = classifyFulfillment(deliveryType);
  // The stored method — "AlShrouq", "Branch Scooter" — is what an agent chasing
  // a specific courier wants, and it is one hover away rather than a column.
  const method = deliveryType?.trim();

  // No method recorded is not a third category to badge — it is the absence of
  // one. A boxed chip around an icon meaning "nothing here" is heavier than the
  // two real answers beside it, so it degrades to the same em dash every other
  // empty cell on the row uses.
  if (!kind) {
    return (
      <span className="text-muted-foreground/60" title="No fulfillment method recorded">
        —
      </span>
    );
  }

  const Icon = kind === "delivery" ? Truck : Store;
  const label = kind === "delivery" ? "Delivery" : "Pickup";
  const tone = kind === "delivery" ? "text-chart-2" : "text-chart-3";

  return (
    <span
      title={method ? `${label} · ${method}` : label}
      className={cn(
        // Same geometry as `TeamBadge`, so the row's chips read as one family.
        "inline-flex max-w-full items-center gap-1 whitespace-nowrap rounded-md border px-1.5 py-0.5",
        "border-border/70 bg-muted/60 text-[10px] font-medium leading-none text-foreground/80",
      )}
    >
      <Icon className={cn("h-3 w-3 shrink-0", tone)} aria-hidden />
      <span className={cn("truncate", showLabel ? "inline" : "hidden 2xl:inline")}>{label}</span>
      {/* The word is always available to a screen reader, including in the
          narrow column form where the chip is the glyph alone. */}
      {!showLabel && <span className="sr-only 2xl:hidden">{label}</span>}
    </span>
  );
}
