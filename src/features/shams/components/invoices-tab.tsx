/**
 * Invoices — look one document up.
 *
 * ## Branch is required, not optional
 *
 * The brief lists Branch as optional, but it cannot be: a Shams document number
 * is unique only *within* a warehouse, so `(branch, docNo)` is the identity, and
 * the server function rejects a query without a valid branch code. Making it
 * optional here would only produce a validation error a step later. It is
 * therefore a required field, labelled as part of the document's identity.
 *
 * ## No date filter
 *
 * Discovery marked the API's date parameters NOT VERIFIED — the MIS frontend
 * sends them empty on every captured request, so nobody has seen them filter
 * anything. Offering a date range would promise behaviour that has never been
 * observed.
 *
 * ## What is deliberately not shown
 *
 * The normalized invoice carries `totalCost` and `profit`. Both are omitted:
 * margin is not needed to read a document, and this milestone shows only what
 * the task requires. Patient identifiers never reach the client at all — they
 * are dropped server-side in `normalize.ts`, so there is nothing to filter out
 * here.
 *
 * ## Customer and Call Centre status
 *
 * Both are shown, and the raw `customer` label is shown *unaltered* next to the
 * derived status rather than being replaced by it. The label is what a person
 * reconciling a document reads, and the distinction the rule turns on —
 * `CALL CENTER SALES` versus `CALL CENTER SALES-Call Centre` — is invisible if
 * only the badge is rendered. The rule itself lives in `normalize.ts`; this file
 * reads `invoice.isCallCentre` and never re-derives it.
 */

import { useMemo, useState, type FormEvent } from "react";
import { Check, ChevronsUpDown, FileText, Search } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from "@/components/ui/command";
import { fmtSAR } from "@/lib/branches";
import { cn } from "@/lib/utils";
import type { ShamsInvoice } from "@/lib/shams/types";
import {
  useBranchLabels,
  useInvoiceLookup,
  type InvoiceLookup,
} from "@/features/shams/hooks/use-shams-data";
import { TD, TH } from "@/features/shams/constants";
import { EmptyState, ErrorState, NotConfiguredState, TableSkeleton } from "./states";

export function InvoicesTab() {
  const [branchCode, setBranchCode] = useState("");
  const [branchOpen, setBranchOpen] = useState(false);
  const [docNo, setDocNo] = useState("");
  // Only a submitted pair is ever queried — typing never triggers a lookup.
  const [submitted, setSubmitted] = useState<InvoiceLookup | null>(null);

  const { data: branchLabels } = useBranchLabels();
  const branches = useMemo(
    () => [...(branchLabels?.values() ?? [])].sort((a, b) => a.branchNo.localeCompare(b.branchNo)),
    [branchLabels],
  );
  const selectedBranch = branchCode ? (branchLabels?.get(branchCode) ?? null) : null;

  const query = useInvoiceLookup(submitted);
  const result = query.data;
  const invoices = useMemo(() => result?.invoices ?? [], [result]);

  const canSubmit = branchCode !== "" && docNo.trim() !== "";

  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (!canSubmit) return;
    setSubmitted({ branchCode, docNo: docNo.trim() });
  };

  return (
    <div className="space-y-4">
      <Card>
        <CardContent className="p-4">
          <form onSubmit={submit} className="flex flex-col gap-3 sm:flex-row sm:items-end">
            <label className="flex min-w-0 flex-1 flex-col gap-1">
              <span className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
                Invoice / Document Number
              </span>
              <div className="relative">
                <FileText
                  className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground"
                  aria-hidden="true"
                />
                <Input
                  value={docNo}
                  onChange={(e) => setDocNo(e.target.value)}
                  placeholder="e.g. 75181"
                  inputMode="numeric"
                  autoComplete="off"
                  className="h-10 pl-9 font-mono"
                />
              </div>
            </label>

            <div className="flex flex-col gap-1 sm:w-56">
              <span
                id="shams-branch-label"
                className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground"
              >
                Branch
              </span>
              {/* Searchable, because 137 branches is too many to scroll. Same
                  Popover + Command pattern the order form's branch picker uses,
                  over the same branch directory — no second data source. */}
              <Popover open={branchOpen} onOpenChange={setBranchOpen}>
                <PopoverTrigger asChild>
                  <Button
                    variant="outline"
                    role="combobox"
                    aria-expanded={branchOpen}
                    aria-labelledby="shams-branch-label"
                    className="h-10 w-full justify-between font-normal"
                  >
                    {selectedBranch ? (
                      <span className="flex min-w-0 items-center gap-2">
                        <span className="font-mono text-xs">{selectedBranch.branchNo}</span>
                        <span className="truncate text-muted-foreground" dir="auto">
                          {selectedBranch.cityEnglish ?? selectedBranch.city}
                        </span>
                      </span>
                    ) : (
                      <span className="text-muted-foreground">Select branch</span>
                    )}
                    <ChevronsUpDown className="h-4 w-4 shrink-0 opacity-50" aria-hidden="true" />
                  </Button>
                </PopoverTrigger>
                <PopoverContent
                  align="start"
                  className="w-[var(--radix-popover-trigger-width)] p-0"
                >
                  <Command>
                    <CommandInput placeholder="Search code, name or city…" />
                    <CommandList>
                      <CommandEmpty>No branch.</CommandEmpty>
                      <CommandGroup>
                        {branches.map((b) => (
                          <CommandItem
                            key={b.branchNo}
                            // What the search matches on: code, English name and
                            // the Arabic city, so "P0221", "0221", "Jeddah" and
                            // "جدة" all find the same branch.
                            value={`${b.branchNo} ${b.cityEnglish ?? ""} ${b.city}`}
                            onSelect={() => {
                              setBranchCode(b.branchNo);
                              setBranchOpen(false);
                            }}
                          >
                            <Check
                              className={cn(
                                "mr-2 h-4 w-4",
                                branchCode === b.branchNo ? "opacity-100" : "opacity-0",
                              )}
                              aria-hidden="true"
                            />
                            <span className="mr-2 font-mono text-xs">{b.branchNo}</span>
                            <span className="truncate text-muted-foreground" dir="auto">
                              {b.cityEnglish ?? b.city}
                            </span>
                          </CommandItem>
                        ))}
                      </CommandGroup>
                    </CommandList>
                  </Command>
                </PopoverContent>
              </Popover>
            </div>

            <Button type="submit" disabled={!canSubmit || query.isFetching} className="h-10">
              <Search className="mr-1.5 h-4 w-4" aria-hidden="true" />
              {query.isFetching ? "Looking up…" : "Look up"}
            </Button>
          </form>

          <p className="mt-2 text-[11px] leading-snug text-muted-foreground">
            A document number identifies an invoice only within its branch, so both are required.
          </p>
        </CardContent>
      </Card>

      {query.isError && <ErrorState onRetry={() => query.refetch()} />}

      {result && !result.configured && <NotConfiguredState />}

      {result && result.configured && !result.ok && (
        <ErrorState kind={result.error?.kind} onRetry={() => query.refetch()} />
      )}

      {query.isFetching && !result && <TableSkeleton rows={5} />}

      {result?.ok && invoices.length === 0 && !query.isFetching && (
        <EmptyState icon={<FileText className="h-8 w-8 opacity-40" aria-hidden="true" />}>
          No invoice found for document {submitted?.docNo} at {submitted?.branchCode}.
        </EmptyState>
      )}

      {invoices.map((invoice) => (
        <InvoiceCard
          key={`${invoice.branchCode}-${invoice.docNo}`}
          invoice={invoice}
          branchCity={
            invoice.branchCode
              ? (branchLabels?.get(invoice.branchCode)?.cityEnglish ??
                branchLabels?.get(invoice.branchCode)?.city ??
                null)
              : null
          }
        />
      ))}

      {!submitted && !query.isFetching && (
        <EmptyState icon={<FileText className="h-8 w-8 opacity-40" aria-hidden="true" />}>
          Enter a document number and branch to look up a Shams invoice.
        </EmptyState>
      )}
    </div>
  );
}

/* -------------------------------------------------------------------------- */
/* Rendering                                                                   */
/* -------------------------------------------------------------------------- */

/**
 * `"2026-08-13T00:00:00"` → `"13 Aug 2026"`.
 *
 * Formatted by string, not through `Date`. The API supplies no timezone, so
 * parsing to an instant and formatting it in the business timezone would shift
 * a midnight document onto the previous day. The date the MIS printed is the
 * date shown.
 */
function formatDocDate(value: string | null): string {
  if (!value) return "—";
  const match = /^(\d{4})-(\d{2})-(\d{2})/.exec(value);
  if (!match) return value;
  const MONTHS = [
    "Jan",
    "Feb",
    "Mar",
    "Apr",
    "May",
    "Jun",
    "Jul",
    "Aug",
    "Sep",
    "Oct",
    "Nov",
    "Dec",
  ];
  const month = MONTHS[Number(match[2]) - 1] ?? match[2];
  return `${Number(match[3])} ${month} ${match[1]}`;
}

function InvoiceCard({
  invoice,
  branchCity,
}: {
  invoice: ShamsInvoice;
  branchCity: string | null;
}) {
  return (
    <Card className={cn(invoice.cancelled && "border-destructive/50")}>
      <CardContent className="p-0">
        <div className="flex flex-wrap items-start justify-between gap-x-6 gap-y-3 border-b border-border/60 p-4">
          <Meta label="Document">
            <span className="font-mono">{invoice.docNo}</span>
            {invoice.cancelled && (
              <span className="ml-2 inline-flex rounded-full bg-destructive/10 px-2 py-0.5 text-[11px] font-semibold text-destructive">
                Cancelled
              </span>
            )}
          </Meta>
          <Meta label="Branch">
            <span className="font-mono">{invoice.branchCode ?? "—"}</span>
            {branchCity && <span className="ml-2 text-muted-foreground">{branchCity}</span>}
          </Meta>
          <Meta label="Date">{formatDocDate(invoice.docDate)}</Meta>
          <Meta label="Type">{invoice.docType ?? "—"}</Meta>
          <Meta label="Total" emphasis>
            {fmtSAR(invoice.grandTotal)}
          </Meta>
        </div>

        <div className="flex flex-wrap items-start justify-between gap-x-6 gap-y-3 border-b border-border/60 px-4 py-3">
          <Meta label="Customer">
            {/* Never truncated: the suffix that decides the status lives at the
                end of the label, and Arabic account names are long. */}
            <span className="break-words">{invoice.customer ?? "—"}</span>
          </Meta>
          <Meta label="Status">
            <span
              className={cn(
                "inline-flex rounded-full px-2 py-0.5 text-[11px] font-semibold",
                invoice.isCallCentre
                  ? "bg-primary/10 text-primary"
                  : "bg-muted text-muted-foreground",
              )}
            >
              {invoice.isCallCentre ? "Call Centre" : "Non Call Centre"}
            </span>
          </Meta>
        </div>

        <div className="flex flex-wrap gap-x-6 gap-y-2 border-b border-border/60 bg-muted/20 px-4 py-2.5 text-xs text-muted-foreground">
          <span>
            Discount <span className="font-medium tabular-nums">{fmtSAR(invoice.discount)}</span>
          </span>
          <span>
            Tax <span className="font-medium tabular-nums">{fmtSAR(invoice.totalTax)}</span>
          </span>
          <span>
            Items <span className="font-medium tabular-nums">{invoice.items.length}</span>
          </span>
        </div>

        {invoice.items.length === 0 ? (
          <p className="p-4 text-sm text-muted-foreground">This document returned no item lines.</p>
        ) : (
          <>
            <table className="hidden w-full text-sm md:table">
              <thead>
                <tr className="border-b border-border/60 text-left text-[11px] uppercase tracking-wide text-muted-foreground">
                  <th className={TH}>Item</th>
                  <th className={TH}>Code</th>
                  <th className={cn(TH, "text-right")}>Qty</th>
                  <th className={cn(TH, "text-right")}>Rate</th>
                  <th className={cn(TH, "text-right")}>Net Amount</th>
                </tr>
              </thead>
              <tbody>
                {invoice.items.map((item, i) => (
                  <tr
                    key={`${item.itemCode}-${i}`}
                    className="border-b border-border/40 last:border-0"
                  >
                    <td className={cn(TD, "font-medium")}>{item.itemName}</td>
                    <td className={cn(TD, "font-mono text-xs text-muted-foreground")}>
                      {item.itemCode}
                    </td>
                    <td className={cn(TD, "text-right tabular-nums")}>{item.quantity}</td>
                    <td className={cn(TD, "text-right tabular-nums")}>{fmtSAR(item.unitRate)}</td>
                    <td className={cn(TD, "text-right font-medium tabular-nums")}>
                      {fmtSAR(item.netAmount)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>

            <ul className="divide-y divide-border/40 md:hidden">
              {invoice.items.map((item, i) => (
                <li key={`${item.itemCode}-${i}`} className="p-4">
                  <p className="text-sm font-medium leading-snug">{item.itemName}</p>
                  <p className="mt-0.5 font-mono text-xs text-muted-foreground">{item.itemCode}</p>
                  <div className="mt-2 flex flex-wrap items-center justify-between gap-x-4 gap-y-1 text-xs">
                    <span className="text-muted-foreground">
                      {item.quantity} × {fmtSAR(item.unitRate)}
                    </span>
                    <span className="text-sm font-semibold tabular-nums">
                      {fmtSAR(item.netAmount)}
                    </span>
                  </div>
                </li>
              ))}
            </ul>
          </>
        )}
      </CardContent>
    </Card>
  );
}

function Meta({
  label,
  children,
  emphasis,
}: {
  label: string;
  children: React.ReactNode;
  emphasis?: boolean;
}) {
  return (
    <div className="min-w-0">
      <p className="text-[11px] uppercase tracking-wide text-muted-foreground">{label}</p>
      <p className={cn("mt-0.5 text-sm", emphasis ? "text-base font-semibold" : "font-medium")}>
        {children}
      </p>
    </div>
  );
}
