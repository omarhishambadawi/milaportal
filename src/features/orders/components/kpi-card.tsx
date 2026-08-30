import { cn } from "@/lib/utils";
import { fmtSAR } from "@/lib/branches";

export function KpiCard({
  label,
  tone,
  highlight,
  totalSales,
  completedSales,
  totalOrders,
  completedOrders,
}: {
  label: string;
  tone: string;
  highlight?: boolean;
  totalSales: number;
  completedSales: number;
  totalOrders: number;
  completedOrders: number;
}) {
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
            {fmtSAR(totalSales)}
          </span>
        </div>
        <div className="flex items-baseline justify-between gap-2">
          <span className="text-xs text-muted-foreground">Completed sales</span>
          <span className="text-base font-semibold tabular-nums truncate text-[var(--positive)]">
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
