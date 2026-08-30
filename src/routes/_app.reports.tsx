import { createFileRoute } from "@tanstack/react-router";
import { useMemo, useState } from "react";
import { endOfMonth, format, startOfMonth } from "date-fns";
import { Printer, ShieldAlert } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { useAuth } from "@/lib/auth";
import { hasPerm } from "@/lib/permissions";
import { DailyReportPrintTable, DailyReportView } from "@/features/reports/components/daily-report";
import { MonthlyReportView } from "@/features/reports/components/monthly-report";
import { ReportPrintFooter, ReportPrintHeader } from "@/components/print-chrome";
import { useDailyReport } from "@/features/reports/hooks/use-daily-report";
import { useMonthlyReport } from "@/features/reports/hooks/use-monthly-report";
import { BASIS_LABEL, type ReportBasis } from "@/features/reports/daily";
import { PRINT_WIDTH_PX } from "@/lib/print-width";
import { usePrintExport } from "@/lib/print-export";

/**
 * Management reports.
 *
 * Two reports that were being produced by hand: the evening WhatsApp summary,
 * and the monthly workbook. Both are now generated from the figures the portal
 * already holds — this page fetches nothing of its own that the Dashboard or the
 * Calls module does not already own, and computes no KPI that either of them
 * defines. That is what makes "the report says 800" and "the dashboard says 800"
 * the same sentence rather than two claims to reconcile.
 *
 * Gated on `view_reports`, which already exists and which owner, admin,
 * supervisor and auditor hold and the two agent roles do not. No new permission,
 * no new role.
 */
export const Route = createFileRoute("/_app/reports")({
  head: () => ({ meta: [{ title: "Reports — MilaServ Portal" }] }),
  component: Reports,
});

const today = () => format(new Date(), "yyyy-MM-dd");

const MONTHS = [
  "January",
  "February",
  "March",
  "April",
  "May",
  "June",
  "July",
  "August",
  "September",
  "October",
  "November",
  "December",
];

function Reports() {
  const { role, profile, loading } = useAuth();
  const canView = hasPerm(role, profile?.permissions as any, "view_reports");
  const canExport = hasPerm(role, profile?.permissions as any, "export_reports");

  const now = new Date();
  const [date, setDate] = useState(today);
  const [basis, setBasis] = useState<ReportBasis>("all");
  const [month, setMonth] = useState(now.getMonth());
  const [year, setYear] = useState(now.getFullYear());

  /**
   * Which report is on screen — controlled rather than `defaultValue`, because
   * the two hooks below are declared by this component and would otherwise both
   * fetch on mount.
   *
   * Radix already unmounts the hidden tab's markup; what it cannot do is stop a
   * hook the route called. Opening this page cost nineteen requests to show a
   * tab that reads four figures. Now the monthly report's month-wide RPCs and
   * its CDR sweep wait until somebody asks for the monthly report.
   */
  const [tab, setTab] = useState("daily");

  const monthRange = useMemo(() => {
    const anchor = new Date(year, month, 1);
    return {
      from: format(startOfMonth(anchor), "yyyy-MM-dd"),
      to: format(endOfMonth(anchor), "yyyy-MM-dd"),
      label: `${MONTHS[month]} ${year}`,
    };
  }, [month, year]);

  const daily = useDailyReport({
    date,
    basis,
    canView,
    authLoading: loading,
    active: tab === "daily",
  });
  const monthly = useMonthlyReport({
    from: monthRange.from,
    to: monthRange.to,
    canView,
    authLoading: loading,
    active: tab === "monthly",
  });

  /**
   * The monthly PDF: lay the report out at the page's width, then print.
   *
   * The frame wait and the reason for it now live in `usePrintExport`, which the
   * Dashboard's own PDF export shares. It was two copies of the same paragraph
   * about `ResizeObserver` timing, which is one copy too many for a rule that
   * has to hold on both pages or neither.
   */
  const { printing, print: printMonthly } = usePrintExport();

  if (!loading && !canView) {
    return (
      <div className="py-16 text-center">
        <ShieldAlert className="mx-auto h-10 w-10 text-destructive" />
        <p className="mt-2 text-sm text-muted-foreground">You don't have access to Reports.</p>
      </div>
    );
  }

  // Years offered: this year and the four before it. Enough to re-run last
  // year's close, short enough that the list is a glance rather than a scroll.
  const years = Array.from({ length: 5 }, (_, index) => now.getFullYear() - index);

  return (
    <div className="space-y-5 print:space-y-3">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <h1 className="text-2xl font-semibold tracking-tight sm:text-3xl">Reports</h1>
          <p className="truncate text-xs text-muted-foreground sm:text-sm">
            Management reporting · generated from the same figures the dashboard shows
          </p>
        </div>
      </div>

      <Tabs value={tab} onValueChange={setTab} className="space-y-4">
        <TabsList className="print:hidden">
          <TabsTrigger value="daily">Daily Report</TabsTrigger>
          <TabsTrigger value="monthly">Monthly Report</TabsTrigger>
        </TabsList>

        {/* ------------------------------------------------------------------ */}
        {/* Daily                                                              */}
        {/* ------------------------------------------------------------------ */}
        <TabsContent value="daily" className="space-y-4">
          <div className="flex flex-wrap items-end justify-between gap-3 print:hidden">
            <div className="flex flex-wrap items-end gap-3">
              <label className="flex flex-col gap-1">
                <span className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
                  Date
                </span>
                <input
                  type="date"
                  value={date}
                  max={today()}
                  onChange={(event) => setDate(event.target.value || today())}
                  className="h-9 rounded-md border border-border/70 bg-card px-2.5 text-[13px] font-medium shadow-sm focus:border-primary focus:outline-none focus:ring-2 focus:ring-primary/15"
                />
              </label>

              {/*
                Which orders the day's figures count.

                The default is every order logged that day, because that is what
                the manual report has always counted — it goes out the same
                evening, when most of the day's orders have not been marked
                complete yet, and counting only the completed ones would report a
                fraction of the day's trading as the day's trading. The other
                basis is offered because it is the right one for a report re-run
                later against a closed day.
              */}
              <label className="flex flex-col gap-1">
                <span className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
                  Basis
                </span>
                <Select value={basis} onValueChange={(v) => setBasis(v as ReportBasis)}>
                  <SelectTrigger className="h-9 w-[190px]">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="all">{BASIS_LABEL.all}</SelectItem>
                    <SelectItem value="completed">{BASIS_LABEL.completed}</SelectItem>
                  </SelectContent>
                </Select>
              </label>
            </div>

            {canExport && (
              // Print is the export, the same way it is on the Calls pages: the
              // browser's own PDF writer renders what is on screen, and the
              // `print:` utilities drop the controls and the textarea from it.
              <Button size="sm" onClick={() => window.print()} disabled={daily.isLoading}>
                <Printer className="mr-2 h-4 w-4" />
                Export PDF
              </Button>
            )}
          </div>

          {daily.isLoading ? (
            <Card>
              <CardContent className="p-4">
                <div className="h-40 animate-pulse rounded-md bg-muted/40" />
              </CardContent>
            </Card>
          ) : (
            <>
              {/* Screen: the message and its preview. */}
              <div className="print:hidden">
                <DailyReportView report={daily.report} callsUnavailable={daily.callsUnavailable} />
              </div>

              {/* Print: one table on A4. The two-card layout and the textarea
                  both print badly — a textarea in particular comes out as a grey
                  box with a scrollbar — so the printed page gets its own
                  rendering of the same values. */}
              <div className="hidden print:block">
                <h2 className="mb-1 text-lg font-semibold">
                  Daily Report — {daily.report.dateLabel}
                </h2>
                <p className="mb-3 text-xs text-muted-foreground">{BASIS_LABEL[basis]}</p>
                <DailyReportPrintTable report={daily.report} />
                <p className="mt-3 text-sm font-semibold">
                  Total Daily Sales (Customer Care + Telesales):{" "}
                  {daily.report.combinedSales.toLocaleString("en-US", {
                    minimumFractionDigits: 2,
                    maximumFractionDigits: 2,
                  })}{" "}
                  SAR
                </p>
              </div>
            </>
          )}
        </TabsContent>

        {/* ------------------------------------------------------------------ */}
        {/* Monthly                                                            */}
        {/* ------------------------------------------------------------------ */}
        <TabsContent value="monthly" className="space-y-4">
          <div className="flex flex-wrap items-end justify-between gap-3 print:hidden">
            <div className="flex flex-wrap items-end gap-3">
              <label className="flex flex-col gap-1">
                <span className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
                  Month
                </span>
                <Select value={String(month)} onValueChange={(v) => setMonth(Number(v))}>
                  <SelectTrigger className="h-9 w-[150px]">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {MONTHS.map((name, index) => (
                      <SelectItem key={name} value={String(index)}>
                        {name}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </label>

              <label className="flex flex-col gap-1">
                <span className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
                  Year
                </span>
                <Select value={String(year)} onValueChange={(v) => setYear(Number(v))}>
                  <SelectTrigger className="h-9 w-[110px]">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {years.map((value) => (
                      <SelectItem key={value} value={String(value)}>
                        {value}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </label>

              <p className="pb-2 text-[11px] text-muted-foreground">
                {monthRange.from} → {monthRange.to}
              </p>
            </div>

            {canExport && (
              <Button size="sm" onClick={printMonthly} disabled={monthly.isLoading || printing}>
                <Printer className="mr-2 h-4 w-4" />
                Export PDF
              </Button>
            )}
          </div>

          {/* Pinned to the printable width for the duration of the export, so
              every chart inside measures the page rather than the monitor. */}
          <div style={printing ? { width: PRINT_WIDTH_PX } : undefined}>
            <ReportPrintHeader title="Monthly Report" period={monthRange.label} />

            <MonthlyReportView data={monthly} label={monthRange.label} printing={printing} />

            <ReportPrintFooter label={`Monthly Report — ${monthRange.label}`} />
          </div>
        </TabsContent>
      </Tabs>
    </div>
  );
}
