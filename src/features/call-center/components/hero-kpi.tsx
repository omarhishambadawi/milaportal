import { Card, CardContent } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { cn } from "@/lib/utils";
import { toneMap } from "../constants";
import type { Tone } from "../types";

export function HeroKpi({ label, value, loading, icon: Icon, tone = "muted", hint }: { label: string; value: string | number; loading?: boolean; icon?: any; tone?: Tone; hint?: string }) {
  const t = toneMap[tone];
  return (
    <Card className="overflow-hidden transition-shadow hover:shadow-md">
      <CardContent className="p-4 sm:p-5">
        <div className="flex items-start justify-between gap-2 mb-3">
          <div className="text-xs font-medium text-muted-foreground uppercase tracking-wide">{label}</div>
          {Icon && (
            <div className={cn("rounded-lg p-2", t.iconBg)}>
              <Icon className={cn("h-4 w-4", t.iconText)} />
            </div>
          )}
        </div>
        {loading ? (
          <Skeleton className="h-9 w-24" />
        ) : (
          <div className={cn("text-2xl sm:text-3xl font-semibold tabular-nums tracking-tight", t.text)}>{value}</div>
        )}
        {hint && <div className="mt-1.5 text-[11px] text-muted-foreground/80">{hint}</div>}
      </CardContent>
    </Card>
  );
}
