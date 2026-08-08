import { PackageCheck, Sparkles, Truck } from "lucide-react";
import { cn } from "@/lib/utils";
import { fmtSAR } from "@/lib/branches";
import type { FulfillmentMix, FulfillmentRow } from "@/features/orders/fulfillment";
import {
  buildDeliveryInsights,
  rankMethods,
  type DeliveryMethodRow,
  type MethodPerformance,
} from "../delivery-analytics";
import { formatCompactSAR, formatCount, formatPercent } from "../format";
import { AnalyticsCard } from "./analytics-card";
import { KpiTile } from "./kpi-tile";
import { SectionTitle } from "./section-title";

/**
 * Delivery methods — how completed orders reached the customer.
 *
 * This replaced two tables that between them answered the question twice and
 * neither time directly: a five-column "fulfillment mix" whose rows were
 * Delivery / Store Pickup / Total, and a four-column "method performance" whose
 * rows were the couriers. A reader had to hold the first in their head to make
 * sense of the second — Store Pickup appears in both, once as half the split
 * and once as one method among four.
 *
 * It is now one argument in steps that do not overlap, and that is the whole
 * organising rule — **each panel answers a question the one above it did not**:
 *
 *   - **KPI strip** — how many completed, and how they divide Delivery against
 *     Store Pickup. The volume question, answered once and only here.
 *   - **Order distribution** — the split as a single 100% bar, then how Cash and
 *     Wasfaty divide *inside* each side. A first cut repeated the counts, the
 *     shares, the sales and the average order values here in two bordered cards;
 *     all of that is in the strip above, in bigger type.
 *   - **Method performance** — the couriers themselves, ranked by volume.
 *   - **Key insight** — what to notice.
 *
 * Same chrome as Monthly performance — `KpiTile`, `AnalyticsCard`,
 * `SectionTitle`, the shared formatters and the chart palette — so the two
 * sections read as one dashboard.
 *
 * The visualisation is CSS, not Recharts. A 100% stacked bar of two segments is
 * three divs and reads instantly at any width; routing it through the charting
 * library would buy a tooltip and cost a lazy boundary.
 *
 * **Completed orders only**, throughout: `summarizeFulfillment` folds the
 * completed columns of `orders_delivery`, and `classifyFulfillment` is the one
 * definition of which side of the cut a method falls on.
 */

/** Delivery and Store Pickup, coloured as the section's two-way split. */
const SIDE_COLOR = {
  delivery: "var(--color-chart-1)",
  pickup: "var(--color-chart-3)",
  unknown: "var(--color-muted-foreground)",
} as const;

/** Cash and Wasfaty, matched to their segments on the Revenue mix chart. */
const CHANNEL_COLOR = {
  cash: "var(--color-chart-4)",
  wasfaty: "var(--color-chart-1)",
} as const;

/** A labelled proportion bar: `Cash 188 · 28.6%` over a track. */
function ChannelBar({
  label,
  color,
  count,
  total,
}: {
  label: string;
  color: string;
  count: number;
  total: number;
}) {
  const percent = total > 0 ? (count / total) * 100 : 0;
  return (
    <div>
      <div className="flex items-baseline justify-between gap-2 text-xs">
        <span className="flex min-w-0 items-center gap-1.5 text-muted-foreground">
          <span
            aria-hidden
            className="h-2 w-2 shrink-0 rounded-full"
            style={{ background: color }}
          />
          <span className="truncate">{label}</span>
        </span>
        <span className="shrink-0 tabular-nums">
          <span className="font-medium">{formatCount(count)}</span>
          <span className="text-muted-foreground"> · {formatPercent(percent)}</span>
        </span>
      </div>
      <div className="mt-1 h-1.5 w-full overflow-hidden rounded-full bg-muted">
        <span className="block h-full" style={{ width: `${percent}%`, background: color }} />
      </div>
    </div>
  );
}

/**
 * How Cash and Wasfaty divide one side of the cut.
 *
 * Only that. This was a bordered card carrying the side's order count, its share
 * of the split, its sales and its average order value — every one of which the
 * KPI strip states above it, in bigger type. What was left once the repetition
 * went is the one thing this card is for, so it is no longer a card: a heading
 * and two bars, sitting directly on the panel.
 */
function ChannelSplit({ row, color }: { row: FulfillmentRow; color: string }) {
  const total = row.cash + row.wasfaty;

  return (
    <div className="min-w-0">
      <div className="flex items-center gap-2">
        <span aria-hidden className="h-2 w-2 shrink-0 rounded-full" style={{ background: color }} />
        <span className="truncate text-xs font-medium">{row.label}</span>
      </div>
      <div className="mt-2 space-y-2">
        <ChannelBar label="Cash" color={CHANNEL_COLOR.cash} count={row.cash} total={total} />
        <ChannelBar
          label="Wasfaty"
          color={CHANNEL_COLOR.wasfaty}
          count={row.wasfaty}
          total={total}
        />
      </div>
    </div>
  );
}

/**
 * One courier's line in the ranking.
 *
 * Volume leads — it is set at display size and right-aligned against the name —
 * with sales, average order value and the completion rate underneath as
 * supporting figures. The bar is the method's share of completed orders, which
 * is what turns three rows of numbers into a shape.
 */
function MethodRow({ method, rank }: { method: MethodPerformance; rank: number }) {
  return (
    <li className="border-b border-border/40 py-2.5 last:border-0 last:pb-0 first:pt-0">
      <div className="flex items-center gap-2.5">
        <span
          aria-hidden
          className="flex h-5 w-5 shrink-0 items-center justify-center rounded-md bg-muted text-[11px] font-semibold text-muted-foreground"
        >
          {rank}
        </span>
        <span className="min-w-0 flex-1 truncate text-sm font-medium">{method.name}</span>
        <span className="shrink-0 text-sm font-semibold tabular-nums">
          {formatCount(method.orders)}
          <span className="ml-1 text-xs font-normal text-muted-foreground">orders</span>
        </span>
      </div>
      <div className="mt-1.5 h-1.5 w-full overflow-hidden rounded-full bg-muted">
        <span
          className="block h-full"
          style={{ width: `${method.share}%`, background: SIDE_COLOR.delivery }}
        />
      </div>
      <div className="mt-1.5 flex items-center justify-between gap-2 text-[11px] text-muted-foreground">
        <span className="min-w-0 truncate tabular-nums">
          {/* Exact to the halala on hover; the line itself conveys magnitude. */}
          <span title={fmtSAR(method.sales)}>{formatCompactSAR(method.sales)}</span>
          {method.avgOrderValue != null && ` · AOV ${formatCompactSAR(method.avgOrderValue)}`}
        </span>
        <span className="shrink-0 rounded-full bg-muted px-1.5 py-0.5 font-medium tabular-nums">
          {formatPercent(method.rate)} completed
        </span>
      </div>
    </li>
  );
}

function KeyInsight({ insights }: { insights: ReturnType<typeof buildDeliveryInsights> }) {
  if (insights.length === 0) return null;

  return (
    <AnalyticsCard title="Key insight" icon={Sparkles} className="mt-3">
      <div className={cn("grid gap-2 sm:gap-3", insights.length > 1 && "sm:grid-cols-2")}>
        {insights.map((insight) => (
          <div
            key={insight.id}
            className="min-w-0 rounded-lg border border-border/60 bg-muted/25 p-3 sm:p-3.5"
          >
            <div className="truncate text-lg font-semibold tabular-nums sm:text-xl">
              {insight.value}
            </div>
            <div className="mt-0.5 text-xs leading-relaxed text-muted-foreground">
              {insight.label}
            </div>
          </div>
        ))}
      </div>
    </AnalyticsCard>
  );
}

export function DeliveryMethodsSection({
  mix,
  methods,
  /** The branch × method and city × method crosstabs, which belong under this
   *  heading but answer a different question and are unchanged by this redesign. */
  children,
}: {
  mix: FulfillmentMix;
  methods: readonly DeliveryMethodRow[];
  children?: React.ReactNode;
}) {
  const ranked = rankMethods(methods);
  const insights = buildDeliveryInsights(mix);
  const empty = mix.total.count === 0;

  return (
    <div>
      <SectionTitle title="Delivery methods" icon={Truck} />
      <p className="-mt-1 mb-3 text-xs text-muted-foreground">
        Completed order fulfillment performance · How customers received their orders
      </p>

      <div className="grid grid-cols-2 gap-2 sm:grid-cols-3 sm:gap-3">
        <KpiTile
          label="Completed orders"
          value={formatCount(mix.total.count)}
          // Only when there is one: a permanent "0 not recorded" line would be a
          // defect displayed forever rather than one that gets fixed.
          sub={
            mix.unknown.count > 0
              ? `${formatCount(mix.unknown.count)} method not recorded`
              : "Delivery + Store Pickup"
          }
        />
        <KpiTile
          label="Delivery"
          value={formatCount(mix.delivery.count)}
          sub={`${formatPercent(mix.delivery.percent)} · ${formatCompactSAR(mix.delivery.sales)}`}
        />
        <KpiTile
          label="Store pickup"
          value={formatCount(mix.pickup.count)}
          sub={`${formatPercent(mix.pickup.percent)} · ${formatCompactSAR(mix.pickup.sales)}`}
        />
      </div>

      <div className="mt-3 grid min-w-0 gap-3 sm:gap-4 lg:grid-cols-2">
        <AnalyticsCard
          title="Order distribution"
          subtitle="Delivery vs Store Pickup · Cash and Wasfaty distribution"
          icon={PackageCheck}
        >
          {empty ? (
            <p className="py-8 text-center text-sm text-muted-foreground">No completed orders</p>
          ) : (
            <>
              {/* The split, as one bar. Percentages are taken against classified
                  orders, so the two segments come to exactly 100 and a method
                  that was never recorded cannot silently round one side up. */}
              <div
                className="flex h-3 w-full overflow-hidden rounded-full bg-muted"
                role="img"
                aria-label={`Delivery ${formatPercent(mix.delivery.percent)}, Store Pickup ${formatPercent(mix.pickup.percent)} of completed orders`}
              >
                <span
                  className="h-full"
                  style={{
                    width: `${mix.delivery.percent}%`,
                    background: SIDE_COLOR.delivery,
                  }}
                />
                <span
                  className="h-full"
                  style={{ width: `${mix.pickup.percent}%`, background: SIDE_COLOR.pickup }}
                />
              </div>
              <div className="mt-1.5 flex justify-between gap-2 text-[11px] text-muted-foreground tabular-nums">
                <span>Delivery {formatPercent(mix.delivery.percent)}</span>
                <span>Store Pickup {formatPercent(mix.pickup.percent)}</span>
              </div>

              {/* Below the bar, the panel changes subject: not how many orders
                  went each way — the strip above says that — but how Cash and
                  Wasfaty divide inside each. */}
              <div className="mt-4 grid gap-4 border-t border-border/50 pt-3.5 sm:grid-cols-2 sm:gap-5">
                <ChannelSplit row={mix.delivery} color={SIDE_COLOR.delivery} />
                <ChannelSplit row={mix.pickup} color={SIDE_COLOR.pickup} />
              </div>

              {mix.unknown.count > 0 && (
                <p className="mt-2.5 text-[11px] text-muted-foreground">
                  {formatCount(mix.unknown.count)} completed orders have no delivery method recorded
                  and are outside the split.
                </p>
              )}
            </>
          )}
        </AnalyticsCard>

        <AnalyticsCard
          title="Method performance"
          subtitle="Completed orders per method, biggest first"
          icon={Truck}
        >
          {ranked.length === 0 ? (
            <p className="py-8 text-center text-sm text-muted-foreground">No completed orders</p>
          ) : (
            <ul>
              {ranked.map((method, index) => (
                <MethodRow key={method.name} method={method} rank={index + 1} />
              ))}
            </ul>
          )}
        </AnalyticsCard>
      </div>

      <KeyInsight insights={insights} />

      {children}
    </div>
  );
}
