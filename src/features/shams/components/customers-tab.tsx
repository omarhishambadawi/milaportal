/**
 * Customers — who a mobile number belongs to, and what they have bought.
 *
 * Backed by `GET /api/v2/crm/data`, the MIS's loyalty endpoint. One submitted
 * search asks for one page; nothing here runs while typing, which matters more
 * than usual because the thing being typed is a real person's phone number and
 * a per-keystroke version would look up a series of unrelated customers on the
 * way to the intended one.
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
import { ChevronLeft, ChevronRight, FileText, Loader2, Phone, Search, User } from "lucide-react";
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
 */
const PER_PAGE_OPTIONS = [25, 50, 100] as const;
const DEFAULT_PER_PAGE = 100;

/** How far back an unset search looks. */
const DEFAULT_WINDOW_DAYS = 90;

/** The API's date format. Formatted locally — a window is calendar days, not instants. */
const toApiDate = (d: Date) => format(d, "yyyyMMdd");

function defaultRange(): DateRange {
  const to = new Date();
  const from = new Date();
  from.setDate(from.getDate() - (DEFAULT_WINDOW_DAYS - 1));
  return { from, to };
}

export function CustomersTab({
  onOpenInvoice,
}: {
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
  const [range, setRange] = useState<DateRange | undefined>(defaultRange);
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

  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (!canSubmit || !range?.from || !range?.to) return;
    setQuery({
      mobile: mobile.trim(),
      fromDate: toApiDate(range.from),
      toDate: toApiDate(range.to),
      page: 1,
      perPage,
    });
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

  return (
    <div className="space-y-4">
      <Card>
        <CardContent className="p-4">
          <form onSubmit={submit} className="flex flex-col gap-3 sm:flex-row sm:items-end">
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

            <Button type="submit" disabled={!canSubmit || searching} className="h-11 sm:w-40">
              {searching ? (
                <Loader2 className="mr-1.5 h-4 w-4 animate-spin" aria-hidden="true" />
              ) : (
                <Search className="mr-1.5 h-4 w-4" aria-hidden="true" />
              )}
              {searching ? "Searching…" : "Find customer"}
            </Button>
          </form>

          <p className="mt-2 text-xs leading-snug text-muted-foreground">
            Search a customer by mobile number over a date range. Any format works —{" "}
            <span className="font-mono">0555555555</span>,{" "}
            <span className="font-mono">+966 55 555 5555</span> — and the history covers only the
            dates chosen.
          </p>
        </CardContent>
      </Card>

      {result && !result.configured && <NotConfiguredState />}

      {historyQuery.isError && <ErrorState onRetry={() => historyQuery.refetch()} />}

      {result && result.configured && !result.ok && (
        <ErrorState kind={result.error?.kind} onRetry={() => historyQuery.refetch()} />
      )}

      {firstLoad && <TableSkeleton rows={8} />}

      {customer && <CustomerSummary customer={customer} />}

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
          page={history?.page ?? 1}
          perPage={perPage}
          hasMore={history?.hasMore ?? false}
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
 * Who the number belongs to.
 *
 * Points are shown here and **only** here. They are a property of the customer,
 * not of any one purchase, so repeating them down a history table — or carrying
 * them onto an invoice — would attach a live loyalty balance to a document that
 * has nothing to do with it.
 */
function CustomerSummary({ customer }: { customer: ShamsCrmCustomer }) {
  return (
    <Card>
      <CardContent className="flex flex-wrap items-start gap-x-8 gap-y-3 p-4">
        <Field label="Customer">
          <span className="break-words" dir="auto">
            {customer.name ?? "—"}
          </span>
        </Field>
        <Field label="Mobile">
          <span className="font-mono">{customer.mobile ?? "—"}</span>
        </Field>
        <Field label="Customer ID">
          <span className="font-mono">{customer.customerId}</span>
        </Field>
        <Field label="Available Points">
          <span className="tabular-nums">{fmtSAR(customer.availablePoints, { bare: true })}</span>
        </Field>
        <Field label="Points Value">
          <span className="tabular-nums">{fmtSAR(customer.pointsValue)}</span>
        </Field>
      </CardContent>
    </Card>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="min-w-0">
      <p className="text-[11px] uppercase tracking-wide text-muted-foreground">{label}</p>
      <div className="mt-0.5 text-sm font-medium">{children}</div>
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
  return (
    <Card className="overflow-hidden">
      <CardContent className="p-0">
        <div
          className={cn("transition-opacity", busy && "pointer-events-none opacity-60")}
          aria-busy={busy}
        >
          <table className="hidden w-full table-fixed text-sm md:table">
            <colgroup>
              <col className="w-[13%]" />
              <col className="w-[11%]" />
              <col className="w-[16%]" />
              <col className="w-[12%]" />
              <col />
              <col className="w-[8%]" />
            </colgroup>
            <thead>
              <tr className="border-b border-border/60 bg-muted/30 text-left text-[11px] uppercase tracking-wide text-muted-foreground">
                <th className={TH}>Date</th>
                <th className={TH}>Invoice</th>
                <th className={TH}>Branch</th>
                <th className={TH}>Item Code</th>
                <th className={TH}>Item</th>
                <th className={cn(TH, "text-right")}>Qty</th>
              </tr>
            </thead>
            <tbody>
              {sales.map((sale, i) => (
                <tr
                  key={`${sale.docNo}-${sale.itemCode}-${i}`}
                  className="border-b border-border/40 last:border-0"
                >
                  <td className={cn(TD, "py-2.5 whitespace-nowrap")}>
                    {formatSaleDate(sale.docDate)}
                  </td>
                  <td className={cn(TD, "py-2.5")}>
                    <InvoiceLink sale={sale} onOpen={onOpenInvoice} />
                  </td>
                  <td className={cn(TD, "py-2.5 text-xs")}>
                    <BranchLabel sale={sale} />
                  </td>
                  <td className={cn(TD, "py-2.5 font-mono text-xs text-muted-foreground")}>
                    {sale.itemCode ?? "—"}
                  </td>
                  <td className={cn(TD, "py-2.5 font-medium")} dir="auto">
                    {sale.itemName ?? "—"}
                  </td>
                  <td className={cn(TD, "py-2.5 text-right tabular-nums")}>{sale.quantity}</td>
                </tr>
              ))}
            </tbody>
          </table>

          <ul className="divide-y divide-border/40 md:hidden">
            {sales.map((sale, i) => (
              <li key={`${sale.docNo}-${sale.itemCode}-${i}`} className="p-4">
                <p className="text-sm font-medium leading-snug" dir="auto">
                  {sale.itemName ?? "—"}
                </p>
                <p className="mt-0.5 font-mono text-xs text-muted-foreground">
                  {sale.itemCode ?? "—"}
                </p>
                <div className="mt-2 flex flex-wrap items-center justify-between gap-x-4 gap-y-1 text-xs">
                  <span className="flex flex-wrap items-center gap-x-2 gap-y-1">
                    <span className="text-muted-foreground">{formatSaleDate(sale.docDate)}</span>
                    <InvoiceLink sale={sale} onOpen={onOpenInvoice} />
                    <BranchLabel sale={sale} />
                  </span>
                  <span className="text-sm font-semibold tabular-nums">× {sale.quantity}</span>
                </div>
              </li>
            ))}
          </ul>
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
 * The invoice number, as a way into the document.
 *
 * A link only when the row carries a branch: `sales/details` is scoped to one
 * warehouse, so without a branch code there is nothing to open. The number is
 * still shown in that case — it is real information — just not clickable.
 */
function InvoiceLink({
  sale,
  onOpen,
}: {
  sale: ShamsCrmSale;
  onOpen: (sale: ShamsCrmSale) => void;
}) {
  if (!sale.docNo) return <span className="text-muted-foreground">—</span>;
  if (!sale.branchCode) return <span className="font-mono">{sale.docNo}</span>;
  return (
    <button
      type="button"
      onClick={() => onOpen(sale)}
      className="font-mono font-medium text-primary underline-offset-2 hover:underline"
      title={`Open invoice ${sale.docNo}`}
    >
      {sale.docNo}
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
        <span className="text-muted-foreground" dir="auto">
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
          {rows === 1 ? "row" : "rows"}
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
