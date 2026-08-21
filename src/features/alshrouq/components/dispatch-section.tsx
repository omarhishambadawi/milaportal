/**
 * AlShrouq delivery — the contextual section on the order page.
 *
 * Sits in the order form's right-hand column beside `OrderInvoicePanel` and
 * `BranchPreviewPanel`, and appears the moment the delivery method is AlShrouq,
 * on a new order as well as a saved one. It reads the form's live state through
 * props: it holds no copy of it, and changing the customer, the branch or the
 * delivery method updates or removes the section without a save or a refresh.
 *
 * ## It cannot affect saving an order
 *
 * `orderFormSchema` is untouched, customer name and phone stay optional, and
 * nothing here participates in submit. The section is rendered *by* the form the
 * same way `BranchPreviewPanel` is — a panel that reads state, never one that
 * validates it.
 *
 * ## Two states, honestly labelled
 *
 * A new order has no id, so it cannot be dispatched and does not pretend it can:
 * the status reads **Pending order creation** and the action is disabled with a
 * plain explanation. Only a saved order reaches the dispatch dialog, and even
 * then the send stops at the server-side safety gate.
 *
 * ## Why there is no delivery-fee figure
 *
 * `GET /integrations/alshrouq/config` publishes `branch_options`,
 * `payment_options`, webhook settings and `missing_secrets` — and **no fee,
 * price, charge, cost, tariff or rate of any kind**. So no fee is shown, because
 * inventing one is how a number nobody can source ends up on an operations
 * screen.
 *
 * The "3 SAR" that looked like an unexplained charge was a misread branch name:
 * the CRM's own names carry digits (`Arid 3 RDHN`, `SHUBRA 2 TIF`), so
 * `P0304 — fayzia 3 BUR` was branch code and branch *name*. Labelling each value
 * in a grid is the fix; a fee panel would have been a fiction.
 */

import { useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { Info, Loader2, MapPin, PackageCheck, Send, Truck } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
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
import {
  alshrouqDispatchContext,
  alshrouqDispatchOrder,
  alshrouqResolveLocation,
  type AlShrouqDispatchContext,
} from "@/lib/shams.functions";
import {
  describeLocationResult,
  formatCoordinates,
  type AlShrouqLocation,
} from "@/features/alshrouq/location";
import type { AlShrouqFieldError } from "@/lib/shams-crm/alshrouq-payload";
import type { AlShrouqDispatchResult } from "@/lib/shams-crm/alshrouq-dispatch.server";

/** The live form values this section reflects. Read-only — never written back. */
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

/**
 * What came back, said plainly.
 *
 * The `prepared` wording is load-bearing: with the safety gate closed the
 * pipeline runs to completion and stops before the POST, and an agent must not
 * read that as a delivery being on its way.
 */
function ResultNotice({ result }: { result: AlShrouqDispatchResult }) {
  const box = "rounded-md border p-3 text-sm";

  switch (result.kind) {
    case "prepared":
      return (
        <div className={`${box} border-dashed text-muted-foreground`}>
          <p className="font-medium text-foreground">Checked — not sent.</p>
          <p className="mt-1">
            Everything AlShrouq needs is present.{" "}
            <strong className="font-medium">
              Live dispatch is switched off, so no courier was contacted
            </strong>{" "}
            and nothing was saved.
          </p>
        </div>
      );
    case "already_dispatched":
      return (
        <div className={`${box} text-muted-foreground`}>
          <p className="font-medium text-foreground">This order has already been sent.</p>
          <p className="mt-1">
            {result.dispatch.externalOrderId
              ? `AlShrouq reference ${result.dispatch.externalOrderId}`
              : "A courier record already exists"}
            . It was not sent again.
          </p>
        </div>
      );
    case "dispatched":
      return (
        <div className={`${box} text-muted-foreground`}>
          <p className="font-medium text-foreground">Sent to AlShrouq.</p>
          <p className="mt-1">
            {result.dispatch.externalOrderId
              ? `Reference ${result.dispatch.externalOrderId}`
              : "The courier was created"}
            .
          </p>
        </div>
      );
    case "rejected":
      return (
        <div className={`${box} border-destructive/40 text-destructive`}>
          <p className="font-medium">AlShrouq refused this order.</p>
          <p className="mt-1">{result.message}</p>
        </div>
      );
    case "indeterminate":
      return (
        <div className={`${box} border-destructive/40 text-destructive`}>
          <p className="font-medium">The result is unknown.</p>
          <p className="mt-1">
            {result.message} It has <strong>not</strong> been sent again — check with AlShrouq
            before anyone tries.
          </p>
        </div>
      );
    case "branch_unresolved":
      return (
        <div className={`${box} border-destructive/40 text-destructive`}>
          <p>This branch cannot be dispatched to. Nothing was sent.</p>
        </div>
      );
    case "options_unavailable":
      return (
        <div className={`${box} border-destructive/40 text-destructive`}>
          <p>The CRM could not be reached, so nothing was sent. Try again shortly.</p>
        </div>
      );
    default:
      return (
        <div className={`${box} border-destructive/40 text-destructive`}>
          <p>Some details are still needed. Nothing was sent.</p>
        </div>
      );
  }
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
   * Branch coverage, payment methods and any existing dispatch.
   *
   * Only asked for once the order exists — a draft has nothing to dispatch, so a
   * new order costs no CRM call. Its absence degrades the section rather than
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
  const [form, setForm] = useState<DispatchForm | null>(null);
  const [result, setResult] = useState<AlShrouqDispatchResult | null>(null);

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

  /**
   * The customer's location, resolved server-side.
   *
   * The browser cannot follow `maps.app.goo.gl` — the shortener sends no CORS
   * headers — and even if it could, the authoritative coordinates must not come
   * from a client that could be asked to report anything. So the link goes to
   * the server, which follows it under an allow-list and reads the point out of
   * where it lands.
   *
   * Coordinates are never typed. They exist only as the product of a successful
   * resolution, which is why an unresolved link leaves them blank and fails
   * validation rather than becoming a location with plausible numbers attached.
   */
  const [located, setLocated] = useState<AlShrouqLocation | null>(null);
  const [locationError, setLocationError] = useState<string | null>(null);
  const resolveFn = useServerFn(alshrouqResolveLocation);

  const resolve = useMutation({
    mutationFn: (url: string) => resolveFn({ data: { url } }),
    onSuccess: (r) => {
      if (r.kind === "resolved") {
        setLocated(r.location);
        setLocationError(null);
        // The form carries the derived values; the agent never edits them.
        setForm((f) =>
          f
            ? {
                ...f,
                mapUrl: r.location.originalUrl,
                lat: String(r.location.latitude),
                lng: String(r.location.longitude),
              }
            : f,
        );
        return;
      }
      // Nothing is fabricated on failure: the link is kept so it can be
      // corrected, and the coordinates stay empty so validation keeps failing.
      setLocated(null);
      setLocationError(describeLocationResult(r));
      setForm((f) => (f ? { ...f, lat: "", lng: "" } : f));
    },
    onError: () => {
      setLocated(null);
      setLocationError("That link could not be checked. Try again.");
    },
  });

  const resolveLocation = () => {
    const url = form?.mapUrl?.trim();
    if (!url || resolve.isPending) return;
    setLocationError(null);
    resolve.mutate(url);
  };

  const errors: AlShrouqFieldError[] = result?.kind === "invalid" ? result.errors : [];
  const branch = useMemo(() => (ctx ? branchLine(ctx) : null), [ctx]);

  const already = ctx?.existingDispatch ?? null;
  const ready = saved && !!ctx && !ctx.optionsError && !!branch?.ok && !already;

  /** Never a state the backend cannot support, and never a fake "Sent". */
  const status: { label: string; tone: "muted" | "ok" | "warn" } = already
    ? { label: already.status ?? "Sent to AlShrouq", tone: "ok" }
    : !saved
      ? { label: "Pending order creation", tone: "muted" }
      : ctxPending
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

  const start = () => {
    if (!ctx) return;
    setForm({
      customerName: ctx.prefill.customerName || customerName,
      customerPhone: ctx.prefill.customerPhone || customerPhone,
      // Never guessed from `order_type`: sending a driver to collect cash from
      // someone who has already paid is the failure this blank prevents.
      paymentType: "",
      mapUrl: "",
      lat: "",
      lng: "",
      orderValue: ctx.prefill.orderValue || invoiceValue,
      details: ctx.prefill.notes || notes,
    });
    setResult(null);
    setLocated(null);
    setLocationError(null);
    dispatch.reset();
    resolve.reset();
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
              Create and send this order to AlShrouq for delivery
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
          <Row label="Payment type" value="Select at dispatch" muted />
          <Row
            label="Order value"
            value={invoiceValue.trim() ? fmtSAR(Number(invoiceValue)) : "—"}
            muted={!invoiceValue.trim()}
          />
        </div>

        {(!branch?.ok || !saved) && (
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
          {already ? (
            <span className="mr-auto flex items-center gap-1.5 text-xs text-muted-foreground">
              <PackageCheck className="h-3.5 w-3.5" aria-hidden="true" />
              {already.externalOrderId ? `Reference ${already.externalOrderId}` : "Dispatched"}
            </span>
          ) : null}
          <Button
            size="sm"
            onClick={start}
            disabled={!ready}
            title={ready ? undefined : status.label}
          >
            {ctxPending && saved ? (
              <Loader2 className="mr-2 h-3.5 w-3.5 animate-spin" aria-hidden="true" />
            ) : (
              <Send className="mr-2 h-3.5 w-3.5" aria-hidden="true" />
            )}
            Open dispatch form
          </Button>
        </div>
      </Card>

      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="max-h-[85vh] overflow-y-auto sm:max-w-lg">
          <DialogHeader>
            <DialogTitle>Send order to AlShrouq</DialogTitle>
            <DialogDescription>
              Order {ctx?.displayNo} · {branchValue}. AlShrouq needs a little more than the order
              records — this is asked once, here, and does not change the order.
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
                <Label htmlFor="al-map">Customer delivery location</Label>
                <div className="flex gap-2">
                  <Input
                    id="al-map"
                    placeholder="Paste the Google Maps link the customer sent"
                    value={form.mapUrl}
                    onChange={(e) => set({ mapUrl: e.target.value })}
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
                    disabled={!form.mapUrl.trim() || resolve.isPending}
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
