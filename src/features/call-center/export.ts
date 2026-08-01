import { hhmmss } from "./utils";
import type { CustomerCareMetrics } from "@/lib/yeastar/metrics-engine";

/**
 * Customer Care XLSX, built from the Metrics Engine and nothing else.
 *
 * Separate from `exportCallCenter` on purpose: that one reads a raw `totals`
 * object and re-derives its own sheet, which is exactly the duplicated
 * calculation the Metrics Engine exists to remove. Telesales still uses it;
 * Customer Care no longer does.
 */
export async function exportCustomerCare(
  metrics: CustomerCareMetrics,
  from: string,
  to: string,
  fileLabel = "customer-care",
) {
  const XLSX = await import("xlsx");
  const { overview, serviceLevel, queue, direction, time, unansweredSplit } = metrics;

  const kpiSheet = [
    { Metric: "Total calls", Value: overview.totalCalls, Source: metrics.sources.overview },
    { Metric: "Answered", Value: overview.answeredCalls, Source: metrics.sources.overview },
    {
      Metric: "Answer rate %",
      Value: overview.answerRate.toFixed(2),
      Source: metrics.sources.overview,
    },
    { Metric: "Queue calls", Value: queue.queueCalls, Source: metrics.sources.queue },
    {
      Metric: "Queue answer rate %",
      Value: queue.queueAnswerRate.toFixed(2),
      Source: metrics.sources.queue,
    },
    { Metric: "Missed (queue)", Value: queue.missed, Source: metrics.sources.queue },
    { Metric: "Abandoned", Value: queue.abandoned, Source: metrics.sources.queue },
    { Metric: "Unanswered total", Value: queue.unansweredTotal, Source: metrics.sources.queue },
    {
      Metric: `SLA (answered <= ${serviceLevel.slaSeconds}s) %`,
      Value: serviceLevel.slaAttainment.toFixed(2),
      Source: metrics.sources.serviceLevel,
    },
    {
      Metric: "Within SLA",
      Value: serviceLevel.slaAnsweredWithin,
      Source: metrics.sources.serviceLevel,
    },
    {
      Metric: "Avg queue wait (all)",
      Value: hhmmss(serviceLevel.avgQueueWaitSec),
      Source: metrics.sources.serviceLevel,
    },
    {
      Metric: "Avg queue wait (answered)",
      Value: hhmmss(serviceLevel.avgQueueWaitAnsweredSec),
      Source: metrics.sources.serviceLevel,
    },
    {
      Metric: "Max queue wait",
      Value: hhmmss(serviceLevel.maxQueueWaitSec),
      Source: metrics.sources.serviceLevel,
    },
    { Metric: "Inbound", Value: direction.inbound, Source: metrics.sources.direction },
    { Metric: "Outbound", Value: direction.outbound, Source: metrics.sources.direction },
    {
      Metric: "No-answer outbound",
      Value: direction.noAnswerOutbound,
      Source: metrics.sources.direction,
    },
    { Metric: "Avg talking", Value: hhmmss(time.avgTalkSec), Source: metrics.sources.overview },
    { Metric: "Total talk", Value: hhmmss(time.totalTalkSec), Source: metrics.sources.overview },
  ];

  // The O1 divergence travels with the export, so a spreadsheet compared
  // against a Yeastar report explains its own difference.
  const o1Sheet = [
    { Split: "Dashboard missed", Value: unansweredSplit.dashboardMissed },
    { Split: "Dashboard abandoned", Value: unansweredSplit.dashboardAbandoned },
    { Split: "Dashboard unanswered total", Value: unansweredSplit.dashboardUnansweredTotal },
    { Split: "Yeastar missed", Value: unansweredSplit.reportMissed ?? "unavailable" },
    { Split: "Yeastar abandoned", Value: unansweredSplit.reportAbandoned ?? "unavailable" },
    {
      Split: "Yeastar unanswered total",
      Value: unansweredSplit.reportUnansweredTotal ?? "unavailable",
    },
    {
      Split: "Populations agree",
      Value:
        unansweredSplit.populationsAgree == null
          ? "unknown"
          : unansweredSplit.populationsAgree
            ? "yes"
            : "no",
    },
  ];

  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(kpiSheet), "KPIs");
  // `rows`, not `visible`: the export is the whole window, not the current
  // on-screen search. This matches the pre-refactor behaviour, where the table
  // received the searched list and the export received the full one.
  XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(metrics.agents.rows), "Agents");
  XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(metrics.trends.byDay), "By day");
  XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(metrics.trends.hourly), "By hour");
  XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(o1Sheet), "Missed vs Abandoned (O1)");
  XLSX.writeFile(wb, `${fileLabel}-${from}_${to}.xlsx`);
}

interface ExportCallCenterArgs {
  ok: boolean | undefined;
  totals: any;
  conv: any;
  rows: any[];
  byDay: any[];
  hourly12: any[];
  from: string;
  to: string;
  /** Filename prefix, e.g. "customer-care". */
  fileLabel?: string;
}

/**
 * Build and download the Call Center analytics XLSX. Moved verbatim from the
 * route's `doExport`: same sheets, same metrics, same file name. xlsx stays
 * lazy-loaded to keep it out of the route's initial chunk.
 */
export async function exportCallCenter({
  ok,
  totals,
  conv,
  rows,
  byDay,
  hourly12,
  from,
  to,
  fileLabel = "call-center",
}: ExportCallCenterArgs) {
  if (!ok || !totals) return;
  const XLSX = await import("xlsx");
  const kpiSheet = [
    { Metric: "Total calls", Value: totals.total },
    { Metric: "Answered", Value: totals.answered },
    { Metric: "Missed (queue)", Value: totals.missed },
    { Metric: "Abandoned", Value: totals.abandoned },
    { Metric: "No-answer outbound", Value: totals.noAnswerOutbound },
    { Metric: "Inbound", Value: totals.inbound },
    { Metric: "Outbound", Value: totals.outbound },
    { Metric: "Answer rate %", Value: totals.answerRate.toFixed(2) },
    { Metric: "Avg talking", Value: hhmmss(totals.avgTalkSec) },
    { Metric: "Avg waiting", Value: hhmmss(totals.avgWaitSec) },
    { Metric: "Total talk", Value: hhmmss(totals.talkSeconds) },
    // Conversion belongs to Telesales only; Customer Care passes conv = null.
    ...(conv
      ? [{ Metric: "Conversion rate %", Value: conv.overall.conversionRate.toFixed(2) }]
      : []),
  ];
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(kpiSheet), "KPIs");
  XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(rows), "Agents");
  XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(byDay), "By day");
  XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(hourly12), "By hour");
  if (conv) {
    XLSX.utils.book_append_sheet(
      wb,
      XLSX.utils.json_to_sheet(conv.perAgent),
      "Conversion by agent",
    );
    XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(conv.perDay), "Conversion by day");
  }
  XLSX.writeFile(wb, `${fileLabel}-${from}_${to}.xlsx`);
}
