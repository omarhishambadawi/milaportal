/**
 * AlShrouq delivery — the contextual card on the order page.
 *
 * Sits in the order form's right-hand column, above `BranchPreviewPanel`,
 * because AlShrouq is the delivery integration an agent acts on and the branch
 * panel is reference. It appears the moment the delivery method is AlShrouq, on
 * a new order as well as a saved one, and reads the form's live state through
 * props: it holds no copy of it, and changing the customer or the branch updates
 * the card without a save or a refresh.
 *
 * **Whether it appears at all is not this component's decision**, and is not the
 * form's live delivery method either — see `showAlShrouqSection` in
 * `dispatch-selection.ts`. A saved order that says AlShrouq, or that has any
 * dispatch history, keeps its card whatever the form is holding; a saved order
 * whose method is changed to something else keeps it until the change is saved,
 * and keeps it afterwards if a courier was ever involved. There is no state in
 * which the order timeline reports a delivery and this card is absent.
 *
 * ## It summarises; it does not run a workflow
 *
 * This card used to contain a complete second dispatch implementation — its own
 * dialog, its own field set, its own validation, its own request. The create
 * journey had another. Two implementations of one handoff is how the two quietly
 * stop sending the same thing, so the dialog is now
 * `AlShrouqApprovalDialog`, shared with the create journey, and the request is
 * built in one place (`approval.ts`) for both.
 *
 * What is left here is a summary of *persisted* state — the dispatch row as the
 * database holds it — plus one action, which exists only while there is
 * something to approve.
 *
 * ## Once it has been handed over, there is no action at all
 *
 * A dispatch is a one-time immutable handoff. When a row exists in any state but
 * cancelled the send control is not rendered — not disabled, not hidden behind a
 * confirmation. `handedOver` is true for `indeterminate` as well as `accepted`,
 * deliberately: an unconfirmed send is exactly the case where a second attempt
 * does the most damage, and the courier may already be moving.
 *
 * Editing the order afterwards changes nothing about the delivery. The card
 * keeps showing the dispatch row, because that is what AlShrouq was told.
 *
 * ## It cannot affect saving an order
 *
 * `orderFormSchema` is untouched, customer name and phone stay optional, and
 * nothing here participates in submit. The card is rendered *by* the form the
 * same way `BranchPreviewPanel` is — a panel that reads state, never one that
 * validates it.
 *
 * ## Why there is no delivery-fee figure
 *
 * `GET /integrations/alshrouq/config` publishes `branch_options`,
 * `payment_options`, webhook settings and `missing_secrets` — and **no fee,
 * price, charge, cost, tariff or rate of any kind**. So no fee is shown, because
 * inventing one is how a number nobody can source ends up on an operations
 * screen.
 */

import { useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import {
  AlertTriangle,
  CalendarClock,
  CalendarX,
  CheckCircle2,
  ClipboardCheck,
  ExternalLink,
  Hourglass,
  Info,
  Link2,
  Loader2,
  MapPin,
  PackageCheck,
  Send,
  Truck,
} from "lucide-react";
import { toast } from "sonner";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Label } from "@/components/ui/label";
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group";
import { Textarea } from "@/components/ui/textarea";
import { fmtSAR } from "@/lib/branches";
import { queryKeys } from "@/lib/query-keys";
import { PANEL_CONTEXT } from "@/lib/panel";
import { cn } from "@/lib/utils";
import {
  alshrouqCancelScheduledDispatch,
  alshrouqDispatchContext,
  alshrouqDispatchOrder,
  alshrouqResolveDispatch,
} from "@/lib/shams.functions";
import {
  ALSHROUQ_RESOLUTION_OUTCOMES,
  RESOLUTION_NOTE_MAX,
  describeResolutionOutcome,
  explainResolutionOutcome,
  isResolutionOutcome,
  isValidResolutionNote,
  resolutionWarningFor,
  type AlShrouqResolutionOutcome,
} from "@/lib/shams-crm/alshrouq-resolution";
import type { AlShrouqFieldError } from "@/lib/shams-crm/alshrouq-payload";
import type { ScheduleResult } from "@/lib/shams-crm/alshrouq-scheduler.server";
import {
  approvalChangedDispatchState,
  describeApprovalResult,
  describeCancelResult,
  dispatchInputFor,
  type AlShrouqApprovalPlan,
} from "../approval";
import {
  // The same absolute-http/https guard the tracking link uses. Aliased because
  // it is applied here to the customer's own map link, and duplicating a URL
  // check is how the two quietly stop agreeing about what is safe to open.
  safeTrackingUrl as safeExternalUrl,
  summariseAlShrouqDispatch,
} from "../dispatch-timeline";
import {
  alshrouqToneStyle,
  explainAlShrouqReadiness,
  explainAlShrouqState,
  type AlShrouqReadiness,
  type AlShrouqTone,
} from "../dispatch-presentation";
import {
  alshrouqOrderValue,
  coverageAllowsDispatch,
  describeBranchCoverage,
} from "../order-requirements";
import type { AlShrouqOrderState } from "../use-alshrouq-order";
import { alshrouqPaymentLabel } from "../payment-methods";
import { formatScheduledFor } from "../scheduling";
import { useOrderAlShrouqDispatch } from "../use-order-dispatch";
import { cardCoverage, shownDispatch } from "../dispatch-selection";
import { useScheduledDispatchCountdown } from "../use-scheduled-countdown";
import { AlShrouqApprovalDialog } from "./approval-dialog";

/** The live form values this card reflects. Read-only — never written back. */
export interface AlShrouqDispatchSectionProps {
  mode: "create" | "edit";
  /** The saved order's id. Absent while the order is still a draft. */
  orderId?: string;
  customerName: string;
  customerPhone: string;
  branchNo: string | null;
  /** The order's own value. Deliberately not a delivery fee. */
  invoiceValue: string;
  /**
   * The AlShrouq half of the order, from the form.
   *
   * The same object the requirements section writes and the approval dialog
   * confirms — one state, so the branch coverage this card reports and the one
   * that decides whether the handover is offered cannot be two different answers.
   */
  alshrouq: AlShrouqOrderState;
}

/**
 * One labelled value in the information grid.
 *
 * `truncate` on the value and `min-w-0` on the cell are what keep this card
 * inside its column: an Arabic branch name or a long customer name shortens
 * rather than widening the grid, so the page never gains a sideways scrollbar on
 * a phone. The full text stays reachable through the tooltip.
 */
function Row({ label, value, muted }: { label: string; value: string; muted?: boolean }) {
  return (
    <div className="min-w-0 space-y-0.5">
      <p className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
        {label}
      </p>
      <p
        className={`truncate text-sm ${muted ? "text-muted-foreground" : "font-medium text-foreground"}`}
        title={value}
        dir="auto"
      >
        {value}
      </p>
    </div>
  );
}

/**
 * The one sentence an agent must not miss once an order has gone.
 *
 * A constant rather than JSX text so it stays a single contiguous string: there
 * is no AlShrouq update endpoint in this integration, and a line break inserted
 * by a formatter is not a good reason for the assertion that guards this wording
 * to stop finding it.
 */
const HANDOVER_NOTICE =
  "AlShrouq submission completed. Changes made in MilaPortal after submission are not sent to AlShrouq.";

/**
 * A full-width sentence in the card's own colour language.
 *
 * The states that need explaining need more room than a badge and less ceremony
 * than a dialog — an uncertain dispatch, a refusal, an operator's conclusion. One
 * component so they line up rather than each inventing its own border.
 */
function Band({
  icon: Icon,
  tone,
  children,
}: {
  icon: typeof Info;
  tone: AlShrouqTone;
  children: React.ReactNode;
}) {
  const style = alshrouqToneStyle(tone);
  return (
    <div
      className={`flex items-start gap-2.5 border-t px-4 py-3 text-[11.5px] leading-snug ${style.band}`}
    >
      <Icon className={`mt-px h-3.5 w-3.5 shrink-0 ${style.icon}`} aria-hidden="true" />
      <div className="min-w-0 flex-1">{children}</div>
    </div>
  );
}

export function AlShrouqDispatchSection({
  mode,
  orderId,
  customerName,
  customerPhone,
  branchNo,
  invoiceValue,
  alshrouq,
}: AlShrouqDispatchSectionProps) {
  const saved = mode === "edit" && !!orderId;

  /**
   * The persisted dispatch, from the shared hook the timeline also reads. One
   * query, one cache entry, so the card and the history cannot disagree.
   */
  const { data: dispatchState, isPending: dispatchPending } = useOrderAlShrouqDispatch(
    orderId,
    saved,
  );
  const current = dispatchState?.current ?? null;

  /**
   * The row the card *reports on*, which is not always the row that owns the
   * slot.
   *
   * `current` is by definition the dispatch that is **not** cancelled, because
   * that is the question the send control has to answer. Reporting on it too
   * meant an order whose only dispatch had been cancelled came back from the
   * orders list looking as though it had never had one — the history was in the
   * timeline and nowhere on the card. So the card falls back to the most recent
   * row, and every state the order has ever been in stays visible when it is
   * reopened.
   *
   * The two are kept apart deliberately: `handedOver` below is derived from
   * `summary`, and a cancelled row correctly reports `handedOver: false`, so
   * falling back here cannot make an order look un-sendable when it is not — nor
   * the reverse, because an *un*cancelled row is always `current` anyway.
   *
   * The rule itself lives in `dispatch-selection.ts`, with the one that decides
   * whether this card is rendered at all, so both are testable without a DOM.
   */
  const shown = shownDispatch(dispatchState?.rows ?? []);
  const summary = useMemo(() => summariseAlShrouqDispatch(shown), [shown]);

  /**
   * Display only. It performs no work and cannot cause any — see the hook.
   *
   * Driven by the row that owns the slot, not the one on display: a cancelled
   * delivery must not count down to a time nobody is going to act on.
   */
  const countdown = useScheduledDispatchCountdown(current?.scheduled_for, current?.dispatch_status);

  /**
   * Branch coverage, payment methods and the order's own details.
   *
   * Only asked for once the order exists — a draft has nothing to dispatch, so a
   * new order costs no CRM call. Its absence degrades the card rather than
   * hiding it: visibility belongs to the delivery method alone.
   */
  const load = useServerFn(alshrouqDispatchContext);
  const {
    data: ctx,
    isPending: ctxPending,
    isError: ctxError,
  } = useQuery({
    queryKey: ["alshrouq", "dispatch-context", orderId],
    enabled: saved,
    retry: false,
    queryFn: () => load({ data: { orderId: orderId! } }),
  });

  const qc = useQueryClient();
  const send = useServerFn(alshrouqDispatchOrder);
  const [open, setOpen] = useState(false);
  const [result, setResult] = useState<ScheduleResult | null>(null);

  /**
   * The approval, through the same server function and the same request shape
   * the create journey uses. This component builds no payload and knows no
   * endpoint — a component that assembled requests is how the previous
   * integration turned a re-render into a second courier.
   */
  const dispatch = useMutation({
    mutationFn: (plan: AlShrouqApprovalPlan) => send({ data: dispatchInputFor(orderId!, plan) }),
    onSuccess: (r) => {
      setResult(r);
      const { tone, message } = describeApprovalResult(r);
      if (tone === "error") toast.error(message);
      else if (tone === "warning") toast.warning(message);
      else if (tone === "success") toast.success(message);
      else toast.info(message);

      if (approvalChangedDispatchState(r)) {
        // The row changed, so re-read it: the card's status, the countdown and
        // the timeline all come from it.
        qc.invalidateQueries({ queryKey: queryKeys.orders.dispatch(orderId) });
        qc.invalidateQueries({ queryKey: ["alshrouq", "dispatch-context", orderId] });
        setOpen(false);
      }
    },
  });

  /**
   * Calling off a scheduled delivery.
   *
   * Contacts nobody: the server refuses anything that is not `scheduled`, and a
   * scheduled dispatch has not been sent. If the worker claimed the row first
   * the server returns a conflict and this reports it rather than pretending the
   * cancellation worked — the row is re-read either way, because the honest
   * state is whatever the database now holds.
   */
  const [confirmingCancel, setConfirmingCancel] = useState(false);
  const cancelFn = useServerFn(alshrouqCancelScheduledDispatch);
  const cancel = useMutation({
    mutationFn: () => cancelFn({ data: { orderId: orderId! } }),
    onSuccess: (r) => {
      const { tone, message } = describeCancelResult(r);
      if (tone === "error") toast.error(message);
      else if (tone === "success") toast.success(message);
      else toast.info(message);
      qc.invalidateQueries({ queryKey: queryKeys.orders.dispatch(orderId) });
    },
    onError: () => {
      toast.error("The delivery could not be cancelled. Nothing was changed.");
    },
    onSettled: () => setConfirmingCancel(false),
  });

  /**
   * Recording what an operator established about a stuck dispatch.
   *
   * Contacts nobody: the server function has no transport in its import graph,
   * and no outcome — including "confirmed not delivered" — sends anything. The
   * row keeps its dispatch slot either way, so this never makes the order
   * sendable again.
   */
  const [resolving, setResolving] = useState(false);
  const [outcome, setOutcome] = useState<AlShrouqResolutionOutcome | null>(null);
  const [note, setNote] = useState("");
  const resolveFn = useServerFn(alshrouqResolveDispatch);
  const resolve = useMutation({
    mutationFn: (input: { outcome: AlShrouqResolutionOutcome; note: string }) =>
      resolveFn({ data: { dispatchId: current!.id, outcome: input.outcome, note: input.note } }),
    onSuccess: (r) => {
      if (r.kind === "resolved") {
        toast.success("Dispatch resolved. The record was updated; nothing was sent to AlShrouq.");
        setResolving(false);
      } else if (r.kind === "already_resolved") {
        toast.info("This dispatch was already resolved by someone else.");
        setResolving(false);
      } else if (r.kind === "not_found") {
        toast.error("That dispatch could not be found.");
      } else {
        // The server's own sentence, naming the state it refused from.
        toast.error(r.message);
      }
      // Whatever happened, the honest state is whatever the database now holds.
      qc.invalidateQueries({ queryKey: queryKeys.orders.dispatch(orderId) });
      qc.invalidateQueries({ queryKey: queryKeys.orders.activity(orderId!) });
    },
    onError: () => {
      toast.error("The dispatch could not be resolved. Nothing was changed.");
    },
  });

  const errors: AlShrouqFieldError[] = result?.kind === "invalid" ? result.errors : [];
  /**
   * Branch coverage — from the form while it is answering, from the order
   * otherwise.
   *
   * The form's answer is the live one and is preferred whenever the form is
   * actually about an AlShrouq delivery: an agent changing the branch sees
   * coverage follow, which is the point of rendering this beside the fields.
   *
   * But `useAlShrouqOrder` short-circuits to `{ kind: "no_branch" }` the moment
   * `form.delivery_type` is not AlShrouq — and that produced the worst screen
   * this card has shown. A saved AlShrouq order whose form had not put the
   * method back yet reported **"Not available — choose a branch to check
   * AlShrouq coverage"** next to a branch that was plainly filled in, on an
   * order the agent had just created *with* a handover. Transient state was
   * being read as a fact about the order.
   *
   * `ctx.branch` is the same resolution made server-side from the order's own
   * `branch_no`, against the same live `branch_options`. It is already fetched
   * — no second query, no new state — so it is what the card falls back to.
   */
  const coverage = cardCoverage(alshrouq.active, alshrouq.coverage, ctx?.branch);
  const covered = coverageAllowsDispatch(coverage);

  /**
   * Whether a courier can be reached from this deployment at all.
   *
   * Reported by the server alongside the branch resolution. Undefined while the
   * context is still loading, and treated as *available* until it answers — the
   * card must not flash "switched off" at an agent on every page load, and the
   * states below already hold the action back while `ctxPending`.
   */
  const canContactCourier = ctx?.dispatchAvailable !== false;

  /**
   * Whether anything may still be approved.
   *
   * Never true once a dispatch exists. `dispatchPending` keeps the action out of
   * the way until the row is known, so a slow query cannot briefly offer "Send"
   * on an order that has already gone.
   *
   * A deployment that cannot reach a courier is excluded here, which is what
   * withholds the send control for a handover that would stop at the gate. The
   * order and its details are untouched by this — only the promise is withdrawn.
   */
  const ready =
    saved && !dispatchPending && !summary.handedOver && !!ctx && covered && canContactCourier;

  /**
   * Where the agent is *before* anything has been approved.
   *
   * This is not a dispatch state — there is no dispatch. It is the reason the
   * send control is or is not offered, phrased as a next step rather than as a
   * status, and it is consulted only while the row is absent.
   */
  const readiness: AlShrouqReadiness = !saved
    ? "draft"
    : // `optionsPending` only counts while the *form* is the one answering.
      // React Query reports a disabled query as pending, so on a saved order
      // whose form is not currently an AlShrouq one this was true forever —
      // and the card sat on "Checking…" waiting for a request nobody had made.
      dispatchPending || ctxPending || (alshrouq.active && alshrouq.optionsPending)
      ? "checking"
      : ctxError
        ? "unverified"
        : covered
          ? // Coverage is about the branch and the gate is about the deployment.
            // Both have to be right before anything may be offered, and they are
            // reported separately so the agent is told which one is missing.
            canContactCourier
            ? "ready"
            : "prepared_only"
          : "unavailable";

  /**
   * Never a state the backend cannot support, and never a fake "Sent".
   *
   * A persisted row wins outright and the readiness is the fallback, rather than
   * the other way round: a status this build does not recognise must still be
   * reported rather than being papered over with "Ready to send". The row on
   * display may be a cancelled one — see `shown` — so this badge names a
   * cancellation instead of pretending the order never had a delivery.
   */
  const status: { label: string; tone: AlShrouqTone } =
    summary.status !== null
      ? { label: summary.label, tone: summary.tone }
      : readiness === "draft"
        ? { label: "Pending order creation", tone: "muted" }
        : readiness === "checking"
          ? { label: "Checking…", tone: "muted" }
          : readiness === "unverified"
            ? { label: "Verification required", tone: "warning" }
            : readiness === "ready"
              ? { label: "Ready to send", tone: "info" }
              : readiness === "prepared_only"
                ? // Not "Ready to send", because it is not, and not an error
                  // either: the order is complete and correct. It is prepared,
                  // and the courier step is the part that cannot run here.
                  { label: "Prepared — dispatch unavailable", tone: "warning" }
                : { label: "Not available", tone: "warning" };

  const tone = alshrouqToneStyle(status.tone);

  /**
   * The line under the badge: what this state means for the person reading it.
   *
   * "Scheduled" and "Delivery status unavailable" are accurate and neither
   * answers *what do I do now*. The sentences live in `dispatch-presentation.ts`
   * so the card, the timeline and the tests read one vocabulary.
   */
  const meaning =
    summary.status !== null ? explainAlShrouqState(summary) : explainAlShrouqReadiness(readiness);

  /**
   * Whether AlShrouq may actually be holding this order.
   *
   * Narrower than `handedOver` on purpose. That flag is about the *slot* — it is
   * true for `scheduled`, which reserves one without anybody having been
   * contacted — and the handover notice is about a submission that has happened.
   * Telling an agent their edits will not reach AlShrouq, beside a delivery
   * AlShrouq has never been told about, is false; and a line that is sometimes
   * false is a line agents learn to skip, including on the states where it is
   * the most important sentence on the card.
   */
  const submitted =
    summary.handedOver && summary.status !== "scheduled" && summary.status !== "failed";

  /**
   * The order's identity, form-first and persisted-second.
   *
   * The form is preferred because the card sits beside it and should follow an
   * edit. The fallback is what stops a saved order describing itself as empty
   * when the form has not put its values back — the same reason `coverage`
   * falls back above, and the same values the approval dialog already reads.
   */
  const orderBranchNo = branchNo || ctx?.branchNo || null;
  const orderCustomerName = customerName.trim() || ctx?.prefill.customerName.trim() || "";
  const orderCustomerPhone = customerPhone.trim() || ctx?.prefill.customerPhone.trim() || "";

  const branchValue = orderBranchNo
    ? coverage.kind === "covered" && coverage.branchName
      ? `${orderBranchNo} · ${coverage.branchName}`
      : orderBranchNo
    : "Select a branch";

  /**
   * The payment method — as approved if it has been, as saved otherwise.
   *
   * The dispatch row stores the CRM's own id and is the authority once a
   * handover exists: it is what AlShrouq was actually told. Before that there is
   * no row, and the answer is the order's own `alshrouq_payment_type`, which the
   * form now carries. It used to be the row or nothing, so a saved order with a
   * payment method chosen and no dispatch yet reported **"Select at dispatch"**
   * — asking again for something already on the order.
   *
   * The label comes from the live option list when there is one. It used to end
   * `?? stored`, which is how this card came to tell an agent their delivery's
   * payment type was **3**: the option list is fetched, so it is empty on first
   * render and empty for good whenever the CRM cannot be reached, and the
   * fallback printed the raw CRM id. `alshrouqPaymentLabel` names the method
   * instead, from the CRM's own published names.
   */
  const paymentLabel = useMemo(
    () =>
      alshrouqPaymentLabel(
        shown?.payment_type ?? alshrouq.paymentType,
        alshrouq.options.paymentOptions,
      ),
    [shown?.payment_type, alshrouq.paymentType, alshrouq.options.paymentOptions],
  );

  /**
   * The delivery point, from the dispatch if there is one and the order if not.
   *
   * Same rule as the payment method, and the same bug before it: the point an
   * agent resolved at order time is on the order, and showing nothing until a
   * courier had been told about it made a fully-configured order look empty.
   */
  const coordinates =
    shown?.customer_lat != null && shown?.customer_lng != null
      ? { lat: String(shown.customer_lat), lng: String(shown.customer_lng) }
      : alshrouq.latitude && alshrouq.longitude
        ? { lat: alshrouq.latitude, lng: alshrouq.longitude }
        : null;

  /**
   * The stored `customer_address`, which is the customer's own map link in
   * almost every real delivery — 104 of the CRM's 126 carry an unresolved short
   * link — but is free text in the rest. Falls back to the order's own
   * `alshrouq_map_url` for the same reason as the two above.
   *
   * Checked with the same guard the tracking link uses rather than a second
   * one: http/https and absolute only, so no stored value can reach an anchor as
   * a `javascript:` destination or be read as a Portal route. A value that fails
   * it is shown as the text it is.
   */
  const locationText = shown?.customer_address?.trim() || alshrouq.mapUrl.trim() || null;
  const customerLink = safeExternalUrl(locationText);

  /**
   * The driver's note — the delivery's own, and only that.
   *
   * It used to fall back to the order's `notes` column, on the belief that the
   * two were one field. They are not, and the fallback was a claim this card had
   * no evidence for: an internal remark typed on the order page would appear
   * here as **Delivery note**, describing instructions no courier was ever
   * given. The row's `details` is what AlShrouq was actually told; absent means
   * absent, and the block below simply does not render.
   */
  const deliveryNote = shown?.details?.trim() || null;

  /**
   * What the card says the order is worth *before* a handover exists.
   *
   * Zero on a prepaid method, for the same reason the payload sends zero: this
   * figure is what a driver would be told to collect, and the card is where an
   * agent checks it before approving. Once `shown.value` exists it wins — that
   * is what AlShrouq was actually told, and the card must not restate it.
   */
  const cardOrderValue = alshrouqOrderValue(invoiceValue, alshrouq.paidPayment);

  return (
    <>
      <Card className={PANEL_CONTEXT.surface}>
        <header className={cn("flex items-start gap-3", PANEL_CONTEXT.header)}>
          <span
            aria-hidden
            className="grid h-7 w-7 shrink-0 place-items-center rounded-md bg-primary/10 text-primary ring-1 ring-inset ring-primary/15"
          >
            <Truck className="h-3.5 w-3.5" />
          </span>
          <div className="min-w-0 flex-1">
            {/* Title and state on one wrapping line: on a phone the badge drops
                below the heading instead of squeezing it. */}
            <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
              <h2 className="text-sm font-semibold leading-none tracking-tight text-foreground">
                AlShrouq delivery
              </h2>
              <Badge
                variant="secondary"
                className={`border-transparent px-2 py-0.5 text-[10px] font-semibold ${tone.badge}`}
              >
                {status.label}
              </Badge>
            </div>
            {/* What that state means, not what it is called. */}
            <p className="mt-1.5 text-[11.5px] leading-snug text-muted-foreground">{meaning}</p>
          </div>
        </header>

        <div
          className={cn("grid grid-cols-1 gap-x-4 gap-y-3.5 sm:grid-cols-2", PANEL_CONTEXT.body)}
        >
          <Row
            label="Order reference"
            value={saved ? (ctx?.displayNo ?? "—") : "Assigned after the order is created"}
            muted={!saved}
          />
          {/* Form first, because an agent editing the order should watch these
              follow — but the *order's* own values when the form has none, so a
              saved order never describes itself as blank. `ctx.prefill` is the
              persisted row, already fetched; the approval dialog below reads it
              the same way. */}
          <Row label="Branch" value={branchValue} muted={!orderBranchNo} />
          <Row label="Customer" value={orderCustomerName || "—"} muted={!orderCustomerName} />
          <Row label="Phone" value={orderCustomerPhone || "—"} muted={!orderCustomerPhone} />
          <Row
            label="Payment type"
            value={paymentLabel ?? "Select at dispatch"}
            muted={!paymentLabel}
          />
          <Row
            label="Order value"
            value={
              // Once handed over, the figure that was approved — not whatever
              // the order says now.
              shown?.value != null
                ? fmtSAR(Number(shown.value))
                : cardOrderValue.trim()
                  ? fmtSAR(Number(cardOrderValue))
                  : "—"
            }
            muted={shown?.value == null && !cardOrderValue.trim()}
          />
        </div>

        {/* --------------------------------------------------------------
            The delivery location, presented as verified order information.

            Persisted values only — nothing here is derived from the form:
            it is what AlShrouq was told. Two facts, deliberately kept
            apart because they answer two different questions: the link the
            customer themself sent, and the point a courier routes to. The
            coordinates were never typed — they are the product of
            resolving that link — so they read as evidence rather than as a
            field somebody could have got wrong.
            -------------------------------------------------------------- */}
        {(customerLink || locationText || coordinates) && (
          <div className="space-y-2 border-t border-border/60 px-4 py-3">
            <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
              <p className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
                Delivery location
              </p>
              {/* Only claimed once there is a point. A link nobody could
                  resolve is not a verified location. */}
              {coordinates && (
                <span className="inline-flex items-center gap-1 rounded-full bg-success/10 px-1.5 py-0.5 text-[10px] font-semibold text-success">
                  <CheckCircle2 className="h-3 w-3" aria-hidden="true" />
                  Verified
                </span>
              )}
            </div>

            {/* The customer's own link, opened rather than read: it is a URL,
                and printing it as text asks an agent to copy it by hand. */}
            {customerLink ? (
              <a
                href={customerLink}
                target="_blank"
                rel="noopener noreferrer"
                className="inline-flex max-w-full items-center gap-1.5 text-sm font-medium text-primary hover:underline"
                title={customerLink}
              >
                <Link2 className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
                <span className="truncate">Location shared by the customer</span>
                <ExternalLink className="h-3 w-3 shrink-0" aria-hidden="true" />
              </a>
            ) : (
              locationText && (
                <p className="truncate text-sm font-medium" title={locationText} dir="auto">
                  {locationText}
                </p>
              )
            )}

            {/* The point itself, labelled, so "24.71360" is never mistaken for
                a reference number. */}
            {coordinates && (
              <p className="flex flex-wrap items-center gap-x-2 gap-y-0.5 font-mono text-xs text-muted-foreground">
                <MapPin className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
                <span>
                  <span className="font-sans text-[11px] uppercase tracking-wide">Lat</span>{" "}
                  {coordinates.lat}
                </span>
                <span>
                  <span className="font-sans text-[11px] uppercase tracking-wide">Lng</span>{" "}
                  {coordinates.lng}
                </span>
              </p>
            )}
          </div>
        )}

        {/* --------------------------------------------------------------
            The note the driver was given.

            The row's own `details`, frozen at approval — not `notes` from the
            form. The order's note can be edited afterwards and AlShrouq is
            never told, so showing the live one here would claim a driver had
            been given instructions nobody sent. Absent until an approval has
            written one, which is why the whole block is conditional rather
            than a row reading "—".
            -------------------------------------------------------------- */}
        {deliveryNote && (
          <div className="space-y-1 border-t border-border/60 px-4 py-3">
            <p className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
              Delivery note
            </p>
            <p className="whitespace-pre-wrap break-words text-sm text-foreground" dir="auto">
              {deliveryNote}
            </p>
          </div>
        )}

        {/* The scheduled slot and how long is left. The countdown is display
            only — the dispatch is performed server-side by pg_cron and the
            worker, whether or not this page is open. */}
        {summary.scheduledFor && (
          <div className="grid grid-cols-1 gap-x-4 gap-y-3 border-t border-border/60 bg-muted/20 px-4 py-3 dark:bg-muted/10 sm:grid-cols-2">
            <div className="min-w-0 space-y-1">
              <p className="flex items-center gap-1.5 text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
                <CalendarClock className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
                Scheduled for
              </p>
              <p className="truncate text-sm font-semibold text-foreground">
                {formatScheduledFor(summary.scheduledFor) ?? "—"}
              </p>
            </div>
            <div className="min-w-0 space-y-1">
              <p className="flex items-center gap-1.5 text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
                <Hourglass className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
                {countdown.state === "waiting" ? "Dispatch begins in" : "Status"}
              </p>
              {/* Emphasised while it is still counting, because that figure is
                  the one an agent came to the card for. `tabular-nums` so the
                  digits do not jitter as the minutes tick. */}
              <p
                className={`truncate text-sm font-semibold tabular-nums ${
                  countdown.state === "waiting" ? "text-primary" : "text-foreground"
                }`}
              >
                {countdown.state === "waiting"
                  ? countdown.remainingLabel
                  : countdown.state === "due"
                    ? /* The moment has passed and the worker has not reported
                         yet. Nothing has been sent, and this must not read as
                         though it had. */
                      "Awaiting dispatch"
                    : /* No longer waiting: the persisted status is the truth,
                         whatever the clock says. */
                      summary.label}
              </p>
            </div>

            {/* Why a delivery that is past its time still has not gone out.
                Rendered only when the row says something — the ordinary wait
                says nothing and shows nothing.

                This is the case the card used to have no answer for: an agent
                looking at a countdown that had reached zero saw "Awaiting
                dispatch" for two days, with the reason sitting unread in the
                row all along. */}
            {summary.waitingProblem && (
              <div className="min-w-0 space-y-1 sm:col-span-2">
                <p className="flex items-center gap-1.5 text-[11px] font-medium uppercase tracking-wide text-amber-700 dark:text-amber-500">
                  <AlertTriangle className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
                  Not sent yet
                </p>
                <p className="text-sm text-amber-800 dark:text-amber-400">
                  {summary.waitingProblem}
                </p>
              </div>
            )}
          </div>
        )}

        {/* The two states that need a sentence rather than a badge.

            `indeterminate` gets fixed copy, because the one thing an agent must
            take from it is that nothing was retried — reading it as a failure is
            what makes someone send it again. `failed` shows the persisted
            reason, but only through `safeFailureReason`, which drops anything
            shaped like a URL, a header, a token or a stack trace. */}
        {(summary.status === "indeterminate" || summary.status === "failed") && (
          <Band icon={AlertTriangle} tone="danger">
            <p>
              {summary.status === "indeterminate"
                ? "AlShrouq response could not be confirmed. The order has not been automatically retried. Check with AlShrouq before anyone sends it again."
                : (summary.failureReason ??
                  "AlShrouq did not accept this delivery. Nothing was sent.")}
            </p>
          </Band>
        )}

        {/* The operator's answer, once somebody has established one.

            Shown beside the machine's own state rather than instead of it: the
            dispatch is still `indeterminate` or `failed`, because that is what
            actually happened, and this line is a person's conclusion about it.
            Attributed as such so it can never read as a courier status. */}
        {summary.resolutionOutcome && (
          <Band icon={ClipboardCheck} tone="muted">
            <p>
              <span className="font-medium text-foreground">
                Resolved by operator:{" "}
                {isResolutionOutcome(summary.resolutionOutcome)
                  ? describeResolutionOutcome(summary.resolutionOutcome)
                  : "outcome recorded"}
              </span>
              . This is a reviewed decision, not a courier update. The order was not sent again.
            </p>
          </Band>
        )}

        {/* The sentence that stops an agent believing a later edit reaches the
            courier. It used to be the header's grey subtitle, where the one line
            an agent must not miss was the smallest text on the card. */}
        {submitted && (
          <Band icon={PackageCheck} tone="muted">
            <p>{HANDOVER_NOTICE}</p>
          </Band>
        )}

        {(!covered || !saved) && !summary.handedOver && (
          <Band icon={Info} tone={readiness === "draft" ? "muted" : "warning"}>
            <p>
              {!saved
                ? "This order has not been created yet. AlShrouq does not publish delivery fees, so none is shown here."
                : ctxError
                  ? "Delivery options could not be loaded. You may not have permission to send this order."
                  : describeBranchCoverage(coverage)}
            </p>
          </Band>
        )}

        <div className="flex flex-wrap items-center justify-end gap-2 border-t border-border/60 px-4 py-3">
          {summary.handedOver ? (
            <>
              {/* The reference stays visible whether or not tracking exists. It
                  is the number an agent quotes on the phone, so it is selectable
                  and set in the same mono face as the coordinates. */}
              {(submitted || summary.externalOrderId) && (
                <span className="mr-auto flex min-w-0 items-center gap-1.5 text-xs text-muted-foreground">
                  <PackageCheck className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
                  {summary.externalOrderId ? (
                    <span className="min-w-0 truncate">
                      Reference{" "}
                      <span className="font-mono font-medium text-foreground">
                        {summary.externalOrderId}
                      </span>
                    </span>
                  ) : (
                    <span className="min-w-0 truncate">No AlShrouq reference yet</span>
                  )}
                </span>
              )}
              {/* Rendered only when the reconciliation persisted a URL. No
                  disabled placeholder, and nothing is assembled from the
                  reference — the destination comes from AlShrouq or not at all. */}
              {summary.trackingUrl && (
                <Button variant="outline" size="sm" asChild>
                  <a href={summary.trackingUrl} target="_blank" rel="noopener noreferrer">
                    <ExternalLink className="mr-2 h-3.5 w-3.5" aria-hidden="true" />
                    Open tracking
                  </a>
                </Button>
              )}
              {/* Only for a dispatch the machine gave up on and nobody has
                  settled yet — `indeterminate` or `failed`, with no answer
                  recorded. Never for scheduled, processing, accepted, cancelled
                  or an already-resolved row, and the server refuses those
                  independently of whether this renders. */}
              {summary.awaitingResolution && current && (
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => {
                    setOutcome(null);
                    setNote("");
                    resolve.reset();
                    setResolving(true);
                  }}
                  disabled={resolve.isPending}
                >
                  <ClipboardCheck className="mr-2 h-3.5 w-3.5" aria-hidden="true" />
                  Resolve dispatch
                </Button>
              )}
              {/* Only while the dispatch is still parked. A claimed, sent or
                  unconfirmed delivery cannot be called off from here, and the
                  server refuses it independently of whether this renders. */}
              {summary.awaitingSchedule && (
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => setConfirmingCancel(true)}
                  disabled={cancel.isPending}
                >
                  {cancel.isPending ? (
                    <Loader2 className="mr-2 h-3.5 w-3.5 animate-spin" aria-hidden="true" />
                  ) : (
                    <CalendarX className="mr-2 h-3.5 w-3.5" aria-hidden="true" />
                  )}
                  {cancel.isPending ? "Cancelling…" : "Cancel scheduled delivery"}
                </Button>
              )}
            </>
          ) : !saved ? (
            /* A draft has nothing to hand over, and a permanently disabled
               button beside it invites a click that can never work. The create
               journey's approval lives on the page's own primary action, so this
               says where to find it rather than imitating it here. */
            <p className="min-w-0 flex-1 text-[11.5px] leading-snug text-muted-foreground">
              Choose <span className="font-medium text-foreground">Create order</span> at the top of
              the page to decide between saving this order only and sending it to AlShrouq.
            </p>
          ) : (
            /* The only send control on this page. It is absent — not disabled —
               once a dispatch exists, so there is nothing to click twice. */
            <Button
              size="sm"
              className="w-full sm:w-auto"
              onClick={() => {
                setResult(null);
                dispatch.reset();
                setOpen(true);
              }}
              disabled={!ready}
              title={ready ? undefined : status.label}
            >
              {(ctxPending || dispatchPending) && saved ? (
                <Loader2 className="mr-2 h-3.5 w-3.5 animate-spin" aria-hidden="true" />
              ) : (
                <Send className="mr-2 h-3.5 w-3.5" aria-hidden="true" />
              )}
              Send to AlShrouq
            </Button>
          )}
        </div>
      </Card>

      <AlertDialog
        open={resolving}
        onOpenChange={(open) => !resolve.isPending && setResolving(open)}
      >
        <AlertDialogContent className="max-h-[85vh] overflow-y-auto">
          <AlertDialogHeader>
            <AlertDialogTitle>Resolve this dispatch</AlertDialogTitle>
            <AlertDialogDescription asChild>
              <div className="space-y-2 text-sm">
                <p>{resolutionWarningFor(summary.status)}</p>
                <p className="text-muted-foreground">
                  Record what you established after checking with AlShrouq. This is kept as an
                  operator decision and is never shown as a courier update.
                </p>
              </div>
            </AlertDialogDescription>
          </AlertDialogHeader>

          <div className="space-y-4">
            <RadioGroup
              value={outcome ?? ""}
              onValueChange={(v) => isResolutionOutcome(v) && setOutcome(v)}
              className="gap-2"
            >
              {ALSHROUQ_RESOLUTION_OUTCOMES.map((option) => (
                <label
                  key={option}
                  htmlFor={`resolve-${option}`}
                  className="flex cursor-pointer items-start gap-2.5 rounded-md border border-border/60 p-3"
                >
                  <RadioGroupItem value={option} id={`resolve-${option}`} className="mt-0.5" />
                  <span className="min-w-0">
                    <span className="block text-sm font-medium text-foreground">
                      {describeResolutionOutcome(option)}
                    </span>
                    <span className="block text-[11.5px] leading-snug text-muted-foreground">
                      {explainResolutionOutcome(option)}
                    </span>
                  </span>
                </label>
              ))}
            </RadioGroup>

            <div className="space-y-1.5">
              <Label htmlFor="resolve-note">How was this established?</Label>
              <Textarea
                id="resolve-note"
                rows={2}
                maxLength={RESOLUTION_NOTE_MAX}
                placeholder="e.g. Confirmed by phone with AlShrouq operations."
                value={note}
                onChange={(e) => setNote(e.target.value)}
              />
              {/* The note is the evidence, and it is shown on the order
                  timeline — so it is a place for how you know, not for the
                  customer's details. */}
              <p className="text-[11px] text-muted-foreground">
                Required. Shown on the order timeline, so do not include customer contact details.
              </p>
            </div>
          </div>

          <AlertDialogFooter>
            <AlertDialogCancel disabled={resolve.isPending}>Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={(event) => {
                // The mutation closes the dialog on its result, not on the click.
                event.preventDefault();
                if (outcome && isValidResolutionNote(note)) resolve.mutate({ outcome, note });
              }}
              disabled={resolve.isPending || !outcome || !isValidResolutionNote(note)}
            >
              {resolve.isPending ? "Recording…" : "Record resolution"}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      <AlertDialog open={confirmingCancel} onOpenChange={setConfirmingCancel}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Cancel the scheduled AlShrouq delivery?</AlertDialogTitle>
            <AlertDialogDescription asChild>
              <div className="space-y-2 text-sm">
                <p>
                  This delivery is scheduled for{" "}
                  <span className="font-medium text-foreground">
                    {formatScheduledFor(summary.scheduledFor) ?? "a scheduled time"}
                  </span>{" "}
                  and <span className="font-medium text-foreground">has not been sent</span>. No
                  courier has been contacted, and cancelling contacts nobody either.
                </p>
                <p className="text-muted-foreground">
                  The order itself stays in MilaPortal, unchanged. If AlShrouq has already started
                  processing this delivery it cannot be cancelled here, and you will be told so.
                </p>
              </div>
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={cancel.isPending}>Keep it scheduled</AlertDialogCancel>
            <AlertDialogAction
              onClick={(event) => {
                // Handled by the mutation, so the dialog closes on the result
                // rather than the moment the button is pressed.
                event.preventDefault();
                cancel.mutate();
              }}
              disabled={cancel.isPending}
            >
              {cancel.isPending ? "Cancelling…" : "Cancel delivery"}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      {/* The shared dialog — the same one the create journey opens. Mounted only
          while there is something to approve. */}
      {ready && (
        <AlShrouqApprovalDialog
          mode="existing"
          open={open}
          onOpenChange={setOpen}
          alshrouq={alshrouq}
          customerName={ctx?.prefill.customerName || customerName}
          customerPhone={ctx?.prefill.customerPhone || customerPhone}
          branchNo={branchNo}
          displayNo={ctx?.displayNo ?? null}
          invoiceValue={ctx?.prefill.orderValue || invoiceValue}
          // The delivery's own note, if this order already has a delivery —
          // never the order's `notes` column. The dialog collects a fresh one
          // otherwise; see `AlShrouqApprovalDialog`.
          details={shown?.details ?? ""}
          dispatchAvailable={canContactCourier}
          errors={errors}
          result={result}
          busy={dispatch.isPending}
          onApprove={(plan) => dispatch.mutate(plan)}
        />
      )}
    </>
  );
}
