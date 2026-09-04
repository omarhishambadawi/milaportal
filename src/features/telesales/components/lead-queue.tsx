import { useCallback, useEffect, useMemo, useState } from "react";
import { Link } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import { ChevronLeft, ChevronRight, Inbox, Loader2, Search, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { supabase } from "@/integrations/supabase/client";
import { useAuth } from "@/lib/auth";
import { hasPerm } from "@/lib/permissions";
import { queryKeys } from "@/lib/query-keys";
import { cn } from "@/lib/utils";
import { businessToday } from "@/lib/telesales/dates";
import { familyLabel } from "@/lib/telesales/products";
import { LEAD_TYPE_LABELS, type LeadType } from "@/lib/telesales/types";
import { BulkActionBar } from "@/features/telesales/components/bulk-action-bar";
import { LeadRow } from "@/features/telesales/components/lead-row";
import { OutcomeDialog } from "@/features/telesales/components/outcome-dialog";
import {
  FOLLOWUP_FILTER_OPTIONS,
  LIFECYCLE_FILTER_OPTIONS,
  PAGE_SIZE_OPTIONS,
  STATUS_FILTER_OPTIONS,
} from "@/features/telesales/constants";
import {
  useAssignableAgents,
  useBulkLeadActions,
} from "@/features/telesales/hooks/use-bulk-actions";
import { useLeadMutations } from "@/features/telesales/hooks/use-lead-detail";
import {
  useStaleLeadCount,
  useTelesalesBranches,
  useTelesalesFamilies,
  useTelesalesQueue,
} from "@/features/telesales/hooks/use-telesales-queue";
import { DEFAULT_QUEUE_FILTERS, type QueueLead } from "@/features/telesales/types";
import { useDebounced } from "@/features/shams/hooks/use-shams-data";
import type { QueueState } from "@/features/telesales/queue-search";

/**
 * The lead queue, once, for every page that shows one.
 *
 * ===========================================================================
 * Why this is a component now
 * ===========================================================================
 * There are four queues on screen after this phase — the Cash desk and the
 * three Wasfaty views — and they are the same list of leads asked four
 * different questions. Copying the page would mean four implementations of
 * "clearing filters is one navigation, not eleven", four places where the
 * selection has to be dropped when the page changes, and four chances for one
 * of them to drift.
 *
 * So: one component, and what differs between the callers is passed in.
 *
 *   - `domain`     which pipelines exist here at all. Not user-settable.
 *   - `typeChips`  the pipelines the user may narrow to within that domain.
 *   - `worked`     the view's own predicate — Worked Leads is this, and only
 *                  this, different from All Leads.
 *
 * Everything else — status, follow-up, lifecycle, branch, product, dates,
 * search, paging — is the operator's and lives in the URL, which is why the
 * state and its setter arrive as props rather than being held here. The page
 * owns the address bar; this component owns the list.
 */

export interface LeadQueueProps {
  /** Comma-joined lead types this queue may show. See `QueueFilters.domain`. */
  domain: string;
  /** Pipelines offered as chips. Empty renders no chip row at all. */
  typeChips?: LeadType[];
  /** The view's fixed predicate: "all" | "worked" | "unworked". */
  worked?: string;
  /** URL state, already validated by the route. */
  state: QueueState;
  /** Writes part of the state back to the URL. `replace` for typing. */
  put: (next: Partial<QueueState>, replace?: boolean) => void;
  /** The queue's filters packed for a lead to carry back. */
  queueContext?: string;
  /** Offer the date range. On by default. */
  showDateFilter?: boolean;
  /** What to say when an unfiltered queue is empty. */
  emptyTitle?: string;
  emptyHint?: string;
}

export function LeadQueue({
  domain,
  typeChips = [],
  worked = "all",
  state,
  put,
  queueContext,
  showDateFilter = true,
  emptyTitle = "The queue is clear",
  emptyHint,
}: LeadQueueProps) {
  const { profile, role, session } = useAuth();
  const userId = session?.user?.id;
  const perms = profile?.permissions as string[] | null | undefined;

  const canView = hasPerm(role, perms, "view_telesales");
  const canWork = hasPerm(role, perms, "work_telesales");
  const canManage = hasPerm(role, perms, "manage_telesales");

  const {
    leadType,
    status,
    branch,
    family,
    followup,
    lifecycle,
    term,
    dateFrom,
    dateTo,
    mineOnly,
    unassignedOnly,
    page,
    pageSize,
  } = state;

  /*
   * The setters, in the shape the page already used.
   *
   * Every filter resets to page 1: page 4 of a different result set is a page
   * the agent never asked for and usually an empty one. That rule lives in the
   * setter itself, so it cannot be forgotten at a call site.
   */
  const setStatus = (v: string) => put({ status: v, page: 0 });
  const setBranch = (v: string) => put({ branch: v, page: 0 });
  const setFamily = (v: string) => put({ family: v, page: 0 });
  const setFollowup = (v: string) => put({ followup: v, page: 0 });
  const setLifecycle = (v: string) => put({ lifecycle: v, page: 0 });
  const setTerm = useCallback((v: string) => put({ term: v, page: 0 }, true), [put]);
  const setPageSize = (v: number) => put({ pageSize: v, page: 0 });
  const setPage = (v: number | ((p: number) => number)) =>
    put({ page: typeof v === "function" ? v(page) : v });

  /*
   * The search box types locally and publishes when it settles.
   *
   * Writing the URL on every keystroke would put one history entry per
   * character — so Back from a lead would walk backwards through the typed
   * word — and would round-trip each keypress through the router, which drops
   * characters under fast typing. The same `draft` + `useDebounced` pattern the
   * `/shams` stock search uses, and for the same two reasons.
   */
  const [draft, setDraft] = useState(term);
  const settled = useDebounced(draft);

  useEffect(() => {
    setDraft((d) => (d === term ? d : term));
  }, [term]);

  useEffect(() => {
    if (settled !== term) setTerm(settled);
    // `settled` is what decides this; `term` would re-fire on adoption.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [settled]);

  const [recording, setRecording] = useState<QueueLead | null>(null);
  /*
   * Selection lives on the page rather than in the URL.
   *
   * It is scoped to the rows currently on screen: changing a filter or a page
   * clears it, because a selection that survives a filter change is a selection
   * whose contents the supervisor can no longer see -- and the next bulk action
   * would move leads they did not know were still chosen.
   */
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const bulk = useBulkLeadActions();
  const assignableAgents = useAssignableAgents(canManage);

  const filters = useMemo(
    () => ({
      domain,
      leadType,
      status,
      agent: "all",
      branch,
      family,
      followup,
      lifecycle,
      dateFrom,
      dateTo,
      worked,
      term: term.trim(),
      mineOnly,
      unassignedOnly,
      userId,
    }),
    [
      domain,
      leadType,
      status,
      branch,
      family,
      followup,
      lifecycle,
      dateFrom,
      dateTo,
      worked,
      term,
      mineOnly,
      unassignedOnly,
      userId,
    ],
  );

  const queue = useTelesalesQueue(filters, page, pageSize, canView);
  const backlog = useStaleLeadCount(canView, domain, leadType);

  // Any change of what is on screen drops the selection.
  const queueIdentity = `${JSON.stringify(filters)}|${page}|${pageSize}`;
  const [selectionScope, setSelectionScope] = useState(queueIdentity);
  if (selectionScope !== queueIdentity) {
    setSelectionScope(queueIdentity);
    if (selected.size > 0) setSelected(new Set());
  }
  const branches = useTelesalesBranches(canView, domain);
  const families = useTelesalesFamilies(canView);
  const mutations = useLeadMutations();
  const today = businessToday();

  /**
   * One roster fetch, not one per row.
   *
   * The queue renders up to 100 rows and each shows an assignee name. Resolving
   * that per row would be 100 requests for a table of at most a few dozen
   * agents — the same mistake the Calls module documents having made once.
   */
  const roster = useQuery<Map<string, string>>({
    queryKey: queryKeys.lookups.ordersDirectory(),
    enabled: canView,
    staleTime: 5 * 60_000,
    queryFn: async () => {
      const { data } = await supabase.from("profiles").select("id,full_name").eq("active", true);
      return new Map(
        ((data as { id: string; full_name: string }[]) ?? []).map((p) => [p.id, p.full_name]),
      );
    },
  });

  const toggleOne = (id: string, on: boolean) =>
    setSelected((prev) => {
      const next = new Set(prev);
      if (on) next.add(id);
      else next.delete(id);
      return next;
    });

  const rows = queue.data?.rows ?? [];
  const total = queue.data?.total ?? 0;
  const pages = Math.max(1, Math.ceil(total / pageSize));
  const filtersActive =
    leadType !== "all" ||
    status !== DEFAULT_QUEUE_FILTERS.status ||
    branch !== "all" ||
    family !== "all" ||
    followup !== "all" ||
    dateFrom !== "" ||
    dateTo !== "" ||
    term.trim() !== "" ||
    mineOnly ||
    unassignedOnly;

  /*
   * Clearing is one navigation, not eleven.
   *
   * Calling each setter in turn would issue eleven `navigate` calls against a
   * `state` that is stale after the first, so the last would win and the rest
   * would be lost. The whole default state goes back at once instead.
   *
   * `lifecycle` is deliberately not reset: it is the actionable/stale axis and
   * it was not on the old reset either, because an agent clearing filters wants
   * their working set back, not the dead backlog with it.
   */
  function resetFilters() {
    put({
      leadType: DEFAULT_QUEUE_FILTERS.leadType,
      status: DEFAULT_QUEUE_FILTERS.status,
      branch: "all",
      family: "all",
      followup: "all",
      dateFrom: "",
      dateTo: "",
      term: "",
      mineOnly: false,
      unassignedOnly: false,
      page: 0,
    });
  }

  return (
    <div className="space-y-4">
      {/*
       * Scope: which pipeline, and whose.
       *
       * A heading, because the row used to be six unlabelled buttons and
       * "My leads" beside "Cash" beside "Unassigned" does not say that the
       * first three are one question and the last two are another.
       */}
      {typeChips.length > 0 || canWork ? (
        <section aria-labelledby="queue-scope">
          <h2
            id="queue-scope"
            className="mb-2 text-xs font-medium uppercase tracking-wide text-muted-foreground"
          >
            Scope
          </h2>
          <div className="flex flex-wrap items-center gap-2">
            {typeChips.length > 0 ? (
              <>
                <Button
                  size="sm"
                  variant={leadType === "all" ? "default" : "outline"}
                  onClick={() => put({ leadType: "all", page: 0 })}
                >
                  All
                </Button>
                {typeChips.map((t) => (
                  <Button
                    key={t}
                    size="sm"
                    variant={leadType === t ? "default" : "outline"}
                    onClick={() => put({ leadType: t, page: 0 })}
                  >
                    {LEAD_TYPE_LABELS[t]}
                  </Button>
                ))}
                <span className="mx-1 h-5 w-px bg-border" aria-hidden />
              </>
            ) : null}
            <Button
              size="sm"
              variant={mineOnly ? "default" : "outline"}
              onClick={() => {
                // One navigation: the two toggles are mutually exclusive, and
                // writing them separately would lose the first.
                put({ mineOnly: !mineOnly, unassignedOnly: false, page: 0 });
              }}
            >
              My leads
            </Button>
            <Button
              size="sm"
              variant={unassignedOnly ? "default" : "outline"}
              onClick={() => {
                put({ unassignedOnly: !unassignedOnly, mineOnly: false, page: 0 });
              }}
            >
              Unassigned
            </Button>
          </div>
        </section>
      ) : null}

      <section aria-labelledby="queue-filters">
        <h2
          id="queue-filters"
          className="mb-2 text-xs font-medium uppercase tracking-wide text-muted-foreground"
        >
          Filters
        </h2>
        <Card>
          <CardContent className="space-y-3 p-3">
            <div className="flex flex-wrap items-center gap-2">
              <div className="relative min-w-[220px] flex-1">
                <Search className="absolute left-2.5 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
                <Input
                  value={draft}
                  onChange={(e) => setDraft(e.target.value)}
                  placeholder="Name, phone, Patient ID, prescription, invoice"
                  className="pl-8"
                  aria-label="Search leads"
                />
              </div>

              <Select value={status} onValueChange={setStatus}>
                <SelectTrigger className="w-[150px]" aria-label="Status">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {STATUS_FILTER_OPTIONS.map((o) => (
                    <SelectItem key={o.value} value={o.value}>
                      {o.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>

              <Select value={followup} onValueChange={setFollowup}>
                <SelectTrigger className="w-[150px]" aria-label="Follow-up">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {FOLLOWUP_FILTER_OPTIONS.map((o) => (
                    <SelectItem key={o.value} value={o.value}>
                      {o.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>

              {/*
               * Lifecycle. Its own control rather than another status option,
               * because a lead can be `follow_up` and stale at the same time and
               * a single dropdown cannot say both.
               */}
              <Select value={lifecycle} onValueChange={setLifecycle}>
                <SelectTrigger className="w-[190px]" aria-label="Lifecycle">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {LIFECYCLE_FILTER_OPTIONS.map((o) => (
                    <SelectItem key={o.value} value={o.value}>
                      {o.label}
                      {o.value === "stale" && backlog.data
                        ? ` · ${backlog.data.stale.toLocaleString("en-US")}`
                        : o.value === "archived" && backlog.data
                          ? ` · ${backlog.data.archived.toLocaleString("en-US")}`
                          : ""}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>

              <Select value={branch} onValueChange={setBranch}>
                <SelectTrigger className="w-[140px]" aria-label="Branch">
                  <SelectValue placeholder="Branch" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">All branches</SelectItem>
                  {(branches.data ?? []).map((b) => (
                    <SelectItem key={b} value={b}>
                      {b}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>

              <Select value={family} onValueChange={setFamily}>
                <SelectTrigger className="w-[160px]" aria-label="Product">
                  <SelectValue placeholder="Product" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">All products</SelectItem>
                  {(families.data ?? []).map((f) => (
                    <SelectItem key={f} value={f}>
                      {familyLabel(f)}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>

              {filtersActive ? (
                <Button variant="ghost" size="sm" onClick={resetFilters}>
                  <X className="mr-1 h-4 w-4" />
                  Clear
                </Button>
              ) : null}
            </div>

            {/*
             * The date range, on its own line.
             *
             * Two native date inputs rather than a calendar popover: the desk
             * types dates far more often than it browses to them, and the pair
             * needs no library. Both ends are optional — "everything since the
             * 1st" is a question people actually ask — and both become a `WHERE`
             * clause, so paging stays correct across the filtered set rather
             * than across a page that was filtered afterwards.
             */}
            {showDateFilter ? (
              <div className="flex flex-wrap items-center gap-2 border-t border-border pt-3">
                <Label htmlFor="queue-date-from" className="text-xs text-muted-foreground">
                  Dates
                </Label>
                <Input
                  id="queue-date-from"
                  type="date"
                  className="h-9 w-[160px]"
                  value={dateFrom}
                  max={dateTo || undefined}
                  onChange={(e) => put({ dateFrom: e.target.value, page: 0 })}
                />
                <span className="text-xs text-muted-foreground">to</span>
                <Input
                  id="queue-date-to"
                  type="date"
                  className="h-9 w-[160px]"
                  value={dateTo}
                  min={dateFrom || undefined}
                  onChange={(e) => put({ dateTo: e.target.value, page: 0 })}
                  aria-label="To date"
                />
                {dateFrom || dateTo ? (
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={() => put({ dateFrom: "", dateTo: "", page: 0 })}
                  >
                    Any date
                  </Button>
                ) : null}
              </div>
            ) : null}
          </CardContent>
        </Card>
      </section>

      {(lifecycle === "stale" || lifecycle === "archived") && backlog.data ? (
        <p className="px-1 text-xs text-muted-foreground">
          {lifecycle === "stale" ? (
            <>
              <span className="font-medium text-foreground">
                {backlog.data.stale.toLocaleString("en-US")} stale
              </span>
              {" · "}
              {backlog.data.staleUnassigned.toLocaleString("en-US")} unassigned
              {" · "}
              {backlog.data.staleAssigned.toLocaleString("en-US")} assigned
              {backlog.data.archived > 0
                ? ` · ${backlog.data.archived.toLocaleString("en-US")} already archived`
                : ""}
            </>
          ) : (
            <>
              <span className="font-medium text-foreground">
                {backlog.data.archived.toLocaleString("en-US")} archived
              </span>
              {" · out of the queue, history kept, restorable by a team lead"}
            </>
          )}
        </p>
      ) : null}

      <section aria-labelledby="queue-leads">
        <div className="mb-2 flex items-baseline justify-between gap-3">
          <h2
            id="queue-leads"
            className="text-xs font-medium uppercase tracking-wide text-muted-foreground"
          >
            Leads
          </h2>
          <p className="text-xs text-muted-foreground">
            {queue.isLoading
              ? "Loading…"
              : `${total.toLocaleString("en-US")} match${total === 1 ? "" : "es"}`}
          </p>
        </div>
        <Card>
          <CardContent className="p-0">
            {queue.isLoading ? (
              <div className="flex items-center justify-center gap-2 py-16 text-sm text-muted-foreground">
                <Loader2 className="h-4 w-4 animate-spin" />
                Loading leads…
              </div>
            ) : queue.isError ? (
              <div className="py-16 text-center">
                <p className="text-sm font-medium">The queue could not be loaded</p>
                <p className="mt-1 text-sm text-muted-foreground">
                  {(queue.error as Error)?.message ?? "Unknown error"}
                </p>
                <Button
                  className="mt-4"
                  variant="outline"
                  size="sm"
                  onClick={() => queue.refetch()}
                >
                  Try again
                </Button>
              </div>
            ) : rows.length === 0 ? (
              /*
               * Two different empty states, because they mean opposite things.
               *
               * A filtered empty queue is a filter to loosen. An unfiltered one is
               * either a desk that has finished its work or a generator that has
               * not run — and telling somebody "no results" when the real answer
               * is "nothing has been imported yet" wastes their morning.
               */
              <div className="py-16 text-center">
                <Inbox className="mx-auto h-10 w-10 text-muted-foreground/60" />
                {filtersActive ? (
                  <>
                    <p className="mt-2 text-sm font-medium">No leads match these filters</p>
                    <Button className="mt-4" variant="outline" size="sm" onClick={resetFilters}>
                      Clear filters
                    </Button>
                  </>
                ) : (
                  <>
                    <p className="mt-2 text-sm font-medium">{emptyTitle}</p>
                    <p className="mt-1 text-sm text-muted-foreground">
                      {emptyHint ??
                        (canManage
                          ? "Import a source file or run lead generation to fill it."
                          : "Nothing is waiting for you right now.")}
                    </p>
                    {canManage ? (
                      <Button asChild className="mt-4" variant="outline" size="sm">
                        <Link to="/telesales/import">Go to import</Link>
                      </Button>
                    ) : null}
                  </>
                )}
              </div>
            ) : (
              <div>
                {canManage ? (
                  <div className="flex items-center gap-2 border-b border-border bg-muted/30 px-3 py-2">
                    <Checkbox
                      aria-label="Select every lead on this page"
                      checked={rows.length > 0 && rows.every((r) => selected.has(r.id))}
                      onCheckedChange={(v) =>
                        setSelected(v === true ? new Set(rows.map((r) => r.id)) : new Set())
                      }
                    />
                    <span className="text-xs text-muted-foreground">Select all on this page</span>
                  </div>
                ) : null}
                {rows.map((lead) => (
                  <LeadRow
                    key={lead.id}
                    lead={lead}
                    today={today}
                    queueContext={queueContext}
                    assigneeName={
                      lead.assigned_to ? (roster.data?.get(lead.assigned_to) ?? null) : null
                    }
                    lastContactName={
                      lead.last_contacted_by
                        ? (roster.data?.get(lead.last_contacted_by) ?? null)
                        : null
                    }
                    archivedByLabel={
                      lead.archived_by ? (roster.data?.get(lead.archived_by) ?? null) : null
                    }
                    selectable={canManage}
                    selected={selected.has(lead.id)}
                    onSelect={toggleOne}
                    isMine={Boolean(userId && lead.assigned_to === userId)}
                    canWork={canWork}
                    claiming={mutations.assign.isPending}
                    onClaim={(l) =>
                      mutations.assign.mutate({ leadId: l.id, assigneeId: userId ?? null })
                    }
                    onRecord={(l) => setRecording(l)}
                  />
                ))}
              </div>
            )}
          </CardContent>
        </Card>
      </section>

      {canManage ? (
        <BulkActionBar
          count={selected.size}
          agents={assignableAgents.data ?? []}
          busy={bulk.busy}
          onAssign={(agentId) =>
            bulk.assign.mutate(
              { leadIds: [...selected], assigneeId: agentId },
              { onSuccess: () => setSelected(new Set()) },
            )
          }
          onUnassign={() =>
            bulk.assign.mutate(
              { leadIds: [...selected], assigneeId: null },
              { onSuccess: () => setSelected(new Set()) },
            )
          }
          onArchive={(reason) =>
            bulk.archive.mutate(
              { leadIds: [...selected], reason },
              { onSuccess: () => setSelected(new Set()) },
            )
          }
          /*
           * Archive and restore are the same gesture in opposite directions, so
           * the bar shows whichever one applies to what is on screen. Offering
           * both at once would mean offering to archive an archived lead.
           */
          mode={lifecycle === "archived" ? "archived" : "active"}
          onRestore={() =>
            bulk.restore.mutate(
              { leadIds: [...selected] },
              { onSuccess: () => setSelected(new Set()) },
            )
          }
          onClear={() => setSelected(new Set())}
        />
      ) : null}

      {total > pageSize ? (
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="flex items-center gap-2 text-sm text-muted-foreground">
            <span>Rows</span>
            <Select value={String(pageSize)} onValueChange={(v) => setPageSize(Number(v))}>
              <SelectTrigger className="h-8 w-[80px]" aria-label="Rows per page">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {PAGE_SIZE_OPTIONS.map((n) => (
                  <SelectItem key={n} value={String(n)}>
                    {n}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="flex items-center gap-2">
            <Button
              variant="outline"
              size="sm"
              disabled={page === 0}
              onClick={() => setPage((p) => Math.max(0, p - 1))}
            >
              <ChevronLeft className="h-4 w-4" />
              <span className="sr-only">Previous page</span>
            </Button>
            <span className={cn("text-sm text-muted-foreground")}>
              Page {page + 1} of {pages}
            </span>
            <Button
              variant="outline"
              size="sm"
              disabled={page + 1 >= pages}
              onClick={() => setPage((p) => p + 1)}
            >
              <ChevronRight className="h-4 w-4" />
              <span className="sr-only">Next page</span>
            </Button>
          </div>
        </div>
      ) : null}

      <OutcomeDialog
        open={Boolean(recording)}
        onOpenChange={(open) => {
          if (!open) setRecording(null);
        }}
        leadType={recording?.lead_type ?? "cash"}
        // The queue row does not carry the product's refill interval; the detail
        // page does. Proposing from the fallback here is right: an agent who
        // needs the exact cycle is one click from the lead.
        refillDays={null}
        customerLabel={
          recording
            ? [recording.customer_name, recording.item_name].filter(Boolean).join(" · ") ||
              "This lead"
            : ""
        }
        submitting={mutations.recordOutcome.isPending}
        onSubmit={(input) => {
          if (!recording) return;
          mutations.recordOutcome.mutate(
            { leadId: recording.id, ...input },
            { onSuccess: () => setRecording(null) },
          );
        }}
      />
    </div>
  );
}
