import { createFileRoute, Link } from "@tanstack/react-router";
import { useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import {
  ArrowLeft,
  ChevronLeft,
  ChevronRight,
  Lightbulb,
  Loader2,
  ShieldAlert,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
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
import { DOMAIN_LEAD_TYPES } from "@/lib/telesales/types";
import { businessToday } from "@/lib/telesales/dates";
import { familyLabel } from "@/lib/telesales/products";
import { BAND_LABELS, type RecommendationBand } from "@/lib/telesales/recommendations";
import { LeadRow } from "@/features/telesales/components/lead-row";
import { OutcomeDialog } from "@/features/telesales/components/outcome-dialog";
import { RecommendationStrip } from "@/features/telesales/components/recommendation-strip";
import { DEFAULT_PAGE_SIZE, PAGE_SIZE_OPTIONS } from "@/features/telesales/constants";
import { useLeadMutations } from "@/features/telesales/hooks/use-lead-detail";
import {
  useRecommendedLeads,
  useVisibleStock,
  type RecommendedQueueLead,
} from "@/features/telesales/hooks/use-recommended-leads";
import {
  useTelesalesBranches,
  useTelesalesFamilies,
} from "@/features/telesales/hooks/use-telesales-queue";

export const Route = createFileRoute("/_app/telesales/recommended")({
  head: () => ({ meta: [{ title: "Recommended leads — MilaServ Portal" }] }),
  component: RecommendedLeadsPage,
});

/**
 * Recommended leads.
 *
 * A view over the existing queue, not a second one. Every row is an ordinary
 * lead with its ordinary actions — call, claim, record — and the only thing
 * this page adds is an ordering and a sentence explaining it.
 *
 * The ordering is deterministic and comes from `recommendations.ts`: refills
 * due today, then overdue, then due within three days, then customers who have
 * bought the product before, then configured cross-sells. Nothing is scored.
 *
 * Filtering and paging happen in the browser, which is the opposite of the
 * queue's rule and deliberate: the recommendation is derived rather than
 * stored, so there is no column to filter on in SQL. The whole candidate set is
 * one bounded read (see `use-recommended-leads.ts`), and at the live volume of
 * 712 open leads the derivation is a few milliseconds.
 */

const BAND_FILTERS: { value: string; label: string }[] = [
  { value: "all", label: "Any recommendation" },
  { value: "refill", label: "Refill opportunity" },
  { value: "refill_due_today", label: BAND_LABELS.refill_due_today },
  { value: "refill_overdue", label: BAND_LABELS.refill_overdue },
  { value: "refill_soon", label: BAND_LABELS.refill_soon },
  { value: "previously_purchased", label: BAND_LABELS.previously_purchased },
  { value: "cross_sell", label: BAND_LABELS.cross_sell },
];

const STOCK_FILTERS = [
  { value: "all", label: "Any stock" },
  { value: "in_stock", label: "In stock" },
  { value: "out_of_stock", label: "Out of stock" },
  { value: "unknown", label: "Stock unknown" },
] as const;

const OWNER_FILTERS = [
  { value: "all", label: "Anyone" },
  { value: "mine", label: "My leads" },
  { value: "unassigned", label: "Unassigned" },
] as const;

function RecommendedLeadsPage() {
  const { profile, role, session } = useAuth();
  const userId = session?.user?.id;
  const perms = profile?.permissions as string[] | null | undefined;

  const canView = hasPerm(role, perms, "view_telesales");
  const canWork = hasPerm(role, perms, "work_telesales");

  const [band, setBand] = useState("all");
  const [stockFilter, setStockFilter] = useState<string>("all");
  const [owner, setOwner] = useState<string>("all");
  const [branch, setBranch] = useState("all");
  const [family, setFamily] = useState("all");
  const [page, setPage] = useState(0);
  const [pageSize, setPageSize] = useState<number>(DEFAULT_PAGE_SIZE);
  const [recording, setRecording] = useState<RecommendedQueueLead | null>(null);

  const { rows, summary, isLoading, error, capped, refetch } = useRecommendedLeads(canView);
  // Recommendations are a Cash-desk view: they rest on a purchase history and a
  // configured companion, neither of which a Wasfaty prescription has.
  const branches = useTelesalesBranches(canView, DOMAIN_LEAD_TYPES.cash.join(","));
  const families = useTelesalesFamilies(canView);
  const mutations = useLeadMutations();
  const today = businessToday();

  /*
   * Filters that need no stock are applied first, so the stock lookup only ever
   * runs for rows that survived everything else.
   */
  const preStock = useMemo(
    () =>
      rows.filter(({ lead, recommendation }) => {
        if (band === "refill" && recommendation.kind !== "refill") return false;
        if (
          band !== "all" &&
          band !== "refill" &&
          recommendation.band !== (band as RecommendationBand)
        )
          return false;
        if (owner === "mine" && lead.assigned_to !== userId) return false;
        if (owner === "unassigned" && lead.assigned_to !== null) return false;
        if (branch !== "all" && lead.branch_no !== branch) return false;
        if (family !== "all" && lead.product_family !== family) return false;
        return true;
      }),
    [rows, band, owner, userId, branch, family],
  );

  /*
   * Stock for what is about to be shown.
   *
   * The page of rows is computed before the lookup so only the visible
   * products are asked about — one request per distinct product, shared with
   * the /shams Stock tab's cache. When the stock filter is active the candidate
   * window widens to the filtered set, because a filter on stock cannot be
   * applied to answers we have not asked for.
   */
  const stockWindow = useMemo(
    () =>
      stockFilter === "all"
        ? preStock.slice(page * pageSize, page * pageSize + pageSize)
        : preStock,
    [preStock, stockFilter, page, pageSize],
  );
  const stockByCode = useVisibleStock(stockWindow, canView);

  const filtered = useMemo(() => {
    if (stockFilter === "all") return preStock;
    return preStock.filter(({ lead, recommendation }) => {
      const code = recommendation.crossSell?.toItemCode ?? lead.item_code;
      const state = (code ? stockByCode.get(code.trim())?.state : undefined) ?? "unknown";
      if (stockFilter === "unknown") return state === "unknown" || state === "not_found";
      return state === stockFilter;
    });
  }, [preStock, stockFilter, stockByCode]);

  const total = filtered.length;
  const pageCount = Math.max(1, Math.ceil(total / pageSize));
  const safePage = Math.min(page, pageCount - 1);
  const visible = filtered.slice(safePage * pageSize, safePage * pageSize + pageSize);

  /**
   * One roster fetch for the assignee names.
   *
   * Identical to the queue's, deliberately: it shares the queue's cache key, so
   * the query behind it must be the same query. A version of this that dropped
   * the `active` filter would return a different roster under the same key and
   * whichever page loaded first would decide what the other one showed.
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

  if (!canView) {
    return (
      <Card>
        <CardContent className="flex items-center gap-3 py-10 text-sm text-muted-foreground">
          <ShieldAlert className="h-5 w-5" />
          You do not have access to Telesales.
        </CardContent>
      </Card>
    );
  }

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <div className="flex items-center gap-2">
            <Lightbulb className="h-5 w-5 text-muted-foreground" />
            <h1 className="text-xl font-semibold">Recommended leads</h1>
          </div>
          <p className="text-sm text-muted-foreground">
            {isLoading
              ? "Working out which leads are worth a call…"
              : `${total.toLocaleString("en-US")} of ${(summary?.considered ?? 0).toLocaleString("en-US")} open leads`}
          </p>
        </div>
        <Button asChild variant="outline" size="sm">
          <Link to="/telesales">
            <ArrowLeft className="mr-2 h-4 w-4" />
            Back to the queue
          </Link>
        </Button>
      </div>

      {/* Filters. Only the ones an agent reaches for -- recommendation, stock,
          ownership, branch, product. */}
      <Card>
        <CardContent className="flex flex-wrap items-center gap-2 py-3">
          <Select value={band} onValueChange={(v) => (setBand(v), setPage(0))}>
            <SelectTrigger className="h-9 w-[210px]">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {BAND_FILTERS.map((o) => (
                <SelectItem key={o.value} value={o.value}>
                  {o.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>

          <Select value={stockFilter} onValueChange={(v) => (setStockFilter(v), setPage(0))}>
            <SelectTrigger className="h-9 w-[150px]">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {STOCK_FILTERS.map((o) => (
                <SelectItem key={o.value} value={o.value}>
                  {o.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>

          <Select value={owner} onValueChange={(v) => (setOwner(v), setPage(0))}>
            <SelectTrigger className="h-9 w-[140px]">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {OWNER_FILTERS.map((o) => (
                <SelectItem key={o.value} value={o.value}>
                  {o.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>

          <Select value={branch} onValueChange={(v) => (setBranch(v), setPage(0))}>
            <SelectTrigger className="h-9 w-[140px]">
              <SelectValue placeholder="Branch" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">Any branch</SelectItem>
              {(branches.data ?? []).map((b) => (
                <SelectItem key={b} value={b}>
                  {b}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>

          <Select value={family} onValueChange={(v) => (setFamily(v), setPage(0))}>
            <SelectTrigger className="h-9 w-[160px]">
              <SelectValue placeholder="Product" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">Any product</SelectItem>
              {(families.data ?? []).map((f) => (
                <SelectItem key={f} value={f}>
                  {familyLabel(f)}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>

          <div className="ml-auto flex items-center gap-2">
            <Select
              value={String(pageSize)}
              onValueChange={(v) => (setPageSize(Number(v)), setPage(0))}
            >
              <SelectTrigger className="h-9 w-[110px]">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {PAGE_SIZE_OPTIONS.map((n) => (
                  <SelectItem key={n} value={String(n)}>
                    {n} per page
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
        </CardContent>
      </Card>

      {capped ? (
        <p className="text-xs text-muted-foreground">
          Derived from the most recent 2,000 open leads.
        </p>
      ) : null}

      <Card>
        <CardContent className="p-0">
          {isLoading ? (
            <div className="flex items-center justify-center gap-2 py-16 text-sm text-muted-foreground">
              <Loader2 className="h-4 w-4 animate-spin" />
              Loading…
            </div>
          ) : error ? (
            <div className="space-y-3 py-12 text-center">
              <p className="text-sm text-muted-foreground">
                The recommendations could not be worked out.
              </p>
              <Button size="sm" variant="outline" onClick={refetch}>
                Try again
              </Button>
            </div>
          ) : visible.length === 0 ? (
            /*
             * An empty list is a real answer here, not a failure. The engine
             * declines a lead when the customer has no purchase history, the
             * product has no refill cycle, or nothing is due -- so the counts
             * say which, rather than leaving an agent to wonder.
             */
            <div className="space-y-2 py-12 text-center">
              <p className="text-sm font-medium">No leads meet a recommendation rule right now.</p>
              {summary ? (
                <p className="mx-auto max-w-xl text-xs text-muted-foreground">
                  Of {summary.considered.toLocaleString("en-US")} open leads:{" "}
                  {summary.declined.refill_too_stale} overdue by more than a full refill cycle,{" "}
                  {summary.declined.not_due_and_no_repeat} not due and never bought before,{" "}
                  {summary.declined.no_refill_basis} with no refill cycle configured,{" "}
                  {summary.declined.no_purchase_history} with no purchase history,{" "}
                  {summary.declined.no_phone} with no usable phone number. They are all still in the
                  queue.
                </p>
              ) : null}
            </div>
          ) : (
            <div>
              {visible.map(({ lead, recommendation }) => {
                const code = recommendation.crossSell?.toItemCode ?? lead.item_code;
                return (
                  <div key={lead.id} className="border-b border-border last:border-0">
                    <RecommendationStrip
                      recommendation={recommendation}
                      stock={code ? stockByCode.get(code.trim()) : undefined}
                    />
                    {/* The ordinary queue row, with the ordinary actions. */}
                    <LeadRow
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
                      selectable={false}
                      selected={false}
                      onSelect={() => {}}
                      isMine={Boolean(userId && lead.assigned_to === userId)}
                      canWork={canWork}
                      claiming={mutations.assign.isPending}
                      onClaim={(l) =>
                        mutations.assign.mutate({ leadId: l.id, assigneeId: userId ?? null })
                      }
                      onRecord={(l) => setRecording(l as RecommendedQueueLead)}
                    />
                  </div>
                );
              })}
            </div>
          )}
        </CardContent>
      </Card>

      {total > pageSize ? (
        <div className="flex items-center justify-between">
          <p className="text-xs text-muted-foreground">
            Page {safePage + 1} of {pageCount}
          </p>
          <div className="flex items-center gap-2">
            <Button
              size="sm"
              variant="outline"
              disabled={safePage === 0}
              onClick={() => setPage((p) => Math.max(0, p - 1))}
            >
              <ChevronLeft className="h-4 w-4" />
            </Button>
            <Button
              size="sm"
              variant="outline"
              disabled={safePage >= pageCount - 1}
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
        // Same as the queue: the row does not carry the product's cycle, and an
        // agent who needs the exact interval is one click from the lead.
        refillDays={null}
        customerLabel={
          recording
            ? [recording.customer_name, recording.item_name].filter(Boolean).join(" \xc2\xb7 ") ||
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
