import { cn } from "@/lib/utils";
import { fmtSAR } from "@/lib/branches";

export function KpiCard({
  label,
  tone,
  highlight,
  className,
  totalSales,
  completedSales,
  totalOrders,
  completedOrders,
}: {
  label: string;
  tone: string;
  highlight?: boolean;
  /** Grid placement from the caller — the Total card spans both phone columns. */
  className?: string;
  totalSales: number;
  completedSales: number;
  totalOrders: number;
  completedOrders: number;
}) {
  return (
    <div
      className={cn(
        "relative rounded-xl border bg-gradient-to-br p-3 shadow-sm sm:p-4",
        tone,
        highlight && "border-primary/40 shadow-md",
        className,
      )}
    >
      <div className="text-[11px] uppercase tracking-wider text-muted-foreground font-semibold">
        {label}
      </div>
      {/*
        Label beside figure where the column is wide enough for both, stacked
        where it is not.

        Three of these sit across the Orders page from `sm`, and between `md` and
        `lg` the app sidebar takes 256px out of the same row — which left about
        150px a card, and "Completed sales" and "96,200 SAR" side by side in
        150px wraps the figure onto a second line *under its own label*. The one
        width where the summary read worse than the table it summarises.

        Stacking rather than shrinking the type: the figure is the thing being
        read, and it keeps its size at every width.
      */}
      <div className="mt-3 space-y-1.5">
        <div className="flex flex-col gap-0 lg:flex-row lg:items-baseline lg:justify-between lg:gap-2">
          <span className="text-xs text-muted-foreground">Total sales</span>
          <span className="truncate text-base font-semibold tabular-nums">
            {fmtSAR(totalSales)}
          </span>
        </div>
        <div className="flex flex-col gap-0 lg:flex-row lg:items-baseline lg:justify-between lg:gap-2">
          <span className="text-xs text-muted-foreground">Completed sales</span>
          <span className="truncate text-base font-semibold tabular-nums text-[var(--positive)]">
            {fmtSAR(completedSales)}
          </span>
        </div>
      </div>
      <div className="mt-3 pt-3 border-t border-border/60 grid grid-cols-2 gap-2">
        <div className="text-left">
          <div className="text-[10px] uppercase tracking-wider text-muted-foreground">
            Total orders
          </div>
          <div className="text-2xl font-bold tabular-nums leading-tight">{totalOrders}</div>
        </div>
        <div className="text-right">
          <div className="text-[10px] uppercase tracking-wider text-muted-foreground">
            Completed
          </div>
          <div className="text-2xl font-bold tabular-nums leading-tight text-[var(--positive)]">
            {completedOrders}
          </div>
        </div>
      </div>
    </div>
  );
}
