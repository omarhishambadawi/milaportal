import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { cn } from "@/lib/utils";

export function ChartCard({
  title,
  subtitle,
  loading,
  hasData,
  actions,
  /** Tailwind height for the plot area. Defaults to the original `h-64`. */
  bodyClassName = "h-64",
  className,
  children,
}: {
  title: string;
  /** One line under the title, explaining how to read the chart. */
  subtitle?: string;
  loading?: boolean;
  hasData?: boolean;
  /**
   * Right-aligned header content — a legend, a total, a peak. Sits on the title
   * row so the plot area keeps its full height, and wraps under it on a narrow
   * screen rather than squeezing the title.
   */
  actions?: React.ReactNode;
  bodyClassName?: string;
  className?: string;
  children: React.ReactNode;
}) {
  return (
    <Card className={cn("h-full", className)}>
      <CardHeader className="gap-x-4 gap-y-2 space-y-0 pb-2 sm:flex sm:flex-row sm:items-start sm:justify-between">
        <div className="min-w-0 space-y-0.5">
          <CardTitle className="text-sm font-semibold">{title}</CardTitle>
          {subtitle && <p className="text-xs leading-snug text-muted-foreground">{subtitle}</p>}
        </div>
        {actions && <div className="mt-2 shrink-0 sm:mt-0">{actions}</div>}
      </CardHeader>
      <CardContent className={cn("pt-1", bodyClassName)}>
        {loading ? (
          <Skeleton className="h-full w-full" />
        ) : !hasData ? (
          <div className="flex h-full items-center justify-center text-xs text-muted-foreground">
            No data
          </div>
        ) : (
          children
        )}
      </CardContent>
    </Card>
  );
}
