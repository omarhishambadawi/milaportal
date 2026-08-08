import { useState } from "react";
import { Check, Copy, PhoneOff } from "lucide-react";
import { Button } from "@/components/ui/button";
import { AnalyticsCard } from "@/features/dashboard/components/analytics-card";
import {
  AnalyticsTable,
  Tbody,
  Td,
  Th,
  Thead,
} from "@/features/dashboard/components/analytics-table";
import { cn } from "@/lib/utils";
import { formatDailyReportText, money, type DailyReport } from "../daily";

/**
 * The daily report, on screen and on the clipboard.
 *
 * Two renderings of one value, and they are generated from the same
 * `DailyReport` rather than one being transcribed from the other: the card is
 * what management reads here, the text is what gets pasted into WhatsApp, and
 * the failure this design rules out is the two drifting so that the message says
 * something the dashboard does not.
 *
 * The card is deliberately close to the message's own shape — team, figures,
 * arrow, total — because the person sending it needs to check at a glance that
 * what they are about to send is what they are looking at.
 */

function Figure({ label, value, strong }: { label: string; value: string; strong?: boolean }) {
  return (
    <div className="flex items-baseline justify-between gap-3 py-1">
      <span
        className={cn(
          "text-[12.5px] text-muted-foreground",
          strong && "font-medium text-foreground",
        )}
      >
        {label}
      </span>
      <span
        className={cn(
          "shrink-0 tabular-nums",
          strong ? "text-[15px] font-bold text-foreground" : "text-[13px] font-semibold",
        )}
      >
        {value}
      </span>
    </div>
  );
}

function TeamBlock({
  title,
  rows,
  total,
}: {
  title: string;
  rows: { label: string; value: string }[];
  total: string;
}) {
  return (
    <div className="min-w-0 rounded-lg border border-border/60 bg-card p-3">
      <h3 className="pb-1.5 text-[11px] font-semibold uppercase tracking-wide text-primary">
        {title}
      </h3>
      <div className="divide-y divide-border/40">
        {rows.map((row) => (
          <Figure key={row.label} label={row.label} value={row.value} />
        ))}
      </div>
      <div className="mt-1.5 border-t-2 border-primary/25 pt-1.5">
        <Figure label="Total Sales" value={total} strong />
      </div>
    </div>
  );
}

export function DailyReportView({
  report,
  callsUnavailable,
  canCopy = true,
}: {
  report: DailyReport;
  callsUnavailable: boolean;
  canCopy?: boolean;
}) {
  const [copied, setCopied] = useState(false);
  const text = formatDailyReportText(report);

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 2000);
    } catch {
      // Clipboard permission denied, or an insecure origin. The textarea below
      // is always present and selectable, so there is a manual path and nothing
      // to report as an error.
    }
  };

  const { telesales: ts, customerCare: cc } = report;

  return (
    <div className="space-y-3">
      {/* A report whose call lines read zero because the PBX was unreachable,
          sent as though they were real, is worse than one that says so. The
          sales half is Supabase-derived and unaffected. */}
      {callsUnavailable && (
        <p className="flex items-start gap-2 rounded-lg border border-[var(--attention)]/40 bg-[var(--attention)]/10 px-3 py-2 text-[12px] text-[var(--attention)]">
          <PhoneOff className="mt-px h-3.5 w-3.5 shrink-0" aria-hidden />
          <span>
            Call figures are unavailable for this date — the phone system did not answer. The order
            and sales figures below are unaffected. Check before sending.
          </span>
        </p>
      )}

      <div className="grid min-w-0 gap-3 lg:grid-cols-2">
        <TeamBlock
          title={`Telesales — ${report.dateLabel}`}
          rows={[
            { label: "Total Calls", value: ts.total.toLocaleString("en-US") },
            { label: "Total Orders", value: ts.orders.toLocaleString("en-US") },
            { label: "Total Cash", value: money(ts.cashSales) },
            { label: "Total Wasfaty", value: money(ts.wasfatySales) },
          ]}
          total={money(ts.totalSales)}
        />
        <TeamBlock
          title={`Customer Care — ${report.dateLabel}`}
          rows={[
            { label: "Inbound Calls", value: cc.inbound.toLocaleString("en-US") },
            {
              label: "Total Calls (Inbound & Outbound)",
              value: cc.total.toLocaleString("en-US"),
            },
            { label: "Total Orders", value: cc.orders.toLocaleString("en-US") },
            { label: "Cash Sales", value: money(cc.cashSales) },
            { label: "Wasfaty Sales", value: money(cc.wasfatySales) },
          ]}
          total={money(cc.totalSales)}
        />
      </div>

      {/* The one number the report exists to deliver. */}
      <div className="flex flex-wrap items-baseline justify-between gap-2 rounded-lg border border-primary/30 bg-primary/[0.04] px-3.5 py-2.5 dark:bg-primary/[0.08]">
        <span className="text-[12.5px] font-medium text-foreground">
          Total Daily Sales (Customer Care + Telesales)
        </span>
        <span className="text-[19px] font-bold tabular-nums text-foreground">
          {money(report.combinedSales)}
        </span>
      </div>

      {/* The message itself, shown rather than described.

          A preview the sender can read before they send is the point: "Copy"
          on its own asks them to trust that what lands in WhatsApp matches the
          card above. `readOnly` rather than disabled so the text stays
          selectable when the clipboard API is unavailable — an insecure origin
          or a denied permission then costs a manual select-all, not the
          feature. */}
      <AnalyticsCard
        title="Message"
        subtitle="Exactly what will be copied — plain text, no formatting"
        actions={
          canCopy ? (
            <Button size="sm" variant={copied ? "outline" : "default"} onClick={copy}>
              {copied ? (
                <Check className="mr-2 h-4 w-4 text-[var(--positive)]" />
              ) : (
                <Copy className="mr-2 h-4 w-4" />
              )}
              {copied ? "Copied" : "Copy report"}
            </Button>
          ) : undefined
        }
      >
        <textarea
          readOnly
          value={text}
          rows={text.split("\n").length}
          aria-label="Daily report text"
          className="w-full resize-none rounded-md border border-border/60 bg-muted/30 p-3 font-mono text-[12px] leading-5 text-foreground focus:border-primary focus:outline-none focus:ring-2 focus:ring-primary/15"
        />
      </AnalyticsCard>
    </div>
  );
}

/**
 * The same figures as a table, for the printed page.
 *
 * The screen layout is two cards side by side and a textarea; none of that is
 * how a report should look on A4, and the textarea in particular prints as a
 * grey box with a scrollbar. So print gets its own rendering — same values, one
 * table — and the two are swapped by `print:` utilities at the call site rather
 * than by a media query nobody can see in the component.
 */
export function DailyReportPrintTable({ report }: { report: DailyReport }) {
  const { telesales: ts, customerCare: cc } = report;

  return (
    <AnalyticsTable minWidth={420}>
      <Thead>
        <tr>
          <Th>Metric</Th>
          <Th align="right">Telesales</Th>
          <Th align="right">Customer Care</Th>
        </tr>
      </Thead>
      <Tbody>
        <tr>
          <Td className="font-medium">Total Calls</Td>
          <Td numeric>{ts.total.toLocaleString("en-US")}</Td>
          <Td numeric>{cc.total.toLocaleString("en-US")}</Td>
        </tr>
        <tr>
          <Td className="font-medium">Inbound Calls</Td>
          <Td numeric>{ts.inbound.toLocaleString("en-US")}</Td>
          <Td numeric>{cc.inbound.toLocaleString("en-US")}</Td>
        </tr>
        <tr>
          <Td className="font-medium">Total Orders</Td>
          <Td numeric>{ts.orders.toLocaleString("en-US")}</Td>
          <Td numeric>{cc.orders.toLocaleString("en-US")}</Td>
        </tr>
        <tr>
          <Td className="font-medium">Cash Sales</Td>
          <Td numeric>{money(ts.cashSales)}</Td>
          <Td numeric>{money(cc.cashSales)}</Td>
        </tr>
        <tr>
          <Td className="font-medium">Wasfaty Sales</Td>
          <Td numeric>{money(ts.wasfatySales)}</Td>
          <Td numeric>{money(cc.wasfatySales)}</Td>
        </tr>
        <tr className="border-t border-border/60 font-semibold">
          <Td className="font-semibold">Total Sales</Td>
          <Td numeric>{money(ts.totalSales)}</Td>
          <Td numeric>{money(cc.totalSales)}</Td>
        </tr>
      </Tbody>
    </AnalyticsTable>
  );
}
