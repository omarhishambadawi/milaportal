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
 * ## The coordinates are read first, and typed only as a fallback
 *
 * They are read out of the pasted link by `parseMapsUrl`, which is pure and
 * keyless — no Places call, no API key, no round trip for numbers already in the
 * URL. A short `maps.app.goo.gl` link carries none, and the browser cannot
 * follow it (the shortener sends no CORS headers), so that one case offers
 * **Check location**, which asks the server.
 *
 * Nothing here invents a coordinate. What changed is what happens when nothing
 * can be read: the fields used to be left empty and read-only, which stated the
 * principle honestly and left the agent with a delivery they could not hand over
 * and no control to fix it. So a link that will not parse now says so — as a
 * warning, not as grey helper text — and the two boxes accept a typed pair, held
 * to the same KSA bounds `parseCoordinatePair` holds a parsed one to. A typed
 * pair survives further edits to the link box; a link that *does* parse still
 * wins outright, because the customer's own pin beats a typed one.
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
import { fmtSAR } from "@/lib/branches";
import { FORM_FIELD } from "@/lib/panel";
import { cn } from "@/lib/utils";
import { alshrouqResolveLocation } from "@/lib/shams.functions";
import { describeLocationResult } from "../location";
import {
  alshrouqOrderValue,
  coverageAllowsDispatch,
  describeBranchCoverage,
  describeLocationReading,
  formatCoordinate,
  type LocationReading,
} from "../order-requirements";
import { alshrouqPaymentOptions } from "../payment-methods";
import type { AlShrouqOrderState } from "../use-alshrouq-order";

/**
 * One coordinate — read from the link when it could be read, typed when it
 * could not.
 *
 * It was read-only, on the principle that a coordinate is evidence rather than
 * an opinion. That holds right up until no link will parse, at which point the
 * principle leaves an agent with a delivery they cannot hand over and nothing
 * to do about it. So the box accepts a number, and the *hint* below carries the
 * principle instead: the link is what should fill this in, and typing is the
 * fallback. `readOnly` still applies wherever the form as a whole is read-only.
 *
 * `inputMode="decimal"` so a phone offers the minus sign and the point, and a
 * monospace face so two pasted numbers line up and a transposed digit shows.
 */
function Coordinate({
  id,
  label,
  value,
  onChange,
  readOnly,
}: {
  id: string;
  label: string;
  value: string;
  onChange: (value: string) => void;
  readOnly?: boolean;
}) {
  return (
    <div className="min-w-0 space-y-1">
      {/* A sub-field of the location block above it, so it is quieter than a
          top-level form label but carries the same weight — semibold, compact,
          scannable — that every other label on this form now does. */}
      <Label htmlFor={id} className="text-[11px] font-semibold text-muted-foreground">
        {label}
      </Label>
      <Input
        id={id}
        inputMode="decimal"
        autoComplete="off"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        readOnly={readOnly}
        aria-readonly={readOnly ? "true" : undefined}
        placeholder="—"
        className={`h-8 font-mono text-xs ${readOnly ? "cursor-default bg-muted/40" : ""}`}
      />
    </div>
  );
}

export function AlShrouqOrderRequirements({
  state,
  invoiceValue = "",
  readOnly,
}: {
  state: AlShrouqOrderState;
  /**
   * The order's value as the form holds it, for the collection readout.
   *
   * Passed in rather than read from a store, because this component has never
   * owned order state and must not start: it renders what the form has, exactly
   * as the card and the dialog do.
   */
  invoiceValue?: string;
  readOnly?: boolean;
}) {
  const {
    mapUrl,
    setMapUrl,
    latitudeText,
    longitudeText,
    setLatitude,
    setLongitude,
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

  /**
   * The order's value, and the part of it a driver is told to collect.
   *
   * `alshrouqOrderValue` is the one rule: it returns 0 on a method whose label
   * says the customer has already paid, and the entered value otherwise. Shared
   * with the confirmation dialog and the dispatch card so no screen can promise
   * a collection the payload does not send.
   */
  const orderValueText = invoiceValue.trim();
  const collectionText = alshrouqOrderValue(invoiceValue, state.paidPayment).trim();
  const collectsNothing = orderValueText !== "" && Number(collectionText) === 0;

  const covered = coverageAllowsDispatch(coverage);
  const locationNote = describeLocationReading(location);
  const canCheck = location.kind === "needs_check" && !resolve.isPending && !readOnly;

  /**
   * A link is present and it did not yield a point.
   *
   * `needs_check` is excluded on purpose: a short link has not failed, it simply
   * has to be asked about, and there is a button beside it for exactly that.
   * Warning about it would be crying wolf on the most common link an agent
   * pastes. `empty` is excluded because nothing has been attempted yet.
   */
  const unread =
    mapUrl.trim() !== "" &&
    (location.kind === "unsupported" ||
      location.kind === "out_of_range" ||
      location.kind === "invalid_pair" ||
      resolveError !== null);

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
              : "border-border/50 bg-muted/20 dark:bg-muted/10"
        }`}
      >
        {covered ? (
          <CheckCircle2
            className="mt-px h-3.5 w-3.5 shrink-0 text-success-ink"
            aria-hidden="true"
          />
        ) : coverage.kind === "not_covered" || coverage.kind === "unlisted" ? (
          <AlertTriangle className="mt-px h-3.5 w-3.5 shrink-0 text-warning" aria-hidden="true" />
        ) : (
          <Info className="mt-px h-3.5 w-3.5 shrink-0 text-muted-foreground" aria-hidden="true" />
        )}
        <div className="min-w-0 flex-1">
          <p className={covered ? "font-medium text-foreground" : "text-foreground"}>
            {describeBranchCoverage(coverage)}
          </p>
          {/* `text-left` beside `dir="auto"`, for the same reason every other
              value on this page carries it: the branch name is a fact in a
              column, not a paragraph. It may still truncate — the branch panel
              in the column opposite carries the name in full. */}
          {coverage.kind === "covered" && coverage.branchName && (
            <p
              className="truncate text-left text-muted-foreground"
              dir="auto"
              title={coverage.branchName}
            >
              {coverage.branchName}
            </p>
          )}
        </div>
      </div>

      {/* ---------------------------------------------------------------
          Delivery. One block, read top to bottom: the link, the point it
          produced, and whether that point is good. The customer's own link is
          the authority and goes on the wire verbatim; the coordinates are what
          routing consumes.
          --------------------------------------------------------------- */}
      <div className="space-y-2">
        <p className={cn("leading-none", FORM_FIELD.group)}>Delivery</p>
        <Label htmlFor="alshrouq-map" className={FORM_FIELD.label}>
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

        {/* The pair and the verdict on it, bound together rather than
            stacked as three equal siblings. The line underneath is metadata
            confirming these two numbers — it is not a fourth control, and it
            used to sit as far from them as they sat from the link. */}
        <div className="space-y-1.5">
          <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
            {/*
            The stored text, verbatim. It used to show the *parsed* value
            instead, which is what let the box read a valid "24.53738" while the
            field behind it held something `Number()` could not read — the form
            looked right and the confirmation said NaN. A box that shows what it
            holds cannot disagree with anything downstream, and it also stops
            reformatting under a person mid-keystroke.
          */}
            <Coordinate
              id="alshrouq-lat"
              label="Latitude"
              value={latitudeText}
              onChange={setLatitude}
              readOnly={readOnly}
            />
            <Coordinate
              id="alshrouq-lng"
              label="Longitude"
              value={longitudeText}
              onChange={setLongitude}
              readOnly={readOnly}
            />
          </div>

          {location.kind === "resolved" ? (
            <p className="flex items-center gap-1.5 text-[11px] font-medium text-success-ink">
              <MapPin className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
              Verified location
            </p>
          ) : (
            /*
              The one case that must never pass silently: a link is present and no
              point came out of it. That used to render as grey helper text
              alongside the standing "coordinates are never typed" line, which read
              as an explanation rather than as something to act on — so the agent
              saw two empty boxes, no way to fill them, and no statement that
              anything had failed. It is now a warning, and it names the way out.
            */
            <p
              className={`flex items-start gap-1.5 text-[11px] leading-snug ${
                unread ? "font-medium text-warning" : "text-muted-foreground"
              }`}
              role={unread ? "status" : undefined}
            >
              {unread && (
                <AlertTriangle className="mt-px h-3.5 w-3.5 shrink-0" aria-hidden="true" />
              )}
              <span>
                {resolveError ??
                  locationNote ??
                  "Coordinates are read from the link. Type them only when it cannot be read."}
              </span>
            </p>
          )}
        </div>
      </div>

      {/* ---------------------------------------------------------------
          Payment & collection.

          Two ordinary fields on the form's own grid, under a rule — not a
          panel. It was a bordered, tinted box for one revision, which put a
          card inside the Order details card and made the least-edited part of
          this section the heaviest thing in it. The grouping it was reaching
          for is done by adjacency and a separator instead, which is what the
          rest of the form uses.

          The two amounts stay named apart, because they genuinely differ and
          conflating them is how somebody is asked to pay twice: the order value
          is what this order is worth, and the collection amount is the only one
          of the two that is an instruction to a driver. The collection figure
          comes from `alshrouqOrderValue` — the same call the confirmation
          dialog and the dispatch card make — so no screen can promise a
          collection the payload does not send.
          --------------------------------------------------------------- */}
      <div className="space-y-2 border-t border-border/50 pt-3.5">
        <p className={cn("leading-none", FORM_FIELD.group)}>Payment &amp; collection</p>
        <div className="grid grid-cols-1 gap-x-5 gap-y-3.5 sm:grid-cols-2">
          <div className="min-w-0 space-y-1.5">
            <Label htmlFor="alshrouq-payment" className={FORM_FIELD.label}>
              <span>Payment method</span>
              <span className="text-destructive" title="Required for AlShrouq">
                *
              </span>
            </Label>
            <Select value={paymentType} onValueChange={setPaymentType} disabled={readOnly}>
              <SelectTrigger id="alshrouq-payment">
                <SelectValue placeholder="How does the customer pay?" />
              </SelectTrigger>
              {/* The live list when the CRM has answered, its published names when
                it has not.

                A Radix `Select` whose value matches none of its items renders
                the *placeholder*, so a reopened order carrying payment method 3
                read "How does the customer pay?" — an answered field presenting
                itself as unanswered — until the config request landed, and
                permanently wherever it does not. See `alshrouqPaymentOptions`. */}
              <SelectContent>
                {alshrouqPaymentOptions(options.paymentOptions).map((p) => (
                  <SelectItem key={p.id} value={String(p.id)}>
                    {p.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <p className={FORM_FIELD.hint}>
              The driver is told this. It is never assumed from the order type.
            </p>
          </div>

          {/* A readout, not two boxes.

            These were a pair of separately bordered rows — two framed
            rectangles, one above the other, inside the Order details card — to
            present two numbers and a sentence. They are one divided list now:
            what the order is worth, then what a driver is actually told to take,
            then why the second is what it is. The rule between them is the whole
            of the separation, and it is the one that matters, because these two
            figures are the ones nobody may confuse.

            The two stay named apart because they genuinely differ, and
            conflating them is how somebody is asked to pay twice. The collection
            figure comes from `alshrouqOrderValue` — the same call the
            confirmation dialog and the dispatch card make — so no screen can
            promise a collection the payload does not send. */}
          <div className="min-w-0 space-y-1.5">
            <p className={FORM_FIELD.label}>Collection</p>
            <dl className="text-[13px]">
              <div className="flex items-baseline justify-between gap-3 py-1">
                <dt className="truncate text-muted-foreground">Order value</dt>
                <dd className="shrink-0 tabular-nums">
                  {orderValueText ? fmtSAR(Number(orderValueText)) : "—"}
                </dd>
              </div>
              <div className="flex items-baseline justify-between gap-3 border-t border-border/50 py-1 pt-1.5">
                <dt className="truncate text-muted-foreground">Collected by AlShrouq</dt>
                <dd
                  className={`shrink-0 font-semibold tabular-nums ${
                    collectsNothing ? "text-success-ink" : "text-foreground"
                  }`}
                >
                  {collectionText ? fmtSAR(Number(collectionText)) : "—"}
                </dd>
              </div>
            </dl>
            <p className={FORM_FIELD.hint}>
              {collectsNothing
                ? "Already paid — the driver collects nothing."
                : "The driver collects this amount at the door."}
            </p>
          </div>
        </div>
      </div>
    </div>
  );
}
