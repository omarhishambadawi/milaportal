/**
 * Approving an AlShrouq delivery — the one dialog, for both journeys.
 *
 * An agent can approve a handoff in two situations: while creating a new order,
 * and on an order that already exists. Those are different sentences, different
 * buttons and different consequences if the agent walks away — so `mode` changes
 * the copy. Everything underneath is deliberately identical: the same fields,
 * the same `AlShrouqApprovalPlan`, the same `alshrouqDispatchOrder`.
 *
 * There used to be two dialogs. The create flow had this one; the order page had
 * its own inside the AlShrouq card, with its own field set, its own validation
 * and its own idea of what to send. Two implementations of the same handoff is
 * how the details silently diverge — one gains a field the other never sends —
 * and it is what this phase collapsed.
 *
 * ## What it is not
 *
 * It is not a dispatcher. It hands a *plan* back to its caller; the caller calls
 * the server function, and the server decides — from the time, on its own clock
 * — whether to contact a courier now or park a frozen snapshot for later.
 * Nothing here talks to AlShrouq, and there is no field a caller could set to
 * make it.
 *
 * ## Why the scheduled wording is so explicit
 *
 * "Send" reads, to a person in a hurry, as *sent*. When the chosen time is in
 * the future nothing is sent at all — the courier is contacted hours later by a
 * job nobody is watching. So the button changes verb, the summary names the
 * exact instant, and the confirmation says how long away it is in words. An
 * agent should never close this dialog believing a driver is on the way when one
 * is not.
 *
 * ## Timing is a choice, not the absence of one
 *
 * "Leave the date and time blank to send now" was the rule, and it is a rule an
 * agent has to be told — a blank field is not an answer, it is an unanswered
 * question, and the difference between the two here is whether a driver leaves
 * in a minute or tomorrow. It is two radio options now, over the same
 * `parseScheduleInput` and the same server-side decision. Nothing about the
 * validation, the safety gate or the clock changed: picking "now" simply means
 * no instant is sent, exactly as two blank boxes did.
 */

import { useEffect, useMemo, useState } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import {
  CalendarClock,
  CheckCircle2,
  CircleAlert,
  ExternalLink,
  Link2,
  Loader2,
  MapPin,
  Send,
  Zap,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
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
import { alshrouqPaymentOptions, alshrouqResolveLocation } from "@/lib/shams.functions";
import type { AlShrouqPaymentOption } from "@/lib/shams-crm/alshrouq-config.server";
import type { AlShrouqFieldError } from "@/lib/shams-crm/alshrouq-payload";
import type { ScheduleResult } from "@/lib/shams-crm/alshrouq-scheduler.server";
import { describeApprovalResult, type AlShrouqApprovalPlan } from "../approval";
import { alshrouqToneStyle, describeApprovalAction } from "../dispatch-presentation";
import { describeLocationResult, formatCoordinates, type AlShrouqLocation } from "../location";
import { describeRemaining, formatScheduledFor, parseScheduleInput } from "../scheduling";

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
  /** Live order values, for the summary. Never written back. */
  customerName: string;
  customerPhone: string;
  branchNo: string | null;
  invoiceValue: string;
  /** Existing orders only: what to call the order, and its branch coverage. */
  displayNo?: string | null;
  branchLabel?: string | null;
  /** The note for the driver, prefilled from the order where there is one. */
  defaultDetails?: string;
  /**
   * The CRM's payment methods, when the caller already has them.
   *
   * The order page fetches them with the rest of the dispatch context, under the
   * permission that decides whether this agent may act on this order. Left
   * absent — on the create journey, where no order exists to scope a context to
   * — the dialog fetches them itself.
   */
  paymentOptions?: AlShrouqPaymentOption[];
  /** Server-side field errors from a refused approval, shown against the field. */
  errors?: AlShrouqFieldError[];
  /** The last outcome, shown inline. The create journey reports it as a toast. */
  result?: ScheduleResult | null;
  busy: boolean;
  onApprove: (plan: AlShrouqApprovalPlan) => void;
}

/**
 * One labelled value in the order summary.
 *
 * `min-w-0` and `truncate` keep a long Arabic customer name inside the dialog
 * rather than widening it past the viewport on a phone.
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

/** A heading for one group of the dialog, so it reads as steps not as a wall. */
function GroupTitle({ children }: { children: React.ReactNode }) {
  return (
    <p className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
      {children}
    </p>
  );
}

/** What came back, said plainly. The wording lives in `describeApprovalResult`. */
function ResultNotice({ result }: { result: ScheduleResult }) {
  const { tone, message } = describeApprovalResult(result);
  const bad = tone === "error" || tone === "warning";
  return (
    <div
      className={`rounded-md border p-3 text-sm ${
        bad ? "border-destructive/40 text-destructive" : "text-muted-foreground"
      }`}
    >
      {message}
    </div>
  );
}

export function AlShrouqApprovalDialog({
  mode,
  open,
  onOpenChange,
  customerName,
  customerPhone,
  branchNo,
  invoiceValue,
  displayNo,
  branchLabel,
  defaultDetails = "",
  paymentOptions: provided,
  errors = [],
  result = null,
  busy,
  onApprove,
}: AlShrouqApprovalDialogProps) {
  const [paymentType, setPaymentType] = useState("");
  const [linkInput, setLinkInput] = useState("");
  const [located, setLocated] = useState<AlShrouqLocation | null>(null);
  const [locationError, setLocationError] = useState<string | null>(null);
  const [timing, setTiming] = useState<"now" | "later">("now");
  const [date, setDate] = useState("");
  const [time, setTime] = useState("");
  const [details, setDetails] = useState(defaultDetails);

  // Reopening is a fresh approval. A payment method or a location left over from
  // the last time this dialog was open is exactly the kind of state that sends a
  // driver to the previous customer's address.
  useEffect(() => {
    if (!open) return;
    setPaymentType("");
    setLinkInput("");
    setLocated(null);
    setLocationError(null);
    setTiming("now");
    setDate("");
    setTime("");
    setDetails(defaultDetails);
  }, [open, defaultDetails]);

  /**
   * The CRM's payment methods.
   *
   * Only fetched when the caller has none to give — and only while the dialog is
   * open, so opening an order costs nothing. There is no enum in this
   * repository: the list belongs to the CRM.
   */
  const optionsFn = useServerFn(alshrouqPaymentOptions);
  const { data: fetched = [] } = useQuery<AlShrouqPaymentOption[]>({
    queryKey: ["alshrouq", "payment-options"],
    enabled: open && !provided,
    staleTime: 5 * 60_000,
    retry: false,
    queryFn: () => optionsFn({ data: undefined }),
  });
  const paymentOptions = provided ?? fetched;

  const resolveFn = useServerFn(alshrouqResolveLocation);
  const resolve = useMutation({
    mutationFn: (url: string) => resolveFn({ data: { url } }),
    onSuccess: (r) => {
      if (r.kind === "resolved") {
        setLocated(r.location);
        setLocationError(null);
        return;
      }
      // Nothing fabricated: the link stays for correction, coordinates stay empty.
      setLocated(null);
      setLocationError(describeLocationResult(r));
    },
    onError: () => {
      setLocated(null);
      setLocationError("That link could not be checked. Try again.");
    },
  });

  const resolveLocation = () => {
    const url = linkInput.trim();
    if (!url || resolve.isPending) return;
    setLocationError(null);
    resolve.mutate(url);
  };

  /**
   * When the courier would be called.
   *
   * "Now" sends no instant at all, exactly as two blank boxes used to. A chosen
   * time is validated against the same rules the server will apply — this
   * dialog's copy changed, its arithmetic did not.
   */
  const schedule = useMemo(() => {
    if (timing === "now") return { ok: true as const, iso: null, timing: "immediate" as const };
    const parsed = parseScheduleInput(date, time);
    return parsed.ok ? { ok: true as const, iso: parsed.iso, timing: parsed.timing } : parsed;
  }, [timing, date, time]);

  const scheduledIso = schedule.ok && schedule.timing === "scheduled" ? schedule.iso : null;
  const remaining = scheduledIso ? Date.parse(scheduledIso) - Date.now() : 0;
  const scheduledLabel = scheduledIso ? formatScheduledFor(scheduledIso) : null;

  const missing: string[] = [];
  if (!customerName.trim()) missing.push("customer name");
  if (!customerPhone.trim()) missing.push("customer phone");
  if (!branchNo) missing.push("branch");
  if (!paymentType) missing.push("payment method");
  if (!located) missing.push("delivery location");
  if (!invoiceValue.trim()) missing.push("order value");

  const canDispatch = missing.length === 0 && schedule.ok;

  const scheduleError = !schedule.ok
    ? schedule.reason === "past"
      ? "That time has already passed."
      : schedule.reason === "unparseable"
        ? "Use a date and a time like 03:30 PM."
        : "Pick both a date and a time for the delivery."
    : null;

  const errorFor = (field: string) => errors.find((e) => e.field === field)?.message;

  const approve = (intent: AlShrouqApprovalPlan["intent"]) => {
    onApprove({
      intent,
      scheduledFor: intent === "dispatch" && scheduledIso ? scheduledIso : undefined,
      paymentType,
      // The customer's own link is what goes on the wire, not the resolved one.
      mapUrl: located?.originalUrl ?? "",
      lat: located ? String(located.latitude) : "",
      lng: located ? String(located.longitude) : "",
      customerName,
      customerPhone,
      orderValue: invoiceValue,
      details,
    });
  };

  const creating = mode === "create";
  /**
   * The primary action's name, written once.
   *
   * It appears twice — on the button, and as the heading of the block that says
   * what the button will do — and the two have to be the same words, or the
   * explanation is about some other action than the one on screen.
   */
  const primaryLabel = creating
    ? scheduledIso
      ? "Create order and schedule delivery"
      : "Create order and send"
    : scheduledIso
      ? "Schedule delivery"
      : "Send to AlShrouq";
  /** Its consequence, so nothing about the outcome is left to be guessed. */
  const outcome = describeApprovalAction(mode, "dispatch", scheduledLabel);
  const outcomeTone = alshrouqToneStyle(scheduledIso ? "info" : "success");

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[85vh] overflow-y-auto sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>{creating ? "Create this order" : "Send order to AlShrouq"}</DialogTitle>
          <DialogDescription>
            {creating
              ? "This order is going out by AlShrouq. Choose whether to save it in MilaPortal only, or to save it and hand the delivery to AlShrouq."
              : `Order ${displayNo ?? "—"}${branchLabel ? ` · ${branchLabel}` : ""}. AlShrouq needs a little more than the order records — this is asked once, here, and does not change the order.`}
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-5">
          {/* ---------------------------------------------------------------
              What is being handed over. Read-only: everything here comes from
              the order, and correcting any of it means correcting the order.
              --------------------------------------------------------------- */}
          <section className="space-y-2">
            <GroupTitle>The order</GroupTitle>
            <div className="grid grid-cols-1 gap-x-4 gap-y-3 rounded-md border border-border/60 p-3 sm:grid-cols-2">
              <Row
                label="Customer"
                value={customerName.trim() || "—"}
                muted={!customerName.trim()}
              />
              <Row
                label="Phone"
                value={customerPhone.trim() || "—"}
                muted={!customerPhone.trim()}
              />
              <Row
                label="Branch"
                value={
                  branchNo
                    ? branchLabel
                      ? `${branchNo} · ${branchLabel}`
                      : branchNo
                    : "Select a branch"
                }
                muted={!branchNo}
              />
              <Row
                label="Order value"
                value={invoiceValue.trim() ? fmtSAR(Number(invoiceValue)) : "—"}
                muted={!invoiceValue.trim()}
              />
            </div>
          </section>

          {/* ---------------------------------------------------------------
              What the courier needs and the order does not record. Asked here
              rather than on the order form, so an AlShrouq requirement can
              never stop an ordinary order being saved.
              --------------------------------------------------------------- */}
          <section className="space-y-4">
            <GroupTitle>What AlShrouq needs</GroupTitle>

            <div className="space-y-1.5">
              <Label htmlFor="ap-payment" className="text-xs font-medium">
                How the customer pays
              </Label>
              <Select value={paymentType} onValueChange={setPaymentType}>
                <SelectTrigger id="ap-payment">
                  <SelectValue placeholder="Choose a payment method" />
                </SelectTrigger>
                <SelectContent>
                  {paymentOptions.map((p) => (
                    <SelectItem key={p.id} value={String(p.id)}>
                      {p.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              {/* Never guessed from the order type: sending a driver to collect
                  cash from someone who has already paid is the failure a blank
                  prevents. */}
              <p className="text-[11px] leading-snug text-muted-foreground">
                The driver is told this. It is never assumed from the order type.
              </p>
              {errorFor("payment_type") && (
                <p className="text-xs text-destructive">{errorFor("payment_type")}</p>
              )}
            </div>

            <div className="space-y-1.5">
              <Label htmlFor="ap-map" className="text-xs font-medium">
                Where to deliver
              </Label>
              {/* The button drops under the input on a narrow dialog rather than
                  squeezing the field it belongs to. */}
              <div className="flex flex-col gap-2 sm:flex-row">
                <Input
                  id="ap-map"
                  className="min-w-0 flex-1"
                  placeholder="Paste the Google Maps link the customer sent"
                  value={linkInput}
                  onChange={(e) => setLinkInput(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") {
                      e.preventDefault();
                      resolveLocation();
                    }
                  }}
                />
                <Button
                  type="button"
                  variant="secondary"
                  className="shrink-0"
                  onClick={resolveLocation}
                  disabled={!linkInput.trim() || resolve.isPending}
                >
                  {resolve.isPending && (
                    <Loader2 className="mr-2 h-3.5 w-3.5 animate-spin" aria-hidden="true" />
                  )}
                  {resolve.isPending ? "Checking…" : "Check location"}
                </Button>
              </div>

              {located ? (
                /* A resolved location, presented as a verified fact about the
                   delivery: what the customer sent, where it points, and the
                   point a driver routes to — three separate lines because they
                   are three separate things, and an agent checking the address
                   should not have to work out which is which. */
                <div className="space-y-2 rounded-md border border-success/25 bg-success/5 p-3">
                  <p className="flex items-center gap-1.5 text-xs font-semibold text-success">
                    <CheckCircle2 className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
                    Location verified
                  </p>
                  {located.address && (
                    <p className="truncate text-sm font-medium" title={located.address} dir="auto">
                      {located.address}
                    </p>
                  )}
                  <a
                    href={located.originalUrl}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="inline-flex max-w-full items-center gap-1.5 text-xs font-medium text-primary hover:underline"
                    title={located.originalUrl}
                  >
                    <Link2 className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
                    <span className="truncate">Open the customer's link</span>
                    <ExternalLink className="h-3 w-3 shrink-0" aria-hidden="true" />
                  </a>
                  <p className="flex items-center gap-1.5 font-mono text-xs text-muted-foreground">
                    <MapPin className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
                    {formatCoordinates(located)}
                  </p>
                </div>
              ) : (
                <p className="text-[11px] leading-snug text-muted-foreground">
                  Short links are fine. The exact point a driver routes to is read from the link
                  itself, so it is never typed and never guessed.
                </p>
              )}
              {locationError && <p className="text-xs text-destructive">{locationError}</p>}
              {errorFor("customer_lat") && !locationError && (
                <p className="text-xs text-destructive">{errorFor("customer_lat")}</p>
              )}
            </div>

            <div className="space-y-1.5">
              <Label htmlFor="ap-details" className="text-xs font-medium">
                Note for the driver{" "}
                <span className="font-normal text-muted-foreground/80">&mdash; optional</span>
              </Label>
              <Textarea
                id="ap-details"
                rows={2}
                placeholder="e.g. Second floor, ring the bell twice."
                value={details}
                onChange={(e) => setDetails(e.target.value)}
              />
            </div>
          </section>

          {/* ---------------------------------------------------------------
              When. Two named choices rather than a blank field that means one
              of them — the gap between "a driver leaves now" and "a driver
              leaves tomorrow" is too large to express as an empty box.
              --------------------------------------------------------------- */}
          <section className="space-y-2">
            <GroupTitle>When to deliver</GroupTitle>
            <RadioGroup
              value={timing}
              onValueChange={(v) => setTiming(v === "later" ? "later" : "now")}
              className="gap-2"
            >
              <label
                htmlFor="ap-timing-now"
                className={`flex cursor-pointer items-start gap-2.5 rounded-md border p-3 transition-colors ${
                  timing === "now" ? "border-primary/40 bg-primary/5" : "border-border/60"
                }`}
              >
                <RadioGroupItem value="now" id="ap-timing-now" className="mt-0.5" />
                <span className="min-w-0">
                  <span className="flex items-center gap-1.5 text-sm font-medium text-foreground">
                    <Zap className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
                    As soon as possible
                  </span>
                  <span className="block text-[11.5px] leading-snug text-muted-foreground">
                    AlShrouq is contacted{" "}
                    {creating ? "the moment the order is created" : "straight away"}.
                  </span>
                </span>
              </label>
              <label
                htmlFor="ap-timing-later"
                className={`flex cursor-pointer items-start gap-2.5 rounded-md border p-3 transition-colors ${
                  timing === "later" ? "border-primary/40 bg-primary/5" : "border-border/60"
                }`}
              >
                <RadioGroupItem value="later" id="ap-timing-later" className="mt-0.5" />
                <span className="min-w-0">
                  <span className="flex items-center gap-1.5 text-sm font-medium text-foreground">
                    <CalendarClock className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
                    At a set time
                  </span>
                  <span className="block text-[11.5px] leading-snug text-muted-foreground">
                    The delivery is reserved and AlShrouq is contacted then. Nobody needs this page
                    open.
                  </span>
                </span>
              </label>
            </RadioGroup>

            {timing === "later" && (
              <div className="space-y-1.5 pt-1">
                <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
                  <div className="space-y-1">
                    <Label htmlFor="ap-date" className="text-[11px] font-medium">
                      Delivery date
                    </Label>
                    <Input
                      id="ap-date"
                      type="date"
                      value={date}
                      onChange={(e) => setDate(e.target.value)}
                    />
                  </div>
                  <div className="space-y-1">
                    <Label htmlFor="ap-time" className="text-[11px] font-medium">
                      Delivery time
                    </Label>
                    <Input
                      id="ap-time"
                      placeholder="03:30 PM"
                      value={time}
                      onChange={(e) => setTime(e.target.value)}
                    />
                  </div>
                </div>
                {scheduleError && <p className="text-xs text-destructive">{scheduleError}</p>}
              </div>
            )}
          </section>

          {/* Everything still outstanding, as a list rather than a sentence: an
              agent scanning for what to fix should not have to parse prose. */}
          {missing.length > 0 && (
            <div className="rounded-md border border-warning/30 bg-warning/5 p-3">
              <p className="flex items-center gap-1.5 text-xs font-semibold text-foreground">
                <CircleAlert className="h-3.5 w-3.5 shrink-0 text-warning" aria-hidden="true" />
                Still needed before AlShrouq can take this
              </p>
              <ul className="mt-1.5 list-inside list-disc text-[11.5px] leading-snug text-muted-foreground">
                {missing.map((item) => (
                  <li key={item}>{item}</li>
                ))}
              </ul>
            </div>
          )}

          {/* ---------------------------------------------------------------
              The choice, spelled out.

              On the create journey these are two genuinely different outcomes
              — one contacts a courier and one does not — and two button labels
              at the bottom of a scroll are not enough to tell them apart. Each
              block is headed with the exact words on its button, so the
              explanation is unmistakably about the thing being pressed.

              On an existing order there is only one action, so its consequence
              is shown once it can actually be taken.
              --------------------------------------------------------------- */}
          {(creating || canDispatch) && (
            <section className="space-y-2">
              <GroupTitle>What happens when you confirm</GroupTitle>
              {creating && (
                <div className="rounded-md border border-border/60 p-3">
                  <p className="text-sm font-medium text-foreground">Create order only</p>
                  <p className="mt-0.5 text-[12.5px] leading-snug text-muted-foreground">
                    {describeApprovalAction(mode, "order_only", null)}
                  </p>
                </div>
              )}
              <div className={`rounded-md border p-3 ${outcomeTone.band}`}>
                <p className="flex items-center gap-1.5 text-sm font-medium">
                  {scheduledIso ? (
                    <CalendarClock
                      className={`h-3.5 w-3.5 shrink-0 ${outcomeTone.icon}`}
                      aria-hidden="true"
                    />
                  ) : (
                    <Send
                      className={`h-3.5 w-3.5 shrink-0 ${outcomeTone.icon}`}
                      aria-hidden="true"
                    />
                  )}
                  {primaryLabel}
                </p>
                <p className="mt-0.5 text-[12.5px] leading-snug text-muted-foreground">
                  {outcome}
                  {scheduledIso && ` That is ${describeRemaining(remaining)} from now.`}
                </p>
              </div>
            </section>
          )}

          {result && <ResultNotice result={result} />}
        </div>

        {/* The primary action last and full-width on a phone, so the thumb lands
            on the intended one; the alternatives stay visibly secondary. */}
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
            disabled={busy || !canDispatch}
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
