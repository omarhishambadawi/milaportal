import { hhmmss } from "./utils";

/**
 * Call Center exports.
 *
 * Customer Care no longer has one: its Excel action was removed in favour of a
 * single PDF (print) export, and `exportCustomerCare` went with it rather than
 * being left here as a Metrics-Engine consumer nothing calls. Telesales still
 * exports XLSX through `exportCallCenter` below.
 */

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
