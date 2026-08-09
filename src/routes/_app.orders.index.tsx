import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectLabel,
  SelectSeparator,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Card, CardContent } from "@/components/ui/card";
import { Checkbox } from "@/components/ui/checkbox";
import {
  ChevronLeft,
  ChevronRight,
  Download,
  Eye,
  Pencil,
  Plus,
  Search,
  ShieldCheck,
  Star,
} from "lucide-react";
import { STATUSES, STATUS_STYLES, TEAMS, fmtSAR, formatOrderNo } from "@/lib/branches";
import { cn } from "@/lib/utils";
import { DateRangePicker } from "@/components/date-range-picker";
import { FULFILLMENT_OPTIONS, PAGE_SIZE_OPTIONS } from "@/features/orders/constants";
import { fmtOrderDate } from "@/features/orders/utils";
import { CopyableOrderNo } from "@/features/orders/components/copyable-order-no";
import { TeamBadge } from "@/features/orders/components/team-badge";
import { StatusBadge } from "@/features/orders/components/status-badge";
import { KpiCard } from "@/features/orders/components/kpi-card";
import { InvoiceCell } from "@/features/orders/components/invoice-cell";
import { useOrdersListFilters } from "@/features/orders/hooks/use-orders-list-filters";
import { useOrdersListData } from "@/features/orders/hooks/use-orders-list-data";
import { useOrdersMutations } from "@/features/orders/hooks/use-orders-mutations";
import { useOrdersExport } from "@/features/orders/hooks/use-orders-export";
import {
  rememberOrderReturn,
  useOrdersScrollRestoration,
} from "@/features/orders/hooks/use-orders-scroll-restoration";

export const Route = createFileRoute("/_app/orders/")({
  head: () => ({ meta: [{ title: "Orders" }] }),
  component: OrdersList,
});

function OrdersList() {
  const navigate = useNavigate();
  const f = useOrdersListFilters();
  const data = useOrdersListData({
    from: f.from,
    to: f.to,
    team: f.team,
    agent: f.agent,
    status: f.status,
    fulfillment: f.fulfillment,

    mineOnly: f.mineOnly,
    starredOnly: f.starredOnly,
    userId: f.userId,
    canFilterAgents: f.canFilterAgents,
    term: f.term,
    searching: f.searching,
    filterKey: f.filterKey,
    page: f.page,
    pageSize: f.pageSize,
    applyFilters: f.applyFilters,
    namesById: f.namesById,
    cities: f.cities,
  });
  const { canEditOrder, canVerifyOrder, updateStatus, toggleVerified } = useOrdersMutations({
    userId: f.userId,
    canEditAll: f.canEditAll,
    canEditOwn: f.canEditOwn,
    canVerifyAll: f.canVerifyAll,
    canVerifyOwn: f.canVerifyOwn,
  });
  // Personal, per-agent shortcuts, read through `useOrdersListFilters` because
  // "Starred only" is one of the filters. RLS on `order_stars` is what keeps one
  // agent's shortlist out of another's list.
  const { starred, toggleStar, canStar } = f;
  const { exportXlsx } = useOrdersExport({
    from: f.from,
    to: f.to,
    canExport: f.canExport,
    applyFilters: f.applyFilters,
    namesById: f.namesById,
    cities: f.cities,
  });

  const { pageRows, summary, total, totalPages, currentPage, rangeStart, rangeEnd } = data;
  // The starred filter is an `id IN (…)` built from the agent's shortlist, so
  // until that list has arrived the narrowed query would legitimately match
  // nothing. Reporting it as loading keeps "No orders found" off the screen for
  // the one frame before the ids land.
  const isLoading = data.isLoading || (f.starredOnly && f.starsLoading);

  // Put the agent back on the order they left (filters, search and pagination
  // are already preserved via the module-level filter cache). `rowsKey` re-runs
  // the restore after each commit that changes the rows, so it searches a DOM
  // that holds the latest render; `settled` is what tells it a row that is still
  // missing is genuinely absent rather than not fetched yet.
  useOrdersScrollRestoration({
    ready: !isLoading && pageRows.length > 0,
    settled: !isLoading && !data.isFetching,
    rowsKey: pageRows.map((o: any) => o.id).join(","),
  });

  if (!f.canView) {
    return (
      <div className="text-center py-16">
        <Eye className="mx-auto h-10 w-10 text-muted-foreground" />
        <p className="mt-2 text-sm text-muted-foreground">You don't have access to Orders.</p>
      </div>
    );
  }

  return (
    <div className="space-y-4">
      <div className="grid grid-cols-[minmax(0,1fr)_auto] items-start gap-3 sm:flex sm:flex-wrap sm:items-center sm:justify-between">
        <div className="min-w-0">
          <h1 className="truncate text-xl font-semibold tracking-tight sm:text-2xl">Orders</h1>
          {/* The day name, not just the date. A list of one day's orders is read
              against the shift it belongs to — "Monday" tells an agent what they
              are looking at in a way "28/07/2026" makes them work out. Absent
              for a multi-day range, where naming one weekday would describe only
              the first of them. */}
          {!f.searching && (
            <p className="truncate text-xs sm:text-sm">
              {f.dateParts.weekday && (
                <span className="font-semibold text-foreground">{f.dateParts.weekday}, </span>
              )}
              <span className="text-muted-foreground">{f.dateParts.date}</span>
            </p>
          )}
          <p className="truncate text-xs text-muted-foreground sm:text-sm">
            <span className="font-medium text-foreground">{total}</span>{" "}
            {f.mineOnly ? "of your" : ""} orders{f.starredOnly ? " · starred" : ""}
            {f.searching ? " · search results" : ""}
          </p>
        </div>
        <div className="flex gap-2 items-center shrink-0">
          <Button
            variant={f.mineOnly ? "default" : "outline"}
            size="sm"
            onClick={() => f.onFilterChange(() => f.setMineOnly((v) => !v))}
          >
            {f.mineOnly ? "My orders" : "All orders"}
          </Button>
          {/* Export sits with the page-level actions rather than in the filter
              bar. It is not a filter — it acts on whatever the filters have
              already selected — and down there it was the only control on a
              second row, so the container carried a row of empty space to hold
              one button. Outline, so it reads as a utility beside the primary
              New order rather than competing with it. */}
          {f.canExport && (
            <Button variant="outline" size="sm" onClick={exportXlsx}>
              <Download className="h-4 w-4 sm:mr-2" />
              <span className="hidden sm:inline">Export Excel</span>
            </Button>
          )}
          {f.canCreate && (
            <Button size="sm" onClick={() => navigate({ to: "/orders/new" })}>
              <Plus className="h-4 w-4 sm:mr-2" />
              <span className="hidden sm:inline">New order</span>
            </Button>
          )}
        </div>
      </div>

      {/* Filter bar.
          One row of equal-height controls at desktop width, wrapping to as many
          as it needs below that. The padding is tighter than the page's other
          cards on purpose: this is a strip of controls, not content, and it sat
          two sizes too tall — `p-4` around `h-10` controls plus a second row
          holding nothing but the (now relocated) Export button. */}
      <Card>
        <CardContent className="p-2.5 sm:p-3 flex flex-wrap items-center gap-2">
          {/* Search is the primary control of the bar and is built to look it:
              it takes the leftover width up to `max-w-md` and lifts its shadow
              on focus. The dropdowns beside it narrow a set; this is the one an
              agent types an invoice number into all day. */}
          <div className="relative flex-1 min-w-[220px] lg:min-w-[260px] lg:max-w-md">
            <Search className="pointer-events-none absolute left-3.5 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
            <Input
              placeholder="Search order, invoice, customer, phone…"
              value={f.q}
              maxLength={80}
              onChange={(e) => {
                f.setQ(e.target.value);
                f.setPage(0);
              }}
              aria-label="Search orders"
              // Same radius, border and focus ring as every other control here
              // — the emphasis comes from width, breathing room around the icon
              // and a shadow that lifts on focus, not from a different shape.
              className="h-10 w-full pl-10 pr-3 text-sm shadow-sm transition-shadow placeholder:text-muted-foreground/75 focus-visible:shadow-md"
            />
          </div>
          <Select
            value={f.team}
            onValueChange={(v) =>
              f.onFilterChange(() => {
                f.setTeam(v);
                f.setAgent("all");
              })
            }
          >
            <SelectTrigger className="h-10 w-[140px]">
              <SelectValue placeholder="Team" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All teams</SelectItem>
              {TEAMS.map((t) => (
                <SelectItem key={t.value} value={t.value}>
                  {t.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          {/* `view_all_agents`, not administrator — an Auditor reviews other
              people's work and holds it by default. */}
          {f.canFilterAgents && (
            <Select value={f.agent} onValueChange={(v) => f.onFilterChange(() => f.setAgent(v))}>
              <SelectTrigger className="h-10 w-[160px]">
                <SelectValue placeholder="Agent" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">All agents</SelectItem>
                {f.filteredAgentOpts.map((a: any) => (
                  <SelectItem key={a.id} value={a.id}>
                    {a.full_name}
                    {a.agent_code ? ` (${a.agent_code})` : ""}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          )}
          <Select value={f.status} onValueChange={(v) => f.onFilterChange(() => f.setStatus(v))}>
            <SelectTrigger className="h-10 w-[140px]">
              <SelectValue placeholder="Status" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All statuses</SelectItem>
              {STATUSES.map((s) => (
                <SelectItem key={s} value={s}>
                  {s}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          {/* Delivery & Pickup, at two resolutions in one control.

              The top two entries are the grouped question — was it taken to the
              customer, or collected at the branch — and Delivery deliberately
              spans every courier, which is what it had stopped doing. Under them
              sit the individual methods for the narrower question, so picking
              "Azman" never has to mean leaving the grouped view first. Both feed
              the list, the KPI summary and the export through one classification
              (see features/orders/fulfillment.ts). */}
          <Select
            value={f.fulfillment}
            onValueChange={(v) => f.onFilterChange(() => f.setFulfillment(v))}
          >
            <SelectTrigger className="h-10 w-[170px]">
              <SelectValue placeholder="Delivery & Pickup" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">Delivery &amp; Pickup</SelectItem>
              {FULFILLMENT_OPTIONS.filter((o) => o.group === "fulfillment").map((o) => (
                <SelectItem key={o.value} value={o.value}>
                  {o.label}
                </SelectItem>
              ))}
              <SelectSeparator />
              {/* SelectLabel reads its group from context, so it must sit inside a
                  SelectGroup — as a direct child of SelectContent it throws and
                  takes the whole page down. */}
              <SelectGroup>
                <SelectLabel>Method</SelectLabel>
                {FULFILLMENT_OPTIONS.filter((o) => o.group === "method").map((o) => (
                  <SelectItem key={o.value} value={o.value}>
                    {o.label}
                  </SelectItem>
                ))}
              </SelectGroup>
            </SelectContent>
          </Select>

          {/* Starred only.
              A toggle rather than an entry in one of the Selects: it answers a
              different question from "which orders" (it answers "which of mine
              am I keeping an eye on"), and it has to compose with every other
              filter — Starred + this month + Delivery is the case it exists
              for. Sits in the filter bar rather than behind a second page, and
              carries the same icon as the column so the two read as one
              feature. The count is the affordance that stops the empty state
              being a mystery: an agent who has starred nothing can see that
              before turning it on. */}
          <Button
            variant="outline"
            size="sm"
            aria-pressed={f.starredOnly}
            disabled={!f.canStar}
            onClick={() => f.onFilterChange(() => f.setStarredOnly((v) => !v))}
            title={
              f.starredOnly
                ? "Showing only orders you starred — click to show all"
                : "Show only orders you starred"
            }
            // Outline like the dropdowns beside it, so it reads as one of the
            // filters rather than an action button that wandered in. Active is a
            // tinted surface and a filled star, not a solid block: it has to
            // look switched on without becoming the loudest thing in the bar.
            //
            // The label stays `foreground` when active rather than taking the
            // primary colour — turquoise text on a 10% turquoise wash measures
            // 2.15:1, which is a filter you cannot read. The border, the tint
            // and the star carry the state; the word stays legible.
            className={cn(
              "h-10 gap-2 px-3 font-normal",
              f.starredOnly && "border-primary/60 bg-primary/10 font-medium hover:bg-primary/15",
            )}
          >
            {/* Amber, so the filter and the starred rows it selects read as one
                feature. `--badge-amber` rather than the row's `--attention`:
                against this button's tinted surface that one measures 2.92:1 in
                light mode, under the 3:1 a meaningful graphic needs, and the
                badge token is the darker amber the system already keeps for
                exactly this — legible on a light fill, light on a dark one. */}
            <Star
              className={cn(
                "h-4 w-4",
                f.starredOnly ? "fill-current text-[var(--badge-amber)]" : "text-muted-foreground",
              )}
            />
            Starred
            {f.starred.size > 0 && (
              <span className="rounded-full bg-muted px-1.5 py-0.5 text-[10px] font-semibold leading-none tabular-nums text-muted-foreground">
                {f.starred.size}
              </span>
            )}
          </Button>

          <DateRangePicker
            range={f.range}
            onChange={(r) => {
              f.setRange(r);
              f.setPage(0);
            }}
            disabled={f.searching}
          />
        </CardContent>
      </Card>

      {/* KPI summary: 3 cards — Cash · Wasfaty · Total (each shows sales + completed sales + total/completed orders split) */}
      <div className="grid gap-3 sm:grid-cols-3">
        <KpiCard
          label="Cash"
          tone="from-[var(--tint-cash)] to-transparent"
          totalSales={summary.cashSales}
          completedSales={summary.cashCompletedSales}
          totalOrders={summary.cashCount}
          completedOrders={summary.cashCompletedCount}
        />
        <KpiCard
          label="Wasfaty"
          tone="from-[var(--tint-wasfaty)] to-transparent"
          totalSales={summary.wasSales}
          completedSales={summary.wasCompletedSales}
          totalOrders={summary.wasCount}
          completedOrders={summary.wasCompletedCount}
        />
        <KpiCard
          label="Total"
          tone="from-primary/10 to-transparent"
          highlight
          totalSales={summary.totalSales}
          completedSales={summary.totalCompletedSales}
          totalOrders={summary.totalCount}
          completedOrders={summary.completedCount}
        />
      </div>

      <Card>
        <CardContent className="p-0">
          {/*
            One table at every width, scrolled sideways on a phone.

            This replaces a bespoke mobile card list that rendered below `md`.
            The cards read well but they were a second layout of the same rows
            with their own truncation rules, and a column that was added to the
            table did not appear in them — the verified rail, the agent code and
            the delivery type were all desktop-only facts. A phone user
            reconciling invoices could not see what a desktop user could.

            A raw <table> rather than the ui/table wrapper, because the wrapper's
            own overflow container fights an outer one. `min-w` is what forces
            the horizontal scroll rather than letting twelve columns crush
            themselves into 380px.
          */}
          <div className="w-full overflow-x-auto overscroll-x-contain [-webkit-overflow-scrolling:touch]">
            <table
              className="w-full caption-bottom text-sm border-separate border-spacing-0"
              style={{ minWidth: 1240 }}
            >
              <colgroup>
                <col style={{ width: 44 }} />
                <col style={{ width: 40 }} />
                <col style={{ width: 168 }} />
                <col style={{ width: 176 }} />
                <col style={{ width: 210 }} />
                <col style={{ width: 160 }} />
                <col style={{ width: 140 }} />
                <col style={{ width: 76 }} />
                <col style={{ width: 118 }} />
                <col style={{ width: 122 }} />
                <col style={{ width: 132 }} />
                <col style={{ width: 48 }} />
              </colgroup>
              <thead className="sticky top-0 z-10 bg-muted/95 backdrop-blur">
                <tr className="text-[10.5px] uppercase tracking-[0.08em] font-semibold text-muted-foreground">
                  <th
                    className="text-center px-2 py-3 border-b border-border/70"
                    title="Call Center verified"
                  >
                    <ShieldCheck
                      className="h-4 w-4 mx-auto text-primary/80"
                      aria-label="Verified"
                    />
                  </th>
                  <th
                    className="text-center px-1 py-3 border-b border-border/70"
                    title="Starred by you"
                  >
                    <Star className="h-4 w-4 mx-auto text-primary/80" aria-label="Starred" />
                  </th>
                  <th className="text-left px-3 py-3 border-b border-border/70">Order</th>
                  <th className="text-left px-3 py-3 border-b border-border/70">Date</th>
                  <th className="text-left px-3 py-3 border-b border-border/70">Customer</th>
                  <th className="text-left px-3 py-3 border-b border-border/70">Agent</th>
                  <th className="text-left px-3 py-3 border-b border-border/70">Invoice No.</th>
                  <th className="text-left px-2 py-3 border-b border-border/70">Type</th>
                  <th className="text-left px-3 py-3 border-b border-border/70">Branch</th>
                  <th className="text-right px-3 py-3 border-b border-border/70">Value</th>
                  <th className="text-left px-3 py-3 border-b border-border/70">Status</th>
                  <th className="px-1 py-3 border-b border-border/70"></th>
                </tr>
              </thead>
              <tbody>
                {isLoading && (
                  <tr>
                    <td
                      colSpan={12}
                      className="text-center text-muted-foreground py-14 border-b border-border/50"
                    >
                      Loading…
                    </td>
                  </tr>
                )}
                {!isLoading && pageRows.length === 0 && (
                  <tr>
                    <td
                      colSpan={12}
                      className="text-center text-muted-foreground py-14 border-b border-border/50"
                    >
                      No orders found
                    </td>
                  </tr>
                )}
                {pageRows.map((o: any, idx: number) => {
                  const editable = canEditOrder(o);
                  const canVerifyRow = canVerifyOrder(o);
                  const verified = !!o.call_center_verified;
                  const isStarred = starred.has(o.id);
                  const zebra = idx % 2 === 1;
                  const rowBg = verified
                    ? "bg-[var(--tint-row)]"
                    : zebra
                      ? "bg-muted/25"
                      : "bg-background";
                  const cellCls = "align-middle border-b border-border/40 py-3";
                  return (
                    <tr
                      key={o.id}
                      // What the scroll restoration looks the row up by when the
                      // agent comes back from editing it. An id rather than an
                      // offset, because a save can move the row.
                      data-order-id={o.id}
                      className={cn("group transition-colors hover:bg-accent/50", rowBg)}
                    >
                      <td
                        className={cn("text-center px-2 relative", cellCls)}
                        onClick={(e) => e.stopPropagation()}
                      >
                        {verified && (
                          <span
                            aria-hidden
                            className="absolute left-0 top-0 bottom-0 w-[3px] bg-primary"
                          />
                        )}
                        <Checkbox
                          checked={verified}
                          disabled={!canVerifyRow}
                          onCheckedChange={(v) => toggleVerified(o, !!v)}
                          aria-label="Call Center invoice verified"
                        />
                      </td>
                      <td
                        className={cn("text-center px-1", cellCls)}
                        onClick={(e) => e.stopPropagation()}
                      >
                        <button
                          type="button"
                          onClick={() => toggleStar(o.id)}
                          disabled={!canStar}
                          aria-pressed={isStarred}
                          aria-label={isStarred ? "Remove star" : "Star this order"}
                          title={
                            isStarred ? "Starred — only you see this" : "Star — only you see this"
                          }
                          className={cn(
                            "inline-flex h-7 w-7 items-center justify-center rounded-md transition-colors",
                            "hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
                            isStarred
                              ? "text-[var(--attention)]"
                              : "text-muted-foreground/60 hover:text-foreground",
                            !canStar && "pointer-events-none opacity-40",
                          )}
                        >
                          <Star className={cn("h-4 w-4", isStarred && "fill-current")} />
                        </button>
                      </td>
                      <td className={cn("px-3", cellCls)}>
                        <div className="flex flex-col items-start gap-1 min-w-0">
                          <CopyableOrderNo value={formatOrderNo(o.team, o.display_no)} />
                          <TeamBadge team={o.team} />
                        </div>
                      </td>

                      <td
                        className={cn(
                          "whitespace-nowrap px-3 text-xs tabular-nums text-muted-foreground",
                          cellCls,
                        )}
                      >
                        {fmtOrderDate(o.order_date)}
                      </td>
                      <td className={cn("px-3 text-sm", cellCls)}>
                        <div className="truncate font-semibold text-foreground leading-tight">
                          {o.customer_name || (
                            <span className="text-muted-foreground font-normal">—</span>
                          )}
                        </div>
                        {o.customer_phone && (
                          <div className="mt-0.5 truncate text-[11px] text-muted-foreground font-mono">
                            {o.customer_phone}
                          </div>
                        )}
                      </td>
                      <td className={cn("px-3 text-sm", cellCls)}>
                        <div className="truncate text-foreground leading-tight">
                          {o.agent_name || <span className="text-muted-foreground">—</span>}
                        </div>
                        {o.agent_code && (
                          <div className="mt-0.5 truncate text-[11px] text-muted-foreground font-mono">
                            {o.agent_code}
                          </div>
                        )}
                      </td>
                      <td className={cn("px-3 text-[13px] font-mono text-foreground/90", cellCls)}>
                        <InvoiceCell value={o.invoice_no} />
                      </td>
                      <td
                        className={cn(
                          "px-2 text-xs text-muted-foreground whitespace-nowrap",
                          cellCls,
                        )}
                      >
                        {o.order_type}
                      </td>
                      <td className={cn("px-3 text-sm", cellCls)}>
                        <div className="font-mono font-medium truncate leading-tight">
                          {o.branch_no ?? "—"}
                        </div>
                        {o.city && (
                          <div className="mt-0.5 text-[11px] text-muted-foreground truncate">
                            {o.city}
                          </div>
                        )}
                      </td>
                      <td
                        className={cn(
                          "px-3 text-right text-sm font-mono font-semibold tabular-nums whitespace-nowrap text-foreground",
                          cellCls,
                        )}
                      >
                        {fmtSAR(o.invoice_value)}
                      </td>
                      <td onClick={(e) => e.stopPropagation()} className={cn("px-3", cellCls)}>
                        {editable ? (
                          <Select value={o.status} onValueChange={(v) => updateStatus(o, v)}>
                            <SelectTrigger
                              className={cn(
                                "h-8 w-full border px-2.5 text-xs font-semibold rounded-md",
                                STATUS_STYLES[o.status] ?? "",
                              )}
                            >
                              <SelectValue />
                            </SelectTrigger>
                            <SelectContent>
                              {STATUSES.map((s) => (
                                <SelectItem key={s} value={s}>
                                  {s}
                                </SelectItem>
                              ))}
                            </SelectContent>
                          </Select>
                        ) : (
                          <StatusBadge s={o.status} />
                        )}
                      </td>
                      <td className={cn("px-1 text-center", cellCls)}>
                        <Button
                          variant="ghost"
                          size="icon"
                          className="h-8 w-8 opacity-70 group-hover:opacity-100 transition-opacity"
                          onClick={() => {
                            // Captured here, before the navigation: opening the
                            // (much shorter) form clamps window.scrollY, so a
                            // position read on the way back is already lost.
                            rememberOrderReturn(o.id);
                            navigate({ to: "/orders/$id", params: { id: o.id } });
                          }}
                          aria-label={editable ? "Edit order" : "View order"}
                        >
                          {editable ? <Pencil className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
                        </Button>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>

          <div className="sticky bottom-0 z-10 bg-background/95 backdrop-blur supports-[backdrop-filter]:bg-background/80 flex flex-wrap items-center justify-between gap-3 p-3 border-t text-sm">
            <div className="text-muted-foreground">
              {total === 0 ? (
                "No orders"
              ) : (
                <>
                  Showing{" "}
                  <span className="font-medium text-foreground">
                    {rangeStart}–{rangeEnd}
                  </span>{" "}
                  of <span className="font-medium text-foreground">{total}</span> orders
                </>
              )}
            </div>
            <div className="flex items-center gap-2 ml-auto">
              <span className="text-xs text-muted-foreground hidden sm:inline">Rows per page</span>
              <Select value={String(f.pageSize)} onValueChange={(v) => f.setPageSize(Number(v))}>
                <SelectTrigger className="h-8 w-[72px]">
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
              <span className="text-xs text-muted-foreground px-2 whitespace-nowrap">
                Page {currentPage + 1} of {totalPages}
              </span>
              <Button
                size="sm"
                variant="outline"
                disabled={currentPage === 0}
                onClick={() => f.setPage((p) => Math.max(0, p - 1))}
              >
                <ChevronLeft className="h-4 w-4 sm:mr-1" />
                <span className="hidden sm:inline">Prev</span>
              </Button>
              <Button
                size="sm"
                variant="outline"
                disabled={currentPage + 1 >= totalPages}
                onClick={() => f.setPage((p) => Math.min(totalPages - 1, p + 1))}
              >
                <span className="hidden sm:inline">Next</span>
                <ChevronRight className="h-4 w-4 sm:ml-1" />
              </Button>
            </div>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
