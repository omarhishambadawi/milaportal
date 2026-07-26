import { hhmmss } from "./utils";

interface ExportCallCenterArgs {
  ok: boolean | undefined;
  totals: any;
  conv: any;
  rows: any[];
  byDay: any[];
  hourly12: any[];
  from: string;
  to: string;
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
    { Metric: "Conversion rate %", Value: (conv?.overall.conversionRate ?? 0).toFixed(2) },
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
  XLSX.writeFile(wb, `call-center-${from}_${to}.xlsx`);
}
