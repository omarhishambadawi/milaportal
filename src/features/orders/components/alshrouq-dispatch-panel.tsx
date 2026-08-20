import { useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { toast } from "sonner";
import { Bike, ExternalLink, Loader2, RefreshCw, XCircle } from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Badge } from "@/components/ui/badge";
import { fmtSAR } from "@/lib/branches";
import { parseCoordinatePair } from "@/lib/geo";
import { mapSearchUrl } from "@/lib/geo/maps-url";
import {
  alshrouqCancelOrder,
  alshrouqConfig,
  alshrouqDispatchOrder,
  alshrouqOrderState,
} from "@/lib/alshrouq.functions";

/**
 * Hand an order to AlShrouq, and show what AlShrouq said back.
 *
 * Only rendered for an order whose delivery method *is* AlShrouq — see
 * `OrderForm` — because the panel is meaningless for a scooter run or a counter
 * pickup, and an always-present "send to courier" button on a pickup order is an
 * invitation to a mistake.
 *
 * ## The status this shows is AlShrouq's own wording
 *
 * Whatever the CRM returns is displayed verbatim. The Portal has no mapping from
 * courier status to order status, because the courier's vocabulary is not
 * documented anywhere we have verified — and a guessed mapping would report
 * "delivered" for a word that meant something else. So there is a Refresh button
 * rather than a live feed, and its result is persisted and timelined.
 */
export function AlShrouqDispatchPanel({ orderId }: { orderId: string }) {
  const qc = useQueryClient();
  const readState = useServerFn(alshrouqOrderState);
  const readConfig = useServerFn(alshrouqConfig);
  const dispatchOrder = useServerFn(alshrouqDispatchOrder);
  const cancelOrder = useServerFn(alshrouqCancelOrder);

  const state = useQuery({
    queryKey: ["alshrouq", "state", orderId],
    queryFn: () => readState({ data: { orderId } }),
  });

  const dispatched = state.data?.dispatch ?? null;
  const live = dispatched && !dispatched.cancelledAt;

  // The payment methods are only worth a network call while there is something
  // to send: a delivered order does not need a courier's price list.
  const config = useQuery({
    queryKey: ["alshrouq", "config"],
    queryFn: () => readConfig({}),
    enabled: state.data?.configured === true && !live,
    staleTime: 10 * 60_000,
    retry: false,
  });

  const [paymentType, setPaymentType] = useState("");
  const [coords, setCoords] = useState("");
  const [details, setDetails] = useState("");
  const [prep, setPrep] = useState("");

  const parsed = useMemo(() => {
    const [latRaw, lngRaw] = coords.split(/[,\s]+/);
    return parseCoordinatePair(latRaw, lngRaw);
  }, [coords]);

  const invalidate = () => {
    void qc.invalidateQueries({ queryKey: ["alshrouq", "state", orderId] });
    void qc.invalidateQueries({ queryKey: ["order-activity", orderId] });
    void qc.invalidateQueries({ queryKey: ["orders"] });
  };

  const send = useMutation({
    mutationFn: async () => {
      const point = parsed.point;
      if (!point) throw new Error("Enter the delivery location as “latitude, longitude”.");
      return dispatchOrder({
        data: {
          orderId,
          paymentType,
          lat: point.lat,
          lng: point.lng,
          details: details.trim() || null,
          // `preparation_time` is sent only when someone states one. The CRM's
          // own default, when it publishes one, seeds the box.
          preparationTime: prep.trim() === "" ? null : Number(prep),
        },
      });
    },
    onSuccess: () => {
      toast.success("Sent to AlShrouq");
      invalidate();
    },
    onError: (e: any) => toast.error(e?.message ?? "AlShrouq did not accept the order."),
  });

  const refresh = useMutation({
    mutationFn: async () => {
      const { alshrouqRefreshOrder } = await import("@/lib/alshrouq.functions");
      return alshrouqRefreshOrder({ data: { orderId } });
    },
    onSuccess: (row) => {
      toast.success(row.status ? `AlShrouq: ${row.status}` : "AlShrouq reported no status");
      invalidate();
    },
    onError: (e: any) => toast.error(e?.message ?? "Unable to refresh the AlShrouq status."),
  });

  const cancel = useMutation({
    mutationFn: () => cancelOrder({ data: { orderId } }),
    onSuccess: () => {
      toast.success("AlShrouq delivery cancelled");
      invalidate();
    },
    onError: (e: any) => toast.error(e?.message ?? "Unable to cancel the AlShrouq delivery."),
  });

  const options = config.data?.paymentTypes ?? [];
  const defaultPrep = config.data?.defaultPreparationTime ?? null;

  return (
    <Card className="overflow-hidden shadow-sm">
      <CardHeader className="border-b border-border/60 bg-muted/25 px-4 py-3 dark:bg-muted/10">
        <CardTitle className="flex items-center gap-2 text-sm font-semibold">
          <Bike className="h-4 w-4 text-muted-foreground" /> AlShrouq delivery
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-3 p-4 text-[13px]">
        {state.isLoading && <div className="text-xs text-muted-foreground">Loading…</div>}

        {state.data && !state.data.configured && (
          <p className="text-xs text-muted-foreground">
            The Shams CRM connection is not configured on this deployment, so orders cannot be sent
            to AlShrouq from here.
          </p>
        )}

        {/* ---------------------------------------------------------------- */}
        {/* What AlShrouq says, once there is something to say               */}
        {/* ---------------------------------------------------------------- */}
        {dispatched && (
          <div className="space-y-2 rounded-md border border-border/60 bg-muted/20 p-3">
            <div className="flex flex-wrap items-center gap-2">
              <Badge variant={live ? "secondary" : "outline"} className="font-medium">
                {dispatched.status ?? "No status reported"}
              </Badge>
              {dispatched.cancelledAt && <Badge variant="outline">Cancelled</Badge>}
            </div>
            <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-[11px] text-muted-foreground">
              <dt>Our reference</dt>
              <dd className="text-foreground tabular-nums">{dispatched.clientOrderId}</dd>
              <dt>AlShrouq reference</dt>
              <dd className="text-foreground tabular-nums">{dispatched.localId ?? "—"}</dd>
              <dt>Payment</dt>
              <dd className="text-foreground">{dispatched.paymentType}</dd>
              <dt>Value</dt>
              <dd className="text-foreground">{fmtSAR(dispatched.value)}</dd>
              {dispatched.lat != null && dispatched.lng != null && (
                <>
                  <dt>Location</dt>
                  <dd>
                    <a
                      className="inline-flex items-center gap-1 text-primary hover:underline"
                      href={mapSearchUrl({ lat: dispatched.lat, lng: dispatched.lng })}
                      target="_blank"
                      rel="noreferrer"
                    >
                      {dispatched.lat.toFixed(5)}, {dispatched.lng.toFixed(5)}
                      <ExternalLink className="h-3 w-3" aria-hidden />
                    </a>
                  </dd>
                </>
              )}
            </dl>
            {dispatched.statusDetail && (
              <p className="text-[11px] text-muted-foreground">{dispatched.statusDetail}</p>
            )}

            {dispatched.timeline.length > 0 && (
              <ol className="space-y-1 border-t border-border/60 pt-2 text-[11px]">
                {dispatched.timeline.map((entry, i) => (
                  <li key={`${entry.status}-${i}`} className="flex justify-between gap-3">
                    <span className="font-medium text-foreground">{entry.status}</span>
                    <span className="text-muted-foreground">{entry.at ?? ""}</span>
                  </li>
                ))}
              </ol>
            )}

            <div className="flex flex-wrap gap-2 pt-1">
              <Button
                type="button"
                size="sm"
                variant="outline"
                onClick={() => refresh.mutate()}
                disabled={refresh.isPending || !dispatched.localId}
              >
                {refresh.isPending ? (
                  <Loader2 className="mr-1 h-3.5 w-3.5 animate-spin" aria-hidden />
                ) : (
                  <RefreshCw className="mr-1 h-3.5 w-3.5" aria-hidden />
                )}
                Refresh status
              </Button>
              {live && (
                <Button
                  type="button"
                  size="sm"
                  variant="outline"
                  onClick={() => cancel.mutate()}
                  disabled={cancel.isPending}
                >
                  <XCircle className="mr-1 h-3.5 w-3.5" aria-hidden /> Cancel delivery
                </Button>
              )}
            </div>
            <p className="text-[11px] text-muted-foreground">
              AlShrouq's wording is shown exactly as the CRM reports it, and only when asked — there
              is no automatic status feed.
            </p>
          </div>
        )}

        {/* ---------------------------------------------------------------- */}
        {/* The send form                                                    */}
        {/* ---------------------------------------------------------------- */}
        {state.data?.configured && !live && (
          <div className="space-y-3">
            {state.data.blockers.length > 0 ? (
              <ul className="list-inside list-disc space-y-1 text-xs text-destructive">
                {state.data.blockers.map((blocker) => (
                  <li key={blocker}>{blocker}</li>
                ))}
              </ul>
            ) : (
              <>
                <div className="space-y-1">
                  <Label htmlFor="alshrouq-payment" className="text-xs">
                    Payment method
                  </Label>
                  <Select value={paymentType} onValueChange={setPaymentType}>
                    <SelectTrigger id="alshrouq-payment" className="h-9">
                      <SelectValue
                        placeholder={
                          config.isLoading
                            ? "Loading AlShrouq methods…"
                            : options.length === 0
                              ? "AlShrouq published no methods"
                              : "Choose a method"
                        }
                      />
                    </SelectTrigger>
                    <SelectContent>
                      {options.map((option) => (
                        <SelectItem key={option.value} value={option.value}>
                          {option.label}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                  {config.isError && (
                    <p className="text-[11px] text-destructive">
                      The CRM did not return its payment methods, so nothing can be sent — the
                      portal will not invent one.
                    </p>
                  )}
                </div>

                <div className="space-y-1">
                  <Label htmlFor="alshrouq-coords" className="text-xs">
                    Delivery location
                  </Label>
                  <Input
                    id="alshrouq-coords"
                    className="h-9 tabular-nums"
                    inputMode="decimal"
                    placeholder="24.71355, 46.67529"
                    value={coords}
                    onChange={(e) => setCoords(e.target.value)}
                  />
                  {coords.trim() !== "" && !parsed.point && (
                    <p className="text-[11px] text-destructive">
                      {parsed.outOfRange
                        ? "That point is outside Saudi Arabia — check the order of the two values."
                        : "Enter it as “latitude, longitude”."}
                    </p>
                  )}
                </div>

                <div className="grid grid-cols-2 gap-2">
                  <div className="space-y-1">
                    <Label htmlFor="alshrouq-prep" className="text-xs">
                      Preparation (min)
                    </Label>
                    <Input
                      id="alshrouq-prep"
                      className="h-9 tabular-nums"
                      inputMode="numeric"
                      placeholder={defaultPrep != null ? String(defaultPrep) : "Optional"}
                      value={prep}
                      onChange={(e) => setPrep(e.target.value.replace(/\D/g, ""))}
                    />
                  </div>
                </div>

                <div className="space-y-1">
                  <Label htmlFor="alshrouq-details" className="text-xs">
                    Details for the driver
                  </Label>
                  <Textarea
                    id="alshrouq-details"
                    rows={2}
                    className="resize-y"
                    placeholder="Defaults to this order's notes"
                    value={details}
                    onChange={(e) => setDetails(e.target.value)}
                  />
                </div>

                <Button
                  type="button"
                  size="sm"
                  className="w-full"
                  onClick={() => send.mutate()}
                  disabled={send.isPending || !paymentType || !parsed.point}
                >
                  {send.isPending && (
                    <Loader2 className="mr-1 h-3.5 w-3.5 animate-spin" aria-hidden />
                  )}
                  {dispatched ? "Send to AlShrouq again" : "Send to AlShrouq"}
                </Button>
              </>
            )}
          </div>
        )}
      </CardContent>
    </Card>
  );
}
