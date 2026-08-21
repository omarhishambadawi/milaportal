/**
 * Approving what happens when an AlShrouq order is created.
 *
 * The one place an agent decides between "just record this order" and "record it
 * and send a courier". It opens from the page's single Create order action, so
 * there is no second button competing with it.
 *
 * ## What it is not
 *
 * It is not a dispatcher. Choosing "send" closes the dialog and hands a plan
 * back to the form; the form saves the order and only then calls the server
 * function, which decides — from the time, on the server's clock — whether to
 * contact a courier now or park a frozen snapshot for later. Nothing here talks
 * to AlShrouq, and there is no field a caller could set to make it.
 *
 * ## Why the scheduled wording is so explicit
 *
 * "Create order and send" reads, to a person in a hurry, as *sent*. When the
 * chosen time is in the future nothing is sent at all — the courier is contacted
 * hours later by a job nobody is watching. So the button changes verb, the
 * summary names the exact instant, and the confirmation says how long away it is
 * in words. An agent should never close this dialog believing a driver is on the
 * way when one is not.
 */

import { useMemo, useState } from "react";
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
import { fmtSAR } from "@/lib/branches";
import { alshrouqPaymentOptions, alshrouqResolveLocation } from "@/lib/shams.functions";
import type { AlShrouqPaymentOption } from "@/lib/shams-crm/alshrouq-config.server";
import { describeLocationResult, formatCoordinates, type AlShrouqLocation } from "../location";
import { describeRemaining, formatScheduledFor, parseScheduleInput } from "../scheduling";

/** What the form is asked to do once the agent decides. */
export interface AlShrouqApprovalPlan {
  intent: "order_only" | "dispatch";
  /** Present only for `dispatch`. Absent means immediate. */
  scheduledFor?: string;
  paymentType: string;
  mapUrl: string;
  lat: string;
  lng: string;
  /** Copied from the order at the moment of approval, not re-read later. */
  customerName: string;
  customerPhone: string;
  orderValue: string;
}

export interface AlShrouqCreateApprovalProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Live order values, for the summary. Never written back. */
  customerName: string;
  customerPhone: string;
  branchNo: string | null;
  invoiceValue: string;
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

export function AlShrouqCreateApproval({
  open,
  onOpenChange,
  customerName,
  customerPhone,
  branchNo,
  invoiceValue,
  busy,
  onApprove,
}: AlShrouqCreateApprovalProps) {
  const [paymentType, setPaymentType] = useState("");
  const [linkInput, setLinkInput] = useState("");
  const [located, setLocated] = useState<AlShrouqLocation | null>(null);
  const [locationError, setLocationError] = useState<string | null>(null);
  const [date, setDate] = useState("");
  const [time, setTime] = useState("");

  /**
   * The CRM's payment methods.
   *
   * Fetched here rather than passed in: a new order has no id to hang a dispatch
   * context off, and the list belongs to the CRM in any case. Only while the
   * dialog is open, so opening an order costs nothing.
   */
  const optionsFn = useServerFn(alshrouqPaymentOptions);
  const { data: paymentOptions = [] } = useQuery<AlShrouqPaymentOption[]>({
    queryKey: ["alshrouq", "payment-options"],
    enabled: open,
    staleTime: 5 * 60_000,
    retry: false,
    queryFn: () => optionsFn({ data: undefined }),
  });

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

  const approve = (intent: AlShrouqApprovalPlan["intent"]) => {
    onApprove({
      intent,
      scheduledFor: intent === "dispatch" && scheduledIso ? scheduledIso : undefined,
      paymentType,
      mapUrl: located?.originalUrl ?? "",
      lat: located ? String(located.latitude) : "",
      lng: located ? String(located.longitude) : "",
      customerName,
      customerPhone,
      orderValue: invoiceValue,
    });
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[85vh] overflow-y-auto sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>Create this order</DialogTitle>
          <DialogDescription>
            This order is going out by AlShrouq. Choose whether to record it only, or to record it
            and hand it to AlShrouq.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4">
          <div className="grid grid-cols-1 gap-x-4 gap-y-3 rounded-md border border-border/60 p-3 sm:grid-cols-2">
            <Row label="Customer" value={customerName.trim() || "—"} muted={!customerName.trim()} />
            <Row label="Phone" value={customerPhone.trim() || "—"} muted={!customerPhone.trim()} />
            <Row label="Branch" value={branchNo ?? "Select a branch"} muted={!branchNo} />
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
          </div>

          <div className="space-y-1.5">
            <Label htmlFor="ap-map">Customer delivery location</Label>
            <div className="flex gap-2">
              <Input
                id="ap-map"
                placeholder="Paste the Google Maps link the customer sent"
                value={linkInput}
                onChange={(e) => setLinkInput(e.target.value)}
              />
              <Button
                type="button"
                variant="secondary"
                onClick={() => linkInput.trim() && resolve.mutate(linkInput.trim())}
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
                {located.address && <p className="mt-1 truncate text-sm">{located.address}</p>}
                <p className="mt-1 font-mono text-xs text-muted-foreground">
                  {formatCoordinates(located)}
                </p>
              </div>
            ) : (
              <p className="text-xs text-muted-foreground">
                Coordinates are read from the link on the server. They are not typed.
              </p>
            )}
            {locationError && <p className="text-xs text-destructive">{locationError}</p>}
          </div>

          <div className="space-y-1.5">
            <Label>Reschedule delivery date &amp; time</Label>
            <div className="grid grid-cols-2 gap-2">
              <Input type="date" value={date} onChange={(e) => setDate(e.target.value)} />
              <Input
                placeholder="03:30 PM"
                value={time}
                onChange={(e) => setTime(e.target.value)}
              />
            </div>
            <p className="text-xs text-muted-foreground">
              Leave both blank to hand the order over as soon as it is created.
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
        </div>

        <DialogFooter className="flex-col gap-2 sm:flex-row sm:justify-end">
          <Button variant="ghost" onClick={() => onOpenChange(false)} disabled={busy}>
            Cancel
          </Button>
          <Button variant="secondary" onClick={() => approve("order_only")} disabled={busy}>
            Create order only
          </Button>
          <Button onClick={() => approve("dispatch")} disabled={busy || !canDispatch}>
            {busy ? (
              <Loader2 className="mr-2 h-4 w-4 animate-spin" aria-hidden="true" />
            ) : scheduledIso ? (
              <CalendarClock className="mr-2 h-4 w-4" aria-hidden="true" />
            ) : (
              <Send className="mr-2 h-4 w-4" aria-hidden="true" />
            )}
            {scheduledIso ? "Create order and schedule delivery" : "Create order and send"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
