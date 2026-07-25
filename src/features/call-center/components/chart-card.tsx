import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";

export function ChartCard({ title, loading, hasData, children }: { title: string; loading?: boolean; hasData?: boolean; children: React.ReactNode }) {
  return (
    <Card>
      <CardHeader className="pb-2"><CardTitle className="text-sm font-semibold">{title}</CardTitle></CardHeader>
      <CardContent className="h-64">
        {loading ? (
          <Skeleton className="h-full w-full" />
        ) : !hasData ? (
          <div className="h-full flex items-center justify-center text-xs text-muted-foreground">No data</div>
        ) : children}
      </CardContent>
    </Card>
  );
}
