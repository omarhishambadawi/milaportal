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
 *   POST /login  {username, password, client_name, app_version}
 *     -> {session_token, id, role, branch_code, allowed_features, username}
 *   GET  /...    X-Session-Token: <session_token>
 *
 * ## Client version handshake
 *
 * The CRM gates `/login` on the caller's declared `app_version` and answers
 * **426 Upgrade Required** to anything below its published floor — before it
 * ever looks at the credentials. A 426 is therefore a statement about the
 * *client*, never about the password, and is classified apart from
 * `auth_failed` so a compatibility break is not escalated as a credential one.
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

/**
 * The client version the Portal declares at login.
 *
 * A constant for the same reason `BASE_URL` is one: not a secret, established
 * from the shipped Desktop package (`desktop-version.json`), and matching the
 * `minimum_supported_version` the CRM publishes. It is a *protocol* field —
 * `client_name` still says truthfully that this is the Portal and not a Desktop
 * install; this only says which wire contract the Portal speaks.
 */
const CLIENT_APP_VERSION = "2026.09.10.204500";

/**
 * Where the CRM publishes the floor it enforces. Unauthenticated by design —
 * the Desktop reads it before it can log in, and so can we.
 */
const RELEASE_MANIFEST_PATH = "/api/public/desktop-release/manifest";

/** Shape-check on a version read from the manifest before it is echoed back. */
const VERSION_PATTERN = /^\d{4}(?:\.\d{1,6}){2,4}$/;

/** Short: this runs inside a login that a caller is already waiting on. */
const MANIFEST_TIMEOUT_MS = 10_000;

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
  | "auth_failed"
  /**
   * The CRM refused the client itself as out of date (HTTP 426), without
   * judging the credentials. Distinct from `auth_failed` on purpose: the two
   * have different causes, different fixes and different people to wake up.
   */
  | "incompatible_client";

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

/**
 * Whose session this is.
 *
 * The CRM derives `created_by_user_id` and `created_by_username` from the
 * authenticated session, and refuses caller-supplied attribution — so the only
 * way an order is recorded against the agent who made it is to log in as them.
 * That makes "which credential" a property of the caller rather than of the
 * deployment, and this is the type that says so.
 *
 * `service` is the deployment's own credential, used for the shared reads —
 * catalog, offers, config, branch options, diagnostics — where no `created_by`
 * is written and a per-agent login would be N logins for no attribution gain.
 */
export type CrmPrincipal =
  | { kind: "service" }
  /**
   * One agent. `agentId` is the **verified** MilaPortal user id, from
   * `requireSupabaseAuth`'s claims — never a value a browser supplied, because a
   * caller who could name the key could borrow another agent's session.
   */
  | { kind: "agent"; agentId: string; username: string; password: string };

export const SERVICE_PRINCIPAL: CrmPrincipal = { kind: "service" };

/**
 * The cache key.
 *
 * Agent keys are prefixed `agent:` and the service key is a bare word, so the
 * two namespaces cannot collide however an agent id was produced.
 */
function principalKey(principal: CrmPrincipal): string {
  return principal.kind === "service" ? "service" : `agent:${principal.agentId}`;
}

/**
 * How many agent sessions an isolate keeps.
 *
 * A Worker isolate is long-lived and serves many people, so an unbounded map is
 * a slow leak. The oldest entry is evicted when the cap is reached — losing one
 * costs a login, never correctness.
 */
const MAX_AGENT_SESSIONS = 64;

/**
 * Sessions, keyed by principal.
 *
 * This was a single module-level `session`, which is the bug this replaces: one
 * isolate serves many agents, so a shared mutable session meant agent B could
 * issue a request under agent A's identity — and with attribution derived from
 * the session, that is an order recorded against the wrong person. Keyed, no
 * caller can reach a session that is not theirs, because the key is derived
 * from verified claims and never passed in from outside.
 */
const sessions = new Map<string, SessionState>();
/** In-flight logins, per principal, so N concurrent callers cause one login. */
const inFlight = new Map<string, Promise<SessionState>>();

/** Drop the oldest agent session once the cap is exceeded. Never the service one. */
function evictIfNeeded(): void {
  for (const key of sessions.keys()) {
    if (sessions.size <= MAX_AGENT_SESSIONS) return;
    if (key === principalKey(SERVICE_PRINCIPAL)) continue;
    sessions.delete(key);
  }
}

/** Test seam. Also lets a future diagnostics surface force a cold login. */
export function _resetCrmSession(): void {
  sessions.clear();
  inFlight.clear();
  negotiatedVersion = null;
}

/** How many sessions are cached. For tests and diagnostics — never a token. */
export function _crmSessionCount(): number {
  return sessions.size;
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
 * The version accepted after a 426, once one has been. Null until then.
 *
 * Set only once a login carrying it got **past the version gate** — which is
 * not the same as succeeding. A retry that reaches "invalid credentials" has
 * proved the version is acceptable and the password is the separate problem;
 * throwing that away would make every login in a bad-credential state pay the
 * 426 and the manifest read again. A retry that is itself refused with 426
 * proves nothing and is not adopted.
 */
let negotiatedVersion: string | null = null;

/** The version the next login will declare. */
function declaredVersion(): string {
  return negotiatedVersion ?? CLIENT_APP_VERSION;
}

/** The floor the CRM currently publishes, or null if it cannot be read. */
async function readRequiredVersion(baseUrl: string): Promise<string | null> {
  try {
    const { status, body } = await request<{ minimum_supported_version?: unknown }>(
      `${baseUrl}${RELEASE_MANIFEST_PATH}`,
      { method: "GET", headers: { accept: "application/json" } },
      MANIFEST_TIMEOUT_MS,
    );
    if (status < 200 || status >= 300) return null;
    const raw =
      typeof body?.minimum_supported_version === "string"
        ? body.minimum_supported_version.trim()
        : "";
    // Shape-checked before it is sent back: this value arrives from an
    // unauthenticated endpoint, and the only thing it is allowed to be is a
    // version string.
    return VERSION_PATTERN.test(raw) ? raw : null;
  } catch {
    // The manifest is a convenience, not a dependency. A login that cannot read
    // it still reports the 426 it got.
    return null;
  }
}

/** One login attempt at a stated client version. Returns the raw outcome. */
function attemptLogin(
  env: ShamsCrmEnv,
  appVersion: string,
): Promise<{ status: number; body: RawCrmLoginResponse | null }> {
  return request<RawCrmLoginResponse>(
    `${env.baseUrl}${LOGIN_PATH}`,
    {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json" },
      body: JSON.stringify({
        username: env.username,
        password: env.password,
        client_name: "milaserv-portal",
        app_version: appVersion,
      }),
    },
    DEFAULT_TIMEOUT_MS,
  );
}

/**
 * Exchange the configured credentials for a session token.
 *
 * `client_name` mirrors what the Desktop sends — its `COMPUTERNAME` — so the
 * server sees a named client rather than an anonymous one. There is no
 * `COMPUTERNAME` in a Worker, hence the explicit portal identifier.
 *
 * A 426 costs one extra round trip: the published floor is read and the login
 * retried once at that version. That is what keeps the next time the CRM raises
 * its floor from being another outage — but the pinned constant is still tried
 * first, so the ordinary login remains a single request.
 */
async function login(env: ShamsCrmEnv): Promise<SessionState> {
  const attemptedVersion = declaredVersion();
  let outcome = await attemptLogin(env, attemptedVersion);

  if (outcome.status === 426) {
    const required = await readRequiredVersion(env.baseUrl);
    if (required && required !== attemptedVersion) {
      const retry = await attemptLogin(env, required);
      if (retry.status !== 426) negotiatedVersion = required;
      outcome = retry;
    }
  }

  const { status, body } = outcome;

  // The body may explain any of these; it is not repeated in the message.
  if (status === 426) {
    throw new ShamsCrmError(
      "incompatible_client",
      "Shams CRM refused this client as out of date.",
      status,
    );
  }
  // Only these two are the server judging the credential. Anything else it
  // returns is a fault on the call, and saying "rejected the credentials" about
  // it sends someone to rotate a password that was never the problem.
  if (status === 401 || status === 403) {
    throw new ShamsCrmError("auth_failed", "Shams CRM rejected the portal's credentials.", status);
  }
  if (status < 200 || status >= 300) {
    throw new ShamsCrmError("http_error", "Shams CRM could not complete the login.", status);
  }
  const token = body?.session_token;
  if (!token) {
    throw new ShamsCrmError("malformed", "Shams CRM returned a login without a session.", status);
  }
  return { token, expiresAt: Date.now() + SESSION_TTL_MS };
}

/** The client version currently declared at login. For diagnostics only. */
export function crmClientVersion(): string {
  return declaredVersion();
}

/**
 * A usable session token, from cache when one is fresh.
 *
 * Single-flight: concurrent callers await the same login rather than racing
 * several against each other — which for a *user* credential also avoids
 * looking like a burst of sign-ins.
 */
async function getSessionToken(
  forceRefresh = false,
  principal: CrmPrincipal = SERVICE_PRINCIPAL,
): Promise<string> {
  /*
   * Which credential this principal logs in with.
   *
   * An agent carries its own; the service principal reads the deployment's.
   * Neither is ever defaulted to the other — an agent whose credential could
   * not be loaded must fail closed, because falling back to the service account
   * would silently record the order against the wrong person, which is the one
   * outcome this whole design exists to prevent.
   */
  const env =
    principal.kind === "agent"
      ? { baseUrl: BASE_URL, username: principal.username, password: principal.password }
      : readCrmEnv();

  if (!env || !env.username || !env.password) {
    throw new ShamsCrmError(
      "not_configured",
      principal.kind === "agent"
        ? "This agent has no Shams CRM account configured."
        : "The Shams CRM connection is not configured on this deployment.",
    );
  }

  const key = principalKey(principal);
  if (forceRefresh) sessions.delete(key);

  const cached = sessions.get(key) ?? null;
  if (isFresh(cached)) return cached.token;

  const pending = inFlight.get(key);
  if (pending) return (await pending).token;

  const attempt = login(env as ShamsCrmEnv).then(
    (next) => {
      sessions.set(key, next);
      evictIfNeeded();
      return next;
    },
    (err) => {
      // Only this principal's session is discarded. A refusal for one agent is
      // not evidence about anybody else's credential.
      sessions.delete(key);
      throw err;
    },
  );
  inFlight.set(key, attempt);
  try {
    return (await attempt).token;
  } finally {
    inFlight.delete(key);
  }
}

/**
 * An authenticated GET against the CRM.
 *
 * On 401 the session is discarded, one fresh login is performed, and the request
 * is retried **once**. A second 401 raises `auth_failed` rather than looping —
 * repeatedly re-authenticating a user credential against a server that keeps
 * refusing is how an account gets locked.
 */
export async function crmFetch<T>(path: string, opts: { timeoutMs?: number } = {}): Promise<T> {
  const env = readCrmEnv();
  if (!env) {
    throw new ShamsCrmError(
      "not_configured",
      "The Shams CRM connection is not configured on this deployment.",
    );
  }
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const url = `${env.baseUrl}${path}`;

  for (let attempt = 0; attempt < 2; attempt++) {
    const token = await getSessionToken(attempt > 0);
    const { status, body } = await request<T>(
      url,
      { method: "GET", headers: { accept: "application/json", "X-Session-Token": token } },
      timeoutMs,
    );

    if (status === 401) {
      // Only the shared session. `crmFetch` serves the reads, which run on the
      // service credential; an agent's session is untouched by this.
      sessions.delete(principalKey(SERVICE_PRINCIPAL));
      if (attempt === 0) continue;
      throw new ShamsCrmError("auth_failed", "Shams CRM rejected the portal's session.", status);
    }
    // Same meaning as at login: the CRM is refusing the client, not the read.
    if (status === 426) {
      throw new ShamsCrmError(
        "incompatible_client",
        "Shams CRM refused this client as out of date.",
        status,
      );
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

/* -------------------------------------------------------------------------- */
/* Reuse points for transports that must not inherit `crmFetch`'s retry         */
/* -------------------------------------------------------------------------- */

/**
 * The session token, for a caller that must send something `crmFetch` cannot.
 *
 * `crmFetch` is GET-only and answers a 401 by re-sending. That is right for a
 * read and unsafe for a create, so `alshrouq-create.server.ts` builds its own
 * single-attempt POST — and needs the session this module already owns rather
 * than a second login flow racing this one.
 *
 * Exposes the token and nothing else. `readCrmEnv` stays private: it is the only
 * thing that ever holds the password, and that has not changed.
 */
export function getCrmSessionToken(principal: CrmPrincipal = SERVICE_PRINCIPAL): Promise<string> {
  return getSessionToken(false, principal);
}

/**
 * Discard one principal's session.
 *
 * What a caller does after its own 401: `alshrouq-create.server.ts` makes a
 * single-attempt POST and must not re-send, so it cannot use `crmFetch`'s retry
 * — but it still has to stop a dead token being handed to the next caller.
 * Scoped, so one agent's refusal never invalidates another's session.
 */
export function invalidateCrmSession(principal: CrmPrincipal = SERVICE_PRINCIPAL): void {
  sessions.delete(principalKey(principal));
}

/** The CRM origin, for the same callers. Not configurable, never a credential. */
export function crmBaseUrl(): string {
  return BASE_URL;
}
