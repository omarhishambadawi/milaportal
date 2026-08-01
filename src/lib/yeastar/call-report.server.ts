/**
 * Yeastar Call Report API client — `openapi/v2.0` ONLY.
 *
 * ---------------------------------------------------------------------------
 * Why v2.0, and why that is not a preference
 * ---------------------------------------------------------------------------
 * `call_report/*` exists on both API versions and returns `errcode 0` on both.
 * Only v2.0 honours `start_time` / `end_time`. A windowed v1.0 query is accepted,
 * silently ignores the window and returns `total_number: 0` — which reads as
 * "there is no data" when it actually means "wrong partition". That single fact
 * is what made Call Report look unusable for two sprints.
 *
 * Measured on firmware 37.23.0.123, identical params, same token, same window
 * (July 2026, queue 6400):
 *
 *   v1.0  call_report/list?type=queueperformance  →  errcode 0, total_number 0
 *   v2.0  call_report/list?type=queueperformance  →  errcode 0, 1,323 calls
 *
 * This is the documented v1.0/v2.0 partitioning — "v2.0 for new data, v1.0 for
 * historical data" — applying to Call Report, not only to CDR. Do not "fall
 * back" to v1.0 on failure: it does not fail, it lies.
 *
 * ---------------------------------------------------------------------------
 * Request contract, taken from the PBX rather than from the documentation
 * ---------------------------------------------------------------------------
 *   1. `start_time`/`end_time` are `DD/MM/YYYY hh:mm:ss AM|PM` in PBX-local
 *      time. The v2.0 validator states it outright:
 *        "valid format: 02/01/2006 03:04:05 PM"
 *      — Go's reference layout, i.e. day first, zero-padded 12-hour, meridiem.
 *      The published example (`YYYY/MM/DD`) is wrong for this firmware, and
 *      `YEASTAR_DATETIME_FORMAT` in `.env` is wrong on both field order and
 *      clock. Neither is consulted here; the format is a constant of the API.
 *   2. Each report `type` requires its own entity id parameter, and it is
 *      genuinely required rather than a filter:
 *        queueperformance      → queue_id_list
 *        queueagentperformance → queue_id
 *      Those take the PBX's internal numeric queue **id**, not the dialable
 *      queue number.
 *   3. A bogus entity id returns `errcode 0` with an empty result — identical
 *      to a genuinely empty window. An empty response therefore proves nothing
 *      about the ids, which is why `queueId` is required rather than optional.
 *
 * See `docs/yeastar/sprint2-source-validation.md` §2 for the full elimination.
 *
 * ---------------------------------------------------------------------------
 * What this is allowed to be used for
 * ---------------------------------------------------------------------------
 * Call Report is the authoritative source for exactly one dashboard metric:
 * **per-agent missed calls**. That is not a preference either — this firmware
 * writes an agent-leg CDR row only when the agent ANSWERS, so a ring that went
 * unanswered leaves no trace in CDR at all (0 inbound agent legs carried
 * `NO ANSWER` across 14,294 July rows). Everything else the queue reports
 * publish is already derived from CDR at equal or better fidelity.
 *
 * Queue-level `missedCalls` / `abandonedCalls` are returned here for REFERENCE
 * ONLY — see the O1 note on `CallReportQueueStats`.
 */
import { yeastarFetch } from "./client.server";
import { BUSINESS_UTC_OFFSET_MINUTES } from "@/lib/timezone";

/** The only version that honours a time window. See the module header. */
const CALL_REPORT_BASE = "/openapi/v2.0/call_report/list";

/** Per-request timeout. Call Report is slower than CDR but must not hang a page. */
const TIMEOUT_MS = 20_000;

function tzOffsetMinutes(): number {
  const raw = Number(process.env.YEASTAR_UTC_OFFSET_MINUTES);
  return Number.isFinite(raw) ? raw : BUSINESS_UTC_OFFSET_MINUTES;
}

const pad = (n: number) => String(n).padStart(2, "0");

/**
 * Format an instant as the Call Report wire format: `DD/MM/YYYY hh:mm:ss AM|PM`
 * in PBX-local time.
 *
 * Exported for testing — this format is the single most expensive thing to get
 * wrong, because a malformed value is *accepted* by v1.0 and merely produces an
 * empty report rather than an error.
 */
export function formatCallReportTime(epochSeconds: number, offsetMin = tzOffsetMinutes()): string {
  const d = new Date(epochSeconds * 1000 + offsetMin * 60_000);
  const hours24 = d.getUTCHours();
  const hours12 = hours24 % 12 === 0 ? 12 : hours24 % 12;
  return (
    `${pad(d.getUTCDate())}/${pad(d.getUTCMonth() + 1)}/${d.getUTCFullYear()} ` +
    `${pad(hours12)}:${pad(d.getUTCMinutes())}:${pad(d.getUTCSeconds())} ` +
    `${hours24 < 12 ? "AM" : "PM"}`
  );
}

/**
 * Inclusive `[from 00:00:00, to 23:59:59]` window in the business timezone,
 * rendered in the Call Report wire format.
 *
 * Deliberately mirrors `cdr.server.ts`'s `dayBounds` so the two sources are
 * asked for the SAME window. A one-second or one-timezone disagreement here
 * would show up as a KPI mismatch and be blamed on the metric.
 */
export function callReportWindow(
  from: string,
  to: string,
  offsetMin = tzOffsetMinutes(),
): { start: string; end: string; startEpoch: number; endEpoch: number } {
  const offMs = offsetMin * 60_000;
  const startEpoch = Math.floor((Date.parse(`${from}T00:00:00Z`) - offMs) / 1000);
  const endEpoch = Math.floor((Date.parse(`${to}T23:59:59Z`) - offMs) / 1000);
  return {
    start: formatCallReportTime(startEpoch, offsetMin),
    end: formatCallReportTime(endEpoch, offsetMin),
    startEpoch,
    endEpoch,
  };
}

/** Queue Performance, as the PBX reports it. */
export interface CallReportQueueStats {
  queueNumber: string;
  totalCalls: number;
  answeredCalls: number;
  /**
   * The queue released the call to its failover destination.
   *
   * O1 (RESOLVED, Sprint 3.5): Yeastar splits unanswered queue calls by *who
   * ended the call* (`abandoned` = the caller hung up while waiting; `missed` =
   * the queue gave up on them). CDR splits the same population by a 5-second
   * wait threshold. Over July 2026 both sides counted 97 unanswered calls, but
   * split them 1/96 (Yeastar) against 95/2 (CDR).
   *
   * The dashboard now reports THIS split, because the page is reconciled against
   * the PBX's own Queue panel. The mapping is `resolveQueueOutcomeSplit` in
   * `metrics-engine.ts`; CDR's threshold split is retained beside it on
   * `UnansweredSplitComparison`. See §9.4 of
   * `docs/yeastar/sprint2-source-validation.md`.
   *
   * Still not a general licence: every OTHER field on this interface remains
   * reference-only, because CDR produces it at equal or better fidelity.
   */
  missedCalls: number;
  /** The caller hung up while waiting. See the O1 note on `missedCalls`. */
  abandonedCalls: number;
  /** Mean wait over ANSWERED queue calls. */
  avgWaitAnsweredSec: number;
  /** Mean wait over ALL queue calls. */
  avgWaitAllSec: number;
  avgTalkSec: number;
  maxWaitSec: number;
  answeredRate: number;
  slaAttainment: number;
}

/**
 * One agent's queue performance.
 *
 * `missedCalls` is the reason this module exists: the agent's phone rang and
 * they did not pick up. CDR cannot produce it.
 */
export interface CallReportAgentStats {
  ext: string;
  name: string;
  totalCalls: number;
  answeredCalls: number;
  missedCalls: number;
  totalTalkSeconds: number;
}

export interface CallReportSnapshot {
  /** False when the PBX could not be reached or returned nothing usable. */
  available: boolean;
  /** Why it is unavailable, for the UI to show honestly. Null when available. */
  error: string | null;
  window: { start: string; end: string };
  queue: CallReportQueueStats | null;
  agents: CallReportAgentStats[];
  elapsedMs: number;
}

const num = (v: unknown): number => {
  const n = Number(v ?? 0);
  return Number.isFinite(n) ? n : 0;
};

interface CallReportResponse {
  errcode?: number;
  errmsg?: string;
  total_number?: number;
  invalid_param_list?: Array<{ field?: string; valid_msg?: string; value?: string }>;
  queue_performance_list?: Array<Record<string, unknown>>;
  queue_agent_performance_list?: Array<Record<string, unknown> & { detail?: unknown }>;
}

/** Turn a non-zero errcode into a message worth showing, including param faults. */
function describeFailure(json: CallReportResponse | null, httpStatus: number): string {
  if (!json) return `Call Report HTTP ${httpStatus}`;
  const invalid = json.invalid_param_list
    ?.map((p) => `${p.field}: ${p.valid_msg ?? p.value ?? "invalid"}`)
    .join("; ");
  return (
    `Call Report errcode ${json.errcode ?? "n/a"} ${json.errmsg ?? ""}`.trim() +
    (invalid ? ` — ${invalid}` : "")
  );
}

async function callReport(
  params: Record<string, string | number>,
  signal?: AbortSignal,
): Promise<{
  json: CallReportResponse | null;
  httpStatus: number;
  ok: boolean;
  error: string | null;
}> {
  const { httpStatus, json } = await yeastarFetch<CallReportResponse>(CALL_REPORT_BASE, params, {
    signal,
    timeoutMs: TIMEOUT_MS,
  });
  const ok = httpStatus === 200 && json?.errcode === 0;
  return { json, httpStatus, ok, error: ok ? null : describeFailure(json, httpStatus) };
}

export interface FetchCallReportOptions {
  /** Inclusive window, "YYYY-MM-DD" in the business timezone. */
  from: string;
  to: string;
  /** PBX-internal numeric queue id — NOT the dialable queue number. */
  queueId: number;
  /** The dialable number, carried through for labelling only. */
  queueNumber: string;
  signal?: AbortSignal;
}

/**
 * Fetch the Customer Care queue's own report for a window.
 *
 * **Never throws.** The dashboard's KPIs are CDR-derived and must render whether
 * or not this succeeds; a Call Report outage degrades one column, it does not
 * take the page down. Failures come back as `available: false` with a reason.
 */
export async function fetchCallReportSnapshot(
  opts: FetchCallReportOptions,
): Promise<CallReportSnapshot> {
  const started = Date.now();
  const { start, end } = callReportWindow(opts.from, opts.to);
  const base = { start_time: start, end_time: end };
  const empty = (error: string | null): CallReportSnapshot => ({
    available: false,
    error,
    window: { start, end },
    queue: null,
    agents: [],
    elapsedMs: Date.now() - started,
  });

  try {
    // Two reports, one window. `queueagentperformance` carries the per-agent
    // detail this module exists for; `queueperformance` carries the queue-level
    // figures used for the O1 comparison and for parity checks.
    const [perf, agentPerf] = await Promise.all([
      callReport(
        { type: "queueperformance", queue_id_list: String(opts.queueId), ...base },
        opts.signal,
      ),
      callReport(
        { type: "queueagentperformance", queue_id: String(opts.queueId), ...base },
        opts.signal,
      ),
    ]);

    if (!perf.ok && !agentPerf.ok) return empty(perf.error ?? agentPerf.error);

    const row = perf.json?.queue_performance_list?.[0] ?? null;
    const queue: CallReportQueueStats | null = row
      ? {
          queueNumber: String(row.queue_num ?? opts.queueNumber),
          totalCalls: num(row.total_calls),
          answeredCalls: num(row.answered_calls),
          missedCalls: num(row.missed_calls),
          abandonedCalls: num(row.abandoned_calls),
          avgWaitAnsweredSec: num(row.average_waiting_time),
          avgWaitAllSec: num(row.all_call_average_waiting_time),
          avgTalkSec: num(row.average_talking_time),
          maxWaitSec: num(row.max_waiting_time),
          answeredRate: num(row.answered_rate),
          slaAttainment: num(row.sla),
        }
      : null;

    // The per-agent rows live in `detail` on the first queue entry, not at the
    // top level — the top-level fields repeat the queue totals.
    const detail = agentPerf.json?.queue_agent_performance_list?.[0]?.detail;
    const agents: CallReportAgentStats[] = Array.isArray(detail)
      ? detail
          .map((a: Record<string, unknown>) => ({
            ext: String(a.agent_number ?? "").trim(),
            name: String(a.agent_name ?? "").trim(),
            totalCalls: num(a.total_calls),
            answeredCalls: num(a.answered_calls),
            missedCalls: num(a.missed_calls),
            totalTalkSeconds: num(a.total_talking_time),
          }))
          .filter((a) => a.ext !== "")
      : [];

    return {
      available: queue != null || agents.length > 0,
      error: queue != null || agents.length > 0 ? null : (perf.error ?? agentPerf.error),
      window: { start, end },
      queue,
      agents,
      elapsedMs: Date.now() - started,
    };
  } catch (e) {
    return empty(e instanceof Error ? e.message : String(e));
  }
}
