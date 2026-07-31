/**
 * Production-safe live KPI validation.
 *
 * Deliberately separate from `diagnostics.server.ts`. That module returns raw
 * PBX response bodies — caller numbers, DIDs, recording paths — and is therefore
 * refused outside a development build. This one runs the same analytics pipeline
 * over the same live CDR but returns ONLY aggregates: call counts, KPI totals,
 * the pass/fail invariants, and field NAMES with their occurrence counts.
 *
 * Nothing here can identify a caller, an agent or a recording:
 *   - no raw response bodies
 *   - no per-call or per-leg rows
 *   - no phone numbers, DIDs or record file paths
 *   - no agent roster join (KPIs are validated at platform level)
 *
 * That is what makes it safe to expose to an administrator on a deployed
 * environment, which is the only place the Yeastar credentials exist.
 */
import { fetchCdrRange } from "./cdr.server";
import { aggregateClassified, classifyRecords, type CallTotals } from "./stats.server";
import { validateAnalytics, type KpiCheck } from "./validate";
import { RETIRED_ASSUMED_FIELDS } from "./diagnostics.server";
import type { NormalizationContext } from "./normalize";
import { BUSINESS_UTC_OFFSET_MINUTES } from "@/lib/timezone";

/** Minutes from midnight → "HH:MM". */
function minuteLabel(minute: number): string {
  const h = Math.floor(minute / 60) % 24;
  const m = minute % 60;
  return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}`;
}

export interface KpiValidationReport {
  at: string;
  window: { from: string; to: string; startEpoch: number; endEpoch: number };
  cdr: {
    path: string;
    totalReported: number | null;
    rowsInWindow: number;
    pagesFetched: number;
    truncated: boolean;
    elapsedMs: number;
  };
  /** Roster sizes only — never the numbers themselves, apart from queues. */
  roster: { extensionCount: number; queueNumbers: string[] };
  /** Configured operating window, or null when the after-hours rule is off. */
  businessHours: { days: number[]; start: string; end: string } | null;
  /** Calls that count toward KPIs. */
  calls: number;
  /** Every call the window produced, operational or not. */
  callsSeen: number;
  /**
   * Why calls were left out, one row per category. Every category is always
   * present — a zero is information, not an omission.
   */
  exclusions: { reason: string; count: number }[];
  /** Rows discarded as repeats of a `new_id` already seen. */
  duplicateRowsDropped: number;
  /** Calls whose direction contradicted the PBX label and was corrected. */
  directionCorrections: { declared: string; corrected: string; count: number }[];
  /** Operational calls per business-timezone hour — read real hours off this. */
  callsByHour: { hour: number; calls: number }[];
  totals: CallTotals;
  /** Aggregate counts by call outcome. */
  outcomes: { outcome: string; count: number }[];
  /** Aggregate counts by leg role — how the normalizer read the routing chain. */
  legRoles: { role: string; count: number }[];
  /** Distribution of legs per call. Should NOT be `{1: everything}` — that was the bug. */
  legsPerCall: { legs: number; calls: number }[];
  checks: KpiCheck[];
  passed: boolean;
  /** Field names + counts. No values, so nothing identifying leaves the server. */
  fieldPresence: { field: string; count: number; percent: number }[];
  /** Any of these reappearing means the firmware changed shape under us. */
  retiredFieldCheck: { field: string; occurrences: number }[];
}

/**
 * Fetch a CDR window, run the production aggregation over it, and re-derive
 * every KPI independently.
 *
 * `ctx` is supplied by the caller so the PBX roster is fetched exactly once, by
 * the same code path analytics uses — a second roster fetch here could disagree
 * with the one analytics saw and produce a validation that proves nothing.
 */
export async function runKpiValidation(
  from: string,
  to: string,
  ctx: NormalizationContext,
): Promise<KpiValidationReport> {
  const cdr = await fetchCdrRange({ from, to });
  const classified = classifyRecords(cdr.records, ctx);
  const result = aggregateClassified(classified, [], []);
  const checks = validateAnalytics(classified, result);

  const outcomes = new Map<string, number>();
  const legRoles = new Map<string, number>();
  const legsPerCall = new Map<number, number>();
  const byHour = new Map<number, number>();
  const tzOffset = ctx.businessHours?.utcOffsetMinutes ?? BUSINESS_UTC_OFFSET_MINUTES;
  for (const c of classified.calls) {
    outcomes.set(c.outcome, (outcomes.get(c.outcome) ?? 0) + 1);
    legsPerCall.set(c.legs.length, (legsPerCall.get(c.legs.length) ?? 0) + 1);
    for (const l of c.legs) legRoles.set(l.role, (legRoles.get(l.role) ?? 0) + 1);
    if (c.startedAt != null) {
      const h = new Date(c.startedAt * 1000 + tzOffset * 60_000).getUTCHours();
      byHour.set(h, (byHour.get(h) ?? 0) + 1);
    }
  }

  // Every category always reported, including the ones that are structurally
  // zero on this PBX — `queue_closed` cannot fire while the queue has
  // `enable_time_condition: 0`, and a zero says so.
  const EXCLUSION_CATEGORIES = [
    "after_hours",
    "queue_closed",
    "outbound_filtered",
    "ivr_only",
    "duplicate",
    "system_event",
    "internal",
    "other",
  ] as const;
  const exclusionMap = new Map<string, number>(
    classified.exclusionCounts.map((e) => [e.reason, e.count]),
  );
  // Duplicates are dropped at row level before a call exists, and the direction
  // filter is applied at query time, so both are folded in here rather than
  // being call-level exclusion reasons.
  exclusionMap.set("duplicate", classified.duplicateRowsDropped);
  exclusionMap.set(
    "outbound_filtered",
    classified.calls.filter((c) => c.direction === "Outbound").length,
  );
  const known = new Set<string>(EXCLUSION_CATEGORIES);
  let other = exclusionMap.get("other") ?? 0;
  for (const [reason, count] of exclusionMap) if (!known.has(reason)) other += count;
  exclusionMap.set("other", other);

  const counts = new Map<string, number>();
  for (const row of cdr.records)
    for (const key of Object.keys(row)) counts.set(key, (counts.get(key) ?? 0) + 1);

  return {
    at: new Date().toISOString(),
    window: { from, to, startEpoch: cdr.startEpoch, endEpoch: cdr.endEpoch },
    cdr: {
      path: cdr.path,
      totalReported: cdr.totalReported,
      rowsInWindow: cdr.records.length,
      pagesFetched: cdr.pagesFetched,
      truncated: cdr.truncated,
      elapsedMs: cdr.elapsedMs,
    },
    roster: { extensionCount: ctx.extensionNumbers.size, queueNumbers: [...ctx.queueNumbers] },
    businessHours: ctx.businessHours
      ? {
          days: [...ctx.businessHours.days],
          start: minuteLabel(ctx.businessHours.startMinute),
          end: minuteLabel(ctx.businessHours.endMinute),
        }
      : null,
    calls: classified.calls.length,
    callsSeen: classified.calls.length + classified.excluded.length,
    exclusions: EXCLUSION_CATEGORIES.map((reason) => ({
      reason,
      count: exclusionMap.get(reason) ?? 0,
    })),
    duplicateRowsDropped: classified.duplicateRowsDropped,
    directionCorrections: classified.directionCorrections,
    callsByHour: Array.from({ length: 24 }, (_, hour) => ({
      hour,
      calls: byHour.get(hour) ?? 0,
    })),
    totals: result.totals,
    outcomes: [...outcomes.entries()]
      .map(([outcome, count]) => ({ outcome, count }))
      .sort((a, b) => b.count - a.count),
    legRoles: [...legRoles.entries()]
      .map(([role, count]) => ({ role, count }))
      .sort((a, b) => b.count - a.count),
    legsPerCall: [...legsPerCall.entries()]
      .map(([legs, calls]) => ({ legs, calls }))
      .sort((a, b) => a.legs - b.legs),
    checks,
    passed: checks.every((c) => c.passed),
    fieldPresence: [...counts.entries()]
      .map(([field, count]) => ({
        field,
        count,
        percent: cdr.records.length ? Math.round((count / cdr.records.length) * 1000) / 10 : 0,
      }))
      .sort((a, b) => b.count - a.count || a.field.localeCompare(b.field)),
    retiredFieldCheck: RETIRED_ASSUMED_FIELDS.map((field) => ({
      field,
      occurrences: counts.get(field) ?? 0,
    })),
  };
}
