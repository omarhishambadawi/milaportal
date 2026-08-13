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
 */

import { AlertTriangle, Bot, Clock3, PackageSearch, RefreshCw } from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { fmtSAR } from "@/lib/branches";
import { cn } from "@/lib/utils";
import { useBranchLabels, type BranchLabel } from "@/features/shams/hooks/use-shams-data";
import type { ItemAvailability, StockState } from "@/lib/shams/availability";
import type { OrderInvoice } from "../invoice-verification";
import type { OrderInvoicesResult } from "../hooks/use-order-invoices";

export function OrderInvoicePanel({ invoices }: { invoices: OrderInvoicesResult }) {
  const { data: branchLabels } = useBranchLabels();
  const { invoices: rows, verified, verifiedTotal, allVerified, isMulti, isLoading } = invoices;

  if (rows.length === 0) {
    return (
      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="flex items-center gap-2 text-sm font-semibold">
            <PackageSearch className="h-4 w-4 text-muted-foreground" /> Invoice information
          </CardTitle>
        </CardHeader>
        <CardContent className="pt-0 text-sm text-muted-foreground">
          No invoice number recorded on this order yet.
        </CardContent>
      </Card>
    );
  }

  return (
    <Card>
      <CardHeader className="flex flex-row flex-wrap items-center justify-between gap-x-4 gap-y-2 pb-3">
        <CardTitle className="flex items-center gap-2 text-sm font-semibold">
          <PackageSearch className="h-4 w-4 text-muted-foreground" /> Invoice information
          {isMulti && (
            <span className="rounded-full bg-muted px-1.5 py-0.5 text-[10px] font-medium tabular-nums text-muted-foreground">
              {verified.length}/{rows.length} verified
            </span>
          )}
        </CardTitle>
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
      </CardHeader>

      <CardContent className="space-y-3 pt-0">
        {/* The verified total, and how complete it is. Labelled "so far" while
            anything is outstanding, because a partial sum presented as the order
            value would be a figure nobody could reconcile. */}
        {verified.length > 0 && (
          <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1 rounded-lg border border-border/60 bg-muted/25 px-3 py-2">
            <span className="text-xs text-muted-foreground">
              {allVerified
                ? isMulti
                  ? `Verified total — ${verified.length} invoices`
                  : "Verified total"
                : `Verified so far — ${verified.length} of ${rows.length}`}
            </span>
            <span className="text-base font-semibold tabular-nums">{fmtSAR(verifiedTotal)}</span>
          </div>
        )}

        {isLoading && rows.length > 0 && verified.length === 0 && (
          <Skeleton className="h-16 w-full" />
        )}

        <div className="space-y-2">
          {rows.map((invoice) => (
            <InvoiceBlock key={invoice.key} invoice={invoice} labels={branchLabels} />
          ))}
        </div>
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
}: {
  invoice: OrderInvoice;
  labels: Map<string, BranchLabel> | undefined;
}) {
  const city = invoice.branchCode
    ? (labels?.get(invoice.branchCode)?.cityEnglish ??
      labels?.get(invoice.branchCode)?.city ??
      null)
    : null;

  return (
    <div className="rounded-lg border border-border/60 p-3">
      <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1.5">
        <span className="flex min-w-0 items-center gap-2">
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
        {invoice.total !== null && (
          <span className="text-sm font-semibold tabular-nums">{fmtSAR(invoice.total)}</span>
        )}
      </div>

      {invoice.state === "verified" && (
        <dl className="mt-2 grid gap-x-4 gap-y-1.5 sm:grid-cols-2">
          {/* The MIS customer label, verbatim and never truncated: the suffix
              that decides the Call Centre classification lives at its end, and
              Arabic account names are long. `Customer_Name` (falling back to
              `CusName`) is the field the MIS portal itself displays — the other
              customer-ish fields are dropped at the normalization boundary and
              never reach the browser. */}
          <Detail label="Customer">
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
        </dl>
      )}

      {invoice.state === "pending" && (
        <p className="mt-1.5 text-[11px] leading-snug text-muted-foreground">
          Not in Shams yet. An invoice can take an hour or two to appear after the order is taken —
          the order is fine, and this will attach itself once the document lands.
        </p>
      )}

      {invoice.state === "unavailable" && (
        <p className="mt-1.5 text-[11px] leading-snug text-muted-foreground">
          Shams could not be reached, so this invoice could not be checked. Nothing is wrong with
          the order; try again shortly.
        </p>
      )}

      {invoice.state === "verified" && invoice.items.length > 0 && (
        <ItemLines items={invoice.items} />
      )}
    </div>
  );
}

function Detail({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="min-w-0">
      <dt className="text-[10.5px] uppercase tracking-wide text-muted-foreground">{label}</dt>
      <dd className="mt-0.5 text-sm font-medium">{children}</dd>
    </div>
  );
}

function StateTag({ state }: { state: OrderInvoice["state"] }) {
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

function ItemLines({ items }: { items: ItemAvailability[] }) {
  return (
    <div className="mt-2.5">
      <p className="mb-1 text-[10.5px] uppercase tracking-wide text-muted-foreground">
        Items &amp; branch stock
      </p>
      <ul className="divide-y divide-border/40 border-t border-border/40">
        {items.map((item, i) => (
          <li
            key={`${item.itemCode}-${i}`}
            className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-0.5 py-1.5"
          >
            <span className="flex min-w-0 flex-1 items-baseline gap-2">
              <span className="truncate text-xs">{item.itemName || item.itemCode}</span>
              <span className="shrink-0 text-[10px] tabular-nums text-muted-foreground">
                &times;{item.invoiced}
              </span>
            </span>
            {item.state === "in_stock" ? (
              <span className="shrink-0 text-[11px] text-muted-foreground">
                <span className="font-semibold tabular-nums text-foreground">{item.quantity}</span>{" "}
                {STOCK_LABEL.in_stock}
              </span>
            ) : (
              <span
                className={cn(
                  "shrink-0 whitespace-nowrap rounded-full px-1.5 py-0.5 text-[10px] font-semibold",
                  item.state === "out_of_stock"
                    ? "bg-destructive/10 text-destructive"
                    : "bg-muted text-muted-foreground",
                )}
              >
                {STOCK_LABEL[item.state]}
              </span>
            )}
          </li>
        ))}
      </ul>
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
