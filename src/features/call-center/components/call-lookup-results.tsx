import { memo } from "react";
import { Headphones, PhoneIncoming, PhoneOutgoing } from "lucide-react";
import { Card, CardContent } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { cn } from "@/lib/utils";
import { hhmmss } from "@/features/call-center/utils";
import { BUSINESS_TIMEZONE } from "@/lib/timezone";
import type { CallLookupRow } from "@/lib/yeastar.functions";

/**
 * How a call-lookup result is drawn.
 *
 * Lifted out of `/calls/lookup` unchanged when the CRM lead page needed the
 * same table. Two copies of this would be two vocabularies for the same PBX
 * data — the same call reading "No answer" on one screen and "Failed" on
 * another — which is exactly the drift `OUTCOME_LABELS` exists to prevent.
 *
 * Nothing here fetches. The rows arrive from `lookupCallsByNumber`, which stays
 * the one lookup implementation; this module only renders what it returned.
 */

const TH = "px-3 py-2.5 font-medium whitespace-nowrap first:pl-4 last:pr-4";
const TD = "px-3 py-3 first:pl-4 last:pr-4";

/**
 * One row, memoized.
 *
 * Rows are immutable values keyed by `callId`, so a re-render of the page that
 * did not change the data — a keystroke in the search box, most commonly — can
 * skip all of them. Without this, every character typed re-rendered up to 200
 * rows and their four badges each.
 */
const ResultRow = memo(function ResultRow({ r }: { r: CallLookupRow }) {
  return (
    <tr className="border-b border-border/40 transition-colors last:border-0 hover:bg-muted/40">
      <td className={cn(TD, "whitespace-nowrap tabular-nums")}>{formatWhen(r.startedAt)}</td>
      <td className={TD}>
        <DirectionBadge direction={r.direction} />
      </td>
      <td className={cn(TD, "font-medium")}>
        {r.agentName ?? <span className="text-muted-foreground">—</span>}
      </td>
      <td className={TD}>
        <TeamBadge team={r.team} />
      </td>
      <td className={cn(TD, "font-mono text-xs text-muted-foreground")}>{r.agentExt ?? "—"}</td>
      <td className={cn(TD, "font-mono text-xs text-muted-foreground")}>{r.queueNumber ?? "—"}</td>
      <td className={TD}>
        <OutcomeBadge outcome={r.outcome} />
      </td>
      <td className={cn(TD, "text-right tabular-nums")}>
        {hhmmss(r.talkSeconds)}
        {r.waitSeconds != null && r.waitSeconds > 0 && (
          <span className="block text-[11px] text-muted-foreground">
            waited {hhmmss(r.waitSeconds)}
          </span>
        )}
      </td>
    </tr>
  );
});

export const ResultsTable = memo(function ResultsTable({
  rows,
  truncated,
}: {
  rows: CallLookupRow[];
  truncated: boolean;
}) {
  return (
    <Card className="overflow-hidden">
      <CardContent className="overflow-x-auto p-0">
        <table className="w-full min-w-[860px] text-sm">
          <thead>
            <tr className="border-b border-border/60 bg-muted/20 text-left text-[11px] uppercase tracking-wide text-muted-foreground">
              <th className={TH}>When</th>
              <th className={TH}>Direction</th>
              <th className={TH}>Agent</th>
              <th className={TH}>Team</th>
              <th className={TH}>Ext</th>
              <th className={TH}>Queue</th>
              <th className={TH}>Status</th>
              <th className={cn(TH, "text-right")}>Duration</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <ResultRow key={r.callId} r={r} />
            ))}
          </tbody>
        </table>
        {truncated && (
          <div className="border-t border-border/60 bg-muted/20 px-4 py-2.5 text-[11px] text-muted-foreground">
            Showing the most recent calls only — this number has more history than the lookup
            returns. Narrow the window to see a specific period.
          </div>
        )}
      </CardContent>
    </Card>
  );
});

export function ResultsSkeleton() {
  return (
    <Card>
      <CardContent className="space-y-2 p-4">
        {Array.from({ length: 6 }).map((_, i) => (
          <Skeleton key={i} className="h-9 w-full" />
        ))}
      </CardContent>
    </Card>
  );
}

function DirectionBadge({ direction }: { direction: CallLookupRow["direction"] }) {
  const inbound = direction === "Inbound";
  const Icon = inbound ? PhoneIncoming : PhoneOutgoing;
  return (
    <span
      className={cn(
        "inline-flex items-center gap-1.5 whitespace-nowrap rounded-full px-2 py-0.5 text-[11px] font-medium",
        inbound ? "bg-success/10 text-success" : "bg-primary/10 text-primary",
      )}
    >
      <Icon className="h-3 w-3" aria-hidden="true" />
      {direction}
    </span>
  );
}

export function TeamBadge({ team }: { team: CallLookupRow["team"] }) {
  if (!team) return <span className="text-muted-foreground">—</span>;
  const care = team === "customer_care";
  const Icon = care ? Headphones : PhoneOutgoing;
  return (
    <span className="inline-flex items-center gap-1.5 whitespace-nowrap rounded-full bg-muted px-2 py-0.5 text-[11px] font-medium text-muted-foreground">
      <Icon className="h-3 w-3" aria-hidden="true" />
      {care ? "Customer Care" : "Telesales"}
    </span>
  );
}

/**
 * The normalizer's own outcome vocabulary, made readable.
 *
 * Deliberately exhaustive over the values `NormalizedCall.outcome` and
 * `.exclusion` can carry, so a new one shows up as its raw key rather than
 * silently rendering as "Answered".
 */
const OUTCOME_LABELS: Record<string, { label: string; tone: "good" | "bad" | "warn" | "muted" }> = {
  answered: { label: "Answered", tone: "good" },
  missed: { label: "Missed", tone: "bad" },
  abandoned: { label: "Abandoned", tone: "warn" },
  ivr_only: { label: "IVR only", tone: "muted" },
  no_answer_outbound: { label: "No answer", tone: "bad" },
  cancelled_by_agent: { label: "Agent cancelled", tone: "bad" },
  busy: { label: "Busy", tone: "warn" },
  failed: { label: "Failed", tone: "bad" },
  voicemail: { label: "Voicemail", tone: "muted" },
  after_hours: { label: "After hours", tone: "muted" },
  queue_closed: { label: "Queue closed", tone: "muted" },
  system_event: { label: "System", tone: "muted" },
  internal: { label: "Internal", tone: "muted" },
};

function OutcomeBadge({ outcome }: { outcome: string }) {
  const meta = OUTCOME_LABELS[outcome] ?? { label: outcome, tone: "muted" as const };
  return (
    <span
      className={cn(
        "inline-flex whitespace-nowrap rounded-full px-2 py-0.5 text-[11px] font-medium",
        meta.tone === "good" && "bg-success/10 text-success",
        meta.tone === "bad" && "bg-destructive/10 text-destructive",
        meta.tone === "warn" && "bg-warning/15 text-warning-foreground",
        meta.tone === "muted" && "bg-muted text-muted-foreground",
      )}
    >
      {meta.label}
    </span>
  );
}

/**
 * One formatter, built once.
 *
 * `toLocaleString` with an options bag constructs a fresh `Intl.DateTimeFormat`
 * on every call, and this runs once per row — at the 200-row cap that was 200
 * formatter constructions per render, which is the single most expensive thing
 * the table did. Hoisting it makes the same work a lookup.
 */
const WHEN_FORMAT = new Intl.DateTimeFormat(undefined, {
  timeZone: BUSINESS_TIMEZONE,
  day: "numeric",
  month: "short",
  year: "numeric",
  hour: "numeric",
  minute: "2-digit",
});

/**
 * Epoch seconds → a readable local instant, in the business timezone.
 *
 * The PBX can omit a timestamp; that must render as a dash rather than as
 * "1 Jan 1970", which reads like real history for a call that has none.
 */
export function formatWhen(startedAt: number | null): string {
  if (startedAt == null) return "—";
  return WHEN_FORMAT.format(new Date(startedAt * 1000));
}
