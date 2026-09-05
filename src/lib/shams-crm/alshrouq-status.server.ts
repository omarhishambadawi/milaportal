/**
 * "Where is this delivery?" — one read of the CRM's AlShrouq record. Server-only.
 *
 * Until now MilaPortal could send a delivery and never hear back. `POST
 * /integrations/alshrouq/orders` creates it; the reconciliation GET in
 * `alshrouq-create.server.ts` answers only "does a record exist"; and everything
 * after that — a stuck dispatch, a customer asking where the driver is — was
 * settled by a person telephoning the courier and typing the answer into
 * `alshrouq-resolve.server.ts`.
 *
 * This closes that loop with the endpoint the Desktop client uses:
 *
 *   GET /integrations/alshrouq/orders/{id}/refresh
 *
 * ## It is a GET, and that is the whole safety argument
 *
 * `alshrouq-create.server.ts` refuses `crmFetch` because its 401 handling
 * re-sends the request, and a re-sent POST is a second driver at a customer's
 * door. None of that applies here: a read may be repeated any number of times
 * without consequence, which is exactly why `findAlshrouqOrderByClientOrderId`
 * uses `crmFetch` too. So this reuses the shared client, the shared session and
 * the shared error taxonomy, and introduces no transport of its own.
 *
 * Nothing in this module writes — not to the CRM, and not to Supabase. The
 * result is a snapshot handed to the caller and nowhere else.
 *
 * ## Why the driver's details are returned but never stored
 *
 * `driverName`, `driverPhone` and the coordinates are what make this useful on a
 * live call: the agent can say who is coming and where they are. They are also
 * a third party's identity and location, which is why `sanitizeResponseBody`
 * lists exactly these keys as PII and drops them from anything that reaches a
 * log. They are returned to the caller for display and are deliberately not
 * persisted — `alshrouq_dispatches` has no column for any of them, and this
 * phase adds none.
 */

import { crmFetch, ShamsCrmError } from "./client.server";
import { safeTrackingUrl } from "@/features/alshrouq/dispatch-timeline";

const ORDERS_PATH = "/integrations/alshrouq/orders";

/**
 * Read timeout.
 *
 * The CRM asks AlShrouq for a live position, so this is slower than a database
 * read and faster than the create's two minutes. It is bounded well under the
 * client's default so an agent waiting mid-call is told something rather than
 * left watching a spinner; the button is the retry.
 */
const STATUS_TIMEOUT_MS = 20_000;

/**
 * The CRM's own row id, as the endpoint takes it.
 *
 * Every observed `id` is an integer (127 records in the Desktop's cache), and
 * the value MilaPortal holds in `alshrouq_dispatches.local_id` is that id
 * stringified. Validating the shape here means a malformed row can never be
 * interpolated into a path — the id is checked before it is used, not escaped
 * after.
 */
const CRM_ID = /^\d{1,18}$/;

export function isAlShrouqCrmOrderId(value: string | null | undefined): boolean {
  return typeof value === "string" && CRM_ID.test(value.trim());
}

/* -------------------------------------------------------------------------- */
/* The shape the Portal consumes                                               */
/* -------------------------------------------------------------------------- */

/**
 * A delivery's live position, reduced to what an agent can act on.
 *
 * Seven fields, and deliberately no more. The CRM record carries the customer's
 * name, phone and address as well, and a status check has no business
 * re-shipping those to a browser that already has them from the order.
 *
 * Every field is nullable: the endpoint returns the same record shape whether a
 * driver has been assigned or not, so "no driver yet" arrives as nulls rather
 * than as a different response.
 */
export interface AlShrouqOrderStatus {
  /** The courier's own label, e.g. `Order delivered`. The headline. */
  statusLabel: string | null;
  /** The latest tracking event, which may be ahead of `statusLabel`. */
  lastTrackingStatus: string | null;
  /** Absolute `http(s)` only — see `safeTrackingUrl`. */
  trackingUrl: string | null;
  driverName: string | null;
  driverPhone: string | null;
  driverLat: number | null;
  driverLng: number | null;
}

export type AlShrouqStatusResult =
  | { kind: "ok"; status: AlShrouqOrderStatus }
  /** No Shams CRM credentials on this deployment. */
  | { kind: "not_configured" }
  /** The CRM has no such order. Distinct from a transport failure. */
  | { kind: "not_found" }
  /** The CRM refused the session — 401/403. An administrator's problem. */
  | { kind: "forbidden" }
  /** Timeout or network failure. Temporary; the caller may simply ask again. */
  | { kind: "unavailable" }
  /** Anything else, including a response that could not be read. */
  | { kind: "failed" };

/* -------------------------------------------------------------------------- */
/* Normalization                                                               */
/* -------------------------------------------------------------------------- */

function str(v: unknown): string | null {
  return typeof v === "string" && v.trim().length > 0 ? v.trim() : null;
}

/**
 * A coordinate, or nothing.
 *
 * Rejects the out-of-range values a "no position yet" record can carry — a `0,0`
 * pair is the Gulf of Guinea, not a driver in Jeddah — because a map pin in the
 * wrong hemisphere reads as information rather than as absence.
 */
function coord(v: unknown, limit: number): number | null {
  if (typeof v !== "number" || !Number.isFinite(v)) return null;
  if (v === 0) return null;
  return Math.abs(v) <= limit ? v : null;
}

/**
 * The record, reduced.
 *
 * Reads by key off whatever came back rather than asserting a schema: the shape
 * is evidenced by the Desktop's cached responses, but this is a third party and
 * a missing key must degrade to `null` rather than throw mid-call.
 */
export function normalizeAlShrouqStatus(raw: unknown): AlShrouqOrderStatus {
  const r = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  return {
    statusLabel: str(r.status_label),
    lastTrackingStatus: str(r.last_tracking_status),
    trackingUrl: safeTrackingUrl(str(r.tracking_url)),
    driverName: str(r.driver_name),
    driverPhone: str(r.driver_phone),
    driverLat: coord(r.driver_lat, 90),
    driverLng: coord(r.driver_lng, 180),
  };
}

/* -------------------------------------------------------------------------- */
/* The read                                                                    */
/* -------------------------------------------------------------------------- */

/**
 * Ask the CRM where one delivery is.
 *
 * Never throws: every failure is a `kind` the caller can render, because this
 * runs behind a button an agent presses during a call and a stack trace is not
 * an answer. A 404 is reported as its own outcome rather than as an error — an
 * order the CRM cannot find is a fact about the order, not a fault.
 */
export async function refreshAlShrouqOrderStatus(
  crmOrderId: string,
): Promise<AlShrouqStatusResult> {
  const id = String(crmOrderId ?? "").trim();
  // Checked before anything is sent: an id this function cannot vouch for is
  // never interpolated into a request path.
  if (!isAlShrouqCrmOrderId(id)) return { kind: "not_found" };

  try {
    const body = await crmFetch<unknown>(`${ORDERS_PATH}/${encodeURIComponent(id)}/refresh`, {
      timeoutMs: STATUS_TIMEOUT_MS,
    });
    return { kind: "ok", status: normalizeAlShrouqStatus(body) };
  } catch (err) {
    if (err instanceof ShamsCrmError) {
      if (err.httpStatus === 404) return { kind: "not_found" };
      // 403 arrives as `http_error`; 401 becomes `auth_failed` after the
      // client's one re-login. Both are the same thing to an operator.
      if (err.httpStatus === 401 || err.httpStatus === 403 || err.kind === "auth_failed") {
        return { kind: "forbidden" };
      }
      if (err.kind === "not_configured") return { kind: "not_configured" };
      if (err.kind === "timeout" || err.kind === "unavailable") return { kind: "unavailable" };
      return { kind: "failed" };
    }
    console.warn("[alshrouq] status refresh failed:", (err as Error)?.name ?? "unknown");
    return { kind: "failed" };
  }
}
