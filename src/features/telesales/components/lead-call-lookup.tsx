import { useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { AlertTriangle, PhoneOff, Search } from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { useAuth } from "@/lib/auth";
import { canViewCallsPage } from "@/lib/permissions";
import { queryKeys } from "@/lib/query-keys";
import { lookupCallsByNumber } from "@/lib/yeastar.functions";
import {
  ResultsSkeleton,
  ResultsTable,
  formatWhen,
} from "@/features/call-center/components/call-lookup-results";

/**
 * Who has called this lead, on the lead's own page.
 *
 * ===========================================================================
 * The same lookup, not a second one
 * ===========================================================================
 * `lookupCallsByNumber` is the server function `/calls/lookup` calls, and this
 * calls it unchanged: same permission check inside the handler, same four
 * retrieval paths, same `CallLookupRow`. The table is the Calls page's own
 * table, lifted into `call-lookup-results.tsx` when this screen needed it, so
 * a call cannot read "No answer" here and "Failed" there.
 *
 * Nothing about call history is re-derived. The agent, the timestamp, the
 * direction, the queue, the outcome and the durations are the PBX's own fields
 * as the normalizer produced them; this module invents no vocabulary of its
 * own.
 *
 * ===========================================================================
 * A window, not a lookback
 * ===========================================================================
 * `/calls/lookup` offers "last N days", which is right for the question that
 * page asks — somebody pastes a number they were just called by. On a lead the
 * question is more often about a period: *did anyone call this patient in
 * July*. So this offers From and To, defaulted to the last month, and passes
 * them to the same function; the server clamps the range to the same 90-day
 * ceiling the lookback carries, so neither route can ask for an unbounded
 * sweep.
 *
 * ===========================================================================
 * It never runs from the queue
 * ===========================================================================
 * Only this component calls the lookup, and it is rendered only on an opened
 * lead. A lookup per queue row would be a PBX request per row — the failure
 * the whole module is built to avoid — which is why this lives here rather
 * than in anything the list renders.
 */

/** The default window: the last month, ending today. */
export const DEFAULT_LOOKBACK_DAYS = 30;

const DAY_MS = 86_400_000;

/** `Date` → `YYYY-MM-DD`, in UTC so the string is stable wherever it runs. */
function isoDay(atMs: number): string {
  return new Date(atMs).toISOString().slice(0, 10);
}

/**
 * The default From/To pair.
 *
 * Exported so the test asserts the actual default rather than a restatement of
 * it: "last month" is the requirement, and an off-by-one here would be a
 * silently narrower window.
 */
export function defaultLookupWindow(nowMs: number = Date.now()): { from: string; to: string } {
  return {
    to: isoDay(nowMs),
    from: isoDay(nowMs - (DEFAULT_LOOKBACK_DAYS - 1) * DAY_MS),
  };
}

export interface LeadCallLookupProps {
  /** The lead's canonical Saudi number, or null when none is on file. */
  phone: string | null | undefined;
}

export function LeadCallLookup({ phone }: LeadCallLookupProps) {
  const { role, profile, loading: authLoading } = useAuth();
  /*
   * The Calls module's own gate, unchanged.
   *
   * Showing call history inside the CRM must not widen who may read it: a
   * telesales agent without call access sees the lead and not this panel. The
   * server re-checks independently through `callCenterAccess`, so this is the
   * courtesy and that is the boundary.
   */
  const canViewCalls = canViewCallsPage(role, profile?.permissions as any, "lookup");

  const lookupFn = useServerFn(lookupCallsByNumber);

  const initial = useMemo(() => defaultLookupWindow(), []);
  const [from, setFrom] = useState(initial.from);
  const [to, setTo] = useState(initial.to);

  const number = phone?.trim() ?? "";
  const enabled = !authLoading && canViewCalls && Boolean(number) && Boolean(from) && Boolean(to);

  const q = useQuery({
    queryKey: queryKeys.callCenter.lookupWindow(number, from, to),
    queryFn: ({ signal }) => lookupFn({ data: { number, from, to }, signal }),
    enabled,
    /*
     * The same caching posture as `/calls/lookup`: a closed window's history
     * does not change while it is on screen, so no polling and no refetch on
     * focus. Sharing the posture matters as much as sharing the function —
     * an agent moving between the two screens should not pay twice for one
     * answer.
     */
    staleTime: 5 * 60_000,
    gcTime: 30 * 60_000,
    refetchOnWindowFocus: false,
    refetchOnMount: false,
    retry: false,
  });

  // The panel is simply absent for somebody without call access, rather than
  // rendering a refusal — the lead page is theirs, this section is not.
  if (!authLoading && !canViewCalls) return null;

  const result = q.data;
  const rows = result?.rows ?? [];
  const lastHandled = rows.find((r) => r.agentName);

  return (
    <Card>
      <CardHeader className="pb-3">
        <CardTitle className="flex items-center gap-2 text-base">
          <Search className="h-4 w-4 text-muted-foreground" />
          Call history
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-3">
        {!number ? (
          /*
           * No number is a state, not a failure. A Wasfaty lead routinely has
           * none until an agent looks it up, and the page above offers the form
           * to add one.
           */
          <p className="flex items-center gap-2 text-sm text-muted-foreground">
            <PhoneOff className="h-4 w-4 shrink-0" />
            No phone number on this lead yet, so there is nothing to look up.
          </p>
        ) : (
          <>
            <div className="flex flex-wrap items-end gap-3">
              <div className="space-y-1.5">
                <Label className="text-xs" htmlFor="lead-call-from">
                  From
                </Label>
                <Input
                  id="lead-call-from"
                  type="date"
                  className="h-9 w-[160px]"
                  value={from}
                  max={to}
                  onChange={(e) => setFrom(e.target.value)}
                />
              </div>
              <div className="space-y-1.5">
                <Label className="text-xs" htmlFor="lead-call-to">
                  To
                </Label>
                <Input
                  id="lead-call-to"
                  type="date"
                  className="h-9 w-[160px]"
                  value={to}
                  min={from}
                  onChange={(e) => setTo(e.target.value)}
                />
              </div>
              <p className="pb-2 text-xs text-muted-foreground">
                Defaults to the last month. Ranges longer than 90 days are trimmed.
              </p>
            </div>

            {q.isPending ? (
              <ResultsSkeleton />
            ) : q.isError ? (
              /*
               * A lookup failure is contained here and never reaches the lead.
               * The PBX being unreachable is not a reason an agent cannot read
               * the customer, the product or the follow-up above.
               */
              <p className="flex items-start gap-2 rounded-md border border-destructive/40 bg-destructive/5 p-3 text-sm text-destructive">
                <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
                <span>
                  Call history could not be loaded.{" "}
                  <span className="text-muted-foreground">
                    {(q.error as Error)?.message ?? "The call system did not answer."}
                  </span>
                </span>
              </p>
            ) : result && !result.configured ? (
              // Distinguished from an error on purpose: nothing is broken, the
              // PBX integration is simply not set up in this environment.
              <p className="text-sm text-muted-foreground">
                The call system is not configured, so no history is available.
              </p>
            ) : result && result.error ? (
              <p className="text-sm text-muted-foreground">{result.error}</p>
            ) : rows.length === 0 ? (
              <p className="text-sm text-muted-foreground">
                No calls to or from this number between {from} and {to}.
              </p>
            ) : (
              <>
                <p className="text-sm text-muted-foreground">
                  {rows.length} call{rows.length === 1 ? "" : "s"} between {result?.window.from} and{" "}
                  {result?.window.to}
                  {lastHandled ? (
                    <>
                      {" "}
                      · last handled by{" "}
                      <span className="font-medium text-foreground">
                        {lastHandled.agentName}
                      </span>{" "}
                      on {formatWhen(lastHandled.startedAt)}
                    </>
                  ) : null}
                </p>
                <ResultsTable rows={rows} truncated={result?.truncated ?? false} />
              </>
            )}
          </>
        )}
      </CardContent>
    </Card>
  );
}
