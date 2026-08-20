import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Bot, Clock } from "lucide-react";
import { cn } from "@/lib/utils";
import { fmtSAR } from "@/lib/branches";
import { BUSINESS_TIMEZONE } from "@/lib/timezone";
import { actorName, useOrderActivity, type OrderActivityEvent } from "../hooks/use-order-activity";

/**
 * Describe one logged change.
 *
 * Three of these entries are machine-written and they are deliberately the most
 * specific in the log. An agent reading history needs the invoice number, the
 * figure it replaced and the fact that nobody typed it — "the order was edited"
 * answers none of that, which is why `record_invoice_verification` writes
 * `value_synced` and `call_center_flagged` itself instead of leaving the two
 * fields to the generic edit trigger.
 */
function describe(e: OrderActivityEvent, nameOf: (id: unknown) => string): string {
  const d = e.details ?? {};
  if (e.action === "created") return "Order created";
  // Reassignment names both sides; a first assignment has no "from" to name.
  // The trigger only writes this row when `agent_id` actually changed, so a
  // page render or a repeated load can never produce one.
  if (e.action === "assigned") {
    return d.from
      ? `Order reassigned — ${nameOf(d.from)} → ${nameOf(d.to)}`
      : `Order assigned to ${nameOf(d.to)}`;
  }
  if (e.action === "status_changed")
    return `Changed status from ${d.from ?? "—"} to ${d.to ?? "—"}`;
  if (e.action === "verification_changed")
    return d.verified
      ? "Marked Call Center invoice verified"
      : "Removed Call Center invoice verification";
  if (e.action === "invoice_verified") return "Automated invoice verification by MilaPortal";
  // Named after the invoice, not the order: this is one document's total being
  // corrected by the MIS, and the order-level consequence gets its own event.
  if (e.action === "invoice_value_changed")
    return `Invoice #${d.invoice_no ?? d.invoice_key ?? "—"} value updated automatically`;
  // The same shape for the other thing the MIS can restate about a document.
  // Separate from the value event because the money did not move.
  if (e.action === "invoice_channel_changed")
    return `Invoice #${d.invoice_no ?? d.invoice_key ?? "—"} channel corrected automatically`;
  if (e.action === "value_synced") return "Order value updated automatically by MilaPortal";
  if (e.action === "call_center_flagged") return "Call Center Invoice marked automatically";
  // The withdrawal, which had no event until the flag could be cleared at all.
  if (e.action === "call_center_cleared") return "Call Center Invoice cleared automatically";
  if (e.action === "auto_completed") return "Order automatically completed by MilaPortal";
  // The courier events. Named after AlShrouq rather than "delivery updated",
  // because the Portal is reporting what another system did with the order and
  // an agent chasing a late delivery needs to know which one to call.
  if (e.action === "alshrouq_submission_started") return "Submitting the order to AlShrouq";
  if (e.action === "alshrouq_dispatched") return "Sent to AlShrouq for delivery";
  if (e.action === "alshrouq_failed") return "AlShrouq did not accept the order";
  // Not a second delivery: a submission whose result was unknown turned out to
  // have already reached the courier, and the portal adopted it.
  if (e.action === "alshrouq_recovered") return "Recovered an AlShrouq delivery already created";
  if (e.action === "alshrouq_status_changed") return "AlShrouq delivery status changed";
  if (e.action === "alshrouq_cancelled") return "AlShrouq delivery cancelled";
  if (e.action === "edited") {
    const keys = Object.keys(d);
    if (keys.length === 0) return "Edited the order";
    return `Updated ${keys.join(", ")}`;
  }
  return e.action;
}

/**
 * The line under the headline: what the event actually says.
 *
 * Only for the entries that carry facts worth repeating — the invoice number,
 * the figure and the one it replaced. Everything else says enough in its title.
 */
function detailLine(e: OrderActivityEvent): string | null {
  const d = e.details ?? {};
  if (e.action === "invoice_verified") {
    const parts = [`Invoice #${d.invoice_no ?? d.invoice_key ?? "—"} verified successfully`];
    if (d.total !== undefined && d.total !== null) parts.push(fmtSAR(Number(d.total)));
    if (d.branch_code) parts.push(`Branch ${d.branch_code}`);
    // The channel this document was classified as, stated on the event that
    // classified it. Without it the timeline can look as though a Call Centre
    // conclusion came from nowhere — or worse, from the wrong invoice.
    if (d.is_call_centre !== undefined && d.is_call_centre !== null) {
      parts.push(`Channel: ${d.is_call_centre ? "Call Centre" : "Non Call Centre"}`);
    }
    return parts.join(" · ");
  }
  if (e.action === "invoice_value_changed") {
    const from = d.from !== undefined && d.from !== null ? fmtSAR(Number(d.from)) : "—";
    const to = d.to !== undefined && d.to !== null ? fmtSAR(Number(d.to)) : "—";
    return `${from} → ${to}`;
  }
  if (e.action === "invoice_channel_changed") {
    // Spelled out rather than shown as true → false: the channel is what the
    // Call Centre flag is decided from, and this is the row that explains a
    // flag changing without anybody touching the order.
    const channel = (v: unknown) =>
      v === undefined || v === null ? "—" : v ? "Call Centre" : "Non Call Centre";
    return `${channel(d.from)} → ${channel(d.to)}`;
  }
  if (e.action === "value_synced") {
    const from = d.from !== undefined && d.from !== null ? fmtSAR(Number(d.from)) : "—";
    const to = d.to !== undefined && d.to !== null ? fmtSAR(Number(d.to)) : "—";
    // The invoices the new figure is built from — all of them, since the total
    // is rebuilt from the order's current set rather than accumulated.
    const based = d.invoice_no
      ? ` · Based on verified invoice${d.invoice_count > 1 ? "s" : ""} #${String(d.invoice_no).split(", ").join(", #")}`
      : "";
    return `${from} → ${to}${based}`;
  }
  if (e.action === "call_center_flagged") {
    // Names the document that actually carried the Call Centre channel — never
    // "an invoice was verified", which is what let a Non Call Centre invoice
    // appear to be the cause.
    return d.invoice_no
      ? `Invoice #${String(d.invoice_no).split(", ").join(", #")} verified as Call Centre`
      : "A verified Call Centre invoice was found";
  }
  if (e.action === "call_center_cleared") {
    return d.invoice_no
      ? `No verified invoice on this order is a Call Centre document (#${String(d.invoice_no).split(", ").join(", #")})`
      : "No verified invoice on this order is a Call Centre document";
  }
  if (e.action === "auto_completed") {
    // Says why, not just what: the invoices are the evidence, and the
    // call-centre one is named separately because it is the condition that
    // qualified the order rather than merely one of its documents.
    const parts = [`${d.from ?? "—"} → ${d.to ?? "Completed"}`];
    if (d.total !== undefined && d.total !== null)
      parts.push(`verified total ${fmtSAR(Number(d.total))}`);
    if (d.call_centre_invoice) parts.push(`Call Centre invoice ${String(d.call_centre_invoice)}`);
    return parts.join(" · ");
  }
  if (e.action === "alshrouq_submission_started") {
    return `Order no. ${d.client_order_id ?? "—"}`;
  }
  if (e.action === "alshrouq_dispatched" || e.action === "alshrouq_recovered") {
    // The reference is the whole point of this line: it is what somebody quotes
    // on the phone when a delivery has to be chased. AlShrouq's own number
    // first, because the CRM's internal id means nothing to the courier.
    const parts = [`AlShrouq no. ${d.external_order_id ?? d.local_id ?? "pending"}`];
    if (d.value !== undefined && d.value !== null) parts.push(fmtSAR(Number(d.value)));
    if (d.status) parts.push(`Status: ${String(d.status)}`);
    return parts.join(" · ");
  }
  if (e.action === "alshrouq_failed") {
    // The reason as the CRM worded it. Never a payload, never a header.
    return d.reason ? String(d.reason) : "No reason reported";
  }
  if (e.action === "alshrouq_status_changed") {
    // AlShrouq's own words on both sides, unmapped — see the dispatch panel.
    return `${d.from ?? "—"} → ${d.to ?? "—"}${d.detail ? ` · ${String(d.detail)}` : ""}`;
  }
  if (e.action === "alshrouq_cancelled") {
    return `AlShrouq no. ${d.external_order_id ?? d.local_id ?? "—"}${d.status ? ` · ${String(d.status)}` : ""}`;
  }
  if (e.action === "assigned" && d.to_team) return `Team: ${String(d.to_team).replace("_", " ")}`;
  return null;
}

/** The customer the MIS recorded against a verified invoice, when it has one. */
function invoiceSubtitle(e: OrderActivityEvent): string | null {
  if (e.action !== "invoice_verified") return null;
  const customer = e.details?.customer;
  return typeof customer === "string" && customer.trim() !== "" ? customer : null;
}

/**
 * `Today 12:31 PM` for anything from the business day in progress, the date
 * otherwise. The order lifecycle is mostly a single shift, and a column of
 * identical dates hides the one entry that is a week old.
 */
const fmtBusinessTime = (iso: string) => {
  try {
    const time = new Intl.DateTimeFormat("en-US", {
      timeZone: BUSINESS_TIMEZONE,
      hour: "numeric",
      minute: "2-digit",
      hour12: true,
    }).format(new Date(iso));
    const day = (value: Date) =>
      new Intl.DateTimeFormat("en-CA", { timeZone: BUSINESS_TIMEZONE }).format(value);
    if (day(new Date(iso)) === day(new Date())) return `Today ${time}`;
    const date = new Intl.DateTimeFormat("en-US", {
      timeZone: BUSINESS_TIMEZONE,
      year: "numeric",
      month: "short",
      day: "2-digit",
    }).format(new Date(iso));
    return `${date} ${time}`;
  } catch {
    return iso;
  }
};

export function OrderActivityTimeline({ orderId }: { orderId: string }) {
  const { data, isLoading } = useOrderActivity(orderId);

  return (
    <Card className="overflow-hidden shadow-sm">
      <CardHeader className="border-b border-border/60 bg-muted/25 px-4 py-3 dark:bg-muted/10">
        <CardTitle className="flex items-center gap-2 text-sm font-semibold">
          <Clock className="h-4 w-4 text-muted-foreground" /> Activity timeline
        </CardTitle>
      </CardHeader>
      <CardContent className="p-4">
        {isLoading && <div className="text-xs text-muted-foreground">Loading…</div>}
        {!isLoading && (data?.length ?? 0) === 0 && (
          <div className="text-xs text-muted-foreground">No activity yet.</div>
        )}
        <ol className="space-y-0">
          {(data ?? []).map((e, i, all) => {
            const automated = e.details?.automated === true || e.action === "invoice_verified";
            const subtitle = invoiceSubtitle(e);
            const detail = detailLine(e);
            const last = i === all.length - 1;
            return (
              <li key={e.id} className="flex gap-2.5">
                {/* The rail: a dot per event and a hairline joining them, so the
                    column reads as one sequence rather than a stack of cards. */}
                <div className="flex shrink-0 flex-col items-center">
                  <span
                    aria-hidden
                    className={cn(
                      "mt-1.5 h-2 w-2 shrink-0 rounded-full ring-2 ring-background",
                      automated ? "bg-success" : "bg-primary",
                    )}
                  />
                  {!last && <span aria-hidden className="w-px flex-1 bg-border" />}
                </div>
                <div className={cn("min-w-0 flex-1", last ? "pb-0" : "pb-3")}>
                  <div className="text-[13px] font-medium leading-snug">
                    {describe(e, (id) => actorName(e.names, id))}
                  </div>
                  {detail && (
                    <div className="text-[11px] leading-snug text-muted-foreground">{detail}</div>
                  )}
                  {subtitle && (
                    <div
                      className="truncate text-[11px] leading-snug text-muted-foreground"
                      dir="auto"
                    >
                      {subtitle}
                    </div>
                  )}
                  <div className="mt-0.5 flex flex-wrap items-center gap-x-1.5 text-[11px] text-muted-foreground">
                    {automated ? (
                      // Named rather than attributed to whoever happened to have
                      // the order open: the portal did this, and history should
                      // not read as though an agent typed it.
                      <span className="inline-flex items-center gap-1 font-medium text-foreground">
                        <Bot className="h-3 w-3" aria-hidden="true" />
                        {e.details?.source ?? "MilaPortal"}
                      </span>
                    ) : (
                      <span className="font-medium text-foreground">{e.actor_name}</span>
                    )}
                    <span>· {fmtBusinessTime(e.created_at)}</span>
                  </div>
                </div>
              </li>
            );
          })}
        </ol>
      </CardContent>
    </Card>
  );
}
