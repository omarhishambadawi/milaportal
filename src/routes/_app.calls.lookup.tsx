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
 * The query runs on a 300 ms debounce rather than on every keystroke, and only
 * once enough digits are present to identify anybody. A half-entered number
 * matches nothing by construction — the server compares whole trailing digits,
 * not prefixes — so firing before then would spend requests answering a question
 * nobody asked. The Search button flushes the debounce for anyone who would
 * rather press it. React Query caches by number + window and aborts the previous
 * request when a new one starts, so re-checking a number is instant and a fast
 * typist never has two lookups racing.
 *
 * Access follows the module gate, but this page is deliberately NOT confined to
 * one team — see `UNCONFINED_PAGES` in `calls-access.ts`.
 */
import { memo, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createFileRoute } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import {
  AlertTriangle,
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
import {
  ResultsSkeleton,
  ResultsTable,
  TeamBadge,
  formatWhen,
} from "@/features/call-center/components/call-lookup-results";
import { BUSINESS_TIMEZONE } from "@/lib/timezone";

/** How far back to sweep. Longer windows cost a bigger CDR fetch. */
const WINDOWS = [
  { value: "7", label: "Last 7 days" },
  { value: "30", label: "Last 30 days" },
  { value: "90", label: "Last 90 days" },
] as const;

/** Long enough that a typist is not searched mid-number, short enough to feel live. */
const DEBOUNCE_MS = 300;
/** Mirrors `LOOKUP_MIN_DIGITS` on the server — below this it refuses anyway. */
const MIN_DIGITS = 4;

const digitCount = (s: string) => (s.match(/\d/g) ?? []).length;

export const Route = createFileRoute("/_app/calls/lookup")({
  head: () => ({ meta: [{ title: "Call Lookup — MilaServ Portal" }] }),
  component: CallLookupPage,
});

function CallLookupPage() {
  const { role, profile, loading: authLoading } = useAuth();
  const canView = canViewCallsPage(role, profile?.permissions as any, "lookup");
  const lookupFn = useServerFn(lookupCallsByNumber);

  // `draft` is what the input holds; `term` is what has actually been asked
  // for. Keeping them apart is what lets the request lag the keystrokes by
  // `DEBOUNCE_MS` — see the note at the top.
  const [draft, setDraft] = useState("");
  const [days, setDays] = useState<string>("30");
  const [term, setTerm] = useState("");

  // Trailing-edge debounce. The timer is cleared on every keystroke, so a burst
  // of typing issues exactly one request — the one for what was finally typed.
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => {
    const trimmed = draft.trim();
    if (trimmed === term) return;
    timer.current = setTimeout(() => setTerm(trimmed), DEBOUNCE_MS);
    return () => {
      if (timer.current) clearTimeout(timer.current);
    };
  }, [draft, term]);

  const searchable = digitCount(term) >= MIN_DIGITS;

  const q = useQuery({
    queryKey: queryKeys.callCenter.lookup(term, Number(days)),
    // `signal` is React Query's — it fires the moment this query is superseded
    // or unmounted, which aborts the in-flight HTTP request rather than letting
    // a stale answer land on top of a newer one.
    queryFn: ({ signal }) => lookupFn({ data: { number: term, days: Number(days) }, signal }),
    enabled: !authLoading && canView && searchable,
    // A number's history for a closed window does not change while you look at
    // it. No polling, no refetch on focus — this is a point lookup.
    staleTime: 5 * 60_000,
    // Recent numbers stay resident well past `staleTime`, so going back to one
    // checked a few minutes ago paints from cache with no request at all.
    gcTime: 30 * 60_000,
    // Deliberately NO `keepPreviousData`: this page answers "who called THIS
    // number", and showing the previous number's history under a new one for
    // the length of a request is not a loading state, it is a wrong answer.
    refetchOnWindowFocus: false,
    refetchOnMount: false,
    retry: false,
  });

  const result = q.data;
  const rows = useMemo(() => result?.rows ?? [], [result]);

  // Who handled them most recently — the single most-asked question, so it is
  // answered above the table rather than found in it.
  const lastHandled = useMemo(() => rows.find((r) => r.agentName), [rows]);

  // Flush the debounce. Pressing Search should not wait out a timer that the
  // keystroke which triggered it already started.
  const submit = useCallback(
    (e: React.FormEvent) => {
      e.preventDefault();
      if (timer.current) clearTimeout(timer.current);
      const trimmed = draft.trim();
      if (!trimmed) return;
      setTerm(trimmed);
    },
    [draft],
  );

  const clear = useCallback(() => {
    if (timer.current) clearTimeout(timer.current);
    setDraft("");
    setTerm("");
  }, []);

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
