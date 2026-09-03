import { AlertTriangle, Loader2, PackageCheck, PackageX, RefreshCw } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { cn } from "@/lib/utils";
import { fmtSAR } from "@/lib/branches";
import type { StockState } from "@/lib/shams/availability";
import type {
  LeadStockResult,
  VerificationState,
} from "@/features/telesales/hooks/use-lead-verification";

/**
 * Can this lead still be fulfilled?
 *
 * The stock half of what was `LeadVerificationPanel`, unchanged. The other half
 * asked whether the lead had already converted, by reconciling its document
 * number against the Shams MIS invoices — and it was removed from the lead page
 * because it answered a reporting question at the cost of a second MIS request
 * on every open, while an agent with a customer on the line needs to know what
 * that customer has bought, not whether a document number reconciles.
 *
 * None of the reconciliation architecture went with it.
 * `telesales_leads.invoice_match_status`, `lib/telesales/reconciliation.ts` and
 * the recommendation engine's `invoice_verified` badge are all untouched; what
 * changed is that this page no longer computes a fresh verdict, so the column
 * keeps the values it already holds rather than gaining new ones.
 *
 * Stock comes from the Shams MIS through the same server function the `/shams`
 * Stock tab uses, under the same query key, so the card shares that cache.
 */

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

/**
 * The card. One question, so the section and the card are the same thing.
 */
export function LeadStockPanel({
  state,
  stock,
  onRetry,
}: {
  state: VerificationState;
  stock: LeadStockResult | null;
  onRetry: () => void;
}) {
  return (
    <Card>
      <CardHeader className="pb-3">
        <CardTitle className="text-base">Availability</CardTitle>
      </CardHeader>
      <CardContent>
        <StockSection state={state} stock={stock} onRetry={onRetry} />
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
