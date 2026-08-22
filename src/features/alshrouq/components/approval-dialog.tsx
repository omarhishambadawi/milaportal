/**
 * Confirming an AlShrouq delivery — one dialog, for both journeys.
 *
 * ## It is a confirmation, not a form
 *
 * It used to collect the payment method, the delivery location and a free-typed
 * date and time, on top of summarising the order — so pressing **Create order**
 * produced a second, taller form containing questions the agent thought they had
 * finished answering. Those fields now live on the order form itself
 * (`AlShrouqOrderRequirements`), and what is left here is the only decision that
 * genuinely belongs at this moment:
 *
 *   *record this order, or record it and hand the delivery to AlShrouq?*
 *
 * Everything it shows, it shows read-only, and every value comes from the order
 * the agent has already filled in. Nothing in this file is an input except the
 * choice of when.
 *
 * ## Why the scheduled wording is so explicit
 *
 * "Send" reads, to a person in a hurry, as *sent*. When the chosen slot is in
 * the future nothing is sent at all — the courier is contacted hours later by a
 * job nobody is watching. So the button changes verb, the summary names the
 * exact slot, and the confirmation says how long away it is. An agent should
 * never close this dialog believing a driver is on the way when one is not.
 *
 * ## It is still not a dispatcher
 *
 * It hands a *plan* back to its caller; the caller calls the server function,
 * and the server decides — from the time, on its own clock — whether to contact
 * a courier now or park a frozen snapshot for later. Nothing here talks to
 * AlShrouq, and there is no field a caller could set to make it.
 */

import { useEffect, useMemo, useState } from "react";
import { CalendarClock, Loader2, Send, Zap } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group";
import { fmtSAR } from "@/lib/branches";
import type { AlShrouqFieldError } from "@/lib/shams-crm/alshrouq-payload";
import type { ScheduleResult } from "@/lib/shams-crm/alshrouq-scheduler.server";
import { describeApprovalResult, type AlShrouqApprovalPlan } from "../approval";
import { alshrouqToneStyle, describeApprovalAction } from "../dispatch-presentation";
import { formatCoordinate } from "../order-requirements";
import { describeRemaining, formatScheduledFor, parseScheduleInput } from "../scheduling";
import { scheduleOptionsAt, type AlShrouqScheduleOption } from "../schedule-options";
import type { AlShrouqOrderState } from "../use-alshrouq-order";

export type { AlShrouqApprovalPlan };

export interface AlShrouqApprovalDialogProps {
  /**
   * `create` — the order does not exist yet, and "order only" is a real choice.
   * `existing` — the order is saved, so the only decision is whether to hand it
   * over and when.
   */
  mode: "create" | "existing";
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** The AlShrouq values the order form collected. Read here, never written. */
  alshrouq: AlShrouqOrderState;
  /** Live order values, for the summary. Never written back. */
  customerName: string;
  customerPhone: string;
  branchNo: string | null;
  invoiceValue: string;
  /** Existing orders only: what to call the order. */
  displayNo?: string | null;
  /** The note for the driver, carried from the order's own notes. */
  details?: string;
  /** Server-side field errors from a refused approval, shown as one line. */
  errors?: AlShrouqFieldError[];
  /** The last outcome, shown inline. The create journey reports it as a toast. */
  result?: ScheduleResult | null;
  busy: boolean;
  onApprove: (plan: AlShrouqApprovalPlan) => void;
}

/**
 * One line of the summary.
 *
 * A two-column definition row rather than a grid of cards: there are six of
 * them, they are read top to bottom, and a value that runs long wraps in its own
 * column instead of widening the dialog. `min-w-0` plus `break-words` is what
 * keeps a long value from producing a horizontal scrollbar.
 */
function Line({
  label,
  children,
  muted,
}: {
  label: string;
  children: React.ReactNode;
  muted?: boolean;
}) {
  return (
    <div className="flex min-w-0 items-baseline justify-between gap-3 py-1">
      <dt className="shrink-0 text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
        {label}
      </dt>
      <dd
        className={`min-w-0 break-words text-right text-[13px] ${
          muted ? "text-muted-foreground" : "font-medium text-foreground"
        }`}
        dir="auto"
      >
        {children}
      </dd>
    </div>
  );
}

/** What came back, said plainly. The wording lives in `describeApprovalResult`. */
function ResultNotice({ result }: { result: ScheduleResult }) {
  const { tone, message } = describeApprovalResult(result);
  const bad = tone === "error" || tone === "warning";
  return (
    <div
      className={`rounded-md border p-2.5 text-[12.5px] leading-snug ${
        bad ? "border-destructive/40 text-destructive" : "border-border/60 text-muted-foreground"
      }`}
    >
      {message}
    </div>
  );
}

/** `NOW` is the absence of a slot, not a slot of its own. */
const NOW = "now";

export function AlShrouqApprovalDialog({
  mode,
  open,
  onOpenChange,
  alshrouq,
  customerName,
  customerPhone,
  branchNo,
  invoiceValue,
  displayNo,
  details = "",
  errors = [],
  result = null,
  busy,
  onApprove,
}: AlShrouqApprovalDialogProps) {
  const [slotId, setSlotId] = useState<string>(NOW);

  /**
   * The slots, generated when the dialog opens.
   *
   * Read from the clock once per opening rather than on every render: a list
   * that re-derived itself each tick would move the option under the agent's
   * cursor as the hour turned.
   */
  const slots = useMemo<AlShrouqScheduleOption[]>(
    () => (open ? scheduleOptionsAt(new Date()) : []),
    [open],
  );

  // Reopening is a fresh approval. A slot left over from the last time this was
  // open is exactly the kind of state that schedules the wrong delivery.
  useEffect(() => {
    if (open) setSlotId(NOW);
  }, [open]);

  const slot = slots.find((s) => s.id === slotId) ?? null;

  /**
   * When the courier would be called.
   *
   * The chosen slot goes through `parseScheduleInput` — the same function, the
   * same rules, the same rejection of the past — so replacing a text box with a
   * list changed the control and nothing about the arithmetic. No slot means no
   * instant, which is what "as soon as possible" has always meant on the wire.
   */
  const schedule = useMemo(() => {
    if (!slot) return { ok: true as const, iso: null, timing: "immediate" as const };
    const parsed = parseScheduleInput(slot.date, slot.time);
    return parsed.ok ? { ok: true as const, iso: parsed.iso, timing: parsed.timing } : parsed;
  }, [slot]);

  const scheduledIso = schedule.ok && schedule.timing === "scheduled" ? schedule.iso : null;
  const scheduledLabel = scheduledIso ? formatScheduledFor(scheduledIso) : null;

  const { ready, requirements, paymentLabel, mapUrl, latitude, longitude } = alshrouq;
  const creating = mode === "create";

  const approve = (intent: AlShrouqApprovalPlan["intent"]) => {
    onApprove({
      intent,
      scheduledFor: intent === "dispatch" && scheduledIso ? scheduledIso : undefined,
      paymentType: alshrouq.paymentType,
      // The customer's own link is what goes on the wire, not a rewritten one.
      mapUrl,
      lat: latitude,
      lng: longitude,
      customerName,
      customerPhone,
      orderValue: invoiceValue,
      details,
    });
  };

  const primaryLabel = creating
    ? scheduledIso
      ? "Create order + schedule delivery"
      : "Create order + AlShrouq delivery"
    : scheduledIso
      ? "Schedule delivery"
      : "Send to AlShrouq";

  const outcomeTone = alshrouqToneStyle(scheduledIso ? "info" : "success");

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      {/*
        36rem, and never wider than the viewport less a safe margin on each side.
        The content is six summary lines and a short list — a wider dialog would
        only stretch them.

        `grid-cols-[minmax(0,1fr)]` is the fix for the horizontal scrollbar, and
        it is a real one rather than a hidden overflow. `DialogContent` is a
        `grid` with an implicit `auto` column, so its single track was sized to
        the *max-content* width of its widest child — one long summary value
        widened the track, every child stretched to match, and the whole dialog
        overflowed its own max-width. A track that may shrink to zero constrains
        the children instead, which is what lets `break-words` below do its job.
      */}
      <DialogContent className="max-h-[85vh] w-[calc(100vw-2rem)] max-w-xl grid-cols-[minmax(0,1fr)] gap-3 overflow-y-auto">
        <DialogHeader className="space-y-1">
          <DialogTitle className="text-base">
            {creating ? "Create this order" : "Send order to AlShrouq"}
          </DialogTitle>
          <DialogDescription className="text-[12.5px]">
            {creating
              ? "Everything below is already on the order. Choose how it goes out."
              : `Order ${displayNo ?? "—"} is already saved. Choose when AlShrouq collects it.`}
          </DialogDescription>
        </DialogHeader>

        {/* ---------------------------------------------------------------
            The order, as it stands. Read-only throughout: correcting any of
            it means correcting the order, which is one dialog behind this.
            --------------------------------------------------------------- */}
        <dl className="divide-y divide-border/50 rounded-md border border-border/60 px-3 py-1">
          <Line label="Customer" muted={!customerName.trim()}>
            {customerName.trim() || "—"}
          </Line>
          <Line label="Phone" muted={!customerPhone.trim()}>
            {customerPhone.trim() || "—"}
          </Line>
          <Line label="Branch" muted={!branchNo}>
            {branchNo ?? "—"}
          </Line>
          <Line label="Order value" muted={!invoiceValue.trim()}>
            {invoiceValue.trim() ? fmtSAR(Number(invoiceValue)) : "—"}
          </Line>
          <Line label="Payment" muted={!paymentLabel}>
            {paymentLabel ?? "—"}
          </Line>
          <Line label="Location" muted={!mapUrl.trim()}>
            {/* The URL itself is never printed: it is a long unbreakable string
                and it tells an agent nothing they can check at a glance. The
                coordinates are the part worth reading back. */}
            {latitude && longitude
              ? `${formatCoordinate(Number(latitude))}, ${formatCoordinate(Number(longitude))}`
              : mapUrl.trim()
                ? "Link added — coordinates not read yet"
                : "—"}
          </Line>
        </dl>

        {/* Anything still missing, named. The primary action is disabled while
            this is showing, so the list is the reason rather than a hint. */}
        {!ready && (
          <div className="rounded-md border border-warning/30 bg-warning/5 p-3">
            <p className="text-[12.5px] font-medium text-foreground">
              AlShrouq delivery is not available yet
            </p>
            <ul className="mt-1 list-inside list-disc text-[11.5px] leading-snug text-muted-foreground">
              {requirements.map((r) => (
                <li key={r.field}>{r.message}</li>
              ))}
            </ul>
          </div>
        )}

        {/* ---------------------------------------------------------------
            When. A short list of slots rather than a date box and a typed
            time: a delivery is arranged in hours, and a free-typed minute is
            precision the courier does not have. Every option is a
            `{date, time}` pair handed to the existing parser.
            --------------------------------------------------------------- */}
        {ready && (
          <div className="space-y-2">
            <p className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
              When should AlShrouq delivery start?
            </p>
            <RadioGroup value={slotId} onValueChange={setSlotId} className="gap-1.5">
              <SlotOption
                id={NOW}
                selected={slotId === NOW}
                icon={<Zap className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />}
                title="As soon as possible"
              />
              {slots.map((option) => (
                <SlotOption
                  key={option.id}
                  id={option.id}
                  selected={slotId === option.id}
                  title={option.day}
                  clock={option.clock}
                />
              ))}
            </RadioGroup>
          </div>
        )}

        {/* What confirming will do, in the tone of the thing it will do. */}
        {ready && (
          <div className={`rounded-md border p-2.5 ${outcomeTone.band}`}>
            <p className="flex items-center gap-1.5 text-[12.5px] font-medium">
              {scheduledIso ? (
                <CalendarClock
                  className={`h-3.5 w-3.5 shrink-0 ${outcomeTone.icon}`}
                  aria-hidden="true"
                />
              ) : (
                <Send className={`h-3.5 w-3.5 shrink-0 ${outcomeTone.icon}`} aria-hidden="true" />
              )}
              {primaryLabel}
            </p>
            <p className="mt-0.5 text-[11.5px] leading-snug text-muted-foreground">
              {describeApprovalAction(mode, "dispatch", scheduledLabel)}
              {scheduledIso &&
                ` That is ${describeRemaining(Date.parse(scheduledIso) - Date.now())} from now.`}
            </p>
          </div>
        )}

        {errors.length > 0 && (
          <p className="text-[12px] text-destructive">{errors.map((e) => e.message).join(" ")}</p>
        )}
        {result && <ResultNotice result={result} />}

        {/* The primary action last in source, so it is lowest on a stacked
            phone footer and rightmost on a desktop one. */}
        <DialogFooter className="flex-col-reverse gap-2 sm:flex-row sm:justify-end">
          <Button
            variant="ghost"
            className="w-full sm:w-auto"
            onClick={() => onOpenChange(false)}
            disabled={busy}
          >
            {creating ? "Cancel" : "Close"}
          </Button>
          {creating && (
            <Button
              variant="outline"
              className="w-full sm:w-auto"
              onClick={() => approve("order_only")}
              disabled={busy}
            >
              Create order only
            </Button>
          )}
          <Button
            className="w-full sm:w-auto"
            onClick={() => approve("dispatch")}
            disabled={busy || !ready}
          >
            {busy ? (
              <Loader2 className="mr-2 h-4 w-4 animate-spin" aria-hidden="true" />
            ) : scheduledIso ? (
              <CalendarClock className="mr-2 h-4 w-4" aria-hidden="true" />
            ) : (
              <Send className="mr-2 h-4 w-4" aria-hidden="true" />
            )}
            {primaryLabel}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/**
 * One slot, as a compact radio card.
 *
 * The selected one is marked by the portal's own primary tint and border rather
 * than by the dot alone, because the dot is 14px and this is the choice that
 * decides whether a driver leaves now or this evening.
 */
function SlotOption({
  id,
  selected,
  title,
  clock,
  icon,
}: {
  id: string;
  selected: boolean;
  title: string;
  clock?: string;
  icon?: React.ReactNode;
}) {
  return (
    <label
      htmlFor={`slot-${id}`}
      className={`flex cursor-pointer items-center gap-2.5 rounded-md border px-3 py-1.5 text-[13px] transition-colors ${
        selected
          ? "border-primary/45 bg-primary/5 font-medium text-foreground"
          : "border-border/60 text-foreground hover:bg-muted/40"
      }`}
    >
      <RadioGroupItem value={id} id={`slot-${id}`} />
      {icon}
      <span className="min-w-0 flex-1 truncate">{title}</span>
      {clock && <span className="shrink-0 tabular-nums text-muted-foreground">{clock}</span>}
    </label>
  );
}
