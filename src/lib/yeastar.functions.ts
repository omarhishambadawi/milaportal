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
        sample: res.records.slice(0, 8).map((r) => ({
          time: r.time,
          timestamp: r.timestamp,
          call_type: r.call_type,
          disposition: r.disposition,
          call_from_number: r.call_from_number,
          call_to_number: r.call_to_number,
          talk_duration: r.talk_duration,
          ring_duration: r.ring_duration,
          duration: r.duration,
          // ID fields for grouping diagnosis
          id: (r as any).id,
          uid: (r as any).uid,
          new_id: (r as any).new_id,
          call_id: (r as any).call_id,
          linkedid: (r as any).linkedid,
          linked_id: (r as any).linked_id,
          pin_code: (r as any).pin_code,
          agent_ring_time: (r as any).agent_ring_time,
          wait_time: (r as any).wait_time,
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
});

const CDR_CACHE_TTL_MS = 60_000;
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

// ---- Phase-1 (classification) cache ----------------------------------------
//
// The CDR *network* fetch is cached above, but classifying those rows — dedup,
// correlation grouping and the sliding-fingerprint sort — is pure over the
// record set and independent of team/agent/direction/status/orders. The Call
// Center page issues one analytics request per filter permutation over the same
// window, so without this every filter toggle re-ran the whole classification.
//
// Keyed by the same `from|to` window and identity-checked against the exact
// records array returned by the CDR cache: when the CDR entry expires and
// refetches, it yields a NEW array, the identity check misses, and we
// reclassify. Same size bound as the CDR cache; entries only hold references to
// the already-cached CdrRecord objects, not copies.
type ClassifiedRecordsT = import("@/lib/yeastar/stats.server").ClassifiedRecords;
const classifiedCache = new Map<string, { records: unknown[]; value: ClassifiedRecordsT }>();

function getClassifiedCached(
  from: string,
  to: string,
  records: any[],
  classifyRecords: (r: any[]) => ClassifiedRecordsT,
): ClassifiedRecordsT {
  const key = `${from}|${to}`;
  const hit = classifiedCache.get(key);
  if (hit && hit.records === records) return hit.value;
  const value = classifyRecords(records);
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

const ROSTER_TTL_MS = 60_000;
let rosterCache: {
  at: number;
  ccExts: Map<string, string>;
  queueNumbers: Set<string>;
} | null = null;

async function fetchQueueData(): Promise<{
  ccExts: Map<string, string>;
  queueNumbers: Set<string>;
}> {
  const now = Date.now();
  if (rosterCache && now - rosterCache.at < ROSTER_TTL_MS) {
    return { ccExts: rosterCache.ccExts, queueNumbers: rosterCache.queueNumbers };
  }
  const ccExts = new Map<string, string>();
  const queueNumbers = new Set<string>();
  try {
    const { isConfigured, yeastarFetch } = await import("@/lib/yeastar/client.server");
    if (!isConfigured()) return { ccExts, queueNumbers };
    const { httpStatus, json } = await yeastarFetch<any>("/openapi/v1.0/queue/list", {
      page: 1,
      page_size: 100,
    });
    if (httpStatus !== 200 || json?.errcode !== 0) return { ccExts, queueNumbers };
    const queues = Array.isArray(json.queue_list) ? json.queue_list : [];
    for (const q of queues) {
      const qnum = String(q?.number ?? "").trim();
      if (qnum) queueNumbers.add(qnum);
      if (qnum === CUSTOMER_CARE_QUEUE_NUMBER) {
        const members = [
          ...(Array.isArray(q.static_agent_list) ? q.static_agent_list : []),
          ...(Array.isArray(q.dynamic_agent_list) ? q.dynamic_agent_list : []),
        ];
        for (const m of members) {
          const ext = String(m?.text2 ?? "").trim();
          const name = String(m?.text ?? "").trim();
          if (ext) ccExts.set(ext, name || ext);
        }
      }
    }
    rosterCache = { at: now, ccExts, queueNumbers };
  } catch {
    // Swallow — caller falls back to DB customer_care mapping.
  }
  return { ccExts, queueNumbers };
}

async function fetchCustomerCareQueueRoster(): Promise<Map<string, string>> {
  return (await fetchQueueData()).ccExts;
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

    let agents = await loadAgents(supabase);

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

      // [C2] Do NOT pre-filter raw rows by direction/status here — that would
      // strip ANSWERED legs and misclassify grouped queue calls. Filters are
      // applied inside aggregateAnalytics AFTER grouping + classification.
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
      // Pass PBX queue numbers so agentExtFor never mistakes a queue for an
      // agent (root cause of the Inbound=0 bug on queue-inbound calls).
      const { queueNumbers } = await fetchQueueData();
      // Phase 1 is cached per window (see getClassifiedCached); phase 2 applies
      // the request's direction/status/scope filters. Identical result to the
      // former single aggregateAnalytics call — only the redundant re-grouping
      // across filter permutations is eliminated.
      const classified = getClassifiedCached(data.from, data.to, records, classifyRecords);
      const result = aggregateClassified(classified, agents, orders, {
        direction: data.direction,
        status: data.status,
        queueNumbers,
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

    const safeFetch = async (
      path: string,
      query: Record<string, string | number | undefined> = {},
    ) => {
      try {
        const { httpStatus, json } = await yeastarFetch<any>(path, query, { timeoutMs: 8_000 });
        if (httpStatus !== 200 || json?.errcode !== 0) return null;
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

    const perQueue = await Promise.all(
      queueIds.map(async (queue_id) => {
        const [cs, as] = await Promise.all([
          safeFetch("/openapi/v1.0/queue/call_status", { queue_id }),
          safeFetch("/openapi/v1.0/queue/agent_status", { queue_id }),
        ]);
        const cList: any[] = Array.isArray(cs?.data)
          ? cs.data
          : Array.isArray(cs?.queue_call_status_list)
            ? cs.queue_call_status_list
            : [];
        const aList: any[] = Array.isArray(as?.data)
          ? as.data
          : Array.isArray(as?.queue_agent_status_list)
            ? as.queue_agent_status_list
            : [];
        return { cList, aList };
      }),
    );

    const calls: any[] = perQueue.flatMap((r) => r.cList);
    const agents: any[] = perQueue.flatMap((r) => r.aList);

    // Widget counters — string-comparison is permissive because the field
    // name varies across firmwares (`status`, `state`, `agent_status`, etc.).
    const isState = (a: any, ...words: string[]) => {
      const s = String(a?.status ?? a?.state ?? a?.agent_status ?? "").toLowerCase();
      return words.some((w) => s.includes(w));
    };

    const waiting = calls.filter((c) => {
      const s = String(c?.status ?? c?.state ?? "").toLowerCase();
      return s.includes("wait") || s.includes("queue");
    }).length;
    const active = calls.filter((c) => {
      const s = String(c?.status ?? c?.state ?? "").toLowerCase();
      return (
        s.includes("talk") || s.includes("connect") || s.includes("busy") || s.includes("bridged")
      );
    }).length;
    const ringing = calls.filter((c) => {
      const s = String(c?.status ?? c?.state ?? "").toLowerCase();
      return s.includes("ring");
    }).length;

    const ready = agents.filter((a) =>
      isState(a, "idle", "ready", "available", "logged_in"),
    ).length;
    const busy = agents.filter((a) => isState(a, "busy", "talk", "on_call", "in_use")).length;
    const paused = agents.filter((a) => isState(a, "paus", "wrap", "away", "dnd")).length;

    return {
      ok: true as const,
      configured: true as const,
      at: new Date().toISOString(),
      calls: { waiting, active, ringing, total: calls.length },
      agents: { ready, busy, paused, total: agents.length },
      raw: { callsCount: calls.length, agentsCount: agents.length, queueIds },
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
    const rows = cdr.records.filter((r) => {
      const anyR = r as any;
      return (
        String(anyR.call_id ?? "") === target ||
        String(anyR.linkedid ?? "") === target ||
        String(anyR.linked_id ?? "") === target ||
        String(anyR.uid ?? "") === target ||
        String(anyR.new_id ?? "") === target ||
        String(anyR.id ?? "") === target
      );
    });

    if (rows.length === 0) {
      return {
        ok: true as const,
        configured: true as const,
        found: false as const,
        sampledFrom: cdr.records.length,
      };
    }

    // Load agents + queue numbers for resolution context.
    const [agents, { queueNumbers }] = await Promise.all([
      loadAgents((context as any).supabase),
      fetchQueueData(),
    ]);
    const byExt = new Map(agents.map((a) => [String(a.ext).trim(), a]));

    // Resolve agent per row using the same rules as the aggregator.
    const isQueue = (v: any) => v != null && queueNumbers.has(String(v).trim());
    const resolveExt = (r: any): { ext: string | null; reason: string } => {
      if (r.call_type === "Outbound") {
        const s = r.call_from_number ? String(r.call_from_number).trim() : "";
        return isQueue(s)
          ? { ext: null, reason: "call_from_number is a queue" }
          : { ext: s || null, reason: "outbound: call_from_number" };
      }
      if (r.call_type === "Inbound") {
        const priority: Array<[string, any]> = [
          ["last_participant_number", r.last_participant_number],
          ["last_participant", r.last_participant],
          ["final_participant", r.final_participant],
          ["answer_by", r.answer_by],
          ["answered_by", r.answered_by],
          ["agent_number", r.agent_number],
          ["dst", r.dst],
          ["dst_num", r.dst_num],
          ["dst_number", r.dst_number],
          ["call_to_number", r.call_to_number],
        ];
        for (const [k, v] of priority) {
          if (v == null) continue;
          const s = String(v).trim();
          if (!s) continue;
          if (isQueue(s)) continue;
          return { ext: s, reason: `inbound: ${k}` };
        }
        return { ext: null, reason: "inbound: no non-queue candidate" };
      }
      return { ext: null, reason: "internal ignored" };
    };

    const trace = rows.map((r) => {
      const { ext, reason } = resolveExt(r);
      const agent = ext ? byExt.get(ext) : undefined;
      return {
        raw: {
          time: r.time,
          timestamp: r.timestamp,
          call_type: r.call_type,
          disposition: r.disposition,
          call_from_number: r.call_from_number,
          call_to_number: r.call_to_number,
          dst: (r as any).dst,
          last_participant_number: (r as any).last_participant_number,
          talk_duration: r.talk_duration,
          ring_duration: r.ring_duration,
          wait_time: (r as any).wait_time,
        },
        resolvedExt: ext,
        resolutionReason: reason,
        matchedAgent: agent
          ? { id: agent.id, name: agent.name, team: agent.team, ext: agent.ext }
          : null,
        contribution: agent
          ? {
              total: 1,
              inbound: r.call_type === "Inbound" ? 1 : 0,
              outbound: r.call_type === "Outbound" ? 1 : 0,
              answered: r.disposition === "ANSWERED" ? 1 : 0,
            }
          : { note: "Unknown agent — counted only in platform totals (never zero-ed)." },
      };
    });

    // Group-level classification for the call.
    const { aggregateAnalytics } = await import("@/lib/yeastar/stats.server");
    const single = aggregateAnalytics(rows, agents, [], { queueNumbers });

    return {
      ok: true as const,
      configured: true as const,
      found: true as const,
      callId: target,
      legs: rows.length,
      trace,
      groupTotals: single.totals,
      queueNumbers: [...queueNumbers],
    };
  });
