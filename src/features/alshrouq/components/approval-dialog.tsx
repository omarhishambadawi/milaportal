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
 *   *record this order, or record it and hand the delivery to AlShrouq — and
 *   when?*
 *
 * Everything else it shows, it shows read-only, and every value comes from the
 * order the agent has already filled in.
 *
 * ## Density is a requirement, not a preference
 *
 * The confirmation must fit a 1280×800 desktop without scrolling. It did not:
 * a seven-row stacked summary, five generated hourly slots as radio cards, a
 * paragraph of description and a bordered outcome panel above the buttons ran
 * past the viewport, and a confirmation you have to scroll is one people confirm
 * without reading. So the summary is a two-column definition grid, the slots are
 * gone (see below), the description is one line, and what the primary action
 * will do is a single muted sentence rather than a tinted card — the button
 * already says it.
 *
 * Nothing is achieved by clipping: `DialogContent` keeps `max-h-[85vh]` with
 * `overflow-y-auto` purely as a last resort for a genuinely short viewport, and
 * at every size this is designed for the content is shorter than that.
 *
 * ## Choosing when: a date and a time, not a list
 *
 * There were five generated whole hours — "Today 9:00 PM", "Today 10:00 PM", …
 * — which is a lot of vertical space to say very little, cannot express 7:30,
 * and offered precision by accident (a "slot" implies AlShrouq knows about it).
 * It is now **As soon as possible** or **Schedule delivery**, and scheduling
 * reveals the portal's own `Calendar` plus an hour / minute / AM-PM triple.
 *
 * The wire format did not change. `schedule-picker.ts` produces the same two
 * strings the slot list did — `"2026-08-23"` and `"07:30 PM"` — and
 * `parseScheduleInput`, untouched, still turns them into the instant
 * `scheduled_for` stores.
 *
 * ## Why the scheduled wording is still explicit
 *
 * "Send" reads, to a person in a hurry, as *sent*. When the chosen time is in
 * the future nothing is sent at all — the courier is contacted hours later by a
 * job nobody is watching. So the button changes verb, the summary names the
 * exact time, and one line says no courier is contacted now. An agent should
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
import { CalendarClock, CalendarIcon, Loader2, Send, Zap } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Calendar } from "@/components/ui/calendar";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import { fmtSAR } from "@/lib/branches";
import type { AlShrouqFieldError } from "@/lib/shams-crm/alshrouq-payload";
import type { ScheduleResult } from "@/lib/shams-crm/alshrouq-scheduler.server";
import { describeApprovalResult, type AlShrouqApprovalPlan } from "../approval";
import { ALSHROUQ_NOTE_MAX } from "../constants";
import { describeApprovalAction } from "../dispatch-presentation";
import { formatCoordinate } from "../order-requirements";
import { formatScheduledFor, parseScheduleInput } from "../scheduling";
import {
  HOUR_OPTIONS,
  MERIDIEM_OPTIONS,
  MINUTE_OPTIONS,
  calendarDate,
  clampSelection,
  dateFromCalendar,
  defaultScheduleSelection,
  earliestMinutesOn,
  formatPickedDate,
  minutesOfDay,
  scheduleInputFor,
  type Meridiem,
  type ScheduleSelection,
} from "../schedule-picker";
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
  /**
   * Makes the note editable, and is what the edit writes to.
   *
   * Supplied by the **create** journey only, where the order has not been saved
   * yet: the handler writes straight back into the order's `notes` field, so the
   * text an agent types here is saved by the ordinary insert — one note, in the
   * column the order's Notes card already reads — and is carried to AlShrouq as
   * the payload's `details` by the approval that follows it.
   *
   * Omitted for an existing order, where the dialog is a confirmation and the
   * order's Notes field is on the page behind it. Editing a saved order's note
   * from here would put a value on the dispatch that the order itself does not
   * hold until somebody remembers to press Save.
   */
  onDetailsChange?: (value: string) => void;
  /** Server-side field errors from a refused approval, shown as one line. */
  errors?: AlShrouqFieldError[];
  /** The last outcome, shown inline. The create journey reports it as a toast. */
  result?: ScheduleResult | null;
  busy: boolean;
  onApprove: (plan: AlShrouqApprovalPlan) => void;
}

/**
 * One line of the summary, as two cells of the enclosing grid.
 *
 * Deliberately a fragment rather than a row of its own: the labels then share a
 * single column and the values line up down the second, which is what makes six
 * facts read as a block instead of six stacked rows. `min-w-0` plus
 * `break-words` on the value is what keeps a long one from widening the dialog.
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
    <>
      <dt className="pt-px text-[10.5px] font-medium uppercase tracking-wide text-muted-foreground">
        {label}
      </dt>
      <dd
        className={`min-w-0 break-words text-[13px] leading-snug ${
          muted ? "text-muted-foreground" : "font-medium text-foreground"
        }`}
        dir="auto"
      >
        {children}
      </dd>
    </>
  );
}

/** What came back, said plainly. The wording lives in `describeApprovalResult`. */
function ResultNotice({ result }: { result: ScheduleResult }) {
  const { tone, message } = describeApprovalResult(result);
  const bad = tone === "error" || tone === "warning";
  return (
    <p className={`text-[12px] leading-snug ${bad ? "text-destructive" : "text-muted-foreground"}`}>
      {message}
    </p>
  );
}

/**
 * One unit of the time control.
 *
 * A `Select` rather than a typed box, for the reason the whole dialog exists:
 * a control that accepts "3.30pm" and rejects it afterwards is a form. Options
 * that have already passed are `disabled` rather than absent, so the list does
 * not change length as the clock moves under the agent's cursor.
 */
function TimeUnit({
  label,
  value,
  options,
  onChange,
  isPast,
  className,
}: {
  label: string;
  value: string;
  options: readonly string[];
  onChange: (value: string) => void;
  isPast: (option: string) => boolean;
  className?: string;
}) {
  return (
    <Select value={value} onValueChange={onChange}>
      <SelectTrigger aria-label={label} className={`h-9 px-2 text-[13px] ${className ?? ""}`}>
        <SelectValue />
      </SelectTrigger>
      <SelectContent className="max-h-56 min-w-0">
        {options.map((option) => (
          <SelectItem key={option} value={option} disabled={isPast(option)} className="text-[13px]">
            {option}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}

/**
 * One timing choice, as a compact radio card.
 *
 * Two of them side by side rather than a stacked list: it is a binary choice,
 * and a column of two full-width cards is the shape the removed slot list had.
 */
function TimingOption({
  id,
  selected,
  icon,
  title,
}: {
  id: string;
  selected: boolean;
  icon: React.ReactNode;
  title: string;
}) {
  return (
    <label
      htmlFor={`timing-${id}`}
      className={`flex cursor-pointer items-center gap-2 rounded-md border px-2.5 py-2 text-[13px] transition-colors ${
        selected
          ? "border-primary/45 bg-primary/5 font-medium text-foreground"
          : "border-border/60 text-foreground hover:bg-muted/40"
      }`}
    >
      <RadioGroupItem value={id} id={`timing-${id}`} />
      {icon}
      <span className="min-w-0 flex-1 truncate">{title}</span>
    </label>
  );
}

/** The two things an agent can mean by "when". */
type Timing = "asap" | "scheduled";

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
  onDetailsChange,
  errors = [],
  result = null,
  busy,
  onApprove,
}: AlShrouqApprovalDialogProps) {
  const [timing, setTiming] = useState<Timing>("asap");
  const [when, setWhen] = useState<ScheduleSelection>(() => defaultScheduleSelection(new Date()));
  const [dateOpen, setDateOpen] = useState(false);

  /*
   * Reopening is a fresh approval. A time left over from the last time this was
   * open is exactly the kind of state that schedules the wrong delivery — and by
   * the next opening it may be in the past, so the default is re-derived from
   * the clock rather than kept.
   */
  useEffect(() => {
    if (!open) return;
    setTiming("asap");
    setWhen(defaultScheduleSelection(new Date()));
    setDateOpen(false);
  }, [open]);

  /**
   * The earliest minute still selectable on the chosen day.
   *
   * Read once per render from the same function the calendar's `before` bound
   * uses, so the day the calendar refuses and the times the selects refuse
   * cannot disagree.
   */
  const earliest = earliestMinutesOn(when.date, new Date());
  const today = calendarDate(defaultScheduleSelection(new Date()).date);

  const pick = (next: ScheduleSelection) => setWhen(clampSelection(next, new Date()));

  /**
   * When the courier would be called.
   *
   * The chosen date and time go through `parseScheduleInput` — the same
   * function, the same rules, the same rejection of the past — so replacing the
   * control changed nothing about the arithmetic. "As soon as possible" sends no
   * instant at all, which is what it has always meant on the wire.
   */
  const schedule = useMemo(() => {
    if (timing === "asap") return { ok: true as const, iso: null, timing: "immediate" as const };
    const input = scheduleInputFor(when);
    const parsed = parseScheduleInput(input.date, input.time);
    return parsed.ok ? { ok: true as const, iso: parsed.iso, timing: parsed.timing } : parsed;
  }, [timing, when]);

  const scheduledIso = schedule.ok && schedule.timing === "scheduled" ? schedule.iso : null;
  const scheduledLabel = scheduledIso ? formatScheduledFor(scheduledIso) : null;
  /** A chosen time that has gone. The controls make it hard; this makes it safe. */
  const schedulePast = !schedule.ok;

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

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      {/*
        34rem — inside the 500–560px this is designed for — and never wider than
        the viewport less a safe margin on each side.

        `grid-cols-[minmax(0,1fr)]` is the fix for the horizontal scrollbar, and
        it is a real one rather than a hidden overflow. `DialogContent` is a
        `grid` with an implicit `auto` column, so its single track was sized to
        the *max-content* width of its widest child — one long summary value
        widened the track, every child stretched to match, and the whole dialog
        overflowed its own max-width. A track that may shrink to zero constrains
        the children instead, which is what lets `break-words` below do its job.
      */}
      <DialogContent className="max-h-[85vh] w-[calc(100vw-2rem)] max-w-[34rem] grid-cols-[minmax(0,1fr)] gap-3 overflow-y-auto">
        <DialogHeader className="space-y-0.5">
          <DialogTitle className="text-base">
            {creating ? "Create this order" : "Send order to AlShrouq"}
          </DialogTitle>
          {/* One line. The summary underneath says what the order is; a
              paragraph here only pushed it down the screen. */}
          <DialogDescription className="text-[12px]">
            {creating
              ? "Confirm what goes to AlShrouq, and when."
              : `Order ${displayNo ?? "—"} is saved. Choose when AlShrouq collects it.`}
          </DialogDescription>
        </DialogHeader>

        {/* ---------------------------------------------------------------
            The order, as it stands. Read-only throughout: correcting any of
            it means correcting the order, which is one dialog behind this.

            A two-column definition grid — labels in the first track, values in
            the second — rather than six bordered rows. One box, one border.
            --------------------------------------------------------------- */}
        <dl className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-4 gap-y-1 rounded-md border border-border/60 bg-muted/20 px-3 py-2.5 dark:bg-muted/10">
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
          {/* The choice made below, read back in the same block as everything
              else it will be sent with. */}
          {ready && (
            <Line label="Delivery" muted={schedulePast}>
              {schedulePast
                ? "Choose a time that has not passed"
                : (scheduledLabel ?? "As soon as possible")}
            </Line>
          )}
        </dl>

        {/* Anything still missing, named. The primary action is disabled while
            this is showing, so the list is the reason rather than a hint. */}
        {!ready && (
          <div className="rounded-md border border-warning/30 bg-warning/5 px-3 py-2">
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
            When. Two choices, and the date and time only once the second is
            taken — so the common case costs no vertical space at all.
            --------------------------------------------------------------- */}
        {ready && (
          <div className="space-y-2">
            <p className="text-[10.5px] font-semibold uppercase tracking-wide text-muted-foreground">
              Delivery timing
            </p>
            <RadioGroup
              value={timing}
              onValueChange={(value) => {
                const next = value as Timing;
                setTiming(next);
                // Re-derived on entry rather than kept: the default that was
                // sensible when the dialog opened may not be a minute later.
                if (next === "scheduled") setWhen(defaultScheduleSelection(new Date()));
              }}
              className="grid grid-cols-1 gap-2 sm:grid-cols-2"
            >
              <TimingOption
                id="asap"
                selected={timing === "asap"}
                icon={<Zap className="h-3.5 w-3.5 shrink-0 text-primary" aria-hidden="true" />}
                title="As soon as possible"
              />
              <TimingOption
                id="scheduled"
                selected={timing === "scheduled"}
                icon={
                  <CalendarClock className="h-3.5 w-3.5 shrink-0 text-primary" aria-hidden="true" />
                }
                title="Schedule delivery"
              />
            </RadioGroup>

            {timing === "scheduled" && (
              <div className="grid gap-2.5 sm:grid-cols-[minmax(0,1fr)_auto]">
                <div className="min-w-0 space-y-1">
                  <p className="text-[11px] font-medium text-muted-foreground">Delivery date</p>
                  {/* The portal's own calendar, through the portal's own
                      popover — the same pair `DateRangePicker` uses. No second
                      calendar was written for this. */}
                  <Popover open={dateOpen} onOpenChange={setDateOpen}>
                    <PopoverTrigger asChild>
                      <Button
                        variant="outline"
                        className="h-9 w-full justify-start px-2.5 text-[13px] font-normal"
                      >
                        <CalendarIcon className="mr-2 h-3.5 w-3.5 shrink-0" aria-hidden="true" />
                        <span className="truncate">{formatPickedDate(when.date)}</span>
                      </Button>
                    </PopoverTrigger>
                    <PopoverContent
                      className="w-auto max-w-[calc(100vw-1.5rem)] p-0"
                      align="start"
                      sideOffset={6}
                      collisionPadding={12}
                    >
                      <Calendar
                        mode="single"
                        selected={calendarDate(when.date)}
                        defaultMonth={calendarDate(when.date)}
                        // A delivery cannot be arranged for a day that has gone.
                        disabled={today ? { before: today } : undefined}
                        onSelect={(day) => {
                          if (!day) return;
                          pick({ ...when, date: dateFromCalendar(day) });
                          setDateOpen(false);
                        }}
                        className="[--cell-size:2rem]"
                      />
                    </PopoverContent>
                  </Popover>
                </div>

                <div className="space-y-1">
                  <p className="text-[11px] font-medium text-muted-foreground">Delivery time</p>
                  <div className="flex items-center gap-1">
                    <TimeUnit
                      label="Hour"
                      value={when.hour}
                      options={HOUR_OPTIONS}
                      className="w-[3.75rem]"
                      onChange={(hour) => pick({ ...when, hour })}
                      // The whole hour is gone only when its last minute is.
                      isPast={(hour) => minutesOfDay(hour, "59", when.meridiem) < earliest}
                    />
                    <span aria-hidden className="text-sm text-muted-foreground">
                      :
                    </span>
                    <TimeUnit
                      label="Minute"
                      value={when.minute}
                      options={MINUTE_OPTIONS}
                      className="w-[3.75rem]"
                      onChange={(minute) => pick({ ...when, minute })}
                      isPast={(minute) => minutesOfDay(when.hour, minute, when.meridiem) < earliest}
                    />
                    <TimeUnit
                      label="AM or PM"
                      value={when.meridiem}
                      options={MERIDIEM_OPTIONS}
                      className="w-[4.25rem]"
                      onChange={(meridiem) => pick({ ...when, meridiem: meridiem as Meridiem })}
                      isPast={(meridiem) =>
                        minutesOfDay("11", "59", meridiem as Meridiem) < earliest
                      }
                    />
                  </div>
                </div>
              </div>
            )}
          </div>
        )}

        {/* ---------------------------------------------------------------
            The note for the driver.

            One box, and not a second notes system: what is typed here is the
            order's own `notes` field — the column the Notes card on the order
            page shows, the export's "Notes" column reads, and the payload
            builder already turns into the courier's `details`. So it survives a
            reopen because the order was saved with it, and it reaches AlShrouq
            because that is where the driver note has always come from.

            This dialog still builds nothing and sends nothing. It collects one
            string and hands it back in the plan, exactly as it does the time.

            `rows={2}` deliberately: the dialog is a confirmation and must not
            grow into a form. `maxLength` is the limit both validators already
            enforce, applied at the keyboard so a long note is trimmed while it
            is being typed rather than refused after the agent commits.
            --------------------------------------------------------------- */}
        {onDetailsChange ? (
          <div className="space-y-1">
            <label
              htmlFor="alshrouq-delivery-note"
              className="flex items-baseline gap-1.5 text-[10.5px] font-semibold uppercase tracking-wide text-muted-foreground"
            >
              Delivery note
              <span className="font-normal normal-case tracking-normal">— optional</span>
            </label>
            <Textarea
              id="alshrouq-delivery-note"
              rows={2}
              maxLength={ALSHROUQ_NOTE_MAX}
              value={details}
              onChange={(e) => onDetailsChange(e.target.value)}
              placeholder="e.g. Second floor, ring the bell twice."
              className="resize-none text-[13px]"
              dir="auto"
            />
          </div>
        ) : (
          details.trim() && (
            <div className="space-y-0.5">
              <p className="text-[10.5px] font-semibold uppercase tracking-wide text-muted-foreground">
                Delivery note
              </p>
              <p className="whitespace-pre-wrap break-words text-[13px] text-foreground" dir="auto">
                {details.trim()}
              </p>
            </div>
          )
        )}

        {/* What confirming will do — one muted sentence, not a tinted panel.
            The button says it too; this is the part the button has no room for,
            and it is the sentence that must never read as "sent" when nothing
            has been. */}
        {ready && !schedulePast && (
          <p className="text-[11.5px] leading-snug text-muted-foreground">
            {describeApprovalAction(mode, "dispatch", scheduledLabel)}
          </p>
        )}

        {errors.length > 0 && (
          <p className="text-[12px] text-destructive">{errors.map((e) => e.message).join(" ")}</p>
        )}
        {result && <ResultNotice result={result} />}

        {/* The primary action last in source, so it is lowest on a stacked
            phone footer and rightmost on a desktop one. */}
        <DialogFooter className="flex-col-reverse gap-2 sm:flex-row sm:justify-end">
          {/* The two secondary actions share a row on a phone and dissolve into
              the footer's own flow from `sm` up (`display: contents`), so the
              desktop arrangement is exactly what it was while the stacked
              version costs one button's height instead of two. */}
          <div className="flex gap-2 sm:contents">
            <Button
              variant="ghost"
              className="flex-1 sm:w-auto sm:flex-none"
              onClick={() => onOpenChange(false)}
              disabled={busy}
            >
              {creating ? "Cancel" : "Close"}
            </Button>
            {creating && (
              <Button
                variant="outline"
                className="flex-1 sm:w-auto sm:flex-none"
                onClick={() => approve("order_only")}
                disabled={busy}
              >
                Create order only
              </Button>
            )}
          </div>
          <Button
            className="w-full sm:w-auto"
            onClick={() => approve("dispatch")}
            disabled={busy || !ready || schedulePast}
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
