import { memo } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";

export interface DistributionSlice {
  label: string;
  value: number;
  color: string;
  hint?: string;
}

/**
 * How the window's calls split across outcomes, as one stacked bar.
 *
 * A donut is the reflex for a part-to-whole and it is worse here: five slices at
 * dashboard scale need a legend to be readable at all, at which point the legend
 * is doing the work and the circle is decoration. A single stacked bar with the
 * figures underneath reads at any width, degrades to a phone without reflowing,
 * and puts the counts where they can actually be compared.
 *
 * Slices arrive pre-computed. This component sums them only to size the bar —
 * it publishes no total and no percentage that any KPI depends on.
 */
export const CallDistribution = memo(function CallDistribution({
  slices,
  loading,
  title = "Call distribution",
  subtitle = "Every call in the window, by outcome.",
}: {
  slices: DistributionSlice[];
  loading: boolean;
  title?: string;
  subtitle?: string;
}) {
  const total = slices.reduce((s, x) => s + x.value, 0);

  return (
    <Card className="h-full overflow-hidden">
      <CardHeader className="border-b border-border/60 bg-muted/20 px-4 py-3.5">
        <CardTitle className="text-sm font-semibold">{title}</CardTitle>
        <p className="text-xs leading-snug text-muted-foreground">{subtitle}</p>
      </CardHeader>
      <CardContent className="space-y-4 p-4">
        {loading ? (
          <>
            <Skeleton className="h-3 w-full" />
            <Skeleton className="h-16 w-full" />
          </>
        ) : (
          <>
            <div
              className="flex h-3 w-full overflow-hidden rounded-full bg-muted"
              role="img"
              aria-label={slices.map((s) => `${s.label}: ${s.value}`).join(", ")}
            >
              {total > 0 &&
                slices
                  .filter((s) => s.value > 0)
                  .map((s) => (
                    <span
                      key={s.label}
                      title={`${s.label}: ${s.value}`}
                      style={{ width: `${(s.value / total) * 100}%`, background: s.color }}
                    />
                  ))}
            </div>

            <dl className="grid grid-cols-2 gap-x-4 gap-y-3 sm:grid-cols-3">
              {slices.map((s) => (
                <div key={s.label} className="min-w-0">
                  <dt className="flex items-center gap-1.5 text-[11px] uppercase tracking-wide text-muted-foreground">
                    <span
                      className="inline-block h-2 w-2 shrink-0 rounded-full"
                      style={{ background: s.color }}
                      aria-hidden="true"
                    />
                    <span className="truncate">{s.label}</span>
                  </dt>
                  <dd className="mt-1 flex items-baseline gap-1.5">
                    <span className="text-lg font-semibold tabular-nums">{s.value}</span>
                    <span className="text-[11px] tabular-nums text-muted-foreground">
                      {total > 0 ? `${((s.value / total) * 100).toFixed(1)}%` : "—"}
                    </span>
                  </dd>
                  {s.hint && (
                    <p className="mt-0.5 text-[11px] leading-snug text-muted-foreground/80">
                      {s.hint}
                    </p>
                  )}
                </div>
              ))}
            </dl>
          </>
        )}
      </CardContent>
    </Card>
  );
});
