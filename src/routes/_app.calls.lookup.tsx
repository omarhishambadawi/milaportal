/**
 * Call Lookup — paste a number, see who has spoken to them.
 *
 * ---------------------------------------------------------------------------
 * This is not an analytics page
 * ---------------------------------------------------------------------------
 * It answers exactly one question, usually with the customer already on the
 * line: has anyone here dealt with this number before, who was it, and when.
 * So there are no KPIs, no charts, no aggregation and no date filter beyond how
 * far back to look — every one of those would slow down the only interaction
 * that matters, which is type-number-see-history.
 *
 * The query runs on submit rather than on every keystroke. A phone number is
 * pasted or typed in full and is meaningless half-entered, so per-keystroke
 * searching would spend a CDR sweep on each of eleven prefixes to answer a
 * question nobody asked. React Query caches by number + window, so re-checking
 * a number is instant.
 *
 * Access follows the module gate, but this page is deliberately NOT confined to
 * one team — see `UNCONFINED_PAGES` in `calls-access.ts`.
 */
import { useMemo, useState } from "react";
import { createFileRoute } from "@tanstack/react-router";
import { keepPreviousData, useQuery } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import {
  AlertTriangle,
  BadgeDollarSign,
  Headphones,
  PhoneIncoming,
  PhoneOutgoing,
  Search,
  ShieldAlert,
  X,
} from "lucide-react";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import { cn } from "@/lib/utils";
import { useAuth } from "@/lib/auth";
import { canViewCallsPage } from "@/lib/permissions";
import { lookupCallsByNumber, type CallLookupRow } from "@/lib/yeastar.functions";
import { queryKeys } from "@/lib/query-keys";
import { hhmmss } from "@/features/call-center/utils";
import { BUSINESS_TIMEZONE } from "@/lib/timezone";

/** How far back to sweep. Longer windows cost a bigger CDR fetch. */
const WINDOWS = [
  { value: "7", label: "Last 7 days" },
  { value: "30", label: "Last 30 days" },
  { value: "90", label: "Last 90 days" },
] as const;

export const Route = createFileRoute("/_app/calls/lookup")({
  head: () => ({ meta: [{ title: "Call Lookup — MilaServ Portal" }] }),
  component: CallLookupPage,
});

function CallLookupPage() {
  const { role, profile, loading: authLoading } = useAuth();
  const canView = canViewCallsPage(role, profile?.permissions as any, "lookup");
  const lookupFn = useServerFn(lookupCallsByNumber);

  // `draft` is what the input holds; `query` is what has actually been asked
  // for. Keeping them apart is what makes this submit-driven rather than
  // keystroke-driven — see the note at the top.
  const [draft, setDraft] = useState("");
  const [days, setDays] = useState<string>("30");
  const [query, setQuery] = useState<{ number: string; days: number } | null>(null);

  const q = useQuery({
    queryKey: queryKeys.callCenter.lookup(query?.number ?? "", query?.days ?? 0),
    queryFn: () => lookupFn({ data: { number: query!.number, days: query!.days } }),
    enabled: !authLoading && canView && query != null,
    // A number's history for a closed window does not change while you look at
    // it. No polling, no refetch on focus — this is a point lookup.
    staleTime: 5 * 60_000,
    placeholderData: keepPreviousData,
    refetchOnWindowFocus: false,
    refetchOnMount: false,
  });

  const result = q.data;
  const rows = useMemo(() => result?.rows ?? [], [result]);

  // Who handled them most recently — the single most-asked question, so it is
  // answered above the table rather than found in it.
  const lastHandled = useMemo(() => rows.find((r) => r.agentName), [rows]);

  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    const trimmed = draft.trim();
    if (!trimmed) return;
    setQuery({ number: trimmed, days: Number(days) });
  };

  const clear = () => {
    setDraft("");
    setQuery(null);
  };

  if (!authLoading && !canView) {
    return (
      <div className="py-16 text-center">
        <ShieldAlert className="mx-auto h-10 w-10 text-destructive" />
        <p className="mt-2 text-sm text-muted-foreground">You don't have access to Call Lookup.</p>
      </div>
    );
  }

  return (
    <div className="space-y-5">
      <div className="min-w-0">
        <h1 className="text-2xl font-semibold tracking-tight sm:text-3xl">Call Lookup</h1>
        <p className="text-xs text-muted-foreground sm:text-sm">
          Paste a customer's number to see who has spoken to them, and when.
        </p>
      </div>

      <Card>
        <CardContent className="p-4">
          <form onSubmit={submit} className="flex flex-wrap items-center gap-2">
            <div className="relative min-w-0 flex-1 sm:min-w-[18rem]">
              <Search
                className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground"
                aria-hidden="true"
              />
              <Input
                value={draft}
                onChange={(e) => setDraft(e.target.value)}
                placeholder="e.g. 0501234567"
                aria-label="Phone number"
                inputMode="tel"
                autoComplete="off"
                autoFocus
                className="h-10 pl-9 pr-9 font-mono"
              />
              {draft && (
                <button
                  type="button"
                  onClick={clear}
                  aria-label="Clear"
                  className="absolute right-2 top-1/2 grid h-6 w-6 -translate-y-1/2 place-items-center rounded text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
                >
                  <X className="h-3.5 w-3.5" />
                </button>
              )}
            </div>
            <Select value={days} onValueChange={setDays}>
              <SelectTrigger className="h-10 w-[150px]">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {WINDOWS.map((w) => (
                  <SelectItem key={w.value} value={w.value}>
                    {w.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <Button type="submit" disabled={!draft.trim() || q.isFetching} className="h-10">
              {q.isFetching ? "Searching…" : "Search"}
            </Button>
          </form>

          <p className="mt-2 text-[11px] leading-snug text-muted-foreground">
            Matched on the last 9 digits, so the country code and a leading zero do not have to
            match.
          </p>
        </CardContent>
      </Card>

      {q.error && (
        <Card>
          <CardContent className="flex items-center gap-2 p-4 text-sm text-muted-foreground">
            <AlertTriangle className="h-4 w-4 shrink-0 text-destructive" />
            {q.error instanceof Error ? q.error.message : "The lookup failed."}
          </CardContent>
        </Card>
      )}

      {result && !result.ok && (
        <Card>
          <CardContent className="flex items-center gap-2 p-4 text-sm text-muted-foreground">
            <AlertTriangle className="h-4 w-4 shrink-0 text-warning" />
            {result.error ??
              (result.configured
                ? "The lookup could not be completed."
                : "Call data is not configured yet.")}
          </CardContent>
        </Card>
      )}

      {q.isFetching && !result && <ResultsSkeleton />}

      {result?.ok && (
        <>
          {/* The headline answer, before the detail. */}
          {lastHandled ? (
            <Card>
              <CardContent className="flex flex-wrap items-center gap-x-6 gap-y-2 p-4">
                <div className="min-w-0">
                  <p className="text-[11px] uppercase tracking-wide text-muted-foreground">
                    Last handled by
                  </p>
                  <p className="mt-0.5 flex items-center gap-2 text-base font-semibold">
                    {lastHandled.agentName}
                    <TeamBadge team={lastHandled.team} />
                  </p>
                </div>
                <div className="min-w-0">
                  <p className="text-[11px] uppercase tracking-wide text-muted-foreground">When</p>
                  <p className="mt-0.5 text-base font-semibold tabular-nums">
                    {formatWhen(lastHandled.startedAt)}
                  </p>
                </div>
                <div className="min-w-0">
                  <p className="text-[11px] uppercase tracking-wide text-muted-foreground">
                    Calls found
                  </p>
                  <p className="mt-0.5 text-base font-semibold tabular-nums">{rows.length}</p>
                </div>
              </CardContent>
            </Card>
          ) : rows.length > 0 ? (
            <Card className="border-dashed">
              <CardContent className="p-4 text-sm text-muted-foreground">
                {rows.length} call{rows.length === 1 ? "" : "s"} found, but no agent answered any of
                them.
              </CardContent>
            </Card>
          ) : null}

          {rows.length === 0 ? (
            <Card className="border-dashed">
              <CardContent className="p-10 text-center text-sm text-muted-foreground">
                No calls with <span className="font-mono">{result.normalized}</span> in the last{" "}
                {result.window.days} days.
              </CardContent>
            </Card>
          ) : (
            <ResultsTable rows={rows} truncated={result.truncated} />
          )}
        </>
      )}

      {!result && !q.isFetching && (
        <Card className="border-dashed">
          <CardContent className="p-10 text-center text-sm text-muted-foreground">
            Enter a number above to search the call history.
          </CardContent>
        </Card>
      )}
    </div>
  );
}

const TH = "px-3 py-2.5 font-medium whitespace-nowrap first:pl-4 last:pr-4";
const TD = "px-3 py-3 first:pl-4 last:pr-4";

function ResultsTable({ rows, truncated }: { rows: CallLookupRow[]; truncated: boolean }) {
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
              <tr
                key={r.callId}
                className="border-b border-border/40 transition-colors last:border-0 hover:bg-muted/40"
              >
                <td className={cn(TD, "whitespace-nowrap tabular-nums")}>
                  {formatWhen(r.startedAt)}
                </td>
                <td className={TD}>
                  <DirectionBadge direction={r.direction} />
                </td>
                <td className={cn(TD, "font-medium")}>
                  {r.agentName ?? <span className="text-muted-foreground">—</span>}
                </td>
                <td className={TD}>
                  <TeamBadge team={r.team} />
                </td>
                <td className={cn(TD, "font-mono text-xs text-muted-foreground")}>
                  {r.agentExt ?? "—"}
                </td>
                <td className={cn(TD, "font-mono text-xs text-muted-foreground")}>
                  {r.queueNumber ?? "—"}
                </td>
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
}

function ResultsSkeleton() {
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

function TeamBadge({ team }: { team: CallLookupRow["team"] }) {
  if (!team) return <span className="text-muted-foreground">—</span>;
  const care = team === "customer_care";
  const Icon = care ? Headphones : BadgeDollarSign;
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
 * Epoch seconds → a readable local instant, in the business timezone.
 *
 * The PBX can omit a timestamp; that must render as a dash rather than as
 * "1 Jan 1970", which reads like real history for a call that has none.
 */
function formatWhen(startedAt: number | null): string {
  if (startedAt == null) return "—";
  return new Date(startedAt * 1000).toLocaleString(undefined, {
    timeZone: BUSINESS_TIMEZONE,
    day: "numeric",
    month: "short",
    year: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}
