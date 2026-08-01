import { Star } from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import { cn } from "@/lib/utils";
import { hhmmss } from "../utils";
import type { AgentHighlights, MetricSource } from "@/lib/yeastar/metrics-engine";

/**
 * DOM id of one agent's row, so callers elsewhere on the page can scroll to it.
 *
 * Exported rather than inlined because the Queue Members chips build the same
 * id to find their target — two hand-written templates would drift the first
 * time either side changed.
 */
export const agentRowId = (ext: string) => `agent-row-${ext}`;

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
  /**
   * Ranking and per-column leaders, from the Metrics Engine. Omit to render the
   * table flat — the component ranks nothing itself.
   */
  highlights?: AgentHighlights;
  /**
   * Extension to call attention to, e.g. after a Queue Members chip was
   * clicked. Purely visual and expected to clear itself after a few seconds —
   * it filters nothing and must never change what the table contains.
   */
  highlightExt?: string | null;
}

/** `#1` beside the agent's name. Silver and bronze are deliberately quieter. */
function RankBadge({ rank }: { rank: number }) {
  return (
    <span
      title={`#${rank} by calls answered`}
      className={cn(
        "inline-flex h-[18px] min-w-[22px] items-center justify-center rounded-full px-1 text-[10px] font-semibold tabular-nums",
        rank === 1
          ? "bg-primary/15 text-primary"
          : "bg-muted text-muted-foreground ring-1 ring-inset ring-border",
      )}
    >
      #{rank}
    </span>
  );
}

/**
 * The single best performer, called out beside their name.
 *
 * Sits alongside the `#1` badge rather than replacing it: the badge says where
 * they placed in the ranking, this says the ranking is worth reading. Kept to a
 * star and a word so it does not compete with the numbers it is describing.
 */
function TopPerformerBadge() {
  return (
    <span
      title="Top performer — most calls answered from the queue"
      className="inline-flex shrink-0 items-center gap-1 rounded-full bg-primary/10 px-2 py-0.5 text-[10px] font-medium uppercase tracking-wide text-primary"
    >
      <Star className="h-3 w-3 fill-current" aria-hidden="true" />
      Top performer
    </span>
  );
}

/** A leading value, wrapped in a quiet pill so the eye finds it in the column. */
function Leader({
  children,
  title,
  tone,
}: {
  children: React.ReactNode;
  title: string;
  tone: "success" | "primary";
}) {
  return (
    <span
      title={title}
      className={cn(
        "inline-flex items-center rounded px-1.5 py-0.5 font-semibold",
        tone === "success" ? "bg-success/10 text-success" : "bg-primary/10 text-primary",
      )}
    >
      {children}
    </span>
  );
}

const TH = "px-3 py-2.5 font-medium whitespace-nowrap";
const TD = "px-3 py-2.5 tabular-nums";

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
  highlights,
  highlightExt,
}: AgentPerformanceTableProps) {
  const isQueue = mode === "customer_care";
  const colCount = isQueue ? 12 : 13;

  return (
    <Card>
      <CardHeader className="flex flex-row items-center justify-between gap-3 space-y-0 py-4">
        <div className="min-w-0">
          <CardTitle className="text-base">Agents ({rows.length})</CardTitle>
          {isQueue && highlights && Object.keys(highlights.ranks).length > 0 && (
            <p className="mt-0.5 text-xs text-muted-foreground">
              #1–#3 rank by queue answered; leading values are highlighted in their column.
            </p>
          )}
        </div>
        <Input
          placeholder="Search agent or ext…"
          value={search}
          onChange={(e) => onSearch(e.target.value)}
          className="h-8 w-40 shrink-0 sm:w-48"
        />
      </CardHeader>
      <CardContent className="overflow-x-auto p-0">
        {/* A min-width makes the container actually scroll on a narrow screen.
            Without it `w-full` just crushes twelve columns into the viewport
            and every number ends up wrapped. */}
        <table className="w-full min-w-[920px] text-sm">
          <thead>
            <tr className="border-b bg-muted/30 text-left text-xs text-muted-foreground">
              <th className={TH}>Ext</th>
              <th className={TH}>Agent</th>
              <th className={cn(TH, "text-right")}>Total</th>
              <th className={cn(TH, "text-right")}>{isQueue ? "Queue answered" : "Answered"}</th>
              {isQueue ? (
                <th className={cn(TH, "text-right")}>Missed*</th>
              ) : (
                <>
                  <th className={cn(TH, "text-right")}>No answer</th>
                  <th className={cn(TH, "text-right")}>Busy</th>
                  <th className={cn(TH, "text-right")}>Failed</th>
                </>
              )}
              <th className={cn(TH, "text-right")}>In</th>
              <th className={cn(TH, "text-right")}>Out</th>
              <th className={cn(TH, "text-right")}>Answer rate</th>
              <th className={cn(TH, "text-right")}>Talk time</th>
              <th className={cn(TH, "text-right")}>Avg talk</th>
              {isQueue && <th className={cn(TH, "text-right")}>Avg ring (answered)</th>}
              <th className={cn(TH, "text-right")}>Longest</th>
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
                <td colSpan={colCount} className="py-6 text-center text-muted-foreground">
                  No agents matched.
                </td>
              </tr>
            ) : (
              rows.map((agent) => {
                const rank = highlights?.ranks[agent.agentId];
                const topAnswered = highlights?.topAnsweredId === agent.agentId;
                const topRate = highlights?.topAnswerRateId === agent.agentId;
                const topTalk = highlights?.topTalkTimeId === agent.agentId;
                const flagged = highlightExt != null && highlightExt === agent.ext;
                return (
                  <tr
                    key={agent.agentId}
                    id={agentRowId(agent.ext)}
                    // `scroll-mt` keeps the sticky page chrome off the row when
                    // something scrolls it into view.
                    className={cn(
                      "scroll-mt-24 border-b transition-colors duration-500 last:border-0",
                      flagged ? "bg-primary/10" : "hover:bg-muted/40",
                    )}
                  >
                    <td className={cn(TD, "font-mono text-xs text-muted-foreground")}>
                      {agent.ext}
                    </td>
                    <td className="px-3 py-2.5 font-medium">
                      {/* `min-w-0` is what lets the name actually truncate —
                          a flex child defaults to min-width:auto and would
                          instead push the badges out of the cell. */}
                      <span className="flex items-center gap-2">
                        {rank ? <RankBadge rank={rank} /> : null}
                        <span className="min-w-0 truncate">{agent.name}</span>
                        {rank === 1 && <TopPerformerBadge />}
                      </span>
                    </td>
                    <td className={cn(TD, "text-right")}>{agent.total}</td>
                    <td className={cn(TD, "text-right")}>
                      {topAnswered ? (
                        <Leader tone="success" title="Most calls answered">
                          {agent.answered}
                        </Leader>
                      ) : (
                        <span className="font-semibold text-success">{agent.answered}</span>
                      )}
                    </td>
                    {isQueue ? (
                      <td className={cn(TD, "text-right text-destructive")}>
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
                        <td className={cn(TD, "text-right text-muted-foreground")}>
                          {agent.noAnswerOutbound}
                        </td>
                        <td className={cn(TD, "text-right text-muted-foreground")}>{agent.busy}</td>
                        <td className={cn(TD, "text-right text-muted-foreground")}>
                          {agent.failed}
                        </td>
                      </>
                    )}
                    <td className={cn(TD, "text-right")}>{agent.inbound}</td>
                    <td className={cn(TD, "text-right")}>{agent.outbound}</td>
                    <td className={cn(TD, "text-right")}>
                      {topRate ? (
                        <Leader tone="primary" title="Highest answer rate">
                          {agent.answerRate.toFixed(1)}%
                        </Leader>
                      ) : (
                        `${agent.answerRate.toFixed(1)}%`
                      )}
                    </td>
                    <td className={cn(TD, "text-right")}>
                      {topTalk ? (
                        <Leader tone="primary" title="Most time on calls">
                          {hhmmss(agent.talkSeconds)}
                        </Leader>
                      ) : (
                        hhmmss(agent.talkSeconds)
                      )}
                    </td>
                    <td className={cn(TD, "text-right")}>{hhmmss(agent.avgTalkSec)}</td>
                    {isQueue && (
                      <td className={cn(TD, "text-right text-muted-foreground")}>
                        {hhmmss(agent.avgRingSec)}
                      </td>
                    )}
                    <td className={cn(TD, "text-right text-muted-foreground")}>
                      {hhmmss(agent.longestSec)}
                    </td>
                  </tr>
                );
              })
            )}
          </tbody>
        </table>
        {isQueue && (
          <div className="border-t px-3 py-2 text-[11px] leading-snug text-muted-foreground">
            *Missed = the agent's own ring went unanswered, sourced from Yeastar's Call Report.
            Individual performance metric only — not summed into the Queue Missed KPI (the queue
            auto-forwards to the next available agent). A dash means the figure is unavailable for
            the current filter, not zero.
          </div>
        )}
      </CardContent>
    </Card>
  );
}
