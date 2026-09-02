import { Package, PackageX, HelpCircle } from "lucide-react";
import { cn } from "@/lib/utils";
import type { StockState } from "@/lib/shams/availability";
import {
  BAND_LABELS,
  SUPPORTING_LABELS,
  type Recommendation,
  type RecommendationBand,
} from "@/lib/telesales/recommendations";

/**
 * Why this lead is recommended, in one line above the row.
 *
 * The brief's test is that an agent should not have to open anything to know
 * why they are looking at a lead, so the band, the supporting signals and the
 * sentence all sit here. The row underneath is the ordinary queue row with its
 * ordinary actions — this is a view over the existing leads, not a second
 * workflow, so nothing about calling, claiming or recording changes.
 *
 * The colour vocabulary is the module's existing one. A refill due today reads
 * with the same urgency as an overdue follow-up elsewhere in the app, and
 * cross-sell is deliberately quiet: it is an idea, not a deadline.
 */

const BAND_STYLES: Record<RecommendationBand, string> = {
  refill_due_today: "bg-[#F59E0B]/15 text-[#B45309] border-[#F59E0B]/40 dark:text-amber-200",
  refill_overdue: "bg-[#EF4444]/15 text-[#B91C1C] border-[#EF4444]/40 dark:text-red-200",
  refill_soon: "bg-[#3B82F6]/15 text-[#1D4ED8] border-[#3B82F6]/40 dark:text-blue-200",
  previously_purchased: "bg-[#8B5CF6]/15 text-[#6D28D9] border-[#8B5CF6]/40 dark:text-violet-200",
  cross_sell: "bg-secondary text-secondary-foreground border-border",
};

const STOCK_STYLES: Record<StockState, string> = {
  in_stock: "bg-[#10B981]/15 text-[#047857] border-[#10B981]/40 dark:text-emerald-200",
  out_of_stock: "bg-[#EF4444]/15 text-[#B91C1C] border-[#EF4444]/40 dark:text-red-200",
  not_found: "bg-muted text-muted-foreground border-border",
  unknown: "bg-muted text-muted-foreground border-border",
};

/**
 * Stock wording.
 *
 * `not_found` and `unknown` stay apart, as they do on the lead detail: "the MIS
 * has no such item" and "nobody has asked yet" are different facts, and an
 * agent about to promise a customer a product should know which one they are
 * looking at. Neither is rendered as a zero.
 */
const STOCK_LABELS: Record<StockState, string> = {
  in_stock: "IN STOCK",
  out_of_stock: "OUT OF STOCK",
  not_found: "NOT IN CATALOGUE",
  unknown: "STOCK UNKNOWN",
};

function Pill({ className, children }: { className?: string; children: React.ReactNode }) {
  return (
    <span
      className={cn(
        "inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-[10px] font-medium tracking-wide",
        className,
      )}
    >
      {children}
    </span>
  );
}

export interface RecommendationStripProps {
  recommendation: Recommendation;
  /** Live stock for this row's product, when the visible-page lookup has an
   *  answer. Undefined is `unknown` and never reads as out of stock. */
  stock?: { state: StockState; quantity: number | null };
}

export function RecommendationStrip({ recommendation, stock }: RecommendationStripProps) {
  const state = stock?.state ?? "unknown";
  const StockIcon =
    state === "in_stock" ? Package : state === "out_of_stock" ? PackageX : HelpCircle;

  return (
    <div className="flex flex-wrap items-center gap-x-2 gap-y-1.5 px-3 pt-3">
      <Pill className={BAND_STYLES[recommendation.band]}>{BAND_LABELS[recommendation.band]}</Pill>

      {/* Supporting signals. `in_stock` is omitted here because the live stock
          badge beside it is the better answer -- the engine's copy was computed
          before the lookup returned. */}
      {recommendation.supporting
        .filter((s) => s !== "in_stock")
        .map((s) => (
          <Pill key={s} className="border-border bg-secondary text-secondary-foreground">
            {SUPPORTING_LABELS[s]}
          </Pill>
        ))}

      <Pill className={STOCK_STYLES[state]}>
        <StockIcon className="h-3 w-3" />
        {STOCK_LABELS[state]}
        {stock?.quantity != null ? ` · ${stock.quantity}` : ""}
      </Pill>

      {recommendation.crossSell ? (
        <Pill className="border-border bg-secondary text-secondary-foreground">
          → {recommendation.crossSell.toItemName}
        </Pill>
      ) : null}

      {/* The sentence. The whole point of the page: no agent should have to
          open a lead to find out why it is on this list. */}
      <p className="w-full text-xs text-muted-foreground sm:w-auto sm:flex-1 sm:truncate">
        {recommendation.reason}
      </p>
    </div>
  );
}
