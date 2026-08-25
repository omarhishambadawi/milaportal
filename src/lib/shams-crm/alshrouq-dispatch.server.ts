/**
 * Sending an order to AlShrouq — the whole workflow, in one place. Server-only.
 *
 * The UI calls this and nothing else. It does not build payloads, it does not
 * know an endpoint, and it cannot reach the transport: `createAlshrouqOrder` is
 * imported here and nowhere a browser can follow. That is deliberate — the
 * reverted integration assembled requests inside a React component, which is how
 * a re-render became a second courier.
 *
 * ## The pipeline
 *
 *   duplicate check → branch resolution → Phase 6 payload → **safety gate**
 *   → POST (once) → reconcile by client_order_id → persist → result
 *
 * Everything up to the gate runs today. Everything after it is written, typed
 * and tested against a mocked transport, and **unreachable** until someone sets
 * `ALSHROUQ_LIVE_DISPATCH_ENABLED=true` in the server environment.
 *
 * ## The safety gate
 *
 * One boolean, read from `process.env` inside this module and nowhere else.
 *
 *   * **Server-side.** Un-prefixed, so it is never inlined into the browser
 *     bundle — the same rule `SHAMS_CRM_PASSWORD` follows.
 *   * **Not an argument.** `DispatchRequest` has no `live` field and no
 *     override. A caller cannot ask for a live dispatch; only the deployment
 *     can permit one. This is why the gate is not merely a disabled button.
 *   * **Default-safe.** Anything other than the exact string `"true"` — unset,
 *     empty, `"1"`, `"TRUE"` — is off.
 *
 * ## Why the POST response is not trusted for the reference
 *
 * The create response has never been captured, so nothing here reads a field out
 * of it. The external reference comes from `findAlshrouqOrderByClientOrderId`,
 * whose shape *is* evidence-backed. A 2xx tells us the delivery exists; the GET
 * tells us what it is called.
 *
 * ## Why an indeterminate result never re-POSTs
 *
 * Server-side deduplication is unknown. A timeout, a 5xx or a 401 after
 * transmission means the courier may already be on the way, so the answer is a
 * *read*, never another write. If the read finds the order, it is persisted and
 * reported as dispatched; if it does not, the operation stays indeterminate and
 * a human decides. There is no branch in this file that sends a second POST.
 *
 * ## An indeterminate result is written down
 *
 * Both outcomes persist a row, and the uncertain one persists as
 * `indeterminate` rather than as nothing. The record does not claim a courier —
 * it records that a request was made and that the outcome is unknown — and it
 * takes the order's slot in `alshrouq_dispatches_live_order_key` so that the
 * duplicate check, the unique index and the order page all refuse to send it
 * again. An order that had already been POSTed used to look untouched here,
 * which is the one state that invites a second driver.
 *
 * ## Every insert states its status
 *
 * `dispatch_status` is written explicitly, never left to the column default.
 * A default is a fine way to describe rows that predate a feature and a poor way
 * for code to express intent — and defaulting an uncertain dispatch to
 * `accepted` would be the worst possible mislabel.
 */

import {
  buildAlshrouqOrderPayload,
  paidPaymentTypeIds,
  type AlShrouqCreatePayload,
  type AlShrouqFieldError,
} from "./alshrouq-payload";
import { resolveAlShrouqBranch, type AlShrouqBranchResolution } from "./alshrouq-branches";
import { fetchAlShrouqDispatchOptions } from "./alshrouq-config.server";
import {
  createAlshrouqOrder,
  findAlshrouqOrderByClientOrderId,
  newAlshrouqOperationId,
  type AlShrouqReconciledOrder,
} from "./alshrouq-create.server";
import { ShamsCrmError } from "./client.server";
import type { AlShrouqDispatchStatus } from "./alshrouq-dispatch-state";
import type { AgentCredentialProblem, AgentCredentialResult } from "./agent-credentials.server";

/**
 * The production boundary.
 *
 * Exported so a diagnostic can *report* it. Nothing may pass a value in — the
 * environment is the only input.
 */
export function isAlShrouqLiveDispatchEnabled(): boolean {
  return process.env.ALSHROUQ_LIVE_DISPATCH_ENABLED === "true";
}

/** What the agent typed in the dispatch dialog. Strings: a form holds text. */
export interface DispatchFormInput {
  customerName: string;
  customerPhone: string;
  paymentType: string;
  mapUrl: string;
  lat: string;
  lng: string;
  orderValue: string;
  details: string;
}

/**
 * One dispatch attempt.
 *
 * Note what is absent: any way to request a live send. The gate is not a
 * parameter, so no caller — UI, server function, or a crafted request — can ask
 * for one.
 */
export interface DispatchRequest {
  orderId: string;
  displayNo: string | null;
  branchNo: string | null;
  /**
   * Who pressed send, for `dispatched_by`. Never defaulted to anyone.
   *
   * The *audit* half of the answer, and only that. It records which MilaPortal
   * account performed the action; it is not who the delivery belongs to.
   */
  userId: string;
  /**
   * The agent the order is assigned to — `orders.agent_id`, and the identity the
   * delivery is recorded under at the CRM.
   *
   * This is the order's owner, not its author. A supervisor may take an order
   * down and hand it to the agent who will service it, and the delivery is that
   * agent's; MilaPortal already separates the two (`agent_id` is the assignee,
   * `created_by` defaults to `auth.uid()`), and this keeps the CRM's
   * `created_by_user_id` agreeing with `agent_id` rather than with whoever
   * happened to click.
   *
   * **Read from the order on the server, never from a form field.** A caller who
   * could name the agent could dispatch under somebody else's CRM identity; a
   * caller who has passed this order's edit check can only ever reach the agent
   * that order is already assigned to.
   *
   * Nullable so a row that predates the column, or a shape this build does not
   * expect, fails closed as `not_configured` rather than falling through to the
   * caller.
   */
  orderAgentId: string | null;
  form: DispatchFormInput;
}

/** A dispatch as the UI is allowed to see it. No customer or driver identity. */
export interface DispatchView {
  externalOrderId: string | null;
  localId: string | null;
  status: string | null;
  trackingUrl: string | null;
  dispatchedAt: string | null;
}

/**
 * The payload, described rather than echoed.
 *
 * Enough for an agent to see that the right order is about to go to the right
 * branch, without putting the customer's name and phone into a result object
 * that may end up in a log.
 */
export interface DispatchPayloadSummary {
  branchId: string;
  clientOrderId: string;
  paymentType: number;
  orderValue: number;
  hasCustomerName: boolean;
  hasCustomerPhone: boolean;
  hasAddress: boolean;
  hasCoordinates: boolean;
  hasDetails: boolean;
}

export type AlShrouqDispatchResult =
  /** An undispatched order is required; this one already has a live courier record. */
  | { kind: "already_dispatched"; dispatch: DispatchView }
  /** The dispatch data is incomplete. Nothing was sent. */
  | { kind: "invalid"; errors: AlShrouqFieldError[] }
  /** The branch cannot be dispatched to. Nothing was sent. */
  | { kind: "branch_unresolved"; branch: AlShrouqBranchResolution }
  /** The CRM could not be reached to resolve the branch. Nothing was sent. */
  | { kind: "options_unavailable"; errorKind: string }
  /**
   * The gate is closed. Everything up to the POST succeeded and **no request was
   * made**. This is the only outcome reachable in the current deployment.
   */
  | { kind: "prepared"; payload: DispatchPayloadSummary; liveDispatchEnabled: false }
  /**
   * The agent has no usable Shams CRM identity, so **nothing was sent**.
   *
   * A distinct outcome rather than a failure, because the order is fine and so
   * is the branch — it is the *agent's* CRM link that is missing, and the fix is
   * an administrator's. Crucially this is where the pipeline stops: it never
   * continues under the service credential, because that would succeed and
   * record the delivery against the wrong person.
   */
  | { kind: "agent_not_configured"; problem: AgentCredentialProblem }
  /** Live only: the CRM accepted it and the GET confirmed what it is called. */
  | { kind: "dispatched"; dispatch: DispatchView }
  /** Live only: the CRM refused it (a 4xx). Nothing was created. */
  | { kind: "rejected"; status: number; message: string }
  /**
   * Live only: the request was sent and the outcome is unknown. Reconciliation
   * has already been attempted; `reconciled` is null when it found nothing.
   * **No second POST was made, and none will be made automatically.**
   */
  | {
      kind: "indeterminate";
      operationId: string;
      errorKind: string;
      message: string;
      reconciled: DispatchView | null;
      /**
       * The `indeterminate` row this outcome wrote.
       *
       * Present whenever the record was persisted, which is the normal case: an
       * uncertain send takes the order's dispatch slot so nothing can offer to
       * send it again. Null only if the write itself failed, and the caller is
       * still told the outcome rather than an error, because the courier may
       * exist whatever the database managed to record.
       */
      dispatch: DispatchView | null;
    };

/** Minimal Supabase surface, so tests need no client. */
interface SupabaseLike {
  from: (table: string) => any;
}

/** Seams. Defaults are the real modules — tests pass fakes, nothing else does. */
export interface DispatchDeps {
  fetchOptions: typeof fetchAlShrouqDispatchOptions;
  createOrder: typeof createAlshrouqOrder;
  reconcile: typeof findAlshrouqOrderByClientOrderId;
  newOperationId: typeof newAlshrouqOperationId;
  liveEnabled: () => boolean;
  /**
   * The dispatching agent's CRM identity.
   *
   * Returns a *reason* rather than throwing when there is none, and never a
   * service principal — see `agent-credentials.server.ts`. Injected so tests can
   * exercise both halves without a database.
   */
  agentPrincipal: (userId: string) => Promise<AgentCredentialResult>;
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

/** Postgres unique violation — the active-dispatch index did its job. */
const UNIQUE_VIOLATION = "23505";

function toView(row: Record<string, unknown> | null | undefined): DispatchView | null {
  if (!row) return null;
  const s = (v: unknown) => (typeof v === "string" && v.length > 0 ? v : null);
  return {
    externalOrderId: s(row.external_order_id),
    localId: s(row.local_id),
    status: s(row.status),
    trackingUrl: s(row.tracking_url),
    dispatchedAt: s(row.dispatched_at),
  };
}

/**
 * The live courier record for an order, if there is one.
 *
 * `cancelled_at IS NULL` is the same predicate as the unique index
 * `alshrouq_dispatches_live_order_key`, so the check and the constraint cannot
 * disagree about what "already dispatched" means. `alshrouq_dispatches` is
 * absent from the generated types, so it is reached through the cast this
 * codebase already uses for such tables — never by hand-editing `types.ts`.
 */
async function liveDispatch(supabase: SupabaseLike, orderId: string): Promise<DispatchView | null> {
  const { data } = await supabase
    .from("alshrouq_dispatches")
    .select("external_order_id,local_id,status,tracking_url,dispatched_at")
    .eq("order_id", orderId)
    .is("cancelled_at", null)
    .maybeSingle();
  return toView(data);
}

/**
 * Everything before the safety gate: duplicate check, branch, payload.
 *
 * Shared by the immediate path and by scheduling, so an order that is scheduled
 * for later is validated by exactly the checks it would face if it were sent
 * now — the agent finds out about an uncovered branch or a missing phone at the
 * moment they approve it, not silently at 2am.
 *
 * Returns a failure `AlShrouqDispatchResult` or the built payload. It never
 * sends and never writes.
 */
export async function prepareAlShrouqDispatch(
  request: DispatchRequest,
  supabase: SupabaseLike,
  deps: DispatchDeps,
): Promise<
  | { ok: true; payload: AlShrouqCreatePayload; summary: DispatchPayloadSummary }
  | AlShrouqDispatchResult
> {
  const { orderId, displayNo, branchNo, form } = request;

  // 1. Duplicate protection, before anything is built or sent.
  const existing = await liveDispatch(supabase, orderId);
  if (existing) return { kind: "already_dispatched", dispatch: existing };

  // 2. The branch, from the CRM's live list.
  let branch: AlShrouqBranchResolution;
  let paymentOptionIds: number[];
  let paidIds: number[];
  try {
    const options = await deps.fetchOptions();
    paymentOptionIds = options.paymentOptions.map((p) => p.id);
    // Read off the same live list, so no payment id is written down in this
    // repository — the CRM's own label is what decides.
    paidIds = paidPaymentTypeIds(options.paymentOptions);
    branch = resolveAlShrouqBranch(options.branchOptions, branchNo);
  } catch (err) {
    return {
      kind: "options_unavailable",
      errorKind: err instanceof ShamsCrmError ? err.kind : "unknown",
    };
  }
  if (branch.kind !== "resolved") return { kind: "branch_unresolved", branch };

  // 3. The payload, from the Phase 6 builder. There is no second builder.
  const built = buildAlshrouqOrderPayload(
    {
      display_no: displayNo,
      customer_name: form.customerName,
      customer_phone: form.customerPhone,
      alshrouq_map_url: form.mapUrl || null,
      alshrouq_lat: form.lat || null,
      alshrouq_lng: form.lng || null,
      alshrouq_payment_type: form.paymentType || null,
      invoice_value: form.orderValue || null,
      notes: form.details || null,
    },
    { alshrouqBranchId: branch.branchId, paymentOptionIds, paidPaymentTypeIds: paidIds },
  );

  if (!built.ok) {
    return built.reason === "invalid"
      ? { kind: "invalid", errors: built.errors }
      : { kind: "branch_unresolved", branch };
  }

  const payload = built.payload;
  const summary: DispatchPayloadSummary = {
    branchId: payload.branch_id,
    clientOrderId: payload.client_order_id,
    paymentType: payload.payment_type,
    orderValue: payload.value,
    hasCustomerName: payload.customer_name.length > 0,
    hasCustomerPhone: payload.customer_phone.length > 0,
    hasAddress: typeof payload.customer_address === "string",
    hasCoordinates: typeof payload.customer_lat === "number",
    hasDetails: typeof payload.details === "string",
  };

  return { ok: true, payload, summary };
}

/**
 * Send one order to AlShrouq now.
 *
 * Never throws for an expected outcome — a missing phone number, an uncovered
 * branch and an unreachable CRM are all results, because each is something an
 * agent is told rather than an exception a UI has to decode.
 */
export async function dispatchOrderToAlShrouq(
  request: DispatchRequest,
  supabase: SupabaseLike,
  overrides: Partial<DispatchDeps> = {},
): Promise<AlShrouqDispatchResult> {
  const deps: DispatchDeps = { ...defaultDeps, ...overrides };
  const { userId } = request;

  const prepared = await prepareAlShrouqDispatch(request, supabase, deps);
  if (!("ok" in prepared)) return prepared;
  const { payload, summary } = prepared;

  /* ---------------------------------------------------------------------- */
  /* THE PRODUCTION SAFETY GATE                                             */
  /*                                                                        */
  /* Below this line a real courier is dispatched to a real address. The    */
  /* gate is an environment variable and nothing else: no argument reaches  */
  /* it, so no caller can open it.                                          */
  /* ---------------------------------------------------------------------- */
  if (!deps.liveEnabled()) {
    // Prepared, not sent. Nothing is written: an order with no courier must not
    // acquire a dispatch record, or the duplicate check would refuse the real
    // send later on the strength of a dry run.
    return { kind: "prepared", payload: summary, liveDispatchEnabled: false };
  }

  /* ---------------------------------------------------------------------- */
  /* WHOSE ORDER THIS IS                                                     */
  /*                                                                         */
  /* Shams CRM stamps `created_by_user_id` from the authenticated session and */
  /* accepts no caller-supplied attribution, so the credential *is* the       */
  /* attribution. It is resolved from the order's **assigned agent**, read on  */
  /* the server from `orders.agent_id` — never from a form field — because the */
  /* delivery belongs to the agent servicing the order, not to whoever pressed */
  /* send. A supervisor handing an order to an agent must not put their own    */
  /* name on that agent's delivery, and supervisors have no CRM account at all. */
  /* `userId` still records who acted, in `dispatched_by`.                     */
  /*                                                                         */
  /* There is deliberately no `?? SERVICE_PRINCIPAL` and no `?? userId`.      */
  /* Either fallback would send the order, return success, and record it       */
  /* against the wrong person — the one outcome this design exists to prevent. */
  /* ---------------------------------------------------------------------- */
  if (!request.orderAgentId) {
    // An order with no agent has nobody to attribute the delivery to. Treated
    // as an unconfigured link rather than an error: it is the same fix — an
    // administrator sorts out who this order belongs to — and nothing was sent.
    return { kind: "agent_not_configured", problem: "not_configured" };
  }
  const identity = await deps.agentPrincipal(request.orderAgentId);
  if (!identity.ok) return { kind: "agent_not_configured", problem: identity.problem };

  // 4. One POST, as that agent. The transport guarantees it is never retried.
  const operationId = deps.newOperationId();
  const sent = await deps.createOrder(payload, operationId, identity.principal);

  if (sent.kind === "rejected") {
    return {
      kind: "rejected",
      status: sent.status,
      message: "AlShrouq refused this order. Nothing was dispatched.",
    };
  }

  // 5. The reference comes from the GET, never from the POST body — for an
  // accepted send and for an ambiguous one alike.
  const found = await deps
    .reconcile(payload.client_order_id)
    .catch((): AlShrouqReconciledOrder | null => null);

  if (sent.kind === "indeterminate") {
    if (!found) {
      /*
       * Transmitted, and nobody can say what happened.
       *
       * **The row is written anyway, as `indeterminate`.** This used to return
       * without persisting, on the reasoning that a record should not claim a
       * courier that may not exist — but the record does not claim one. It
       * records that a *request was made* and that the outcome is unknown, which
       * is the fact of the matter.
       *
       * Writing it is what makes the order stop looking sendable. The row takes
       * the order's slot in `alshrouq_dispatches_live_order_key`, so the
       * duplicate check at the top of this function, the unique index behind it
       * and the card that reads the row all refuse a second send. Returning
       * nothing left an order that had already been POSTed looking untouched,
       * and the next click would have put a second driver on the road.
       *
       * It is still not `failed`: nothing here reinterprets an unknown outcome
       * as a refusal, and nothing retries it. Resolving it is a human action.
       */
      const persisted = await persist(
        supabase,
        request,
        payload,
        null,
        userId,
        "indeterminate",
        sent.message,
      );
      if (persisted.kind === "conflict") {
        // Another request won the race. Its record is the honest answer.
        return { kind: "already_dispatched", dispatch: persisted.dispatch };
      }
      return {
        kind: "indeterminate",
        operationId,
        errorKind: sent.errorKind,
        message: sent.message,
        reconciled: null,
        dispatch: persisted.dispatch,
      };
    }
    // The GET found it, so the delivery exists and is named. That is evidence,
    // and evidence outranks an ambiguous response leg.
    const persisted = await persist(supabase, request, payload, found, userId, "accepted");
    if (persisted.kind === "conflict") {
      return { kind: "already_dispatched", dispatch: persisted.dispatch };
    }
    return { kind: "dispatched", dispatch: persisted.dispatch };
  }

  // accepted
  const persisted = await persist(supabase, request, payload, found, userId, "accepted");
  if (persisted.kind === "conflict") {
    return { kind: "already_dispatched", dispatch: persisted.dispatch };
  }
  return { kind: "dispatched", dispatch: persisted.dispatch };
}

type PersistOutcome =
  | { kind: "written"; dispatch: DispatchView }
  | { kind: "conflict"; dispatch: DispatchView };

/**
 * Record the courier we now have.
 *
 * Only ever called after the CRM has been told, so a row here always means a
 * real delivery. A unique violation is not an error to show an agent — it means
 * another request won the race, and the honest answer is that one's record.
 */
async function persist(
  supabase: SupabaseLike,
  request: DispatchRequest,
  payload: AlShrouqCreatePayload,
  found: AlShrouqReconciledOrder | null,
  userId: string,
  /**
   * The lifecycle value to store, stated rather than defaulted.
   *
   * The column carries `DEFAULT 'accepted'`, which was right for the four rows
   * that predate scheduling and wrong as a way for application code to express
   * intent: an insert that omits it reads as though nobody decided, and it would
   * silently label an *uncertain* dispatch as accepted. The default stays for
   * those historical rows; every write from here names its state.
   */
  status: AlShrouqDispatchStatus,
  /** A safe sentence for a state that needs explaining. Never a stack trace. */
  lastError: string | null = null,
): Promise<PersistOutcome> {
  const now = new Date().toISOString();
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
    // Evidence-backed fields only, and only from the GET.
    local_id: found?.id != null ? String(found.id) : null,
    external_order_id: found?.externalOrderId != null ? String(found.externalOrderId) : null,
    tracking_url: found?.trackingUrl ?? null,
    status: found?.statusLabel ?? null,
    dispatched_by: userId,
    refreshed_at: found ? now : null,
    // Explicit, never the column default.
    dispatch_status: status,
    last_error: lastError,
    // One attempt was made. There is never a second.
    attempt_count: 1,
    last_attempt_at: now,
  };

  const { data, error } = await supabase
    .from("alshrouq_dispatches")
    .insert(row)
    .select("external_order_id,local_id,status,tracking_url,dispatched_at")
    .maybeSingle();

  if (error) {
    if ((error as { code?: string }).code === UNIQUE_VIOLATION) {
      const winner = await liveDispatch(supabase, request.orderId);
      return {
        kind: "conflict",
        dispatch: winner ?? { ...emptyView(), externalOrderId: row.external_order_id },
      };
    }
    // The courier exists whatever the database says, so the reference is still
    // reported rather than swallowed behind a write failure.
    return { kind: "written", dispatch: { ...emptyView(), ...fromRow(row) } };
  }

  return { kind: "written", dispatch: toView(data) ?? { ...emptyView(), ...fromRow(row) } };
}

function emptyView(): DispatchView {
  return {
    externalOrderId: null,
    localId: null,
    status: null,
    trackingUrl: null,
    dispatchedAt: null,
  };
}

function fromRow(row: Record<string, unknown>): Partial<DispatchView> {
  return {
    externalOrderId: (row.external_order_id as string) ?? null,
    localId: (row.local_id as string) ?? null,
    status: (row.status as string) ?? null,
    trackingUrl: (row.tracking_url as string) ?? null,
  };
}
