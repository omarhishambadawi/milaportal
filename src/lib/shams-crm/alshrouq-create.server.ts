/**
 * The AlShrouq create transport, and the read that reconciles it. Server-only.
 *
 * **Nothing in this repository calls `createAlshrouqOrder` yet.** It is built,
 * tested against a mocked transport, and left disconnected. Wiring it to an
 * order is a separate phase.
 *
 * ## Why this does not use `crmFetch`
 *
 * `crmFetch` answers a 401 by discarding the session, logging in again and
 * **re-sending the request**. For a read that is correct and is what makes a
 * 30-minute session TTL workable. For a create it is a second driver at a
 * customer's door: a 401 arriving on the *response* leg — an expired session, a
 * token invalidated mid-flight — is indistinguishable from one arriving before
 * the CRM processed anything, and the retry cannot tell those apart.
 *
 * So the create has its own transport with one rule: **one logical create is one
 * POST attempt, and there is no path through this file that sends a second.**
 * `crmFetch` is untouched and still owns every read, including the
 * reconciliation below.
 *
 * ## The invariant worth remembering
 *
 *   * If `createAlshrouqOrder` **throws**, nothing was transmitted.
 *   * If it **returns**, exactly one POST was attempted, whatever the outcome.
 *
 * Everything that can fail before transmission — no credentials, a failed login
 * — throws. Everything after the request leaves the machine is a result.
 *
 * ## Why `indeterminate` exists
 *
 * Only a **4xx** counts as a refusal, because only a 4xx tells us the CRM
 * understood the request and declined it. Everything else that is not a clean
 * 2xx — 5xx, 401, timeout, network failure, an unreadable body — is ambiguous
 * about whether a courier was dispatched, and is reported as such.
 *
 * Server-side deduplication is **unknown**. The Desktop client sends
 * `X-Client-Operation-Id` on this endpoint (confirmed: the path is the sixth
 * member of its `tracked_prefixes` tuple, and `_begin_tracked_operation`
 * generates a uuid4 for it), so the header is sent here too — but whether
 * `shams-crm.cloud` honours a repeat has never been observed. Until it has, a
 * timeout must never be answered with another POST. It is answered by
 * `findAlshrouqOrderByClientOrderId`, which is a GET.
 */

import {
  crmBaseUrl,
  crmFetch,
  getCrmSessionToken,
  isCrmConfigured,
  ShamsCrmError,
} from "./client.server";
import type { AlShrouqCreatePayload } from "./alshrouq-payload";

/** Confirmed from the Desktop client. The same path serves the history GET. */
const ORDERS_PATH = "/integrations/alshrouq/orders";

/**
 * Generous on purpose, and a judgement rather than a measurement.
 *
 * The CRM is brokering a call to the courier, so this is slower than a read, and
 * the 60 s a read gets is likely short. Cutting a create off early does not make
 * it safe — it converts a probably-successful delivery into an `indeterminate`
 * that a human has to reconcile. The expensive outcome is ambiguity, so this
 * errs long. No captured evidence fixes this number.
 */
const CREATE_TIMEOUT_MS = 120_000;

/** JSON as it comes back. The create response shape has never been captured. */
export type JsonValue = string | number | boolean | null | JsonValue[] | { [k: string]: JsonValue };

export type AlShrouqCreateResult =
  /** The CRM returned 2xx. The delivery exists. Never send this payload again. */
  | { kind: "accepted"; operationId: string; status: number; body: JsonValue | null }
  /**
   * A **4xx**: the CRM understood the request and declined it. Nothing was
   * created. 5xx is deliberately not here — see `indeterminate`.
   */
  | { kind: "rejected"; operationId: string; status: number; body: JsonValue | null }
  /**
   * The request left the machine and the outcome is unknown. **Not a failure.**
   * Covers timeout, network failure, an unreadable 2xx, 401, and **any 5xx**.
   * The only safe next step is `findAlshrouqOrderByClientOrderId`.
   */
  | { kind: "indeterminate"; operationId: string; errorKind: string; message: string };

/** A uuid4 for one logical create. There are no retries, so there is no reuse. */
export function newAlshrouqOperationId(): string {
  return crypto.randomUUID();
}

/**
 * Keys never worth carrying out of a response we cannot schema-check.
 *
 * The create response is unknown, so it is sanitized by *name* rather than by
 * shape: anything that looks like a credential is dropped outright, and the
 * customer and driver identity fields the CRM is known to hold are dropped
 * because a diagnostic does not need a person's phone number.
 */
const REDACTED_KEY = /token|password|secret|authorization|session|api[_-]?key/i;
const PII_KEY =
  /^(customer_name|customer_phone|customer_address|driver_name|driver_phone|driver_lat|driver_lng)$/i;

const MAX_DEPTH = 6;
const MAX_ARRAY = 25;
const MAX_STRING = 500;

/**
 * A response body reduced to something safe to log.
 *
 * Deliberately structural rather than typed: inventing an
 * `AlshrouqCreateResponse` interface would be this repository asserting a schema
 * it has never seen, which is how the previous attempt shipped a create that was
 * rejected on every call. Whatever the CRM sends is preserved in shape, minus
 * credentials and identities, capped so a diagnostic cannot become a data dump.
 */
export function sanitizeResponseBody(value: unknown, depth = 0): JsonValue | null {
  if (value === null || value === undefined) return null;
  if (typeof value === "boolean") return value;
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (typeof value === "string") {
    return value.length > MAX_STRING ? `${value.slice(0, MAX_STRING)}…[truncated]` : value;
  }
  if (depth >= MAX_DEPTH) return "[depth-limited]";
  if (Array.isArray(value)) {
    const out = value.slice(0, MAX_ARRAY).map((v) => sanitizeResponseBody(v, depth + 1));
    if (value.length > MAX_ARRAY) out.push(`[${value.length - MAX_ARRAY} more]`);
    return out as JsonValue[];
  }
  if (typeof value === "object") {
    const out: { [k: string]: JsonValue } = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      if (REDACTED_KEY.test(k) || PII_KEY.test(k)) {
        out[k] = "[redacted]";
        continue;
      }
      out[k] = sanitizeResponseBody(v, depth + 1) as JsonValue;
    }
    return out;
  }
  return null;
}

async function readBody(res: Response): Promise<{ ok: boolean; body: JsonValue | null }> {
  try {
    const text = await res.text();
    if (text.trim().length === 0) return { ok: true, body: null };
    return { ok: true, body: sanitizeResponseBody(JSON.parse(text)) };
  } catch {
    return { ok: false, body: null };
  }
}

/**
 * Send one AlShrouq create. Once.
 *
 * Authentication happens **before** transmission, so a login failure throws and
 * nothing is sent. After `fetch` is called there is no branch that calls it
 * again: every outcome is classified and returned.
 *
 * `payload` is not mutated and not logged.
 */
export async function createAlshrouqOrder(
  payload: AlShrouqCreatePayload,
  operationId: string,
): Promise<AlShrouqCreateResult> {
  if (!isCrmConfigured()) {
    throw new ShamsCrmError(
      "not_configured",
      "The Shams CRM connection is not configured on this deployment.",
    );
  }

  // Pre-transmission. A failure here throws, which is the caller's signal that
  // no delivery can possibly exist.
  const token = await getCrmSessionToken();

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), CREATE_TIMEOUT_MS);

  let res: Response;
  try {
    // The one and only POST.
    res = await fetch(`${crmBaseUrl()}${ORDERS_PATH}`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "application/json",
        "X-Session-Token": token,
        // Confirmed as what the Desktop sends on this endpoint. Whether the
        // server dedupes on it is unknown, so nothing here depends on it.
        "X-Client-Operation-Id": operationId,
      },
      body: JSON.stringify(payload),
      signal: controller.signal,
    });
  } catch (err) {
    // The request left the machine, or may have. Either way: no second attempt.
    const aborted = err instanceof Error && err.name === "AbortError";
    return {
      kind: "indeterminate",
      operationId,
      errorKind: aborted ? "timeout" : "network",
      message: aborted
        ? "The CRM did not respond in time. Whether the delivery was created is unknown."
        : "The connection to the CRM failed. Whether the delivery was created is unknown.",
    };
  } finally {
    clearTimeout(timer);
  }

  const status = res.status;
  const { ok: readable, body } = await readBody(res);

  /**
   * 401 is *not* treated as a refusal.
   *
   * By the time it arrives the request has already been transmitted, and an
   * expired session on the response leg looks exactly like one rejected before
   * processing. `crmFetch` would re-login and re-send here; that is the single
   * most dangerous thing this transport could do, so it reports ambiguity and
   * lets a GET settle it.
   */
  if (status === 401) {
    return {
      kind: "indeterminate",
      operationId,
      errorKind: "auth_failed",
      message:
        "The CRM rejected the session on a request that had already been sent. " +
        "Whether the delivery was created is unknown.",
    };
  }

  if (status >= 200 && status < 300) {
    // A 2xx we cannot read is still an outcome we cannot correlate, so it is
    // reconciled rather than assumed.
    if (!readable) {
      return {
        kind: "indeterminate",
        operationId,
        errorKind: "malformed",
        message: "The CRM accepted the request but its response could not be read.",
      };
    }
    return { kind: "accepted", operationId, status, body };
  }

  /**
   * 5xx is *not* treated as a refusal either.
   *
   * A 4xx is the CRM saying "I understood this and I will not do it" — a
   * validation failure, an uncovered branch — and nothing was created. A 5xx
   * says nothing of the kind. The CRM brokers this call onward to AlShrouq, so
   * a 500, a 502 from a proxy, or a 504 on the response leg is equally
   * consistent with the delivery having been created and the acknowledgement
   * having been lost on the way back.
   *
   * We have no evidence that a 5xx means the courier was not dispatched, and
   * "no evidence either way" is exactly what `indeterminate` is for. Calling it
   * `rejected` would invite a caller to treat it as safe to send again, which
   * is the one mistake that puts a second driver at a customer's door.
   */
  if (status >= 500) {
    return {
      kind: "indeterminate",
      operationId,
      errorKind: "server_error",
      message:
        `The CRM returned ${status}. Whether the delivery was created is unknown — ` +
        "a server error can arrive after the order was accepted.",
    };
  }

  // An explicit refusal: a 4xx, where the CRM understood the request and
  // declined it. The status is the signal, so an unreadable body is reported as
  // a rejection with no body rather than as ambiguity.
  return { kind: "rejected", operationId, status, body };
}

/* -------------------------------------------------------------------------- */
/* Reconciliation — GET only                                                   */
/* -------------------------------------------------------------------------- */

/**
 * The CRM's stored representation, as confirmed from 127 real records.
 *
 * Unlike the create response this shape *is* evidence, which is why it may be
 * typed. Identity fields are deliberately not carried out of this module:
 * reconciliation answers "does this order exist, and what is it called", not
 * "who ordered it".
 */
export interface AlShrouqReconciledOrder {
  /** The CRM's own row id — what `/refresh` and `/cancel` take. */
  id: number | null;
  /** AlShrouq's number — the reference quoted when chasing a delivery. */
  externalOrderId: number | null;
  clientOrderId: string;
  branchId: string | null;
  paymentType: number | null;
  orderValue: number | null;
  preparationTime: number | null;
  /** Ambiguous on its own: id 23 is both "Order Created" and "Order cancelled". */
  statusId: string | null;
  statusLabel: string | null;
  /** The discriminator `status_id` cannot provide. */
  isCancelled: boolean;
  trackingUrl: string | null;
  createdAt: string | null;
  updatedAt: string | null;
}

interface RawRecord {
  [k: string]: unknown;
}

function str(v: unknown): string | null {
  return typeof v === "string" && v.length > 0 ? v : null;
}
function num(v: unknown): number | null {
  return typeof v === "number" && Number.isFinite(v) ? v : null;
}

function toReconciled(raw: RawRecord): AlShrouqReconciledOrder {
  return {
    id: num(raw.id),
    externalOrderId: num(raw.external_order_id),
    clientOrderId: String(raw.client_order_id ?? ""),
    branchId: str(raw.branch_id),
    paymentType: num(raw.payment_type),
    orderValue: num(raw.order_value),
    preparationTime: num(raw.preparation_time),
    statusId: str(raw.status_id),
    statusLabel: str(raw.status_label),
    isCancelled: raw.is_cancelled === true,
    trackingUrl: str(raw.tracking_url),
    createdAt: str(raw.created_at),
    updatedAt: str(raw.updated_at),
  };
}

function isoDate(d: Date): string {
  return d.toISOString().slice(0, 10);
}

/**
 * Did this order reach the CRM? A read, and only ever a read.
 *
 * This is what an `indeterminate` create is answered with. It goes through
 * `crmFetch`, whose 401-retry is safe precisely because a GET can be repeated.
 *
 * The window defaults to yesterday-through-tomorrow rather than today: the CRM
 * timestamps in its own zone, and a create near midnight would otherwise fall
 * outside a single-day window and be reported missing — which, for a caller
 * deciding whether a delivery already exists, is the one wrong answer that
 * causes a second driver.
 *
 * Returns `null` when no record matches. `null` means "not found", never "not
 * created" — the caller stays in doubt rather than resolving it by sending
 * another POST.
 */
export async function findAlshrouqOrderByClientOrderId(
  clientOrderId: string,
  opts: { fromDate?: string; toDate?: string; now?: Date } = {},
): Promise<AlShrouqReconciledOrder | null> {
  const wanted = clientOrderId.trim();
  if (wanted.length === 0) return null;

  const now = opts.now ?? new Date();
  const from = opts.fromDate ?? isoDate(new Date(now.getTime() - 24 * 60 * 60 * 1000));
  const to = opts.toDate ?? isoDate(new Date(now.getTime() + 24 * 60 * 60 * 1000));

  const query = new URLSearchParams({
    from_date: from,
    to_date: to,
    include_raw_data: "false",
  });

  const rows = await crmFetch<unknown>(`${ORDERS_PATH}?${query.toString()}`);
  if (!Array.isArray(rows)) return null;

  const hit = (rows as RawRecord[]).find(
    (r) => r && typeof r === "object" && String(r.client_order_id ?? "") === wanted,
  );
  return hit ? toReconciled(hit) : null;
}
