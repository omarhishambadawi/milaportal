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
  calls: number;
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
  const checks = validateAnalytics(classified.calls, result);

  const outcomes = new Map<string, number>();
  const legRoles = new Map<string, number>();
  const legsPerCall = new Map<number, number>();
  for (const c of classified.calls) {
    outcomes.set(c.outcome, (outcomes.get(c.outcome) ?? 0) + 1);
    legsPerCall.set(c.legs.length, (legsPerCall.get(c.legs.length) ?? 0) + 1);
    for (const l of c.legs) legRoles.set(l.role, (legRoles.get(l.role) ?? 0) + 1);
  }

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
    calls: classified.calls.length,
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
