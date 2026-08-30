import type { LucideIcon } from "lucide-react";
import { Card, CardContent } from "@/components/ui/card";
import { cn } from "@/lib/utils";

/**
 * Compact single-figure stat card (Complaints summary row).
 *
 * The icon is optional and sits in the same tinted square `AnalyticsCard` and
 * `DashKpiCard` use, at a size down — 7 units rather than 9 — because this tile
 * is half their height and an icon scaled to their square would be the largest
 * thing on it. Same shape, same tint, same ring: one icon treatment across the
 * page at two densities, rather than two treatments.
 *
 * `accent` tones the value and nothing else. A card whose *label* is coloured
 * reads as a warning; a card whose figure is coloured reads as a figure with a
 * direction, which is what "In progress" and "Resolved" are.
 */
export function StatCard({
  label,
  value,
  icon: Icon,
  accent,
  sub,
}: {
  label: string;
  value: string | number;
  icon?: LucideIcon;
  accent?: string;
  sub?: string;
}) {
  return (
    <Card className="group/stat border-border/60 shadow-sm transition-shadow duration-300 hover:shadow-md">
      <CardContent className="p-3 sm:p-4">
        <div className="flex items-center gap-2">
          {Icon && (
            <span
              aria-hidden
              className={cn(
                "flex h-7 w-7 shrink-0 items-center justify-center rounded-md",
                "bg-primary/8 text-primary/80 ring-1 ring-inset ring-primary/10",
                "transition-colors duration-300 group-hover/stat:bg-primary/12 group-hover/stat:text-primary",
              )}
            >
              <Icon className="h-3.5 w-3.5" strokeWidth={2} />
            </span>
          )}
          <div className="min-w-0 truncate text-[10px] uppercase tracking-wider text-muted-foreground sm:text-[11px]">
            {label}
          </div>
        </div>
        <div
          className={cn("mt-1.5 truncate text-base font-semibold tabular-nums sm:text-xl", accent)}
        >
          {value}
        </div>
        {sub && (
          <div className="mt-0.5 truncate text-[10px] text-muted-foreground sm:text-[11px]">
            {sub}
          </div>
        )}
      </CardContent>
    </Card>
  );
}
