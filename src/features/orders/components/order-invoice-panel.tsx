/**
 * Invoice information — an order's invoices in Shams, and the branch stock behind them.
 *
 * ## The rule this panel is built around
 *
 * A document does not appear in the MIS when the order is taken. It can land an
 * hour or two later. So "not found" is rendered as **Pending**, in plain words,
 * with the reason — never as an error, a failure, or a reason to doubt the
 * order. The order is valid without an invoice, and when the document does
 * appear the panel picks it up on the next open and records it against the
 * existing order. Nothing has to be recreated and nothing polls.
 *
 * ## The order's branch is a lead, not an answer
 *
 * `orders.branch_no` is what an agent picked while taking the call; nothing
 * guarantees the invoice was raised there. It is used as the *first place to
 * look* — one request — and a branch is reported as the invoice's only because
 * Shams returned the document for it. Where the order names no branch, there is
 * nowhere cheap to look and the invoice simply stays pending: discovering it
 * would mean sweeping all 137 branches, which is not something a page does on
 * open.
 *
 * ## One order, many invoices
 *
 * Always a collection. A single invoice renders as one plain block rather than a
 * list of one, but nothing here holds "the" invoice, and the verified total is
 * the sum of the distinct verified documents — never the first one found.
 *
 * ## Why each invoice folds
 *
 * The panel lives in the form's right-hand column now, beside the fields rather
 * than a page-scroll below them, and an order with four invoices and their item
 * lines is taller than the column. So each document is a compact header —
 * number, state, total, customer — that opens onto the rest. The customer stays
 * in the *closed* row deliberately: it is the fact an agent checks most often,
 * and putting it behind a click would be trading the panel's whole purpose for
 * vertical space.
 */

import { useState } from "react";
import { AlertTriangle, Bot, ChevronDown, Clock3, PackageSearch, RefreshCw } from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import { Skeleton } from "@/components/ui/skeleton";
import { CURRENCY, fmtSAR } from "@/lib/branches";
import { cn } from "@/lib/utils";
import { useBranchLabels, type BranchLabel } from "@/features/shams/hooks/use-shams-data";
import type { ItemAvailability, StockState } from "@/lib/shams/availability";
import type { OrderInvoice } from "../invoice-verification";
import type { OrderInvoicesResult } from "../hooks/use-order-invoices";

/**
 * Every document starts open.
 *
 * It used to fold past two invoices, back when this column had its own capped,
 * scrolling box and height was scarce. It no longer does — the column is part of
 * the page scroll — and the items are the reason an agent opens this panel at
 * all: a pharmacist checking what is on an invoice should not have to click
 * anything first. The fold is still there for tidying a four-invoice order by
 * hand, it just is not the starting state.
 */
const STARTS_OPEN = true;

export function OrderInvoicePanel({ invoices }: { invoices: OrderInvoicesResult }) {
  const { data: branchLabels } = useBranchLabels();
  const { invoices: rows, verified, verifiedTotal, allVerified, isMulti, isLoading } = invoices;

  return (
    <Card className="overflow-hidden shadow-sm">
      <CardHeader className="flex flex-row flex-wrap items-center justify-between gap-x-4 gap-y-2 border-b border-border/60 bg-muted/25 px-4 py-3 dark:bg-muted/10">
        <CardTitle className="flex items-center gap-2 text-sm font-semibold">
          <PackageSearch className="h-4 w-4 text-muted-foreground" /> Invoice information
          {isMulti && (
            <span className="rounded-full bg-background px-1.5 py-0.5 text-[10px] font-medium tabular-nums text-muted-foreground ring-1 ring-inset ring-border">
              {verified.length}/{rows.length} verified
            </span>
          )}
        </CardTitle>
        {rows.length > 0 && (
          <Button
            type="button"
            variant="ghost"
            size="sm"
            className="h-7 px-2 text-xs"
            onClick={invoices.refresh}
            disabled={invoices.isFetching}
          >
            <RefreshCw className={cn("mr-1.5 h-3 w-3", invoices.isFetching && "animate-spin")} />
            Check again
          </Button>
        )}
      </CardHeader>

      <CardContent className="space-y-2.5 p-4">
        {rows.length === 0 ? (
          <p className="text-xs text-muted-foreground">
            No invoice number on this order yet. Add one on the left and the portal will look it up.
          </p>
        ) : (
          <>
            {/* The verified total, and how complete it is. Labelled "so far"
                while anything is outstanding, because a partial sum presented as
                the order value would be a figure nobody could reconcile. */}
            {verified.length > 0 && (
              <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1 rounded-lg border border-success/25 bg-success/5 px-3 py-2">
                <span className="text-xs font-medium text-muted-foreground">
                  {allVerified
                    ? isMulti
                      ? `Verified total — ${verified.length} invoices`
                      : "Verified total"
                    : `Verified so far — ${verified.length} of ${rows.length}`}
                </span>
                <span className="text-base font-semibold tabular-nums">
                  {fmtSAR(verifiedTotal)}
                </span>
              </div>
            )}

            {/* The order could not be brought into line with what was verified.
                Said out loud rather than swallowed: a silent failure here is
                precisely what left a verified invoice sitting beside an order
                value of 0.00 with nothing on screen to explain it. */}
            {invoices.syncError && (
              <p className="flex flex-wrap items-center gap-x-2 gap-y-1 rounded-lg border border-destructive/30 bg-destructive/5 px-3 py-2 text-[11px] leading-snug text-muted-foreground">
                <AlertTriangle
                  className="h-3.5 w-3.5 shrink-0 text-destructive"
                  aria-hidden="true"
                />
                <span className="min-w-0 flex-1">
                  The invoice was verified, but the order value could not be updated.
                </span>
                <button
                  type="button"
                  onClick={invoices.retrySync}
                  disabled={invoices.isRecording}
                  className="font-medium text-primary underline-offset-2 hover:underline"
                >
                  {invoices.isRecording ? "Retrying…" : "Retry"}
                </button>
              </p>
            )}

            {isLoading && verified.length === 0 && <Skeleton className="h-14 w-full" />}

            {rows.map((invoice) => (
              <InvoiceBlock
                key={invoice.key}
                invoice={invoice}
                labels={branchLabels}
                defaultOpen={STARTS_OPEN}
              />
            ))}
          </>
        )}
      </CardContent>
    </Card>
  );
}

/* -------------------------------------------------------------------------- */
/* One invoice                                                                 */
/* -------------------------------------------------------------------------- */

function InvoiceBlock({
  invoice,
  labels,
  defaultOpen,
}: {
  invoice: OrderInvoice;
  labels: Map<string, BranchLabel> | undefined;
  defaultOpen: boolean;
}) {
  const [open, setOpen] = useState(defaultOpen);
  const city = invoice.branchCode
    ? (labels?.get(invoice.branchCode)?.cityEnglish ??
      labels?.get(invoice.branchCode)?.city ??
      null)
    : null;

  return (
    <Collapsible
      open={open}
      onOpenChange={setOpen}
      className={cn(
        "rounded-lg border",
        invoice.state === "verified" ? "border-border/70" : "border-border/50 bg-muted/15",
      )}
    >
      <CollapsibleTrigger className="flex w-full items-center gap-2 px-3 py-2 text-left">
        <span className="flex min-w-0 flex-1 flex-col gap-0.5">
          <span className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1">
            <span className="font-mono text-sm font-semibold" dir="ltr">
              #{invoice.invoiceNo}
            </span>
            <StateTag state={invoice.state} />
            {invoice.cancelled && (
              <span className="rounded-full bg-destructive/10 px-1.5 py-0.5 text-[10px] font-semibold text-destructive">
                Cancelled
              </span>
            )}
          </span>
          {/* The customer stays visible with the document closed — it is the
              fact most often checked and the one the channel is derived from. */}
          {invoice.state === "verified" && invoice.customer && (
            <span className="truncate text-[11px] leading-tight text-muted-foreground" dir="auto">
              {invoice.customer}
            </span>
          )}
        </span>
        {invoice.total !== null && (
          <span className="shrink-0 text-sm font-semibold tabular-nums">
            {fmtSAR(invoice.total)}
          </span>
        )}
        <ChevronDown
          aria-hidden="true"
          className={cn(
            "h-4 w-4 shrink-0 text-muted-foreground transition-transform",
            open && "rotate-180",
          )}
        />
      </CollapsibleTrigger>

      <CollapsibleContent className="border-t border-border/50 px-3 py-2.5">
        {invoice.state === "verified" && (
          <dl className="grid gap-x-4 gap-y-2 sm:grid-cols-2">
            {/* The MIS customer label, verbatim and never truncated: the suffix
                that decides the Call Centre classification lives at its end, and
                Arabic account names are long. `Customer_Name` (falling back to
                `CusName`) is the field the MIS portal itself displays — the other
                customer-ish fields are dropped at the normalization boundary and
                never reach the browser. */}
            <Detail label="Customer" className="sm:col-span-2">
              {invoice.customer ? (
                <span className="break-words" dir="auto">
                  {invoice.customer}
                </span>
              ) : (
                <span className="text-muted-foreground">Not provided by MIS</span>
              )}
            </Detail>
            <Detail label="Branch">
              {invoice.branchCode ? (
                <span className="flex items-baseline gap-1.5">
                  <span className="font-mono">{invoice.branchCode}</span>
                  {city && (
                    <span className="truncate text-xs text-muted-foreground" dir="auto">
                      {city}
                    </span>
                  )}
                </span>
              ) : (
                <span className="text-muted-foreground">—</span>
              )}
            </Detail>
            <Detail label="Channel">
              <span
                className={cn(
                  "inline-flex rounded-full px-1.5 py-0.5 text-[10px] font-semibold",
                  invoice.isCallCentre
                    ? "bg-success/10 text-success"
                    : "bg-destructive/10 text-destructive",
                )}
              >
                {invoice.isCallCentre ? "Call Centre" : "Non Call Centre"}
              </span>
            </Detail>
            <Detail label="Document date">{formatDocDate(invoice.docDate)}</Detail>
            {/* Who established this. Never an agent: the portal asked Shams and
                Shams answered, and the timeline records it the same way. */}
            <Detail label="Verified by">
              <span className="inline-flex items-center gap-1">
                <Bot className="h-3.5 w-3.5 text-success" aria-hidden="true" />
                MilaPortal
              </span>
            </Detail>
          </dl>
        )}

        {invoice.state === "pending" && (
          <p className="text-[11px] leading-snug text-muted-foreground">
            Not in Shams yet. An invoice can take an hour or two to appear after the order is taken
            — the order is fine, and this will attach itself once the document lands.
          </p>
        )}

        {invoice.state === "unavailable" && (
          <p className="text-[11px] leading-snug text-muted-foreground">
            Shams could not be reached, so this invoice could not be checked. Nothing is wrong with
            the order; try again shortly.
          </p>
        )}

        {invoice.state === "verified" && invoice.items.length > 0 && (
          <ItemLines items={invoice.items} />
        )}
      </CollapsibleContent>
    </Collapsible>
  );
}

function Detail({
  label,
  className,
  children,
}: {
  label: string;
  className?: string;
  children: React.ReactNode;
}) {
  return (
    <div className={cn("min-w-0", className)}>
      <dt className="text-[10.5px] uppercase tracking-wide text-muted-foreground">{label}</dt>
      <dd className="mt-0.5 text-sm font-medium">{children}</dd>
    </div>
  );
}

export function StateTag({ state }: { state: OrderInvoice["state"] }) {
  if (state === "verified") {
    return (
      <span className="inline-flex items-center gap-1 rounded-full bg-success/10 px-1.5 py-0.5 text-[10px] font-semibold text-success">
        <Bot className="h-3 w-3" aria-hidden="true" />
        Verified
      </span>
    );
  }
  if (state === "unavailable") {
    return (
      <span className="inline-flex items-center gap-1 rounded-full bg-muted px-1.5 py-0.5 text-[10px] font-semibold text-muted-foreground">
        <AlertTriangle className="h-3 w-3" aria-hidden="true" />
        Unavailable
      </span>
    );
  }
  // Deliberately neutral, not destructive: pending is the expected state for a
  // fresh order and must not read as something the agent got wrong.
  return (
    <span className="inline-flex items-center gap-1 rounded-full bg-muted px-1.5 py-0.5 text-[10px] font-semibold text-muted-foreground">
      <Clock3 className="h-3 w-3" aria-hidden="true" />
      Pending
    </span>
  );
}

/* -------------------------------------------------------------------------- */
/* Branch stock for the invoice's lines                                        */
/* -------------------------------------------------------------------------- */

const STOCK_LABEL: Record<StockState, string> = {
  in_stock: "in stock",
  out_of_stock: "Out of stock",
  not_found: "Not in catalogue",
  unknown: "Stock unavailable",
};

/**
 * The invoice's lines, and what the branch still holds of each.
 *
 * A real three-column table rather than the flex row this replaces, because
 * these are medications and the previous layout made them the hardest thing on
 * the page to read: the name was `truncate`d to whatever space the quantity and
 * stock badge left over, so `MOUNJARO KWIKPEN 5 MG/0.6ML` and
 * `MOUNJARO KWIKPEN 7.5 MG/0.6ML` — different products, different prices —
 * rendered identically as `MOUNJARO KWIKPEN 5 MG/0.6…`. Two products that look
 * the same on screen is a dispensing error waiting to happen.
 *
 * So the name column wraps instead of truncating, and everything else gets a
 * fixed column that lines up down the list. The full name is on `title` as
 * well, for the pathological ones.
 *
 * ## What a line now says
 *
 * Product, code, quantity, unit price, line total, stock. The money was there
 * all along — `Rate`, `Amt` and `Item_NetAmt` come back on every sales line —
 * and was simply dropped at the availability boundary, so an agent could see
 * that a branch held four of something without being able to see what the
 * customer paid for it. `ItemAvailability` carries it now; nothing new is
 * fetched.
 *
 * The code sits *under* the name rather than in its own column. At this width
 * six columns would leave the product — the one field that is genuinely long
 * and genuinely ambiguous between similar medications — with the least space of
 * anything on the row, which is the trade this whole table exists to avoid.
 */
function ItemLines({ items }: { items: ItemAvailability[] }) {
  /** True when the MIS priced any line here; an unpriced document loses the columns. */
  const priced = items.some((i) => i.lineTotal !== null || i.unitRate !== null);

  return (
    <div className="mt-3">
      <table className="w-full table-fixed border-collapse text-left">
        <caption className="sr-only">Invoice items, prices and branch stock</caption>
        <thead>
          <tr className="border-b border-border/60 text-[10px] uppercase tracking-wide text-muted-foreground">
            {/* No width on the product column: `table-fixed` gives it whatever
                the fixed ones leave, which is the largest share and the point. */}
            <th scope="col" className="pb-1 pr-2 font-medium">
              Product
            </th>
            <th scope="col" className="w-10 pb-1 pr-2 text-right font-medium">
              Qty
            </th>
            {priced && (
              <>
                {/* Columns from `sm` up; on a phone they fold into the product
                    cell instead. Six fixed columns cannot fit a 295px table
                    without either overflowing the page sideways or crushing the
                    product name, and both are worse than one extra line. */}
                {/* The unit lives in the header, once, instead of on every
                    cell: repeating " SAR" down two columns costs ~34px each,
                    and on this page that comes straight out of the product name
                    beside it. */}
                <th
                  scope="col"
                  className="hidden w-[3.75rem] pb-1 pr-2 text-right font-medium sm:table-cell"
                >
                  Unit <span className="font-normal">({CURRENCY})</span>
                </th>
                <th
                  scope="col"
                  className="hidden w-[4.25rem] pb-1 pr-2 text-right font-medium sm:table-cell"
                >
                  Total <span className="font-normal">({CURRENCY})</span>
                </th>
              </>
            )}
            <th scope="col" className="w-24 pb-1 text-right font-medium">
              Stock
            </th>
          </tr>
        </thead>
        <tbody className="divide-y divide-border/40">
          {items.map((item, i) => (
            <tr key={`${item.itemCode}-${i}`} className="align-top">
              <td className="py-1.5 pr-2">
                {/* Wrapping, not truncating — see above. `break-words` so a long
                    unbroken code cannot widen the column either. */}
                <span
                  className="block break-words text-xs leading-snug"
                  title={item.itemName || item.itemCode}
                >
                  {item.itemName || item.itemCode}
                </span>
                {item.itemCode && item.itemName && (
                  <span className="mt-0.5 block font-mono text-[10px] leading-none text-muted-foreground">
                    {item.itemCode}
                  </span>
                )}
                {/* The phone's version of the two money columns. Same values,
                    same formatter — only the placement changes. */}
                {priced && (item.unitRate !== null || item.lineTotal !== null) && (
                  <span className="mt-1 block text-[10.5px] leading-none tabular-nums text-muted-foreground sm:hidden">
                    {item.unitRate === null ? "—" : fmtSAR(item.unitRate, { exact: true })}
                    {" · "}
                    <span className="font-medium text-foreground">
                      {item.lineTotal === null ? "—" : fmtSAR(item.lineTotal, { exact: true })}
                    </span>
                  </span>
                )}
              </td>
              <td className="py-1.5 pr-2 text-right text-xs tabular-nums text-muted-foreground">
                &times;{item.invoiced}
              </td>
              {priced && (
                <>
                  <td className="hidden py-1.5 pr-2 text-right text-xs tabular-nums text-muted-foreground sm:table-cell">
                    {/* `exact` so a column of figures shares one shape: 45.00
                        above 167.50, not 45 above 167.5. A line the document
                        priced at nothing shows a dash — never a made-up 0.00. */}
                    {item.unitRate === null
                      ? "—"
                      : fmtSAR(item.unitRate, { exact: true, bare: true })}
                  </td>
                  <td className="hidden py-1.5 pr-2 text-right text-xs font-medium tabular-nums sm:table-cell">
                    {item.lineTotal === null
                      ? "—"
                      : fmtSAR(item.lineTotal, { exact: true, bare: true })}
                  </td>
                </>
              )}
              <td className="py-1.5 text-right">
                {item.state === "in_stock" ? (
                  <span className="whitespace-nowrap text-[11px] text-muted-foreground">
                    <span className="font-semibold tabular-nums text-foreground">
                      {item.quantity}
                    </span>{" "}
                    {STOCK_LABEL.in_stock}
                  </span>
                ) : (
                  <span
                    className={cn(
                      "inline-block whitespace-nowrap rounded-full px-1.5 py-0.5 text-[10px] font-semibold",
                      item.state === "out_of_stock"
                        ? "bg-destructive/10 text-destructive"
                        : "bg-muted text-muted-foreground",
                    )}
                  >
                    {STOCK_LABEL[item.state]}
                  </span>
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/**
 * `"2026-08-13T00:00:00"` → `"13 Aug 2026"`.
 *
 * By string, not through `Date`: the API supplies no timezone, so parsing to an
 * instant and reformatting would shift a midnight document onto the day before.
 */
function formatDocDate(value: string | null): string {
  if (!value) return "—";
  const match = /^(\d{4})-(\d{2})-(\d{2})/.exec(value);
  if (!match) return value;
  const MONTHS = [
    "Jan",
    "Feb",
    "Mar",
    "Apr",
    "May",
    "Jun",
    "Jul",
    "Aug",
    "Sep",
    "Oct",
    "Nov",
    "Dec",
  ];
  return `${Number(match[3])} ${MONTHS[Number(match[2]) - 1] ?? match[2]} ${match[1]}`;
}
