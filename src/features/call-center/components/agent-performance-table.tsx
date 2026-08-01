import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import { hhmmss } from "../utils";
import type { MetricSource } from "@/lib/yeastar/metrics-engine";

export interface AgentRow {
  agentId: string;
  name: string;
  ext: string;
  total: number;
  inbound: number;
  outbound: number;
  answered: number;
  noAnswerOutbound: number;
  busy: number;
  failed: number;
  talkSeconds: number;
  avgTalkSec: number;
  avgRingSec: number;
  longestSec: number;
  answerRate: number;
  /**
   * Queue mode only: the agent's phone rang and they did not pick up.
   *
   * Supplied by the Metrics Engine from Yeastar's Call Report — CDR cannot
   * produce it, because this firmware writes an agent-leg row only when the
   * agent answers. `missedSource` says whether the value is real; when it is
   * not, the cell renders "—" rather than a zero that would read as "missed
   * nothing".
   */
  missedCalls?: number;
  missedSource?: MetricSource;
}

interface AgentPerformanceTableProps {
  rows: AgentRow[];
  loading: boolean;
  search: string;
  onSearch: (v: string) => void;
  /**
   * Which columns to show. Customer Care is queue-driven, so it reports the
   * agent's own unanswered ring and how long the phone rang. Telesales is
   * extension-driven and dials out, so it reports call outcomes instead.
   */
  mode: "customer_care" | "telesales";
}

/**
 * Agent performance table, shared by both dashboards.
 *
 * The rows are identical — they come from the same analytics engine — only the
 * columns differ, because the two workflows are judged on different things.
 */
export function AgentPerformanceTable({
  rows,
  loading,
  search,
  onSearch,
  mode,
}: AgentPerformanceTableProps) {
  const isQueue = mode === "customer_care";
  const colCount = isQueue ? 12 : 13;

  return (
    <Card>
      <CardHeader className="flex flex-row items-center justify-between">
        <CardTitle className="text-base">Agents ({rows.length})</CardTitle>
        <Input
          placeholder="Search agent or ext…"
          value={search}
          onChange={(e) => onSearch(e.target.value)}
          className="h-8 w-48"
        />
      </CardHeader>
      <CardContent className="p-0 overflow-x-auto">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b text-left text-xs text-muted-foreground">
              <th className="px-3 py-2">Ext</th>
              <th className="px-3 py-2">Agent</th>
              <th className="px-3 py-2 text-right">Total</th>
              <th className="px-3 py-2 text-right">Answered</th>
              {isQueue ? (
                <th className="px-3 py-2 text-right">Missed*</th>
              ) : (
                <>
                  <th className="px-3 py-2 text-right">No answer</th>
                  <th className="px-3 py-2 text-right">Busy</th>
                  <th className="px-3 py-2 text-right">Failed</th>
                </>
              )}
              <th className="px-3 py-2 text-right">In</th>
              <th className="px-3 py-2 text-right">Out</th>
              <th className="px-3 py-2 text-right">Answer %</th>
              <th className="px-3 py-2 text-right">Talk</th>
              <th className="px-3 py-2 text-right">Avg talk</th>
              {isQueue && <th className="px-3 py-2 text-right">Avg ring (answered)</th>}
              <th className="px-3 py-2 text-right">Longest</th>
            </tr>
          </thead>
          <tbody>
            {loading ? (
              Array.from({ length: 5 }).map((_, i) => (
                <tr key={i}>
                  <td colSpan={colCount} className="p-2">
                    <Skeleton className="h-6 w-full" />
                  </td>
                </tr>
              ))
            ) : rows.length === 0 ? (
              <tr>
                <td colSpan={colCount} className="text-center text-muted-foreground py-6">
                  No agents matched.
                </td>
              </tr>
            ) : (
              rows.map((agent) => (
                <tr key={agent.agentId} className="border-b last:border-0">
                  <td className="px-3 py-2 font-mono text-xs">{agent.ext}</td>
                  <td className="px-3 py-2 font-medium">{agent.name}</td>
                  <td className="px-3 py-2 text-right tabular-nums">{agent.total}</td>
                  <td className="px-3 py-2 text-right tabular-nums font-semibold text-success">
                    {agent.answered}
                  </td>
                  {isQueue ? (
                    <td className="px-3 py-2 text-right tabular-nums text-destructive">
                      {agent.missedSource === "call_report" ? (
                        agent.missedCalls
                      ) : (
                        <span
                          className="text-muted-foreground"
                          title="Unavailable for this filter — Yeastar's Call Report is the only source for this figure."
                        >
                          —
                        </span>
                      )}
                    </td>
                  ) : (
                    <>
                      <td className="px-3 py-2 text-right tabular-nums text-muted-foreground">
                        {agent.noAnswerOutbound}
                      </td>
                      <td className="px-3 py-2 text-right tabular-nums text-muted-foreground">
                        {agent.busy}
                      </td>
                      <td className="px-3 py-2 text-right tabular-nums text-muted-foreground">
                        {agent.failed}
                      </td>
                    </>
                  )}
                  <td className="px-3 py-2 text-right tabular-nums">{agent.inbound}</td>
                  <td className="px-3 py-2 text-right tabular-nums">{agent.outbound}</td>
                  <td className="px-3 py-2 text-right tabular-nums">
                    {agent.answerRate.toFixed(1)}%
                  </td>
                  <td className="px-3 py-2 text-right tabular-nums">{hhmmss(agent.talkSeconds)}</td>
                  <td className="px-3 py-2 text-right tabular-nums">{hhmmss(agent.avgTalkSec)}</td>
                  {isQueue && (
                    <td className="px-3 py-2 text-right tabular-nums">
                      {hhmmss(agent.avgRingSec)}
                    </td>
                  )}
                  <td className="px-3 py-2 text-right tabular-nums">{hhmmss(agent.longestSec)}</td>
                </tr>
              ))
            )}
          </tbody>
        </table>
        {isQueue && (
          <div className="px-3 py-2 text-[11px] text-muted-foreground">
            *Missed = the agent's own ring went unanswered, sourced from Yeastar's Call Report.
            Individual performance metric only — not summed into the platform Missed KPI (the queue
            auto-forwards to the next available agent). A dash means the figure is unavailable for
            the current filter, not zero.
          </div>
        )}
      </CardContent>
    </Card>
  );
}
