import type { ReactNode } from "react";
import type { LucideIcon } from "lucide-react";
import { cn } from "@/lib/utils";
import { fmtSAR } from "@/lib/branches";
import type { DashKpiStats } from "../types";

/**
 * Headline KPI card (Cash / Wasfaty / Total) for the selected period.
 *
 * ---------------------------------------------------------------------------
 * What changed, and why
 * ---------------------------------------------------------------------------
 * Every figure the card carried is still on it. What moved is the ranking.
 *
 *   - **The money leads.** Total sales was one of four values in a stack of
 *     label/value rows, set at the same 16px as the row above it, while the
 *     order *counts* underneath were 24px bold. So the largest thing on a sales
 *     dashboard's headline card was a count of orders. The period's sales figure
 *     is now the one number set at display size, with everything else supporting
 *     it.
 *   - **The completion rate is a badge**, not the first third of a three-column
 *     micro row at 11px. It is the card's one ratio and the only figure on it
 *     that is directly comparable between the three cards.
 *   - **An icon** in the same tinted square `AnalyticsCard` gives its panels, at
 *     the same size and radius, so the KPI row and the chart headers below it
 *     read as one component family rather than as two.
 *
 * The tone gradient is unchanged: it is what tells the three cards apart at a
 * glance and it comes from the `--tint-*` tokens, not from a colour invented
 * here.
 */
export function DashKpiCard({
  label,
  /** Gradient classes from the `--tint-*` tokens. */
  tone,
  /** A Lucide component naming what the bucket is. */
  icon: Icon,
  highlight,
  stats,
  /**
   * Render every figure as a placeholder bar while `orders_kpis` is in flight.
   *
   * The cards used to paint zeroes for that window, which is worse than a
   * placeholder rather than better: a zero is a number, and nothing tells the
   * reader it apart from a period that genuinely had no sales.
   */
  loading,
}: {
  label: string;
  tone: string;
  icon: LucideIcon;
  highlight?: boolean;
  stats?: DashKpiStats;
  loading?: boolean;
}) {
  const s: DashKpiStats = stats ?? {
    totalSales: 0,
    completedSales: 0,
    totalOrders: 0,
    completedOrders: 0,
    pending: 0,
    cancelled: 0,
    completionRate: 0,
  };

  /**
   * A figure, or its placeholder.
   *
   * The placeholder is drawn *inside the element the figure would occupy*
   * rather than in a parallel skeleton tree, and that is the whole point: a
   * separate skeleton is a second set of heights to keep in step with the
   * first, and the two had already drifted 22px apart — which the reader sees
   * as the KPI row jumping the moment the RPC lands. Here the line box is the
   * real one, produced by the real type classes; only the glyphs are swapped
   * for a tinted bar. The card cannot change height when the numbers arrive.
   *
   * `&nbsp;` and not an empty span: an empty inline-block has no strut, so it
   * would collapse the very line height it exists to preserve.
   */
  const figure = (value: ReactNode, width: string): ReactNode =>
    loading ? (
      <span
        className={cn(
          // `align-baseline`, not `middle`. A non-overflowing inline-block takes
          // its baseline from its own content, so at baseline it sits in the line
          // box exactly where the text it stands in for would; `middle` centres
          // it on the x-height instead and grows the line box by a few pixels a
          // line — which added up to the whole card being 10px taller while it
          // loaded, and to the row twitching as the figures arrived.
          "inline-block max-w-full animate-pulse select-none rounded bg-muted align-baseline text-transparent",
          width,
        )}
      >
        &nbsp;
      </span>
    ) : (
      value
    );

  return (
    <div
      className={cn(
        "group/kpi relative flex h-full flex-col rounded-xl border bg-gradient-to-br p-4 sm:p-5 print:p-2.5",
        tone,
        // Same restraint as `AnalyticsCard`: a slow, small lift. A KPI row that
        // twitches as the pointer crosses it is the difference between an
        // analytics product and a landing page.
        "shadow-sm transition-shadow duration-300 hover:shadow-md",
        highlight && "border-primary/40 shadow-md",
      )}
    >
      <div className="flex items-center gap-2.5">
        <span
          aria-hidden
          className={cn(
            "flex h-9 w-9 shrink-0 items-center justify-center rounded-lg print:h-6 print:w-6",
            "bg-primary/8 text-primary/80 ring-1 ring-inset ring-primary/10",
            "transition-colors duration-300 group-hover/kpi:bg-primary/12 group-hover/kpi:text-primary",
          )}
        >
          <Icon className="h-[18px] w-[18px]" strokeWidth={2} />
        </span>
        <span className="min-w-0 flex-1 truncate text-[11px] font-semibold uppercase tracking-wider text-muted-foreground print:text-[8px]">
          {label}
        </span>
        {/* The completion rate, carried as the card's one badge. Tabular so the
            three cards' percentages line up down the row. */}
        <span className="shrink-0 rounded-full bg-background/70 px-2 py-0.5 text-[11px] font-semibold tabular-nums text-foreground ring-1 ring-inset ring-border/60 print:px-1 print:text-[8px]">
          {figure(`${s.completionRate.toFixed(1)}%`, "w-9")}
        </span>
      </div>

      {/* Two figures, both primary.
          Completed sales used to be twelve pixels of green on the right of a
          caption, under a twenty-four pixel revenue figure — a footnote about
          the number management is actually judged on. It now gets its own label,
          its own line and the same type as revenue, ranked directly under it:
          what was taken, then what of it landed.

          Stacked rather than side by side, and that is a responsiveness
          decision. Two SAR figures at 24px need about 370px between them; the
          three cards share the page, so on a 1024px viewport there is not that
          much and one of them would truncate. Stacked, each gets the card's full
          width at every breakpoint.

          The `print:` sizes are the A4 column, not a second design: three of
          these cards share 186mm of paper, about 60mm each, and
          "1,247,820.55 SAR" at 24px does not fit 60mm. */}
      {/* 24px from `md:` and not from `sm:`.
          Between 640 and 768 the grid is already three across, which leaves each
          figure about 160px — and "1,247,820.55 SAR" needs 188 at 24px. It
          truncated. One step down at that band fits it exactly, and above 768
          there is room for the display size. */}
      {/* 24px from `md:` and not from `sm:`. Between 640 and 768 the grid is
          already three across, which leaves each figure about 160px — and
          "1,247,820.55 SAR" needs 188 of them at 24px, so it truncated. One step
          down over that band fits it exactly; above 768 there is room for the
          display size. */}
      <div className="mt-4 space-y-3 print:mt-2 print:space-y-1.5">
        <div>
          <div className="text-[10px] uppercase tracking-wider text-muted-foreground print:text-[7px]">
            Total sales
          </div>
          <div className="mt-0.5 truncate text-xl font-semibold leading-tight tabular-nums md:text-2xl print:mt-0 print:text-[13px]">
            {figure(fmtSAR(s.totalSales), "w-40")}
          </div>
        </div>
        <div>
          <div className="text-[10px] uppercase tracking-wider text-muted-foreground print:text-[7px]">
            Completed sales
          </div>
          <div className="mt-0.5 truncate text-xl font-semibold leading-tight tabular-nums text-[var(--positive)] md:text-2xl print:mt-0 print:text-[13px]">
            {figure(fmtSAR(s.completedSales), "w-40")}
          </div>
        </div>
      </div>

      <div className="mt-4 grid grid-cols-2 gap-2 border-t border-border/60 pt-3 print:mt-2 print:pt-1.5">
        <div>
          <div className="whitespace-nowrap text-[10px] uppercase tracking-wider text-muted-foreground">
            Total orders
          </div>
          <div className="text-lg font-semibold leading-tight tabular-nums sm:text-xl print:text-xs">
            {figure(s.totalOrders, "w-14")}
          </div>
        </div>
        <div className="text-right">
          {/* "Completed", not "Completed orders": paired with "Total orders" in
              the other half of the row it is unambiguous, and the longer label
              wraps to two lines in a three-up card at tablet width — which drops
              its value half a line below its neighbour's and makes the row look
              misaligned. `whitespace-nowrap` on both keeps that decided here
              rather than by the viewport. */}
          <div className="whitespace-nowrap text-[10px] uppercase tracking-wider text-muted-foreground">
            Completed
          </div>
          <div className="text-lg font-semibold leading-tight tabular-nums text-[var(--positive)] sm:text-xl print:text-xs">
            {figure(s.completedOrders, "w-14")}
          </div>
        </div>
      </div>

      <div className="mt-2.5 flex items-center gap-3 border-t border-border/40 pt-2 text-[11px] print:mt-1.5 print:gap-2 print:pt-1 print:text-[8px]">
        <span className="inline-flex items-center gap-1.5">
          <span aria-hidden className="h-1.5 w-1.5 rounded-full bg-[var(--attention)]" />
          <span className="text-muted-foreground">Pending</span>
          <span className="font-semibold tabular-nums text-[var(--attention)]">
            {figure(s.pending, "w-6")}
          </span>
        </span>
        <span className="inline-flex items-center gap-1.5">
          <span aria-hidden className="h-1.5 w-1.5 rounded-full bg-[var(--negative)]" />
          <span className="text-muted-foreground">Cancelled</span>
          <span className="font-semibold tabular-nums text-[var(--negative)]">
            {figure(s.cancelled, "w-6")}
          </span>
        </span>
      </div>
    </div>
  );
}
