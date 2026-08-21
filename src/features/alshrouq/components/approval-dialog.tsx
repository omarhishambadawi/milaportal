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
 */

import { useEffect, useMemo, useState } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { CalendarClock, Loader2, MapPin, Send } from "lucide-react";
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
   * Blank date and time mean "now" — an agent who does not pick a slot wants the
   * order to go out, not to be parked indefinitely. A chosen time is validated
   * against the same rules the server will apply.
   */
  const schedule = useMemo(() => {
    if (!date.trim() && !time.trim())
      return { ok: true as const, iso: null, timing: "immediate" as const };
    const parsed = parseScheduleInput(date, time);
    return parsed.ok ? { ok: true as const, iso: parsed.iso, timing: parsed.timing } : parsed;
  }, [date, time]);

  const scheduledIso = schedule.ok && schedule.timing === "scheduled" ? schedule.iso : null;
  const remaining = scheduledIso ? Date.parse(scheduledIso) - Date.now() : 0;

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
        : "Add both a date and a time, or leave both blank to send now."
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

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[85vh] overflow-y-auto sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>{creating ? "Create this order" : "Send order to AlShrouq"}</DialogTitle>
          <DialogDescription>
            {creating
              ? "This order is going out by AlShrouq. Choose whether to record it only, or to record it and hand it to AlShrouq."
              : `Order ${displayNo ?? "—"}${branchLabel ? ` · ${branchLabel}` : ""}. AlShrouq needs a little more than the order records — this is asked once, here, and does not change the order.`}
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4">
          <div className="grid grid-cols-1 gap-x-4 gap-y-3 rounded-md border border-border/60 p-3 sm:grid-cols-2">
            <Row label="Customer" value={customerName.trim() || "—"} muted={!customerName.trim()} />
            <Row label="Phone" value={customerPhone.trim() || "—"} muted={!customerPhone.trim()} />
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

          <div className="space-y-1.5">
            <Label htmlFor="ap-payment">Payment method</Label>
            <Select value={paymentType} onValueChange={setPaymentType}>
              <SelectTrigger id="ap-payment">
                <SelectValue placeholder="Choose" />
              </SelectTrigger>
              <SelectContent>
                {paymentOptions.map((p) => (
                  <SelectItem key={p.id} value={String(p.id)}>
                    {p.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            {errorFor("payment_type") && (
              <p className="text-xs text-destructive">{errorFor("payment_type")}</p>
            )}
          </div>

          <div className="space-y-1.5">
            <Label htmlFor="ap-map">Customer delivery location</Label>
            <div className="flex gap-2">
              <Input
                id="ap-map"
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
                onClick={resolveLocation}
                disabled={!linkInput.trim() || resolve.isPending}
              >
                {resolve.isPending && (
                  <Loader2 className="mr-2 h-3.5 w-3.5 animate-spin" aria-hidden="true" />
                )}
                {resolve.isPending ? "Checking…" : "Resolve"}
              </Button>
            </div>
            {located ? (
              <div className="rounded-md border border-border/60 bg-muted/20 p-3 dark:bg-muted/10">
                <p className="flex items-center gap-1.5 text-xs font-medium text-foreground">
                  <MapPin className="h-3.5 w-3.5" aria-hidden="true" />
                  Location verified
                </p>
                {located.address && (
                  <p className="mt-1 truncate text-sm" title={located.address}>
                    {located.address}
                  </p>
                )}
                <p className="mt-1 font-mono text-xs text-muted-foreground">
                  {formatCoordinates(located)}
                </p>
              </div>
            ) : (
              <p className="text-xs text-muted-foreground">
                Short links are fine — they are followed on the server to read the coordinates a
                courier routes to. Latitude and longitude come from the link and are not typed.
              </p>
            )}
            {locationError && <p className="text-xs text-destructive">{locationError}</p>}
            {errorFor("customer_lat") && !locationError && (
              <p className="text-xs text-destructive">{errorFor("customer_lat")}</p>
            )}
          </div>

          <div className="space-y-1.5">
            <Label htmlFor="ap-details">Note for the driver (optional)</Label>
            <Textarea
              id="ap-details"
              rows={2}
              value={details}
              onChange={(e) => setDetails(e.target.value)}
            />
          </div>

          <div className="space-y-1.5">
            <Label>Delivery date &amp; time</Label>
            <div className="grid grid-cols-2 gap-2">
              <Input type="date" value={date} onChange={(e) => setDate(e.target.value)} />
              <Input
                placeholder="03:30 PM"
                value={time}
                onChange={(e) => setTime(e.target.value)}
              />
            </div>
            <p className="text-xs text-muted-foreground">
              Leave both blank to hand the order over
              {creating ? " as soon as it is created" : " now"}.
            </p>
            {scheduleError && <p className="text-xs text-destructive">{scheduleError}</p>}
          </div>

          {scheduledIso && (
            <div className="rounded-md border border-border/60 bg-muted/20 p-3 text-sm dark:bg-muted/10">
              <p className="flex items-center gap-1.5 font-medium text-foreground">
                <CalendarClock className="h-3.5 w-3.5" aria-hidden="true" />
                Scheduled AlShrouq delivery
              </p>
              <p className="mt-1 text-muted-foreground">
                {formatScheduledFor(scheduledIso)} — AlShrouq will be contacted in{" "}
                {describeRemaining(remaining)}.{" "}
                <strong className="font-medium">No courier is contacted now.</strong>
              </p>
            </div>
          )}

          {missing.length > 0 && (
            <p className="text-xs text-muted-foreground">
              Sending to AlShrouq also needs: {missing.join(", ")}.
            </p>
          )}

          {result && <ResultNotice result={result} />}
        </div>

        <DialogFooter className="flex-col gap-2 sm:flex-row sm:justify-end">
          <Button variant="ghost" onClick={() => onOpenChange(false)} disabled={busy}>
            {creating ? "Cancel" : "Close"}
          </Button>
          {creating && (
            <Button variant="secondary" onClick={() => approve("order_only")} disabled={busy}>
              Create order only
            </Button>
          )}
          <Button onClick={() => approve("dispatch")} disabled={busy || !canDispatch}>
            {busy ? (
              <Loader2 className="mr-2 h-4 w-4 animate-spin" aria-hidden="true" />
            ) : scheduledIso ? (
              <CalendarClock className="mr-2 h-4 w-4" aria-hidden="true" />
            ) : (
              <Send className="mr-2 h-4 w-4" aria-hidden="true" />
            )}
            {creating
              ? scheduledIso
                ? "Create order and schedule delivery"
                : "Create order and send"
              : scheduledIso
                ? "Schedule delivery"
                : "Send to AlShrouq"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
