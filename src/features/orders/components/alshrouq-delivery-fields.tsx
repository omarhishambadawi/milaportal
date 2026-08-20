import { useCallback, useMemo, useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { X } from "lucide-react";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Button } from "@/components/ui/button";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { mapSearchUrl, parseMapsUrl, parseCoordinatePair, roundCoordinate } from "@/lib/geo";
import { geoResolveMapLink } from "@/lib/geo.functions";
import { alshrouqConfig } from "@/lib/alshrouq.functions";

/**
 * The four fields an AlShrouq delivery needs, on the order form itself.
 *
 * Only these four. The existing Customer Name, Customer Phone and Branch are
 * reused as-is rather than restated here — a second copy of a customer's phone
 * on one form is two things to keep in step and one of them will be wrong. There
 * is deliberately no preparation time, no driver note, no timeslot and no
 * service fee: the CRM accepts them, but none is required to create a delivery
 * and every one of them is another box between an agent and a saved order.
 *
 * ## Why a link *and* a point
 *
 * They are not interchangeable. The link the customer sent over WhatsApp names
 * their building; the coordinates are what a courier routes to. The CRM's own
 * records carry both, so the Portal captures both — pasting a link fills in the
 * point, and typing a point generates a link.
 */

export interface AlShrouqDelivery {
  map_url: string;
  lat: string;
  lng: string;
  payment_type: string;
  /** A datetime-local value. Empty means send as soon as the order is saved. */
  scheduled_at: string;
}

interface Props {
  value: AlShrouqDelivery;
  onChange: (next: AlShrouqDelivery) => void;
  /** The branch on the order, so its AlShrouq coverage can be shown here. */
  branchNo: string | null;
  disabled?: boolean;
  /** Field-level messages from the form's own schema, keyed as the form keys. */
  errors?: Partial<Record<keyof AlShrouqDelivery, string>>;
}

type LinkStatus =
  | { kind: "idle" }
  | { kind: "resolving" }
  | { kind: "no_location" }
  | { kind: "out_of_range" }
  | { kind: "failed" };

export function AlShrouqDeliveryFields({ value, onChange, branchNo, disabled, errors }: Props) {
  const [status, setStatus] = useState<LinkStatus>({ kind: "idle" });
  const resolveFn = useServerFn(geoResolveMapLink);

  /**
   * The payment methods, from the CRM.
   *
   * Never a hardcoded list: the ids are the CRM's (1 COD, 2 SPAN Machine,
   * 3 Paid, 4 AlshrouqPay today) and it owns the set. When the call fails the
   * select is empty and says so, rather than offering a guess that would be sent
   * to a courier as fact.
   */
  const config = useQuery({
    queryKey: ["alshrouq", "config"],
    queryFn: () => alshrouqConfig({}),
    staleTime: 10 * 60_000,
    retry: false,
  });
  const paymentOptions = config.data?.paymentTypes ?? [];

  /**
   * What the CRM says about this branch.
   *
   * The same `branch_options` list the server resolves against at dispatch, so the
   * warning here and the refusal there cannot disagree. Undefined while the
   * config is still loading, which shows nothing rather than a false alarm.
   */
  const branch = branchNo
    ? config.data?.branches.find((entry) => entry.code === branchNo.trim())
    : undefined;
  const coverage: "loading" | "covered" | "not_covered" | "unmapped" = !config.data
    ? "loading"
    : !branchNo
      ? "loading"
      : !branch
        ? "unmapped"
        : branch.covered
          ? "covered"
          : "not_covered";

  /** Keep the newest request only: an agent editing a link fires several. */
  const requestId = useRef(0);

  const setPoint = useCallback(
    (next: { lat: number; lng: number }, mapUrl?: string) => {
      onChange({
        ...value,
        map_url: mapUrl ?? mapSearchUrl(next),
        lat: String(roundCoordinate(next.lat)),
        lng: String(roundCoordinate(next.lng)),
      });
      setStatus({ kind: "idle" });
    },
    [onChange, value],
  );

  /**
   * Read a pasted link.
   *
   * The local parse runs first and usually settles it — the coordinates are
   * already in the URL, so no request is made. Only a shortener, which carries
   * nothing but a redirect the browser cannot follow, reaches the server.
   */
  const readLink = useCallback(
    async (raw: string) => {
      const parsed = parseMapsUrl(raw);
      if (parsed.point) {
        setPoint(parsed.point, raw);
        return;
      }
      if (parsed.outOfRange) {
        setStatus({ kind: "out_of_range" });
        return;
      }
      if (!parsed.needsResolution) {
        setStatus(raw.trim() ? { kind: "no_location" } : { kind: "idle" });
        return;
      }

      const id = ++requestId.current;
      setStatus({ kind: "resolving" });
      try {
        const result = await resolveFn({ data: { url: raw.trim() } });
        if (id !== requestId.current) return;
        if (result.point) setPoint(result.point, result.url);
        else setStatus({ kind: result.outOfRange ? "out_of_range" : "no_location" });
      } catch {
        if (id === requestId.current) setStatus({ kind: "failed" });
      }
    },
    [resolveFn, setPoint],
  );

  /**
   * A typed pair, checked the same way a pasted one is.
   *
   * Editing either box regenerates the link — but only when the pair is whole
   * and inside the country, so a half-typed latitude does not blank the link the
   * customer sent.
   */
  const setCoordinate = (which: "lat" | "lng", raw: string) => {
    const next = { ...value, [which]: raw };
    const parsed = parseCoordinatePair(next.lat, next.lng);
    if (parsed.point) {
      // A pasted link is kept: it names the place, and the typed point agrees
      // with it closely enough that overwriting would lose the name for nothing.
      const parsedExisting = parseMapsUrl(value.map_url);
      const keepsLink =
        parsedExisting.point != null &&
        Math.abs(parsedExisting.point.lat - parsed.point.lat) < 1e-4 &&
        Math.abs(parsedExisting.point.lng - parsed.point.lng) < 1e-4;
      next.map_url = keepsLink ? value.map_url : mapSearchUrl(parsed.point);
    }
    onChange(next);
    setStatus({ kind: "idle" });
  };

  const clear = () => {
    requestId.current++;
    onChange({ ...value, map_url: "", lat: "", lng: "" });
    setStatus({ kind: "idle" });
  };

  const pairError = useMemo(() => {
    if (value.lat === "" || value.lng === "") return null;
    const parsed = parseCoordinatePair(value.lat, value.lng);
    if (parsed.point) return null;
    return parsed.outOfRange
      ? "That point is outside Saudi Arabia — the two values may be swapped."
      : "Enter the latitude and longitude as plain numbers.";
  }, [value.lat, value.lng]);

  return (
    <div className="space-y-3">
      {/* Coverage, stated before anything is typed. AlShrouq does not serve
          every branch, and finding that out at dispatch — after the order is
          filled in — wastes the agent's call. The server refuses these too;
          this is so nobody gets that far. */}
      {coverage === "not_covered" && (
        <p className="rounded-md border border-destructive/40 bg-destructive/5 px-2.5 py-2 text-[11px] text-destructive">
          AlShrouq does not cover {branch?.name ?? branchNo}
          {branch?.note ? ` (${branch.note})` : ""}. This order can still be saved, but it cannot be
          sent to AlShrouq — choose another branch or another delivery method.
        </p>
      )}
      {coverage === "unmapped" && (
        <p className="rounded-md border border-destructive/40 bg-destructive/5 px-2.5 py-2 text-[11px] text-destructive">
          {branchNo} is not in AlShrouq's branch list, so this order cannot be sent to them.
        </p>
      )}

      {/* Row 1 — the link and the point it resolves to, together, because an
          agent checking one against the other should not have to scroll. */}
      <div className="grid gap-3 sm:grid-cols-[minmax(0,2fr)_minmax(0,1fr)_minmax(0,1fr)]">
        <div className="space-y-1">
          <Label htmlFor="order-alshrouq-map-url" className="text-xs">
            Map URL
          </Label>
          <div className="flex gap-2">
            <Input
              id="order-alshrouq-map-url"
              value={value.map_url}
              placeholder="Paste the customer's Google Maps link…"
              disabled={disabled}
              dir="ltr"
              onChange={(event) => {
                onChange({ ...value, map_url: event.target.value });
                setStatus({ kind: "idle" });
              }}
              // On blur and on Enter rather than on every keystroke: a shortener
              // costs a request, and a half-typed URL resolves to nothing anyway.
              onBlur={(event) => void readLink(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Enter") {
                  event.preventDefault();
                  void readLink((event.target as HTMLInputElement).value);
                }
              }}
            />
            {!disabled && (value.map_url || value.lat || value.lng) && (
              <Button
                type="button"
                variant="outline"
                size="icon"
                onClick={clear}
                title="Clear location"
              >
                <X className="h-4 w-4" />
              </Button>
            )}
          </div>
        </div>

        <div className="space-y-1">
          <Label htmlFor="order-alshrouq-lat" className="text-xs">
            Lat
          </Label>
          <Input
            id="order-alshrouq-lat"
            className="tabular-nums"
            inputMode="decimal"
            dir="ltr"
            placeholder="24.7135500"
            disabled={disabled}
            value={value.lat}
            onChange={(event) => setCoordinate("lat", event.target.value)}
          />
        </div>

        <div className="space-y-1">
          <Label htmlFor="order-alshrouq-lng" className="text-xs">
            Lng
          </Label>
          <Input
            id="order-alshrouq-lng"
            className="tabular-nums"
            inputMode="decimal"
            dir="ltr"
            placeholder="46.6752900"
            disabled={disabled}
            value={value.lng}
            onChange={(event) => setCoordinate("lng", event.target.value)}
          />
        </div>
      </div>

      <StatusLine status={status} />
      {pairError && <p className="text-[11px] text-destructive">{pairError}</p>}
      {errors?.lat && <p className="text-[11px] text-destructive">{errors.lat}</p>}

      {/* Row 2 — how they pay, and when it goes. */}
      <div className="grid gap-3 sm:grid-cols-[minmax(0,2fr)_minmax(0,2fr)]">
        <div className="space-y-1">
          <Label htmlFor="order-alshrouq-payment" className="text-xs">
            Payment Method
          </Label>
          <Select
            value={value.payment_type}
            disabled={disabled || paymentOptions.length === 0}
            onValueChange={(next) => onChange({ ...value, payment_type: next })}
          >
            <SelectTrigger id="order-alshrouq-payment">
              <SelectValue
                placeholder={
                  config.isLoading
                    ? "Loading AlShrouq's methods…"
                    : paymentOptions.length === 0
                      ? "Unavailable"
                      : "Choose a payment method"
                }
              />
            </SelectTrigger>
            <SelectContent>
              {paymentOptions.map((option) => (
                <SelectItem key={option.value} value={String(option.value)}>
                  {option.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          {!config.isLoading && paymentOptions.length === 0 && (
            <p className="text-[11px] text-destructive">
              The CRM did not return its payment methods, so this order cannot be sent to AlShrouq
              yet.
            </p>
          )}
          {errors?.payment_type && (
            <p className="text-[11px] text-destructive">{errors.payment_type}</p>
          )}
        </div>

        {/* When to send it.
            Empty means "on save", which is what most orders want. A future time
            holds the order: AlShrouq ignores the delivery time the CRM accepts,
            so the only way to make a delivery late is to send the request late.
            The Portal keeps the appointment on the server, so the agent can
            close the tab. */}
        <div className="space-y-1">
          <Label htmlFor="order-alshrouq-schedule" className="text-xs">
            Send to AlShrouq
          </Label>
          <Input
            id="order-alshrouq-schedule"
            type="datetime-local"
            disabled={disabled}
            value={value.scheduled_at}
            onChange={(event) => onChange({ ...value, scheduled_at: event.target.value })}
          />
          <p className="text-[11px] text-muted-foreground">
            {value.scheduled_at
              ? new Date(value.scheduled_at).getTime() > Date.now()
                ? "Held until this time, then sent automatically."
                : "This time has passed — it will be sent on save."
              : "Leave empty to send as soon as the order is saved."}
          </p>
        </div>
      </div>
    </div>
  );
}

function StatusLine({ status }: { status: LinkStatus }) {
  if (status.kind === "resolving") {
    return <p className="text-[11px] text-muted-foreground">Following the link…</p>;
  }
  if (status.kind === "out_of_range") {
    return (
      <p className="text-[11px] text-destructive">
        That location is outside Saudi Arabia — the latitude and longitude may be swapped.
      </p>
    );
  }
  if (status.kind === "no_location") {
    return (
      <p className="text-[11px] text-muted-foreground">
        That link names a place but carries no coordinates — type the latitude and longitude
        instead.
      </p>
    );
  }
  if (status.kind === "failed") {
    return (
      <p className="text-[11px] text-destructive">
        Could not follow that link — type the latitude and longitude instead.
      </p>
    );
  }
  return null;
}
