/**
 * The AlShrouq fields, on the order form where the rest of the order is.
 *
 * Appears the moment the delivery method is AlShrouq and collects the three
 * things a courier needs that no order column holds: where the customer is, how
 * they pay, and — read rather than asked — the point a driver routes to. It also
 * says, immediately, whether AlShrouq serves the chosen branch.
 *
 * ## Why it is here and not in the dialog
 *
 * These used to be asked for *after* the agent pressed **Create order**, which
 * made the confirmation a second form: three more questions between the agent
 * and the order they had already finished. Asking here means they are answered
 * while the customer is still on the phone, and the dialog can go back to being
 * a confirmation.
 *
 * ## The coordinates are never typed
 *
 * They are read out of the pasted link by `parseMapsUrl`, which is pure and
 * keyless — no Places call, no API key, no round trip for numbers already in the
 * URL. A short `maps.app.goo.gl` link carries none, and the browser cannot
 * follow it (the shortener sends no CORS headers), so that one case offers
 * **Check location**, which asks the server. Nothing here invents a coordinate:
 * a link that cannot be read leaves the fields empty and the handover blocked.
 */

import { useMutation } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { AlertTriangle, CheckCircle2, Info, Loader2, MapPin } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { alshrouqResolveLocation } from "@/lib/shams.functions";
import { describeLocationResult } from "../location";
import {
  coverageAllowsDispatch,
  describeBranchCoverage,
  describeLocationReading,
  formatCoordinate,
} from "../order-requirements";
import type { AlShrouqOrderState } from "../use-alshrouq-order";

/** One read-only coordinate, labelled so a number is never read as a reference. */
function Coordinate({ label, value }: { label: string; value: string }) {
  return (
    <div className="min-w-0 space-y-1">
      <Label className="text-[11px] font-medium text-muted-foreground">{label}</Label>
      <Input
        readOnly
        tabIndex={-1}
        aria-readonly="true"
        value={value}
        placeholder="—"
        className="h-8 cursor-default bg-muted/40 font-mono text-xs"
      />
    </div>
  );
}

export function AlShrouqOrderRequirements({
  state,
  readOnly,
}: {
  state: AlShrouqOrderState;
  readOnly?: boolean;
}) {
  const {
    mapUrl,
    setMapUrl,
    latitude,
    longitude,
    applyResolved,
    location,
    paymentType,
    setPaymentType,
    coverage,
    options,
  } = state;

  /**
   * Following a short link, on the server.
   *
   * The one case the browser genuinely cannot do itself. `resolveMapLink` holds
   * the URL to an allow-list of Google hosts over HTTPS, re-checked on every hop,
   * reads only the `Location` header and never the body, and caps length, hops
   * and time. It writes nothing and dispatches nothing.
   */
  const resolveFn = useServerFn(alshrouqResolveLocation);
  const resolve = useMutation({
    mutationFn: (url: string) => resolveFn({ data: { url } }),
    onSuccess: (r) => {
      // Nothing fabricated: a link that will not resolve leaves the coordinates
      // empty, and the failure below says which kind of link would work.
      if (r.kind === "resolved") applyResolved(r.location.latitude, r.location.longitude);
    },
  });

  const resolveError =
    resolve.data && resolve.data.kind !== "resolved"
      ? describeLocationResult(resolve.data)
      : resolve.isError
        ? "That link could not be checked. Try again."
        : null;

  const covered = coverageAllowsDispatch(coverage);
  const locationNote = describeLocationReading(location);
  const canCheck = location.kind === "needs_check" && !resolve.isPending && !readOnly;

  return (
    <div className="space-y-3.5 sm:col-span-2">
      {/* Coverage first: if AlShrouq does not serve the branch, nothing below it
          matters, and an agent should learn that before typing an address. */}
      <div
        className={`flex items-start gap-2.5 rounded-md border px-3 py-2.5 text-[11.5px] leading-snug ${
          covered
            ? "border-success/25 bg-success/5"
            : coverage.kind === "not_covered" || coverage.kind === "unlisted"
              ? "border-warning/30 bg-warning/5"
              : "border-border/60 bg-muted/20 dark:bg-muted/10"
        }`}
      >
        {covered ? (
          <CheckCircle2 className="mt-px h-3.5 w-3.5 shrink-0 text-success" aria-hidden="true" />
        ) : coverage.kind === "not_covered" || coverage.kind === "unlisted" ? (
          <AlertTriangle className="mt-px h-3.5 w-3.5 shrink-0 text-warning" aria-hidden="true" />
        ) : (
          <Info className="mt-px h-3.5 w-3.5 shrink-0 text-muted-foreground" aria-hidden="true" />
        )}
        <div className="min-w-0 flex-1">
          <p className={covered ? "font-medium text-foreground" : "text-foreground"}>
            {describeBranchCoverage(coverage)}
          </p>
          {coverage.kind === "covered" && coverage.branchName && (
            <p className="truncate text-muted-foreground" dir="auto" title={coverage.branchName}>
              {coverage.branchName}
            </p>
          )}
        </div>
      </div>

      {/* ---------------------------------------------------------------
          Delivery location. One compact block: the link, then the point
          it produced. The customer's own link is the authority and goes
          on the wire verbatim; the coordinates are what routing consumes.
          --------------------------------------------------------------- */}
      <div className="space-y-2">
        <Label htmlFor="alshrouq-map" className="flex items-center gap-1.5 text-xs font-medium">
          <span>Delivery location</span>
          <span className="text-destructive" title="Required for AlShrouq">
            *
          </span>
        </Label>
        <div className="flex flex-col gap-2 sm:flex-row">
          <Input
            id="alshrouq-map"
            className="min-w-0 flex-1"
            placeholder="Paste the Google Maps link the customer sent"
            value={mapUrl}
            onChange={(e) => setMapUrl(e.target.value)}
            disabled={readOnly}
            // Long URLs shorten instead of stretching the column they sit in.
            style={{ textOverflow: "ellipsis" }}
          />
          {/* Only for the one link this browser cannot read. No permanently
              disabled button beside a link that needs no checking. */}
          {location.kind === "needs_check" && (
            <Button
              type="button"
              variant="secondary"
              className="shrink-0"
              onClick={() => canCheck && resolve.mutate(mapUrl.trim())}
              disabled={!canCheck}
            >
              {resolve.isPending && (
                <Loader2 className="mr-2 h-3.5 w-3.5 animate-spin" aria-hidden="true" />
              )}
              {resolve.isPending ? "Checking…" : "Check location"}
            </Button>
          )}
        </div>

        <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
          <Coordinate label="Latitude" value={latitude ? formatCoordinate(Number(latitude)) : ""} />
          <Coordinate
            label="Longitude"
            value={longitude ? formatCoordinate(Number(longitude)) : ""}
          />
        </div>

        {location.kind === "resolved" ? (
          <p className="flex items-center gap-1.5 text-[11px] font-medium text-success">
            <MapPin className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
            Verified location
          </p>
        ) : (
          <p className="text-[11px] leading-snug text-muted-foreground">
            {resolveError ??
              locationNote ??
              "Coordinates are read from the link. They are never typed."}
          </p>
        )}
      </div>

      {/* ---------------------------------------------------------------
          Payment. Prominent, because sending a driver to collect cash from
          somebody who has already paid is the failure a blank prevents —
          so it is never guessed from the order type.
          --------------------------------------------------------------- */}
      <div className="space-y-1.5">
        <Label htmlFor="alshrouq-payment" className="flex items-center gap-1.5 text-xs font-medium">
          <span>Payment method</span>
          <span className="text-destructive" title="Required for AlShrouq">
            *
          </span>
        </Label>
        <Select value={paymentType} onValueChange={setPaymentType} disabled={readOnly}>
          <SelectTrigger id="alshrouq-payment">
            <SelectValue placeholder="How does the customer pay?" />
          </SelectTrigger>
          <SelectContent>
            {options.paymentOptions.map((p) => (
              <SelectItem key={p.id} value={String(p.id)}>
                {p.label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <p className="text-[11px] leading-snug text-muted-foreground">
          The driver is told this. It is never assumed from the order type.
        </p>
      </div>
    </div>
  );
}
