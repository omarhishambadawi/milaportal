import { AlertTriangle, Loader2, RefreshCw, Star } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { cn } from "@/lib/utils";
import { DISPLAY_LOCALE, fmtSAR } from "@/lib/branches";
import { formatSaudiPhone } from "@/lib/phone";
import {
  INTELLIGENCE_MESSAGES,
  type CustomerIntelligence,
  type IntelligenceState,
} from "@/lib/telesales/customer-intelligence";

/**
 * What the Shams MIS knows about this customer.
 *
 * One component, two densities. The lead detail wants the headline — loyalty,
 * last purchase, what they have bought before — because an agent is reading it
 * with a customer already on the line. The customer profile wants that plus the
 * full history table. `compact` chooses.
 *
 * Everything on screen is labelled as coming from Shams MIS and stamped with
 * when it was actually retrieved, because an agent quoting a loyalty balance to
 * a customer needs to know whether they are reading something from a minute ago
 * or from when they opened the tab an hour back.
 */

export interface MisCustomerPanelProps {
  state: IntelligenceState;
  data: CustomerIntelligence | null;
  retrievedAt: number | null;
  isFetching: boolean;
  onRetry: () => void;
  /** The name Telesales holds, so a mismatch can be shown rather than resolved. */
  telesalesName: string | null;
  /** Canonical phone, for the "looked up as" line. */
  phone: string | null;
  compact?: boolean;
}

/** "2 minutes ago". Coarse, because the exact second is never the question. */
function retrievedLabel(at: number | null): string | null {
  if (!at) return null;
  const seconds = Math.max(0, Math.round((Date.now() - at) / 1000));
  if (seconds < 60) return "just now";
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes} minute${minutes === 1 ? "" : "s"} ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours} hour${hours === 1 ? "" : "s"} ago`;
  return `${Math.round(hours / 24)} days ago`;
}

/** `2026-08-28` → `28 Aug 2026`, without constructing an instant. */
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
function day(value: string | null): string {
  if (!value) return "—";
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!m) return value;
  return `${Number(m[3])} ${MONTHS[Number(m[2]) - 1]} ${m[1]}`;
}

export function MisCustomerPanel({
  state,
  data,
  retrievedAt,
  isFetching,
  onRetry,
  telesalesName,
  phone,
  compact = false,
}: MisCustomerPanelProps) {
  const retrieved = retrievedLabel(retrievedAt);

  return (
    <Card>
      <CardHeader className="pb-3">
        <div className="flex flex-wrap items-center gap-2">
          <CardTitle className="text-base">Shams MIS</CardTitle>
          {/*
           * The source and its freshness, always. Never "live" -- this is a
           * lookup whose answer is held in the browser for five minutes, and
           * saying otherwise would be a claim the integration does not make.
           */}
          {state === "ready" && retrieved ? (
            <span className="text-xs text-muted-foreground">Retrieved {retrieved}</span>
          ) : null}
          {isFetching ? (
            <Loader2 className="h-3.5 w-3.5 animate-spin text-muted-foreground" />
          ) : null}
          {phone ? (
            <span className="ml-auto font-mono text-xs text-muted-foreground">
              {formatSaudiPhone(phone)}
            </span>
          ) : null}
        </div>
      </CardHeader>

      <CardContent className="space-y-4">
        {state === "loading" ? (
          <p className="flex items-center gap-2 py-4 text-sm text-muted-foreground">
            <Loader2 className="h-4 w-4 animate-spin" />
            Loading customer history…
          </p>
        ) : state !== "ready" ? (
          <NonReady state={state} isFetching={isFetching} onRetry={onRetry} />
        ) : (
          <Ready data={data!} telesalesName={telesalesName} compact={compact} />
        )}
      </CardContent>
    </Card>
  );
}

/**
 * Everything that is not a purchase history.
 *
 * Four distinct messages, because they mean four different things and the
 * dangerous failure of this whole feature would be showing "no purchase
 * history" for a customer whose lookup simply failed.
 */
function NonReady({
  state,
  isFetching,
  onRetry,
}: {
  state: Exclude<IntelligenceState, "ready" | "loading">;
  isFetching: boolean;
  onRetry: () => void;
}) {
  const message = INTELLIGENCE_MESSAGES[state];
  const alarming = state === "error" || state === "not_configured";

  return (
    <div
      className={cn(
        "rounded-md border p-3",
        alarming ? "border-[#F59E0B]/40 bg-[#F59E0B]/10" : "border-dashed border-border",
      )}
    >
      <p
        className={cn(
          "flex items-center gap-1.5 text-sm font-medium",
          alarming && "text-[#B45309] dark:text-amber-200",
        )}
      >
        {alarming ? <AlertTriangle className="h-4 w-4" /> : null}
        {message.title}
      </p>
      <p className="mt-1 text-xs text-muted-foreground">{message.detail}</p>
      {message.retryable ? (
        <Button
          className="mt-2"
          size="sm"
          variant="outline"
          disabled={isFetching}
          onClick={onRetry}
        >
          {isFetching ? (
            <Loader2 className="mr-1.5 h-4 w-4 animate-spin" />
          ) : (
            <RefreshCw className="mr-1.5 h-4 w-4" />
          )}
          Retry
        </Button>
      ) : null}
    </div>
  );
}

function Ready({
  data,
  telesalesName,
  compact,
}: {
  data: CustomerIntelligence;
  telesalesName: string | null;
  compact: boolean;
}) {
  /*
   * The two names are compared, never merged.
   *
   * Phase 1 already found one number answering to two names, and the MIS is a
   * third opinion. Overwriting the Telesales name with the MIS one would be a
   * silent identity decision on a record an agent is about to use to greet
   * somebody.
   */
  const misName = data.misName?.trim() ?? "";
  const localName = telesalesName?.trim() ?? "";
  const namesDiffer =
    Boolean(misName) && Boolean(localName) && misName.toLowerCase() !== localName.toLowerCase();

  return (
    <>
      <div className="grid grid-cols-2 gap-x-6 gap-y-3 text-sm sm:grid-cols-4">
        <Field label="Shams customer">{misName || "—"}</Field>
        <Field label="Shams customer ID">
          <span className="font-mono text-xs">{data.misCustomerId ?? "—"}</span>
        </Field>
        <Field label="Loyalty points">
          {data.loyaltyPoints == null ? (
            <span className="text-muted-foreground">Unavailable</span>
          ) : (
            <span className="inline-flex items-center gap-1 font-medium">
              <Star className="h-3.5 w-3.5 text-[#B45309] dark:text-amber-300" />
              {data.loyaltyPoints.toLocaleString(DISPLAY_LOCALE)}
            </span>
          )}
        </Field>
        <Field label="Loyalty value">
          {/*
           * Shown only when the MIS supplies it. Deriving a value from points
           * would mean inventing a conversion rate the pharmacy owns.
           */}
          {data.loyaltyValue == null ? (
            <span className="text-muted-foreground">Unavailable</span>
          ) : (
            fmtSAR(data.loyaltyValue, { exact: true })
          )}
        </Field>
      </div>

      {namesDiffer ? (
        <div className="rounded-md border border-dashed border-border p-3">
          <p className="text-xs font-medium">Shams MIS holds a different name</p>
          <p className="mt-0.5 text-xs text-muted-foreground">
            Telesales has <strong>{localName}</strong>; Shams MIS has <strong>{misName}</strong>.
            Both are kept — confirm who you are speaking to before discussing a previous order.
          </p>
        </div>
      ) : null}

      {/* Last purchase — the single most useful line during a call. */}
      <div className="rounded-md border border-border p-3">
        <p className="text-xs font-medium">Last purchase</p>
        {data.lastPurchase ? (
          <p className="mt-1 text-sm">
            {data.lastPurchase.itemName ?? "—"}
            <span className="text-muted-foreground">
              {" · "}
              {day(data.lastPurchase.purchasedOn)}
              {data.lastPurchase.branchCode ? ` · ${data.lastPurchase.branchCode}` : ""}
              {data.lastPurchase.documentNo ? ` · Inv ${data.lastPurchase.documentNo}` : ""}
              {data.lastPurchase.quantity ? ` · ×${data.lastPurchase.quantity}` : ""}
            </span>
          </p>
        ) : (
          <p className="mt-1 text-sm text-muted-foreground">No dated purchase on record.</p>
        )}
      </div>

      {data.products.length > 0 ? (
        <div>
          <p className="text-xs font-medium">Previously purchased</p>
          <div className="mt-1.5 flex flex-wrap gap-1.5">
            {data.products.slice(0, compact ? 6 : 24).map((p) => (
              <span
                key={p.itemCode ?? p.itemName}
                className="rounded-full border border-border bg-secondary px-2 py-0.5 text-[11px] text-secondary-foreground"
                title={
                  p.lastPurchasedOn
                    ? `${p.timesPurchased}× · last ${day(p.lastPurchasedOn)}`
                    : `${p.timesPurchased}×`
                }
              >
                {p.itemName}
                {p.timesPurchased > 1 ? ` ×${p.timesPurchased}` : ""}
              </span>
            ))}
            {compact && data.products.length > 6 ? (
              <span className="px-1 text-[11px] text-muted-foreground">
                +{data.products.length - 6} more
              </span>
            ) : null}
          </div>
        </div>
      ) : null}

      {/* The full table lives on the customer profile only. A lead row's job is
          to get an agent onto a call, not to hold a ledger. */}
      {!compact ? <PurchaseTable data={data} /> : null}
    </>
  );
}

function PurchaseTable({ data }: { data: CustomerIntelligence }) {
  return (
    <div>
      <p className="mb-1.5 text-xs font-medium">
        Purchase history
        <span className="ml-1 font-normal text-muted-foreground">
          ({data.purchases.length} line{data.purchases.length === 1 ? "" : "s"}, newest first)
        </span>
      </p>
      <div className="overflow-x-auto rounded-md border border-border">
        <table className="w-full min-w-[560px] text-sm">
          <thead>
            <tr className="border-b border-border text-left text-xs text-muted-foreground">
              <th className="px-3 py-2 font-medium">Date</th>
              <th className="px-3 py-2 font-medium">Product</th>
              <th className="px-3 py-2 font-medium">Branch</th>
              <th className="px-3 py-2 font-medium">Invoice</th>
              <th className="px-3 py-2 text-right font-medium">Qty</th>
            </tr>
          </thead>
          <tbody>
            {data.purchases.map((p, i) => (
              <tr
                key={`${p.documentNo ?? "?"}-${p.itemCode ?? i}-${i}`}
                className="border-b border-border last:border-0"
              >
                <td className="whitespace-nowrap px-3 py-2">{day(p.purchasedOn)}</td>
                <td className="px-3 py-2">{p.itemName ?? "—"}</td>
                <td className="whitespace-nowrap px-3 py-2 text-muted-foreground">
                  {p.branchCode ?? "—"}
                </td>
                <td className="whitespace-nowrap px-3 py-2 font-mono text-xs text-muted-foreground">
                  {p.documentNo ?? "—"}
                </td>
                <td className="px-3 py-2 text-right tabular-nums">{p.quantity || "—"}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {data.hasMore ? (
        /*
         * `crm/data` reports no total, so "more" is inferred from a full page.
         * Saying so is better than showing a truncated history that looks
         * complete.
         */
        <p className="mt-1.5 text-xs text-muted-foreground">
          This is the most recent {data.purchases.length} lines from the last two years. Older
          purchases exist beyond this page.
        </p>
      ) : null}
    </div>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <p className="text-xs text-muted-foreground">{label}</p>
      <div className="mt-0.5">{children}</div>
    </div>
  );
}
