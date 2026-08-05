/**
 * The call list behind the Abandoned and Missed KPIs.
 *
 * ---------------------------------------------------------------------------
 * A drill-down, not a second dashboard
 * ---------------------------------------------------------------------------
 * A supervisor reading "37 abandoned" has one follow-up question — which 37,
 * and did anyone call them back — and this dialog answers exactly that. It
 * derives no metric: `total` and `handled` are counted server-side over the same
 * calls the KPI counted, and every cell is read off a row. The cards keep their
 * own numbers whatever happens here.
 *
 * The two lists are one component because they are the same table over a
 * different outcome: same columns, same follow-up rule, same filters. The only
 * differences are the title and what the wait column is called — a caller who
 * hung up "waited", a caller the queue released was "ringing" — and forking the
 * file to express that would guarantee the two drift.
 *
 * ---------------------------------------------------------------------------
 * Cost
 * ---------------------------------------------------------------------------
 * The query is `enabled` only while the dialog is open, so a page nobody drills
 * into pays nothing. When it does run it reads the classified window the
 * dashboard already built, so on a warm page it costs no PBX request at all —
 * which is what keeps a month-wide drill-down as fast as a day's.
 *
 * Searching, sorting and paging are all client-side over the rows already in
 * hand: the answer is capped and small, and a round-trip per keystroke would be
 * slower than the filter it is asking for.
 */
import { memo, useEffect, useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import {
  AlertTriangle,
  ArrowDown,
  ArrowUp,
  ChevronLeft,
  ChevronRight,
  Headphones,
  PhoneIncoming,
  PhoneOutgoing,
  Search,
  X,
} from "lucide-react";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import { cn } from "@/lib/utils";
import { BUSINESS_TIMEZONE } from "@/lib/timezone";
import { digitsOf } from "@/lib/yeastar/lookup-match";
import type { CallTeam } from "@/lib/yeastar/unanswered";
import { queryKeys } from "@/lib/query-keys";
import {
  getUnansweredCalls,
  type UnansweredCallRow,
  type UnansweredKind,
} from "@/lib/yeastar.functions";
import type { Direction } from "../types";
import { hhmmss } from "../utils";
import { InfoBanner } from "./info-banner";

/** Rows per page. Big enough to scan a shift, small enough to render instantly. */
const PAGE_SIZE = 25;

export interface UnansweredDialogFilters {
  from: string;
  to: string;
  /** Agent id, or "all". */
  agentId: string;
  direction: Direction;
  /** Queue number, or "all". */
  queue: string;
  /** True when the caller may select an agent other than themselves. */
  canAll: boolean;
  canView: boolean;
  authLoading: boolean;
}

const COPY: Record<UnansweredKind, { title: string; blurb: string; wait: string; status: string }> =
  {
    abandoned: {
      title: "Abandoned calls",
      blurb: "Callers who hung up while waiting for an agent.",
      wait: "Waiting",
      status: "Abandoned",
    },
    missed: {
      title: "Missed calls",
      blurb: "Queue calls the queue released without an agent answering.",
      wait: "Ringing",
      status: "Missed",
    },
  };

export function UnansweredCallsDialog({
  open,
  onOpenChange,
  kind,
  filters,
  kpiValue,
  yeastarSplit,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  kind: UnansweredKind;
  filters: UnansweredDialogFilters;
  /** What the card shows, so a divergence can be explained rather than hidden. */
  kpiValue?: number;
  /** True when that card follows Yeastar's Missed/Abandoned split, not CDR's. */
  yeastarSplit?: boolean;
}) {
  const fetchRows = useServerFn(getUnansweredCalls);
  const copy = COPY[kind];

  const [term, setTerm] = useState("");
  const [newestFirst, setNewestFirst] = useState(true);
  const [page, setPage] = useState(0);

  const q = useQuery({
    queryKey: queryKeys.callCenter.unanswered({
      from: filters.from,
      to: filters.to,
      kind,
      agentId: filters.agentId,
      direction: filters.direction,
      queue: filters.queue,
    }),
    queryFn: () =>
      fetchRows({
        data: {
          from: filters.from,
          to: filters.to,
          kind,
          team: "customer_care" as const,
          agentId: filters.canAll && filters.agentId !== "all" ? filters.agentId : null,
          direction: filters.direction,
          ...(filters.queue && filters.queue !== "all" ? { queue: filters.queue } : {}),
        },
      }),
    // Nothing is fetched until somebody actually opens the drill-down.
    enabled: open && !filters.authLoading && filters.canView,
    // A closed window's list cannot change while it is on screen, and a live
    // one is re-read the next time the dialog opens. No polling: this is a
    // detail view, not a monitor.
    staleTime: 5 * 60_000,
    gcTime: 15 * 60_000,
    refetchOnWindowFocus: false,
    refetchOnMount: false,
    retry: false,
  });

  const result = q.data;
  const allRows = useMemo(() => result?.rows ?? [], [result]);

  // Digits only, so 050-123 4567 and 0501234567 are the same query and a
  // half-typed number still narrows rather than matching nothing.
  const searchDigits = digitsOf(term);
  const rows = useMemo(() => {
    const filtered = searchDigits
      ? allRows.filter((r) => digitsOf(r.customerNumber).includes(searchDigits))
      : allRows;
    // The server sorts newest-first; only the other direction costs a pass.
    return newestFirst ? filtered : [...filtered].reverse();
  }, [allRows, searchDigits, newestFirst]);

  // A narrowed list can be shorter than the page being viewed. Clamping rather
  // than resetting keeps the position when the change did not invalidate it.
  const pageCount = Math.max(1, Math.ceil(rows.length / PAGE_SIZE));
  const safePage = Math.min(page, pageCount - 1);
  useEffect(() => {
    if (page !== safePage) setPage(safePage);
  }, [page, safePage]);

  const visible = rows.slice(safePage * PAGE_SIZE, safePage * PAGE_SIZE + PAGE_SIZE);

  // Reset the transient view state per opening: a search typed last time is not
  // a filter the next drill-down should silently inherit.
  useEffect(() => {
    if (!open) {
      setTerm("");
      setPage(0);
      setNewestFirst(true);
    }
  }, [open]);

  const loading = q.isPending && open;
  const errMsg =
    q.error instanceof Error
      ? q.error.message
      : result && !result.ok
        ? result.configured
          ? "The call details could not be loaded."
          : "Call data is not configured yet."
        : null;

  // The card and this list can legitimately disagree — see the banner copy.
  const divergent =
    result?.ok === true && kpiValue != null && kpiValue !== result.total && !!yeastarSplit;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="flex max-h-[88vh] w-[calc(100vw-1.5rem)] max-w-5xl flex-col gap-0 overflow-hidden p-0">
        <DialogHeader className="space-y-1 border-b border-border/60 px-4 py-3.5 pr-12 text-left sm:px-5">
          <DialogTitle className="text-base sm:text-lg">{copy.title}</DialogTitle>
          <DialogDescription className="text-xs sm:text-sm">
            {copy.blurb} {filters.from} → {filters.to}
            {filters.queue !== "all" && ` · queue ${filters.queue}`}
            {filters.direction !== "all" && ` · ${filters.direction.toLowerCase()}`}
          </DialogDescription>
        </DialogHeader>

        <div className="flex flex-wrap items-center gap-2 border-b border-border/60 px-4 py-2.5 sm:px-5">
          <div className="relative min-w-0 flex-1 sm:max-w-xs">
            <Search
              className="pointer-events-none absolute left-3 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground"
              aria-hidden="true"
            />
            <Input
              value={term}
              onChange={(e) => {
                setTerm(e.target.value);
                setPage(0);
              }}
              placeholder="Search customer number"
              aria-label="Search by customer phone number"
              inputMode="tel"
              autoComplete="off"
              className="h-9 pl-9 pr-8 font-mono text-sm"
            />
            {term && (
              <button
                type="button"
                onClick={() => setTerm("")}
                aria-label="Clear search"
                className="absolute right-2 top-1/2 grid h-6 w-6 -translate-y-1/2 cursor-pointer place-items-center rounded text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
              >
                <X className="h-3.5 w-3.5" />
              </button>
            )}
          </div>
          <Button
            variant="outline"
            size="sm"
            onClick={() => {
              setNewestFirst((v) => !v);
              setPage(0);
            }}
            className="h-9"
            aria-label={`Sort by date, ${newestFirst ? "oldest" : "newest"} first`}
          >
            {newestFirst ? (
              <ArrowDown className="mr-1.5 h-3.5 w-3.5" />
            ) : (
              <ArrowUp className="mr-1.5 h-3.5 w-3.5" />
            )}
            {newestFirst ? "Newest first" : "Oldest first"}
          </Button>
          {result?.ok && (
            <p className="ml-auto text-xs text-muted-foreground">
              <span className="font-medium text-foreground tabular-nums">{result.total}</span> call
              {result.total === 1 ? "" : "s"} ·{" "}
              <span className="font-medium text-foreground tabular-nums">{result.handled}</span>{" "}
              reached later
            </p>
          )}
        </div>

        <div className="min-h-0 flex-1 overflow-y-auto">
          {errMsg && (
            <div className="flex items-center gap-2 px-4 py-4 text-sm text-muted-foreground sm:px-5">
              <AlertTriangle className="h-4 w-4 shrink-0 text-destructive" />
              {errMsg}
            </div>
          )}

          {loading && (
            <div className="space-y-2 p-4 sm:p-5">
              {Array.from({ length: 8 }).map((_, i) => (
                <Skeleton key={i} className="h-10 w-full" />
              ))}
            </div>
          )}

          {result?.ok && !loading && (
            <>
              {(divergent || result.truncated) && (
                <div className="px-4 pt-3 sm:px-5">
                  {divergent && (
                    <InfoBanner
                      summary={`The card reads ${kpiValue} — the PBX labels these calls slightly differently.`}
                    >
                      The Missed and Abandoned cards follow Yeastar's split, which sorts unanswered
                      queue calls by <strong>who ended the call</strong>. This list is built from
                      our own call records, which can only sort them by{" "}
                      <strong>how long the caller waited</strong>. Both describe the same unanswered
                      callers; only the line between the two labels moves, so a caller missing here
                      will be in the other list.
                    </InfoBanner>
                  )}
                  {result.truncated && (
                    <p className="pt-2 text-[11px] text-muted-foreground">
                      Showing the most recent {result.rows.length} of {result.total} calls. Narrow
                      the date range to see the rest.
                    </p>
                  )}
                </div>
              )}

              {rows.length === 0 ? (
                <p className="px-4 py-12 text-center text-sm text-muted-foreground sm:px-5">
                  {allRows.length === 0
                    ? `No ${kind} calls for these filters.`
                    : `No calls matching “${term}”.`}
                </p>
              ) : (
                <>
                  {/* Wide: one row per call. */}
                  <div className="hidden overflow-x-auto sm:block">
                    <table className="w-full min-w-[880px] text-sm">
                      <thead>
                        <tr className="border-b border-border/60 bg-muted/20 text-left text-[11px] uppercase tracking-wide text-muted-foreground">
                          <th className={TH}>When</th>
                          <th className={TH}>Customer</th>
                          <th className={TH}>Queue</th>
                          <th className={cn(TH, "text-right")}>{copy.wait}</th>
                          <th className={TH}>Status</th>
                          <th className={TH}>Handled later</th>
                          <th className={TH}>Agent</th>
                          <th className={TH}>Follow-up</th>
                        </tr>
                      </thead>
                      <tbody>
                        {visible.map((r) => (
                          <CallRow key={r.callId} r={r} status={copy.status} />
                        ))}
                      </tbody>
                    </table>
                  </div>

                  {/* Narrow: the same fields, stacked, so nothing needs scrolling sideways. */}
                  <ul className="divide-y divide-border/40 sm:hidden">
                    {visible.map((r) => (
                      <CallCard key={r.callId} r={r} status={copy.status} waitLabel={copy.wait} />
                    ))}
                  </ul>
                </>
              )}
            </>
          )}
        </div>

        {result?.ok && rows.length > PAGE_SIZE && (
          <div className="flex items-center justify-between gap-2 border-t border-border/60 px-4 py-2.5 sm:px-5">
            <p className="text-xs text-muted-foreground tabular-nums">
              {safePage * PAGE_SIZE + 1}–{Math.min(rows.length, (safePage + 1) * PAGE_SIZE)} of{" "}
              {rows.length}
            </p>
            <div className="flex items-center gap-2">
              <Button
                variant="outline"
                size="sm"
                className="h-8"
                onClick={() => setPage((p) => Math.max(0, p - 1))}
                disabled={safePage === 0}
              >
                <ChevronLeft className="h-3.5 w-3.5" />
                <span className="sr-only sm:not-sr-only sm:ml-1">Previous</span>
              </Button>
              <span className="text-xs text-muted-foreground tabular-nums">
                {safePage + 1} / {pageCount}
              </span>
              <Button
                variant="outline"
                size="sm"
                className="h-8"
                onClick={() => setPage((p) => Math.min(pageCount - 1, p + 1))}
                disabled={safePage >= pageCount - 1}
              >
                <span className="sr-only sm:not-sr-only sm:mr-1">Next</span>
                <ChevronRight className="h-3.5 w-3.5" />
              </Button>
            </div>
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}

const TH = "px-3 py-2.5 font-medium whitespace-nowrap first:pl-4 last:pr-4";
const TD = "px-3 py-2.5 align-top first:pl-4 last:pr-4";

/**
 * One call, memoized.
 *
 * Rows are immutable values keyed by `callId`, so typing in the search box —
 * which re-renders the dialog on every keystroke — re-renders only the rows
 * that actually changed.
 */
const CallRow = memo(function CallRow({ r, status }: { r: UnansweredCallRow; status: string }) {
  return (
    <tr className="border-b border-border/40 transition-colors last:border-0 hover:bg-muted/40">
      <td className={cn(TD, "whitespace-nowrap tabular-nums")}>{formatWhen(r.startedAt)}</td>
      <td className={cn(TD, "whitespace-nowrap font-mono text-xs")}>{r.customerNumber || "—"}</td>
      <td className={cn(TD, "font-mono text-xs text-muted-foreground")}>{r.queueNumber ?? "—"}</td>
      <td className={cn(TD, "whitespace-nowrap text-right tabular-nums")}>
        {r.waitSeconds == null ? "—" : hhmmss(r.waitSeconds)}
      </td>
      <td className={TD}>
        <StatusBadge label={status} />
      </td>
      <td className={TD}>
        <HandledBadge handled={r.handled != null} />
      </td>
      <td className={TD}>
        {r.handled ? (
          <div className="min-w-0">
            <div className="font-medium">{r.handled.agentName ?? `Ext ${r.handled.agentExt}`}</div>
            <TeamLine team={r.handled.team} />
          </div>
        ) : (
          <span className="text-muted-foreground">—</span>
        )}
      </td>
      <td className={TD}>
        {r.handled ? (
          <div className="min-w-0 space-y-1">
            <div className="whitespace-nowrap tabular-nums">{formatWhen(r.handled.at)}</div>
            <div className="flex flex-wrap items-center gap-1.5">
              <DirectionBadge direction={r.handled.direction} />
              <span className="whitespace-nowrap text-[11px] text-muted-foreground">
                {afterLabel(r.handled.afterSeconds)}
              </span>
            </div>
          </div>
        ) : (
          <span className="text-muted-foreground">—</span>
        )}
      </td>
    </tr>
  );
});

const CallCard = memo(function CallCard({
  r,
  status,
  waitLabel,
}: {
  r: UnansweredCallRow;
  status: string;
  waitLabel: string;
}) {
  return (
    <li className="space-y-2 px-4 py-3">
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <p className="truncate font-mono text-sm font-medium">{r.customerNumber || "—"}</p>
          <p className="text-xs tabular-nums text-muted-foreground">{formatWhen(r.startedAt)}</p>
        </div>
        <StatusBadge label={status} />
      </div>
      <dl className="flex flex-wrap gap-x-4 gap-y-1 text-[11px] text-muted-foreground">
        <div className="flex gap-1">
          <dt>Queue</dt>
          <dd className="font-mono text-foreground">{r.queueNumber ?? "—"}</dd>
        </div>
        <div className="flex gap-1">
          <dt>{waitLabel}</dt>
          <dd className="tabular-nums text-foreground">
            {r.waitSeconds == null ? "—" : hhmmss(r.waitSeconds)}
          </dd>
        </div>
      </dl>
      <div className="flex flex-wrap items-center gap-2">
        <HandledBadge handled={r.handled != null} />
        {r.handled && (
          <>
            <DirectionBadge direction={r.handled.direction} />
            <span className="text-[11px] text-muted-foreground">
              {afterLabel(r.handled.afterSeconds)}
            </span>
          </>
        )}
      </div>
      {r.handled && (
        <div className="rounded-md bg-muted/40 px-2.5 py-2 text-xs">
          <p className="font-medium">{r.handled.agentName ?? `Ext ${r.handled.agentExt}`}</p>
          <p>
            <TeamLine team={r.handled.team} />
          </p>
          <p className="mt-0.5 tabular-nums text-muted-foreground">{formatWhen(r.handled.at)}</p>
        </div>
      )}
    </li>
  );
});

function StatusBadge({ label }: { label: string }) {
  return (
    <span
      className={cn(
        "inline-flex whitespace-nowrap rounded-full px-2 py-0.5 text-[11px] font-medium",
        label === "Missed"
          ? "bg-destructive/10 text-destructive"
          : "bg-warning/15 text-warning-foreground",
      )}
    >
      {label}
    </span>
  );
}

function HandledBadge({ handled }: { handled: boolean }) {
  return (
    <span
      className={cn(
        "inline-flex whitespace-nowrap rounded-full px-2 py-0.5 text-[11px] font-medium",
        handled ? "bg-success/10 text-success" : "bg-muted text-muted-foreground",
      )}
    >
      {handled ? "Yes" : "No"}
    </span>
  );
}

function TeamLine({ team }: { team: CallTeam | null }) {
  if (!team) return <span className="text-[11px] text-muted-foreground">Team unknown</span>;
  const care = team === "customer_care";
  const Icon = care ? Headphones : PhoneOutgoing;
  return (
    <span className="mt-0.5 inline-flex items-center gap-1 text-[11px] text-muted-foreground">
      <Icon className="h-3 w-3" aria-hidden="true" />
      {care ? "Customer Care" : "Telesales"}
    </span>
  );
}

function DirectionBadge({ direction }: { direction: "Inbound" | "Outbound" }) {
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

/**
 * One formatter, built once — `toLocaleString` with an options bag constructs a
 * fresh `Intl.DateTimeFormat` per call, and this runs twice per row.
 */
const WHEN_FORMAT = new Intl.DateTimeFormat(undefined, {
  timeZone: BUSINESS_TIMEZONE,
  day: "numeric",
  month: "short",
  hour: "numeric",
  minute: "2-digit",
});

/** Epoch seconds → a readable instant in the business timezone. */
function formatWhen(at: number | null): string {
  if (at == null) return "—";
  return WHEN_FORMAT.format(new Date(at * 1000));
}

/** How long after the failed call the customer was reached. */
function afterLabel(seconds: number): string {
  if (seconds < 60) return `${Math.max(0, Math.round(seconds))}s later`;
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes}m later`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ${minutes % 60}m later`;
  const days = Math.floor(hours / 24);
  return `${days}d ${hours % 24}h later`;
}
