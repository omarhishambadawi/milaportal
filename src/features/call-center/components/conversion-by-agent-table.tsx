import { memo } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { cn } from "@/lib/utils";
import { fmtSAR } from "@/lib/branches";

export interface ConversionAgentRow {
  agentId: string;
  name: string;
  ext: string;
  answered: number;
  ordersTotal: number;
  ordersCompleted: number;
  conversionRate: number;
  revenue: number;
  revenuePerCall: number;
}

const TH = "px-3 py-2.5 font-medium whitespace-nowrap first:pl-4 last:pr-4";
const TD = "px-3 py-3 tabular-nums first:pl-4 last:pr-4";
/** Hairline before the money columns — see the note in the agent table. */
const GROUP_EDGE = "border-l border-border/50";

/**
 * Conversion per telesales agent.
 *
 * Lifted out of the route and given the same chrome as `AgentPerformanceTable`
 * (banded header, roomier rows, a rule before the money columns) so the two
 * tables on this page stop looking like they came from different products. It
 * derives nothing — every figure arrives from the analytics engine's own
 * conversion rows.
 */
export const ConversionByAgentTable = memo(function ConversionByAgentTable({
  rows,
  loading,
}: {
  rows: ConversionAgentRow[];
  loading: boolean;
}) {
  return (
    <Card className="overflow-hidden">
      <CardHeader className="border-b border-border/60 bg-muted/20 px-4 py-3.5">
        <CardTitle className="flex items-baseline gap-2 text-sm font-semibold">
          Conversion by agent
          <span className="rounded-full bg-muted px-2 py-0.5 text-[11px] font-medium tabular-nums text-muted-foreground">
            {rows.length}
          </span>
        </CardTitle>
      </CardHeader>
      <CardContent className="overflow-x-auto p-0">
        <table className="w-full min-w-[760px] text-sm">
          <thead>
            <tr className="border-b border-border/60 text-left text-[11px] uppercase tracking-wide text-muted-foreground">
              <th className={TH}>Ext</th>
              <th className={TH}>Agent</th>
              <th className={cn(TH, "text-right")}>Answered</th>
              <th className={cn(TH, "text-right")}>Orders</th>
              <th className={cn(TH, "text-right")}>Completed</th>
              <th className={cn(TH, "text-right")}>Conversion</th>
              <th className={cn(TH, "text-right", GROUP_EDGE)}>Revenue</th>
              <th className={cn(TH, "text-right")}>Rev / call</th>
            </tr>
          </thead>
          <tbody>
            {loading ? (
              Array.from({ length: 4 }).map((_, i) => (
                <tr key={i}>
                  <td colSpan={8} className="px-4 py-2">
                    <Skeleton className="h-7 w-full" />
                  </td>
                </tr>
              ))
            ) : rows.length === 0 ? (
              <tr>
                <td colSpan={8} className="py-10 text-center text-muted-foreground">
                  No telesales activity in range.
                </td>
              </tr>
            ) : (
              rows.map((c) => (
                <tr
                  key={c.agentId}
                  className="border-b border-border/40 transition-colors last:border-0 hover:bg-muted/40"
                >
                  <td className={cn(TD, "font-mono text-xs text-muted-foreground")}>{c.ext}</td>
                  <td className="px-3 py-3 font-medium first:pl-4">
                    <span className="block min-w-0 truncate">{c.name}</span>
                  </td>
                  <td className={cn(TD, "text-right")}>{c.answered}</td>
                  <td className={cn(TD, "text-right font-medium")}>{c.ordersTotal}</td>
                  <td className={cn(TD, "text-right font-semibold text-success")}>
                    {c.ordersCompleted}
                  </td>
                  <td className={cn(TD, "text-right")}>{c.conversionRate.toFixed(1)}%</td>
                  <td className={cn(TD, "text-right font-medium", GROUP_EDGE)}>
                    {fmtSAR(c.revenue)}
                  </td>
                  <td className={cn(TD, "text-right text-muted-foreground")}>
                    {fmtSAR(c.revenuePerCall)}
                  </td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </CardContent>
    </Card>
  );
});
