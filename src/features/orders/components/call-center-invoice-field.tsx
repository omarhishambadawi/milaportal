/**
 * Call Center Invoice — the flag, and where it came from.
 *
 * The control exists on the form at all because the flag is now mostly *not* a
 * decision anybody makes: a verified document whose MIS customer carries the
 * `-Call Centre` channel suffix ticks it through `record_invoice_verification`,
 * and the agent's job is to see that it happened, not to do it. So the three
 * states are stated in words rather than left to a bare checkbox:
 *
 *   automated   the portal ticked it, and says so, naming the invoice;
 *   manual      somebody ticked it, and it stays ticked;
 *   pending     nothing verified yet — which is the ordinary state of an order
 *               whose invoice has not appeared in the MIS, and must not read as
 *               something the agent forgot.
 *
 * The box is still operable by anyone holding the verification permission, in
 * both directions, because a document can be raised outside the call centre and
 * still belong to it. What the box must never do is claim an automated result
 * for a person, which is why the automated state is labelled rather than merely
 * checked.
 */

import { Bot, Clock3, PhoneCall } from "lucide-react";
import { Checkbox } from "@/components/ui/checkbox";
import { FORM_FIELD } from "@/lib/panel";
import { cn } from "@/lib/utils";

export function CallCenterInvoiceField({
  checked,
  automated,
  invoiceNos,
  hasVerified,
  canVerify,
  disabled,
  onChange,
}: {
  checked: boolean;
  /** True when a verified Call Centre document is what set this. */
  automated: boolean;
  /** The call-centre invoices behind an automated tick, for the caption. */
  invoiceNos: string[];
  /** Whether anything on the order has been verified at all. */
  hasVerified: boolean;
  canVerify: boolean;
  disabled?: boolean;
  onChange: (next: boolean) => void;
}) {
  const caption = automated
    ? invoiceNos.length > 0
      ? `Automated by MilaPortal — invoice ${invoiceNos.map((n) => `#${n}`).join(", ")}`
      : "Automated by MilaPortal"
    : checked
      ? "Marked manually."
      : hasVerified
        ? "The verified invoice is not a Call Centre document."
        : "Not verified yet. This is set automatically when a Call Centre invoice is verified.";

  /*
   * No box.
   *
   * This was a tinted, bordered panel whose colour carried the state — green for
   * automated, brand for manual, grey otherwise. That put a card around a single
   * checkbox, inside a card, inside a column of cards, and made one tickbox the
   * heaviest object in the Assignment section by a distance.
   *
   * Nothing is lost: the state was never actually *in* the border. It is in the
   * caption, which names the invoice, and in the icon beside it — a success
   * `Bot` when the portal did it, a clock while nothing has been verified — and
   * both survive. The separator above it, in the form, is what says this is its
   * own concern rather than a third assignment field.
   */
  return (
    <div className="flex items-start gap-3">
      <Checkbox
        id="call-center-verified"
        checked={checked}
        disabled={disabled || !canVerify}
        onCheckedChange={(v) => onChange(!!v)}
        className="mt-0.5"
      />
      <div className="min-w-0 flex-1">
        <label
          htmlFor="call-center-verified"
          className={cn(FORM_FIELD.label, canVerify && !disabled && "cursor-pointer")}
        >
          <PhoneCall className="h-3.5 w-3.5 shrink-0 text-muted-foreground" aria-hidden="true" />
          Call Center Invoice
        </label>
        <p className="mt-1 flex items-start gap-1 text-[11px] leading-snug text-muted-foreground">
          {automated ? (
            <Bot className="mt-px h-3 w-3 shrink-0 text-success" aria-hidden="true" />
          ) : !checked && !hasVerified ? (
            <Clock3 className="mt-px h-3 w-3 shrink-0" aria-hidden="true" />
          ) : null}
          <span className="min-w-0">{caption}</span>
        </p>
      </div>
    </div>
  );
}
