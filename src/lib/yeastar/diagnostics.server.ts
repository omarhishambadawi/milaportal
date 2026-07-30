/**
 * Development-only Yeastar endpoint diagnostics.
 *
 * Runs a fixed set of read-only probes against the live PBX and reports, for
 * each one: the endpoint, the request it sent, the HTTP status, the raw response
 * body, the parsed/normalized result, and any parsing errors.
 *
 * Purpose is to make a field regression obvious the moment the PBX firmware
 * changes shape. Nothing here is used by analytics, nothing is persisted, and
 * every probe is a GET.
 */
import { yeastarFetch } from "./client.server";
import { buildContext, normalizeCdr, type NormalizedCall, type RawCdrRow } from "./normalize";
import { aggregateClassified, classifyRecords, type CallTotals } from "./stats.server";
import { validateAnalytics, type KpiCheck } from "./validate";

/** Fields the previous parser referenced that do NOT exist on this firmware. */
export const RETIRED_ASSUMED_FIELDS = [
  "wait_time",
  "agent_ring_time",
  "last_participant_number",
  "last_participant",
  "final_participant",
  "answer_by",
  "answered_by",
  "agent_number",
  "dst",
  "dst_num",
  "dst_number",
  "linkedid",
  "linked_id",
  "id",
] as const;

/**
 * JSON-safe value. The report crosses a server-function boundary, and TanStack
 * Start rejects `unknown` in a serialized payload, so the parsed output is typed
 * concretely rather than left open.
 */
export type JsonValue = string | number | boolean | null | JsonValue[] | { [k: string]: JsonValue };

export interface DiagnosticProbe {
  label: string;
  endpoint: string;
  method: "GET";
  request: Record<string, string | number>;
  httpStatus: number;
  errcode: number | null;
  errmsg: string | null;
  /** True when the endpoint exists on this firmware (errcode 10001 = it does not). */
  endpointExists: boolean;
  /** Raw response body, truncated for display. */
  responseBody: string;
  responseTruncated: boolean;
  /** Parsed/normalized output, when this probe has a parser attached. */
  parsed: JsonValue;
  parseErrors: string[];
  elapsedMs: number;
}

/**
 * Live KPI validation — the analytics pipeline run end to end over the CDR this
 * diagnostics pass fetched, with every invariant re-checked against the real
 * PBX rather than against fixtures.
 */
export interface LiveKpiValidation {
  /** Calls the window normalized to (Internal excluded). */
  calls: number;
  /** Raw rows those calls came from. */
  rows: number;
  totals: CallTotals;
  checks: KpiCheck[];
  passed: boolean;
}

export interface DiagnosticsReport {
  at: string;
  baseUrlConfigured: boolean;
  probes: DiagnosticProbe[];
  /** Field-presence census over the CDR rows this run fetched. */
  fieldPresence: { field: string; count: number; percent: number }[];
  /** Assumed-but-absent field check, run against live rows. */
  retiredFieldCheck: { field: string; occurrences: number }[];
  cdrRowsInspected: number;
  /** Null when no CDR rows were retrieved, so nothing could be validated. */
  kpiValidation: LiveKpiValidation | null;
}

const BODY_LIMIT = 4000;

async function probe(
  label: string,
  endpoint: string,
  request: Record<string, string | number>,
  parse?: (json: unknown) => { parsed: JsonValue; errors: string[] },
): Promise<{ probe: DiagnosticProbe; json: unknown }> {
  const started = Date.now();
  let httpStatus = 0;
  let body = "";
  let json: unknown = null;
  const parseErrors: string[] = [];

  try {
    const res = await yeastarFetch<unknown>(endpoint, request, { timeoutMs: 15_000 });
    httpStatus = res.httpStatus;
    body = res.body ?? "";
    json = res.json;
    if (body && json === null) parseErrors.push("Response body is not valid JSON.");
  } catch (err) {
    parseErrors.push(`Request failed: ${err instanceof Error ? err.message : String(err)}`);
  }

  const obj = json as { errcode?: number; errmsg?: string } | null;
  const errcode = obj?.errcode ?? null;
  const errmsg = obj?.errmsg ?? null;

  let parsed: JsonValue = null;
  if (parse && json) {
    try {
      const out = parse(json);
      parsed = out.parsed;
      parseErrors.push(...out.errors);
    } catch (err) {
      parseErrors.push(`Parser threw: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  return {
    json,
    probe: {
      label,
      endpoint,
      method: "GET",
      request,
      httpStatus,
      errcode,
      errmsg,
      // 10001 INTERFACE NOT EXISTED is the firmware's "this endpoint is not
      // implemented" signal. Any other errcode still means the route is there.
      endpointExists: errcode !== 10001,
      responseBody: body.slice(0, BODY_LIMIT),
      responseTruncated: body.length > BODY_LIMIT,
      parsed,
      parseErrors,
      elapsedMs: Date.now() - started,
    },
  };
}

/** Summary of one normalized call, small enough to render in a table. */
function summarizeCall(c: NormalizedCall) {
  return {
    callId: c.callId,
    direction: c.direction,
    outcome: c.outcome,
    caller: c.callerNumber,
    queue: c.queueNumber,
    answeringExtension: c.answeringExtension ?? "Unknown",
    queueWaitSeconds: c.queueWaitSeconds,
    agentRingSeconds: c.agentRingSeconds,
    talkSeconds: c.talkSeconds,
    legs: c.legs.map(
      (l) => `${l.role}:${l.destinationNumber || l.destinationLabel}(${l.disposition})`,
    ),
  };
}

export async function runDiagnostics(windowDays = 7): Promise<DiagnosticsReport> {
  const now = Math.floor(Date.now() / 1000);
  const startTime = now - windowDays * 86_400;
  const probes: DiagnosticProbe[] = [];

  // --- rosters first: normalization needs them -----------------------------
  const extRes = await probe("Extension roster", "/openapi/v1.0/extension/list", {
    page: 1,
    page_size: 200,
  });
  probes.push(extRes.probe);
  const queueRes = await probe("Queue roster", "/openapi/v1.0/queue/list", {
    page: 1,
    page_size: 100,
  });
  probes.push(queueRes.probe);

  const extData = (extRes.json as { data?: { number?: unknown }[] } | null)?.data ?? [];
  const queueData =
    (queueRes.json as { queue_list?: { number?: unknown }[] } | null)?.queue_list ?? [];
  const ctx = buildContext(extData, queueData);

  // --- CDR, with the normalization layer attached --------------------------
  let cdrRows: RawCdrRow[] = [];
  const cdrRes = await probe(
    "CDR (normalized)",
    "/openapi/v1.0/cdr/search",
    { page: 1, page_size: 200, start_time: startTime, end_time: now },
    (json) => {
      const errors: string[] = [];
      const data = (json as { data?: RawCdrRow[] } | null)?.data;
      if (!Array.isArray(data)) {
        errors.push("Expected an array at `data` — the CDR row array field is missing.");
        return { parsed: null, errors };
      }
      cdrRows = data;
      if (ctx.extensionNumbers.size === 0)
        errors.push("Extension roster is empty — agent legs cannot be identified.");
      if (ctx.queueNumbers.size === 0)
        errors.push("Queue roster is empty — queue legs cannot be identified.");

      const calls = normalizeCdr(data, ctx);
      const unknownAnswered = calls.filter(
        (c) => c.outcome === "answered" && c.answeringExtension === null,
      );
      if (unknownAnswered.length)
        errors.push(
          `${unknownAnswered.length} answered call(s) resolved to Unknown answering extension.`,
        );

      return {
        parsed: {
          rawRows: data.length,
          normalizedCalls: calls.length,
          outcomeBreakdown: calls.reduce<Record<string, number>>((acc, c) => {
            acc[c.outcome] = (acc[c.outcome] ?? 0) + 1;
            return acc;
          }, {}),
          sample: calls.slice(0, 25).map(summarizeCall),
        } as unknown as JsonValue,
        errors,
      };
    },
  );
  probes.push(cdrRes.probe);

  // --- realtime queue surfaces --------------------------------------------
  const firstQueueId = Number((queueData as { id?: unknown }[])[0]?.id ?? 0);
  const queueScope: Record<string, string | number> =
    firstQueueId > 0 ? { queue_id: firstQueueId } : {};

  probes.push(
    (
      await probe(
        "Queue call status (realtime)",
        "/openapi/v1.0/queue/call_status",
        queueScope,
        (json) => {
          const j = json as Record<string, unknown>;
          const errors: string[] = [];
          // Verified field names — NOT `data` and NOT `queue_call_status_list`.
          const has = (k: string) => Object.prototype.hasOwnProperty.call(j, k);
          for (const k of ["waiting_list", "active_list", "ringing_list"])
            if (!has(k)) errors.push(`Expected field \`${k}\` is missing from the response.`);
          if (j.errcode === 60001)
            errors.push("errcode 60001 (DATA NOT FOUND) — queue is idle; this is not a failure.");
          return {
            parsed: {
              waitingCalls: j.waiting_calls ?? null,
              activeCalls: j.active_calls ?? null,
              ringingCalls: j.ringing_calls ?? null,
              waitingList: j.waiting_list ?? null,
              activeList: j.active_list ?? null,
              ringingList: j.ringing_list ?? null,
            } as unknown as JsonValue,
            errors,
          };
        },
      )
    ).probe,
  );

  probes.push(
    (
      await probe(
        "Queue agent status (realtime)",
        "/openapi/v1.0/queue/agent_status",
        queueScope,
        (json) => {
          const j = json as { data?: unknown[]; total_number?: number; errcode?: number };
          const errors: string[] = [];
          if (j.errcode === 60001)
            errors.push(
              "errcode 60001 (DATA NOT FOUND) — no agents signed in; this is not a failure.",
            );
          return {
            parsed: {
              totalNumber: j.total_number ?? null,
              agents: j.data ?? null,
            } as unknown as JsonValue,
            errors,
          };
        },
      )
    ).probe,
  );

  probes.push(
    (await probe("PBX system information", "/openapi/v1.0/system/information", {})).probe,
  );

  // --- field census over the rows we actually fetched ----------------------
  const counts = new Map<string, number>();
  for (const row of cdrRows)
    for (const key of Object.keys(row)) counts.set(key, (counts.get(key) ?? 0) + 1);

  const fieldPresence = [...counts.entries()]
    .map(([field, count]) => ({
      field,
      count,
      percent: cdrRows.length ? Math.round((count / cdrRows.length) * 1000) / 10 : 0,
    }))
    .sort((a, b) => b.count - a.count || a.field.localeCompare(b.field));

  const retiredFieldCheck = RETIRED_ASSUMED_FIELDS.map((field) => ({
    field,
    occurrences: counts.get(field) ?? 0,
  }));

  // --- live KPI validation -------------------------------------------------
  // Runs the production aggregation over these live rows and re-derives every
  // headline KPI independently. Agent-level attribution is deliberately left
  // out: this is a PBX-side check, and pulling the app's agent roster in would
  // make it depend on the database rather than on the PBX.
  let kpiValidation: LiveKpiValidation | null = null;
  if (cdrRows.length > 0) {
    const classified = classifyRecords(cdrRows, ctx);
    const result = aggregateClassified(classified, [], []);
    const checks = validateAnalytics(classified.calls, result);
    kpiValidation = {
      calls: classified.calls.length,
      rows: classified.rowsInspected,
      totals: result.totals,
      checks,
      passed: checks.every((c) => c.passed),
    };
  }

  return {
    at: new Date().toISOString(),
    baseUrlConfigured: true,
    probes,
    fieldPresence,
    retiredFieldCheck,
    cdrRowsInspected: cdrRows.length,
    kpiValidation,
  };
}
