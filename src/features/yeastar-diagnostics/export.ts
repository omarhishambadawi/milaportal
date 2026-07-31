import { hhmmss } from "@/features/call-center/utils";
import type { CallRow, KpiComparisonRow } from "./compare";

function fmt(row: KpiComparisonRow, v: number | null): string | number {
  if (v == null) return "";
  if (row.format === "duration") return hhmmss(v);
  if (row.format === "percent") return `${v.toFixed(2)}%`;
  return v;
}

function kpiSheet(comparison: KpiComparisonRow[]) {
  return comparison.map((r) => ({
    KPI: r.label,
    Dashboard: fmt(r, r.dashboard),
    Official: fmt(r, r.official),
    Difference: fmt(r, r.difference),
    Status: r.status === "not-entered" ? "not entered" : r.status,
  }));
}

function callSheet(rows: CallRow[]) {
  return rows.map((r) => ({
    "Call ID": r.callId,
    "Date / Time": r.startedAt ? new Date(r.startedAt * 1000).toISOString() : "",
    Extension: r.extension,
    Direction: r.direction,
    "Declared direction": r.declaredDirection,
    "Dashboard classification": r.classification,
    Included: r.included ? "included" : "excluded",
    "Exclusion reason": r.exclusionReason ?? "",
    "Talk time": hhmmss(r.talkSeconds),
    "Ring time": r.ringSeconds == null ? "" : hhmmss(r.ringSeconds),
    "Queue wait": r.queueWaitSeconds == null ? "" : hhmmss(r.queueWaitSeconds),
    Queue: r.queueNumber ?? "",
    Legs: r.legs,
    "Root cause": r.rootCause,
  }));
}

function exclusionSheet(exclusions: Array<{ reason: string; count: number }>) {
  return exclusions.map((e) => ({ Category: e.reason, Calls: e.count }));
}

/** Minimal RFC-4180 CSV. Values are quoted and inner quotes doubled. */
function toCsv(rows: Array<Record<string, unknown>>): string {
  if (rows.length === 0) return "";
  const headers = Object.keys(rows[0]);
  const cell = (v: unknown) => `"${String(v ?? "").replace(/"/g, '""')}"`;
  return [
    headers.map(cell).join(","),
    ...rows.map((r) => headers.map((h) => cell(r[h])).join(",")),
  ].join("\r\n");
}

function download(name: string, content: string, mime: string) {
  const url = URL.createObjectURL(new Blob([content], { type: mime }));
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  a.click();
  URL.revokeObjectURL(url);
}

interface ExportArgs {
  comparison: KpiComparisonRow[];
  calls: CallRow[];
  exclusions: Array<{ reason: string; count: number }>;
  from: string;
  to: string;
}

/**
 * One workbook with a sheet per concern: the KPI comparison, the full call
 * comparison, the mismatching calls on their own, and the exclusion ledger.
 * `xlsx` stays lazily imported so it never lands in the page's initial chunk.
 */
export async function exportValidationXlsx({
  comparison,
  calls,
  exclusions,
  from,
  to,
}: ExportArgs) {
  const XLSX = await import("xlsx");
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(
    wb,
    XLSX.utils.json_to_sheet(kpiSheet(comparison)),
    "KPI comparison",
  );
  XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(callSheet(calls)), "Calls");
  const mismatching = calls.filter((c) => !c.included || c.rootCause !== "none");
  XLSX.utils.book_append_sheet(
    wb,
    XLSX.utils.json_to_sheet(callSheet(mismatching)),
    "Mismatch report",
  );
  XLSX.utils.book_append_sheet(
    wb,
    XLSX.utils.json_to_sheet(exclusionSheet(exclusions)),
    "Exclusion ledger",
  );
  XLSX.writeFile(wb, `yeastar-validation-${from}_${to}.xlsx`);
}

export function exportComparisonCsv(comparison: KpiComparisonRow[], from: string, to: string) {
  download(`yeastar-kpi-comparison-${from}_${to}.csv`, toCsv(kpiSheet(comparison)), "text/csv");
}

export function exportCallsCsv(calls: CallRow[], from: string, to: string) {
  download(`yeastar-calls-${from}_${to}.csv`, toCsv(callSheet(calls)), "text/csv");
}

export function exportMismatchCsv(calls: CallRow[], from: string, to: string) {
  const mismatching = calls.filter((c) => !c.included || c.rootCause !== "none");
  download(`yeastar-mismatch-${from}_${to}.csv`, toCsv(callSheet(mismatching)), "text/csv");
}
