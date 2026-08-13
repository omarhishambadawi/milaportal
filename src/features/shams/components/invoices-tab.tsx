/**
 * Invoices — find a document by number, then read it.
 *
 * ## Why there is a branch step at all
 *
 * A Shams document number is unique only *within* a warehouse, so `(branch,
 * docNo)` is the identity — `22138` can exist in several branches and mean
 * several different sales. The old form made the agent supply both, which meant
 * knowing the branch before looking anything up.
 *
 * So the number is asked for alone and the branch is *discovered*: the server
 * asks every branch whether it holds that number and returns the ones that do.
 * The MIS has no cross-branch lookup — `sales/details` takes exactly one
 * `wh_cd`, which is also why its own Sales Register demands a store code — so a
 * sweep is the only honest answer, and it runs once per submission, never while
 * typing.
 *
 * One match skips the chooser entirely; several present a short list; none is an
 * empty state, not an error, because a document that does not exist is a fact
 * the API reports with `200`.
 *
 * ## Customer and Call Centre status
 *
 * Both are shown, and the raw `customer` label is shown *unaltered* next to the
 * derived status rather than being replaced by it. The label is what a person
 * reconciling a document reads, and the distinction the rule turns on —
 * `CALL CENTER SALES` versus `CALL CENTER SALES-Call Centre` — is invisible if
 * only the badge is rendered. The rule itself lives in `normalize.ts`; this file
 * reads `invoice.isCallCentre` and never re-derives it.
 *
 * `Non Call Centre` is destructive-toned on purpose: it is the state that makes
 * an invoice ineligible, and an agent needs to see that without reading.
 */

import { useEffect, useMemo, useState, type FormEvent } from "react";
import { ArrowLeft, Building2, FileText, Loader2, Search } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import { fmtSAR } from "@/lib/branches";
import { cn } from "@/lib/utils";
import type { InvoiceBranchMatch, ShamsInvoice } from "@/lib/shams/types";
import {
  useBranchLabels,
  useInvoiceBranches,
  useInvoiceLookup,
  type BranchLabel,
} from "@/features/shams/hooks/use-shams-data";
import { TD, TH } from "@/features/shams/constants";
import { EmptyState, ErrorState, NotConfiguredState } from "./states";

export function InvoicesTab() {
  const [docNo, setDocNo] = useState("");
  /** The number actually searched for. Typing never triggers a sweep. */
  const [submitted, setSubmitted] = useState<string | null>(null);
  const [branchCode, setBranchCode] = useState<string | null>(null);

  const { data: branchLabels } = useBranchLabels();

  const discovery = useInvoiceBranches(submitted);
  const matches = discovery.matches;

  /**
   * One match needs no chooser — but only once the sweep is **finished**.
   *
   * Auto-selecting the first branch to answer would be wrong: a second branch
   * may still be coming, and the agent would already be looking at a document
   * they were never offered a choice about.
   */
  useEffect(() => {
    if (discovery.done && matches.length === 1) setBranchCode(matches[0].branchCode);
  }, [discovery.done, matches]);

  const invoiceQuery = useInvoiceLookup(
    branchCode && submitted ? { branchCode, docNo: submitted } : null,
  );
  const invoiceResult = invoiceQuery.data;
  const invoices = useMemo(() => invoiceResult?.invoices ?? [], [invoiceResult]);

  const canSubmit = docNo.trim() !== "";

  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (!canSubmit) return;
    setBranchCode(null);
    setSubmitted(docNo.trim());
  };

  const reset = () => {
    setBranchCode(null);
  };

  const searching = discovery.searching;
  /**
   * Show the chooser while the sweep is still running, as soon as there is
   * anything to show. It only disappears once a branch is picked.
   */
  const showChoice = matches.length > 1 || (matches.length > 0 && !discovery.done);

  return (
    <div className="space-y-4">
      <Card>
        <CardContent className="p-4">
          {/* A form, so Enter submits — the agent's hands never leave the
              number field. */}
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
                  placeholder="e.g. 22138"
                  inputMode="numeric"
                  autoComplete="off"
                  autoFocus
                  className="h-11 pl-9 font-mono text-base"
                />
              </div>
            </label>

            <Button type="submit" disabled={!canSubmit || searching} className="h-11 sm:w-40">
              <Search className="mr-1.5 h-4 w-4" aria-hidden="true" />
              {searching ? "Searching…" : "Find invoice"}
            </Button>
          </form>

          <p className="mt-2 text-xs leading-snug text-muted-foreground">
            Enter the number alone. The same number can exist in several branches, so the portal
            checks which branches hold it and asks only if there is a choice.
          </p>
        </CardContent>
      </Card>

      {!discovery.configured && <NotConfiguredState />}

      {discovery.failed && (
        <ErrorState kind={discovery.error?.kind} onRetry={() => discovery.refetch()} />
      )}

      {/* Progressive: the chooser appears as soon as a branch answers, and says
          for itself that more may still arrive. Only a sweep with nothing to
          show yet gets a skeleton. */}
      {searching && matches.length === 0 && <DiscoverySkeleton docNo={submitted} />}

      {discovery.done && !discovery.failed && matches.length === 0 && (
        <EmptyState icon={<FileText className="h-8 w-8 opacity-40" aria-hidden="true" />}>
          No invoice found for this document number.
        </EmptyState>
      )}

      {showChoice && !branchCode && (
        <BranchChoice
          matches={matches}
          labels={branchLabels}
          onChoose={setBranchCode}
          searching={!discovery.done}
        />
      )}

      {branchCode && matches.length > 1 && (
        <button
          type="button"
          onClick={reset}
          className="inline-flex items-center gap-1.5 text-xs font-medium text-muted-foreground transition-colors hover:text-foreground"
        >
          <ArrowLeft className="h-3.5 w-3.5" aria-hidden="true" />
          Back to the {matches.length} matching branches
        </button>
      )}

      {invoiceQuery.isError && <ErrorState onRetry={() => invoiceQuery.refetch()} />}

      {invoiceResult && invoiceResult.configured && !invoiceResult.ok && (
        <ErrorState kind={invoiceResult.error?.kind} onRetry={() => invoiceQuery.refetch()} />
      )}

      {branchCode && invoiceQuery.isFetching && !invoiceResult && <InvoiceSkeleton />}

      {invoices.map((invoice) => (
        <InvoiceCard
          key={`${invoice.branchCode}-${invoice.docNo}`}
          invoice={invoice}
          branchCity={invoice.branchCode ? branchCityOf(branchLabels, invoice.branchCode) : null}
        />
      ))}

      {!submitted && !searching && (
        <EmptyState icon={<FileText className="h-8 w-8 opacity-40" aria-hidden="true" />}>
          Enter an invoice number to look it up across all Shams branches.
        </EmptyState>
      )}
    </div>
  );
}

/* -------------------------------------------------------------------------- */
/* Branch discovery                                                            */
/* -------------------------------------------------------------------------- */

function branchCityOf(labels: Map<string, BranchLabel> | undefined, code: string): string | null {
  const hit = labels?.get(code);
  if (!hit) return null;
  return hit.cityEnglish ?? hit.city ?? null;
}

/**
 * The sweep takes a few seconds — every branch is asked — so it says what it is
 * doing rather than showing an anonymous spinner.
 */
function DiscoverySkeleton({ docNo }: { docNo: string | null }) {
  return (
    <Card>
      <CardContent className="space-y-3 p-4">
        <p className="text-sm text-muted-foreground">
          Searching Shams branches for document{" "}
          <span className="font-mono font-medium text-foreground">{docNo}</span>…
        </p>
        <Skeleton className="h-10 w-full" />
        <Skeleton className="h-10 w-full" />
      </CardContent>
    </Card>
  );
}

function InvoiceSkeleton() {
  return (
    <Card>
      <CardContent className="space-y-3 p-4">
        <Skeleton className="h-6 w-1/3" />
        <Skeleton className="h-4 w-1/2" />
        <Skeleton className="h-24 w-full" />
      </CardContent>
    </Card>
  );
}

/**
 * The branch chooser.
 *
 * Ordered Call Centre first (`sortInvoiceBranchMatches`, applied server-side and
 * again over the merged client list), and call-centre rows carry a left rule and
 * a tint so the row the agent wants is found by shape, before any reading.
 * Everything else stays plain: one emphasised row among five is a signal, five
 * emphasised rows are wallpaper.
 */
function BranchChoice({
  matches,
  labels,
  onChoose,
  searching,
}: {
  matches: InvoiceBranchMatch[];
  labels: Map<string, BranchLabel> | undefined;
  onChoose: (branchCode: string) => void;
  searching: boolean;
}) {
  return (
    <Card className="overflow-hidden">
      <CardContent className="p-0">
        <div className="flex flex-wrap items-center gap-x-2 gap-y-1 border-b border-border/60 bg-muted/30 px-4 py-2.5">
          <Building2 className="h-4 w-4 shrink-0 text-muted-foreground" aria-hidden="true" />
          <p className="text-sm font-medium">
            Found in {matches.length} {matches.length === 1 ? "branch" : "branches"}
            {matches.length > 1 ? " — choose one" : ""}
          </p>
          {searching && (
            <span className="inline-flex items-center gap-1.5 text-xs text-muted-foreground">
              <Loader2 className="h-3 w-3 animate-spin" aria-hidden="true" />
              still searching the remaining branches…
            </span>
          )}
        </div>
        <ul className="divide-y divide-border/40">
          {matches.map((match) => (
            <li key={match.branchCode}>
              <button
                type="button"
                onClick={() => onChoose(match.branchCode)}
                className={cn(
                  "flex w-full flex-wrap items-center justify-between gap-x-4 gap-y-1.5 border-l-2 px-4 py-3 text-left transition-colors hover:bg-muted/50 focus:bg-muted/50 focus:outline-none",
                  match.isCallCentre ? "border-l-success bg-success/5" : "border-l-transparent",
                )}
              >
                <span className="flex min-w-0 items-center gap-3">
                  <span className="font-mono text-sm font-semibold">{match.branchCode}</span>
                  <span className="truncate text-sm" dir="auto">
                    {branchCityOf(labels, match.branchCode) ?? "—"}
                  </span>
                  {match.cancelled && <CancelledBadge />}
                </span>
                <span className="flex shrink-0 items-center gap-3">
                  <CallCentreBadge isCallCentre={match.isCallCentre} compact />
                  <span className="text-sm font-semibold tabular-nums">
                    {fmtSAR(match.grandTotal)}
                  </span>
                </span>
              </button>
            </li>
          ))}
        </ul>
      </CardContent>
    </Card>
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

function CancelledBadge() {
  return (
    <span className="inline-flex shrink-0 rounded-full bg-destructive/10 px-2 py-0.5 text-[11px] font-semibold text-destructive">
      Cancelled
    </span>
  );
}

/**
 * Call Centre status.
 *
 * Both states are deliberately loud. `Non Call Centre` is destructive-toned
 * because it is the disqualifying answer, and an agent scanning a screen should
 * not have to read a neutral grey chip to learn that.
 */
function CallCentreBadge({ isCallCentre, compact }: { isCallCentre: boolean; compact?: boolean }) {
  return (
    <span
      className={cn(
        "inline-flex whitespace-nowrap rounded-full font-semibold",
        compact ? "px-2 py-0.5 text-[11px]" : "px-2.5 py-1 text-xs",
        isCallCentre ? "bg-success/10 text-success" : "bg-destructive/10 text-destructive",
      )}
    >
      {isCallCentre ? "Call Centre" : "Non Call Centre"}
    </span>
  );
}

function InvoiceCard({
  invoice,
  branchCity,
}: {
  invoice: ShamsInvoice;
  branchCity: string | null;
}) {
  return (
    <Card className={cn("overflow-hidden", invoice.cancelled && "border-destructive/50")}>
      <CardContent className="p-0">
        <div className="flex flex-wrap items-start justify-between gap-x-6 gap-y-3 border-b border-border/60 p-4">
          <Meta label="Document">
            <span className="font-mono">{invoice.docNo}</span>
            {invoice.cancelled && <span className="ml-2 align-middle">{<CancelledBadge />}</span>}
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
            <span className="break-words" dir="auto">
              {invoice.customer ?? "—"}
            </span>
          </Meta>
          <Meta label="Status">
            <CallCentreBadge isCallCentre={invoice.isCallCentre} />
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
            <table className="hidden w-full table-fixed text-sm md:table">
              <colgroup>
                <col />
                <col className="w-[14%]" />
                <col className="w-[9%]" />
                <col className="w-[15%]" />
                <col className="w-[17%]" />
              </colgroup>
              <thead>
                <tr className="border-b border-border/60 bg-muted/30 text-left text-[11px] uppercase tracking-wide text-muted-foreground">
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
                    <td className={cn(TD, "py-2.5 font-medium")}>{item.itemName}</td>
                    <td className={cn(TD, "py-2.5 font-mono text-xs text-muted-foreground")}>
                      {item.itemCode}
                    </td>
                    <td className={cn(TD, "py-2.5 text-right tabular-nums")}>{item.quantity}</td>
                    <td className={cn(TD, "py-2.5 text-right tabular-nums")}>
                      {fmtSAR(item.unitRate)}
                    </td>
                    <td className={cn(TD, "py-2.5 text-right font-semibold tabular-nums")}>
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
      <div className={cn("mt-0.5 text-sm", emphasis ? "text-base font-semibold" : "font-medium")}>
        {children}
      </div>
    </div>
  );
}
