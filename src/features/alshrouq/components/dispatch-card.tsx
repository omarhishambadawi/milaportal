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
 * **It does not dispatch.** Submitting calls `alshrouqDispatchOrder`, which runs
 * the whole pipeline server-side and stops at the safety gate. No AlShrouq create
 * endpoint is reached, no courier is sent, nothing is written. Enabling the live
 * send is a separate, separately-reviewed step.
 *
 * ## Why visibility does not depend on the CRM
 *
 * This card originally decided whether to render from the dispatch context —
 * which logs into the CRM first. While that round trip was in flight it rendered
 * nothing, and if it failed it rendered nothing *permanently and silently*: no
 * card, no error, no way to tell a non-AlShrouq order from a broken one.
 *
 * Visibility now comes from the order's own `delivery_type`, read from the cache
 * `useOrderForm` has already filled. The CRM-dependent parts — branch coverage,
 * payment methods — degrade the card instead of hiding it, and are only fetched
 * for an order that is actually going to AlShrouq.
 */

import { useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
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
import { supabase } from "@/integrations/supabase/client";
import { queryKeys } from "@/lib/query-keys";
import {
  alshrouqDispatchContext,
  alshrouqDispatchOrder,
  type AlShrouqDispatchContext,
} from "@/lib/shams.functions";
import type { AlShrouqFieldError } from "@/lib/shams-crm/alshrouq-payload";
import type { AlShrouqDispatchResult } from "@/lib/shams-crm/alshrouq-dispatch.server";
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

/**
 * What came back, said plainly.
 *
 * The `prepared` wording is the load-bearing part: with the safety gate closed
 * the pipeline runs to completion and stops before the POST, and an agent must
 * not read that as a delivery being on its way. It says no courier was
 * contacted, because none was.
 */
function ResultNotice({ result }: { result: AlShrouqDispatchResult }) {
  const box = "rounded-md border p-3 text-sm";

  if (result.kind === "prepared") {
    return (
      <div className={`${box} border-dashed text-muted-foreground`}>
        <p className="font-medium text-foreground">Checked — not sent.</p>
        <p className="mt-1">
          Everything AlShrouq needs is present, and the order was prepared for branch{" "}
          {result.payload.branchId} as {result.payload.clientOrderId}.{" "}
          <strong className="font-medium">
            Live dispatch is switched off, so no courier was contacted
          </strong>{" "}
          and nothing was saved.
        </p>
      </div>
    );
  }

  if (result.kind === "already_dispatched") {
    return (
      <div className={`${box} text-muted-foreground`}>
        <p className="font-medium text-foreground">This order has already been sent.</p>
        <p className="mt-1">
          {result.dispatch.externalOrderId
            ? `AlShrouq reference ${result.dispatch.externalOrderId}`
            : "A courier record already exists"}
          {result.dispatch.status ? ` · ${result.dispatch.status}` : ""}. It was not sent again.
        </p>
      </div>
    );
  }

  if (result.kind === "dispatched") {
    return (
      <div className={`${box} text-muted-foreground`}>
        <p className="font-medium text-foreground">Sent to AlShrouq.</p>
        <p className="mt-1">
          {result.dispatch.externalOrderId
            ? `Reference ${result.dispatch.externalOrderId}`
            : "The courier was created"}
          {result.dispatch.status ? ` · ${result.dispatch.status}` : ""}.
        </p>
      </div>
    );
  }

  if (result.kind === "rejected") {
    return (
      <div className={`${box} border-destructive/40 text-destructive`}>
        <p className="font-medium">AlShrouq refused this order.</p>
        <p className="mt-1">{result.message} Nothing was dispatched.</p>
      </div>
    );
  }

  if (result.kind === "indeterminate") {
    return (
      <div className={`${box} border-destructive/40 text-destructive`}>
        <p className="font-medium">The result is unknown.</p>
        <p className="mt-1">
          {result.message} It has <strong>not</strong> been sent again — check with AlShrouq before
          anyone tries.
        </p>
      </div>
    );
  }

  if (result.kind === "branch_unresolved") {
    return (
      <div className={`${box} border-destructive/40 text-destructive`}>
        <p>This branch cannot be dispatched to. Nothing was sent.</p>
      </div>
    );
  }

  if (result.kind === "options_unavailable") {
    return (
      <div className={`${box} border-destructive/40 text-destructive`}>
        <p>The CRM could not be reached, so nothing was sent. Try again shortly.</p>
      </div>
    );
  }

  // `invalid` — the field messages are shown beside their inputs.
  return (
    <div className={`${box} border-destructive/40 text-destructive`}>
      <p>Some details are still needed. Nothing was sent.</p>
    </div>
  );
}

export function AlShrouqDispatchCard() {
  const params = useParams({ strict: false }) as { id?: string };
  const orderId = params?.id;

  /**
   * Whether to show at all, decided from the order itself.
   *
   * Deliberately **not** from the dispatch context. That context reaches the CRM
   * — a login plus a config read — and keying visibility on it meant the card
   * rendered nothing until a third-party round trip finished, and nothing at all
   * if it failed. An order's delivery method has no such dependency.
   *
   * Same query key and same shape as the one `useOrderForm` already runs, so
   * React Query serves it from cache and this costs no extra request.
   */
  const { data: order } = useQuery({
    queryKey: queryKeys.orders.detail(orderId),
    enabled: !!orderId,
    queryFn: async () => {
      const { data, error } = await supabase
        .from("orders")
        .select("*")
        .eq("id", orderId!)
        .maybeSingle();
      if (error) throw error;
      return data;
    },
  });

  const isAlShrouqOrder =
    (order as { delivery_type?: string | null } | null | undefined)?.delivery_type === ALSHROUQ;

  /**
   * The branch, payment methods and any existing dispatch.
   *
   * Only asked for once the order is known to be an AlShrouq one, so opening an
   * ordinary order no longer causes a CRM login at all. Its absence degrades the
   * card rather than hiding it.
   */
  const load = useServerFn(alshrouqDispatchContext);
  const {
    data: ctx,
    isPending: ctxPending,
    isError: ctxError,
  } = useQuery({
    queryKey: ["alshrouq", "dispatch-context", orderId],
    enabled: !!orderId && isAlShrouqOrder,
    // A forbidden order is a legitimate answer here (an agent viewing someone
    // else's order), not a fault worth hammering the server over.
    retry: false,
    queryFn: () => load({ data: { orderId: orderId! } }),
  });

  const qc = useQueryClient();
  const send = useServerFn(alshrouqDispatchOrder);
  const [open, setOpen] = useState(false);
  const [form, setForm] = useState<DispatchForm | null>(null);
  const [result, setResult] = useState<AlShrouqDispatchResult | null>(null);

  /**
   * The one call this component makes.
   *
   * It sends what the agent typed and nothing else — no payload, no endpoint, no
   * branch id. The server builds, checks and (when the gate is open) sends. A
   * component that assembled requests is how the previous integration turned a
   * re-render into a second courier.
   */
  const dispatch = useMutation({
    mutationFn: (f: DispatchForm) =>
      send({
        data: {
          orderId: orderId!,
          customerName: f.customerName,
          customerPhone: f.customerPhone,
          paymentType: f.paymentType,
          mapUrl: f.mapUrl,
          lat: f.lat,
          lng: f.lng,
          orderValue: f.orderValue,
          details: f.details,
        },
      }),
    onSuccess: (r) => {
      setResult(r);
      if (r.kind === "dispatched" || r.kind === "already_dispatched") {
        qc.invalidateQueries({ queryKey: ["alshrouq", "dispatch-context", orderId] });
      }
    },
  });

  const errors: AlShrouqFieldError[] = result?.kind === "invalid" ? result.errors : [];
  const branch = useMemo(() => (ctx ? branchLine(ctx) : null), [ctx]);

  // The only reason to render nothing: this is not an AlShrouq order.
  if (!orderId || !isAlShrouqOrder) return null;

  const already = ctx?.existingDispatch ?? null;
  /** Dispatchable only once the CRM has answered and the branch is covered. */
  const ready = !!ctx && !ctx.optionsError && !!branch?.ok;

  /** What the card says under its title while the CRM is being consulted. */
  const statusLine = ctxPending
    ? "Checking branch coverage…"
    : ctxError
      ? "Dispatch details could not be loaded. You may not have permission to send this order."
      : ctx?.optionsError
        ? "The CRM could not be reached, so the branch could not be checked."
        : (branch?.text ?? "");

  const start = () => {
    if (!ctx) return;
    setForm(toForm(ctx));
    setResult(null);
    dispatch.reset();
    setOpen(true);
  };

  const submit = () => {
    if (!form || dispatch.isPending) return;
    setResult(null);
    dispatch.mutate(form);
  };

  const set = (patch: Partial<DispatchForm>) => {
    setForm((f) => (f ? { ...f, ...patch } : f));
    setResult(null);
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
              <p
                className={`text-sm ${ctxPending || ready ? "text-muted-foreground" : "text-destructive"}`}
              >
                {statusLine}
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
              disabled={!ready}
              title={ready ? undefined : statusLine}
            >
              {ctxPending && <Loader2 className="mr-2 h-4 w-4 animate-spin" aria-hidden="true" />}
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
              Order {ctx?.displayNo} · branch {branch?.text}. AlShrouq needs a little more than the
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
                      {(ctx?.paymentOptions ?? []).map((p) => (
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

              {dispatch.isError && (
                <p className="rounded-md border border-destructive/40 p-3 text-sm text-destructive">
                  The dispatch check could not be completed. You may not have permission to send
                  this order.
                </p>
              )}

              {result && <ResultNotice result={result} />}
            </div>
          )}

          <DialogFooter>
            <Button variant="ghost" onClick={() => setOpen(false)}>
              Close
            </Button>
            <Button onClick={submit} disabled={!form || dispatch.isPending}>
              {dispatch.isPending && (
                <Loader2 className="mr-2 h-4 w-4 animate-spin" aria-hidden="true" />
              )}
              {dispatch.isPending ? "Checking…" : "Send to AlShrouq"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
