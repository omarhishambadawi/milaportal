/**
 * The Shams CRM synchronisation service. Server-only.
 *
 * Four calls, and nothing else in this codebase talks to these endpoints:
 *
 *   POST /stock/sync              triggerStockSync()
 *   GET  /stock/sync/status       getStockSyncStatus()
 *   POST /promotions/sync         triggerPromotionsSync()
 *   GET  /promotions/sync/status  getPromotionsSyncStatus()
 *
 * ## What this module is not
 *
 * It is not the sync. Phase 1 established that the synchronisation runs entirely
 * inside `shams-crm.cloud`, in a background worker of its own — the Desktop
 * client contains no pagination, no branch loop and no upstream record handling,
 * and neither does this. Everything here queues work on somebody else's machine
 * and then asks how it went.
 *
 * ## Authentication is borrowed whole
 *
 * `client.server.ts` already owns login, the session cache, single-flight and
 * the 401 policy for this host, on the `SHAMS_CRM_USERNAME` /
 * `SHAMS_CRM_PASSWORD` pair. None of that is repeated here: the reads go through
 * `crmFetch`, and the one thing it cannot do — a POST — takes the session token
 * from `getCrmSessionToken` rather than logging in a second time.
 *
 * The service principal is correct for both. These endpoints act on the whole
 * chain rather than on one agent's behalf, and the CRM derives no `created_by`
 * from them.
 *
 * ## Why the trigger does not reuse `crmFetch`
 *
 * `crmFetch` answers a 401 by logging in again and **re-sending the request**.
 * On a read that is right. On a trigger it is the single most dangerous thing
 * this integration could do: a 401 on the response leg of a POST that the server
 * already accepted is indistinguishable from one refused before processing, so
 * re-sending would queue a second sync run against a concurrency contract that
 * has never been verified.
 *
 * So the trigger is a single attempt that reports ambiguity instead of resolving
 * it, exactly as `alshrouq-create.server.ts` does for the same reason. A GET
 * settles what actually happened, and the scheduler is what performs it.
 */

import {
  ShamsCrmError,
  crmBaseUrl,
  getCrmSessionToken,
  invalidateCrmSession,
  isCrmConfigured,
} from "./client.server";
import {
  normalizeSyncStatus,
  readTriggerRunId,
  type RawShamsSyncStatus,
  type RawShamsSyncTrigger,
  type ShamsSyncKind,
  type ShamsSyncStatus,
} from "./sync-status";

/** The paths, in one place, keyed by the kind everything else is keyed by. */
const PATHS: Record<ShamsSyncKind, { trigger: string; status: string }> = {
  stock: { trigger: "/stock/sync", status: "/stock/sync/status" },
  promotions: { trigger: "/promotions/sync", status: "/promotions/sync/status" },
};

/**
 * Read timeout.
 *
 * A status read is a small document and should be quick. Kept well under the
 * client's 60 s default so a hung CRM cannot hold a scheduled tick open.
 */
const STATUS_TIMEOUT_MS = 20_000;

/**
 * Trigger timeout.
 *
 * The trigger returns as soon as the run is queued — the Desktop's own copy is
 * "started in background", and the observed round trip is fast. This bounds the
 * window in which the outcome is unknown; it is not related to how long a sync
 * takes, because nothing waits for that.
 */
const TRIGGER_TIMEOUT_MS = 30_000;

export function isSyncConfigured(): boolean {
  return isCrmConfigured();
}

/* -------------------------------------------------------------------------- */
/* Reads                                                                       */
/* -------------------------------------------------------------------------- */

/**
 * Current status for one kind.
 *
 * `now` is injectable so the timestamp assessment in `sync-status.ts` can be
 * tested through this seam as well as directly.
 */
export async function getSyncStatus(
  kind: ShamsSyncKind,
  now: number = Date.now(),
): Promise<ShamsSyncStatus> {
  const raw = await crmFetchStatus(kind);
  return normalizeSyncStatus(raw, now);
}

async function crmFetchStatus(kind: ShamsSyncKind): Promise<RawShamsSyncStatus> {
  const { crmFetch } = await import("./client.server");
  return crmFetch<RawShamsSyncStatus>(PATHS[kind].status, { timeoutMs: STATUS_TIMEOUT_MS });
}

/** Named wrappers, so callers read as the brief describes them. */
export const getStockSyncStatus = (now?: number) => getSyncStatus("stock", now);
export const getPromotionsSyncStatus = (now?: number) => getSyncStatus("promotions", now);

/* -------------------------------------------------------------------------- */
/* Triggers                                                                    */
/* -------------------------------------------------------------------------- */

/**
 * The outcome of asking the CRM to start a run.
 *
 * Three kinds, and the third is the one that matters. `indeterminate` means the
 * request may or may not have started a run, and the caller must **not** treat
 * it as either — it reconciles by reading status, and never by trying again.
 */
export type ShamsSyncTriggerResult =
  | { kind: "triggered"; runId: string }
  /** The CRM answered, and its answer was not a run. Safe: nothing started. */
  | { kind: "rejected"; errorKind: string; httpStatus: number | null; message: string }
  /** Sent, outcome unknown. Never retried. */
  | { kind: "indeterminate"; errorKind: string; message: string };

/**
 * Ask the CRM to start a run. One attempt, no retry, ever.
 *
 * A 2xx without a `run_id` is deliberately **not** success. The run may well
 * have started, but a run we cannot name is one we cannot reconcile or report
 * on, so it is indeterminate — which stops the scheduler rather than letting it
 * record a run it cannot follow.
 */
export async function triggerSync(kind: ShamsSyncKind): Promise<ShamsSyncTriggerResult> {
  if (!isCrmConfigured()) {
    return {
      kind: "rejected",
      errorKind: "not_configured",
      httpStatus: null,
      message: "The Shams CRM connection is not configured on this deployment.",
    };
  }

  /*
   * Pre-transmission. A failure here means nothing left the machine, so it is a
   * clean refusal rather than an ambiguity.
   */
  let token: string;
  try {
    token = await getCrmSessionToken();
  } catch (err) {
    const kindOf = err instanceof ShamsCrmError ? err.kind : "unavailable";
    return {
      kind: "rejected",
      errorKind: kindOf,
      httpStatus: err instanceof ShamsCrmError ? err.httpStatus : null,
      message: "Could not authenticate with Shams CRM. Nothing was started.",
    };
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TRIGGER_TIMEOUT_MS);

  let res: Response;
  try {
    // The one and only POST.
    res = await fetch(`${crmBaseUrl()}${PATHS[kind].trigger}`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "application/json",
        "X-Session-Token": token,
      },
      /*
       * An empty object, not a filtered request.
       *
       * The CRM's run notes echo parameters it understands — `itm_cd`, `wh_cd`,
       * `max_pages`, `branch_code` — which is suggestive but was never verified,
       * and a scheduled full refresh is exactly what the operator triggers by
       * hand today. Sending nothing reproduces that precisely. Narrowing a
       * nightly sync on an unverified parameter would risk a partial refresh
       * that still reports success.
       */
      body: "{}",
      signal: controller.signal,
    });
  } catch (err) {
    // It left the machine, or may have. No second attempt.
    const aborted = err instanceof Error && err.name === "AbortError";
    return {
      kind: "indeterminate",
      errorKind: aborted ? "timeout" : "network",
      message: aborted
        ? "Shams CRM did not respond in time. Whether a run started is unknown."
        : "The connection to Shams CRM failed. Whether a run started is unknown.",
    };
  } finally {
    clearTimeout(timer);
  }

  /*
   * 401 after transmission is ambiguous, not a refusal — by the time it arrives
   * the request has already been delivered. The session is dropped so the next
   * caller gets a fresh one, but this request is not re-sent.
   */
  if (res.status === 401) {
    invalidateCrmSession();
    return {
      kind: "indeterminate",
      errorKind: "auth_failed",
      message:
        "Shams CRM rejected the session on a request that had already been sent. " +
        "Whether a run started is unknown.",
    };
  }

  if (res.status < 200 || res.status >= 300) {
    /*
     * A non-2xx is the CRM declining, which is safe — and is also the shape a
     * refusal would take if the server does reject an overlapping run. The
     * status code is kept; the body is not, because it is a third-party string
     * that would end up on an admin page.
     */
    return {
      kind: "rejected",
      errorKind: "http_error",
      httpStatus: res.status,
      message: `Shams CRM declined to start the run (HTTP ${res.status}).`,
    };
  }

  const body = await readJson<RawShamsSyncTrigger>(res);
  const runId = readTriggerRunId(body);
  if (!runId) {
    return {
      kind: "indeterminate",
      errorKind: "missing_run_id",
      message:
        "Shams CRM accepted the request but did not return a run id, so the run cannot be followed.",
    };
  }

  return { kind: "triggered", runId };
}

export const triggerStockSync = () => triggerSync("stock");
export const triggerPromotionsSync = () => triggerSync("promotions");

/** Parse a response body, or null. A malformed body is never thrown over. */
async function readJson<T>(res: Response): Promise<T | null> {
  try {
    const text = await res.text();
    return text ? (JSON.parse(text) as T) : null;
  } catch {
    return null;
  }
}
