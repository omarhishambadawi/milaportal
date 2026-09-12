/**
 * Scheduled AlShrouq dispatch: parking a courier handoff, and performing it
 * later without anyone's browser being open. Server-only.
 *
 * ## The two halves
 *
 *   `scheduleAlShrouqDispatch` — runs when the agent approves the order. It
 *   validates exactly as an immediate send would, then writes one row holding
 *   the approved payload and the time it is due. It contacts nobody.
 *
 *   `runDueAlShrouqDispatches` — runs from `pg_cron`, every minute, via
 *   `alshrouq_dispatch_due()` → `net.http_post` → the scheduler route. It claims
 *   due rows and sends them.
 *
 * ## Why the snapshot exists
 *
 * The worker never reads the order. It reads `payload_snapshot`, written when
 * the agent said yes.
 *
 * A dispatch that rebuilt itself from `orders` at 2am would tell a courier
 * whatever the row said by then — a phone corrected after the fact, a branch
 * changed by someone tidying up — and nobody would have approved that. The
 * snapshot means the delivery that happens is the delivery that was authorised,
 * and it is why editing a Portal order after scheduling changes nothing about
 * what AlShrouq is told.
 *
 * ## Claiming, and why two workers cannot collide
 *
 * A row is taken with a compare-and-swap: `UPDATE … SET status='processing'
 * WHERE id = ? AND status='scheduled'`, which Postgres serialises. The worker
 * that gets a row back owns it; the other gets nothing and moves on. If a
 * dispatch record somehow still slipped past, the unique index
 * `alshrouq_dispatches_live_order_key` is the backstop it collides with.
 *
 * ## What it does not do
 *
 * It does not retry a POST. Ever. A timeout, a 5xx or a 401 leaves the row
 * `indeterminate` after one reconciliation read, and a human resolves it. The
 * whole point of scheduling is that nobody is watching — which is exactly when
 * an automatic retry would put a second driver on the road unobserved.
 *
 * ## What it does retry, and why that is not the same thing
 *
 * A failure that happens **before** the POST leaves the machine is a different
 * fact from a failure after it, and the transport is built so the two can be
 * told apart without guessing: `createAlshrouqOrder` *throws* when nothing was
 * transmitted and *returns* when exactly one POST was attempted, whatever the
 * outcome. So a refused CRM login, an unreachable CRM, a login timeout — none
 * of which reach AlShrouq at all — put the row back to `scheduled` to be tried
 * again, with the reason recorded. That cannot duplicate a delivery, because
 * there is no delivery: the thing being retried never happened.
 *
 * Anything from the POST onwards keeps the old rule exactly. A returned result
 * is settled here and now; a failure while *recording* a returned result leaves
 * the row claimed for `reapStaleClaims` to settle as `indeterminate`.
 *
 * ## One bad row does not stop the others
 *
 * Each row is handled inside its own `try`. A row that throws is settled or
 * released on its own and the run moves to the next one — the alternative,
 * which is what this used to do, was that the first unreachable CRM aborted the
 * whole batch, the endpoint answered pg_cron with a 500, and every other
 * delivery that had come due that minute was simply not looked at.
 */

import {
  isAlShrouqLiveDispatchEnabled,
  prepareAlShrouqDispatch,
  type AlShrouqDispatchResult,
  type DispatchDeps,
  type DispatchRequest,
} from "./alshrouq-dispatch.server";
import {
  createAlshrouqOrder,
  findAlshrouqOrderByClientOrderId,
  newAlshrouqOperationId,
  type AlShrouqCreateResult,
  type AlShrouqReconciledOrder,
} from "./alshrouq-create.server";
import { fetchAlShrouqDispatchOptions } from "./alshrouq-config.server";
import { readAlshrouqRejectionReason } from "./alshrouq-rejection";
import type { AlShrouqCreatePayload } from "./alshrouq-payload";
import {
  canCancelDispatch,
  describeCancelRefusal,
  type AlShrouqDispatchStatus as DispatchStatus,
} from "./alshrouq-dispatch-state";

/**
 * The lifecycle, as the database stores it.
 *
 * Re-exported rather than redeclared: the states and the rules about them live
 * in `alshrouq-dispatch-state.ts`, so the worker, the cancellation and the
 * duplicate check cannot end up with three slightly different ideas of what
 * `indeterminate` means.
 */
export type { AlShrouqDispatchStatus } from "./alshrouq-dispatch-state";

interface SupabaseLike {
  from: (table: string) => any;
}

const defaultDeps: DispatchDeps = {
  fetchOptions: fetchAlShrouqDispatchOptions,
  createOrder: createAlshrouqOrder,
  reconcile: findAlshrouqOrderByClientOrderId,
  newOperationId: newAlshrouqOperationId,
  liveEnabled: isAlShrouqLiveDispatchEnabled,
  agentPrincipal: async (userId) => {
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
    const { agentCrmPrincipal, supabaseAgentCredentialDeps } =
      await import("./agent-credentials.server");
    return agentCrmPrincipal(userId, supabaseAgentCredentialDeps(supabaseAdmin as never));
  },
};

const UNIQUE_VIOLATION = "23505";

/**
 * How many due rows one run will take.
 *
 * Small on purpose, and the number is derived rather than chosen. One create
 * may take up to `CREATE_TIMEOUT_MS` (120 s), and this runs inside a serverless
 * function with a platform-imposed wall clock. At 25 a single unlucky batch
 * asked for fifty minutes of runtime, was killed part-way through, and left
 * every row it had already claimed sitting in `processing` with nothing able to
 * pick it up again — which is precisely the stuck state `reapStaleClaims`
 * exists to clean up. Five bounds a worst-case run to ten minutes.
 *
 * A backlog is not a reason to raise it: the poll runs every minute, so five
 * per minute drains three hundred an hour, and a courier integration that ever
 * has that queue has a different problem.
 */
const BATCH_SIZE = 5;

/**
 * How long a claim may go unfinished before it is treated as abandoned.
 *
 * Comfortably past the worst case a whole batch can take (5 × 120 s), so a slow
 * but living run is never reaped out from under itself.
 */
const STALE_CLAIM_MS = 15 * 60_000;

/**
 * How long a released row waits before it is claimed again.
 *
 * A row put back to `scheduled` after a pre-transmission failure is, by
 * definition, still overdue — so without this it would be re-claimed by the very
 * next minute's poll, and a CRM that is refusing a login would be asked to
 * refuse it sixty times an hour. `client.server.ts` says plainly what that costs:
 * "repeatedly re-authenticating a user credential against a server that keeps
 * refusing is how an account gets locked."
 *
 * Two minutes is short enough that a delivery held up by a brief outage goes out
 * within a couple of minutes of the CRM returning, and long enough that a
 * genuinely broken credential is tried thirty times an hour rather than sixty
 * while an operator reads the reason off the order.
 *
 * The anchor is `last_attempt_at`, which the claim already writes. A delivery
 * that has never been attempted has none, so nothing here delays a first
 * dispatch.
 */
const RETRY_BACKOFF_MS = 2 * 60_000;

/**
 * How many due rows are *read* before the backoff filter is applied.
 *
 * Wider than `BATCH_SIZE` so a handful of rows resting in backoff cannot crowd a
 * freshly due delivery out of the batch — the filter runs after the read, and
 * reading exactly five would mean five backed-off rows produced a run that did
 * nothing. Still a bounded read, and still ordered oldest-first.
 */
const DUE_FETCH_LIMIT = BATCH_SIZE * 4;

/**
 * The sentences `alshrouq_dispatch_due()` stamps on a row it cannot act on.
 *
 * They are cleared the moment a worker actually claims the row: they describe
 * the scheduler being unable to run, and once it has run they are stale. Kept
 * as a list rather than a wildcard so a genuine dispatch failure recorded in
 * the same column is never mistaken for one of them.
 */
const POLL_STALL_NOTE_PREFIXES = [
  "The delivery scheduler is not connected",
  "The delivery scheduler could not be reached",
  "The delivery scheduler was refused",
] as const;

/** True for text the poll wrote about itself, rather than a dispatch outcome. */
export function isSchedulerStallNote(value: string | null | undefined): boolean {
  if (typeof value !== "string") return false;
  return POLL_STALL_NOTE_PREFIXES.some((prefix) => value.startsWith(prefix));
}

/**
 * What kind of thing went wrong, for a log line and for an operator.
 *
 * Categories rather than messages, for the same reason `AgentCredentialProblem`
 * is: an upstream body can carry a username, a token or a customer's name, and
 * these end up in logs and on screens. Nothing from the thrown error is copied
 * out — only its shape is read, and the sentence returned is one of the fixed
 * ones below.
 */
export type DispatchFailureCategory =
  /** The deployment or the agent link is not set up. An administrator fixes it. */
  | "configuration"
  /** The CRM refused the credential itself — a 401 or 403 on the login. */
  | "authentication"
  /**
   * The CRM refused this build of the Portal as out of date — a 426 on the
   * login, judged before the credentials are looked at. Its own category
   * because its fix is a deployment, not a password. See `incompatible_client`
   * in `client.server.ts`.
   */
  | "incompatible_client"
  /** The CRM could not be reached, or answered the login with a server error. */
  | "upstream"
  /** The CRM was reached and took too long. */
  | "timeout"
  /** Supabase, not the CRM. Reading the row, the credential, or writing back. */
  | "database"
  | "unknown";

export interface DispatchFailure {
  category: DispatchFailureCategory;
  /**
   * Whether trying again could plausibly work *on its own*.
   *
   * `false` does not mean "give up" — a released row is retried either way. It
   * means nothing will change until a person changes it, which is what separates
   * `blocked` from `retryable` in the run summary and what tells an operator
   * whether the delivery is waiting on the network or on them.
   */
  retryable: boolean;
  /** Safe to store on the row and show an agent. Never an upstream message. */
  message: string;
}

/**
 * Classify a failure that happened **before** anything was transmitted.
 *
 * The kinds line up with `ShamsCrmErrorKind`, and the status is read as well as
 * the kind. `client.server.ts` now raises `auth_failed` only for a 401 or 403,
 * but it did not always, and the difference is not academic: rounding every
 * non-2xx on `/login` up to `auth_failed` is what made the CRM's 426 version
 * gate read as a bad password on 2026-09-10. Checking the status here means
 * this classification stays right whatever a future transport decides to call
 * things.
 *
 * `incompatible_client` is kept apart from both. A 426 is the CRM refusing this
 * build of the Portal before it looks at the credentials, and its fix is a
 * deployment — sending somebody to re-enter a password would be the exact wrong
 * instruction.
 */
export function classifyDispatchFailure(err: unknown): DispatchFailure {
  const kind = (err as { kind?: string } | null)?.kind;
  const status = (err as { httpStatus?: number | null } | null)?.httpStatus ?? null;

  if (kind === "not_configured") {
    return {
      category: "configuration",
      retryable: false,
      message:
        "Blocked: the Shams CRM connection for this dispatch is not configured. " +
        "An administrator needs to complete the setup.",
    };
  }

  if (kind === "incompatible_client") {
    /*
     * Not retryable by this deployment, and deliberately not silent.
     *
     * `login()` already reads the CRM's published floor and retries once at it,
     * so reaching here means even the negotiated version was refused — nothing
     * the running build can do about that, and the delivery waits rather than
     * being abandoned.
     */
    return {
      category: "incompatible_client",
      retryable: false,
      message:
        "Blocked: Shams CRM refused this version of the Portal, so nothing was sent. " +
        "The Portal needs updating before scheduled deliveries can go out.",
    };
  }

  if (kind === "auth_failed") {
    // A non-2xx that is not 401/403 is the CRM having a bad time, not a bad
    // password — kept for transports that have not narrowed `auth_failed`.
    if (status != null && status !== 401 && status !== 403) {
      return {
        category: "upstream",
        retryable: true,
        message:
          "Shams CRM could not sign the order agent in, so nothing was sent. " +
          "The delivery is still scheduled and will be tried again.",
      };
    }
    return {
      category: "authentication",
      retryable: false,
      message:
        "Blocked: Shams CRM refused the order agent's sign-in, so nothing was sent. " +
        "An administrator needs to re-enter the CRM credentials.",
    };
  }

  if (kind === "timeout") {
    return {
      category: "timeout",
      retryable: true,
      message:
        "Shams CRM did not answer in time before the delivery was sent, so nothing " +
        "was sent. The delivery is still scheduled and will be tried again.",
    };
  }

  if (kind === "unavailable" || kind === "http_error" || kind === "malformed") {
    return {
      category: "upstream",
      retryable: true,
      message:
        "Shams CRM could not be reached, so nothing was sent. The delivery is " +
        "still scheduled and will be tried again.",
    };
  }

  /*
   * Postgres, not the CRM. A SQLSTATE is a five-character code and nothing else
   * on this path carries one, so it is a safe discriminator — and telling a
   * database fault apart from an upstream one is the difference between waking
   * the right person and the wrong one.
   */
  const code = (err as { code?: unknown } | null)?.code;
  if (typeof code === "string" && /^[0-9A-Z]{5}$/.test(code)) {
    return {
      category: "database",
      retryable: true,
      message:
        "The delivery could not be sent because its record could not be read, " +
        "and nothing was sent. It is still scheduled and will be tried again.",
    };
  }

  return {
    category: "unknown",
    retryable: true,
    message:
      "The delivery could not be sent because of an unexpected problem, and " +
      "nothing was sent. It is still scheduled and will be tried again.",
  };
}

export type ScheduleResult =
  /** Parked. Nothing was sent; `scheduledFor` is when it will be. */
  | { kind: "scheduled"; scheduledFor: string }
  /** Anything `prepareAlShrouqDispatch` refused — invalid, uncovered branch, … */
  | AlShrouqDispatchResult;

/**
 * Park a dispatch for later.
 *
 * Validated now, deliberately: an agent scheduling an order for tonight should
 * be told about a missing phone number or an uncovered branch while they are
 * still looking at it.
 *
 * The row is written with `dispatch_status='scheduled'`, which also takes the
 * order's slot in `alshrouq_dispatches_live_order_key` — so a second schedule,
 * or an immediate send while one is pending, is refused by the database rather
 * than producing two couriers.
 */
export async function scheduleAlShrouqDispatch(
  request: DispatchRequest,
  scheduledFor: Date,
  supabase: SupabaseLike,
  overrides: Partial<DispatchDeps> = {},
): Promise<ScheduleResult> {
  const deps: DispatchDeps = { ...defaultDeps, ...overrides };

  const prepared = await prepareAlShrouqDispatch(request, supabase, deps);
  if (!("ok" in prepared)) return prepared;

  const payload = prepared.payload;
  const when = scheduledFor.toISOString();

  const row = {
    order_id: request.orderId,
    client_order_id: payload.client_order_id,
    alshrouq_branch_id: payload.branch_id,
    branch_no: request.branchNo,
    payment_type: payload.payment_type,
    value: payload.value,
    details: payload.details ?? null,
    customer_address: payload.customer_address ?? null,
    customer_lat: payload.customer_lat ?? null,
    customer_lng: payload.customer_lng ?? null,
    preparation_time: payload.preparation_time ?? null,
    dispatch_status: "scheduled" as const,
    scheduled_for: when,
    scheduled_by: request.userId,
    /**
     * Whose delivery this is, frozen beside the payload.
     *
     * The same principle as `payload_snapshot`: what goes out at 2am is what was
     * approved, decided now. Kept apart from `scheduled_by` because the two
     * answer different questions — who acted, and whose delivery it is — and a
     * supervisor scheduling an agent's order makes them different values.
     */
    crm_agent_id: request.orderAgentId,
    scheduled_at: new Date().toISOString(),
    // The whole point. Read at dispatch time instead of the order.
    payload_snapshot: payload as unknown as Record<string, unknown>,
    dispatched_by: request.userId,
  };

  const { error } = await supabase.from("alshrouq_dispatches").insert(row);

  if (error) {
    if ((error as { code?: string }).code === UNIQUE_VIOLATION) {
      const { data } = await supabase
        .from("alshrouq_dispatches")
        .select("external_order_id,local_id,status,tracking_url,dispatched_at")
        .eq("order_id", request.orderId)
        .is("cancelled_at", null)
        .maybeSingle();
      /*
       * Only a *live* row makes "already dispatched" true.
       *
       * Both unique indexes on this table are partial on `cancelled_at IS
       * NULL`, so a collision means one exists and its record is the answer.
       * With no live row the collision was with something else — cancelled
       * history, before `20260901130000` scoped the `client_order_id` index the
       * way its sibling was already scoped — and reporting "already
       * dispatched" would leave an agent looking at a dispatch that is not
       * there, with no way to schedule the one they asked for. Nothing has been
       * sent on this path (scheduling contacts nobody), so the honest answer is
       * that the save failed.
       */
      if (data) {
        return {
          kind: "already_dispatched",
          dispatch: {
            externalOrderId: data.external_order_id ?? null,
            localId: data.local_id ?? null,
            status: data.status ?? null,
            trackingUrl: data.tracking_url ?? null,
            dispatchedAt: data.dispatched_at ?? null,
          },
        };
      }
    }
    throw new Error("The scheduled dispatch could not be saved.");
  }

  return { kind: "scheduled", scheduledFor: when };
}

export interface RunDueSummary {
  /** Rows that were due and eligible — after the retry backoff — when the run started. */
  due: number;
  claimed: number;
  accepted: number;
  failed: number;
  indeterminate: number;
  /** Due rows left untouched because the production gate is closed. */
  skippedDisabled: number;
  /**
   * Due rows returned to `scheduled` because the order agent's CRM identity
   * could not be used. Counted separately from `failed`: nothing is wrong with
   * the order, and the delivery still goes out once the link is fixed.
   *
   * Also carries the pre-transmission failures nothing will fix on its own — a
   * refused sign-in, an unconfigured connection — for the same reason: they are
   * waiting on an administrator, not on a network.
   */
  blocked: number;
  /**
   * Due rows returned to `scheduled` after a failure that happened **before**
   * the POST left the machine, and that trying again could plausibly fix.
   *
   * Nothing was transmitted — that is `createAlshrouqOrder`'s invariant, not an
   * assumption — so releasing these cannot produce a second courier.
   */
  retryable: number;
  /**
   * Rows that were due but are resting inside `RETRY_BACKOFF_MS` of their last
   * attempt. Not an error: a non-zero value alongside a non-zero `retryable`
   * over several runs is what an outage in progress looks like.
   */
  deferred: number;
  /**
   * Claims whose POST was made but whose outcome could not be written down.
   *
   * Left in `processing` deliberately, for `reapStaleClaims` to settle as
   * `indeterminate`. The one case where the run knows something happened and
   * must not say what.
   */
  unsettled: number;
  /**
   * Abandoned claims moved out of `processing` and into `indeterminate`.
   *
   * Its own counter because a non-zero value is a statement about this service,
   * not about any order: it means a previous run died mid-flight.
   */
  reaped: number;
}

interface DueRow {
  id: string;
  order_id: string;
  client_order_id: string;
  payload_snapshot: AlShrouqCreatePayload | null;
  scheduled_for: string;
  /** Who approved it. Audit only — no longer the identity it is sent under. */
  scheduled_by: string | null;
  /** The order's assigned agent. The identity this row is sent under. */
  crm_agent_id: string | null;
  /** How many claims this row has already had. Audit; never a gate on sending. */
  attempt_count: number | null;
  /** When it was last claimed. The backoff anchor. Null before the first claim. */
  last_attempt_at: string | null;
}

/**
 * Settle claims a previous run walked away from.
 *
 * ## The state that had no exit
 *
 * `processing` is written by the compare-and-swap and cleared by whichever
 * branch of the run finishes the row. If the process dies in between — a deploy
 * mid-run, a platform timeout, a batch that asked for more wall clock than it
 * was given — the row keeps the claim forever. The due query looks only for
 * `scheduled`, so no later run reconsiders it; `cancelScheduledAlShrouqDispatch`
 * refuses every state but `scheduled`, so no agent can clear it either. It was a
 * silent, permanent disappearance, which is the one outcome this integration is
 * built to prevent.
 *
 * ## Why `indeterminate` and not back to `scheduled`
 *
 * Because a claim says nothing about whether the POST went out. The run may
 * have died before contacting anyone, or after a courier was already assigned,
 * and from the outside those look identical. `indeterminate` is exactly that
 * statement — transmitted or not, outcome unknown, never followed by another
 * POST, settled by a person through the existing resolution flow. Returning the
 * row to `scheduled` would instead re-send it, which is how a second driver
 * arrives at a customer's door.
 *
 * The row keeps the order's slot in `alshrouq_dispatches_live_order_key`
 * throughout, so nothing about this frees the order for a fresh send.
 */
async function reapStaleClaims(supabase: SupabaseLike, now: Date): Promise<number> {
  const cutoff = new Date(now.getTime() - STALE_CLAIM_MS).toISOString();

  const { data } = await supabase
    .from("alshrouq_dispatches")
    .update({
      dispatch_status: "indeterminate",
      last_error:
        "The delivery was being sent when the process stopped, and the result " +
        "could not be confirmed. It has NOT been sent again — check with AlShrouq " +
        "before anyone resends it.",
    })
    .eq("dispatch_status", "processing")
    .is("cancelled_at", null)
    .lt("last_attempt_at", cutoff)
    .select("id");

  const reaped = (data ?? []).length;
  if (reaped > 0) {
    // Counts only, and the one line worth having: a non-zero value here means a
    // run died mid-dispatch, which nothing else in the system would report.
    console.warn("[alshrouq] abandoned dispatch claims settled as indeterminate", { reaped });
  }
  return reaped;
}

/**
 * Write the outcome of a claim, and only onto a row this run still holds.
 *
 * Every terminal write goes through here so they all carry the same guard:
 * `dispatch_status = 'processing'`. Without it a run that was reaped as
 * abandoned — because it overran by a quarter of an hour — could wake up and
 * overwrite the `indeterminate` a person may already have investigated and
 * resolved, replacing a settled human judgement with a stale machine one.
 *
 * A write that matches nothing is not an error and is not retried. It means
 * this run no longer owns the row, and the state that is there was written by
 * something with a better claim to it than a process that had already lost one.
 */
async function finishClaim(
  supabase: SupabaseLike,
  id: string,
  patch: Record<string, unknown>,
): Promise<void> {
  await supabase
    .from("alshrouq_dispatches")
    .update(patch)
    .eq("id", id)
    .eq("dispatch_status", "processing");
}

/**
 * Hand a claimed row back, unsent.
 *
 * The single exit for every outcome where **nothing reached AlShrouq**: a
 * missing CRM link, a refused sign-in, an unreachable CRM. The row returns to
 * `scheduled` carrying the reason, keeps its original `scheduled_for` — it is
 * overdue and should go on saying so — and is picked up by a later run once the
 * backoff has passed.
 *
 * `attempt_count` is incremented so the history of a struggling delivery is on
 * the row rather than only in a log. It gates nothing: there is no attempt
 * budget, because a delivery that stops being retried after N tries is a
 * delivery silently abandoned during an outage, which is the failure this whole
 * change is about.
 *
 * `last_attempt_at` is deliberately left as the claim wrote it. It is what the
 * backoff measures from, and rewriting it here would measure from the wrong end
 * of the attempt.
 *
 * Safe by construction, not by hope: it is only ever called where
 * `createAlshrouqOrder` has not returned, and that function throws if and only
 * if nothing was transmitted.
 */
async function releaseClaim(
  supabase: SupabaseLike,
  id: string,
  note: string,
  attemptCount: number | null,
): Promise<void> {
  await finishClaim(supabase, id, {
    dispatch_status: "scheduled",
    last_error: note,
    attempt_count: (attemptCount ?? 0) + 1,
  });
}

/**
 * Perform every dispatch that has come due.
 *
 * Idempotent by construction: a row is only acted on if the compare-and-swap
 * into `processing` succeeds, so running this twice concurrently — or a cron
 * firing twice — dispatches each order once.
 *
 * **The safety gate is checked before anything is claimed.** With it closed the
 * run touches nothing: rows stay `scheduled`, no request is made, no status is
 * invented, and they will be picked up whenever the gate is opened. A scheduled
 * order that quietly reported "sent" while the gate was shut would be the worst
 * possible failure, so it cannot happen.
 */
export async function runDueAlShrouqDispatches(
  supabase: SupabaseLike,
  overrides: Partial<DispatchDeps> = {},
  now: Date = new Date(),
): Promise<RunDueSummary> {
  const deps: DispatchDeps = { ...defaultDeps, ...overrides };
  const summary: RunDueSummary = {
    due: 0,
    claimed: 0,
    accepted: 0,
    failed: 0,
    indeterminate: 0,
    skippedDisabled: 0,
    blocked: 0,
    retryable: 0,
    deferred: 0,
    unsettled: 0,
    reaped: 0,
  };

  /*
   * Before anything else, and *before* the safety gate.
   *
   * Reaping contacts nobody — it reads no CRM and sends no request — so it is
   * not the gate's business, and a deployment with dispatch switched off must
   * still not accumulate rows stuck in a claim nothing can clear.
   */
  summary.reaped = await reapStaleClaims(supabase, now);

  /*
   * Everything whose time has come, oldest first — not everything scheduled for
   * this minute.
   *
   * `scheduled_for <= now` is the whole recovery story. A delivery due at 18:30
   * while the endpoint was answering 500s is still `scheduled` and still
   * overdue at 18:42, so the first run that succeeds picks it up. Nothing here
   * depends on any particular minute having been processed, which is exactly
   * what an every-minute poll must never depend on.
   *
   * The ordering is the other half. Reading five rows out of a backlog with no
   * `ORDER BY` lets Postgres return whichever five it likes, so the delivery
   * that has been waiting longest is not necessarily the one that goes next.
   * Oldest-first makes a drain fair and makes the worst-case wait bounded.
   */
  const { data: dueRows } = await supabase
    .from("alshrouq_dispatches")
    // `crm_agent_id` is read because it *is* the identity this row will be sent
    // under: the agent the order was assigned to when it was approved is who the
    // CRM must record. `scheduled_by` comes too, as the fallback for rows
    // written before the two were told apart.
    .select(
      "id,order_id,client_order_id,payload_snapshot,scheduled_for,scheduled_by,crm_agent_id," +
        "attempt_count,last_attempt_at",
    )
    .eq("dispatch_status", "scheduled")
    .is("cancelled_at", null)
    .lte("scheduled_for", now.toISOString())
    .order("scheduled_for", { ascending: true })
    .limit(DUE_FETCH_LIMIT);

  const eligible: DueRow[] = [];
  const backoffCutoff = now.getTime() - RETRY_BACKOFF_MS;
  for (const row of (dueRows ?? []) as DueRow[]) {
    /*
     * Released rows rest before being tried again.
     *
     * Filtered here rather than in the query so the read stays a plain range
     * scan on the partial due index, and so a row with an unparseable
     * `last_attempt_at` errs towards being attempted rather than towards being
     * silently skipped forever.
     */
    const attemptedAt = row.last_attempt_at ? Date.parse(row.last_attempt_at) : NaN;
    if (!Number.isNaN(attemptedAt) && attemptedAt > backoffCutoff) {
      summary.deferred += 1;
      continue;
    }
    if (eligible.length < BATCH_SIZE) eligible.push(row);
  }

  const due = eligible;
  summary.due = due.length;
  if (due.length === 0) return summary;

  if (!deps.liveEnabled()) {
    summary.skippedDisabled = due.length;
    return summary;
  }

  for (const row of due) {
    /*
     * One row, in its own `try`.
     *
     * `owned` and `sent` are what the catch needs to answer the only two
     * questions that matter about a thrown error here: do we hold this row, and
     * did a POST leave the machine. Everything else about the failure is
     * classification.
     */
    const attempts = row.attempt_count ?? 0;
    let owned = false;
    let sent: AlShrouqCreateResult | undefined;

    try {
      // Compare-and-swap. Losing the race is normal and silent.
      const { data: claimed } = await supabase
        .from("alshrouq_dispatches")
        .update({
          dispatch_status: "processing",
          last_attempt_at: new Date().toISOString(),
          /*
           * Whatever the poll last said about itself no longer holds.
           *
           * `alshrouq_dispatch_due()` stamps rows it could not act on — "the
           * scheduler is not connected", "the scheduler was refused" — so an
           * agent looking at a finished countdown is told why. The moment a
           * worker has the row those sentences are false, and leaving one in
           * place would caption a dispatch that is happening with the reason it
           * was not.
           */
          last_error: null,
        })
        .eq("id", row.id)
        .eq("dispatch_status", "scheduled")
        .select("id")
        .maybeSingle();
      if (!claimed) continue;
      owned = true;
      summary.claimed += 1;

      const payload = row.payload_snapshot;
      if (!payload || typeof payload !== "object") {
        // Nothing approved, nothing to send. Never reconstructed from the order.
        await finishClaim(supabase, row.id, {
          dispatch_status: "failed",
          last_error: "The approved dispatch details are missing.",
          attempt_count: attempts + 1,
        });
        summary.failed += 1;
        continue;
      }

      /*
       * Whose delivery this is, read from the row rather than from the order.
       *
       * The order's agent was recorded in `crm_agent_id` when the dispatch was
       * approved, and that frozen value is what the worker logs in as — an
       * ordinary immediate create, so from the CRM's side it is
       * indistinguishable from that agent having typed it at this moment. The
       * order itself is never re-read here, for the same reason
       * `payload_snapshot` exists: what goes out is what was approved, not what
       * the row has since become.
       *
       * `scheduled_by` is the fallback, and only for rows written before the two
       * were distinguished — where an agent approving their own order made them
       * the same value anyway.
       *
       * If the credential is gone, the row goes **back to `scheduled`** with the
       * reason recorded. It is not sent under the service account and not under
       * anybody else: a delivery attributed to the wrong person is worse than a
       * late one, and the schedule survives so it goes out once an administrator
       * fixes the link.
       */
      const attributedTo = row.crm_agent_id ?? row.scheduled_by;
      const identity = attributedTo ? await deps.agentPrincipal(attributedTo) : null;
      if (!identity || !identity.ok) {
        await releaseClaim(
          supabase,
          row.id,
          identity
            ? `Blocked: the order agent's Shams CRM account is unavailable (${identity.problem}).`
            : "Blocked: this dispatch has no recorded agent to send it as.",
          attempts,
        );
        summary.blocked += 1;
        continue;
      }

      const operationId = deps.newOperationId();
      sent = await deps.createOrder(payload, operationId, identity.principal);

      /*
       * The reference comes from the GET, whatever the POST said. The POST body is
       * never read for it, and the read now happens for a **refusal** too.
       *
       * That is the "already booked" case, and it is the one an idempotent
       * scheduler has to get right. A 4xx means the CRM understood the request and
       * declined it — and the commonest reason it declines a repeat of a create is
       * that the `client_order_id` already exists, because an earlier attempt got
       * further than this process saw. Recording that as `failed` would be a lie
       * about a delivery that is on its way, and it would show an agent a failure
       * next to a driver already en route.
       *
       * So the question is settled by evidence rather than by the status code:
       * ask the CRM whether a delivery with this `client_order_id` exists. If it
       * does, that delivery is this row's, and it is recorded as accepted. If it
       * does not, the refusal was a real refusal and is recorded as one.
       *
       * One GET, and only ever a GET. Nothing on this path can produce a second
       * POST.
       */
      const found = await deps
        .reconcile(payload.client_order_id)
        .catch((): AlShrouqReconciledOrder | null => null);

      if (sent.kind === "rejected" && !found) {
        /*
         * The refusal reason is stored, not just its status code.
         *
         * `last_error` is what the order page shows an agent and what an
         * operator reads when asking why a scheduled delivery never happened. A
         * bare "(400)" told them nothing actionable; the CRM's own sanitized
         * explanation tells them which field to fix.
         */
        const reason = readAlshrouqRejectionReason(sent.body);
        console.warn("[alshrouq] scheduled dispatch rejected", {
          at: new Date().toISOString(),
          dispatchId: row.id,
          orderId: row.order_id,
          clientOrderId: payload.client_order_id,
          alshrouqBranchId: payload.branch_id,
          httpStatus: sent.status,
          reason,
        });
        await finishClaim(supabase, row.id, {
          dispatch_status: "failed",
          last_error: reason
            ? `AlShrouq refused the order (${sent.status}): ${reason}`
            : `AlShrouq refused the order (${sent.status}).`,
          attempt_count: attempts + 1,
        });
        summary.failed += 1;
        continue;
      }

      if (sent.kind === "indeterminate" && !found) {
        await finishClaim(supabase, row.id, {
          dispatch_status: "indeterminate",
          last_error: sent.message,
          attempt_count: attempts + 1,
        });
        summary.indeterminate += 1;
        continue;
      }

      await finishClaim(supabase, row.id, {
        dispatch_status: "accepted",
        local_id: found?.id != null ? String(found.id) : null,
        external_order_id: found?.externalOrderId != null ? String(found.externalOrderId) : null,
        tracking_url: found?.trackingUrl ?? null,
        status: found?.statusLabel ?? null,
        refreshed_at: found ? new Date().toISOString() : null,
        dispatched_at: new Date().toISOString(),
        attempt_count: attempts + 1,
        last_error: null,
      });
      summary.accepted += 1;
    } catch (err) {
      /*
       * The whole reason this `try` exists.
       *
       * Before it, a thrown error here — a CRM that would not answer a login, a
       * Supabase blip — escaped the loop, aborted every remaining due delivery,
       * and left this row claimed in `processing` where nothing but the
       * fifteen-minute reaper could reach it. One unreachable CRM therefore
       * turned into one `indeterminate` needing a human, per minute, for as long
       * as the outage lasted.
       *
       * The three cases below are the only three there are, and which one
       * applies is a fact the code holds rather than a guess.
       */
      if (!owned) {
        /*
         * The claim itself failed. We never took the row, so it is untouched and
         * still `scheduled` — the next poll will find it exactly as it is.
         */
        console.error("[alshrouq] scheduled dispatch could not claim a row", {
          job: "alshrouq-run-scheduled",
          dispatchId: row.id,
          orderId: row.order_id,
          category: classifyDispatchFailure(err).category,
          error: (err as Error)?.name ?? "unknown",
        });
        continue;
      }

      if (sent !== undefined) {
        /*
         * The POST was made and the outcome could not be written down.
         *
         * The one case that must NOT be released: something happened at
         * AlShrouq's end and this process no longer knows what. The row stays
         * claimed, and `reapStaleClaims` settles it as `indeterminate` for a
         * person — which is the existing, correct answer to "transmitted,
         * outcome unknown".
         */
        summary.unsettled += 1;
        console.error("[alshrouq] scheduled dispatch outcome could not be recorded", {
          job: "alshrouq-run-scheduled",
          dispatchId: row.id,
          orderId: row.order_id,
          outcome: sent.kind,
          error: (err as Error)?.name ?? "unknown",
        });
        continue;
      }

      /*
       * Nothing was transmitted, so the delivery can safely be tried again.
       *
       * This is not optimism. `createAlshrouqOrder` throws if and only if the
       * POST never left the machine — everything from `fetch` onwards is a
       * returned result — so `sent === undefined` on a row we own means there is
       * no delivery at AlShrouq to duplicate. The row goes back to `scheduled`
       * with the reason on it, keeps its original due time, and waits out
       * `RETRY_BACKOFF_MS`.
       */
      const failure = classifyDispatchFailure(err);
      await releaseClaim(supabase, row.id, failure.message, attempts).catch(() => {
        /*
         * Even the release failed. The row stays `processing` and the reaper
         * settles it — the same outcome as before this change, and the only one
         * available when the database cannot be written to at all.
         */
      });
      if (failure.retryable) summary.retryable += 1;
      else summary.blocked += 1;

      console.warn("[alshrouq] scheduled dispatch released for a later attempt", {
        job: "alshrouq-run-scheduled",
        dispatchId: row.id,
        orderId: row.order_id,
        category: failure.category,
        retryable: failure.retryable,
        attempt: attempts + 1,
        error: (err as Error)?.name ?? "unknown",
      });
    }
  }

  return summary;
}

/**
 * Calling off a scheduled dispatch.
 *
 * The inverse of `scheduleAlShrouqDispatch`, and like it, **it contacts
 * nobody**. There is no transport in this function: cancelling a parked dispatch
 * is a local decision about a request that was never made, and there is no
 * AlShrouq cancellation endpoint in this integration to call even if there were
 * something to call off.
 *
 * ## Only `scheduled`, and why
 *
 * `canCancelDispatch` allows exactly one state. A parked row has contacted
 * nobody, so calling it off costs nothing and tells no one. Every other state is
 * refused with a sentence naming the reason — see `describeCancelRefusal`. The
 * refusal that matters most is `indeterminate`: recording "cancelled" against an
 * outcome nobody can establish would be a claim the data does not support, and
 * it would quietly free the order's slot for a resend.
 *
 * ## The race with the worker
 *
 * An agent can click Cancel in the same second `pg_cron` fires. Both operations
 * want the same transition out of `scheduled`:
 *
 *   worker: UPDATE … SET dispatch_status='processing' WHERE id=? AND dispatch_status='scheduled'
 *   cancel: UPDATE … SET dispatch_status='cancelled'  WHERE order_id=? AND dispatch_status='scheduled'
 *
 * Postgres serialises two updates to one row, so exactly one matches
 * `dispatch_status='scheduled'` and the other matches nothing. There is no
 * window in which both succeed, and no read-then-write for a concurrent
 * transaction to slip between.
 *
 * If cancellation wins, the row is `cancelled` and the worker's claim finds
 * nothing — and even if that worker had already selected the row in its due
 * query, it cannot claim it, and an unclaimed row is never sent.
 *
 * If the worker wins, cancellation returns `conflict` and **says so**. It does
 * not retry, and it does not overwrite a `processing` row: that row may be
 * mid-request, and marking it cancelled would record a delivery as called off
 * while a driver was being assigned.
 */
export type CancelScheduledResult =
  /** Called off. Nothing was sent, and nothing will be. */
  | { kind: "cancelled"; cancelledAt: string }
  /** No dispatch for this order at all. */
  | { kind: "not_found" }
  /** Already cancelled — reported as its own outcome, not as an error. */
  | { kind: "already_cancelled" }
  /**
   * The dispatch is in a state cancellation may not touch. `status` is what it
   * is actually in, and `message` is what to tell the agent.
   */
  | { kind: "conflict"; status: DispatchStatus | null; message: string };

/**
 * `userId` is the **verified** caller, from `requireSupabaseAuth`'s claims — the
 * server function takes an order id and nothing else, so a browser cannot
 * attribute a cancellation to somebody else by asking to. It joins
 * `dispatched_by` and `scheduled_by` in recording who did the consequential
 * thing, which cancellation was previously the only one to omit.
 */
export async function cancelScheduledAlShrouqDispatch(
  orderId: string,
  userId: string,
  supabase: SupabaseLike,
): Promise<CancelScheduledResult> {
  const cancelledAt = new Date().toISOString();

  /*
   * The compare-and-swap. `dispatch_status='scheduled'` is the guard, and it is
   * the same predicate the worker's claim uses, so the two cannot both win.
   *
   * `cancelled_at` is set in the same statement as the status. They are the two
   * markers the rest of the system reads — the unique index keys on
   * `cancelled_at IS NULL`, the due query and the timeline on both — and writing
   * them separately would leave a window where the row disagreed with itself.
   */
  const { data: cancelled } = await supabase
    .from("alshrouq_dispatches")
    .update({
      dispatch_status: "cancelled",
      cancelled_at: cancelledAt,
      cancelled_by: userId,
    })
    .eq("order_id", orderId)
    .eq("dispatch_status", "scheduled")
    .is("cancelled_at", null)
    .select("id,cancelled_at")
    .maybeSingle();

  if (cancelled) return { kind: "cancelled", cancelledAt };

  /*
   * Nothing was updated. Read the row to say *why* — a cancellation that failed
   * silently, or that reported success it did not achieve, is worse than one
   * that explains itself. This read happens only on the failure path, so the
   * common case is a single statement.
   */
  const { data: current } = await supabase
    .from("alshrouq_dispatches")
    .select("dispatch_status,cancelled_at")
    .eq("order_id", orderId)
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();

  if (!current) return { kind: "not_found" };

  const status = (current.dispatch_status ?? null) as DispatchStatus | null;
  if (status === "cancelled" || current.cancelled_at) return { kind: "already_cancelled" };

  // Never silently mutate a row cancellation may not have. Report the state.
  return { kind: "conflict", status, message: describeCancelRefusal(status) };
}
