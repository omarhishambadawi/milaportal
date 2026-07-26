/**
 * Yeastar P-Series OpenAPI client (server-only).
 *
 * Two-tier cache:
 *   L1: module-scoped memory (per-isolate)
 *   L2: public.yeastar_token_cache (shared across isolates / cold starts)
 *
 * The PBX rate-limits /get_token aggressively (errcode 60002 = MAX LIMITATION
 * EXCEEDED). Without L2, every cold start / new isolate would hit that limit.
 * On 60002 we persist a `blocked_until` window so no isolate retries until it
 * expires.
 */

const TOKEN_PATH = "/openapi/v1.0/get_token";
const REFRESH_PATH = "/openapi/v1.0/refresh_token";
const REFRESH_SKEW_MS = 60_000;
const UA = "OpenAPI";
const BLOCK_MS = 5 * 60_000; // 5 minutes after a 60002

export interface YeastarEnv {
  baseUrl: string;
  clientId: string;
  clientSecret: string;
}
export interface TokenState {
  accessToken: string;
  refreshToken: string;
  accessExpiresAt: number;
  refreshExpiresAt: number;
  obtainedAt: number;
}

export function readEnv(): YeastarEnv | null {
  const raw = process.env.YEASTAR_BASE_URL?.trim();
  const clientId = process.env.YEASTAR_CLIENT_ID?.trim();
  const clientSecret = process.env.YEASTAR_CLIENT_SECRET?.trim();
  if (!raw || !clientId || !clientSecret) return null;
  const trimmed = raw.replace(/\/+$/, "");
  const baseUrl = /^https?:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`;
  return { baseUrl, clientId, clientSecret };
}
export function isConfigured(): boolean {
  return readEnv() !== null;
}

// ---- L1 cache ---------------------------------------------------------------
let token: TokenState | null = null;
let inFlight: Promise<TokenState> | null = null;
export function _resetForTests() {
  token = null;
  inFlight = null;
}

// ---- L2 cache (Supabase) ----------------------------------------------------
interface L2Row {
  access_token: string | null;
  refresh_token: string | null;
  access_expires_at: string | null;
  refresh_expires_at: string | null;
  obtained_at: string | null;
  blocked_until: string | null;
  block_reason: string | null;
}

async function loadL2(): Promise<L2Row | null> {
  try {
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
    const { data, error } = await supabaseAdmin
      .from("yeastar_token_cache")
      .select(
        "access_token, refresh_token, access_expires_at, refresh_expires_at, obtained_at, blocked_until, block_reason",
      )
      .eq("id", 1)
      .maybeSingle();
    if (error) {
      console.warn("[yeastar] L2 load failed:", error.message);
      return null;
    }
    return (data as L2Row) ?? null;
  } catch (e) {
    console.warn("[yeastar] L2 load exception:", (e as Error).message);
    return null;
  }
}

async function saveL2Token(state: TokenState) {
  try {
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
    await supabaseAdmin.from("yeastar_token_cache").upsert(
      {
        id: 1,
        access_token: state.accessToken,
        refresh_token: state.refreshToken,
        access_expires_at: new Date(state.accessExpiresAt).toISOString(),
        refresh_expires_at: new Date(state.refreshExpiresAt).toISOString(),
        obtained_at: new Date(state.obtainedAt).toISOString(),
        blocked_until: null,
        block_reason: null,
        updated_at: new Date().toISOString(),
      },
      { onConflict: "id" },
    );
  } catch (e) {
    console.warn("[yeastar] L2 save failed:", (e as Error).message);
  }
}

async function saveL2Block(reason: string, ms = BLOCK_MS) {
  try {
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
    await supabaseAdmin.from("yeastar_token_cache").upsert(
      {
        id: 1,
        blocked_until: new Date(Date.now() + ms).toISOString(),
        block_reason: reason,
        updated_at: new Date().toISOString(),
      },
      { onConflict: "id" },
    );
    console.warn(`[yeastar] L2 block persisted for ${Math.round(ms / 1000)}s: ${reason}`);
  } catch (e) {
    console.warn("[yeastar] L2 block save failed:", (e as Error).message);
  }
}

function l2ToState(row: L2Row): TokenState | null {
  if (
    !row.access_token ||
    !row.access_expires_at ||
    !row.refresh_token ||
    !row.refresh_expires_at ||
    !row.obtained_at
  )
    return null;
  return {
    accessToken: row.access_token,
    refreshToken: row.refresh_token,
    accessExpiresAt: new Date(row.access_expires_at).getTime(),
    refreshExpiresAt: new Date(row.refresh_expires_at).getTime(),
    obtainedAt: new Date(row.obtained_at).getTime(),
  };
}

// ---- low-level HTTP ---------------------------------------------------------
interface JsonResponse<T = any> {
  httpStatus: number;
  body: string;
  json: T | null;
}
async function postJson<T = any>(
  url: string,
  payload: unknown,
  signal?: AbortSignal,
): Promise<JsonResponse<T>> {
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/json", "User-Agent": UA },
    body: JSON.stringify(payload),
    signal,
  });
  const body = await res.text().catch(() => "");
  let json: T | null = null;
  try {
    json = body ? (JSON.parse(body) as T) : null;
  } catch {
    /* non-JSON */
  }
  return { httpStatus: res.status, body, json };
}

// ---- auth flows -------------------------------------------------------------
async function requestNewToken(env: YeastarEnv): Promise<TokenState> {
  const url = `${env.baseUrl}${TOKEN_PATH}`;
  console.log("[yeastar] POST /get_token");
  const { httpStatus, body, json } = await postJson<any>(url, {
    username: env.clientId,
    password: env.clientSecret,
  });
  if (httpStatus !== 200 || !json || json.errcode !== 0 || !json.access_token) {
    if (json?.errcode === 60002) {
      await saveL2Block(`60002 ${json?.errmsg ?? "MAX LIMITATION EXCEEDED"}`, BLOCK_MS);
    }
    throw new YeastarAuthError(
      `get_token failed: HTTP ${httpStatus} errcode=${json?.errcode ?? "n/a"} errmsg=${json?.errmsg ?? "n/a"}`,
      {
        httpStatus,
        errcode: json?.errcode ?? null,
        errmsg: json?.errmsg ?? null,
        bodyPreview: body.slice(0, 300),
      },
    );
  }
  const now = Date.now();
  const state: TokenState = {
    accessToken: json.access_token,
    refreshToken: json.refresh_token,
    accessExpiresAt: now + Number(json.access_token_expire_time ?? 1800) * 1000,
    refreshExpiresAt: now + Number(json.refresh_token_expire_time ?? 86400) * 1000,
    obtainedAt: now,
  };
  console.log(
    `[yeastar] get_token OK; access lifetime=${Math.round((state.accessExpiresAt - now) / 1000)}s`,
  );
  await saveL2Token(state);
  return state;
}

async function refreshToken(env: YeastarEnv, current: TokenState): Promise<TokenState> {
  const url = `${env.baseUrl}${REFRESH_PATH}`;
  console.log("[yeastar] POST /refresh_token");
  const { httpStatus, json } = await postJson<any>(url, { refresh_token: current.refreshToken });
  if (httpStatus !== 200 || !json || json.errcode !== 0 || !json.access_token) {
    console.warn(
      `[yeastar] refresh failed (HTTP ${httpStatus} errcode=${json?.errcode ?? "n/a"}); falling back to /get_token`,
    );
    return requestNewToken(env);
  }
  const now = Date.now();
  const state: TokenState = {
    accessToken: json.access_token,
    refreshToken: json.refresh_token ?? current.refreshToken,
    accessExpiresAt: now + Number(json.access_token_expire_time ?? 1800) * 1000,
    refreshExpiresAt: now + Number(json.refresh_token_expire_time ?? 86400) * 1000,
    obtainedAt: now,
  };
  await saveL2Token(state);
  return state;
}

export class YeastarAuthError extends Error {
  details: {
    httpStatus: number;
    errcode: number | null;
    errmsg: string | null;
    bodyPreview: string;
  };
  constructor(msg: string, details: YeastarAuthError["details"]) {
    super(msg);
    this.name = "YeastarAuthError";
    this.details = details;
  }
}

// ---- public: getAccessToken -------------------------------------------------
export interface AuthResult {
  token: TokenState;
  source: "cache" | "l2" | "refresh" | "new";
}

function isFresh(t: TokenState): boolean {
  return t.accessExpiresAt - Date.now() > REFRESH_SKEW_MS;
}

export async function getAccessToken(): Promise<AuthResult> {
  const env = readEnv();
  if (!env) throw new Error("Yeastar not configured (missing env vars)");

  // 1. L1 cache
  if (token && isFresh(token)) return { token, source: "cache" };

  // 2. single-flight across the isolate
  if (inFlight) return { token: await inFlight, source: "cache" };

  inFlight = (async () => {
    // 3. L2 cache (shared)
    const row = await loadL2();
    if (row) {
      if (row.blocked_until && new Date(row.blocked_until).getTime() > Date.now()) {
        const remainingSec = Math.round(
          (new Date(row.blocked_until).getTime() - Date.now()) / 1000,
        );
        throw new YeastarAuthError(
          `PBX auth temporarily blocked (${row.block_reason ?? "rate-limited"}); retry in ${remainingSec}s`,
          { httpStatus: 0, errcode: 60002, errmsg: row.block_reason, bodyPreview: "" },
        );
      }
      const l2 = l2ToState(row);
      if (l2 && isFresh(l2)) {
        token = l2;
        return l2;
      }

      // 4. try refresh with L2 refresh_token
      if (l2 && l2.refreshExpiresAt - Date.now() > 5_000) {
        try {
          const next = await refreshToken(env, l2);
          token = next;
          return next;
        } catch {
          /* fall through */
        }
      }
    }

    // 5. brand-new token
    const next = await requestNewToken(env);
    token = next;
    return next;
  })().finally(() => {
    inFlight = null;
  });

  const next = await inFlight;
  return { token: next, source: "new" };
}

// ---- public: yeastarFetch ---------------------------------------------------
export async function yeastarFetch<T = any>(
  path: string,
  query: Record<string, string | number | undefined> = {},
  opts: {
    signal?: AbortSignal;
    timeoutMs?: number;
    method?: "GET" | "POST";
    body?: Record<string, unknown>;
  } = {},
): Promise<{ httpStatus: number; json: T | null; body: string }> {
  const env = readEnv();
  if (!env) throw new Error("Yeastar not configured");

  const method = opts.method ?? "GET";

  const buildUrl = (accessToken: string) => {
    const qs = new URLSearchParams();
    for (const [k, v] of Object.entries(query))
      if (v !== undefined && v !== "") qs.set(k, String(v));
    qs.set("access_token", accessToken);
    return `${env.baseUrl}${path}?${qs.toString()}`;
  };

  const doOnce = async (): Promise<{
    httpStatus: number;
    json: T | null;
    body: string;
    retryAuth: boolean;
  }> => {
    const { token: t } = await getAccessToken();
    const timeout = opts.timeoutMs ?? 25_000;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeout);
    const signal = opts.signal ?? controller.signal;
    try {
      const init: RequestInit = {
        method,
        headers: {
          Accept: "application/json",
          "User-Agent": UA,
          ...(method === "POST" ? { "Content-Type": "application/json" } : {}),
        },
        signal,
      };
      if (method === "POST") init.body = JSON.stringify(opts.body ?? {});
      const res = await fetch(buildUrl(t.accessToken), init);
      const body = await res.text().catch(() => "");
      let json: T | null = null;
      try {
        json = body ? (JSON.parse(body) as T) : null;
      } catch {
        /* non-JSON */
      }
      const errcode = (json as any)?.errcode;
      const retryAuth = res.status === 401 || errcode === 10003 || errcode === 10004;
      return { httpStatus: res.status, json, body, retryAuth };
    } finally {
      clearTimeout(timer);
    }
  };

  let out = await doOnce();
  if (out.retryAuth) {
    console.warn("[yeastar] auth-expired signal received; invalidating cache and retrying once");
    token = null;
    out = await doOnce();
  }
  return { httpStatus: out.httpStatus, json: out.json, body: out.body };
}

export function tokenSnapshot() {
  if (!token) return null;
  return {
    obtainedAt: new Date(token.obtainedAt).toISOString(),
    accessExpiresAt: new Date(token.accessExpiresAt).toISOString(),
    refreshExpiresAt: new Date(token.refreshExpiresAt).toISOString(),
    remainingAccessSec: Math.max(0, Math.floor((token.accessExpiresAt - Date.now()) / 1000)),
    remainingRefreshSec: Math.max(0, Math.floor((token.refreshExpiresAt - Date.now()) / 1000)),
  };
}
