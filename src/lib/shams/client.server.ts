/**
 * Shams Pharmacy MIS API client (server-only).
 *
 * ## Authentication
 *
 * The MIS data API is Bearer-authenticated. A machine credential pair is
 * exchanged for a short-lived access token, and that token is attached to every
 * data request:
 *
 *   POST /api/v2/auth/token   {account_identifier, api_key}
 *     -> {success, token_type: "Bearer", access_token, expires_in, expires_at,
 *         account_identifier}
 *
 *   GET  /api/v2/product/...  Authorization: Bearer <token>
 *
 * This replaces the anonymous access an earlier capture showed. That window is
 * closed: the data endpoints now answer 401 without a token. The old
 * `POST /api/v2/auth/login` still exists but is the **portal user's** login —
 * it returns a profile and UI permissions, never an API token — so it plays no
 * part in this client and no username/password is configured for it.
 *
 * The parameters below are not guesses. They are the contract the MIS portal's
 * own client implements, read from its shipped bundle: a 60 s refresh skew, the
 * `Authorization: Bearer` header on everything except the token call itself, and
 * on 401 a forced token refresh followed by exactly one retry.
 *
 * ## Token handling
 *
 * Module-scoped memory with single-flight, and nothing else. There is
 * deliberately **no Supabase L2 tier** like the Yeastar client's: that exists
 * because the PBX rate-limits token issuance hard enough to lock the
 * integration out (`errcode 60002`), a fact established from live evidence. No
 * such evidence exists here, and an L2 tier would mean a migration and a table
 * holding a live bearer token. If Shams turns out to rate-limit `/auth/token`,
 * that is the moment to add one — not before.
 *
 * ## Logging
 *
 * Requests are logged as method, path, status and duration. Never logged: the
 * API key, the account identifier, the access token, the Authorization header,
 * or any query *value* — `crm/data` takes a customer mobile number and
 * `sales/details` echoes patient identifiers.
 */

import type { RawTokenResponse, ShamsAuthStatus } from "./types";

/**
 * Per-request timeout.
 *
 * The MIS portal allows itself 120 s (180 s for dashboards). Observed latencies
 * are far below that — 0.4–2.3 s across both captures — but a server function
 * that hangs for two minutes is worse for the portal than one that fails, so
 * this sits well under the MIS's own ceiling while leaving generous headroom.
 */
const DEFAULT_TIMEOUT_MS = 30_000;
/** One retry, for transient failures only (network, timeout, 5xx). */
const MAX_ATTEMPTS = 2;
const RETRY_BASE_DELAY_MS = 300;
/**
 * Treat a token as stale this long before it actually expires.
 *
 * 60 s, matching the MIS portal's own client. It covers the round trip of a
 * request that would otherwise be issued with a token expiring mid-flight.
 */
const REFRESH_SKEW_MS = 60_000;
/** Fallback lifetime if the API ever omits `expires_in`. Observed value: 1800. */
const FALLBACK_TOKEN_TTL_SEC = 1800;

const TOKEN_PATH = "/api/v2/auth/token";

export interface ShamsEnv {
  baseUrl: string;
  accountIdentifier: string;
  apiKey: string;
}

/**
 * Server-only configuration.
 *
 * All three are required — without the credential pair the API cannot be
 * reached at all, so a partial configuration is treated as no configuration
 * rather than failing later with a 401 that looks like a Shams-side problem.
 */
export function readEnv(): ShamsEnv | null {
  const raw = process.env.SHAMS_MIS_BASE_URL?.trim();
  const accountIdentifier = process.env.SHAMS_MIS_ACCOUNT_IDENTIFIER?.trim();
  const apiKey = process.env.SHAMS_MIS_API_KEY?.trim();
  if (!raw || !accountIdentifier || !apiKey) return null;
  const trimmed = raw.replace(/\/+$/, "");
  const baseUrl = /^https?:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`;
  return { baseUrl, accountIdentifier, apiKey };
}

export function isConfigured(): boolean {
  return readEnv() !== null;
}

/* -------------------------------------------------------------------------- */
/* Errors                                                                      */
/* -------------------------------------------------------------------------- */

export type ShamsErrorKind =
  | "not_configured"
  | "timeout"
  | "unavailable"
  | "http_error"
  | "malformed"
  | "auth_failed";

/**
 * A failure safe to surface to the browser.
 *
 * `message` is written to be user-facing: it never contains a credential, a
 * token, a URL with a query string, or an upstream response body.
 */
export class ShamsError extends Error {
  readonly kind: ShamsErrorKind;
  readonly httpStatus: number | null;

  constructor(kind: ShamsErrorKind, message: string, httpStatus: number | null = null) {
    super(message);
    this.name = "ShamsError";
    this.kind = kind;
    this.httpStatus = httpStatus;
  }
}

/* -------------------------------------------------------------------------- */
/* Token cache                                                                 */
/* -------------------------------------------------------------------------- */

interface TokenState {
  accessToken: string;
  /** Epoch ms at which the token stops being valid. */
  expiresAt: number;
}

let token: TokenState | null = null;
/** In-flight token request, so N concurrent callers cause one exchange. */
let inFlight: Promise<TokenState> | null = null;

/** Test seam. Also the way a diagnostic forces a cold acquisition. */
export function _resetAuthForTests(): void {
  token = null;
  inFlight = null;
}

function isFresh(state: TokenState | null): state is TokenState {
  return state !== null && Date.now() < state.expiresAt - REFRESH_SKEW_MS;
}

/**
 * Exchange the credential pair for an access token.
 *
 * Lifetime comes from `expires_in` (a duration) rather than `expires_at` (an
 * absolute instant): a duration is immune to clock skew between this server and
 * the MIS, and the two captured values agree anyway.
 */
async function requestToken(env: ShamsEnv): Promise<TokenState> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), DEFAULT_TIMEOUT_MS);
  const startedAt = Date.now();

  try {
    const res = await fetch(`${env.baseUrl}${TOKEN_PATH}`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json" },
      body: JSON.stringify({
        account_identifier: env.accountIdentifier,
        api_key: env.apiKey,
      }),
      signal: controller.signal,
    });

    const text = await res.text().catch(() => "");
    let body: RawTokenResponse | null = null;
    try {
      body = text ? (JSON.parse(text) as RawTokenResponse) : null;
    } catch {
      throw new ShamsError("malformed", "Shams MIS returned a malformed token response.");
    }

    if (!res.ok || !body?.success || !body?.access_token) {
      // The upstream message can name the account; it is deliberately not echoed.
      console.warn(`[shams] token request rejected (HTTP ${res.status})`);
      throw new ShamsError(
        "auth_failed",
        "Shams MIS rejected the portal's API credentials.",
        res.status,
      );
    }

    const ttlSec = Number(body.expires_in);
    const lifetimeSec = Number.isFinite(ttlSec) && ttlSec > 0 ? ttlSec : FALLBACK_TOKEN_TTL_SEC;
    console.log(`[shams] token acquired in ${Date.now() - startedAt}ms; lifetime ${lifetimeSec}s`);
    return { accessToken: body.access_token, expiresAt: Date.now() + lifetimeSec * 1000 };
  } catch (err) {
    if (err instanceof ShamsError) throw err;
    const aborted = (err as Error)?.name === "AbortError";
    throw aborted
      ? new ShamsError("timeout", "Shams MIS did not respond in time.")
      : new ShamsError("unavailable", "Shams MIS is unreachable.");
  } finally {
    clearTimeout(timer);
  }
}

/**
 * A usable access token, from cache when one is fresh.
 *
 * `forceRefresh` discards the cached token first — used after a 401, where the
 * server has told us the token is not acceptable regardless of what its stated
 * expiry claims.
 *
 * Single-flight: concurrent callers await the same exchange. Without it, the
 * first page load of the Shams UI (search + branch directory) would race
 * several token requests against each other.
 */
export async function getAccessToken(forceRefresh = false): Promise<string> {
  const env = readEnv();
  if (!env) {
    throw new ShamsError(
      "not_configured",
      "Shams MIS integration is not configured on this deployment.",
    );
  }

  if (forceRefresh) token = null;
  if (isFresh(token)) return token.accessToken;
  if (inFlight) return (await inFlight).accessToken;

  inFlight = requestToken(env).then(
    (next) => {
      token = next;
      return next;
    },
    (err) => {
      token = null;
      throw err;
    },
  );

  try {
    return (await inFlight).accessToken;
  } finally {
    inFlight = null;
  }
}

/** Non-secret view of the token cache, for diagnostics. Never the token itself. */
export function tokenSnapshot(): { cached: boolean; expiresInSec: number | null } {
  if (!token) return { cached: false, expiresInSec: null };
  return {
    cached: true,
    expiresInSec: Math.max(0, Math.floor((token.expiresAt - Date.now()) / 1000)),
  };
}

/* -------------------------------------------------------------------------- */
/* Transport                                                                   */
/* -------------------------------------------------------------------------- */

function buildUrl(base: string, path: string, query: Record<string, string | number | undefined>) {
  const qs = new URLSearchParams();
  for (const [k, v] of Object.entries(query)) {
    // `undefined` means "omit"; empty string is meaningful to `sales/details`,
    // whose own frontend sends `start_date=&end_date=` to mean "unfiltered".
    if (v !== undefined) qs.set(k, String(v));
  }
  const suffix = qs.toString();
  return `${base}${path}${suffix ? `?${suffix}` : ""}`;
}

interface Attempt {
  status: number;
  json: unknown;
  parseFailed: boolean;
}

/** One authenticated GET. Throws only for transport-level failures. */
async function attempt(
  url: string,
  path: string,
  accessToken: string,
  timeoutMs: number,
  signal?: AbortSignal,
): Promise<Attempt> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const startedAt = Date.now();
  try {
    const res = await fetch(url, {
      method: "GET",
      headers: {
        Accept: "application/json",
        Authorization: `Bearer ${accessToken}`,
      },
      signal: signal ?? controller.signal,
    });
    const text = await res.text().catch(() => "");
    let json: unknown = null;
    let parseFailed = false;
    try {
      json = text ? JSON.parse(text) : null;
    } catch {
      parseFailed = true;
    }
    console.log(`[shams] GET ${path} -> ${res.status} in ${Date.now() - startedAt}ms`);
    return { status: res.status, json, parseFailed };
  } catch (err) {
    const aborted = (err as Error)?.name === "AbortError";
    throw aborted
      ? new ShamsError("timeout", "Shams MIS did not respond in time.")
      : new ShamsError("unavailable", "Shams MIS is unreachable.");
  } finally {
    clearTimeout(timer);
  }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * One authenticated GET against the MIS API.
 *
 * Handles three failure shapes distinctly, because they need different answers:
 *
 *   401           the token is not acceptable. Force a fresh one and retry
 *                 **once**. A second 401 is a credential problem, not a stale
 *                 token, and is reported as `auth_failed` rather than retried
 *                 into a loop.
 *   5xx / network transient. Retried once with a short backoff, unless the
 *                 caller opts out — see `retry` below.
 *   unparseable   raised as `malformed`, never handed on — a page rendering
 *                 `undefined` because the upstream returned an HTML error page
 *                 is strictly worse than an error the caller can catch.
 *
 * `retry` covers only the transient case. The 401 refresh is not a retry policy
 * but a correctness one — a token can expire mid-flight — so it always applies.
 */
export async function shamsFetch<T>(
  path: string,
  query: Record<string, string | number | undefined> = {},
  opts: { timeoutMs?: number; signal?: AbortSignal; retry?: boolean } = {},
): Promise<T> {
  const env = readEnv();
  if (!env) {
    throw new ShamsError(
      "not_configured",
      "Shams MIS integration is not configured on this deployment.",
    );
  }

  const url = buildUrl(env.baseUrl, path, query);
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const retryTransient = opts.retry ?? true;

  let accessToken = await getAccessToken();
  let refreshed = false;
  let transientAttempts = 0;

  for (;;) {
    let out: Attempt;
    try {
      out = await attempt(url, path, accessToken, timeoutMs, opts.signal);
    } catch (err) {
      // Transport-level failure: transient, retried once.
      if (retryTransient && err instanceof ShamsError && transientAttempts < MAX_ATTEMPTS - 1) {
        transientAttempts++;
        console.warn(`[shams] GET ${path} -> ${err.kind}; retrying once`);
        await sleep(RETRY_BASE_DELAY_MS);
        continue;
      }
      throw err;
    }

    if (out.status === 401) {
      if (refreshed) {
        console.warn(`[shams] GET ${path} -> 401 after refresh; credentials rejected`);
        throw new ShamsError(
          "auth_failed",
          "Shams MIS rejected the portal's API credentials.",
          401,
        );
      }
      console.warn(`[shams] GET ${path} -> 401; refreshing token and retrying once`);
      refreshed = true;
      accessToken = await getAccessToken(true);
      continue;
    }

    if (out.status >= 500) {
      if (retryTransient && transientAttempts < MAX_ATTEMPTS - 1) {
        transientAttempts++;
        console.warn(`[shams] GET ${path} -> HTTP ${out.status}; retrying once`);
        await sleep(RETRY_BASE_DELAY_MS);
        continue;
      }
      throw new ShamsError(
        "http_error",
        `Shams MIS returned an unexpected response (HTTP ${out.status}).`,
        out.status,
      );
    }

    if (out.status < 200 || out.status >= 300) {
      throw new ShamsError(
        "http_error",
        `Shams MIS returned an unexpected response (HTTP ${out.status}).`,
        out.status,
      );
    }

    if (out.parseFailed || out.json === null || typeof out.json !== "object") {
      throw new ShamsError("malformed", "Shams MIS returned a malformed response.");
    }

    return out.json as T;
  }
}

/* -------------------------------------------------------------------------- */
/* Diagnostics                                                                 */
/* -------------------------------------------------------------------------- */

/**
 * Verify the configured API credentials by acquiring a token.
 *
 * This is the honest health check for the integration: it exercises the exact
 * credential path every read depends on. It reports lifetime and the account
 * identifier's presence — never the identifier, the key, or the token.
 */
export async function checkAuth(): Promise<ShamsAuthStatus> {
  const env = readEnv();
  if (!env) {
    throw new ShamsError(
      "not_configured",
      "Shams MIS integration is not configured on this deployment.",
    );
  }
  // Force a real exchange so the check cannot pass on a cached token.
  await getAccessToken(true);
  const snapshot = tokenSnapshot();
  return {
    ok: true,
    tokenType: "Bearer",
    expiresInSec: snapshot.expiresInSec,
  };
}

/* -------------------------------------------------------------------------- */
/* Cache                                                                       */
/* -------------------------------------------------------------------------- */

interface CacheEntry<T> {
  value: T;
  expiresAt: number;
}

/**
 * A small module-scoped TTL cache.
 *
 * In-memory on purpose. The alternative — a Supabase-backed cache like the CDR
 * mirror — would mean a migration and a table of third-party catalog data for a
 * payload that is cheap to refetch (~0.5 s) and changes without notice. Per-
 * isolate caching is enough to stop a keystroke-per-request search from
 * hammering the MIS, which is the actual problem being solved.
 */
export class TtlCache<T> {
  private readonly store = new Map<string, CacheEntry<T>>();

  constructor(
    private readonly ttlMs: number,
    private readonly maxEntries = 200,
  ) {}

  get(key: string): T | undefined {
    const hit = this.store.get(key);
    if (!hit) return undefined;
    if (hit.expiresAt <= Date.now()) {
      this.store.delete(key);
      return undefined;
    }
    return hit.value;
  }

  set(key: string, value: T): void {
    // Bounded so a long-lived isolate cannot grow one entry per distinct query.
    if (this.store.size >= this.maxEntries) {
      const oldest = this.store.keys().next();
      if (!oldest.done) this.store.delete(oldest.value);
    }
    this.store.set(key, { value, expiresAt: Date.now() + this.ttlMs });
  }

  clear(): void {
    this.store.clear();
  }
}
