import { parseInvoiceNumbers } from "../utils";

/**
 * Every invoice number on the order, one per line.
 *
 * An order can carry several invoices, and the cell used to show the first with
 * a "+2" pill standing in for the rest — which meant the numbers agents
 * reconcile against all afternoon were the one thing the row would not tell
 * them. They are all rendered now; the column is sized for a six-digit number,
 * so a second or third invoice grows the row's height rather than its width and
 * the table's horizontal scroll is unchanged.
 *
 * There is deliberately no copy affordance here (there was one, mirroring
 * `CopyableOrderNo`). Invoice numbers are copied continuously as part of the
 * workflow, and a button that appears under the cursor on every row of a list
 * that is scrolled all day is noise on the one column read most often.
 */
export function InvoiceCell({ value }: { value: string | null | undefined }) {
  if (!value) return <span className="text-muted-foreground font-sans">—</span>;

  const parts = parseInvoiceNumbers(value);
  if (parts.length === 0) return <span className="text-muted-foreground font-sans">—</span>;

  return (
    <span className="flex flex-col items-start gap-0.5 min-w-0 leading-tight">
      {parts.map((invoice, i) => (
        <span key={`${invoice}-${i}`} className="block max-w-full truncate" title={invoice}>
          {invoice}
        </span>
      ))}
    </span>
  );
}
