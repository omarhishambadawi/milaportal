import { Card, CardContent } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { cn } from "@/lib/utils";
import { accentMap, toneMap } from "../constants";
import type { Tone } from "../types";

export function HeroKpi({
  label,
  value,
  loading,
  icon: Icon,
  tone = "muted",
  hint,
  accent,
}: {
  label: string;
  value: string | number;
  loading?: boolean;
  icon?: any;
  tone?: Tone;
  hint?: string;
  /** Hairline stripe grouping this card with its peers. See `Kpi`. */
  accent?: Tone;
}) {
  const t = toneMap[tone];
  return (
    <Card
      className={cn(
        "h-full overflow-hidden transition-shadow hover:shadow-md",
        accent && `border-l-[3px] ${accentMap[accent]}`,
      )}
    >
      <CardContent className="flex h-full flex-col p-4 sm:p-5">
        <div className="mb-3 flex items-start justify-between gap-2">
          <div className="text-xs font-medium uppercase leading-tight tracking-wide text-muted-foreground">
            {label}
          </div>
          {Icon && (
            <div className={cn("shrink-0 rounded-lg p-2", t.iconBg)}>
              <Icon className={cn("h-4 w-4", t.iconText)} />
            </div>
          )}
        </div>
        {loading ? (
          <Skeleton className="h-9 w-24" />
        ) : (
          <div
            className={cn("text-2xl font-semibold tracking-tight tabular-nums sm:text-3xl", t.text)}
          >
            {value}
          </div>
        )}
        {hint && (
          <div className="mt-auto pt-1.5 text-[11px] leading-snug text-muted-foreground/80">
            {hint}
          </div>
        )}
      </CardContent>
    </Card>
  );
}
