import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useCallback } from "react";
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
import {
  ChevronLeft,
  ChevronRight,
  Download,
  Eye,
  Search,
  ShieldCheck,
  Star,
  X,
} from "lucide-react";
import { STATUSES, TEAMS } from "@/lib/branches";
import { cn } from "@/lib/utils";
import { DateRangePicker } from "@/components/date-range-picker";
import {
  FULFILLMENT_OPTIONS,
  PAGE_SIZE_OPTIONS,
  VERIFICATION_OPTIONS,
} from "@/features/orders/constants";
import { KpiCard } from "@/features/orders/components/kpi-card";
import { OrderRow } from "@/features/orders/components/order-row";
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
    verification: f.verification,

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
  const { canEditOrder, updateStatus } = useOrdersMutations({
    userId: f.userId,
    canEditAll: f.canEditAll,
    canEditOwn: f.canEditOwn,
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

  const {
    pageRows,
    summary,
    summaryUnavailable,
    total,
    totalPages,
    currentPage,
    rangeStart,
    rangeEnd,
  } = data;
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
  // `highlightedOrderId` marks the row the agent has just come back from, for a
  // couple of seconds. Same trip, same anchor: it is set when the restore finds
  // the row, so it survives the order being re-sorted or the list refetching.
  const { highlightedOrderId } = useOrdersScrollRestoration({
    ready: !isLoading && pageRows.length > 0,
    settled: !isLoading && !data.isFetching,
    rowsKey: pageRows.map((o: any) => o.id).join(","),
  });

  // Stable, so the memoised rows are not invalidated by the page re-rendering.
  // `rememberOrderReturn` is still captured here, before the navigation: opening
  // the (much shorter) form clamps window.scrollY, so a position read on the way
  // back is already lost.
  const openOrder = useCallback(
    (id: string) => {
      rememberOrderReturn(id);
      navigate({ to: "/orders/$id", params: { id } });
    },
    [navigate],
  );

  // What the agent last asked the list for, as one string.
  //
  // The <tbody> is keyed on it, so switching scope, changing a filter, running a
  // search or turning a page remounts the body and the incoming rows arrive as
  // one quiet fade instead of a swap. Keyed on the *request* rather than on the
  // rows: `keepPreviousData` holds the old rows on screen while the next page is
  // in flight, so a key derived from row ids would fire after the moment it is
  // meant to cover. A background refetch that changes nothing is not included,
  // and nothing here affects what is fetched.
  const viewKey = [
    f.mineOnly,
    f.starredOnly,
    f.team,
    f.agent,
    f.status,
    f.fulfillment,
    f.verification,
    f.term,
    f.from,
    f.to,
    f.page,
  ].join("|");

  if (!f.canView) {
    return (
      <div className="text-center py-16">
        <Eye className="mx-auto h-10 w-10 text-muted-foreground" />
        <p className="mt-2 text-sm text-muted-foreground">You don't have access to Orders.</p>
      </div>
    );
  }

  return (
    // `orders-page` scopes this page's reduced-motion rule (styles.css). It
    // carries no styling of its own.
    <div className="orders-page space-y-4">
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
        <div className="flex flex-wrap items-center justify-end gap-2 shrink-0">
          {/* Which orders am I looking at — the scope group.
              All / My were one button that swapped its own label, which meant
              the state you were not in was invisible. Two buttons state both,
              and Starred joins them because it answers the same question: it
              names a set of orders, not a property to filter them by, which is
              why it reads better here than among the dropdowns.

              Grouped tightly and divided from the actions on the right, so the
              header splits into "what I'm looking at" and "what I can do". */}
          <div className="flex items-center gap-1.5">
            {/* Guarded so clicking the scope you are already on does nothing.
                `onFilterChange` resets to page 1, which is right when the set
                changes and wrong when it does not — as a single toggle the case
                could not arise, and as two buttons it can. */}
            <Button
              variant={!f.mineOnly ? "default" : "outline"}
              size="sm"
              aria-pressed={!f.mineOnly}
              onClick={() => f.mineOnly && f.onFilterChange(() => f.setMineOnly(false))}
            >
              All orders
            </Button>
            <Button
              variant={f.mineOnly ? "default" : "outline"}
              size="sm"
              aria-pressed={f.mineOnly}
              onClick={() => !f.mineOnly && f.onFilterChange(() => f.setMineOnly(true))}
            >
              My orders
            </Button>
            {/* Starred is *not* a third option of the pair beside it — it
                narrows whichever of All/My is selected, and every other filter
                on top of that. Hence a separate pressed toggle rather than a
                third segment, which would promise the mutual exclusivity it
                does not have. */}
            <Button
              variant={f.starredOnly ? "default" : "outline"}
              size="sm"
              aria-pressed={f.starredOnly}
              disabled={!f.canStar}
              onClick={() => f.onFilterChange(() => f.setStarredOnly((v) => !v))}
              title={
                f.starredOnly
                  ? "Showing only orders you starred — click to show all"
                  : "Show only orders you starred"
              }
            >
              {/* Inherits the button's own foreground in both states, so the
                  contrast is the variant's rather than a colour of its own —
                  amber on a turquoise fill was the one pairing the design system
                  has no token for. */}
              <Star className={cn("h-4 w-4 sm:mr-2", f.starredOnly && "fill-current")} />
              <span className="hidden sm:inline">Starred</span>
              {f.starred.size > 0 && (
                <span
                  className={cn(
                    "ml-1.5 rounded-full px-1.5 py-0.5 text-[10px] font-semibold leading-none tabular-nums",
                    // A solid chip when active, not a translucent one: white on
                    // 20%-white over the primary fill measures 1.01:1, which is
                    // a count you cannot read at all.
                    f.starredOnly
                      ? "bg-background text-foreground"
                      : "bg-muted text-muted-foreground",
                  )}
                >
                  {f.starred.size}
                </span>
              )}
            </Button>
          </div>

          <div className="mx-0.5 hidden h-5 w-px bg-border sm:block" aria-hidden />

          {/* Export sits with the page-level actions rather than in the filter
              bar. It is not a filter — it acts on whatever the filters have
              already selected — and down there it was the only control on a
              second row, so the container carried a row of empty space to hold
              one button.

              It is the only action here now. "New order" stood beside it as the
              page's primary button and has been removed: the sidebar offers it
              on every page, including this one, so the header copy was a second
              route to the same form. Creating an order is otherwise unchanged —
              `/orders/new`, the `create_orders` permission and the form are all
              untouched. */}
          {f.canExport && (
            <Button variant="outline" size="sm" onClick={exportXlsx}>
              <Download className="h-4 w-4 sm:mr-2" />
              <span className="hidden sm:inline">Export Excel</span>
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
      <Card className="animate-in fade-in fill-mode-both duration-300">
        <CardContent className="p-2.5 sm:p-3 flex flex-wrap items-center gap-2">
          {/* Search is the primary control of the bar and is built to look it:
              it takes the leftover width up to `max-w-md` and lifts its shadow
              on focus. The dropdowns beside it narrow a set; this is the one an
              agent types an invoice number into all day. */}
          {/* Same box, same width, same height, same place in the bar. What
              changed is the finish: the icon dims a shade so it reads as an
              affordance rather than as content, the focus state adds a soft
              primary ring to the lifted shadow instead of relying on the shadow
              alone, and the field can now be cleared without selecting its
              contents — an × while there is text, and Escape from the keyboard.
              `pr-9` is the room that × needs; nothing else moved. */}
          <div className="group/search relative flex-1 min-w-[220px] lg:min-w-[260px] lg:max-w-md">
            <Search className="pointer-events-none absolute left-3.5 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground/70 transition-colors group-focus-within/search:text-foreground" />
            <Input
              placeholder="Search order, invoice, customer, phone…"
              value={f.q}
              maxLength={80}
              onChange={(e) => {
                f.setQ(e.target.value);
                f.setPage(0);
              }}
              onKeyDown={(e) => {
                // The convention for a search field, and the reason the × never
                // has to be reached for.
                if (e.key === "Escape" && f.q) {
                  e.preventDefault();
                  f.setQ("");
                  f.setPage(0);
                }
              }}
              aria-label="Search orders"
              // Same radius, border and focus ring as every other control here
              // — the emphasis comes from width, breathing room around the icon
              // and a shadow that lifts on focus, not from a different shape.
              className="h-10 w-full pl-10 pr-9 text-sm shadow-sm transition-[box-shadow,border-color] duration-200 placeholder:text-muted-foreground/75 focus-visible:border-primary/50 focus-visible:shadow-md"
            />
            {f.q && (
              <button
                type="button"
                onClick={() => {
                  f.setQ("");
                  f.setPage(0);
                }}
                aria-label="Clear search"
                className="absolute right-2 top-1/2 inline-flex h-6 w-6 -translate-y-1/2 items-center justify-center rounded text-muted-foreground transition-colors hover:bg-accent hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
              >
                <X className="h-3.5 w-3.5" />
              </button>
            )}
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
          {/* Invoice Verification — three states over `orders.invoices_verified`,
              the column the first column of the table already reads. Applied
              through the same `onFilterChange` and the same `applyOrderFilters`
              as everything beside it, so it composes with status, team, agent,
              date, fulfillment, scope and search rather than replacing any of
              them. See features/orders/verification.ts. */}
          <Select
            value={f.verification}
            onValueChange={(v) => f.onFilterChange(() => f.setVerification(v))}
          >
            {/* 140px — the same width as Status and Team beside it, which is
                both the more consistent choice and, at 1440, exactly the ten
                pixels that keep the bar on one row. */}
            <SelectTrigger className="h-10 w-[140px]">
              <SelectValue placeholder="Invoice" />
            </SelectTrigger>
            <SelectContent>
              {VERIFICATION_OPTIONS.map((o) => (
                <SelectItem key={o.value} value={o.value}>
                  {o.label}
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
      <div className="grid gap-3 sm:grid-cols-3 animate-in fade-in fill-mode-both delay-75 duration-300">
        <KpiCard
          label="Cash"
          tone="from-[var(--tint-cash)] to-transparent"
          totalSales={summary.cashSales}
          completedSales={summary.cashCompletedSales}
          totalOrders={summary.cashCount}
          completedOrders={summary.cashCompletedCount}
          unavailable={summaryUnavailable}
        />
        <KpiCard
          label="Wasfaty"
          tone="from-[var(--tint-wasfaty)] to-transparent"
          totalSales={summary.wasSales}
          completedSales={summary.wasCompletedSales}
          totalOrders={summary.wasCount}
          completedOrders={summary.wasCompletedCount}
          unavailable={summaryUnavailable}
        />
        <KpiCard
          label="Total"
          tone="from-primary/10 to-transparent"
          highlight
          totalSales={summary.totalSales}
          completedSales={summary.totalCompletedSales}
          totalOrders={summary.totalCount}
          completedOrders={summary.completedCount}
          unavailable={summaryUnavailable}
        />
      </div>

      {/* The strip is the only thing that failed, and it says so itself rather
          than leaving three cards of dashes to be read as an empty day. The list
          below is a separate query and is unaffected, which is worth stating: an
          agent looking at rows and no totals should know the rows are sound. */}
      {summaryUnavailable && (
        <p role="status" className="-mt-1 text-xs text-destructive">
          Totals could not be loaded. The list below is unaffected.
        </p>
      )}

      <Card className="animate-in fade-in fill-mode-both delay-150 duration-300">
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
              {/* Two of these changed, and they pay for each other exactly.

                  Date drops 176 → 92 because `dd/MM/yy` needs a fraction of what
                  the spelled-out weekday did, and Type takes the 84px back
                  (76 → 160) to seat the Delivery/Pickup badge beside the payment
                  type it already showed. Every other column is untouched, the
                  table's `min-w` is unchanged, and no font or row height moved:
                  the new information is paid for by the column that was widest
                  for the least. */}
              <colgroup>
                <col style={{ width: 44 }} />
                <col style={{ width: 40 }} />
                <col style={{ width: 168 }} />
                <col style={{ width: 92 }} />
                <col style={{ width: 210 }} />
                <col style={{ width: 160 }} />
                <col style={{ width: 140 }} />
                <col style={{ width: 160 }} />
                <col style={{ width: 118 }} />
                <col style={{ width: 122 }} />
                <col style={{ width: 132 }} />
                <col style={{ width: 48 }} />
              </colgroup>
              <thead className="sticky top-0 z-10 bg-muted/95 backdrop-blur">
                <tr className="text-[10.5px] uppercase tracking-[0.08em] font-semibold text-muted-foreground">
                  <th
                    className="text-center px-2 py-3 border-b border-border/70"
                    title="Call Centre — derived from verified invoice data"
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
              <tbody
                key={viewKey}
                className={cn(
                  "animate-in fade-in duration-200",
                  // Opacity only, and only once the first page has painted —
                  // the rows stay exactly where they are while the next set
                  // loads, which is the point of keeping them on screen.
                  "transition-opacity duration-200",
                  !isLoading && data.isFetching && "opacity-70",
                )}
              >
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
                {pageRows.map((o: any) => (
                  <OrderRow
                    key={o.id}
                    order={o}
                    editable={canEditOrder(o)}
                    isStarred={starred.has(o.id)}
                    canStar={canStar}
                    highlighted={o.id === highlightedOrderId}
                    onToggleStar={toggleStar}
                    onUpdateStatus={updateStatus}
                    onOpen={openOrder}
                  />
                ))}
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
