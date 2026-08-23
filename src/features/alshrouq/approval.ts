/**
 * The approval contract — shared by both places an agent can hand an order to
 * AlShrouq.
 *
 * There are two *user journeys*: approving while creating a new order, and
 * approving one that already exists. There is exactly **one** backend dispatch
 * contract, and this module is it. The request `alshrouqDispatchOrder` receives
 * is built here and nowhere else, so the two journeys cannot drift into sending
 * different things — which is what "consolidate the dispatch paths" means in
 * practice: not one screen, one request.
 *
 * Pure. No React, no server function, no network — it shapes a request and
 * chooses a sentence. Whether anything is sent is decided on the server, by the
 * time on the server's clock and by the safety gate behind it.
 */

import { formatScheduledFor } from "./scheduling";
import { explainAgentCredentialProblem } from "@/lib/shams-crm/agent-credentials.server";
import type {
  CancelScheduledResult,
  ScheduleResult,
} from "@/lib/shams-crm/alshrouq-scheduler.server";

/** What the agent approved. Identical for a new order and an existing one. */
export interface AlShrouqApprovalPlan {
  /**
   * `order_only` exists for the create journey, where the choice is between
   * recording an order and recording it *and* calling a courier. An existing
   * order is already recorded, so its dialog only ever approves `dispatch`.
   */
  intent: "order_only" | "dispatch";
  /** A canonical UTC instant. Absent means "as soon as the server sees this". */
  scheduledFor?: string;
  paymentType: string;
  mapUrl: string;
  lat: string;
  lng: string;
  /** Copied from the order at the moment of approval, not re-read later. */
  customerName: string;
  customerPhone: string;
  orderValue: string;
  /** The note for the driver. Optional, and empty is a legitimate value. */
  details: string;
}

/**
 * Exactly the input `alshrouqDispatchOrder` validates.
 *
 * Kept as a type of its own so a field added to the server's schema without a
 * matching field here is a type error rather than a silently omitted value on
 * one of the two journeys.
 */
export interface AlShrouqDispatchInput {
  orderId: string;
  customerName: string;
  customerPhone: string;
  paymentType: string;
  mapUrl: string;
  lat: string;
  lng: string;
  orderValue: string;
  details: string;
  scheduledFor?: string;
}

/**
 * The one place a dispatch request is assembled.
 *
 * Note what it does not do: it does not decide between scheduling and sending.
 * It carries the time the agent chose and nothing more. The server compares that
 * time to its own clock, so a browser with a wrong clock — or a crafted request
 * — cannot turn a scheduled delivery into an immediate one, and there is no
 * field here through which a caller could ask for a live send.
 */
export function dispatchInputFor(
  orderId: string,
  plan: AlShrouqApprovalPlan,
): AlShrouqDispatchInput {
  return {
    orderId,
    customerName: plan.customerName,
    customerPhone: plan.customerPhone,
    paymentType: plan.paymentType,
    mapUrl: plan.mapUrl,
    lat: plan.lat,
    lng: plan.lng,
    orderValue: plan.orderValue,
    details: plan.details,
    // Omitted rather than sent as undefined-ish text: absent means "now", and
    // the server's validator treats the key as optional.
    ...(plan.scheduledFor ? { scheduledFor: plan.scheduledFor } : {}),
  };
}

/**
 * What the agent is told, per outcome.
 *
 * One mapping for both journeys. `created` only changes the opening clause —
 * the part that matters, whether a courier was contacted, is the same sentence
 * either way, because it is the same server result.
 *
 * Nothing here claims success without evidence. `prepared` means the gate is
 * shut and says so; `indeterminate` says the result is unknown *and* that it has
 * not been retried, because an agent who reads it as a failure will send it
 * again and put a second driver at the customer's door.
 */
export function describeApprovalResult(
  result: ScheduleResult,
  created = false,
): { tone: "success" | "info" | "warning" | "error"; message: string } {
  const lead = created ? "Order created. " : "";

  switch (result.kind) {
    case "scheduled": {
      const when = formatScheduledFor(result.scheduledFor);
      return {
        tone: "success",
        message: `${lead}AlShrouq will be contacted${when ? ` at ${when}` : ""}. No courier has been contacted yet.`,
      };
    }
    case "dispatched":
      return {
        tone: "success",
        message: result.dispatch.externalOrderId
          ? `${lead}Sent to AlShrouq — reference ${result.dispatch.externalOrderId}.`
          : `${lead}Sent to AlShrouq.`,
      };
    case "already_dispatched":
      return {
        tone: "info",
        message: `${lead}This order already has an AlShrouq delivery, so it was not sent again.`,
      };
    case "prepared":
      // The gate is shut. Saying "sent" here would be the single most damaging
      // thing this function could do.
      return {
        tone: "info",
        message: `${lead}AlShrouq dispatch is switched off, so no courier was contacted.`,
      };
    case "rejected":
      return {
        tone: "error",
        message: `${lead}AlShrouq refused the delivery. No courier was sent.`,
      };
    case "indeterminate":
      return {
        tone: "warning",
        message: `${lead}The AlShrouq result could not be confirmed and it has NOT been sent again — check with AlShrouq before anyone resends it.`,
      };
    case "invalid": {
      /*
       * Name what is missing, rather than saying "incomplete".
       *
       * The result has always carried a per-field list and this sentence threw
       * it away, so an agent looking at a form with a branch, a customer, a
       * phone and a pin visibly filled in was told the details were incomplete
       * and given nothing to act on. The server already knows which field it
       * refused; the only thing missing was saying so.
       *
       * The field *messages* are used, not the identifiers — they are written
       * for a person, and `customer_phone` is not.
       */
      const named = result.errors
        .map((e) => e.message.trim())
        .filter((m) => m.length > 0)
        .join(" ");
      return {
        tone: "error",
        message: named
          ? `${lead}${named} Nothing was sent.`
          : // No list came back. The generic sentence stays as the floor, so a
            // shape this build does not expect still says the safe thing.
            `${lead}The AlShrouq details were incomplete. Nothing was sent.`,
      };
    }
    case "branch_unresolved":
      return {
        tone: "error",
        message: `${lead}This branch cannot be dispatched to. Nothing was sent.`,
      };
    case "options_unavailable":
      return {
        tone: "error",
        message: `${lead}AlShrouq could not be reached. Nothing was sent.`,
      };
    case "agent_not_configured":
      /*
       * The agent's own CRM link is missing, so the order was not sent.
       *
       * Deliberately not phrased as a failure of the order or of AlShrouq: both
       * are fine. The CRM records a delivery against whichever account created
       * it, so without this agent's own account there is no honest way to send
       * it — and sending it under the deployment's account would put somebody
       * else's name on it, which is why nothing was sent instead.
       */
      return {
        tone: "error",
        message: `${lead}${explainAgentCredentialProblem(result.problem)} Nothing was sent.`,
      };
  }
}

/**
 * Did this outcome leave a dispatch row behind?
 *
 * The signal the UI uses to decide whether to re-read the order's dispatch
 * state. Everything that stops before the gate — `prepared`, `invalid`, an
 * unresolved branch — changed nothing, so re-reading would only spend a request
 * to be told the same thing.
 *
 * **`indeterminate` is in this list, and it is the important entry.** An
 * uncertain send now persists a row that takes the order's dispatch slot, so the
 * page must re-read it: the card has to stop offering to send an order that has
 * already been POSTed. Leaving it out would put the safest state behind the
 * stalest view.
 *
 * A `rejected` 4xx is deliberately absent — the immediate path persists nothing
 * for it, because a 4xx is the CRM saying it understood the request and declined
 * it, and nothing was created.
 */
export function approvalChangedDispatchState(result: ScheduleResult): boolean {
  return (
    result.kind === "scheduled" ||
    result.kind === "dispatched" ||
    result.kind === "already_dispatched" ||
    result.kind === "indeterminate"
  );
}

/** What the agent is told when a cancellation comes back. */
export function describeCancelResult(result: CancelScheduledResult): {
  tone: "success" | "info" | "error";
  message: string;
} {
  switch (result.kind) {
    case "cancelled":
      return {
        tone: "success",
        message: "Scheduled AlShrouq delivery cancelled. No courier was contacted.",
      };
    case "already_cancelled":
      return { tone: "info", message: "This delivery was already cancelled." };
    case "not_found":
      return { tone: "error", message: "There is no scheduled AlShrouq delivery for this order." };
    case "conflict":
      // The server's own sentence, which names the state it refused from.
      return { tone: "error", message: result.message };
  }
}
