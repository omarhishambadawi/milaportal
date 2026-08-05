import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
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
import { useOrdersScrollRestoration } from "@/features/orders/hooks/use-orders-scroll-restoration";

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
  const { exportXlsx } = useOrdersExport({
    from: f.from,
    to: f.to,
    canExport: f.canExport,
    applyFilters: f.applyFilters,
    namesById: f.namesById,
    cities: f.cities,
  });

  const { isLoading, pageRows, summary, total, totalPages, currentPage, rangeStart, rangeEnd } =
    data;

  // Restore list scroll position when returning from an order (filters, search
  // and pagination are already preserved via the module-level filter cache).
  useOrdersScrollRestoration(!isLoading);

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
            {f.mineOnly ? "of your" : ""} orders{f.searching ? " · search results" : ""}
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
          {f.canCreate && (
            <Button size="sm" onClick={() => navigate({ to: "/orders/new" })}>
              <Plus className="h-4 w-4 sm:mr-2" />
              <span className="hidden sm:inline">New order</span>
            </Button>
          )}
        </div>
      </div>

      <Card>
        <CardContent className="p-3 sm:p-4 flex flex-wrap items-center gap-2 lg:gap-3">
          <div className="relative flex-1 min-w-[200px] lg:max-w-xs">
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
            <Input
              placeholder="Search order, invoice, customer, phone…"
              value={f.q}
              maxLength={80}
              onChange={(e) => {
                f.setQ(e.target.value);
                f.setPage(0);
              }}
              className="pl-9 h-10"
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
            <SelectTrigger className="h-10 w-[150px]">
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
              <SelectTrigger className="h-10 w-[180px]">
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
          {/* Delivery & Pickup — coarser than the courier stored on the row:
              anything collected at the branch is a pickup, everything else a
              delivery. Feeds the list, the KPI summary and the export alike. */}
          <Select
            value={f.fulfillment}
            onValueChange={(v) => f.onFilterChange(() => f.setFulfillment(v))}
          >
            <SelectTrigger className="h-10 w-[170px]">
              <SelectValue placeholder="Delivery & Pickup" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">Delivery &amp; Pickup</SelectItem>
              {FULFILLMENT_OPTIONS.map((o) => (
                <SelectItem key={o.value} value={o.value}>
                  {o.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>

          <DateRangePicker
            range={f.range}
            onChange={(r) => {
              f.setRange(r);
              f.setPage(0);
            }}
            disabled={f.searching}
          />
          {f.canExport && (
            <Button variant="outline" size="sm" onClick={exportXlsx} className="h-10 ml-auto">
              <Download className="h-4 w-4 mr-2" />
              Export
            </Button>
          )}
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
            the horizontal scroll rather than letting eleven columns crush
            themselves into 380px.
          */}
          <div className="w-full overflow-x-auto overscroll-x-contain [-webkit-overflow-scrolling:touch]">
            <table
              className="w-full caption-bottom text-sm border-separate border-spacing-0"
              style={{ minWidth: 1200 }}
            >
              <colgroup>
                <col style={{ width: 44 }} />
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
                      colSpan={11}
                      className="text-center text-muted-foreground py-14 border-b border-border/50"
                    >
                      Loading…
                    </td>
                  </tr>
                )}
                {!isLoading && pageRows.length === 0 && (
                  <tr>
                    <td
                      colSpan={11}
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
                          onClick={() => navigate({ to: "/orders/$id", params: { id: o.id } })}
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
