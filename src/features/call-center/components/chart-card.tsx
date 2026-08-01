import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { cn } from "@/lib/utils";

export function ChartCard({
  title,
  subtitle,
  loading,
  hasData,
  /** Tailwind height for the plot area. Defaults to the original `h-64`. */
  bodyClassName = "h-64",
  children,
}: {
  title: string;
  /** One line under the title, explaining how to read the chart. */
  subtitle?: string;
  loading?: boolean;
  hasData?: boolean;
  bodyClassName?: string;
  children: React.ReactNode;
}) {
  return (
    <Card className="h-full">
      <CardHeader className="space-y-0.5 pb-2">
        <CardTitle className="text-sm font-semibold">{title}</CardTitle>
        {subtitle && <p className="text-xs text-muted-foreground">{subtitle}</p>}
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
