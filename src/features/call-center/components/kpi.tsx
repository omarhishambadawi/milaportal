import { Card, CardContent } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { cn } from "@/lib/utils";
import { accentMap, toneMap } from "../constants";
import type { Tone } from "../types";

export function Kpi({
  label,
  value,
  loading,
  icon: Icon,
  tone = "muted",
  hint,
  accent,
  footnote,
}: {
  label: string;
  value: string | number;
  loading?: boolean;
  icon?: any;
  tone?: Tone;
  /** One short line under the value, explaining what the number counts. */
  hint?: string;
  /**
   * Groups this card with the others carrying the same accent — a hairline
   * stripe down the left edge. Grouping only; it says nothing about the value,
   * which is what `tone` is for.
   */
  accent?: Tone;
  /**
   * A provenance or caveat note, rendered smaller and dimmer than `hint`. Use
   * it for "where this number came from", not for what it means.
   */
  footnote?: string;
}) {
  const t = toneMap[tone];
  return (
    <Card
      className={cn(
        "h-full transition-shadow hover:shadow-sm",
        accent && `border-l-[3px] ${accentMap[accent]}`,
      )}
    >
      <CardContent className="flex h-full flex-col p-3 sm:p-3.5">
        <div className="mb-1.5 flex items-start justify-between gap-2">
          <div className="text-[11px] font-medium uppercase leading-tight tracking-wide text-muted-foreground">
            {label}
          </div>
          {Icon && <Icon className={cn("mt-px h-3.5 w-3.5 shrink-0", t.iconText)} />}
        </div>
        {loading ? (
          <Skeleton className="h-6 w-16" />
        ) : (
          <div className={cn("text-lg font-semibold tabular-nums sm:text-xl", t.text)}>{value}</div>
        )}
        {hint && (
          <div className="mt-1 text-[11px] leading-snug text-muted-foreground/80">{hint}</div>
        )}
        {footnote && (
          <div className="mt-auto pt-1.5 text-[10px] leading-snug text-muted-foreground/60">
            {footnote}
          </div>
        )}
      </CardContent>
    </Card>
  );
}
