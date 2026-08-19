/**
 * Customers — who a mobile number belongs to, and what they have bought.
 *
 * Backed by `GET /api/v2/crm/data`, the MIS's loyalty endpoint. One submitted
 * search asks for one page; nothing here runs while typing, which matters more
 * than usual because the thing being typed is a real person's phone number and
 * a per-keystroke version would look up a series of unrelated customers on the
 * way to the intended one.
 *
 * ## The shape of the screen
 *
 * Search, then who they are, then what they bought — in that order, because it
 * is the order an agent needs them on a call. The summary is a band of facts
 * rather than a table, so name, number and points are readable at a glance; the
 * history below it is the primary content and gets the space.
 *
 * ## What the API gives, and what it withholds
 *
 * The response is flat: every row repeats the customer and carries one
 * purchased line. So the summary above the table and the table itself come from
 * the same request — the summary is not a second lookup.
 *
 * Its `pagination` block reports `total: null` and `total_pages: null`, so
 * **there is no page count to show and no last page to jump to**. The footer
 * says which page is open and offers Previous/Next, and Next is offered exactly
 * when the page came back full — see `getCustomerHistory`. Rendering "Page 2 of
 * 7" would mean inventing the 7.
 *
 * The same absence governs the summary. "Total purchases" is only knowable when
 * the whole range fits in one page; when it does not, the figure says it counts
 * the page, because a number labelled as a total that is really a page is worse
 * than no number.
 *
 * **There are no per-purchase points.** The endpoint returns a customer-level
 * balance and nothing per line, so the history has no points column. A value
 * derived from the line total would be a guess about a loyalty scheme this
 * portal has no rules for.
 *
 * ## Where a mobile number is allowed to go
 *
 * Into the form, into the request, and onto this screen. Not into the URL: the
 * page's other tabs keep their state in the address bar, and this one
 * deliberately does not, because a search string in a URL ends up in history,
 * in a pasted link and in a screen-share. Paging is local state for the same
 * reason.
 */

import { useMemo, useState, type FormEvent } from "react";
import { format } from "date-fns";
import type { DateRange } from "react-day-picker";
import {
  CalendarClock,
  ChevronLeft,
  ChevronRight,
  Eye,
  FileText,
  Loader2,
  Phone,
  Receipt,
  Search,
  Star,
  User,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { DateRangePicker } from "@/components/date-range-picker";
import { fmtSAR } from "@/lib/branches";
import { cn } from "@/lib/utils";
import type { ShamsCrmCustomer, ShamsCrmSale } from "@/lib/shams/types";
import { countInvoices, groupSalesByMonth, latestSaleDate } from "@/lib/shams/crm-history";
import {
  useCustomerHistory,
  type CustomerHistoryQuery,
} from "@/features/shams/hooks/use-shams-data";
import { rememberInvoiceCustomer } from "@/features/shams/invoice-customer-link";
import { TD, TH } from "@/features/shams/constants";
import { EmptyState, ErrorState, NotConfiguredState, TableSkeleton } from "./states";

/**
 * Page sizes offered.
 *
 * 100 is the default and the only size any capture demonstrates; the smaller
 * two are offered because `per_page` is a confirmed, honoured parameter and a
 * shorter page is quicker to scan. Nothing downstream trusts the number that
 * was asked for — `hasMore` is measured against the size the API echoes back —
 * so a size the endpoint chose to clamp cannot truncate a history.
 *
 * 100 also does the most for correctness: the more of a range that fits in one
 * page, the more often the newest-first ordering below is globally true rather
 * than true within a page. See `sortSalesNewestFirst`.
 */
const PER_PAGE_OPTIONS = [25, 50, 100] as const;
const DEFAULT_PER_PAGE = 100;

/** The API's date format. Formatted locally — a window is calendar days, not instants. */
const toApiDate = (d: Date) => format(d, "yyyyMMdd");

/**
 * Ranges offered as one click.
 *
 * Months rather than day counts, so "3 months" means the same three months an
 * agent means, across months of different lengths.
 */
const QUICK_RANGES = [
  { months: 1, label: "1 month" },
  { months: 3, label: "3 months" },
  { months: 6, label: "6 months" },
  { months: 12, label: "12 months" },
] as const;

/**
 * A window of the last `months` months, ending today.
 *
 * `setMonth` with a negative overflow rolls the year correctly, and clamping the
 * day guards the case JavaScript gets wrong on its own: 31 March minus one month
 * is 31 February, which `Date` silently turns into 3 March and would quietly
 * drop two days off the start of the range.
 */
function rangeOfMonths(months: number): DateRange {
  const to = new Date();
  const from = new Date(to);
  from.setDate(1);
  from.setMonth(from.getMonth() - months);
  from.setDate(Math.min(to.getDate(), daysInMonth(from.getFullYear(), from.getMonth())));
  return { from, to };
}

function daysInMonth(year: number, monthIndex: number): number {
  // Day 0 of the next month is the last day of this one.
  return new Date(year, monthIndex + 1, 0).getDate();
}

/**
 * How far back an unsearched form looks: one rolling year.
 *
 * A pharmacy customer's useful history is seasonal — a repeat prescription, a
 * baby formula, an annual course — and a shorter default made an agent widen
 * the range and search a second time on almost every call. One year is one
 * request that usually answers the question.
 *
 * It costs nothing extra to *offer*: the range is a parameter on a request that
 * is made once per submitted search either way, and paging is unchanged.
 */
const DEFAULT_RANGE_MONTHS = 12;

export function CustomersTab({
  active = true,
  onOpenInvoice,
}: {
  /**
   * Whether this tab is the one on screen.
   *
   * All three tabs stay mounted so a switch does not discard a loaded history,
   * which means `autoFocus` has to be conditional — otherwise three inputs
   * claim focus on one mount and a hidden one can win.
   */
  active?: boolean;
  /**
   * Open a document from the history in the Invoices tab.
   *
   * The row carries the branch as well as the number, which is what makes this
   * the one-request path: the Invoices tab can go straight to that warehouse
   * instead of sweeping all 137 to find out which one holds it.
   */
  onOpenInvoice: (branchCode: string, docNo: string) => void;
}) {
  const [mobile, setMobile] = useState("");
  const [range, setRange] = useState<DateRange | undefined>(() =>
    rangeOfMonths(DEFAULT_RANGE_MONTHS),
  );
  const [perPage, setPerPage] = useState<number>(DEFAULT_PER_PAGE);

  /**
   * The search actually running — number, window and page together.
   *
   * One piece of state rather than four, so paging cannot desynchronise from
   * the number: changing the form after a search leaves the results alone until
   * the agent submits again, exactly as the Invoices tab behaves.
   */
  const [query, setQuery] = useState<CustomerHistoryQuery | null>(null);

  const historyQuery = useCustomerHistory(query);
  const result = historyQuery.data;
  const history = result?.ok ? result.history : null;

  const customer = history?.customer ?? null;
  const sales = useMemo(() => history?.sales ?? [], [history]);

  /** A range needs both ends; the picker reports a half-made one mid-click. */
  const rangeReady = Boolean(range?.from && range?.to);
  const canSubmit = mobile.trim() !== "" && rangeReady;

  const runSearch = (next: DateRange | undefined = range, page = 1) => {
    if (mobile.trim() === "" || !next?.from || !next?.to) return;
    setQuery({
      mobile: mobile.trim(),
      fromDate: toApiDate(next.from),
      toDate: toApiDate(next.to),
      page,
      perPage,
    });
  };

  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (!canSubmit) return;
    runSearch();
  };

  /**
   * A quick range sets the dates — and re-runs only if a search is already up.
   *
   * Re-running is the useful behaviour once results are on screen ("same
   * customer, wider window") and it is one request the agent asked for by
   * clicking. Before any search there is nothing to re-run, so it only fills
   * the picker.
   */
  const applyQuickRange = (months: number) => {
    const next = rangeOfMonths(months);
    setRange(next);
    if (query) runSearch(next);
  };

  /** Paging keeps everything but the page — see `placeholderData` in the hook. */
  const goToPage = (page: number) => {
    setQuery((prev) => (prev ? { ...prev, page } : prev));
  };

  /**
   * Changing the page size restarts at page one.
   *
   * It has to: page 3 of 100-row pages and page 3 of 25-row pages are different
   * rows, so keeping the number would silently move the agent somewhere they
   * did not ask to go. Applied immediately rather than on the next submit,
   * because it is a display choice about results already on screen.
   */
  const changePerPage = (next: number) => {
    setPerPage(next);
    setQuery((prev) => (prev ? { ...prev, perPage: next, page: 1 } : prev));
  };

  const open = (sale: ShamsCrmSale) => {
    if (!sale.branchCode || !sale.docNo) return;
    // Record the link *before* navigating, so the Invoices tab can show who
    // this document belongs to. The relationship is the CRM row's, not a guess
    // — see `invoice-customer-link.ts`.
    rememberInvoiceCustomer(sale.branchCode, sale.docNo, customer);
    onOpenInvoice(sale.branchCode, sale.docNo);
  };

  const searching = historyQuery.isFetching;
  /** A first load has no previous page to keep on screen; paging does. */
  const firstLoad = searching && !result;

  const page = history?.page ?? 1;
  const hasMore = history?.hasMore ?? false;
  /**
   * Is everything the range holds on this one page?
   *
   * Only then can a count be called a total. Page 1 with no next page is the
   * whole answer; anything else is a page of it, and the summary says so.
   */
  const wholeRangeLoaded = page === 1 && !hasMore;

  return (
    <div className="space-y-4">
      <Card>
        <CardContent className="space-y-3 p-4">
          <form onSubmit={submit} className="flex flex-col gap-3 lg:flex-row lg:items-end">
            <label className="flex min-w-0 flex-1 flex-col gap-1">
              <span className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
                Customer Mobile Number
              </span>
              <div className="relative">
                <Phone
                  className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground"
                  aria-hidden="true"
                />
                <Input
                  value={mobile}
                  onChange={(e) => setMobile(e.target.value)}
                  placeholder="e.g. 0555555555"
                  inputMode="tel"
                  autoComplete="off"
                  // Only when this tab is the visible one: all three are mounted.
                  autoFocus={active}
                  // Not `type="tel"` with a pattern: the number is accepted in
                  // whatever form the agent has it written down and canonicalized
                  // server-side, so browser-level validation would reject inputs
                  // the portal handles perfectly well.
                  className="h-11 pl-9 font-mono text-base"
                />
              </div>
            </label>

            <div className="flex min-w-0 flex-col gap-1">
              <span className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
                From &amp; To Date
              </span>
              {/* The portal's own range control, so this reads like the call
                  analytics screens rather than like a second date convention. */}
              <DateRangePicker range={range} onChange={setRange} />
            </div>

            <Button type="submit" disabled={!canSubmit || searching} className="h-11 lg:w-40">
              {searching ? (
                <Loader2 className="mr-1.5 h-4 w-4 animate-spin" aria-hidden="true" />
              ) : (
                <Search className="mr-1.5 h-4 w-4" aria-hidden="true" />
              )}
              {searching ? "Searching…" : "Find customer"}
            </Button>
          </form>

          <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
            <span className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
              Quick range
            </span>
            <div className="flex flex-wrap gap-1.5">
              {QUICK_RANGES.map((r) => (
                <button
                  key={r.months}
                  type="button"
                  onClick={() => applyQuickRange(r.months)}
                  disabled={searching}
                  className="rounded-full border border-border/70 px-2.5 py-1 text-xs font-medium transition-colors hover:bg-muted focus:bg-muted focus:outline-none disabled:opacity-50"
                >
                  {r.label}
                </button>
              ))}
            </div>
          </div>

          <p className="text-xs leading-snug text-muted-foreground">
            Any number format works — <span className="font-mono">0555555555</span>,{" "}
            <span className="font-mono">+966 55 555 5555</span>. The history covers only the dates
            chosen, and opens on the last {DEFAULT_RANGE_MONTHS} months.
          </p>
        </CardContent>
      </Card>

      {result && !result.configured && <NotConfiguredState />}

      {historyQuery.isError && <ErrorState onRetry={() => historyQuery.refetch()} />}

      {result && result.configured && !result.ok && (
        <ErrorState kind={result.error?.kind} onRetry={() => historyQuery.refetch()} />
      )}

      {firstLoad && <TableSkeleton rows={8} />}

      {customer && (
        <CustomerSummary
          customer={customer}
          sales={sales}
          wholeRangeLoaded={wholeRangeLoaded}
          onPage={page}
        />
      )}

      {/* A number nobody recognises and a customer with nothing in the window
          are different facts, and an agent needs to tell them apart: the first
          means "check the number", the second means "widen the dates". */}
      {result?.ok && !customer && !searching && (
        <EmptyState icon={<User className="h-8 w-8 opacity-40" aria-hidden="true" />}>
          No customer found for this mobile number.
        </EmptyState>
      )}

      {result?.ok && customer && sales.length === 0 && (
        <EmptyState icon={<FileText className="h-8 w-8 opacity-40" aria-hidden="true" />}>
          This customer has no purchases in the selected dates.
        </EmptyState>
      )}

      {sales.length > 0 && (
        <SalesHistory
          sales={sales}
          page={page}
          perPage={perPage}
          hasMore={hasMore}
          // Dim rather than unmount: paging should not blank the table and
          // throw the agent's scroll position back to the top.
          busy={searching}
          onOpenInvoice={open}
          onPage={goToPage}
          onPerPage={changePerPage}
        />
      )}

      {!query && (
        <EmptyState icon={<User className="h-8 w-8 opacity-40" aria-hidden="true" />}>
          Enter a customer's mobile number to see their purchase history.
        </EmptyState>
      )}
    </div>
  );
}

/* -------------------------------------------------------------------------- */
/* Summary                                                                     */
/* -------------------------------------------------------------------------- */

/**
 * Who the number belongs to, and the shape of what they bought.
 *
 * Every figure here is read off the response already on screen — there is no
 * second request behind this card, and nothing in it is derived from anything
 * the API did not return. In particular there is no lifetime spend, no order
 * frequency and no segment: `crm/data` supplies no line totals, so a currency
 * figure would have to be invented.
 *
 * Points are shown here and **only** here. They are a property of the customer,
 * not of any one purchase, so repeating them down a history table — or carrying
 * them onto an invoice — would attach a live loyalty balance to a document that
 * has nothing to do with it.
 */
function CustomerSummary({
  customer,
  sales,
  wholeRangeLoaded,
  onPage,
}: {
  customer: ShamsCrmCustomer;
  sales: ShamsCrmSale[];
  /** True when the range fits in one page, so a count is a total. */
  wholeRangeLoaded: boolean;
  onPage: number;
}) {
  // Distinct documents, not rows: the API returns one row per item, so counting
  // rows would report a three-item purchase as three purchases.
  const invoices = useMemo(() => countInvoices(sales), [sales]);
  const latest = useMemo(() => latestSaleDate(sales), [sales]);

  return (
    <Card>
      <CardContent className="flex flex-col gap-4 p-4 lg:flex-row lg:items-center lg:gap-6">
        <div className="flex min-w-0 items-center gap-3">
          <span
            className="grid h-11 w-11 shrink-0 place-items-center rounded-full bg-primary/10 text-primary"
            aria-hidden="true"
          >
            <User className="h-5 w-5" />
          </span>
          <div className="min-w-0">
            <p className="truncate text-lg font-semibold leading-tight" dir="auto">
              {customer.name ?? "Unnamed customer"}
            </p>
            <p className="mt-0.5 flex flex-wrap items-center gap-x-2 gap-y-0.5 text-xs text-muted-foreground">
              <span>
                ID <span className="font-mono text-foreground">{customer.customerId}</span>
              </span>
              <span aria-hidden="true">·</span>
              <span className="font-mono text-foreground">{customer.mobile ?? "—"}</span>
            </p>
          </div>
        </div>

        {/* Wraps rather than scrolls, so a phone stacks these instead of
            hiding the last one off the right edge. */}
        <div className="grid flex-1 grid-cols-2 gap-3 sm:grid-cols-4 lg:gap-5">
          <SummaryStat
            icon={<Star className="h-3.5 w-3.5" aria-hidden="true" />}
            label="Available points"
            value={fmtSAR(customer.availablePoints, { bare: true })}
          />
          <SummaryStat
            icon={<Star className="h-3.5 w-3.5" aria-hidden="true" />}
            label="Points value"
            value={fmtSAR(customer.pointsValue)}
          />
          <SummaryStat
            icon={<Receipt className="h-3.5 w-3.5" aria-hidden="true" />}
            // The label carries the caveat rather than a footnote: when the
            // range spills over a page this counts the page, and says so.
            label={wholeRangeLoaded ? "Invoices in range" : `Invoices on page ${onPage}`}
            value={String(invoices)}
          />
          <SummaryStat
            icon={<CalendarClock className="h-3.5 w-3.5" aria-hidden="true" />}
            label={wholeRangeLoaded ? "Last purchase" : "Latest on page"}
            value={formatSaleDate(latest)}
          />
        </div>
      </CardContent>
    </Card>
  );
}

function SummaryStat({
  icon,
  label,
  value,
}: {
  icon: React.ReactNode;
  label: string;
  value: string;
}) {
  return (
    <div className="min-w-0">
      <p className="flex items-center gap-1.5 text-[11px] uppercase tracking-wide text-muted-foreground">
        {icon}
        <span className="truncate">{label}</span>
      </p>
      <p className="mt-1 truncate text-lg font-semibold tabular-nums">{value}</p>
    </div>
  );
}

/* -------------------------------------------------------------------------- */
/* History                                                                     */
/* -------------------------------------------------------------------------- */

/**
 * `"2026-07-03T00:00:00"` → `"3 Jul 2026"`.
 *
 * By string, like the Invoices tab: the API supplies no timezone, so parsing to
 * an instant would shift a midnight purchase onto the previous day.
 */
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

function formatSaleDate(value: string | null): string {
  if (!value) return "—";
  const match = /^(\d{4})-(\d{2})-(\d{2})/.exec(value);
  if (!match) return value;
  return `${Number(match[3])} ${MONTHS[Number(match[2]) - 1] ?? match[2]} ${match[1]}`;
}

/** `"2026-07-03T00:00:00"` → `"3 Jul"`. Inside a month group the year is noise. */
function formatDayInMonth(value: string | null): string {
  if (!value) return "—";
  const match = /^(\d{4})-(\d{2})-(\d{2})/.exec(value);
  if (!match) return formatSaleDate(value);
  return `${Number(match[3])} ${MONTHS[Number(match[2]) - 1] ?? match[2]}`;
}

/**
 * The purchase history, grouped by month.
 *
 * Months come from `groupSalesByMonth`, which preserves the newest-first order
 * the data layer already established rather than sorting again — one comparator
 * for the whole feature, so the headings and the rows under them cannot drift
 * apart.
 *
 * The grouping is per page, because the API pages. A month that spans a page
 * boundary gets a heading on both, which is the honest rendering: the second
 * page really is showing more of that month. No row appears twice.
 *
 * One table with a `<tbody>` per month rather than a table per month, so every
 * column stays aligned down the whole history and `table-fixed` has one set of
 * widths to honour.
 */
function SalesHistory({
  sales,
  page,
  perPage,
  hasMore,
  busy,
  onOpenInvoice,
  onPage,
  onPerPage,
}: {
  sales: ShamsCrmSale[];
  page: number;
  perPage: number;
  hasMore: boolean;
  busy: boolean;
  onOpenInvoice: (sale: ShamsCrmSale) => void;
  onPage: (page: number) => void;
  onPerPage: (perPage: number) => void;
}) {
  const months = useMemo(() => groupSalesByMonth(sales), [sales]);

  return (
    <Card className="overflow-hidden">
      <CardContent className="p-0">
        <div className="flex flex-wrap items-center justify-between gap-2 border-b border-border/60 px-4 py-3">
          <h2 className="text-sm font-semibold">Purchase History</h2>
          <span className="text-xs text-muted-foreground">Newest first</span>
        </div>

        <div className={cn("transition-opacity", busy && "pointer-events-none opacity-60")}>
          <table className="hidden w-full table-fixed text-sm md:table">
            <colgroup>
              <col className="w-[11%]" />
              <col className="w-[11%]" />
              <col className="w-[17%]" />
              <col />
              <col className="w-[7%]" />
              <col className="w-[8%]" />
            </colgroup>
            <thead>
              <tr className="border-b border-border/60 bg-muted/30 text-left text-[11px] uppercase tracking-wide text-muted-foreground">
                <th className={TH}>Date</th>
                <th className={TH}>Invoice</th>
                <th className={TH}>Branch</th>
                <th className={TH}>Item</th>
                <th className={cn(TH, "text-right")}>Qty</th>
                <th className={cn(TH, "text-right")}>Actions</th>
              </tr>
            </thead>

            {months.map((month) => (
              <tbody key={month.key}>
                <tr>
                  {/* The separator an agent scans for. Sticky so the month
                      stays named while a long one scrolls past. */}
                  <th
                    colSpan={6}
                    scope="colgroup"
                    className="sticky top-0 z-10 border-y border-border/60 bg-muted/60 px-4 py-2 text-left backdrop-blur"
                  >
                    <span className="text-[13px] font-semibold">{month.label}</span>
                    <span className="ml-2 text-xs font-normal text-muted-foreground">
                      {month.invoices} {month.invoices === 1 ? "invoice" : "invoices"} ·{" "}
                      {month.sales.length} {month.sales.length === 1 ? "item" : "items"}
                    </span>
                  </th>
                </tr>
                {month.sales.map((sale, i) => (
                  <tr
                    key={`${sale.branchCode}-${sale.docNo}-${sale.itemCode}-${i}`}
                    className="border-b border-border/40 last:border-0"
                  >
                    <td className={cn(TD, "whitespace-nowrap py-2.5")}>
                      {formatDayInMonth(sale.docDate)}
                    </td>
                    <td className={cn(TD, "py-2.5 font-mono text-xs")}>{sale.docNo ?? "—"}</td>
                    <td className={cn(TD, "py-2.5 text-xs")}>
                      <BranchLabel sale={sale} />
                    </td>
                    <td className={cn(TD, "py-2.5 font-medium")} dir="auto">
                      {sale.itemName ?? "—"}
                      <span className="mt-0.5 block font-mono text-xs font-normal text-muted-foreground">
                        {sale.itemCode ?? "—"}
                      </span>
                    </td>
                    <td className={cn(TD, "py-2.5 text-right tabular-nums")}>{sale.quantity}</td>
                    <td className={cn(TD, "py-2.5 text-right")}>
                      <OpenInvoiceButton sale={sale} onOpen={onOpenInvoice} />
                    </td>
                  </tr>
                ))}
              </tbody>
            ))}
          </table>

          {/* Mobile: the same months, as sections. Nothing scrolls sideways. */}
          <div className="md:hidden">
            {months.map((month) => (
              <section key={month.key}>
                <h3 className="sticky top-0 z-10 border-y border-border/60 bg-muted/60 px-4 py-2 text-[13px] font-semibold backdrop-blur">
                  {month.label}
                  <span className="ml-2 text-xs font-normal text-muted-foreground">
                    {month.invoices} {month.invoices === 1 ? "invoice" : "invoices"}
                  </span>
                </h3>
                <ul className="divide-y divide-border/40">
                  {month.sales.map((sale, i) => (
                    <li
                      key={`${sale.branchCode}-${sale.docNo}-${sale.itemCode}-${i}`}
                      className="px-4 py-3"
                    >
                      <div className="flex items-start justify-between gap-3">
                        <p className="min-w-0 flex-1 text-sm font-medium leading-snug" dir="auto">
                          {sale.itemName ?? "—"}
                        </p>
                        <span className="shrink-0 text-sm font-semibold tabular-nums">
                          × {sale.quantity}
                        </span>
                      </div>
                      <p className="mt-0.5 font-mono text-xs text-muted-foreground">
                        {sale.itemCode ?? "—"}
                      </p>
                      <div className="mt-2 flex flex-wrap items-center justify-between gap-x-3 gap-y-1 text-xs">
                        <span className="flex flex-wrap items-center gap-x-2 gap-y-1">
                          <span className="text-muted-foreground">
                            {formatDayInMonth(sale.docDate)}
                          </span>
                          <span className="font-mono">{sale.docNo ?? "—"}</span>
                          <BranchLabel sale={sale} />
                        </span>
                        <OpenInvoiceButton sale={sale} onOpen={onOpenInvoice} withLabel />
                      </div>
                    </li>
                  ))}
                </ul>
              </section>
            ))}
          </div>
        </div>

        <Pager
          page={page}
          perPage={perPage}
          rows={sales.length}
          hasMore={hasMore}
          busy={busy}
          onPage={onPage}
          onPerPage={onPerPage}
        />
      </CardContent>
    </Card>
  );
}

/**
 * The way into a document from a history row.
 *
 * Rendered only when the row carries a branch: `sales/details` is scoped to one
 * warehouse, so without a branch code there is nothing to open. The invoice
 * number itself stays plain text in its own column — one affordance per row
 * rather than two controls that do the same thing.
 */
function OpenInvoiceButton({
  sale,
  onOpen,
  withLabel,
}: {
  sale: ShamsCrmSale;
  onOpen: (sale: ShamsCrmSale) => void;
  withLabel?: boolean;
}) {
  if (!sale.branchCode || !sale.docNo) return null;

  if (withLabel) {
    return (
      <button
        type="button"
        onClick={() => onOpen(sale)}
        className="inline-flex items-center gap-1.5 font-medium text-primary underline-offset-2 hover:underline"
      >
        <Eye className="h-3.5 w-3.5" aria-hidden="true" />
        Open invoice
      </button>
    );
  }

  return (
    <button
      type="button"
      onClick={() => onOpen(sale)}
      aria-label={`Open invoice ${sale.docNo}`}
      title={`Open invoice ${sale.docNo}`}
      className="inline-grid h-7 w-7 place-items-center rounded-md border border-border/70 text-muted-foreground transition-colors hover:bg-muted hover:text-foreground focus:bg-muted focus:outline-none"
    >
      <Eye className="h-3.5 w-3.5" aria-hidden="true" />
    </button>
  );
}

/** `P0215` with its city, or whatever the MIS printed when it will not split. */
function BranchLabel({ sale }: { sale: ShamsCrmSale }) {
  if (!sale.branchCode) {
    return <span className="text-muted-foreground">{sale.branchLabel ?? "—"}</span>;
  }
  return (
    <span className="flex flex-wrap items-baseline gap-x-1.5">
      <span className="font-mono">{sale.branchCode}</span>
      {sale.branchCity && (
        <span className="truncate text-muted-foreground" dir="auto">
          {sale.branchCity}
        </span>
      )}
    </span>
  );
}

/**
 * Paging, without a total.
 *
 * The API supplies neither `total` nor `total_pages`, so this says what it
 * actually knows: the page number, how many rows are on it, and whether there
 * is reason to think another exists. Next is disabled on a short page because a
 * short page is the end of the history.
 */
function Pager({
  page,
  perPage,
  rows,
  hasMore,
  busy,
  onPage,
  onPerPage,
}: {
  page: number;
  perPage: number;
  rows: number;
  hasMore: boolean;
  busy: boolean;
  onPage: (page: number) => void;
  onPerPage: (perPage: number) => void;
}) {
  return (
    <div className="flex flex-wrap items-center justify-between gap-3 border-t border-border/60 bg-muted/20 px-4 py-2.5">
      <div className="flex items-center gap-2 text-xs text-muted-foreground">
        <span>Rows per page</span>
        <Select value={String(perPage)} onValueChange={(v) => onPerPage(Number(v))} disabled={busy}>
          <SelectTrigger className="h-8 w-[74px]">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {PER_PAGE_OPTIONS.map((n) => (
              <SelectItem key={n} value={String(n)}>
                {n}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>

      <div className="flex items-center gap-3">
        <span className="text-xs text-muted-foreground">
          Page <span className="font-medium text-foreground">{page}</span> · {rows}{" "}
          {rows === 1 ? "item" : "items"}
        </span>
        <div className="flex items-center gap-1">
          <Button
            type="button"
            variant="outline"
            size="sm"
            className="h-8"
            disabled={busy || page <= 1}
            onClick={() => onPage(page - 1)}
          >
            <ChevronLeft className="mr-1 h-3.5 w-3.5" aria-hidden="true" />
            Previous
          </Button>
          <Button
            type="button"
            variant="outline"
            size="sm"
            className="h-8"
            disabled={busy || !hasMore}
            onClick={() => onPage(page + 1)}
          >
            Next
            <ChevronRight className="ml-1 h-3.5 w-3.5" aria-hidden="true" />
          </Button>
        </div>
      </div>
    </div>
  );
}
