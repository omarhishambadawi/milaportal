/**
 * AlShrouq delivery — the contextual card on the order page.
 *
 * Sits in the order form's right-hand column, above `BranchPreviewPanel`,
 * because AlShrouq is the delivery integration an agent acts on and the branch
 * panel is reference. It appears the moment the delivery method is AlShrouq, on
 * a new order as well as a saved one, and reads the form's live state through
 * props: it holds no copy of it, and changing the customer, the branch or the
 * delivery method updates or removes the card without a save or a refresh.
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
import { ExternalLink, Info, Loader2, MapPin, PackageCheck, Send, Truck } from "lucide-react";
import { toast } from "sonner";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { fmtSAR } from "@/lib/branches";
import { queryKeys } from "@/lib/query-keys";
import {
  alshrouqDispatchContext,
  alshrouqDispatchOrder,
  type AlShrouqDispatchContext,
} from "@/lib/shams.functions";
import type { AlShrouqFieldError } from "@/lib/shams-crm/alshrouq-payload";
import type { ScheduleResult } from "@/lib/shams-crm/alshrouq-scheduler.server";
import {
  approvalChangedDispatchState,
  describeApprovalResult,
  dispatchInputFor,
  type AlShrouqApprovalPlan,
} from "../approval";
import { summariseAlShrouqDispatch } from "../dispatch-timeline";
import { formatScheduledFor } from "../scheduling";
import { useOrderAlShrouqDispatch } from "../use-order-dispatch";
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
  notes: string;
}

function branchLine(ctx: AlShrouqDispatchContext): { text: string; ok: boolean } {
  const b = ctx.branch;
  if (b.kind === "resolved") return { text: b.branchName ?? "Covered", ok: true };
  if (b.kind === "not_covered") return { text: "AlShrouq does not cover this branch", ok: false };
  if (b.reason === "no_branch_on_order") return { text: "Select a branch", ok: false };
  if (b.reason === "no_id_published") return { text: "No AlShrouq id published", ok: false };
  return { text: "Not in the CRM's branch list", ok: false };
}

/** One labelled value in the information grid. */
function Row({ label, value, muted }: { label: string; value: string; muted?: boolean }) {
  return (
    <div className="min-w-0 space-y-0.5">
      <p className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
        {label}
      </p>
      <p
        className={`truncate text-sm ${muted ? "text-muted-foreground" : "font-medium text-foreground"}`}
        title={value}
      >
        {value}
      </p>
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
  notes,
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
  const summary = useMemo(() => summariseAlShrouqDispatch(current), [current]);

  /** Display only. It performs no work and cannot cause any — see the hook. */
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

  const errors: AlShrouqFieldError[] = result?.kind === "invalid" ? result.errors : [];
  const branch = useMemo(() => (ctx ? branchLine(ctx) : null), [ctx]);

  /**
   * Whether anything may still be approved.
   *
   * Never true once a dispatch exists. `dispatchPending` keeps the action out of
   * the way until the row is known, so a slow query cannot briefly offer "Send"
   * on an order that has already gone.
   */
  const ready =
    saved && !dispatchPending && !summary.handedOver && !!ctx && !ctx.optionsError && !!branch?.ok;

  /** Never a state the backend cannot support, and never a fake "Sent". */
  const status: { label: string; tone: "muted" | "ok" | "warn" } = summary.handedOver
    ? {
        label: summary.label,
        tone: summary.tone === "danger" || summary.tone === "warning" ? "warn" : "ok",
      }
    : !saved
      ? { label: "Pending order creation", tone: "muted" }
      : dispatchPending || ctxPending
        ? { label: "Checking…", tone: "muted" }
        : ctxError || ctx?.optionsError
          ? { label: "Verification required", tone: "warn" }
          : branch?.ok
            ? { label: "Ready to send", tone: "ok" }
            : { label: "Not available", tone: "warn" };

  const branchValue = branchNo
    ? branch && saved && !ctxPending && !ctxError
      ? `${branchNo} · ${branch.text}`
      : branchNo
    : "Select a branch";

  /**
   * The payment method, as it was approved.
   *
   * The row stores the CRM's own id; the label comes from the live option list.
   * An id the list no longer offers shows as the id rather than as a guess.
   */
  const paymentLabel = useMemo(() => {
    if (!current?.payment_type) return null;
    const match = (ctx?.paymentOptions ?? []).find((p) => String(p.id) === current.payment_type);
    return match?.label ?? current.payment_type;
  }, [current?.payment_type, ctx?.paymentOptions]);

  const coordinates =
    current?.customer_lat != null && current?.customer_lng != null
      ? `${current.customer_lat}, ${current.customer_lng}`
      : null;

  return (
    <>
      <Card className="overflow-hidden shadow-sm">
        <header className="flex items-start gap-3 border-b border-border/60 bg-muted/25 px-4 py-3 dark:bg-muted/10">
          <span
            aria-hidden
            className="grid h-7 w-7 shrink-0 place-items-center rounded-md bg-primary/10 text-primary ring-1 ring-inset ring-primary/15"
          >
            <Truck className="h-3.5 w-3.5" />
          </span>
          <div className="min-w-0 flex-1">
            <div className="flex flex-wrap items-center gap-2">
              <h2 className="text-sm font-semibold leading-none tracking-tight text-foreground">
                AlShrouq delivery
              </h2>
              <Badge
                variant={status.tone === "ok" ? "default" : "secondary"}
                className={`text-[10px] font-medium ${
                  status.tone === "warn" ? "bg-destructive/10 text-destructive" : ""
                }`}
              >
                {status.label}
              </Badge>
            </div>
            <p className="mt-1 text-[11.5px] leading-tight text-muted-foreground">
              {summary.handedOver
                ? "This order has been handed to AlShrouq. Later edits here do not change the delivery."
                : "Create and send this order to AlShrouq for delivery"}
            </p>
          </div>
        </header>

        <div className="grid grid-cols-1 gap-x-4 gap-y-3.5 p-4 sm:grid-cols-2">
          <Row
            label="Order reference"
            value={saved ? (ctx?.displayNo ?? "—") : "Assigned after the order is created"}
            muted={!saved}
          />
          <Row label="Branch" value={branchValue} muted={!branchNo} />
          <Row label="Customer" value={customerName.trim() || "—"} muted={!customerName.trim()} />
          <Row label="Phone" value={customerPhone.trim() || "—"} muted={!customerPhone.trim()} />
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
              current?.value != null
                ? fmtSAR(Number(current.value))
                : invoiceValue.trim()
                  ? fmtSAR(Number(invoiceValue))
                  : "—"
            }
            muted={current?.value == null && !invoiceValue.trim()}
          />

          {/* Persisted delivery details, shown only once they exist. Nothing
              here is derived from the form: it is what AlShrouq was told. */}
          {current?.customer_address && (
            <div className="min-w-0 space-y-0.5 sm:col-span-2">
              <p className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
                Customer location
              </p>
              <p className="truncate text-sm font-medium" title={current.customer_address}>
                {current.customer_address}
              </p>
            </div>
          )}
          {coordinates && (
            <div className="min-w-0 space-y-0.5 sm:col-span-2">
              <p className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
                Coordinates
              </p>
              <p className="flex items-center gap-1.5 font-mono text-xs text-muted-foreground">
                <MapPin className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
                {coordinates}
              </p>
            </div>
          )}
        </div>

        {/* The scheduled slot and how long is left. The countdown is display
            only — the dispatch is performed server-side by pg_cron and the
            worker, whether or not this page is open. */}
        {summary.scheduledFor && (
          <div className="border-t border-border/60 bg-muted/20 px-4 py-3 dark:bg-muted/10">
            <p className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
              Scheduled delivery
            </p>
            <p className="mt-0.5 text-sm font-medium text-foreground">
              {formatScheduledFor(summary.scheduledFor) ?? "—"}
            </p>
            <p className="mt-0.5 text-[11.5px] text-muted-foreground">
              {countdown.state === "waiting"
                ? `Dispatching in ${countdown.remainingLabel}`
                : countdown.state === "due"
                  ? "Dispatch pending"
                  : summary.label}
            </p>
          </div>
        )}

        {(!branch?.ok || !saved) && !summary.handedOver && (
          <div className="flex items-start gap-2 border-t border-border/60 bg-muted/20 px-4 py-3 text-[11.5px] leading-snug text-muted-foreground dark:bg-muted/10">
            <Info className="mt-px h-3.5 w-3.5 shrink-0" aria-hidden="true" />
            <p>
              {!saved
                ? "Save the order first to enable AlShrouq dispatch. Delivery fees are set by AlShrouq and are not published by the CRM, so none is shown here."
                : ctxError
                  ? "Dispatch details could not be loaded. You may not have permission to send this order."
                  : ctx?.optionsError
                    ? "The CRM could not be reached, so branch coverage could not be checked."
                    : (branch?.text ?? "Checking branch coverage…")}
            </p>
          </div>
        )}

        <div className="flex flex-wrap items-center justify-end gap-2 border-t border-border/60 px-4 py-3">
          {summary.handedOver ? (
            <>
              <span className="mr-auto flex min-w-0 items-center gap-1.5 text-xs text-muted-foreground">
                <PackageCheck className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
                {/* The reference stays visible whether or not tracking exists. */}
                <span className="truncate">
                  {summary.externalOrderId
                    ? `Reference ${summary.externalOrderId}`
                    : "No AlShrouq reference yet"}
                </span>
              </span>
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
            </>
          ) : (
            /* The only send control on this page. It is absent — not disabled —
               once a dispatch exists, so there is nothing to click twice. */
            <Button
              size="sm"
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

      {/* The shared dialog — the same one the create journey opens. Mounted only
          while there is something to approve. */}
      {ready && (
        <AlShrouqApprovalDialog
          mode="existing"
          open={open}
          onOpenChange={setOpen}
          customerName={ctx?.prefill.customerName || customerName}
          customerPhone={ctx?.prefill.customerPhone || customerPhone}
          branchNo={branchNo}
          branchLabel={branch?.text ?? null}
          displayNo={ctx?.displayNo ?? null}
          invoiceValue={ctx?.prefill.orderValue || invoiceValue}
          defaultDetails={ctx?.prefill.notes || notes}
          paymentOptions={ctx?.paymentOptions}
          errors={errors}
          result={result}
          busy={dispatch.isPending}
          onApprove={(plan) => dispatch.mutate(plan)}
        />
      )}
    </>
  );
}
