import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Bot, Clock } from "lucide-react";
import { cn } from "@/lib/utils";
import { fmtSAR } from "@/lib/branches";
import { BUSINESS_TIMEZONE } from "@/lib/timezone";
import { actorName, useOrderActivity, type OrderActivityEvent } from "../hooks/use-order-activity";

/**
 * Describe one logged change.
 *
 * `invoice_verified` is the only machine-written entry, and it is deliberately
 * the most specific: an agent reading history needs the number, the branch and
 * the total to reconcile against, not "the order was edited". The surrounding
 * `edited` and `verification_changed` rows the orders trigger raises on the back
 * of it are left as they are — they are a true record of what changed, and
 * together the three read as the sequence the prompt describes.
 */
function describe(e: OrderActivityEvent, nameOf: (id: unknown) => string): string {
  const d = e.details ?? {};
  if (e.action === "created") return "Created the order";
  // Reassignment names both sides; a first assignment has no "from" to name.
  // The trigger only writes this row when `agent_id` actually changed, so a
  // page render or a repeated load can never produce one.
  if (e.action === "assigned") {
    return d.from
      ? `Reassigned from ${nameOf(d.from)} to ${nameOf(d.to)}`
      : `Assigned to ${nameOf(d.to)}`;
  }
  if (e.action === "status_changed")
    return `Changed status from ${d.from ?? "—"} to ${d.to ?? "—"}`;
  if (e.action === "verification_changed")
    return d.verified
      ? "Marked Call Center invoice verified"
      : "Removed Call Center invoice verification";
  if (e.action === "invoice_verified") {
    const parts = [`Invoice #${d.invoice_no ?? d.invoice_key ?? "—"}`];
    if (d.branch_code) parts.push(`Branch ${d.branch_code}`);
    if (d.total !== undefined && d.total !== null) parts.push(`Total ${fmtSAR(Number(d.total))}`);
    return `Invoice verified — ${parts.join(" · ")}`;
  }
  if (e.action === "edited") {
    const keys = Object.keys(d);
    if (keys.length === 0) return "Edited the order";
    return `Updated ${keys.join(", ")}`;
  }
  return e.action;
}

/** The customer the MIS recorded against a verified invoice, when it has one. */
function invoiceSubtitle(e: OrderActivityEvent): string | null {
  if (e.action !== "invoice_verified") return null;
  const customer = e.details?.customer;
  return typeof customer === "string" && customer.trim() !== "" ? customer : null;
}

const fmtBusinessTime = (iso: string) => {
  try {
    return new Intl.DateTimeFormat("en-US", {
      timeZone: BUSINESS_TIMEZONE,
      year: "numeric",
      month: "short",
      day: "2-digit",
      hour: "numeric",
      minute: "2-digit",
      hour12: true,
    }).format(new Date(iso));
  } catch {
    return iso;
  }
};

export function OrderActivityTimeline({ orderId }: { orderId: string }) {
  const { data, isLoading } = useOrderActivity(orderId);

  return (
    <Card>
      <CardHeader className="pb-3">
        <CardTitle className="flex items-center gap-2 text-sm font-semibold">
          <Clock className="h-4 w-4 text-muted-foreground" /> Activity timeline
        </CardTitle>
      </CardHeader>
      <CardContent>
        {isLoading && <div className="text-sm text-muted-foreground">Loading…</div>}
        {!isLoading && (data?.length ?? 0) === 0 && (
          <div className="text-sm text-muted-foreground">No activity yet.</div>
        )}
        <ol className="space-y-3">
          {(data ?? []).map((e) => {
            const automated = e.action === "invoice_verified" || e.details?.automated === true;
            const subtitle = invoiceSubtitle(e);
            return (
              <li key={e.id} className="flex gap-3 text-sm">
                <div
                  className={cn(
                    "mt-1.5 h-2 w-2 shrink-0 rounded-full",
                    automated ? "bg-success" : "bg-primary",
                  )}
                />
                <div className="min-w-0 flex-1">
                  <div className="font-medium">{describe(e, (id) => actorName(e.names, id))}</div>
                  {subtitle && (
                    <div className="truncate text-xs text-muted-foreground" dir="auto">
                      Customer: {subtitle}
                    </div>
                  )}
                  <div className="flex flex-wrap items-center gap-x-1.5 text-xs text-muted-foreground">
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
