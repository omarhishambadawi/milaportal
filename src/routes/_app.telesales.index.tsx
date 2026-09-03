import { createFileRoute, Link } from "@tanstack/react-router";
import { useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import {
  ChevronLeft,
  ChevronRight,
  Inbox,
  Lightbulb,
  Loader2,
  Search,
  ShieldAlert,
  Upload,
  X,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
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
import { LEAD_TYPES, LEAD_TYPE_LABELS } from "@/lib/telesales/types";
import { BulkActionBar } from "@/features/telesales/components/bulk-action-bar";
import { LeadRow } from "@/features/telesales/components/lead-row";
import { OutcomeDialog } from "@/features/telesales/components/outcome-dialog";
import {
  DEFAULT_PAGE_SIZE,
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

export const Route = createFileRoute("/_app/telesales/")({
  head: () => ({ meta: [{ title: "Telesales — MilaServ Portal" }] }),
  component: TelesalesQueuePage,
});

/**
 * The agent work queue.
 *
 * This screen is the replacement for opening a spreadsheet, filtering it by
 * date, and copying the survivors into a working sheet. The agent sees the leads
 * that need action; there is no filtering to reproduce, because the generator
 * already did it and recorded why.
 *
 * The filters that remain are the ones a person actually reaches for mid-shift —
 * which pipeline, whose leads, which branch, what is due — and every one of them
 * is applied in the database, not in the browser.
 */
function TelesalesQueuePage() {
  const { profile, role, session } = useAuth();
  const userId = session?.user?.id;
  const perms = profile?.permissions as string[] | null | undefined;

  const canView = hasPerm(role, perms, "view_telesales");
  const canWork = hasPerm(role, perms, "work_telesales");
  const canManage = hasPerm(role, perms, "manage_telesales");

  const [leadType, setLeadType] = useState(DEFAULT_QUEUE_FILTERS.leadType);
  const [status, setStatus] = useState(DEFAULT_QUEUE_FILTERS.status);
  const [branch, setBranch] = useState(DEFAULT_QUEUE_FILTERS.branch);
  const [family, setFamily] = useState(DEFAULT_QUEUE_FILTERS.family);
  const [followup, setFollowup] = useState(DEFAULT_QUEUE_FILTERS.followup);
  const [lifecycle, setLifecycle] = useState(DEFAULT_QUEUE_FILTERS.lifecycle);
  const [term, setTerm] = useState("");
  const [mineOnly, setMineOnly] = useState(false);
  const [unassignedOnly, setUnassignedOnly] = useState(false);
  const [page, setPage] = useState(0);
  const [pageSize, setPageSize] = useState<number>(DEFAULT_PAGE_SIZE);
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
      leadType,
      status,
      agent: "all",
      branch,
      family,
      followup,
      lifecycle,
      term: term.trim(),
      mineOnly,
      unassignedOnly,
      userId,
    }),
    [leadType, status, branch, family, followup, lifecycle, term, mineOnly, unassignedOnly, userId],
  );

  const queue = useTelesalesQueue(filters, page, pageSize, canView);
  const backlog = useStaleLeadCount(canView, leadType);

  // Any change of what is on screen drops the selection.
  const queueIdentity = `${JSON.stringify(filters)}|${page}|${pageSize}`;
  const [selectionScope, setSelectionScope] = useState(queueIdentity);
  if (selectionScope !== queueIdentity) {
    setSelectionScope(queueIdentity);
    if (selected.size > 0) setSelected(new Set());
  }
  const branches = useTelesalesBranches(canView);
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

  if (!canView) {
    return (
      <div className="py-16 text-center">
        <ShieldAlert className="mx-auto h-10 w-10 text-destructive" />
        <p className="mt-2 text-sm font-medium">Telesales is restricted</p>
        <p className="mt-1 text-sm text-muted-foreground">
          You do not have access to the Telesales CRM.
        </p>
      </div>
    );
  }

  const rows = queue.data?.rows ?? [];
  const total = queue.data?.total ?? 0;
  const pages = Math.max(1, Math.ceil(total / pageSize));
  const filtersActive =
    leadType !== "all" ||
    status !== DEFAULT_QUEUE_FILTERS.status ||
    branch !== "all" ||
    family !== "all" ||
    followup !== "all" ||
    term.trim() !== "" ||
    mineOnly ||
    unassignedOnly;

  function resetFilters() {
    setLeadType(DEFAULT_QUEUE_FILTERS.leadType);
    setStatus(DEFAULT_QUEUE_FILTERS.status);
    setBranch("all");
    setFamily("all");
    setFollowup("all");
    setTerm("");
    setMineOnly(false);
    setUnassignedOnly(false);
    setPage(0);
  }

  /** Any filter change returns to page 1 — page 4 of a different result set is
   *  a page the agent never asked for and usually an empty one. */
  function onFilter<T>(setter: (v: T) => void) {
    return (value: T) => {
      setter(value);
      setPage(0);
    };
  }

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-xl font-semibold">Telesales</h1>
          <p className="text-sm text-muted-foreground">
            {queue.isLoading
              ? "Loading the queue…"
              : `${total.toLocaleString("en-US")} lead${total === 1 ? "" : "s"}`}
          </p>
        </div>
        <div className="flex items-center gap-2">
          {/* Recommended is an agent view, so it sits outside the manage-only
              block — the whole point is the person making the calls. */}
          <Button asChild variant="outline" size="sm">
            <Link to="/telesales/recommended">
              <Lightbulb className="mr-2 h-4 w-4" />
              Recommended
            </Link>
          </Button>
          {canManage ? (
            <>
              <Button asChild variant="outline" size="sm">
                <Link to="/telesales/management">Management</Link>
              </Button>
              {/* Configuration, so it sits with the other manage-only links. */}
              <Button asChild variant="outline" size="sm">
                <Link to="/telesales/relations">Cross-sell</Link>
              </Button>
              <Button asChild variant="outline" size="sm">
                <Link to="/telesales/identity">Product identity</Link>
              </Button>
              <Button asChild size="sm">
                <Link to="/telesales/import">
                  <Upload className="mr-2 h-4 w-4" />
                  Import
                </Link>
              </Button>
            </>
          ) : null}
        </div>
      </div>

      {/* Quick pipeline switch. A row of buttons rather than a select: three
          options, and an agent switches between them constantly. */}
      <div className="flex flex-wrap items-center gap-2">
        <Button
          size="sm"
          variant={leadType === "all" ? "default" : "outline"}
          onClick={() => onFilter(setLeadType)("all")}
        >
          All
        </Button>
        {LEAD_TYPES.map((t) => (
          <Button
            key={t}
            size="sm"
            variant={leadType === t ? "default" : "outline"}
            onClick={() => onFilter(setLeadType)(t)}
          >
            {LEAD_TYPE_LABELS[t]}
          </Button>
        ))}
        <span className="mx-1 h-5 w-px bg-border" aria-hidden />
        <Button
          size="sm"
          variant={mineOnly ? "default" : "outline"}
          onClick={() => {
            onFilter(setMineOnly)(!mineOnly);
            if (!mineOnly) setUnassignedOnly(false);
          }}
        >
          My leads
        </Button>
        <Button
          size="sm"
          variant={unassignedOnly ? "default" : "outline"}
          onClick={() => {
            onFilter(setUnassignedOnly)(!unassignedOnly);
            if (!unassignedOnly) setMineOnly(false);
          }}
        >
          Unassigned
        </Button>
      </div>

      <Card>
        <CardContent className="space-y-3 p-3">
          <div className="flex flex-wrap items-center gap-2">
            <div className="relative min-w-[220px] flex-1">
              <Search className="absolute left-2.5 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
              <Input
                value={term}
                onChange={(e) => onFilter(setTerm)(e.target.value)}
                placeholder="Name, phone, Patient ID, prescription, invoice"
                className="pl-8"
              />
            </div>

            <Select value={status} onValueChange={onFilter(setStatus)}>
              <SelectTrigger className="w-[150px]">
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

            <Select value={followup} onValueChange={onFilter(setFollowup)}>
              <SelectTrigger className="w-[150px]">
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
             *
             * The stale count rides on the option itself, so a supervisor sees
             * how much old opportunity is in the system without changing the
             * filter to find out.
             */}
            <Select value={lifecycle} onValueChange={onFilter(setLifecycle)}>
              <SelectTrigger className="w-[190px]">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {LIFECYCLE_FILTER_OPTIONS.map((o) => (
                  <SelectItem key={o.value} value={o.value}>
                    {o.label}
                    {/* The size of each backlog, on the option itself, so a
                        supervisor sees how much is waiting without switching
                        view to find out. */}
                    {o.value === "stale" && backlog.data
                      ? ` · ${backlog.data.stale.toLocaleString("en-US")}`
                      : o.value === "archived" && backlog.data
                        ? ` · ${backlog.data.archived.toLocaleString("en-US")}`
                        : ""}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>

            <Select value={branch} onValueChange={onFilter(setBranch)}>
              <SelectTrigger className="w-[140px]">
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

            <Select value={family} onValueChange={onFilter(setFamily)}>
              <SelectTrigger className="w-[160px]">
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
        </CardContent>
      </Card>

      {/*
       * The backlog, in one line.
       *
       * Only while a supervisor is actually looking at it -- an agent working
       * the active queue does not need a running total of leads they have been
       * deliberately shielded from. Operational rather than analytical: three
       * numbers that say how big the problem is and how much of it nobody owns.
       */}
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
              <Button className="mt-4" variant="outline" size="sm" onClick={() => queue.refetch()}>
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
                  <p className="mt-2 text-sm font-medium">The queue is clear</p>
                  <p className="mt-1 text-sm text-muted-foreground">
                    {canManage
                      ? "Import a source file or run lead generation to fill it."
                      : "Nothing is waiting for you right now."}
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
            <Select
              value={String(pageSize)}
              onValueChange={(v) => {
                setPageSize(Number(v));
                setPage(0);
              }}
            >
              <SelectTrigger className="h-8 w-[80px]">
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
