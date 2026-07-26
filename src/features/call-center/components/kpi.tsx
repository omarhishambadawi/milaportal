import { Card, CardContent } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { cn } from "@/lib/utils";
import { toneMap } from "../constants";
import type { Tone } from "../types";

export function Kpi({
  label,
  value,
  loading,
  icon: Icon,
  tone = "muted",
  hint,
}: {
  label: string;
  value: string | number;
  loading?: boolean;
  icon?: any;
  tone?: Tone;
  hint?: string;
}) {
  const t = toneMap[tone];
  return (
    <Card className="transition-shadow hover:shadow-sm">
      <CardContent className="p-3 sm:p-4">
        <div className="flex items-center justify-between mb-1.5">
          <div className="text-[11px] font-medium text-muted-foreground uppercase tracking-wide">
            {label}
          </div>
          {Icon && <Icon className={cn("h-3.5 w-3.5", t.iconText)} />}
        </div>
        {loading ? (
          <Skeleton className="h-6 w-16" />
        ) : (
          <div className={cn("text-lg sm:text-xl font-semibold tabular-nums", t.text)}>{value}</div>
        )}
        {hint && <div className="mt-1 text-[10px] text-muted-foreground/80">{hint}</div>}
      </CardContent>
    </Card>
  );
}
