import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { toast } from "sonner";
import { Bike, ExternalLink, Loader2, RefreshCw, Send, XCircle } from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { fmtSAR } from "@/lib/branches";
import { isAdministrator, useAuth } from "@/lib/auth";
import { HISTORICAL_ALSHROUQ_NOTICE } from "@/lib/alshrouq/dispatch";
import {
  alshrouqCancelOrder,
  alshrouqConfig,
  alshrouqDispatchOrder,
  alshrouqOrderState,
  alshrouqSetHistorical,
} from "@/lib/alshrouq.functions";

/**
 * What AlShrouq said about this order.
 *
 * Only rendered for an order whose delivery method *is* AlShrouq — see
 * `OrderForm` — because the panel is meaningless for a scooter run or a counter
 * pickup.
 *
 * ## This is not where an order is composed
 *
 * It used to be: the panel carried its own payment, coordinates, preparation
 * time and driver-note boxes, and an agent filled them in *after* saving. That
 * asked for the delivery twice and let the courier order say something the order
 * did not. The delivery now lives on the order form beside the branch and the
 * customer, and saving the order sends it. What remains here is the record and
 * the three things that can still be done to a live delivery: refresh it, cancel
 * it, or — when the submission failed — try it again.
 *
 * ## The status shown is AlShrouq's own wording
 *
 * Whatever the CRM returns is displayed verbatim. The Portal has no mapping from
 * courier status to order status, because the courier's vocabulary is the
 * courier's — and a guessed mapping would report "delivered" for a word that
 * meant something else. So there is a Refresh button rather than a live feed,
 * and its result is persisted and timelined.
 */
export function AlShrouqDispatchPanel({ orderId }: { orderId: string }) {
  const qc = useQueryClient();
  const readState = useServerFn(alshrouqOrderState);
  const readConfig = useServerFn(alshrouqConfig);
  const dispatchOrder = useServerFn(alshrouqDispatchOrder);
  const cancelOrder = useServerFn(alshrouqCancelOrder);
  const setHistorical = useServerFn(alshrouqSetHistorical);
  const { role } = useAuth();
  // Owner and admin only. The server checks the same thing against `has_role`;
  // this only decides whether to offer it.
  const mayMarkHistorical = isAdministrator(role);

  const state = useQuery({
    queryKey: ["alshrouq", "state", orderId],
    queryFn: () => readState({ data: { orderId } }),
  });

  const dispatched = state.data?.dispatch ?? null;
  const live = Boolean(dispatched && !dispatched.cancelledAt);
  const blockers = state.data?.blockers ?? [];

  // Only to put a name on the stored numeric payment id. Not needed while there
  // is nothing dispatched to label.
  const config = useQuery({
    queryKey: ["alshrouq", "config"],
    queryFn: () => readConfig({}),
    enabled: state.data?.configured === true && dispatched != null,
    staleTime: 10 * 60_000,
    retry: false,
  });
  const paymentLabel =
    config.data?.paymentTypes.find((p) => p.value === dispatched?.paymentType)?.label ??
    (dispatched?.paymentType != null ? String(dispatched.paymentType) : "—");

  const invalidate = () => {
    void qc.invalidateQueries({ queryKey: ["alshrouq", "state", orderId] });
    void qc.invalidateQueries({ queryKey: ["order-activity", orderId] });
    void qc.invalidateQueries({ queryKey: ["orders"] });
  };

  const retry = useMutation({
    mutationFn: () => dispatchOrder({ data: { orderId } }),
    onSuccess: (row) => {
      toast.success(
        row.externalOrderId
          ? `Sent to AlShrouq — reference ${row.externalOrderId}`
          : "Sent to AlShrouq",
      );
      invalidate();
    },
    onError: (e: any) => toast.error(e?.message ?? "AlShrouq did not accept the order."),
  });

  const markHistorical = useMutation({
    mutationFn: (historical: boolean) => setHistorical({ data: { orderId, historical } }),
    onSuccess: (r) => {
      toast.success(
        r.historical ? "Marked as a historical AlShrouq order" : "Historical marking removed",
      );
      invalidate();
    },
    onError: (e: any) => toast.error(e?.message ?? "Unable to change that."),
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
              <dt>Our order no.</dt>
              <dd className="text-foreground tabular-nums">{dispatched.clientOrderId}</dd>
              {/* AlShrouq's own number, which is what a supervisor quotes on the
                  phone. `localId` is the CRM's internal handle and means nothing
                  to the courier, so it is not shown as "the" reference. */}
              <dt>AlShrouq order no.</dt>
              <dd className="text-foreground tabular-nums">{dispatched.externalOrderId ?? "—"}</dd>
              {/* The branch the courier collected from, read off the dispatch
                  row rather than the order. Invoice review can move the order to
                  the branch that had the stock, and that is a true statement
                  about the order — but the van went here. */}
              {dispatched.branchNo && (
                <>
                  <dt>Collected from</dt>
                  <dd className="text-foreground">{dispatched.branchNo}</dd>
                </>
              )}
              <dt>Payment</dt>
              <dd className="text-foreground">{paymentLabel}</dd>
              <dt>Value</dt>
              <dd className="text-foreground">{fmtSAR(dispatched.value)}</dd>
              {dispatched.mapUrl && (
                <>
                  <dt>Map URL</dt>
                  <dd>
                    <a
                      className="inline-flex items-center gap-1 text-primary hover:underline"
                      href={dispatched.mapUrl}
                      target="_blank"
                      rel="noreferrer"
                    >
                      Open the customer's location
                      <ExternalLink className="h-3 w-3" aria-hidden />
                    </a>
                  </dd>
                </>
              )}
              {dispatched.lat != null && dispatched.lng != null && (
                <>
                  <dt>Lat / Lng</dt>
                  <dd className="text-foreground tabular-nums">
                    {dispatched.lat.toFixed(5)}, {dispatched.lng.toFixed(5)}
                  </dd>
                </>
              )}
              {dispatched.trackingUrl && (
                <>
                  <dt>Tracking</dt>
                  <dd>
                    <a
                      className="inline-flex items-center gap-1 text-primary hover:underline"
                      href={dispatched.trackingUrl}
                      target="_blank"
                      rel="noreferrer"
                    >
                      Follow the driver
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
        {/* Held for a chosen time                                           */}
        {/* ---------------------------------------------------------------- */}
        {/* Nothing has been sent and no dispatch row exists — the courier has
            not been told anything yet. The sweep sends it when the time comes. */}
        {state.data?.held && state.data.scheduledAt && !dispatched && (
          <div className="rounded-md border border-border/60 bg-muted/20 p-3">
            <Badge variant="outline" className="font-medium">
              Scheduled
            </Badge>
            <p className="mt-1.5 text-[11px] text-muted-foreground">
              Held until {new Date(state.data.scheduledAt).toLocaleString()}. Nothing has been sent
              to AlShrouq yet — the portal submits it automatically at that time.
            </p>
          </div>
        )}

        {/* ---------------------------------------------------------------- */}
        {/* Raised before the integration existed                            */}
        {/* ---------------------------------------------------------------- */}
        {/* A note and nothing else. No blockers — the fields it "lacks" were
            never going to exist — and deliberately no button: this delivery was
            arranged by a person months ago, and the only thing a control here
            could achieve is a second driver at the customer's door. */}
        {state.data?.historical && (
          <p className="text-[11px] text-muted-foreground">{HISTORICAL_ALSHROUQ_NOTICE}</p>
        )}

        {/* ---------------------------------------------------------------- */}
        {/* Not sent yet — why, and the way to try again                     */}
        {/* ---------------------------------------------------------------- */}
        {state.data?.configured && !state.data.historical && !state.data.held && !dispatched && (
          <div className="space-y-2">
            <p className="text-[11px] text-muted-foreground">
              This order has not reached AlShrouq. Saving an AlShrouq order sends it automatically;
              if that did not happen, the order's timeline says why.
            </p>
            {blockers.length > 0 && (
              <ul className="space-y-1 text-[11px] text-destructive">
                {blockers.map((b) => (
                  <li key={b}>{b}</li>
                ))}
              </ul>
            )}
            <Button
              type="button"
              size="sm"
              variant="outline"
              onClick={() => retry.mutate()}
              disabled={retry.isPending || blockers.length > 0}
            >
              {retry.isPending ? (
                <Loader2 className="mr-1 h-3.5 w-3.5 animate-spin" aria-hidden />
              ) : (
                <Send className="mr-1 h-3.5 w-3.5" aria-hidden />
              )}
              Send to AlShrouq
            </Button>
          </div>
        )}
        {/* ---------------------------------------------------------------- */}
        {/* Owner / admin: declare this one historical                        */}
        {/* ---------------------------------------------------------------- */}
        {/* Offered only to owner and admin, and refused server-side for anyone
            else. Hidden while a delivery is live: the courier already has that
            order, and calling it historical afterwards would only hide it. */}
        {mayMarkHistorical && state.data?.configured && !live && (
          <label className="flex items-start gap-2 border-t border-border/60 pt-3 text-[11px] text-muted-foreground">
            <input
              type="checkbox"
              className="mt-0.5"
              checked={state.data.historicalManual}
              disabled={markHistorical.isPending}
              onChange={(e) => markHistorical.mutate(e.target.checked)}
            />
            <span>
              Historical AlShrouq order — automatic dispatch is not applicable. Stops this order
              being sent to AlShrouq, on save and on any schedule.
            </span>
          </label>
        )}
      </CardContent>
    </Card>
  );
}
