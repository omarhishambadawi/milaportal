import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useCallback } from "react";
import { Button } from "@/components/ui/button";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Card, CardContent } from "@/components/ui/card";
import {
  ChevronLeft,
  ChevronRight,
  Download,
  Eye,
  SearchX,
  ShieldCheck,
  Star,
  Truck,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { PAGE_SIZE_OPTIONS } from "@/features/orders/constants";
import { KpiCard } from "@/features/orders/components/kpi-card";
import { OrderRow } from "@/features/orders/components/order-row";
import { OrdersToolbar } from "@/features/orders/components/orders-toolbar";
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

/** The table's twelve columns, for the loading and empty rows. */
const COLUMN_COUNT = 12;

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
    searchAgentIds: f.searchAgentIds,
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

  const { pageRows, summary, total, totalPages, currentPage, rangeStart, rangeEnd } = data;
  // The starred filter is an `id IN (…)` built from the agent's shortlist, so
  // until that list has arrived the narrowed query would legitimately match
  // nothing. Reporting it as loading keeps "No orders found" off the screen for
  // the one frame before the ids land.
  const isLoading = data.isLoading || (f.starredOnly && f.starsLoading);
  // A settled list being replaced under a new filter, rather than a first load.
  // Drives the table's dimming and the progress hairline; `isLoading` owns the
  // first paint, where there is nothing to dim.
  const isRefreshing = !isLoading && data.isFetching;

  /**
   * What the agent asked for, as one string.
   *
   * The `<tbody>` is keyed on it, which is what makes a filter change, a scope
   * change, a search or a page turn cross-fade rather than snap: a new key
   * remounts the body, so the incoming rows play the entry animation together.
   * Keyed on the *request* rather than on the rows, deliberately —
   * `keepPreviousData` holds the old rows on screen while the new page is in
   * flight, so a key derived from row ids would fire once on arrival, after the
   * moment it is meant to cover. Scrolling to another page of the same filter is
   * included; a background refetch that changes nothing is not.
   */
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

  if (!f.canView) {
    return (
      <div className="py-16 text-center">
        <Eye className="mx-auto h-10 w-10 text-muted-foreground" />
        <p className="mt-2 text-sm text-muted-foreground">You don't have access to Orders.</p>
      </div>
    );
  }

  return (
    // `orders-page` is the scope for this page's reduced-motion rules (see
    // styles.css). Nothing else hangs off it.
    <div className="orders-page space-y-3.5">
      {/* Header. Title, what is being looked at, and the one action that is not
          a filter.

          "New order" used to sit here as the page's primary button. It is one
          click away in the sidebar, on every page including this one, and a
          second copy of it was the loudest thing on a screen whose job is
          reading a list — so the header is now the sentence describing the list
          and nothing else. Creating an order is unchanged. */}
      <div className="flex flex-wrap items-end justify-between gap-x-4 gap-y-2">
        <div className="min-w-0">
          <h1 className="truncate text-xl font-semibold tracking-tight sm:text-[22px]">Orders</h1>
          {/* The day name, not just the date. A list of one day's orders is read
              against the shift it belongs to — "Monday" tells an agent what they
              are looking at in a way "28/07/2026" makes them work out. Absent
              for a multi-day range, where naming one weekday would describe only
              the first of them, and while searching, where the range is off. */}
          <p className="mt-0.5 flex flex-wrap items-center gap-x-1.5 truncate text-xs text-muted-foreground sm:text-[13px]">
            {!f.searching && (
              <>
                {f.dateParts.weekday && (
                  <span className="font-medium text-foreground">{f.dateParts.weekday},</span>
                )}
                <span>{f.dateParts.date}</span>
                <span aria-hidden className="text-border">
                  •
                </span>
              </>
            )}
            <span>
              <span className="font-semibold tabular-nums text-foreground">{total}</span>{" "}
              {f.mineOnly ? "of your orders" : "orders"}
              {f.starredOnly ? " · starred" : ""}
              {f.searching ? " · search results" : ""}
            </span>
          </p>
        </div>

        {/* Export acts on whatever the filters have already selected, so it is a
            page action rather than one of them. Outline: a utility, not the
            page's purpose. */}
        {f.canExport && (
          <Button variant="outline" size="sm" onClick={exportXlsx} className="h-9 shrink-0">
            <Download className="h-4 w-4 sm:mr-2" />
            <span className="hidden sm:inline">Export Excel</span>
          </Button>
        )}
      </div>

      <OrdersToolbar f={f} />

      {/* KPI summary: 3 cards — Cash · Wasfaty · Total (each shows sales +
          completed sales + total/completed orders split). Three across from
          `sm`; the card itself is what adapts to a narrow column (see
          `KpiCard`), because two-up here made the summary taller than the first
          screen of the table it summarises.

          On a phone the same reasoning gives two columns rather than one: three
          full-width cards stacked came to about 700px, so an agent opening
          Orders on a handset scrolled past the summary to reach the orders. Cash
          and Wasfaty pair naturally — they are the two halves — and Total spans
          both underneath, which is the hierarchy anyway. */}
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
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
          className="col-span-2 sm:col-span-1"
          tone="from-primary/10 to-transparent"
          highlight
          totalSales={summary.totalSales}
          completedSales={summary.totalCompletedSales}
          totalOrders={summary.totalCount}
          completedOrders={summary.completedCount}
        />
      </div>

      {/* Deliberately no `overflow-hidden` on the card. Clipping both axes makes
          an element a scroll container, and `position: sticky` measures against
          the nearest scrolling ancestor — one that never scrolls produces no
          offset, so the table's sticky header and its sticky pager would both
          stop sticking. Same trap the app shell documents at length. */}
      <Card>
        <CardContent className="relative p-0">
          {/* A 2px hairline across the top of the table while a new page is in
              flight. `keepPreviousData` means the old rows stay readable during a
              filter change — which is right, and also means nothing on screen
              says the list is about to change. This does, without a spinner and
              without moving anything. */}
          <div
            aria-hidden
            className={cn(
              "pointer-events-none absolute inset-x-0 top-0 z-20 h-0.5 overflow-hidden transition-opacity duration-200",
              isRefreshing ? "opacity-100" : "opacity-0",
            )}
          >
            <div className="orders-progress h-full w-1/3 bg-primary/70" />
          </div>

          {/*
            One table at every width, and **no horizontal scroll at any of
            them**. It used to be twelve fixed columns behind `min-width: 1240`,
            so every laptop read the list sideways.

            `table-fixed` with per-column widths, and columns that appear as the
            viewport earns them; what is not yet a column is folded into the
            row's meta line rather than dropped (see `OrderRow`). A raw <table>
            rather than the ui/table wrapper, because the wrapper brings its own
            overflow container — which is the thing being removed here.
          */}
          <table className="w-full table-fixed caption-bottom border-separate border-spacing-0 text-sm">
            <thead className="sticky top-0 z-10 bg-muted/95 backdrop-blur">
              <tr className="text-[10.5px] font-semibold uppercase tracking-[0.07em] text-muted-foreground">
                <th
                  className="w-8 border-b border-border/70 px-1 py-2.5 text-center sm:w-9"
                  title="Invoice verification — derived from verified invoice data"
                >
                  <ShieldCheck className="mx-auto h-4 w-4 text-primary/80" aria-label="Verified" />
                </th>
                <th
                  className="w-8 border-b border-border/70 px-0 py-2.5 text-center sm:w-9"
                  title="Starred by you"
                >
                  <Star className="mx-auto h-4 w-4 text-primary/80" aria-label="Starred" />
                </th>
                <th className="w-auto border-b border-border/70 px-2.5 py-2.5 text-left sm:w-[124px] lg:w-[146px]">
                  Order
                </th>
                <th className="hidden border-b border-border/70 px-2.5 py-2.5 text-left sm:table-cell">
                  Customer
                </th>
                <th className="hidden w-[104px] border-b border-border/70 px-2.5 py-2.5 text-left xl:table-cell">
                  Invoice
                </th>
                <th className="hidden w-[128px] border-b border-border/70 px-2.5 py-2.5 text-left xl:table-cell">
                  Agent
                </th>
                <th className="hidden w-[96px] border-b border-border/70 px-2.5 py-2.5 text-left 2xl:table-cell">
                  Branch
                </th>
                <th
                  className="hidden w-11 border-b border-border/70 px-2 py-2.5 text-left lg:table-cell 2xl:w-[104px]"
                  title="Delivery or pickup"
                >
                  <Truck className="h-4 w-4 text-primary/80 2xl:hidden" aria-label="Fulfillment" />
                  <span className="hidden 2xl:inline">Delivery</span>
                </th>
                <th className="hidden w-[92px] border-b border-border/70 px-2.5 py-2.5 text-right lg:table-cell">
                  Value (SAR)
                </th>
                <th className="w-[100px] border-b border-border/70 px-2 py-2.5 text-left lg:w-[120px]">
                  Status
                </th>
                <th className="hidden w-[64px] border-b border-border/70 px-2 py-2.5 text-left lg:table-cell">
                  Date
                </th>
                <th className="w-9 border-b border-border/70 px-0 py-2.5 sm:w-10"></th>
              </tr>
            </thead>
            {/* Keyed on the request, so a new filter's rows arrive as one quiet
                fade rather than a swap. Under `prefers-reduced-motion` the class
                is inert (styles.css) and the rows simply appear. */}
            <tbody
              key={viewKey}
              className={cn(
                "animate-in fade-in duration-200",
                "transition-opacity",
                isRefreshing && "opacity-60",
              )}
            >
              {isLoading && (
                <tr>
                  <td
                    colSpan={COLUMN_COUNT}
                    className="border-b border-border/50 py-14 text-center text-muted-foreground"
                  >
                    Loading…
                  </td>
                </tr>
              )}
              {!isLoading && pageRows.length === 0 && (
                <tr>
                  <td colSpan={COLUMN_COUNT} className="border-b border-border/50 py-14">
                    {/* An empty list has two causes and one of them is fixable
                        from here. Saying which, and offering the way out, beats
                        three words that leave the agent to work out that the
                        Verification dropdown they set an hour ago is still on. */}
                    <div className="mx-auto flex max-w-sm flex-col items-center gap-2 px-4 text-center">
                      <SearchX className="h-8 w-8 text-muted-foreground/50" aria-hidden />
                      <p className="text-sm font-medium text-foreground">No orders found</p>
                      <p className="text-xs text-muted-foreground">
                        {f.searching
                          ? `Nothing matches “${f.q.trim()}”.`
                          : f.activeFilterCount > 0
                            ? "No orders match the filters you have applied."
                            : "There are no orders in this date range."}
                      </p>
                      {f.activeFilterCount > 0 && (
                        <Button
                          variant="outline"
                          size="sm"
                          className="mt-1 h-8"
                          onClick={f.resetFilters}
                        >
                          Reset filters
                        </Button>
                      )}
                    </div>
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

          <div className="sticky bottom-0 z-10 flex flex-wrap items-center justify-between gap-3 border-t bg-background/95 p-2.5 text-sm backdrop-blur supports-[backdrop-filter]:bg-background/80">
            <div className="text-xs text-muted-foreground sm:text-sm">
              {total === 0 ? (
                "No orders"
              ) : (
                <>
                  Showing{" "}
                  <span className="font-medium tabular-nums text-foreground">
                    {rangeStart}–{rangeEnd}
                  </span>{" "}
                  of <span className="font-medium tabular-nums text-foreground">{total}</span>
                </>
              )}
            </div>
            <div className="ml-auto flex items-center gap-2">
              <span className="hidden text-xs text-muted-foreground sm:inline">Rows</span>
              <Select value={String(f.pageSize)} onValueChange={(v) => f.setPageSize(Number(v))}>
                <SelectTrigger className="h-8 w-[68px]">
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
              <span className="whitespace-nowrap px-1 text-xs tabular-nums text-muted-foreground">
                {currentPage + 1} / {totalPages}
              </span>
              <Button
                size="sm"
                variant="outline"
                className="h-8 px-2"
                disabled={currentPage === 0}
                onClick={() => f.setPage((p) => Math.max(0, p - 1))}
                aria-label="Previous page"
              >
                <ChevronLeft className="h-4 w-4" />
              </Button>
              <Button
                size="sm"
                variant="outline"
                className="h-8 px-2"
                disabled={currentPage + 1 >= totalPages}
                onClick={() => f.setPage((p) => Math.min(totalPages - 1, p + 1))}
                aria-label="Next page"
              >
                <ChevronRight className="h-4 w-4" />
              </Button>
            </div>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
