/**
 * An order's invoices in Shams, and what the issuing branch still holds.
 *
 * This is the Order → Invoice → Branch → Stock chain on the order itself:
 * `orders.invoice_no` carries the numbers, Shams says where each one actually
 * lives, the document carries its item lines, and `product/stock` says what that
 * branch has of them now.
 *
 * ## The order's branch is a lead, not an answer
 *
 * `orders.branch_no` is the branch an agent picked while taking the call. Nothing
 * guarantees it is where the invoice was raised — an order can be moved, split or
 * mis-keyed — so it is never *equated* with the invoice's branch. It is used as
 * the first place to look, which is a different thing: one `sales/details` call
 * asks that branch directly, and the branch is reported as the invoice's only
 * because Shams returned the document for it. When it does not, the panel says so
 * and offers the authoritative chain-wide sweep rather than guessing.
 *
 * That ordering is the whole performance story. Discovery is a sweep of all 137
 * branches; checking one costs a single request, and it is right most of the
 * time. So the cheap, usually-correct question is asked on open, and the
 * expensive, always-correct one is one click away.
 *
 * ## Saved numbers only
 *
 * Driven by what is stored on the order, never by the invoice inputs above it.
 * Looking up a half-typed number is the per-keystroke traffic the Invoices tab
 * exists to avoid, and an unsaved edit is not yet a fact about the order.
 */

import { useState } from "react";
import { Building2, Loader2, PackageSearch, Search } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { fmtSAR } from "@/lib/branches";
import { cn } from "@/lib/utils";
import { failureMessage } from "@/features/shams/constants";
import {
  useBranchLabels,
  useInvoiceBranches,
  useInvoiceStock,
  type BranchLabel,
} from "@/features/shams/hooks/use-shams-data";
import { parseInvoiceNumbers } from "@/features/orders/utils";
import type { ItemAvailability, StockState } from "@/lib/shams/availability";
import type { InvoiceBranchMatch } from "@/lib/shams/types";

export function OrderInvoicePanel({
  invoiceNo,
  orderBranchNo,
}: {
  invoiceNo: string | null | undefined;
  orderBranchNo: string | null | undefined;
}) {
  const numbers = parseInvoiceNumbers(invoiceNo);
  const { data: branchLabels } = useBranchLabels();

  if (numbers.length === 0) return null;

  return (
    <div className="min-w-0 space-y-2 md:col-span-2">
      <div className="flex items-center gap-1.5">
        <PackageSearch className="h-3.5 w-3.5 text-muted-foreground" aria-hidden="true" />
        <h3 className="text-xs font-medium">In Shams</h3>
        <span className="text-[11px] font-normal text-muted-foreground/80">
          &mdash; where each invoice was raised, and what that branch holds now
        </span>
      </div>
      {numbers.map((docNo) => (
        <InvoiceRow
          key={docNo}
          docNo={docNo}
          orderBranchNo={orderBranchNo?.trim() || null}
          labels={branchLabels}
        />
      ))}
    </div>
  );
}

/* -------------------------------------------------------------------------- */
/* One invoice number                                                          */
/* -------------------------------------------------------------------------- */

function InvoiceRow({
  docNo,
  orderBranchNo,
  labels,
}: {
  docNo: string;
  orderBranchNo: string | null;
  labels: Map<string, BranchLabel> | undefined;
}) {
  /**
   * The branch being shown. Null until something confirms one — either the
   * order's branch answering, or the agent picking from a sweep. It is never
   * seeded from the order.
   */
  const [chosen, setChosen] = useState<string | null>(null);
  /** Whether the agent has asked for the chain-wide sweep. */
  const [sweeping, setSweeping] = useState(false);

  // The cheap first question: does the order's own branch hold this document?
  // Skipped entirely when the order names no branch.
  const atOrderBranch = useInvoiceStock(
    orderBranchNo && !chosen ? { branchCode: orderBranchNo, docNo } : null,
  );
  const picked = useInvoiceStock(chosen ? { branchCode: chosen, docNo } : null);

  const active = chosen ? picked : atOrderBranch;
  const result = active.data;
  const branchCode = chosen ?? orderBranchNo;

  const notConfigured = result?.configured === false;
  const failed = active.isError || (result && result.configured && !result.ok);
  const missingHere = Boolean(result?.ok && !result.invoice);

  return (
    <div className="rounded-lg border border-border/60 bg-muted/20 p-3">
      <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1.5">
        <span className="flex min-w-0 items-center gap-2">
          <span className="font-mono text-sm font-semibold" dir="ltr">
            {docNo}
          </span>
          {result?.invoice && branchCode && (
            <BranchTag code={branchCode} labels={labels} confirmed />
          )}
        </span>
        {result?.invoice && (
          <span className="flex shrink-0 items-center gap-2">
            <CallCentreTag isCallCentre={result.invoice.isCallCentre} />
            <span className="text-sm font-semibold tabular-nums">
              {fmtSAR(result.invoice.grandTotal)}
            </span>
          </span>
        )}
      </div>

      {active.isFetching && !result && <Skeleton className="mt-2 h-8 w-full" />}

      {notConfigured && (
        <p className="mt-1.5 text-[11px] text-muted-foreground">
          Shams MIS is not configured for this deployment.
        </p>
      )}

      {failed && (
        <p className="mt-1.5 text-[11px] text-muted-foreground">
          {failureMessage(result?.error?.kind)}{" "}
          <button
            type="button"
            onClick={() => active.refetch()}
            className="font-medium text-primary underline-offset-2 hover:underline"
          >
            Retry
          </button>
        </p>
      )}

      {/* The lead did not pay off: the branch on the order does not hold this
          number. Said plainly, because it is a real discrepancy worth an
          agent's attention and not a loading state. The sweep is the
          authoritative answer, and it is one click away rather than automatic —
          it asks all 137 branches. */}
      {missingHere && !chosen && !sweeping && (
        <p className="mt-1.5 flex flex-wrap items-center gap-x-2 gap-y-1 text-[11px] text-muted-foreground">
          <span>Not at {branchCode}, the branch on this order.</span>
          <button
            type="button"
            onClick={() => setSweeping(true)}
            className="inline-flex items-center gap-1 font-medium text-primary underline-offset-2 hover:underline"
          >
            <Search className="h-3 w-3" aria-hidden="true" />
            Search all branches
          </button>
        </p>
      )}

      {/* The branch the sweep offered no longer answers for the document — its
          five-minute window lapsed between the choice and the read. */}
      {missingHere && chosen && (
        <p className="mt-1.5 text-[11px] text-muted-foreground">
          {chosen} no longer returns this document.{" "}
          <button
            type="button"
            onClick={() => active.refetch()}
            className="font-medium text-primary underline-offset-2 hover:underline"
          >
            Retry
          </button>
        </p>
      )}

      {!orderBranchNo && !chosen && !sweeping && (
        <p className="mt-1.5 flex flex-wrap items-center gap-x-2 gap-y-1 text-[11px] text-muted-foreground">
          <span>This order names no branch, so there is nowhere to check first.</span>
          <button
            type="button"
            onClick={() => setSweeping(true)}
            className="inline-flex items-center gap-1 font-medium text-primary underline-offset-2 hover:underline"
          >
            <Search className="h-3 w-3" aria-hidden="true" />
            Search all branches
          </button>
        </p>
      )}

      {sweeping && !chosen && <BranchSweep docNo={docNo} labels={labels} onChoose={setChosen} />}

      {result?.invoice && <ItemTable items={result.items} skipped={result.stockSkipped} />}
    </div>
  );
}

/* -------------------------------------------------------------------------- */
/* Chain-wide discovery, on request                                            */
/* -------------------------------------------------------------------------- */

/**
 * The authoritative answer: every branch that holds this number.
 *
 * Reuses the Invoices tab's own hook, so it is the same four-part parallel
 * sweep against the same server-side cache — an agent who looked this number up
 * there pays nothing for it here, and the document it finds is already in
 * `sweptDocuments` when the branch below is picked.
 */
function BranchSweep({
  docNo,
  labels,
  onChoose,
}: {
  docNo: string;
  labels: Map<string, BranchLabel> | undefined;
  onChoose: (branchCode: string) => void;
}) {
  const discovery = useInvoiceBranches(docNo);
  const matches = discovery.matches;

  return (
    <div className="mt-2 space-y-1.5">
      <p className="flex items-center gap-1.5 text-[11px] text-muted-foreground">
        {!discovery.done && <Loader2 className="h-3 w-3 animate-spin" aria-hidden="true" />}
        {discovery.done
          ? `Found in ${matches.length} ${matches.length === 1 ? "branch" : "branches"}.`
          : "Searching every Shams branch…"}
      </p>

      {discovery.failed && (
        <p className="text-[11px] text-muted-foreground">{failureMessage(discovery.error?.kind)}</p>
      )}

      {discovery.done && matches.length === 0 && !discovery.failed && (
        <p className="text-[11px] text-muted-foreground">No branch holds this document number.</p>
      )}

      {/* Every match, always — a number can legitimately exist in several
          branches and mean several different sales. */}
      {matches.map((match: InvoiceBranchMatch) => (
        <button
          key={match.branchCode}
          type="button"
          onClick={() => onChoose(match.branchCode)}
          className={cn(
            "flex w-full flex-wrap items-center justify-between gap-x-3 gap-y-1 rounded-md border border-border/60 px-2.5 py-2 text-left transition-colors hover:bg-muted/60",
            match.isCallCentre && "border-l-2 border-l-success bg-success/5",
          )}
        >
          <span className="flex min-w-0 items-center gap-2">
            <Building2 className="h-3.5 w-3.5 shrink-0 text-muted-foreground" aria-hidden="true" />
            <BranchTag code={match.branchCode} labels={labels} />
          </span>
          <span className="flex shrink-0 items-center gap-2">
            <CallCentreTag isCallCentre={match.isCallCentre} />
            <span className="text-xs font-semibold tabular-nums">{fmtSAR(match.grandTotal)}</span>
          </span>
        </button>
      ))}
    </div>
  );
}

/* -------------------------------------------------------------------------- */
/* Item lines and their availability                                           */
/* -------------------------------------------------------------------------- */

/**
 * Copy and tone per state.
 *
 * Four entries rather than a number and a blank, because "none left" and "we
 * could not find out" are different facts and showing either as `0` would tell
 * an agent something false. Only the disqualifying answer is loud.
 */
const STOCK_LABEL: Record<StockState, string> = {
  in_stock: "in stock",
  out_of_stock: "Out of stock",
  not_found: "Not in catalogue",
  unknown: "Stock unavailable",
};

function ItemTable({ items, skipped }: { items: ItemAvailability[]; skipped: boolean }) {
  if (items.length === 0) {
    return (
      <p className="mt-2 text-[11px] text-muted-foreground">
        This document returned no item lines.
      </p>
    );
  }

  return (
    <ul className="mt-2 divide-y divide-border/40 border-t border-border/40">
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
          {skipped ? (
            <span className="shrink-0 text-[11px] text-muted-foreground">—</span>
          ) : item.state === "in_stock" ? (
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
  );
}

/* -------------------------------------------------------------------------- */
/* Small shared bits                                                           */
/* -------------------------------------------------------------------------- */

/** A branch code with whatever the portal knows it is called. */
function BranchTag({
  code,
  labels,
  confirmed,
}: {
  code: string;
  labels: Map<string, BranchLabel> | undefined;
  confirmed?: boolean;
}) {
  const label = labels?.get(code);
  const city = label?.cityEnglish ?? label?.city ?? null;
  return (
    <span className="flex min-w-0 items-baseline gap-1.5">
      <span
        className="font-mono text-xs font-medium"
        // Stated rather than implied: this branch is where Shams returned the
        // document, which is not necessarily the branch on the order.
        title={confirmed ? "Where Shams holds this invoice" : undefined}
      >
        {code}
      </span>
      {city && (
        <span className="truncate text-[11px] text-muted-foreground" dir="auto">
          {city}
        </span>
      )}
    </span>
  );
}

function CallCentreTag({ isCallCentre }: { isCallCentre: boolean }) {
  return (
    <span
      className={cn(
        "whitespace-nowrap rounded-full px-1.5 py-0.5 text-[10px] font-semibold",
        isCallCentre ? "bg-success/10 text-success" : "bg-destructive/10 text-destructive",
      )}
    >
      {isCallCentre ? "Call Centre" : "Non Call Centre"}
    </span>
  );
}
