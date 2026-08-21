/**
 * Sequencing "create the order" and "hand it to a courier".
 *
 * The two are separate operations against separate systems, and this hook is
 * what keeps them in the right order without pretending they are one
 * transaction. There is no transaction available across them — the order is
 * inserted through Supabase and the dispatch is approved through a server
 * function — so the design makes the *partial* state a safe one instead:
 *
 *   order insert fails      → nothing else runs. No dispatch, no navigation.
 *   order created, approval fails → an ordinary saved order, no dispatch row,
 *                                   no courier contacted. Exactly the state
 *                                   "Create order only" produces, and the agent
 *                                   can approve from the order page afterwards.
 *   order created + scheduled     → order + a `scheduled` row holding a frozen
 *                                   snapshot. Still no courier.
 *   order created + immediate     → order + whatever the server's one POST
 *                                   actually achieved.
 *
 * The dangerous inverse — a dispatch with no order — cannot happen, because
 * approving one requires an order id that only a successful insert produces.
 *
 * ## The approval never decides whether to send
 *
 * It carries a time, not a permission. The server compares that time to its own
 * clock to choose scheduling over immediate dispatch, and the safety gate sits
 * behind both. A browser with a wrong clock, or a crafted request, changes
 * neither.
 */

import { useCallback, useRef, useState } from "react";
import { toast } from "sonner";
import { useServerFn } from "@tanstack/react-start";
import { alshrouqDispatchOrder } from "@/lib/shams.functions";
import type { ScheduleResult } from "@/lib/shams-crm/alshrouq-scheduler.server";
import type { AlShrouqApprovalPlan } from "./components/create-approval-dialog";
import { formatScheduledFor } from "./scheduling";

export interface AlShrouqCreateApprovalState {
  isOpen: boolean;
  open: () => void;
  setOpen: (open: boolean) => void;
  /** The last approval outcome, for the page to show. */
  result: ScheduleResult | null;
  /** Records the agent's choice and submits the form. */
  approve: (plan: AlShrouqApprovalPlan, submitForm: () => void) => void;
  /** Handed to `useOrderForm`; runs once, after a successful insert. */
  afterCreate: (orderId: string) => Promise<void>;
}

/** What the agent is told, per outcome. Never "sent" without evidence. */
function announce(result: ScheduleResult): void {
  switch (result.kind) {
    case "scheduled":
      toast.success(
        `Order created. AlShrouq will be contacted at ${formatScheduledFor(result.scheduledFor)}.`,
      );
      return;
    case "dispatched":
      toast.success(
        result.dispatch.externalOrderId
          ? `Order created and sent to AlShrouq — reference ${result.dispatch.externalOrderId}.`
          : "Order created and sent to AlShrouq.",
      );
      return;
    case "already_dispatched":
      toast.info(
        "Order created. This order already had an AlShrouq delivery, so it was not sent again.",
      );
      return;
    case "prepared":
      // The gate is shut. Saying "sent" here would be the single most damaging
      // thing this hook could do.
      toast.info("Order created. AlShrouq dispatch is switched off, so no courier was contacted.");
      return;
    case "rejected":
      toast.error("Order created, but AlShrouq refused the delivery. No courier was sent.");
      return;
    case "indeterminate":
      toast.warning(
        "Order created. The AlShrouq result is unknown and it has NOT been retried — check with AlShrouq before anyone sends it again.",
      );
      return;
    case "invalid":
      toast.error("Order created, but the AlShrouq details were incomplete. Nothing was sent.");
      return;
    case "branch_unresolved":
      toast.error("Order created, but this branch cannot be dispatched to. Nothing was sent.");
      return;
    case "options_unavailable":
      toast.error("Order created, but AlShrouq could not be reached. Nothing was sent.");
      return;
  }
}

export function useAlShrouqCreateApproval(): AlShrouqCreateApprovalState {
  const [isOpen, setOpen] = useState(false);
  const [result, setResult] = useState<ScheduleResult | null>(null);
  /** Held in a ref: the form submits immediately and must see the final value. */
  const plan = useRef<AlShrouqApprovalPlan | null>(null);
  const send = useServerFn(alshrouqDispatchOrder);

  const approve = useCallback((next: AlShrouqApprovalPlan, submitForm: () => void) => {
    plan.current = next;
    setResult(null);
    setOpen(false);
    submitForm();
  }, []);

  const afterCreate = useCallback(
    async (orderId: string) => {
      const current = plan.current;
      plan.current = null;
      // "Create order only" is a complete outcome, not a skipped step.
      if (!current || current.intent !== "dispatch") return;

      try {
        const outcome = await send({
          data: {
            orderId,
            customerName: current.customerName,
            customerPhone: current.customerPhone,
            paymentType: current.paymentType,
            mapUrl: current.mapUrl,
            lat: current.lat,
            lng: current.lng,
            orderValue: current.orderValue,
            details: "",
            scheduledFor: current.scheduledFor,
          },
        });
        setResult(outcome);
        announce(outcome);
      } catch {
        // The order is saved and correct; only the courier step failed, and it
        // failed before contacting anyone.
        toast.error("Order created, but the AlShrouq approval failed. Nothing was sent.");
      }
    },
    [send],
  );

  const open = useCallback(() => setOpen(true), []);

  return { isOpen, open, setOpen, result, approve, afterCreate };
}
