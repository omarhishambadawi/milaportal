/**
 * Yeastar server functions.
 *
 * Config + auth diagnostics require administrator. Call Center analytics and the
 * realtime queue share one view gate (see `callCenterAccess` /
 * CALL_CENTER_VIEW_PERMISSIONS); non-admins are auto-scoped to themselves. PBX
 * data is never persisted.
 */
import { createServerFn } from "@tanstack/react-start";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import { BUSINESS_UTC_OFFSET_MINUTES } from "@/lib/timezone";
import { CALL_CENTER_VIEW_PERMISSIONS } from "@/lib/call-center-permissions";
import { z } from "zod";
// Type-only: erased at compile time, so the server-only diagnostics module is
// never pulled into a client bundle.
import type { DiagnosticsReport as YeastarDiagnosticsReport } from "@/lib/yeastar/diagnostics.server";
import type { KpiValidationReport } from "@/lib/yeastar/kpi-validation.server";
import type { NormalizationContext } from "@/lib/yeastar/normalize";

async function assertAdmin(ctx: { supabase: any; userId: string }) {
  const { data, error } = await ctx.supabase.rpc("is_administrator", { _user_id: ctx.userId });
  if (error || !data) throw new Error("Forbidden: administrator access required");
}

/**
 * Shared server-side Call Center view gate. Mirrors the client
 * `canViewCallCenter`: access is granted to administrators or to any user
 * holding one of CALL_CENTER_VIEW_PERMISSIONS. Returns the admin flag too, since
 * analytics uses it for agent-scope decisions.
 */
async function callCenterAccess(
  supabase: any,
  userId: string,
): Promise<{ canView: boolean; isAdmin: boolean }> {
  const [{ data: isAdmin }, ...permResults] = await Promise.all([
    supabase.rpc("is_administrator", { _user_id: userId }),
    ...CALL_CENTER_VIEW_PERMISSIONS.map((perm) =>
      supabase.rpc("has_permission", { _user_id: userId, _permission: perm }),
    ),
  ]);
  const canView = !!isAdmin || permResults.some((r: any) => !!r?.data);
  return { canView, isAdmin: !!isAdmin };
}

// ---- Configuration / auth diagnostics --------------------------------------

export const yeastarConfigDiagnostic = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => {
    await assertAdmin(context as any);
    return {
      baseUrlLoaded: !!process.env.YEASTAR_BASE_URL,
      clientIdLoaded: !!process.env.YEASTAR_CLIENT_ID,
      clientSecretLoaded: !!process.env.YEASTAR_CLIENT_SECRET,
      utcOffsetMinutes: Number(
        process.env.YEASTAR_UTC_OFFSET_MINUTES ?? BUSINESS_UTC_OFFSET_MINUTES,
      ),
      datetimeFormat: process.env.YEASTAR_DATETIME_FORMAT ?? "yyyy/MM/dd HH:mm:ss",
      source: "process.env (Cloudflare Worker runtime)",
      at: new Date().toISOString(),
    };
  });

export const yeastarAuthDiagnostic = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => {
    await assertAdmin(context as any);
    const { getAccessToken, isConfigured, tokenSnapshot, YeastarAuthError } =
      await import("@/lib/yeastar/client.server");
    if (!isConfigured()) return { ok: false as const, configured: false as const };
    try {
      const started = Date.now();
      const { source } = await getAccessToken();
      return {
        ok: true as const,
        configured: true as const,
        source,
        elapsedMs: Date.now() - started,
        token: tokenSnapshot(),
        at: new Date().toISOString(),
      };
    } catch (err) {
      const anyErr = err as any;
      if (anyErr instanceof YeastarAuthError)
        return {
          ok: false as const,
          configured: true as const,
          error: anyErr.message,
          details: anyErr.details,
        };
      return {
        ok: false as const,
        configured: true as const,
        error: anyErr?.message ?? String(err),
      };
    }
  });

// ---- CDR probe (admin only) ------------------------------------------------

const cdrProbeInput = z.object({
  from: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  to: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
});

export const yeastarCdrProbe = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d) => cdrProbeInput.parse(d))
  .handler(async ({ context, data }) => {
    await assertAdmin(context as any);
    const { isConfigured } = await import("@/lib/yeastar/client.server");
    if (!isConfigured()) return { ok: false as const, configured: false as const };
    try {
      const { fetchCdrRange } = await import("@/lib/yeastar/cdr.server");
      const res = await fetchCdrRange({ from: data.from, to: data.to });
      return {
        ok: true as const,
        configured: true as const,
        path: res.path,
        totalReported: res.totalReported,
        fetched: res.records.length,
        truncated: res.truncated,
        pagesFetched: res.pagesFetched,
        elapsedMs: res.elapsedMs,
        // Verified fields only. The retired ones (`id`, `linkedid`,
        // `linked_id`, `agent_ring_time`, `wait_time`) do not exist on this
        // firmware — /admin/yeastar-diagnostics re-checks that on every run.
        sample: res.records.slice(0, 8).map((r) => ({
          time: r.time,
          timestamp: r.timestamp,
          call_type: r.call_type,
          disposition: r.disposition,
          call_from_number: r.call_from_number,
          call_to: r.call_to,
          call_to_number: r.call_to_number,
          talk_duration: r.talk_duration,
          ring_duration: r.ring_duration,
          duration: r.duration,
          // Grouping ids: call_id groups legs into a call, new_id is row-unique,
          // uid is ALSO call-level here (never de-duplicate on it).
          call_id: (r as any).call_id,
          new_id: (r as any).new_id,
          uid: (r as any).uid,
        })),
      };
    } catch (err) {
      return {
        ok: false as const,
        configured: true as const,
        error: err instanceof Error ? err.message : String(err),
      };
    }
  });

// ---- Queue roster (admin only) --------------------------------------------
//
// Confirmed supported on this firmware via /openapi/v1.0/queue/list. Returns
// the queues configured on the PBX and their static agent members with
// {extension_id, extension_number, display_name}. This is authoritative for
// "who is a Call Center agent". Read-only; not persisted.
// NOT wired into analytics yet — exposed as diagnostic first.

interface QueueMember {
  extension_id: string;
  extension_number: string;
  display_name: string;
  member_type: string;
}
interface QueueEntry {
  id: number;
  number: string;
  name: string;
  ring_strategy: string;
  static_members: QueueMember[];
  dynamic_members: QueueMember[];
}

export const yeastarQueueRoster = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .handler(
    async ({
      context,
    }): Promise<{
      ok: boolean;
      configured: boolean;
      at: string;
      totalQueues: number;
      queues: QueueEntry[];
      uniqueAgents: QueueMember[];
      error?: string;
    }> => {
      await assertAdmin(context as any);
      const { isConfigured, yeastarFetch } = await import("@/lib/yeastar/client.server");
      if (!isConfigured()) {
        return {
          ok: false,
          configured: false,
          at: new Date().toISOString(),
          totalQueues: 0,
          queues: [],
          uniqueAgents: [],
        };
      }
      const { httpStatus, json } = await yeastarFetch<any>("/openapi/v1.0/queue/list", {
        page: 1,
        page_size: 100,
      });
      if (httpStatus !== 200 || json?.errcode !== 0) {
        return {
          ok: false,
          configured: true,
          at: new Date().toISOString(),
          totalQueues: 0,
          queues: [],
          uniqueAgents: [],
          error: `queue/list failed: HTTP ${httpStatus} errcode=${json?.errcode ?? "n/a"} errmsg=${json?.errmsg ?? "n/a"}`,
        };
      }

      const mapMember = (m: any): QueueMember => ({
        extension_id: String(m?.value ?? ""),
        extension_number: String(m?.text2 ?? ""),
        display_name: String(m?.text ?? ""),
        member_type: String(m?.type ?? "extension"),
      });

      const queues: QueueEntry[] = (Array.isArray(json.queue_list) ? json.queue_list : []).map(
        (q: any): QueueEntry => ({
          id: Number(q?.id ?? 0),
          number: String(q?.number ?? ""),
          name: String(q?.name ?? ""),
          ring_strategy: String(q?.ring_strategy ?? ""),
          static_members: Array.isArray(q?.static_agent_list)
            ? q.static_agent_list.map(mapMember)
            : [],
          dynamic_members: Array.isArray(q?.dynamic_agent_list)
            ? q.dynamic_agent_list.map(mapMember)
            : [],
        }),
      );

      const seen = new Set<string>();
      const uniqueAgents: QueueMember[] = [];
      for (const q of queues) {
        for (const m of [...q.static_members, ...q.dynamic_members]) {
          if (!m.extension_number || seen.has(m.extension_number)) continue;
          seen.add(m.extension_number);
          uniqueAgents.push(m);
        }
      }
      uniqueAgents.sort((a, b) =>
        a.extension_number.localeCompare(b.extension_number, undefined, { numeric: true }),
      );

      return {
        ok: true,
        configured: true,
        at: new Date().toISOString(),
        totalQueues: queues.length,
        queues,
        uniqueAgents,
      };
    },
  );

// ---- Endpoint capability probe (admin only) --------------------------------
//
// Verifies which Yeastar OpenAPI endpoints the connected PBX actually exposes,
// on this firmware, using the live access token. Purely read-only. Nothing
// else in the app changes based on this — the caller decides whether to wire
// a new integration in based on the results.
//
// Semantics:
//   supported === true  → HTTP 200 AND (errcode === 0 OR errcode absent)
//   supported === false → HTTP 404 / 501, errcode 404xx, or firmware-not-supported errcodes
//   otherwise the raw status/errcode/errmsg is returned so we can classify
//   auth vs. schema vs. missing-endpoint failures without guessing.

const endpointProbeInput = z.object({
  from: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/)
    .optional(),
  to: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/)
    .optional(),
});

interface ProbeResult {
  endpoint: string;
  method: "GET" | "POST";
  httpStatus: number;
  errcode: number | null;
  errmsg: string | null;
  supported: boolean;
  sampleKeys: string[] | null;
  dataCount: number | null;
  bodyPreview: string;
  note?: string;
}

export const yeastarEndpointProbe = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d) => endpointProbeInput.parse(d ?? {}))
  .handler(
    async ({
      context,
      data,
    }): Promise<{
      ok: boolean;
      configured: boolean;
      at: string;
      window?: { from: string; to: string; startEpoch: number; endEpoch: number };
      probeContext?: { sampleQueueId: number | null; sampleQueueNumber: string | null };
      results: ProbeResult[];
    }> => {
      await assertAdmin(context as any);
      const { isConfigured, yeastarFetch, getAccessToken } =
        await import("@/lib/yeastar/client.server");
      if (!isConfigured())
        return { ok: false, configured: false, at: new Date().toISOString(), results: [] };

      // Ensure auth works before probing — otherwise every probe returns the same auth error.
      try {
        await getAccessToken();
      } catch (err) {
        return {
          ok: false,
          configured: true,
          at: new Date().toISOString(),
          results: [
            {
              endpoint: "auth",
              method: "POST",
              httpStatus: 0,
              errcode: null,
              errmsg: err instanceof Error ? err.message : String(err),
              supported: false,
              sampleKeys: null,
              dataCount: null,
              bodyPreview: "",
              note: "Auth failed — probe aborted",
            },
          ],
        };
      }

      // 24h window ending now, or caller-supplied dates.
      const now = Math.floor(Date.now() / 1000);
      let startEpoch = now - 86_400;
      let endEpoch = now;
      if (data.from && data.to) {
        startEpoch = Math.floor(new Date(`${data.from}T00:00:00Z`).getTime() / 1000);
        endEpoch = Math.floor(new Date(`${data.to}T23:59:59Z`).getTime() / 1000);
      }

      const classify = (
        httpStatus: number,
        errcode: number | null,
        errmsg: string | null,
      ): boolean => {
        if (httpStatus === 200 && (errcode === 0 || errcode === null)) return true;
        // Yeastar returns 200 with errcode for "invalid params" too — that still means
        // the endpoint exists on this firmware. Only treat clear "not supported" as false.
        if (httpStatus === 200 && errcode !== null && errcode !== 0) {
          const msg = (errmsg ?? "").toLowerCase();
          if (
            msg.includes("not support") ||
            msg.includes("not exist") ||
            msg.includes("no such") ||
            msg.includes("invalid api")
          )
            return false;
          return true; // endpoint exists, just needs different params
        }
        return false;
      };

      const summarize = (json: any): { sampleKeys: string[] | null; dataCount: number | null } => {
        if (!json || typeof json !== "object") return { sampleKeys: null, dataCount: null };
        const arr = Array.isArray(json.data)
          ? json.data
          : Array.isArray(json.list)
            ? json.list
            : Array.isArray(json.result)
              ? json.result
              : null;
        const dataCount = arr ? arr.length : null;
        const first = arr && arr.length ? arr[0] : json;
        const sampleKeys =
          first && typeof first === "object" ? Object.keys(first).slice(0, 40) : null;
        return { sampleKeys, dataCount };
      };

      const runProbe = async (
        endpoint: string,
        method: "GET" | "POST",
        query: Record<string, string | number | undefined> = {},
        body?: Record<string, unknown>,
        note?: string,
      ): Promise<ProbeResult> => {
        try {
          const {
            httpStatus,
            json,
            body: rawBody,
          } = await yeastarFetch<any>(endpoint, query, { method, body, timeoutMs: 15_000 });
          const errcode = json?.errcode ?? null;
          const errmsg = json?.errmsg ?? null;
          const { sampleKeys, dataCount } = summarize(json);
          return {
            endpoint,
            method,
            httpStatus,
            errcode,
            errmsg,
            supported: classify(httpStatus, errcode, errmsg),
            sampleKeys,
            dataCount,
            bodyPreview: (rawBody ?? "").slice(0, 400),
            note,
          };
        } catch (err) {
          return {
            endpoint,
            method,
            httpStatus: 0,
            errcode: null,
            errmsg: err instanceof Error ? err.message : String(err),
            supported: false,
            sampleKeys: null,
            dataCount: null,
            bodyPreview: "",
            note: note ?? "fetch threw",
          };
        }
      };

      // The connected firmware only exposes /openapi/v1.0/*. We still test v2.0
      // paths explicitly so the caller sees the actual 404 rather than assuming.
      const results: ProbeResult[] = [];

      // Discover a real queue id / number up-front. /queue/call_status and
      // /queue/agent_status require a queue id on this firmware — probing them
      // without one just returns "invalid params" and looks like a false failure.
      let sampleQueueId: number | null = null;
      let sampleQueueNumber: string | null = null;
      try {
        const { httpStatus, json } = await yeastarFetch<any>(
          "/openapi/v1.0/queue/list",
          { page: 1, page_size: 10 },
          { timeoutMs: 10_000 },
        );
        if (httpStatus === 200 && json?.errcode === 0) {
          const first = Array.isArray(json.queue_list) ? json.queue_list[0] : null;
          if (first) {
            sampleQueueId = Number(first?.id ?? 0) || null;
            sampleQueueNumber = String(first?.number ?? "") || null;
          }
        }
      } catch {
        /* ignore — probes below will still surface the failure */
      }

      const queueIdNote = sampleQueueId
        ? `Probed with queue_id=${sampleQueueId} (${sampleQueueNumber ?? "?"}) from /queue/list.`
        : "No queue id discovered from /queue/list — probe used empty params.";

      // --- CDR ---------------------------------------------------------------
      results.push(
        await runProbe(
          "/openapi/v1.0/cdr/list",
          "GET",
          { page: 1, page_size: 1 },
          undefined,
          "Current implementation uses this as fallback.",
        ),
      );
      results.push(
        await runProbe(
          "/openapi/v1.0/cdr/search",
          "GET",
          { page: 1, page_size: 1, start_time: startEpoch, end_time: endEpoch },
          undefined,
          "Current implementation prefers this over /cdr/list.",
        ),
      );
      results.push(
        await runProbe(
          "/openapi/v2.0/cdr/detail",
          "GET",
          { start_time: startEpoch, end_time: endEpoch, page: 1, page_size: 1 },
          undefined,
          "v2.0 CDR — commonly absent on P-Series.",
        ),
      );

      // --- Queue ------------------------------------------------------------
      const queueScope = sampleQueueId ? { queue_id: sampleQueueId } : {};
      results.push(
        await runProbe(
          "/openapi/v1.0/queue/call_status",
          "GET",
          queueScope,
          undefined,
          `Real-time queue call status. ${queueIdNote}`,
        ),
      );
      results.push(
        await runProbe(
          "/openapi/v1.0/queue/agent_status",
          "GET",
          queueScope,
          undefined,
          `Real-time queue agent status. ${queueIdNote}`,
        ),
      );
      results.push(
        await runProbe(
          "/openapi/v1.0/queue/list",
          "GET",
          { page: 1, page_size: 10 },
          undefined,
          "Queue enumeration.",
        ),
      );
      results.push(
        await runProbe(
          "/openapi/v1.0/queue/query",
          "GET",
          sampleQueueId ? { queue_id: sampleQueueId } : {},
          undefined,
          `Queue configuration query. ${queueIdNote}`,
        ),
      );
      results.push(
        await runProbe(
          "/openapi/v1.0/queue/callstatistics",
          "GET",
          { start_time: startEpoch, end_time: endEpoch },
          undefined,
          "Historical queue statistics.",
        ),
      );
      results.push(
        await runProbe(
          "/openapi/v1.0/queue/panel/callstatistics",
          "GET",
          { start_time: startEpoch, end_time: endEpoch },
          undefined,
          "Queue panel statistics (alt path).",
        ),
      );

      // --- Call report (authoritative queue/agent KPIs) ---------------------
      // Candidate replacements for CDR-inferred KPIs. Probe-only in this iteration —
      // NOT wired into analytics until we confirm firmware support.
      results.push(
        await runProbe(
          "/openapi/v1.0/call_report/list",
          "GET",
          { start_time: startEpoch, end_time: endEpoch, page: 1, page_size: 1 },
          undefined,
          "Authoritative call report list.",
        ),
      );
      results.push(
        await runProbe(
          "/openapi/v1.0/call_report/detail",
          "GET",
          { start_time: startEpoch, end_time: endEpoch, page: 1, page_size: 1 },
          undefined,
          "Authoritative call report detail.",
        ),
      );

      // --- Call / extension -------------------------------------------------
      results.push(
        await runProbe("/openapi/v1.0/call/query", "GET", {}, undefined, "Active call query."),
      );
      results.push(
        await runProbe(
          "/openapi/v1.0/extension/callstatistics",
          "GET",
          { start_time: startEpoch, end_time: endEpoch },
          undefined,
          "Per-extension historical stats.",
        ),
      );

      // --- System -----------------------------------------------------------
      results.push(
        await runProbe(
          "/openapi/v1.0/system/information",
          "GET",
          {},
          undefined,
          "PBX system information (firmware / model).",
        ),
      );

      // --- Event push (webhooks / subscriptions) ----------------------------
      // These are subscription endpoints, not GET data endpoints. Probing them
      // read-only tells us whether the firmware exposes the event push API at all.
      results.push(
        await runProbe(
          "/openapi/v1.0/event/list",
          "GET",
          {},
          undefined,
          "Event push — list current subscriptions (Call End / Incoming / Ring Timeout / Transfer).",
        ),
      );
      results.push(
        await runProbe(
          "/openapi/v1.0/event_center/event/list",
          "GET",
          {},
          undefined,
          "Event Center — alt event listing path.",
        ),
      );
      results.push(
        await runProbe(
          "/openapi/v1.0/subscribe",
          "GET",
          {},
          undefined,
          "Event subscription endpoint (probe with GET — POST would create a subscription).",
        ),
      );

      return {
        ok: true,
        configured: true,
        at: new Date().toISOString(),
        window: {
          from: data.from ?? new Date(startEpoch * 1000).toISOString().slice(0, 10),
          to: data.to ?? new Date(endEpoch * 1000).toISOString().slice(0, 10),
          startEpoch,
          endEpoch,
        },
        probeContext: { sampleQueueId, sampleQueueNumber },
        results,
      };
    },
  );

// ---- Development-only endpoint diagnostics ---------------------------------
//
// Surfaces endpoint / request / status / body / parsed output / parse errors for
// the endpoints this integration depends on, so a firmware field change is
// visible immediately. Refuses to run outside development: it returns raw PBX
// response bodies, which is a development affordance and not something to expose
// from a production deployment even to an administrator.

const devDiagnosticsInput = z.object({
  windowDays: z.number().int().min(1).max(30).default(7),
});

export type DevDiagnosticsResult =
  | { ok: false; devOnly: true }
  | { ok: false; configured: false }
  | { ok: false; configured: true; error: string }
  | { ok: true; configured: true; report: YeastarDiagnosticsReport };

export const yeastarDevDiagnostics = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d) => devDiagnosticsInput.parse(d ?? {}))
  .handler(async ({ context, data }): Promise<DevDiagnosticsResult> => {
    if (!import.meta.env.DEV) {
      return { ok: false, devOnly: true };
    }
    await assertAdmin(context as any);
    const { isConfigured } = await import("@/lib/yeastar/client.server");
    if (!isConfigured()) return { ok: false, configured: false };
    try {
      const { runDiagnostics } = await import("@/lib/yeastar/diagnostics.server");
      const report = await runDiagnostics(data.windowDays);
      return { ok: true, configured: true, report };
    } catch (err) {
      return {
        ok: false,
        configured: true,
        error: err instanceof Error ? err.message : String(err),
      };
    }
  });

// ---- Live KPI validation (admin, production-safe) --------------------------
//
// Runs the real analytics pipeline over live CDR and re-derives every KPI
// independently, so the numbers on the Call Center page can be validated
// against the PBX in the environment where the Yeastar credentials actually
// exist. Unlike `yeastarDevDiagnostics` this does NOT return raw response
// bodies or any per-call data — only aggregates and pass/fail checks — which is
// what makes it safe outside development. Administrator only; nothing is
// persisted; every request is a read.

const kpiValidationInput = z.object({
  from: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/)
    .optional(),
  to: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/)
    .optional(),
  /** Used only when `from`/`to` are omitted. */
  windowDays: z.number().int().min(1).max(30).default(7),
  /**
   * Which workflow to validate. Telesales is compared against Yeastar Reports ›
   * Extension Call Statistics; Customer Care must NOT use that report, and is
   * validated on queue analytics instead.
   */
  team: z.enum(["all", "customer_care", "telesales"]).default("all"),
});

export type KpiValidationResult =
  | { ok: false; configured: false }
  | { ok: false; configured: true; error: string }
  | { ok: true; configured: true; report: KpiValidationReport };

/** `YYYY-MM-DD` for an epoch-ms instant in the business timezone. */
function businessDay(atMs: number): string {
  const off = Number(process.env.YEASTAR_UTC_OFFSET_MINUTES ?? BUSINESS_UTC_OFFSET_MINUTES);
  return new Date(atMs + off * 60_000).toISOString().slice(0, 10);
}

export const yeastarKpiValidation = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d) => kpiValidationInput.parse(d ?? {}))
  .handler(async ({ context, data }): Promise<KpiValidationResult> => {
    await assertAdmin(context as any);
    const { isConfigured } = await import("@/lib/yeastar/client.server");
    if (!isConfigured()) return { ok: false, configured: false };
    try {
      const now = Date.now();
      const to = data.to ?? businessDay(now);
      const from = data.from ?? businessDay(now - (data.windowDays - 1) * 86_400_000);

      // Same roster path analytics uses, including the DB fallback, so the
      // validation exercises the exact context the KPIs were computed under.
      const agents = await loadAgents((context as any).supabase);
      const ctx = await buildNormalizationContext(agents.map((a) => a.ext));

      const teamExtensions =
        data.team === "all"
          ? null
          : new Set(agents.filter((a) => a.team === data.team).map((a) => String(a.ext).trim()));

      // Observe the production CDR cache WITHOUT touching it. Validation always
      // fetches its own copy, so running diagnostics can neither warm nor evict
      // the cache the dashboards depend on.
      const cached = cdrCache.get(`${from}|${to}`);
      const cdrCacheState: { status: "warm" | "cold"; ageMs: number | null } =
        cached && Date.now() - cached.at < CDR_CACHE_TTL_MS
          ? { status: "warm", ageMs: Date.now() - cached.at }
          : { status: "cold", ageMs: null };

      const { runKpiValidation } = await import("@/lib/yeastar/kpi-validation.server");
      const scopedAgents =
        data.team === "all" ? agents : agents.filter((a) => a.team === data.team);
      const agentsByExtension = new Map(
        scopedAgents.filter((a) => a.ext).map((a) => [String(a.ext).trim(), a.name]),
      );

      const report = await runKpiValidation(from, to, ctx, {
        teamExtensions,
        agentsByExtension,
        cdrCache: cdrCacheState,
      });
      return { ok: true, configured: true, report };
    } catch (err) {
      return {
        ok: false,
        configured: true,
        error: err instanceof Error ? err.message : String(err),
      };
    }
  });

// ---- Agent mapping diagnostic (admin) --------------------------------------

export const yeastarAgentMappingDiagnostic = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d) => cdrProbeInput.parse(d))
  .handler(async ({ context, data }) => {
    await assertAdmin(context as any);
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");

    const { data: profiles } = await supabaseAdmin
      .from("profiles")
      .select("id,full_name,agent_code,active");
    // yeastar_ext isn't in generated types yet; separate select cast.
    const { data: extRows } = await supabaseAdmin.from("profiles" as any).select("id,yeastar_ext");
    const extMap = new Map<string, string | null>(
      ((extRows as any[]) ?? []).map((r) => [r.id, r.yeastar_ext ?? null]),
    );
    const { data: roles } = await supabaseAdmin.from("user_roles").select("user_id,role");
    const roleMap = new Map(((roles as any[]) ?? []).map((r) => [r.user_id, r.role as string]));

    const agents = ((profiles as any[]) ?? [])
      .filter((p) => p.active)
      .map((p) => ({
        id: p.id,
        name: p.full_name,
        agent_code: p.agent_code ?? null,
        ext: extMap.get(p.id) ?? null,
        role: roleMap.get(p.id) ?? null,
      }))
      .filter((p) => p.role === "customer_care" || p.role === "telesales");

    const missingExt = agents.filter((a) => !a.ext || !String(a.ext).trim());

    const { isConfigured } = await import("@/lib/yeastar/client.server");
    let topUnmatched: Array<{ ext: string; count: number }> = [];
    let cdrError: string | null = null;
    if (isConfigured()) {
      try {
        const { fetchCdrRange } = await import("@/lib/yeastar/cdr.server");
        const { records } = await fetchCdrRange({ from: data.from, to: data.to });
        const knownExts = new Set(
          agents.map((a) => String(a.ext ?? a.agent_code ?? "").trim()).filter(Boolean),
        );
        const counts = new Map<string, number>();
        for (const r of records) {
          const ext =
            r.call_type === "Outbound"
              ? (r.call_from_number ?? null)
              : r.call_type === "Inbound"
                ? (r.call_to_number ?? null)
                : (r.call_from_number ?? r.call_to_number ?? null);
          if (!ext) continue;
          if (knownExts.has(String(ext).trim())) continue;
          counts.set(ext, (counts.get(ext) ?? 0) + 1);
        }
        topUnmatched = [...counts.entries()]
          .map(([ext, count]) => ({ ext, count }))
          .sort((a, b) => b.count - a.count)
          .slice(0, 25);
      } catch (err) {
        cdrError = err instanceof Error ? err.message : String(err);
      }
    }

    return {
      ok: true as const,
      agentCount: agents.length,
      missingExt: missingExt.map((a) => ({ id: a.id, name: a.name, agent_code: a.agent_code })),
      topUnmatched,
      cdrError,
    };
  });

// ---- Analytics (dashboard) -------------------------------------------------

const statsInput = z.object({
  from: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  to: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  team: z.enum(["all", "customer_care", "telesales"]).default("all"),
  agentId: z.string().uuid().nullable().optional(),
});

const analyticsInput = statsInput.extend({
  jobId: z.string().min(1).max(80).optional(),
  direction: z.enum(["all", "Inbound", "Outbound"]).default("all"),
  status: z.enum(["all", "ANSWERED", "NO ANSWER", "BUSY", "FAILED", "VOICEMAIL"]).default("all"),
  includeOrders: z.boolean().default(true),
  /**
   * Restrict to one queue number. ADDITIVE and optional — every existing caller
   * omits it and behaves exactly as before. Used only by the queue-driven
   * Customer Care dashboard; Telesales never sends it, because telesales agents
   * belong to no queue.
   */
  queue: z.string().max(20).optional(),
});

// Aligned with the Call Center query's own `staleTime` (5 min). The client will
// not ask for fresher data than this, so a shorter server TTL only produced
// redundant full-window CDR sweeps — the dominant cost of the page. Caching
// longer changes nothing about how a KPI is computed, only how often the same
// rows are re-fetched.
const CDR_CACHE_TTL_MS = 5 * 60_000;
const CDR_CACHE_MAX = 20;
const cdrCache = new Map<string, { at: number; promise: Promise<any> }>();

function evictCdrCache() {
  const now = Date.now();
  // TTL sweep
  for (const [k, v] of cdrCache) {
    if (now - v.at > CDR_CACHE_TTL_MS) cdrCache.delete(k);
  }
  // Size cap: drop oldest entries (Map preserves insertion order)
  while (cdrCache.size > CDR_CACHE_MAX) {
    const oldest = cdrCache.keys().next().value;
    if (oldest === undefined) break;
    cdrCache.delete(oldest);
  }
}

// ---- Phase-1 (normalization) cache ------------------------------------------
//
// The CDR *network* fetch is cached above, but normalizing those rows — row
// de-dup on `new_id` and grouping by `call_id` — is pure over the record set and
// the PBX roster, and independent of team/agent/direction/status/orders. The
// Call Center page issues one analytics request per filter permutation over the
// same window, so without this every filter toggle re-ran the whole
// normalization.
//
// Keyed by the `from|to` window plus a roster fingerprint (a queue or extension
// change alters how legs are classified, so it must invalidate), and
// identity-checked against the exact records array returned by the CDR cache:
// when the CDR entry expires and refetches, it yields a NEW array, the identity
// check misses, and we re-normalize. Same size bound as the CDR cache; entries
// only hold references to the already-cached rows, not copies.
type ClassifiedRecordsT = import("@/lib/yeastar/stats.server").ClassifiedRecords;
const classifiedCache = new Map<string, { records: unknown[]; value: ClassifiedRecordsT }>();

function getClassifiedCached(
  from: string,
  to: string,
  records: any[],
  ctx: NormalizationContext,
  classifyRecords: (r: any[], c: NormalizationContext) => ClassifiedRecordsT,
): ClassifiedRecordsT {
  const key = `${from}|${to}|${rosterSignature(ctx)}`;
  const hit = classifiedCache.get(key);
  if (hit && hit.records === records) return hit.value;
  const value = classifyRecords(records, ctx);
  classifiedCache.set(key, { records, value });
  while (classifiedCache.size > CDR_CACHE_MAX) {
    const oldest = classifiedCache.keys().next().value;
    if (oldest === undefined) break;
    classifiedCache.delete(oldest);
  }
  return value;
}

async function getCdrCached(from: string, to: string, jobId?: string) {
  evictCdrCache();
  const key = `${from}|${to}`;
  const now = Date.now();
  const hit = cdrCache.get(key);
  if (hit && now - hit.at < CDR_CACHE_TTL_MS) {
    if (jobId) {
      const p = await import("@/lib/yeastar/progress.server");
      hit.promise
        .then((cdr) => {
          p.updateJob(jobId, {
            status: "aggregating",
            page: 1,
            totalPages: 1,
            records: cdr.records.length,
            totalReported: cdr.totalReported,
            message: `Cached ${cdr.records.length.toLocaleString()} records — aggregating…`,
          }).catch(() => {});
        })
        .catch(() => {});
    }
    return hit.promise;
  }
  const { fetchCdrRange } = await import("@/lib/yeastar/cdr.server");
  const promise = fetchCdrRange({ from, to, jobId }).catch((e) => {
    cdrCache.delete(key);
    throw e;
  });
  cdrCache.set(key, { at: now, promise });
  if (cdrCache.size > CDR_CACHE_MAX) evictCdrCache();
  return promise;
}

// Customer Care roster is authoritative from PBX queue #6400 (see user
// clarification: telesales agents do NOT belong to any queue). Telesales
// stays DB-driven via `yeastar_ext`, backstopped by static extensions so
// Ahmed (1000) and Kamr (1001) are always present. The two rosters are
// merged — one is never a substitute for the other.
const CUSTOMER_CARE_QUEUE_NUMBER = "6400";
const TELESALES_STATIC_EXTS: Array<{ ext: string; name: string }> = [
  { ext: "1000", name: "Ahmed Mousad" },
  { ext: "1001", name: "Kamr Elsayed" },
];

const ROSTER_TTL_MS = 5 * 60_000;

interface PbxRoster {
  /** Customer Care queue members: extension → display name. */
  ccExts: Map<string, string>;
  /** Every configured queue number. A queue is never an agent. */
  queueNumbers: Set<string>;
  /** Every configured extension number, from /extension/list. */
  extensionNumbers: Set<string>;
  /** Members of every queue — extensions by definition, whatever page they are on. */
  queueMemberExts: Set<string>;
  /** Configured queues, for the Customer Care queue filter. */
  queues: Array<{ number: string; name: string }>;
}

let rosterCache: { at: number; roster: PbxRoster } | null = null;

/**
 * Pull the two authoritative rosters from the PBX.
 *
 * Both are required by the normalization layer: `queue/list` says which numbers
 * are queues and `extension/list` says which are agents. Without them a CDR leg
 * cannot be told apart from an IVR stage, which is exactly the ambiguity that
 * produced the old KPI errors — so this is fetched, not guessed.
 */
async function fetchPbxRoster(): Promise<PbxRoster> {
  const now = Date.now();
  if (rosterCache && now - rosterCache.at < ROSTER_TTL_MS) return rosterCache.roster;

  const ccExts = new Map<string, string>();
  const queueNumbers = new Set<string>();
  const extensionNumbers = new Set<string>();
  const queueMemberExts = new Set<string>();
  const queues: Array<{ number: string; name: string }> = [];
  let ok = false;
  try {
    const { isConfigured, yeastarFetch } = await import("@/lib/yeastar/client.server");
    if (!isConfigured()) return { ccExts, queueNumbers, extensionNumbers, queueMemberExts, queues };

    const queueRes = await yeastarFetch<any>("/openapi/v1.0/queue/list", {
      page: 1,
      page_size: 100,
    });
    if (queueRes.httpStatus === 200 && queueRes.json?.errcode === 0) {
      ok = true;
      const queueList = Array.isArray(queueRes.json.queue_list) ? queueRes.json.queue_list : [];
      for (const q of queueList) {
        const qnum = String(q?.number ?? "").trim();
        if (qnum) {
          queueNumbers.add(qnum);
          queues.push({ number: qnum, name: String(q?.name ?? "").trim() || qnum });
        }
        const members = [
          ...(Array.isArray(q.static_agent_list) ? q.static_agent_list : []),
          ...(Array.isArray(q.dynamic_agent_list) ? q.dynamic_agent_list : []),
        ];
        for (const m of members) {
          // Verified member shape: value = extension id, text = display name,
          // text2 = extension NUMBER.
          const ext = String(m?.text2 ?? "").trim();
          const name = String(m?.text ?? "").trim();
          if (!ext) continue;
          queueMemberExts.add(ext);
          if (qnum === CUSTOMER_CARE_QUEUE_NUMBER) ccExts.set(ext, name || ext);
        }
      }
    }

    // /extension/list pages at 200; this PBX has ~28 extensions, but page
    // through anyway rather than silently truncating a larger roster later.
    const PAGE = 200;
    for (let page = 1; page <= 10; page++) {
      const { httpStatus, json } = await yeastarFetch<any>("/openapi/v1.0/extension/list", {
        page,
        page_size: PAGE,
      });
      if (httpStatus !== 200 || json?.errcode !== 0) break;
      const list: any[] = Array.isArray(json.data) ? json.data : [];
      for (const e of list) {
        const n = String(e?.number ?? "").trim();
        if (n) extensionNumbers.add(n);
      }
      if (list.length < PAGE) break;
    }
  } catch {
    // Swallow — callers fall back to the DB roster.
  }
  // Cache only a roster we actually retrieved, so a transient PBX failure
  // doesn't pin an empty roster for a minute.
  if (ok || extensionNumbers.size > 0) {
    rosterCache = {
      at: now,
      roster: { ccExts, queueNumbers, extensionNumbers, queueMemberExts, queues },
    };
  }
  return { ccExts, queueNumbers, extensionNumbers, queueMemberExts, queues };
}

async function fetchCustomerCareQueueRoster(): Promise<Map<string, string>> {
  return (await fetchPbxRoster()).ccExts;
}

/**
 * Build the normalization context for a CDR window.
 *
 * `fallbackExts` (the app's own agent extensions) is used ONLY when
 * `/extension/list` is unavailable. Without any extension roster the normalizer
 * cannot recognise an agent leg and every inbound call would look like it never
 * reached a human — degrading to the app roster keeps analytics honest for the
 * agents we know about instead of reporting a zero answer rate.
 */
async function buildNormalizationContext(
  fallbackExts: Iterable<string> = [],
): Promise<NormalizationContext> {
  const { extensionNumbers, queueNumbers, queueMemberExts } = await fetchPbxRoster();
  const { buildContext, parseBusinessHours } = await import("@/lib/yeastar/normalize");
  const exts = new Set(extensionNumbers);
  // Queue members are extensions by definition, and /extension/list is paged —
  // an agent on an unfetched page must still be recognisable.
  for (const ext of queueMemberExts) exts.add(ext);
  if (exts.size === 0) {
    for (const ext of fallbackExts) {
      const e = String(ext).trim();
      if (e) exts.add(e);
    }
  }
  // Business hours are configuration, not something this firmware exposes:
  // queue 6400 reports `enable_time_condition: 0`, so any time condition lives
  // on the inbound route and there is no API for it. Unset means NO call is
  // excluded for arriving after hours — guessing a window would silently move
  // every KPI, which is worse than not applying the rule.
  //   YEASTAR_BUSINESS_HOURS="sun-thu 08:00-17:00"
  const businessHours = parseBusinessHours(
    process.env.YEASTAR_BUSINESS_HOURS,
    Number(process.env.YEASTAR_UTC_OFFSET_MINUTES ?? BUSINESS_UTC_OFFSET_MINUTES),
  );

  // The PBX's outbound ring timeout. It is what separates a genuine No Answer
  // (rang the full timeout) from an agent cancelling early — both carry
  // disposition "NO ANSWER", so nothing in the CDR distinguishes them. Confirm
  // the real value from the ring histogram on /admin/yeastar-diagnostics.
  const ringTimeout = Number(process.env.YEASTAR_OUTBOUND_RING_TIMEOUT_SEC);

  return buildContext(
    [...exts].map((number) => ({ number })),
    [...queueNumbers].map((number) => ({ number })),
    undefined,
    businessHours,
    Number.isFinite(ringTimeout) && ringTimeout > 0 ? ringTimeout : undefined,
  );
}

/** Cheap stable fingerprint of a roster, so a roster change busts the cache. */
function rosterSignature(ctx: NormalizationContext): string {
  const bh = ctx.businessHours;
  const src =
    `${[...ctx.extensionNumbers].sort().join(",")}|${[...ctx.queueNumbers].sort().join(",")}` +
    // Business hours change which calls are operational, so they must bust the
    // normalization cache exactly like a roster change does.
    `|${bh ? `${bh.days.join("")}:${bh.startMinute}-${bh.endMinute}@${bh.utcOffsetMinutes}` : "none"}` +
    // The ring timeout decides cancelled-vs-no-answer, so it must bust the
    // normalization cache too.
    `|rt${ctx.outboundRingTimeoutSeconds ?? "d"}`;
  let h = 2166136261;
  for (let i = 0; i < src.length; i++) {
    h ^= src.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return (h >>> 0).toString(36);
}

/**
 * Agent roster cache.
 *
 * `loadAgents` issues three Supabase reads plus a PBX queue fetch, and it ran on
 * every analytics request — so each filter toggle paid for it again even though
 * the roster is identical. It is cached for the same window as the PBX roster.
 * The roster only decides ATTRIBUTION (which agent a call belongs to), never how
 * a KPI is computed, and a newly added agent appears within the TTL.
 */
const AGENT_ROSTER_TTL_MS = ROSTER_TTL_MS;
let agentRosterCache: {
  at: number;
  promise: Promise<
    Array<{ id: string; name: string; team: "customer_care" | "telesales"; ext: string }>
  >;
} | null = null;

async function loadAgentsCached(supabase: any) {
  const now = Date.now();
  if (agentRosterCache && now - agentRosterCache.at < AGENT_ROSTER_TTL_MS) {
    return agentRosterCache.promise;
  }
  const promise = loadAgents(supabase).catch((e) => {
    agentRosterCache = null;
    throw e;
  });
  agentRosterCache = { at: now, promise };
  return promise;
}

async function loadAgents(_supabase: any) {
  // yeastar_ext and roles are read via the service-role client because
  // authenticated SELECT on profiles no longer exposes sensitive columns
  // ([H4]). This function is only reachable after a call-center permission
  // check upstream, so an admin read here is appropriate.
  const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
  const [{ data: profiles }, { data: extRows }, { data: roles }, ccQueueExts] = await Promise.all([
    supabaseAdmin.from("profiles").select("id,full_name,agent_code,active"),
    supabaseAdmin.from("profiles" as any).select("id,yeastar_ext"),
    supabaseAdmin.from("user_roles").select("user_id,role"),
    fetchCustomerCareQueueRoster(),
  ]);

  const extMap = new Map<string, string | null>(
    ((extRows as any[]) ?? []).map((r) => [r.id, r.yeastar_ext ?? null]),
  );
  const roleMap = new Map<string, string>(
    ((roles as any[]) ?? []).map((r) => [r.user_id, r.role as string]),
  );
  const activeProfiles = ((profiles as any[]) ?? []).filter((p) => p.active);

  // Profile lookup by extension — used to attach queue members to their DB user.
  const profileByExt = new Map<string, { id: string; name: string }>();
  for (const p of activeProfiles) {
    const ext = String(extMap.get(p.id) ?? p.agent_code ?? "").trim();
    if (ext) profileByExt.set(ext, { id: p.id, name: p.full_name ?? "Unknown" });
  }

  const agents: Array<{
    id: string;
    name: string;
    team: "customer_care" | "telesales";
    ext: string;
  }> = [];

  // --- Customer Care: queue #6400 authoritative; DB fallback if PBX fails ---
  if (ccQueueExts.size > 0) {
    for (const [ext, pbxName] of ccQueueExts) {
      const p = profileByExt.get(ext);
      agents.push({
        id: p?.id ?? `pbx:${ext}`,
        name: p?.name ?? pbxName,
        team: "customer_care",
        ext,
      });
    }
  } else {
    for (const p of activeProfiles) {
      if (roleMap.get(p.id) !== "customer_care") continue;
      const ext = String(extMap.get(p.id) ?? p.agent_code ?? "").trim();
      if (!ext) continue;
      agents.push({ id: p.id, name: p.full_name ?? "Unknown", team: "customer_care", ext });
    }
  }

  // --- Telesales: DB-driven, backstopped by static extensions -------------
  //     Telesales does NOT belong to any PBX queue — the static list keeps
  //     Ahmed (1000) / Kamr (1001) visible even if their yeastar_ext row
  //     is missing.
  const telesalesExtsPresent = new Set<string>();
  for (const p of activeProfiles) {
    if (roleMap.get(p.id) !== "telesales") continue;
    const ext = String(extMap.get(p.id) ?? p.agent_code ?? "").trim();
    if (!ext) continue;
    telesalesExtsPresent.add(ext);
    agents.push({ id: p.id, name: p.full_name ?? "Unknown", team: "telesales", ext });
  }
  for (const t of TELESALES_STATIC_EXTS) {
    if (telesalesExtsPresent.has(t.ext)) continue;
    const p = profileByExt.get(t.ext);
    agents.push({
      id: p?.id ?? `pbx:${t.ext}`,
      name: p?.name ?? t.name,
      team: "telesales",
      ext: t.ext,
    });
  }

  return agents;
}

// Note: legacy `getAgentCallStats` was removed (Prompt 1, item 1). Callers
// use `getCallCenterAnalytics` below which is the queue-aware, order-joined
// analytics engine.

/**
 * Full Call Center Analytics — queue-aware, order-joined.
 */
export const getCallCenterAnalytics = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d) => analyticsInput.parse(d))
  .handler(async ({ context, data }) => {
    const { supabase, userId } = context as { supabase: any; userId: string };
    const { isConfigured } = await import("@/lib/yeastar/client.server");
    if (!isConfigured()) return { ok: false as const, configured: false as const };

    const [{ canView, isAdmin }, { data: canAll }] = await Promise.all([
      callCenterAccess(supabase, userId),
      supabase.rpc("has_permission", { _user_id: userId, _permission: "view_all_agents" }),
    ]);
    if (!canView) throw new Error("Forbidden: call analytics access required");
    const seesAll = !!canAll || isAdmin;

    // Namespace the client-supplied job id to the caller. cdr_progress has no
    // owner column, so without this any authenticated user could read (or
    // clobber) another user's progress record by guessing its id. The progress
    // route re-derives the same key from its own authenticated user, so a job
    // is only ever visible to the user who started it.
    const scopedJobId = data.jobId ? `${userId}:${data.jobId}` : undefined;
    const progress = scopedJobId ? await import("@/lib/yeastar/progress.server") : null;
    if (progress && scopedJobId) await progress.initJob(scopedJobId);

    // `allAgents` stays unfiltered: it only ever feeds the roster fallback for
    // normalization, which must not depend on the active team/agent filter.
    const allAgents = await loadAgentsCached(supabase);
    let agents = allAgents;

    if (data.team !== "all") agents = agents.filter((a) => a.team === data.team);
    if (!seesAll) agents = agents.filter((a) => a.id === userId);
    else if (data.agentId) agents = agents.filter((a) => a.id === data.agentId);

    // Active scope for EVERY KPI. Non-privileged users are always scoped to
    // themselves; privileged users are scoped by the team/agent filter. When
    // no filter is active (team=all, no agent, privileged) scope stays
    // undefined and all calls/orders are included (prior behaviour).
    const effectiveAgentId = !seesAll ? userId : (data.agentId ?? null);
    const scopeActive = data.team !== "all" || !!effectiveAgentId;
    let scope: { exts: Set<string>; ownedQueueNumbers?: Set<string> } | undefined;
    if (scopeActive) {
      const exts = new Set(agents.map((a) => String(a.ext).trim()).filter((e) => e.length > 0));
      // A team-level selection (no specific agent) also owns its queue's
      // unanswered inbound calls. Only Customer Care owns a queue (6400).
      const ownedQueueNumbers =
        data.team === "customer_care" && !effectiveAgentId
          ? new Set([CUSTOMER_CARE_QUEUE_NUMBER])
          : undefined;
      scope = { exts, ownedQueueNumbers };
    }

    try {
      const cdr = await getCdrCached(data.from, data.to, scopedJobId);
      if (progress && scopedJobId)
        await progress.updateJob(scopedJobId, {
          status: "aggregating",
          message: "Computing analytics…",
          records: cdr.records.length,
        });

      // Do NOT pre-filter raw rows by direction/status here — a row is a LEG,
      // and dropping legs corrupts the call it belongs to. Filters are applied
      // to whole calls AFTER normalization.
      const records = cdr.records as any[];

      // Load orders in the same window, for telesales conversion
      // Orders scoped to the same team/agent as the calls (Orders is the SSOT
      // for order metrics; scoping here keeps conversion/completion aligned).
      let orders: any[] = [];
      if (data.includeOrders) {
        let oq = supabase
          .from("orders")
          .select("id,agent_id,order_date,status,order_type,invoice_value")
          .gte("order_date", data.from)
          .lte("order_date", data.to);
        if (data.team !== "all") oq = oq.eq("team", data.team);
        if (effectiveAgentId) oq = oq.eq("agent_id", effectiveAgentId);
        const { data: ord } = await oq;
        orders = (ord as any[]) ?? [];
      }

      const { aggregateClassified, classifyRecords } = await import("@/lib/yeastar/stats.server");
      // The PBX rosters drive leg classification: a queue is never an agent,
      // and an agent leg is only recognisable by its extension being on the
      // roster. Fall back to the app's own agent extensions if /extension/list
      // is unreachable.
      const ctx = await buildNormalizationContext(allAgents.map((a) => a.ext));
      // Phase 1 (normalize) is cached per window + roster; phase 2 applies the
      // request's direction/status/scope filters over whole calls.
      const classified = getClassifiedCached(data.from, data.to, records, ctx, classifyRecords);
      const result = aggregateClassified(classified, agents, orders, {
        direction: data.direction,
        status: data.status,
        queueNumber: data.queue ?? null,
        scope,
      });

      if (progress && scopedJobId)
        await progress.finishJob(scopedJobId, cdr.totalReported, cdr.records.length);

      return {
        ok: true as const,
        configured: true as const,
        window: {
          from: data.from,
          to: data.to,
          team: data.team,
          agentId: data.agentId ?? null,
          direction: data.direction,
          status: data.status,
          queue: data.queue ?? null,
        },
        cdr: {
          path: cdr.path,
          totalReported: cdr.totalReported,
          fetched: cdr.records.length,
          filtered: result.totals.total,
          truncated: cdr.truncated,
          elapsedMs: cdr.elapsedMs,
        },
        ...result,
      };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (progress && scopedJobId) await progress.failJob(scopedJobId, msg);
      throw err;
    }
  });

// ---- Queue options (Customer Care queue filter) ----------------------------
//
// Additive, read-only. Gated on the shared Call Center view permission rather
// than administrator, because it feeds a filter dropdown on the Customer Care
// dashboard. Returns queue numbers and names only.

export const yeastarQueueOptions = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .handler(
    async ({
      context,
    }): Promise<{
      ok: boolean;
      configured: boolean;
      queues: Array<{ number: string; name: string }>;
    }> => {
      const { supabase, userId } = context as { supabase: any; userId: string };
      const { canView } = await callCenterAccess(supabase, userId);
      if (!canView) throw new Error("Forbidden: call analytics access required");

      const { isConfigured } = await import("@/lib/yeastar/client.server");
      if (!isConfigured()) return { ok: false, configured: false, queues: [] };

      const { queues } = await fetchPbxRoster();
      return { ok: true, configured: true, queues };
    },
  );

// ---- Realtime queue widgets ------------------------------------------------
//
// Powered ONLY by /openapi/v1.0/queue/call_status and /queue/agent_status
// (confirmed supported on this firmware). Never used for historical
// analytics — those stay CDR-driven.

export const yeastarRealtimeQueue = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => {
    const { supabase, userId } = context as { supabase: any; userId: string };
    const { canView } = await callCenterAccess(supabase, userId);
    if (!canView) throw new Error("Forbidden");

    const { isConfigured, yeastarFetch } = await import("@/lib/yeastar/client.server");
    if (!isConfigured()) {
      return { ok: false as const, configured: false as const };
    }

    // errcode 60001 (DATA NOT FOUND) from the realtime queue endpoints means
    // "queue idle / nobody signed in" — verified against the live PBX. The
    // response still carries the full field skeleton, so it must be parsed as a
    // legitimate empty snapshot rather than discarded as a failure.
    const safeFetch = async (
      path: string,
      query: Record<string, string | number | undefined> = {},
    ) => {
      try {
        const { httpStatus, json } = await yeastarFetch<any>(path, query, { timeoutMs: 8_000 });
        if (httpStatus !== 200) return null;
        if (json?.errcode !== 0 && json?.errcode !== 60001) return null;
        return json;
      } catch {
        return null;
      }
    };

    // /queue/call_status and /queue/agent_status require a queue id on this
    // firmware; without it they return "invalid params" and the widget shows
    // zeros. Enumerate queues from /queue/list, then fan out per queue and
    // merge — preserving the flat calls[] / agents[] shape the widget expects.
    const queueListJson = await safeFetch("/openapi/v1.0/queue/list", { page: 1, page_size: 100 });
    const queueList: any[] = Array.isArray(queueListJson?.queue_list)
      ? queueListJson.queue_list
      : [];
    const queueIds: number[] = queueList
      .map((q) => Number(q?.id ?? 0))
      .filter((id) => Number.isFinite(id) && id > 0);

    const arr = (v: unknown): any[] => (Array.isArray(v) ? v : []);

    const perQueue = await Promise.all(
      queueIds.map(async (queue_id) => {
        const [cs, as] = await Promise.all([
          safeFetch("/openapi/v1.0/queue/call_status", { queue_id }),
          safeFetch("/openapi/v1.0/queue/agent_status", { queue_id }),
        ]);
        // Verified response shape: three separate lists plus ready-made
        // scalars. `data` and `queue_call_status_list` do NOT exist here — the
        // widget used to read them and therefore always rendered zeros.
        return {
          waiting: arr(cs?.waiting_list),
          active: arr(cs?.active_list),
          ringing: arr(cs?.ringing_list),
          // Prefer the PBX's own counters; the lists are the cross-check.
          waitingCount: Number(cs?.waiting_calls ?? arr(cs?.waiting_list).length),
          activeCount: Number(cs?.active_calls ?? arr(cs?.active_list).length),
          ringingCount: Number(cs?.ringing_calls ?? arr(cs?.ringing_list).length),
          agents: arr(as?.data),
        };
      }),
    );

    const sum = (pick: (r: (typeof perQueue)[number]) => number) =>
      perQueue.reduce((n, r) => n + (Number.isFinite(pick(r)) ? pick(r) : 0), 0);

    const waiting = sum((r) => r.waitingCount);
    const active = sum((r) => r.activeCount);
    const ringing = sum((r) => r.ringingCount);
    const callsTotal = waiting + active + ringing;

    const agents: any[] = perQueue.flatMap((r) => r.agents);

    // Agent status field name varies across firmwares (`status`, `state`,
    // `agent_status`), so matching stays permissive.
    const isState = (a: any, ...words: string[]) => {
      const s = String(a?.status ?? a?.state ?? a?.agent_status ?? "").toLowerCase();
      return words.some((w) => s.includes(w));
    };

    const ready = agents.filter((a) =>
      isState(a, "idle", "ready", "available", "logged_in"),
    ).length;
    const busy = agents.filter((a) => isState(a, "busy", "talk", "on_call", "in_use")).length;
    const paused = agents.filter((a) => isState(a, "paus", "wrap", "away", "dnd")).length;

    return {
      ok: true as const,
      configured: true as const,
      at: new Date().toISOString(),
      calls: { waiting, active, ringing, total: callsTotal },
      agents: { ready, busy, paused, total: agents.length },
      raw: { callsCount: callsTotal, agentsCount: agents.length, queueIds },
    };
  });

// ---- Analytics debug — trace a single Call ID ------------------------------
//
// Admin-only. Fetches CDRs for a date range, finds every row matching the
// supplied Call ID / linkedid, runs classification, and reports agent
// resolution + KPI contribution. Read-only.

const analyticsDebugInput = z.object({
  from: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  to: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  callId: z.string().min(1).max(200),
});

export const yeastarAnalyticsDebug = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d) => analyticsDebugInput.parse(d))
  .handler(async ({ context, data }) => {
    await assertAdmin(context as any);
    const { isConfigured } = await import("@/lib/yeastar/client.server");
    if (!isConfigured()) return { ok: false as const, configured: false as const };

    const { fetchCdrRange } = await import("@/lib/yeastar/cdr.server");
    const cdr = await fetchCdrRange({ from: data.from, to: data.to });

    const target = data.callId.trim();
    // Verified id fields only: `call_id` (call-level), `uid` (also call-level on
    // this firmware) and `new_id` (row-level). `linkedid` / `linked_id` / `id`
    // do not exist here and were removed.
    const seed = cdr.records.filter((r) => {
      const anyR = r as any;
      return (
        String(anyR.call_id ?? "") === target ||
        String(anyR.uid ?? "") === target ||
        String(anyR.new_id ?? "") === target
      );
    });
    // A `new_id` match is a single LEG. Expand to the whole call so the trace
    // shows the routing chain the KPIs are actually derived from.
    const callIds = new Set(seed.map((r) => String((r as any).call_id ?? "")).filter(Boolean));
    const rows = callIds.size
      ? cdr.records.filter((r) => callIds.has(String((r as any).call_id ?? "")))
      : seed;

    if (rows.length === 0) {
      return {
        ok: true as const,
        configured: true as const,
        found: false as const,
        sampledFrom: cdr.records.length,
      };
    }

    // Load agents + PBX rosters, then normalize exactly as analytics does.
    const agents = await loadAgents((context as any).supabase);
    const ctx = await buildNormalizationContext(agents.map((a) => a.ext));
    const byExt = new Map(agents.map((a) => [String(a.ext).trim(), a]));

    const { normalizeCdr } = await import("@/lib/yeastar/normalize");
    const calls = normalizeCdr(rows as any[], ctx);

    // Per-leg trace: what each row is, and what the normalizer made of it.
    // There is no field-priority chain any more — the answering extension is
    // the agent leg, identified by roster membership.
    const trace = calls.map((c) => ({
      callId: c.callId,
      direction: c.direction,
      outcome: c.outcome,
      answeringExtension: c.answeringExtension ?? "Unknown",
      matchedAgent: (() => {
        const a = c.answeringExtension ? byExt.get(c.answeringExtension) : undefined;
        return a ? { id: a.id, name: a.name, team: a.team, ext: a.ext } : null;
      })(),
      queueNumber: c.queueNumber,
      queueWaitSeconds: c.queueWaitSeconds,
      agentRingSeconds: c.agentRingSeconds,
      talkSeconds: c.talkSeconds,
      legs: c.legs.map((l) => ({
        rowId: l.rowId,
        role: l.role,
        destination: l.destinationNumber,
        label: l.destinationLabel,
        disposition: l.disposition,
        ringSeconds: l.ringSeconds,
        talkSeconds: l.talkSeconds,
        durationSeconds: l.durationSeconds,
        timestamp: l.timestamp,
        note:
          l.role === "ivr" && l.answered
            ? "ANSWERED here means the auto-attendant picked up — not a handled call."
            : l.role === "queue"
              ? "ring_duration on this leg is the caller's QUEUE WAIT."
              : undefined,
      })),
    }));

    // Call-level KPI contribution, through the real aggregator.
    const { aggregateAnalytics } = await import("@/lib/yeastar/stats.server");
    const single = aggregateAnalytics(rows, ctx, agents, [], {});

    return {
      ok: true as const,
      configured: true as const,
      found: true as const,
      callId: target,
      legs: rows.length,
      calls: calls.length,
      trace,
      groupTotals: single.totals,
      queueNumbers: [...ctx.queueNumbers],
      extensionCount: ctx.extensionNumbers.size,
    };
  });
