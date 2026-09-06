import { useCallback, useEffect, useMemo, useState } from "react";
import { Link } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import { ChevronLeft, ChevronRight, Inbox, Loader2, Search, X } from "lucide-react";
import { DateRangePicker } from "@/components/date-range-picker";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
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
import { LEAD_TYPE_LABELS, OUTCOME_BY_KEY, type LeadType } from "@/lib/telesales/types";
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
import { useDeleteLead, useLeadMutations } from "@/features/telesales/hooks/use-lead-detail";
import {
  useStaleLeadCount,
  useTelesalesBranches,
  useTelesalesFamilies,
  useTelesalesQueue,
  type WasfatyCycle,
} from "@/features/telesales/hooks/use-telesales-queue";
import type { QueueLead } from "@/features/telesales/types";
import { useDebounced } from "@/features/shams/hooks/use-shams-data";
import {
  clearedQueueFilters,
  queueDefaults,
  queueFiltersActive,
} from "@/features/telesales/queue-search";
import type { QueueDefaults, QueueState } from "@/features/telesales/queue-search";

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

/**
 * `YYYY-MM-DD` to a local `Date`, and back.
 *
 * The queue speaks business dates — plain calendar days, stored and filtered as
 * `date` in Postgres — and `DateRangePicker` speaks `Date`. `new Date("2026-09-05")`
 * would parse as midnight UTC and render as the 4th anywhere west of Greenwich,
 * so the parts are handed to the local constructor instead.
 */
function parseBusinessDate(iso: string): Date {
  const [y, m, d] = iso.split("-").map(Number);
  return new Date(y, (m ?? 1) - 1, d ?? 1);
}

function isoOf(d: Date): string {
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

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
  /**
   * Which vocabulary the leftmost filter speaks.
   *
   * `"status"` is the workflow state, which is what the Cash desk tracks.
   * `"outcome"` is the recorded action, which is what the Wasfaty desk calls a
   * status — and the two are genuinely different questions, so this picks one
   * rather than showing both.
   */
  statusFilter?: "status" | "outcome";
  /** The actions offered when `statusFilter` is `"outcome"`. */
  outcomeKeys?: readonly string[];
  /** Offer the lifecycle (Active / Stale / Archived) control. On by default. */
  showLifecycleFilter?: boolean;
  /** Offer the product-family control. On by default. */
  showProductFilter?: boolean;
  /**
   * The import cycles, when this queue has them. Renders the Period control.
   *
   * Wasfaty only: a Cash lead comes from a rolling daily window rather than
   * from a monthly file, so there is no cycle to pick.
   */
  cycles?: WasfatyCycle[];
  /** The resolved period the Period control shows — `"all"` or a `YYYY-MM`. */
  cyclePeriod?: string;
  /** The batches in that period, comma-joined. `""` is every cycle. */
  importIds?: string;
  /**
   * Where this view's filters rest when the URL says nothing.
   *
   * The same `QueueDefaults` the route hands `validateQueueSearch` and
   * `queueStateFromSearch`, so the queue, the URL and the Clear button agree on
   * one answer to "what is this page's resting position".
   *
   * They used to disagree. This prop was only the date range, and Clear reset
   * `status` to the *global* default — `"open"`. On All Leads and Worked Leads,
   * whose resting status is `"all"`, that made Clear a filter rather than the
   * removal of one: every converted and closed prescription vanished from a
   * supervisor's list, on a page whose entire purpose is to show them, and
   * Wasfaty hides the status control (`statusFilter="outcome"`) so there was
   * nothing on screen to put back. The same mismatch made `filtersActive` true
   * at rest, which is why Clear was always offered on a page nobody had filtered.
   */
  defaults?: Partial<QueueDefaults>;
  /** Offer the administrator's per-lead Delete. */
  canDelete?: boolean;
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
  statusFilter = "status",
  outcomeKeys,
  showLifecycleFilter = true,
  showProductFilter = true,
  cycles,
  cyclePeriod = "all",
  importIds = "",
  defaults: viewDefaults,
  canDelete = false,
  emptyTitle = "The queue is clear",
  emptyHint,
}: LeadQueueProps) {
  /*
   * The view's resting position, filled in from the global one.
   *
   * `queueDefaults(viewDefaults)` is the same helper `validateQueueSearch` and
   * `queueStateFromSearch` use, so a view that overrides nothing rests exactly
   * where the URL reader thinks it does — which is the property that broke.
   */
  const defaults = queueDefaults(viewDefaults);

  const { profile, role, session } = useAuth();
  const userId = session?.user?.id;
  const perms = profile?.permissions as string[] | null | undefined;

  const canView = hasPerm(role, perms, "view_telesales");
  const canWork = hasPerm(role, perms, "work_telesales");
  const canManage = hasPerm(role, perms, "manage_telesales");

  const {
    leadType,
    status,
    outcome,
    agent,
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
  const setOutcome = (v: string) => put({ outcome: v, page: 0 });
  const setAgent = (v: string) => put({ agent: v, page: 0 });
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
   * The lead an administrator has asked to delete, held until they confirm.
   *
   * A destructive action with no undo, so it is a two-step: the row raises the
   * intent, the dialog states what will happen to *this* lead — deleted, or
   * archived because it carries a call log that is not ours to destroy — and
   * only then does anything run.
   */
  const [deleting, setDeleting] = useState<QueueLead | null>(null);
  const deleteLead = useDeleteLead();
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
      outcome,
      importIds,
      agent,
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
      outcome,
      importIds,
      agent,
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
  /*
   * Measured against the *view's* resting position, not the queue's.
   *
   * All Leads and Worked Leads rest at `status: "all"`; comparing those against
   * the global `"open"` is what offered a Clear button on a page nobody had
   * filtered — and pressing it then applied the very filter the comparison had
   * imagined. `queueFiltersActive` and `resetFilters` now read the same rule, so
   * the button appears only when it would change something and disappears once
   * it has.
   */
  const filtersActive = queueFiltersActive(state, defaults);

  /*
   * Clearing is one navigation, not eleven.
   *
   * Calling each setter in turn would issue eleven `navigate` calls against a
   * `state` that is stale after the first, so the last would win and the rest
   * would be lost. The whole default state goes back at once instead.
   *
   * ## Clear means "put this page back where it opens"
   *
   * Not "apply the queue's global defaults", which is what it used to do and
   * what made it destructive. `status` went back to `DEFAULT_QUEUE_FILTERS`'s
   * `"open"` on every page, including the two whose whole purpose is to show
   * closed work — so a supervisor pressing Clear on All Leads watched every
   * converted prescription disappear, with no visible control to bring it back
   * because Wasfaty renders the outcome filter in the status filter's place.
   *
   * `defaults` is the view's own resting position, the same one the URL reader
   * uses, so clearing now lands on exactly the state the page opens in — and,
   * because `filtersActive` is measured against the same values, the button
   * disappears once it has done its job. That is the visible confirmation the
   * old behaviour could never give.
   *
   * `lifecycle` is reset too, which it was not before. It has to be: it is one
   * of the two filters a view may rest somewhere other than the global default,
   * so leaving it out would recreate the same disagreement on the other axis.
   * On every existing view its resting value is the global one, so nothing an
   * agent sees today changes.
   */
  function resetFilters() {
    put(clearedQueueFilters(defaults));
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

              {statusFilter === "outcome" ? (
                /*
                 * The Wasfaty status filter is the Recorded Action vocabulary.
                 *
                 * Not a second list that happens to look like it: the options
                 * are `OUTCOME_BY_KEY` entries, so the filter and the badge on
                 * the row read from one definition and the stored keys are the
                 * historical ones — `low_price` still, labelled "Below
                 * Threshold".
                 */
                <Select value={outcome} onValueChange={setOutcome}>
                  <SelectTrigger className="w-[170px]" aria-label="Recorded action">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="all">All actions</SelectItem>
                    {(outcomeKeys ?? []).map((key) => (
                      <SelectItem key={key} value={key}>
                        {OUTCOME_BY_KEY.get(key)?.label ?? key}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              ) : (
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
              )}

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
              {showLifecycleFilter ? (
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
              ) : null}

              {/*
               * Which agent's leads.
               *
               * The assignment, not the last person to record something: those
               * are two columns and two questions, and "how many leads did this
               * agent receive" is the one a supervisor is asking. Offered only
               * to somebody who can manage the desk — an agent has "My leads"
               * beside it, which is the same question asked of themselves.
               */}
              {canManage ? (
                <Select value={agent} onValueChange={setAgent}>
                  <SelectTrigger className="w-[180px]" aria-label="Telesales agent">
                    <SelectValue placeholder="Agent" />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="all">All agents</SelectItem>
                    {(assignableAgents.data ?? []).map((a) => (
                      <SelectItem key={a.id} value={a.id}>
                        {a.name}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              ) : null}

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

              {showProductFilter ? (
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
              ) : null}

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
            {showDateFilter || cycles ? (
              <div className="flex flex-wrap items-center gap-2 border-t border-border pt-3">
                {/*
                 * The period, when this queue has cycles.
                 *
                 * Wasfaty arrives as a monthly file and the desk works one
                 * month at a time, so the resting position is the current cycle
                 * rather than everything ever imported. Historical months stay
                 * here, one click away, which is the whole reason this is a
                 * control and not a hard-coded window.
                 */}
                {cycles ? (
                  <>
                    <Label className="text-xs text-muted-foreground">Period</Label>
                    <Select value={cyclePeriod} onValueChange={(v) => put({ cycle: v, page: 0 })}>
                      <SelectTrigger className="h-9 w-[190px]" aria-label="Import period">
                        <SelectValue placeholder="Period" />
                      </SelectTrigger>
                      <SelectContent>
                        {cycles.map((c) => (
                          <SelectItem key={c.period} value={c.period}>
                            {c.label} · {c.leads.toLocaleString("en-US")}
                          </SelectItem>
                        ))}
                        <SelectItem value="all">All periods</SelectItem>
                      </SelectContent>
                    </Select>
                    <span className="mx-1 h-5 w-px bg-border" aria-hidden />
                  </>
                ) : null}

                {/*
                 * The date range, through the portal's own calendar.
                 *
                 * The same `DateRangePicker` the Dashboard and Orders use,
                 * presets and all, rather than the pair of native date inputs
                 * that used to be here — one calendar in the product means an
                 * agent who has picked "Last month" on Orders already knows how
                 * to pick it here.
                 */}
                {showDateFilter ? (
                  <>
                    <Label className="text-xs text-muted-foreground">Dates</Label>
                    <DateRangePicker
                      size="sm"
                      range={
                        dateFrom || dateTo
                          ? {
                              from: parseBusinessDate(dateFrom || dateTo),
                              to: parseBusinessDate(dateTo || dateFrom),
                            }
                          : undefined
                      }
                      onChange={(r) =>
                        put({
                          dateFrom: r?.from ? isoOf(r.from) : "",
                          dateTo: r?.to ? isoOf(r.to) : r?.from ? isoOf(r.from) : "",
                          page: 0,
                        })
                      }
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
                  </>
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
                    canDelete={canDelete}
                    onDelete={(l) => setDeleting(l)}
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

      <AlertDialog open={Boolean(deleting)} onOpenChange={(open) => !open && setDeleting(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete this lead?</AlertDialogTitle>
            <AlertDialogDescription>
              {deleting
                ? `${[deleting.customer_name, deleting.prescription_no, deleting.item_name]
                    .filter(Boolean)
                    .join(" · ")} will disappear from Generated, All and Worked Leads.`
                : ""}
            </AlertDialogDescription>
          </AlertDialogHeader>
          {/*
           * Said before it happens, not after.
           *
           * A lead nobody has worked is deleted outright. A lead carrying a call
           * log is archived instead, because the activity table is append-only
           * and that guarantee is not something a screen gets to spend. Either
           * way it leaves the operational views, which is what was asked for —
           * and the toast afterwards says which of the two occurred.
           */}
          <p className="text-sm text-muted-foreground">
            A lead nobody has worked is removed permanently. One that carries call history is
            archived instead, so its recorded actions survive. This cannot be undone.
          </p>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={deleteLead.isPending}>Cancel</AlertDialogCancel>
            <AlertDialogAction
              disabled={deleteLead.isPending}
              onClick={(e) => {
                e.preventDefault();
                if (!deleting) return;
                deleteLead.mutate({ leadId: deleting.id }, { onSuccess: () => setDeleting(null) });
              }}
            >
              {deleteLead.isPending ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : null}
              Delete
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

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
