/**
 * Shams CRM client (server-only).
 *
 * The backend PharmacyCRM Desktop uses — `https://shams-crm.cloud` — which is a
 * different system from the MIS in `src/lib/shams`:
 *
 *   MIS   mis.shamspharmacy.com  machine credential  Authorization: Bearer
 *   CRM   shams-crm.cloud        user credential     X-Session-Token
 *
 * Deliberately **not** built on `shamsFetch`. Sharing that transport would mean
 * one function reasoning about two hosts, two credential kinds and two auth
 * headers, and a 401 on one meaning something different from a 401 on the other.
 * The only thing borrowed is the shape of the code, so both read alike.
 *
 * ## Authentication
 *
 *   POST /login  {username, password, client_name}
 *     -> {session_token, id, role, branch_code, allowed_features, username}
 *   GET  /...    X-Session-Token: <session_token>
 *
 * This is a **user** login, not a machine account — the same credential a person
 * types into the Desktop — used here as an authorized temporary measure until
 * Shams issues a service credential. Every request the Portal makes is therefore
 * attributed to that person. See §10.1.
 *
 * ## Session lifetime
 *
 * The login response carries **no expiry**, so none is assumed. Two things stand
 * in for one:
 *
 *   1. A conservative soft TTL — *our* bound, not a claim about the server —
 *      after which the next call re-logs in rather than discovering staleness
 *      through a failure.
 *   2. On 401: discard the session, log in once, retry the request once. A second
 *      401 raises. There is no loop.
 *
 * ## Logging
 *
 * There is none. Not the username, not the password, not the token, not the
 * `X-Session-Token` header, not a response body. The one thing a caller learns
 * about a failure is a `kind`.
 */

import type { RawCrmLoginResponse } from "./types";

/**
 * The CRM origin, from the Desktop's own `desktop-client.json` → `api_base`.
 *
 * A constant rather than a third environment variable: it is not a secret, it is
 * established from the shipped package, and the brief asked for exactly two.
 */
const BASE_URL = "https://shams-crm.cloud";

const LOGIN_PATH = "/login";

/** Per-request timeout. The catalog read is the slow one; 60 s covers it. */
const DEFAULT_TIMEOUT_MS = 60_000;

/**
 * How long a session is reused before a fresh login.
 *
 * Thirty minutes is a guess about *our* tolerance, not about the server's
 * policy, which is unknown. It exists so a long-lived isolate does not hold one
 * token indefinitely; correctness comes from the 401 path, not from this number.
 */
const SESSION_TTL_MS = 30 * 60_000;

interface ShamsCrmEnv {
  baseUrl: string;
  username: string;
  password: string;
}

/**
 * Server-only configuration.
 *
 * Both are required together; a partial configuration is treated as none, so a
 * missing password surfaces as "not configured" rather than as a login failure
 * that looks like Shams rejecting us.
 *
 * Deliberately un-prefixed — a `VITE_` copy would be inlined into the browser
 * bundle, which for a password is not a mistake anyone gets to make twice.
 *
 * **Module-private on purpose.** It is the only thing that ever holds the
 * password, so it is not exported; callers outside this file get
 * `isCrmConfigured()`, which answers the only question they have.
 */
function readCrmEnv(): ShamsCrmEnv | null {
  const username = process.env.SHAMS_CRM_USERNAME?.trim();
  const password = process.env.SHAMS_CRM_PASSWORD?.trim();
  if (!username || !password) return null;
  return { baseUrl: BASE_URL, username, password };
}

export function isCrmConfigured(): boolean {
  return readCrmEnv() !== null;
}

export type ShamsCrmErrorKind =
  | "not_configured"
  | "timeout"
  | "unavailable"
  | "http_error"
  | "malformed"
  | "auth_failed";

/** A failure safe to surface. Never carries a credential, token, or body. */
export class ShamsCrmError extends Error {
  readonly kind: ShamsCrmErrorKind;
  readonly httpStatus: number | null;

  constructor(kind: ShamsCrmErrorKind, message: string, httpStatus: number | null = null) {
    super(message);
    this.name = "ShamsCrmError";
    this.kind = kind;
    this.httpStatus = httpStatus;
  }
}

interface SessionState {
  token: string;
  /** Epoch ms after which the token is re-acquired. Our bound, not the server's. */
  expiresAt: number;
}

let session: SessionState | null = null;
/** In-flight login, so N concurrent callers cause one login. */
let inFlight: Promise<SessionState> | null = null;

/** Test seam. Also lets a future diagnostics surface force a cold login. */
export function _resetCrmSession(): void {
  session = null;
  inFlight = null;
}

function isFresh(state: SessionState | null): state is SessionState {
  return state !== null && state.expiresAt > Date.now();
}

/** One HTTP call. Returns the parsed body; never returns headers. */
async function request<T>(
  url: string,
  init: RequestInit,
  timeoutMs: number,
): Promise<{ status: number; body: T | null }> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, { ...init, signal: controller.signal });
    const text = await res.text().catch(() => "");
    let body: T | null = null;
    try {
      body = text ? (JSON.parse(text) as T) : null;
    } catch {
      body = null;
    }
    return { status: res.status, body };
  } catch (err) {
    if (err instanceof Error && err.name === "AbortError") {
      throw new ShamsCrmError("timeout", "Shams CRM took too long to respond.");
    }
    throw new ShamsCrmError("unavailable", "Unable to reach Shams CRM.");
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Exchange the configured credentials for a session token.
 *
 * `client_name` mirrors what the Desktop sends — its `COMPUTERNAME` — so the
 * server sees a named client rather than an anonymous one. There is no
 * `COMPUTERNAME` in a Worker, hence the explicit portal identifier.
 */
async function login(env: ShamsCrmEnv): Promise<SessionState> {
  const { status, body } = await request<RawCrmLoginResponse>(
    `${env.baseUrl}${LOGIN_PATH}`,
    {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json" },
      body: JSON.stringify({
        username: env.username,
        password: env.password,
        client_name: "milaserv-portal",
      }),
    },
    DEFAULT_TIMEOUT_MS,
  );

  const token = body?.session_token;
  if (status < 200 || status >= 300 || !token) {
    // The body may explain why; it is not repeated here.
    throw new ShamsCrmError("auth_failed", "Shams CRM rejected the portal's credentials.", status);
  }
  return { token, expiresAt: Date.now() + SESSION_TTL_MS };
}

/**
 * A usable session token, from cache when one is fresh.
 *
 * Single-flight: concurrent callers await the same login rather than racing
 * several against each other — which for a *user* credential also avoids
 * looking like a burst of sign-ins.
 */
async function getSessionToken(forceRefresh = false): Promise<string> {
  const env = readCrmEnv();
  if (!env) {
    throw new ShamsCrmError(
      "not_configured",
      "The Shams CRM connection is not configured on this deployment.",
    );
  }

  if (forceRefresh) session = null;
  if (isFresh(session)) return session.token;
  if (inFlight) return (await inFlight).token;

  inFlight = login(env).then(
    (next) => {
      session = next;
      return next;
    },
    (err) => {
      session = null;
      throw err;
    },
  );
  try {
    return (await inFlight).token;
  } finally {
    inFlight = null;
  }
}

/**
 * An authenticated call against the CRM.
 *
 * On 401 the session is discarded, one fresh login is performed, and the request
 * is retried **once**. A second 401 raises `auth_failed` rather than looping —
 * repeatedly re-authenticating a user credential against a server that keeps
 * refusing is how an account gets locked.
 *
 * ## Why a write may be retried at all
 *
 * The retry happens only on 401, which the CRM answers *before* doing anything:
 * a rejected session never reached the courier, so re-sending it cannot create a
 * second delivery. Every other failure — timeout included — is raised, because a
 * timed-out `POST` may well have been accepted and only the answer was lost. The
 * duplicate protection for that case is the caller's `client_order_id`, not a
 * decision taken here.
 */
async function crmCall<T>(
  path: string,
  opts: { method?: "GET" | "POST"; body?: unknown; timeoutMs?: number } = {},
): Promise<T> {
  const env = readCrmEnv();
  if (!env) {
    throw new ShamsCrmError(
      "not_configured",
      "The Shams CRM connection is not configured on this deployment.",
    );
  }
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const method = opts.method ?? "GET";
  const url = `${env.baseUrl}${path}`;

  for (let attempt = 0; attempt < 2; attempt++) {
    const token = await getSessionToken(attempt > 0);
    const headers: Record<string, string> = {
      accept: "application/json",
      "X-Session-Token": token,
    };
    if (opts.body !== undefined) headers["content-type"] = "application/json";
    const { status, body } = await request<T>(
      url,
      {
        method,
        headers,
        ...(opts.body !== undefined ? { body: JSON.stringify(opts.body) } : {}),
      },
      timeoutMs,
    );

    if (status === 401) {
      session = null;
      if (attempt === 0) continue;
      throw new ShamsCrmError("auth_failed", "Shams CRM rejected the portal's session.", status);
    }
    if (status < 200 || status >= 300) {
      throw new ShamsCrmError("http_error", "Shams CRM returned an unexpected status.", status);
    }
    if (body === null) {
      throw new ShamsCrmError("malformed", "Shams CRM returned an unreadable response.", status);
    }
    return body;
  }

  // Unreachable: the loop either returns or throws.
  throw new ShamsCrmError("auth_failed", "Shams CRM rejected the portal's session.");
}

/** An authenticated GET against the CRM. */
export async function crmFetch<T>(path: string, opts: { timeoutMs?: number } = {}): Promise<T> {
  return crmCall<T>(path, { method: "GET", timeoutMs: opts.timeoutMs });
}

/**
 * An authenticated POST against the CRM.
 *
 * Exists for the AlShrouq integration, which is the first thing the Portal does
 * on this host that is not a read. `body` is optional because two of its three
 * write endpoints — cancel, and the refresh the Desktop issues as a GET — take
 * none.
 */
export async function crmSend<T>(
  path: string,
  opts: { body?: unknown; timeoutMs?: number } = {},
): Promise<T> {
  return crmCall<T>(path, { method: "POST", body: opts.body ?? {}, timeoutMs: opts.timeoutMs });
}

