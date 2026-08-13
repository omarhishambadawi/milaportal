/**
 * Shams Pharmacy MIS API client (server-only).
 *
 * ## The finding that shapes this file
 *
 * **The MIS data API performs no authentication.** This is not an assumption
 * about an undocumented scheme — it is what the capture shows, across all 21
 * requests:
 *
 *   - `POST /api/v2/auth/login` returns `{success, user, permissions,
 *     needsPasswordReset}`. There is **no token, no session id, no expiry**, and
 *     the response carries **no `Set-Cookie`**.
 *   - Every subsequent request — products, stock, sales, CRM, dashboards —
 *     sends **no `Authorization` header, no `Cookie`, and no session parameter**.
 *     The union of request headers across the whole capture is `Accept`,
 *     `Content-Type`, `DNT`, `Referer`, `User-Agent`, `sec-ch-ua*`.
 *   - Responses carry `Access-Control-Allow-Origin: *`.
 *
 * So there is deliberately **no token cache here** — no L1/L2 tiers, no refresh,
 * no single-flight. Yeastar needs all of that because its PBX issues and
 * rate-limits real tokens; copying that machinery here would be ceremony around
 * a credential the server never sends. This client is a thin, timing-out,
 * retrying GET.
 *
 * `login()` exists to verify a credential still works (and to give the
 * discovered endpoint a home), **not** to authorize data calls — nothing here
 * calls it before fetching, because doing so would gate nothing.
 *
 * If Shams later puts the API behind real auth, `authHeaders()` is the single
 * seam to fill in; no caller changes.
 *
 * ## Logging
 *
 * Requests are logged as method, path, status and duration. Query *values* are
 * never logged: `crm/data` takes a customer mobile number and `sales/details`
 * echoes patient identifiers, so a logged query string is a PII leak.
 */

import type { RawLoginResponse, ShamsCredentialCheck } from "./types";

/** Generous next to the ~2.2 s worst case observed, tight enough to fail fast. */
const DEFAULT_TIMEOUT_MS = 15_000;
/** One retry, for transient failures only (network, timeout, 5xx). */
const MAX_ATTEMPTS = 2;
const RETRY_BASE_DELAY_MS = 300;

export interface ShamsEnv {
  baseUrl: string;
}

/**
 * Base URL only.
 *
 * Credentials are read separately and on demand by `login()`, so that the data
 * path — which needs none — cannot accidentally come to depend on them being set.
 */
export function readEnv(): ShamsEnv | null {
  const raw = process.env.SHAMS_MIS_BASE_URL?.trim();
  if (!raw) return null;
  const trimmed = raw.replace(/\/+$/, "");
  const baseUrl = /^https?:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`;
  return { baseUrl };
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
 * `message` is written to be user-facing: it never contains a credential, a URL
 * with a query string, or an upstream response body.
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
/* Transport                                                                   */
/* -------------------------------------------------------------------------- */

/**
 * The seam for a future authentication scheme.
 *
 * Empty today because the API accepts — and ignores — everything. Kept so that
 * adding auth is a one-function change rather than a sweep of every call site.
 */
function authHeaders(): Record<string, string> {
  return {};
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

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

/**
 * One GET against the MIS API, with a timeout and a single transient retry.
 *
 * Returns the parsed body. Anything that is not parseable JSON, or that is JSON
 * but not an object, raises `malformed` rather than being handed on — a portal
 * page rendering `undefined` because an upstream returned an HTML error page is
 * strictly worse than an error the caller can catch.
 */
export async function shamsFetch<T>(
  path: string,
  query: Record<string, string | number | undefined> = {},
  opts: { timeoutMs?: number; signal?: AbortSignal } = {},
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
  let lastError: ShamsError | null = null;

  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    const startedAt = Date.now();

    try {
      const res = await fetch(url, {
        method: "GET",
        headers: { Accept: "application/json", ...authHeaders() },
        signal: opts.signal ?? controller.signal,
      });
      const elapsed = Date.now() - startedAt;

      if (!res.ok) {
        // 5xx is worth another attempt; 4xx is a statement about the request.
        const transient = res.status >= 500;
        console.warn(`[shams] GET ${path} -> HTTP ${res.status} in ${elapsed}ms`);
        lastError = new ShamsError(
          "http_error",
          `Shams MIS returned an unexpected response (HTTP ${res.status}).`,
          res.status,
        );
        if (transient && attempt < MAX_ATTEMPTS) {
          await sleep(RETRY_BASE_DELAY_MS * attempt);
          continue;
        }
        throw lastError;
      }

      const text = await res.text();
      let parsed: unknown;
      try {
        parsed = text ? JSON.parse(text) : null;
      } catch {
        console.warn(`[shams] GET ${path} -> unparseable body (${text.length} bytes)`);
        throw new ShamsError("malformed", "Shams MIS returned a malformed response.");
      }
      if (parsed === null || typeof parsed !== "object") {
        throw new ShamsError("malformed", "Shams MIS returned a malformed response.");
      }

      console.log(`[shams] GET ${path} -> 200 in ${elapsed}ms`);
      return parsed as T;
    } catch (err) {
      clearTimeout(timer);

      if (err instanceof ShamsError) throw err;

      const aborted = (err as Error)?.name === "AbortError";
      lastError = aborted
        ? new ShamsError("timeout", "Shams MIS did not respond in time.")
        : new ShamsError("unavailable", "Shams MIS is unreachable.");
      console.warn(`[shams] GET ${path} -> ${lastError.kind} (attempt ${attempt}/${MAX_ATTEMPTS})`);

      if (attempt < MAX_ATTEMPTS) {
        await sleep(RETRY_BASE_DELAY_MS * attempt);
        continue;
      }
      throw lastError;
    } finally {
      clearTimeout(timer);
    }
  }

  throw lastError ?? new ShamsError("unavailable", "Shams MIS is unreachable.");
}

/* -------------------------------------------------------------------------- */
/* Credential verification                                                     */
/* -------------------------------------------------------------------------- */

/**
 * Verify the configured MIS credentials against `POST /api/v2/auth/login`.
 *
 * This is a diagnostic. It authorizes nothing, and no data path calls it — see
 * the note at the top of this file. The credentials are read here and nowhere
 * else, and neither they nor the returned profile are logged.
 */
export async function login(): Promise<ShamsCredentialCheck> {
  const env = readEnv();
  if (!env) {
    throw new ShamsError(
      "not_configured",
      "Shams MIS integration is not configured on this deployment.",
    );
  }

  const username = process.env.SHAMS_MIS_USERNAME?.trim();
  const password = process.env.SHAMS_MIS_PASSWORD;
  if (!username || !password) {
    throw new ShamsError("not_configured", "Shams MIS credentials are not configured.");
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), DEFAULT_TIMEOUT_MS);
  try {
    const res = await fetch(`${env.baseUrl}/api/v2/auth/login`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json" },
      body: JSON.stringify({ username, password }),
      signal: controller.signal,
    });
    const text = await res.text().catch(() => "");
    let body: RawLoginResponse | null = null;
    try {
      body = text ? (JSON.parse(text) as RawLoginResponse) : null;
    } catch {
      throw new ShamsError("malformed", "Shams MIS returned a malformed login response.");
    }

    if (!res.ok || !body?.success) {
      // Deliberately does not echo the upstream message, which can name the
      // account that failed.
      console.warn(`[shams] credential check failed (HTTP ${res.status})`);
      throw new ShamsError("auth_failed", "Shams MIS rejected the configured credentials.");
    }

    console.log("[shams] credential check OK");
    return {
      ok: true,
      username: body.user?.username ?? null,
      needsPasswordReset: body.needsPasswordReset === true,
    };
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
