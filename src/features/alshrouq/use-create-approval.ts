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
import { useQueryClient } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { alshrouqDispatchOrder } from "@/lib/shams.functions";
import { queryKeys } from "@/lib/query-keys";
import type { ScheduleResult } from "@/lib/shams-crm/alshrouq-scheduler.server";
import {
  approvalChangedDispatchState,
  describeApprovalResult,
  dispatchInputFor,
  type AlShrouqApprovalPlan,
} from "./approval";

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

/**
 * What the agent is told, per outcome.
 *
 * The wording lives in `describeApprovalResult`, shared with the order page, so
 * the same server result cannot be reported two different ways depending on
 * which screen the agent happened to approve from. Only the "Order created."
 * opening clause belongs to this journey.
 */
function announce(result: ScheduleResult): void {
  const { tone, message } = describeApprovalResult(result, true);
  if (tone === "error") toast.error(message);
  else if (tone === "warning") toast.warning(message);
  else if (tone === "success") toast.success(message);
  else toast.info(message);
}

export function useAlShrouqCreateApproval(): AlShrouqCreateApprovalState {
  const [isOpen, setOpen] = useState(false);
  const [result, setResult] = useState<ScheduleResult | null>(null);
  /** Held in a ref: the form submits immediately and must see the final value. */
  const plan = useRef<AlShrouqApprovalPlan | null>(null);
  const send = useServerFn(alshrouqDispatchOrder);
  const qc = useQueryClient();

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
        // Built by the same function the order page uses, so both journeys send
        // the identical request shape to the identical server function.
        const outcome = await send({ data: dispatchInputFor(orderId, current) });
        setResult(outcome);
        announce(outcome);
        if (approvalChangedDispatchState(outcome)) {
          // The new order's page reads its dispatch row from the shared query;
          // seed nothing, just make sure it is not served a cached absence.
          qc.invalidateQueries({ queryKey: queryKeys.orders.dispatch(orderId) });
        }
      } catch {
        // The order is saved and correct; only the courier step failed, and it
        // failed before contacting anyone.
        toast.error("Order created, but the AlShrouq approval failed. Nothing was sent.");
      }
    },
    [send, qc],
  );

  const open = useCallback(() => setOpen(true), []);

  return { isOpen, open, setOpen, result, approve, afterCreate };
}
