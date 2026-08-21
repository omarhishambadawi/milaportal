/**
 * Sending an order to AlShrouq — the dialog, and everything before the send.
 *
 * ## Why this is a dialog and not fields on the order form
 *
 * A courier needs to know who to call, where to go, and how the customer pays.
 * The Portal is an order *log* and does not collect any of that: of 2,823
 * AlShrouq orders in the last 30 days, 7 carry both a customer name and a phone.
 * Making those required on the order form would change the daily workflow for
 * every one of those 2,823 orders to serve the handful that are dispatched — and
 * conditional-required rules in `orderFormSchema` are precisely what broke order
 * saving the last time this integration was attempted.
 *
 * So the extra information is asked for **at dispatch time, from an agent who
 * has chosen to dispatch**, and `orderFormSchema` is not touched at all. This
 * component renders *beside* `OrderForm`, shares no state with it, and cannot
 * affect saving an order.
 *
 * ## What it does not do yet
 *
 * **It does not dispatch.** Submitting validates the order through the Phase 6
 * builder and stops. No AlShrouq create endpoint is called, no courier is sent,
 * nothing is written to the database. Enabling the live send is a separate,
 * separately-reviewed step; until then this proves the data path end to end
 * without putting a driver on the road.
 */

import { useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { useParams } from "@tanstack/react-router";
import { Loader2, PackageCheck, Truck } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
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
import { alshrouqDispatchContext, type AlShrouqDispatchContext } from "@/lib/shams.functions";
import {
  buildAlshrouqOrderPayload,
  type AlShrouqFieldError,
} from "@/lib/shams-crm/alshrouq-payload";
import { ALSHROUQ } from "../constants";

/** What the agent types in the dialog. A form holds text, not numbers. */
interface DispatchForm {
  customerName: string;
  customerPhone: string;
  paymentType: string;
  mapUrl: string;
  lat: string;
  lng: string;
  orderValue: string;
  details: string;
}

function toForm(ctx: AlShrouqDispatchContext): DispatchForm {
  return {
    customerName: ctx.prefill.customerName,
    customerPhone: ctx.prefill.customerPhone,
    // Never guessed from `order_type`: sending a driver to collect cash from
    // someone who has already paid is the failure this blank prevents.
    paymentType: "",
    mapUrl: "",
    lat: "",
    lng: "",
    orderValue: ctx.prefill.orderValue,
    details: ctx.prefill.notes,
  };
}

function branchLine(ctx: AlShrouqDispatchContext): { text: string; ok: boolean } {
  const b = ctx.branch;
  if (b.kind === "resolved") {
    return { text: `${ctx.branchNo} — ${b.branchName ?? "covered"}`, ok: true };
  }
  if (b.kind === "not_covered") {
    return { text: `${ctx.branchNo} — AlShrouq does not cover this branch`, ok: false };
  }
  if (b.reason === "no_branch_on_order") {
    return { text: "This order has no branch", ok: false };
  }
  if (b.reason === "no_id_published") {
    return { text: `${ctx.branchNo} — the CRM publishes no AlShrouq id`, ok: false };
  }
  return { text: `${ctx.branchNo} — not in the CRM's branch list`, ok: false };
}

export function AlShrouqDispatchCard() {
  const params = useParams({ strict: false }) as { id?: string };
  const orderId = params?.id;

  const load = useServerFn(alshrouqDispatchContext);
  const { data: ctx, isPending } = useQuery({
    queryKey: ["alshrouq", "dispatch-context", orderId],
    enabled: !!orderId,
    // A forbidden order is a legitimate answer here (an agent viewing someone
    // else's order), not a fault worth hammering the server over.
    retry: false,
    queryFn: () => load({ data: { orderId: orderId! } }),
  });

  const [open, setOpen] = useState(false);
  const [form, setForm] = useState<DispatchForm | null>(null);
  const [errors, setErrors] = useState<AlShrouqFieldError[]>([]);
  const [validated, setValidated] = useState(false);

  const branch = useMemo(() => (ctx ? branchLine(ctx) : null), [ctx]);

  // Nothing to offer: not an AlShrouq order, or the caller may not act on it.
  if (!orderId || isPending || !ctx) return null;
  if (ctx.deliveryType !== ALSHROUQ) return null;

  const already = ctx.existingDispatch;

  const start = () => {
    setForm(toForm(ctx));
    setErrors([]);
    setValidated(false);
    setOpen(true);
  };

  /**
   * Validate, and stop.
   *
   * The payload is built by the Phase 6 builder — the same pure function the
   * transport will use — so what is checked here is exactly what would be sent.
   * Nothing is sent: this step deliberately ends at a validated payload.
   */
  const validate = () => {
    if (!form || ctx.branch.kind !== "resolved") return;
    setValidated(false);
    const result = buildAlshrouqOrderPayload(
      {
        display_no: ctx.displayNo,
        customer_name: form.customerName,
        customer_phone: form.customerPhone,
        alshrouq_map_url: form.mapUrl || null,
        alshrouq_lat: form.lat || null,
        alshrouq_lng: form.lng || null,
        alshrouq_payment_type: form.paymentType || null,
        invoice_value: form.orderValue || null,
        notes: form.details || null,
      },
      {
        alshrouqBranchId: ctx.branch.branchId,
        // The CRM's own list, read live. No enum in the app.
        paymentOptionIds: ctx.paymentOptions.map((p) => p.id),
      },
    );
    if (result.ok) {
      setErrors([]);
      setValidated(true);
      return;
    }
    setValidated(false);
    setErrors(
      result.reason === "invalid"
        ? result.errors
        : [{ field: "branch_id", message: "This branch has no AlShrouq id." }],
    );
  };

  const set = (patch: Partial<DispatchForm>) => {
    setForm((f) => (f ? { ...f, ...patch } : f));
    setValidated(false);
  };
  const errorFor = (field: string) => errors.find((e) => e.field === field)?.message;

  return (
    <>
      <Card className="mt-4">
        <CardContent className="flex flex-wrap items-center justify-between gap-3 py-4">
          <div className="space-y-1">
            <p className="flex items-center gap-2 text-sm font-medium">
              <Truck className="h-4 w-4" aria-hidden="true" />
              AlShrouq delivery
            </p>
            {already ? (
              <p className="text-sm text-muted-foreground">
                Already sent
                {already.externalOrderId ? ` — reference ${already.externalOrderId}` : ""}
                {already.status ? ` · ${already.status}` : ""}
              </p>
            ) : (
              <p className={`text-sm ${branch?.ok ? "text-muted-foreground" : "text-destructive"}`}>
                {ctx.optionsError
                  ? "The CRM could not be reached, so the branch could not be checked."
                  : branch?.text}
              </p>
            )}
          </div>

          {already ? (
            <span className="flex items-center gap-1.5 text-sm text-muted-foreground">
              <PackageCheck className="h-4 w-4" aria-hidden="true" />
              Dispatched
            </span>
          ) : (
            <Button
              variant="secondary"
              onClick={start}
              disabled={!branch?.ok || !!ctx.optionsError}
              title={branch?.ok ? undefined : branch?.text}
            >
              Send to AlShrouq
            </Button>
          )}
        </CardContent>
      </Card>

      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="max-h-[85vh] overflow-y-auto sm:max-w-lg">
          <DialogHeader>
            <DialogTitle>Send order to AlShrouq</DialogTitle>
            <DialogDescription>
              Order {ctx.displayNo} · branch {branch?.text}. AlShrouq needs a little more than the
              order records — this is asked once, here, and does not change the order.
            </DialogDescription>
          </DialogHeader>

          {form && (
            <div className="space-y-4">
              <div className="grid gap-4 sm:grid-cols-2">
                <div className="space-y-1.5">
                  <Label htmlFor="al-name">Customer name</Label>
                  <Input
                    id="al-name"
                    value={form.customerName}
                    onChange={(e) => set({ customerName: e.target.value })}
                  />
                  {errorFor("customer_name") && (
                    <p className="text-xs text-destructive">{errorFor("customer_name")}</p>
                  )}
                </div>

                <div className="space-y-1.5">
                  <Label htmlFor="al-phone">Customer phone</Label>
                  <Input
                    id="al-phone"
                    value={form.customerPhone}
                    onChange={(e) => set({ customerPhone: e.target.value })}
                  />
                  {errorFor("customer_phone") && (
                    <p className="text-xs text-destructive">{errorFor("customer_phone")}</p>
                  )}
                </div>

                <div className="space-y-1.5">
                  <Label htmlFor="al-payment">Payment method</Label>
                  <Select value={form.paymentType} onValueChange={(v) => set({ paymentType: v })}>
                    <SelectTrigger id="al-payment">
                      <SelectValue placeholder="Choose" />
                    </SelectTrigger>
                    <SelectContent>
                      {ctx.paymentOptions.map((p) => (
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
                  <Label htmlFor="al-value">Order value (SAR)</Label>
                  <Input
                    id="al-value"
                    inputMode="decimal"
                    value={form.orderValue}
                    onChange={(e) => set({ orderValue: e.target.value })}
                  />
                  {errorFor("order_value") && (
                    <p className="text-xs text-destructive">{errorFor("order_value")}</p>
                  )}
                </div>
              </div>

              <div className="space-y-1.5">
                <Label htmlFor="al-map">Delivery location (Google Maps link)</Label>
                <Input
                  id="al-map"
                  placeholder="https://maps.app.goo.gl/…"
                  value={form.mapUrl}
                  onChange={(e) => set({ mapUrl: e.target.value })}
                />
                <p className="text-xs text-muted-foreground">
                  Paste the link the customer sent. Short links are fine — the courier reads them as
                  they are.
                </p>
              </div>

              <div className="grid gap-4 sm:grid-cols-2">
                <div className="space-y-1.5">
                  <Label htmlFor="al-lat">Latitude (optional)</Label>
                  <Input
                    id="al-lat"
                    inputMode="decimal"
                    value={form.lat}
                    onChange={(e) => set({ lat: e.target.value })}
                  />
                </div>
                <div className="space-y-1.5">
                  <Label htmlFor="al-lng">Longitude (optional)</Label>
                  <Input
                    id="al-lng"
                    inputMode="decimal"
                    value={form.lng}
                    onChange={(e) => set({ lng: e.target.value })}
                  />
                </div>
              </div>
              {errorFor("customer_lat") && (
                <p className="text-xs text-destructive">{errorFor("customer_lat")}</p>
              )}

              <div className="space-y-1.5">
                <Label htmlFor="al-details">Note for the driver (optional)</Label>
                <Textarea
                  id="al-details"
                  rows={2}
                  value={form.details}
                  onChange={(e) => set({ details: e.target.value })}
                />
              </div>

              {validated && (
                <p className="rounded-md border border-dashed p-3 text-sm text-muted-foreground">
                  These details are complete and would be accepted by the AlShrouq contract.
                  <strong className="font-medium"> Sending is not enabled yet</strong> — no courier
                  has been contacted and nothing has been saved.
                </p>
              )}
            </div>
          )}

          <DialogFooter>
            <Button variant="ghost" onClick={() => setOpen(false)}>
              Close
            </Button>
            <Button onClick={validate} disabled={!form}>
              Check details
            </Button>
            <Button disabled title="Live dispatch is not enabled yet">
              <Loader2 className="mr-2 hidden h-4 w-4 animate-spin" aria-hidden="true" />
              Send to AlShrouq
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
