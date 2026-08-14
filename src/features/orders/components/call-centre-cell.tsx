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
 *
 * ## And a fourth, which outranks them
 *
 * A cancelled order shows an **X**, whatever its invoices say. A green tick
 * beside a "Cancelled" pill is a contradiction an agent has to stop and resolve
 * — one glyph saying the invoice is good, one word saying the order is off —
 * and the order being cancelled is the fact that matters at a glance. The
 * Call Centre data underneath is untouched: `call_center_verified` still holds
 * whatever the MIS established, and the order page still shows it. This is a
 * display precedence, not a change of state.
 */

import { AlertTriangle, Check, Minus, X } from "lucide-react";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";

export type CallCentreState = "cancelled" | "pending" | "verified" | "walk_in";

/**
 * Read an order row's Call Centre position.
 *
 * Order-level by design: an order with one Call Centre invoice and one walk-in
 * invoice *is* a call-centre order, and `call_center_verified` already carries
 * that judgement from the server. The per-invoice channel stays visible on the
 * order page, where each document is listed separately.
 */
export function callCentreState(order: {
  status?: string | null;
  invoices_verified?: boolean | null;
  call_center_verified?: boolean | null;
}): CallCentreState {
  // First, and regardless of the invoice flags — a cancelled order is cancelled
  // whether or not its invoice was ever verified as a Call Centre document.
  if (order.status === "Cancelled") return "cancelled";
  if (order.call_center_verified) return "verified";
  return order.invoices_verified ? "walk_in" : "pending";
}

/**
 * The whole background for one row: the zebra base, plus a light-mode-only
 * warning tint.
 *
 * Returns the *complete* set rather than a tint to be added to something else,
 * because two `bg-*` utilities cannot coexist on one element — `cn`'s
 * tailwind-merge keeps the last and drops the other, so layering silently
 * removed the base and left the row transparent, which is a third background
 * rather than a uniform one.
 *
 * **Dark mode gets no tint at all.** Over a dark surface the same 9% destructive
 * read as a *status* colour rather than a faint flag: rows looked painted by
 * their state, which is exactly what a table of statuses must not do, and there
 * is no tint over that background subtle enough to be a whisper and still be
 * visible. So every dark row resolves to its zebra base and nothing else.
 *
 * Nothing is lost. The signal is the glyph and the 3px rail beside it, both
 * unchanged and both legible in either theme. Light mode keeps the tint —
 * over white it stays a whisper, and nobody complained about it.
 *
 * Cancelled is deliberately absent: a cancelled row is not a warning about its
 * invoice, and painting rows by status is the thing being removed.
 */
export function orderRowBackground(state: CallCentreState, zebra: boolean): string {
  const base = zebra ? "bg-muted/25" : "bg-background";
  if (state !== "walk_in") return base;
  // Light: the tint. Dark: explicitly back to the base, so the row matches
  // every other row in the table.
  return zebra
    ? "bg-destructive/[0.055] dark:bg-muted/25"
    : "bg-destructive/[0.055] dark:bg-background";
}

const COPY: Record<CallCentreState, { label: string; tip: string }> = {
  cancelled: {
    label: "Cancelled",
    tip: "This order was cancelled. Its invoice data is unchanged.",
  },
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
              (state === "walk_in" || state === "cancelled") &&
                "bg-destructive/15 text-destructive",
              state === "pending" && "text-muted-foreground/50",
            )}
            role="img"
            aria-label={label}
          >
            {state === "cancelled" && <X className="h-3.5 w-3.5" aria-hidden="true" />}
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
