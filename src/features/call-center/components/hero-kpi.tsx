import { ChevronRight } from "lucide-react";
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
  onClick,
  actionLabel,
}: {
  label: string;
  value: string | number;
  loading?: boolean;
  icon?: any;
  tone?: Tone;
  hint?: string;
  /** Hairline stripe grouping this card with its peers. See `Kpi`. */
  accent?: Tone;
  /**
   * Makes the card a drill-down. Supplying it turns the whole card into a
   * button, so the affordance is keyboard-reachable and announced as one.
   */
  onClick?: () => void;
  /** What opening the card shows, for the accessible name. */
  actionLabel?: string;
}) {
  const t = toneMap[tone];
  const card = (
    <Card
      className={cn(
        "h-full overflow-hidden transition-shadow hover:shadow-md",
        accent && `border-l-[3px] ${accentMap[accent]}`,
        onClick && "group-hover:shadow-lg",
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
          <div className="mt-auto flex items-end gap-1 pt-1.5 text-[11px] leading-snug text-muted-foreground/80">
            <span className="min-w-0 flex-1">{hint}</span>
            {onClick && (
              <ChevronRight
                className="h-3.5 w-3.5 shrink-0 translate-y-px transition-transform group-hover:translate-x-0.5 group-hover:text-foreground print:hidden"
                aria-hidden="true"
              />
            )}
          </div>
        )}
      </CardContent>
    </Card>
  );

  if (!onClick) return card;
  return (
    <button
      type="button"
      onClick={onClick}
      aria-label={actionLabel ? `${label}: ${value}. ${actionLabel}` : undefined}
      className="group h-full w-full cursor-pointer rounded-xl text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background"
    >
      {card}
    </button>
  );
}
