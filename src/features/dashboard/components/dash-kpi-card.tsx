import { cn } from "@/lib/utils";
import { fmtSAR } from "@/lib/branches";
import type { DashKpiStats } from "../types";

/** Headline KPI card (Cash / Wasfaty / Total) for the selected period. */
export function DashKpiCard({
  label,
  tone,
  highlight,
  stats,
}: {
  label: string;
  tone: string;
  highlight?: boolean;
  stats?: DashKpiStats;
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
  return (
    <div
      className={cn(
        "relative rounded-xl border bg-gradient-to-br p-4 shadow-sm",
        tone,
        highlight && "border-primary/40 shadow-md",
      )}
    >
      <div className="text-[11px] uppercase tracking-wider text-muted-foreground font-semibold">
        {label}
      </div>
      <div className="mt-3 space-y-1.5">
        <div className="flex items-baseline justify-between gap-2">
          <span className="text-xs text-muted-foreground">Total sales</span>
          <span className="text-base font-semibold tabular-nums truncate">
            {fmtSAR(s.totalSales)}
          </span>
        </div>
        <div className="flex items-baseline justify-between gap-2">
          <span className="text-xs text-muted-foreground">Completed sales</span>
          <span className="text-base font-semibold tabular-nums truncate text-[var(--positive)]">
            {fmtSAR(s.completedSales)}
          </span>
        </div>
      </div>
      <div className="mt-3 pt-3 border-t border-border/60 grid grid-cols-2 gap-2">
        <div className="text-left">
          <div className="text-[10px] uppercase tracking-wider text-muted-foreground">
            Total orders
          </div>
          <div className="text-2xl font-bold tabular-nums leading-tight">{s.totalOrders}</div>
        </div>
        <div className="text-right">
          <div className="text-[10px] uppercase tracking-wider text-muted-foreground">
            Completed
          </div>
          <div className="text-2xl font-bold tabular-nums leading-tight text-[var(--positive)]">
            {s.completedOrders}
          </div>
        </div>
      </div>
      <div className="mt-2 pt-2 border-t border-border/40 grid grid-cols-3 gap-1 text-[11px]">
        <div>
          <span className="text-muted-foreground">Rate </span>
          <span className="font-semibold">{s.completionRate.toFixed(1)}%</span>
        </div>
        <div>
          <span className="text-muted-foreground">Pending </span>
          <span className="font-semibold text-[var(--attention)]">{s.pending}</span>
        </div>
        <div>
          <span className="text-muted-foreground">Cancelled </span>
          <span className="font-semibold text-[var(--negative)]">{s.cancelled}</span>
        </div>
      </div>
    </div>
  );
}
