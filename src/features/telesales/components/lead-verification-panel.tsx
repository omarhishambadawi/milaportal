import {
  AlertTriangle,
  CheckCircle2,
  HelpCircle,
  Loader2,
  PackageCheck,
  PackageX,
  RefreshCw,
  XCircle,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { cn } from "@/lib/utils";
import { fmtSAR } from "@/lib/branches";
import type { StockState } from "@/lib/shams/availability";
import {
  DISCREPANCY_LABELS,
  MATCH_STATUS_LABELS,
  type InvoiceMatchStatus,
  type InvoiceVerification,
} from "@/lib/telesales/reconciliation";
import type {
  LeadStockResult,
  VerificationState,
} from "@/features/telesales/hooks/use-lead-verification";

/**
 * Did this lead become a real sale, and can we still fulfil it?
 *
 * Two questions on one card, because an agent asks them together: an invoice
 * that matched means the customer already bought, and stock at the branch means
 * a lead that has not converted still can.
 *
 * Both halves come from the Shams MIS through the same server functions the
 * `/shams` Invoices and Stock tabs use, so the card is labelled as such.
 */

const STATUS_STYLES: Record<InvoiceMatchStatus, string> = {
  matched: "bg-[#10B981]/15 text-[#047857] border-[#10B981]/40 dark:text-emerald-200",
  not_matched: "bg-[#EF4444]/15 text-[#B91C1C] border-[#EF4444]/40 dark:text-red-200",
  ambiguous: "bg-[#F59E0B]/15 text-[#B45309] border-[#F59E0B]/40 dark:text-amber-200",
  not_checked: "bg-muted text-muted-foreground border-border",
};

const STATUS_ICON: Record<InvoiceMatchStatus, typeof CheckCircle2> = {
  matched: CheckCircle2,
  not_matched: XCircle,
  ambiguous: AlertTriangle,
  not_checked: HelpCircle,
};

const STOCK_STYLES: Record<StockState, string> = {
  in_stock: "bg-[#10B981]/15 text-[#047857] border-[#10B981]/40 dark:text-emerald-200",
  out_of_stock: "bg-[#EF4444]/15 text-[#B91C1C] border-[#EF4444]/40 dark:text-red-200",
  not_found: "bg-muted text-muted-foreground border-border",
  unknown: "bg-muted text-muted-foreground border-border",
};

/**
 * Agent-facing stock wording.
 *
 * `not_found` and `unknown` are kept apart even though both mean "no number to
 * show". The MIS answering "no such item" and the MIS not mentioning this
 * branch are different facts, and an agent deciding whether to promise a
 * customer a product should know which one they are looking at.
 */
const STOCK_LABELS: Record<StockState, string> = {
  in_stock: "In stock",
  out_of_stock: "Out of stock",
  not_found: "Not in the Shams catalogue",
  unknown: "Stock unknown",
};

/** `2026-07-30` → `30 Jul 2026`, without constructing an instant. */
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
function day(value: string | null | undefined): string {
  if (!value) return "—";
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  return m ? `${Number(m[3])} ${MONTHS[Number(m[2]) - 1]} ${m[1]}` : value;
}

export interface LeadVerificationPanelProps {
  invoiceState: VerificationState;
  verification: InvoiceVerification | null;
  onRetryInvoice: () => void;
  stockState: VerificationState;
  stock: LeadStockResult | null;
  onRetryStock: () => void;
}

export function LeadVerificationPanel({
  invoiceState,
  verification,
  onRetryInvoice,
  stockState,
  stock,
  onRetryStock,
}: LeadVerificationPanelProps) {
  return (
    <Card>
      <CardHeader className="pb-3">
        <div className="flex flex-wrap items-center gap-2">
          <CardTitle className="text-base">Verification &amp; availability</CardTitle>
          <span className="text-xs text-muted-foreground">from Shams MIS</span>
        </div>
      </CardHeader>
      <CardContent className="space-y-4">
        <InvoiceSection state={invoiceState} verification={verification} onRetry={onRetryInvoice} />
        <StockSection state={stockState} stock={stock} onRetry={onRetryStock} />
      </CardContent>
    </Card>
  );
}

function Unavailable({
  what,
  state,
  onRetry,
}: {
  what: string;
  state: Extract<VerificationState, "unavailable" | "forbidden">;
  onRetry: () => void;
}) {
  return (
    <div className="rounded-md border border-[#F59E0B]/40 bg-[#F59E0B]/10 p-3">
      <p className="flex items-center gap-1.5 text-sm font-medium text-[#B45309] dark:text-amber-200">
        <AlertTriangle className="h-4 w-4" />
        {state === "forbidden"
          ? `You do not have access to Shams MIS ${what}`
          : `Shams MIS is currently unavailable`}
      </p>
      <p className="mt-1 text-xs text-muted-foreground">
        {state === "forbidden"
          ? "This is granted separately from Telesales. Ask an administrator for Shams MIS access."
          : `${what} could not be checked. This does not mean the lead is unverified — try again, or continue without it.`}
      </p>
      {state === "unavailable" ? (
        <Button className="mt-2" size="sm" variant="outline" onClick={onRetry}>
          <RefreshCw className="mr-1.5 h-4 w-4" />
          Retry
        </Button>
      ) : null}
    </div>
  );
}

function InvoiceSection({
  state,
  verification,
  onRetry,
}: {
  state: VerificationState;
  verification: InvoiceVerification | null;
  onRetry: () => void;
}) {
  if (state === "loading") {
    return (
      <p className="flex items-center gap-2 text-sm text-muted-foreground">
        <Loader2 className="h-4 w-4 animate-spin" />
        Checking the invoice…
      </p>
    );
  }
  if (state === "unavailable" || state === "forbidden") {
    return <Unavailable what="invoices" state={state} onRetry={onRetry} />;
  }
  if (!verification) return null;

  const Icon = STATUS_ICON[verification.status];

  return (
    <div>
      <div className="flex flex-wrap items-center gap-2">
        <span
          className={cn(
            "inline-flex items-center gap-1.5 rounded-full border px-2 py-0.5 text-[11px] font-medium",
            STATUS_STYLES[verification.status],
          )}
        >
          <Icon className="h-3.5 w-3.5" />
          {MATCH_STATUS_LABELS[verification.status]}
        </span>
      </div>
      <p className="mt-1.5 text-sm text-muted-foreground">{verification.reason}</p>

      {verification.invoice ? (
        <div className="mt-2 grid grid-cols-2 gap-x-6 gap-y-2 rounded-md border border-border p-3 text-sm sm:grid-cols-4">
          <Field label="Invoice">
            <span className="font-mono text-xs">{verification.invoice.docNo}</span>
          </Field>
          <Field label="Date">{day(verification.invoice.docDay)}</Field>
          <Field label="Branch">{verification.invoice.branchCode ?? "—"}</Field>
          <Field label="Total">{fmtSAR(verification.invoice.grandTotal)}</Field>
          <Field label="Product on invoice">
            {verification.matchedLine?.itemName ?? (
              <span className="text-muted-foreground">not this lead&apos;s product</span>
            )}
          </Field>
          <Field label="Quantity">{verification.matchedLine?.quantity ?? "—"}</Field>
          <Field label="Customer account">
            <span className="text-xs">{verification.invoice.customer ?? "—"}</span>
          </Field>
          <Field label="Lines">{verification.invoice.itemCount}</Field>
        </div>
      ) : null}

      {/* Every disagreement, named. A matched document with a product that is
          not on it is still a matched document — but the agent must see why it
          is not straightforward. */}
      {verification.discrepancies.length > 0 ? (
        <ul className="mt-2 space-y-1">
          {verification.discrepancies.map((d) => (
            <li
              key={d}
              className="flex items-start gap-1.5 text-xs text-[#B45309] dark:text-amber-300"
            >
              <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
              {DISCREPANCY_LABELS[d]}
            </li>
          ))}
        </ul>
      ) : null}

      {verification.candidates.length > 0 ? (
        <div className="mt-2 rounded-md border border-border p-3">
          <p className="text-xs font-medium">Possible invoices</p>
          <ul className="mt-1 space-y-1 text-xs text-muted-foreground">
            {verification.candidates.map((c, i) => (
              <li key={`${c.docNo}-${i}`}>
                {c.docNo} · {day(c.docDay)} · {c.branchCode ?? "—"} · {fmtSAR(c.grandTotal)}
              </li>
            ))}
          </ul>
        </div>
      ) : null}
    </div>
  );
}

function StockSection({
  state,
  stock,
  onRetry,
}: {
  state: VerificationState;
  stock: LeadStockResult | null;
  onRetry: () => void;
}) {
  if (state === "loading") {
    return (
      <p className="flex items-center gap-2 text-sm text-muted-foreground">
        <Loader2 className="h-4 w-4 animate-spin" />
        Checking branch stock…
      </p>
    );
  }
  if (state === "unavailable" || state === "forbidden") {
    return <Unavailable what="stock" state={state} onRetry={onRetry} />;
  }
  if (!stock) return null;

  const Icon = stock.state === "in_stock" ? PackageCheck : PackageX;

  return (
    <div className="border-t border-border pt-3">
      <div className="flex flex-wrap items-center gap-2">
        <span
          className={cn(
            "inline-flex items-center gap-1.5 rounded-full border px-2 py-0.5 text-[11px] font-medium",
            STOCK_STYLES[stock.state],
          )}
        >
          <Icon className="h-3.5 w-3.5" />
          {STOCK_LABELS[stock.state]}
        </span>
        {/* A quantity only where one is a fact. `unknown` and `not_found` carry
            none, and printing "0" for either would be an invented figure. */}
        {stock.quantity != null ? (
          <span className="text-sm tabular-nums">
            {stock.quantity} at {stock.branchNo}
          </span>
        ) : null}
      </div>
      <p className="mt-1 truncate text-xs text-muted-foreground">
        {stock.itemName ?? "No product on this lead"}
        {stock.itemCode ? ` · ${stock.itemCode}` : ""}
        {stock.branchNo ? ` · ${stock.branchNo}` : ""}
      </p>
      {stock.state === "unknown" && stock.branchNo && !stock.productUnknown ? (
        <p className="mt-1 text-xs text-muted-foreground">
          Shams listed other branches for this product but not {stock.branchNo}, so its stock is
          unaccounted for rather than zero.
        </p>
      ) : null}
    </div>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <p className="text-xs text-muted-foreground">{label}</p>
      <div className="mt-0.5">{children}</div>
    </div>
  );
}
