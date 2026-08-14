/**
 * The Orders list's Call Centre column: derived, read-only, three states.
 *
 * ## Why it is not a checkbox any more
 *
 * It used to be one an agent could tick. That made a claim the row cannot
 * support: the channel is a property of the *document*, decided by the MIS's
 * `-Call Centre` customer suffix and recorded on the invoice when it was
 * verified. A tick beside it could only agree or disagree with that, and since
 * `record_invoice_verification` re-derives the flag on every reconciliation, a
 * disagreeing tick would be silently overwritten — the worst of both.
 *
 * ## Three states, not two
 *
 * An unticked box used to mean two different things, and they want opposite
 * treatments on screen:
 *
 *   pending   the MIS has not answered for this order yet. Unremarkable — most
 *             orders are here for an hour or two after being taken — so it gets
 *             a muted dash and no row tint at all.
 *   verified  a verified invoice is a Call Centre document. The ordinary,
 *             expected outcome, so it gets a tick and nothing louder.
 *   walk-in   verified, and *none* of the invoices is a Call Centre document.
 *             This is the one worth noticing: the order was taken by the call
 *             centre but the invoice was not raised through it.
 *
 * `invoices_verified` is what separates the first from the third; without it
 * every un-checked order would look like a warning.
 */

import { AlertTriangle, Check, Minus } from "lucide-react";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";

export type CallCentreState = "pending" | "verified" | "walk_in";

/**
 * Read an order row's Call Centre position.
 *
 * Order-level by design: an order with one Call Centre invoice and one walk-in
 * invoice *is* a call-centre order, and `call_center_verified` already carries
 * that judgement from the server. The per-invoice channel stays visible on the
 * order page, where each document is listed separately.
 */
export function callCentreState(order: {
  invoices_verified?: boolean | null;
  call_center_verified?: boolean | null;
}): CallCentreState {
  if (order.call_center_verified) return "verified";
  return order.invoices_verified ? "walk_in" : "pending";
}

/** The very light row tint a walk-in invoice earns. Empty for everything else. */
export function callCentreRowTint(state: CallCentreState): string {
  // Deliberately only the warning case. The positive state used to tint the
  // whole row in brand teal, which on a full page of verified orders was most
  // of the table shouting at once; the tick carries it now.
  return state === "walk_in" ? "bg-destructive/[0.055] dark:bg-destructive/[0.09]" : "";
}

const COPY: Record<CallCentreState, { label: string; tip: string }> = {
  verified: {
    label: "Call Centre",
    tip: "Verified automatically from invoice data by MilaPortal.",
  },
  walk_in: {
    label: "Non Call Centre",
    tip: "Invoice verified, but this is not a Call Centre invoice.",
  },
  pending: {
    label: "Not verified yet",
    tip: "No invoice has been verified for this order yet.",
  },
};

export function CallCentreCell({ state }: { state: CallCentreState }) {
  const { label, tip } = COPY[state];

  return (
    // Provider per cell, matching `users-table.tsx`: Radix throws when a
    // `Tooltip` has none above it, and keeping it here means the cell works
    // wherever it is dropped rather than depending on its container.
    <TooltipProvider delayDuration={200}>
      <Tooltip>
        <TooltipTrigger asChild>
          {/* A span, not a button: there is nothing to press. The tooltip is the
              only interaction, and it explains rather than invites. */}
          <span
            className={cn(
              "inline-flex h-5 w-5 cursor-default items-center justify-center rounded-full",
              state === "verified" && "bg-success/15 text-success",
              state === "walk_in" && "bg-destructive/15 text-destructive",
              state === "pending" && "text-muted-foreground/50",
            )}
            role="img"
            aria-label={label}
          >
            {state === "verified" && <Check className="h-3.5 w-3.5" aria-hidden="true" />}
            {state === "walk_in" && <AlertTriangle className="h-3.5 w-3.5" aria-hidden="true" />}
            {state === "pending" && <Minus className="h-3 w-3" aria-hidden="true" />}
          </span>
        </TooltipTrigger>
        <TooltipContent side="right" className="max-w-56">
          <p className="font-medium">{label}</p>
          <p className="text-xs opacity-80">{tip}</p>
        </TooltipContent>
      </Tooltip>
    </TooltipProvider>
  );
}
