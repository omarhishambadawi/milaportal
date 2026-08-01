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
        "flex h-full flex-col overflow-hidden rounded-xl border-border/60",
        // The hover lift is deliberately slow and small. A dashboard is a wall
        // of cards; anything faster reads as the page twitching as the pointer
        // crosses it.
        "shadow-sm transition-shadow duration-300 hover:shadow-md",
        className,
      )}
    >
      <CardHeader className="flex flex-row items-start justify-between gap-3 space-y-0 px-4 py-3.5 sm:px-5">
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
        {actions && <div className="shrink-0">{actions}</div>}
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
