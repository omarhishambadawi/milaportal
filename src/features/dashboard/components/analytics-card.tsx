import type { LucideIcon } from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { cn } from "@/lib/utils";

/**
 * The single card every analytics panel on the dashboard sits in.
 *
 * Before this there were four card shapes on one page — the chart panels used a
 * bare `CardHeader` at its default `p-6`, the tables used the same header over a
 * `p-0` body, the delivery matrices used a third combination and the map used
 * its own bordered header. They differed in header height, in body padding and
 * in whether they reacted to hover at all, which is most of why the page read as
 * assembled rather than designed.
 *
 * One component, one set of numbers. Panels differ in what they contain, never
 * in how they are framed.
 */
export function AnalyticsCard({
  title,
  subtitle,
  /** A Lucide component naming what the panel measures. Rendered in a tinted
   *  square so every header has the same leading rhythm whether or not the
   *  title wraps, and so the icon reads as chrome rather than as content. */
  icon: Icon,
  actions,
  /** Drop the body padding — for tables, which manage their own insets. */
  flush,
  /** Render the title as a placeholder bar. Lets the skeleton reuse this
   *  chrome instead of keeping a second copy of it that drifts. */
  loading,
  className,
  bodyClassName,
  children,
}: {
  title: string;
  subtitle?: string;
  icon?: LucideIcon;
  actions?: React.ReactNode;
  flush?: boolean;
  loading?: boolean;
  className?: string;
  bodyClassName?: string;
  children: React.ReactNode;
}) {
  return (
    <Card
      className={cn(
        "group/card flex h-full flex-col overflow-hidden rounded-xl border-border/60",
        // The hover lift is deliberately slow and small. A dashboard is a wall
        // of cards; anything faster reads as the page twitching as the pointer
        // crosses it.
        "shadow-sm transition-shadow duration-300 hover:shadow-md",
        // On paper, a panel split across a sheet boundary is the "awkwardly cut"
        // failure — half a chart at the foot of page two and its axis at the top
        // of page three. Every card opts out of the break; `styles.css` covers
        // the table primitives underneath them.
        "print:break-inside-avoid",
        className,
      )}
    >
      <CardHeader className="flex flex-row items-start justify-between gap-3 space-y-0 px-4 py-3.5 sm:px-5">
        <div className="flex min-w-0 items-center gap-2.5">
          {Icon && !loading && (
            <span
              aria-hidden
              className={cn(
                "flex h-9 w-9 shrink-0 items-center justify-center rounded-lg",
                "bg-primary/8 text-primary/80 ring-1 ring-inset ring-primary/10",
                "transition-colors duration-300 group-hover/card:bg-primary/12 group-hover/card:text-primary",
              )}
            >
              <Icon className="h-[18px] w-[18px]" strokeWidth={2} />
            </span>
          )}
          {loading && <span className="h-9 w-9 shrink-0 animate-pulse rounded-lg bg-muted" />}
          <div className="min-w-0">
            {loading ? (
              <div className="h-4 w-36 animate-pulse rounded bg-muted" />
            ) : (
              <CardTitle className="truncate text-sm font-semibold tracking-tight sm:text-base">
                {title}
              </CardTitle>
            )}
            {subtitle && !loading && (
              <p className="mt-0.5 truncate text-xs text-muted-foreground">{subtitle}</p>
            )}
          </div>
        </div>
        {/* Card actions are controls — a scope toggle, a tab strip. On paper
            they are a set of dead buttons where the exported report should carry
            the state they were left in, which the panel below already shows. */}
        {actions && <div className="shrink-0 print:hidden">{actions}</div>}
      </CardHeader>
      <CardContent
        className={cn(
          "min-w-0 flex-1",
          flush ? "p-0" : "px-4 pb-4 pt-0 sm:px-5 sm:pb-5",
          bodyClassName,
        )}
      >
        {children}
      </CardContent>
    </Card>
  );
}
