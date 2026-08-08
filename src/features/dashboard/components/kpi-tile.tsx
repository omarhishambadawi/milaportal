import { Card, CardContent } from "@/components/ui/card";
import { cn } from "@/lib/utils";

/**
 * One KPI in an analytics strip.
 *
 * Deliberately the same type scale as `StatCard` — the tile the Complaints row
 * already uses — so every strip on the Dashboard reads as one component. What
 * it adds over `StatCard` is a tone on the value and on the second line, which
 * a growth rate needs and a complaint count has no reason to grow a prop for.
 *
 * Shared by Monthly performance and Delivery methods. That is the whole reason
 * it is a module rather than a local function: the two strips sit on the same
 * page, and a second copy of these five class strings is a second thing to
 * change when the density is next tuned.
 */
export function KpiTile({
  label,
  value,
  valueTone,
  sub,
  subTone = "text-muted-foreground",
}: {
  label: string;
  value: string;
  valueTone?: string;
  sub?: string;
  subTone?: string;
}) {
  return (
    <Card className="border-border/60 shadow-sm">
      <CardContent className="p-3 sm:p-4">
        <div className="truncate text-[10px] uppercase tracking-wider text-muted-foreground sm:text-[11px]">
          {label}
        </div>
        <div
          className={cn("mt-1 truncate text-base font-semibold tabular-nums sm:text-xl", valueTone)}
        >
          {value}
        </div>
        {sub && (
          <div className={cn("mt-0.5 truncate text-[11px] tabular-nums", subTone)}>{sub}</div>
        )}
      </CardContent>
    </Card>
  );
}
