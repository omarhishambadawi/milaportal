import { memo } from "react";
import { Star } from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { cn } from "@/lib/utils";
import { hhmmss } from "../utils";
import { INBOUND } from "./chart-primitives";

export interface TopAgentRow {
  agentId: string;
  name: string;
  ext: string;
  answered: number;
  total: number;
  answerRate: number;
  talkSeconds: number;
}

/**
 * The leaderboard, as a ranked list rather than a chart.
 *
 * A bar chart of agent names is the obvious choice and the wrong one: the names
 * are long, there are a dozen of them, and the question is "who is at the top",
 * which a sorted list answers without an axis. The bar behind each row carries
 * the relative volume that a chart would have carried.
 *
 * Ranking is a derivation, so it is NOT performed here — `rows` arrives already
 * ordered and truncated by the page's own memo, which reads the analytics
 * engine's agent list. This component draws what it is given.
 */
export const TopAgents = memo(function TopAgents({
  rows,
  loading,
  title = "Top agents",
  subtitle = "By calls answered in the selected window.",
}: {
  rows: TopAgentRow[];
  loading: boolean;
  title?: string;
  subtitle?: string;
}) {
  const peak = Math.max(1, ...rows.map((r) => r.answered));

  return (
    <Card className="h-full overflow-hidden">
      <CardHeader className="border-b border-border/60 bg-muted/20 px-4 py-3.5">
        <CardTitle className="text-sm font-semibold">{title}</CardTitle>
        <p className="text-xs leading-snug text-muted-foreground">{subtitle}</p>
      </CardHeader>
      <CardContent className="p-0">
        {loading ? (
          <div className="space-y-2 p-4">
            {Array.from({ length: 5 }).map((_, i) => (
              <Skeleton key={i} className="h-9 w-full" />
            ))}
          </div>
        ) : rows.length === 0 ? (
          <p className="py-10 text-center text-sm text-muted-foreground">
            No agent handled a call in this window.
          </p>
        ) : (
          <ol className="divide-y divide-border/40">
            {rows.map((a, i) => (
              <li
                key={a.agentId}
                className="relative flex items-center gap-3 px-4 py-3 transition-colors hover:bg-muted/40"
              >
                {/* The volume bar sits behind the row rather than beside it, so
                    the numbers keep their own column and stay aligned. */}
                <span
                  className="pointer-events-none absolute inset-y-0 left-0 opacity-[0.07]"
                  style={{ width: `${(a.answered / peak) * 100}%`, background: INBOUND }}
                  aria-hidden="true"
                />
                <span
                  className={cn(
                    "relative grid h-6 w-6 shrink-0 place-items-center rounded-md text-[11px] font-semibold tabular-nums",
                    i === 0
                      ? "bg-primary/15 text-primary ring-1 ring-inset ring-primary/25"
                      : "bg-muted text-muted-foreground ring-1 ring-inset ring-border",
                  )}
                >
                  {i + 1}
                </span>
                <span className="relative min-w-0 flex-1">
                  <span className="flex items-center gap-1.5">
                    <span className="min-w-0 truncate text-sm font-medium">{a.name}</span>
                    {i === 0 && (
                      <Star
                        className="h-3 w-3 shrink-0 fill-current text-primary"
                        aria-label="Top performer"
                      />
                    )}
                  </span>
                  <span className="block font-mono text-[11px] text-muted-foreground">
                    ext {a.ext}
                  </span>
                </span>
                <span className="relative shrink-0 text-right">
                  <span className="block text-sm font-semibold tabular-nums text-success">
                    {a.answered}
                  </span>
                  <span className="block text-[11px] tabular-nums text-muted-foreground">
                    {a.answerRate.toFixed(0)}% · {hhmmss(a.talkSeconds)}
                  </span>
                </span>
              </li>
            ))}
          </ol>
        )}
      </CardContent>
    </Card>
  );
});
