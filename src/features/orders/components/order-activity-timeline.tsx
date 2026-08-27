import { useMemo, useState } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Bot, ChevronDown, Clock, ExternalLink, Truck } from "lucide-react";
import { cn } from "@/lib/utils";
import { PANEL_CONTEXT } from "@/lib/panel";
import { fmtSAR } from "@/lib/branches";
import { BUSINESS_TIMEZONE } from "@/lib/timezone";
import { actorName, useOrderActivity, type OrderActivityEvent } from "../hooks/use-order-activity";
import {
  buildAlShrouqTimeline,
  type AlShrouqTimelineEvent,
  type AlShrouqTimelineKind,
} from "@/features/alshrouq/dispatch-timeline";
import { useOrderAlShrouqDispatch } from "@/features/alshrouq/use-order-dispatch";
import {
  RESOLUTION_ACTIVITY_ACTION,
  describeResolutionOutcome,
  isResolutionOutcome,
} from "@/lib/shams-crm/alshrouq-resolution";
import { useScheduledDispatchCountdown } from "@/features/alshrouq/use-scheduled-countdown";
import { compactTimelineCount } from "../activity-fold";

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
  /*
   * An operator's conclusion about a stuck dispatch — never AlShrouq's.
   *
   * The wording says "operator" out loud because this is the one entry on the
   * timeline that looks like a courier status and is not one. AlShrouq's own
   * events read "Accepted by AlShrouq"; this reads as a person's decision,
   * because that is what it is.
   */
  if (e.action === RESOLUTION_ACTIVITY_ACTION) return "AlShrouq dispatch resolved by operator";
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
  if (e.action === RESOLUTION_ACTIVITY_ACTION) {
    // The outcome in the operator's vocabulary, then their own account of how
    // they established it. No payload, no courier body, no customer identity —
    // the resolution record holds none of those.
    const outcome = isResolutionOutcome(d.outcome)
      ? describeResolutionOutcome(d.outcome)
      : "Outcome recorded";
    const note = typeof d.note === "string" && d.note.trim() !== "" ? d.note.trim() : null;
    return note ? `${outcome} · ${note}` : outcome;
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

/**
 * One row of the timeline, whichever log it came from.
 *
 * The order's own history lives in `order_activity`; the AlShrouq handoff lives
 * in `alshrouq_dispatches`. Both are backend facts, and an agent reading "what
 * happened to this order" wants them in one column in time order — so they are
 * normalised to this shape and merged, rather than a second timeline being built
 * beside the first.
 */
interface TimelineEntry {
  id: string;
  at: string;
  title: string;
  detail: string | null;
  subtitle: string | null;
  /** Which mark the rail draws, and in what colour. */
  tone: "default" | "automated" | "success" | "warning" | "danger";
  /** Who or what did it. `null` renders no attribution at all. */
  actor: { kind: "person" | "system" | "delivery"; name: string } | null;
  /**
   * For a dispatch entry, which lifecycle step it is.
   *
   * The countdown attaches to the scheduled step by this, not by matching its
   * title: copy gets rewritten, and a renamed heading silently detaching the
   * countdown is exactly the kind of break nothing would catch.
   */
  dispatchKind?: AlShrouqTimelineKind;
  /** Only ever a persisted, absolute tracking URL. Never assembled. */
  trackingUrl?: string | null;
}

const DOT: Record<TimelineEntry["tone"], string> = {
  default: "bg-primary",
  automated: "bg-success",
  success: "bg-success",
  warning: "bg-warning",
  danger: "bg-destructive",
};

/** An `order_activity` row, as the timeline renders it. */
function fromActivity(e: OrderActivityEvent): TimelineEntry {
  const automated = e.details?.automated === true || e.action === "invoice_verified";
  return {
    id: e.id,
    at: e.created_at,
    title: describe(e, (id) => actorName(e.names, id)),
    detail: detailLine(e),
    subtitle: invoiceSubtitle(e),
    tone: automated ? "automated" : "default",
    actor: automated
      ? // Named rather than attributed to whoever happened to have the order
        // open: the portal did this, and history should not read as though an
        // agent typed it.
        { kind: "system", name: String(e.details?.source ?? "MilaPortal") }
      : { kind: "person", name: e.actor_name },
  };
}

/** A dispatch event, derived from the persisted row. */
function fromDispatch(e: AlShrouqTimelineEvent, index: number): TimelineEntry {
  return {
    id: `alshrouq-${e.kind}-${e.at}-${index}`,
    at: e.at,
    title: e.title,
    detail: e.detail,
    subtitle: null,
    tone:
      e.tone === "success"
        ? "success"
        : e.tone === "danger"
          ? "danger"
          : e.tone === "warning"
            ? "warning"
            : "default",
    // The integration, not a person. Who approved it is on the order's own
    // history; repeating a name here would attribute the courier's own
    // acknowledgement to whoever last touched the order.
    actor: { kind: "delivery", name: "AlShrouq" },
    trackingUrl: e.trackingUrl,
    dispatchKind: e.kind,
  };
}

export function OrderActivityTimeline({ orderId }: { orderId: string }) {
  const { data, isLoading } = useOrderActivity(orderId);

  /**
   * The dispatch history, from the shared hook the AlShrouq card also reads.
   * An order that was never dispatched has no rows and contributes no events —
   * the timeline of a Store Pickup order is exactly what it always was.
   */
  const { data: dispatchState } = useOrderAlShrouqDispatch(orderId);
  const current = dispatchState?.current ?? null;

  /**
   * The countdown, owned here because this is where the clock is rendered.
   * Display only: it has no network call and no mutation, and reaching zero
   * changes a label. The dispatch is performed server-side by pg_cron and the
   * worker whether or not this page is open.
   */
  const countdown = useScheduledDispatchCountdown(current?.scheduled_for, current?.dispatch_status);

  const entries = useMemo<TimelineEntry[]>(() => {
    const activity = (data ?? []).map(fromActivity);
    const dispatch = (dispatchState?.rows ?? []).flatMap((row, i) =>
      buildAlShrouqTimeline(row).map((event, j) => fromDispatch(event, i * 100 + j)),
    );
    // Newest first, matching the order the activity query already returns.
    return [...activity, ...dispatch].sort((a, b) => Date.parse(b.at) - Date.parse(a.at));
  }, [data, dispatchState]);

  /**
   * How long is left, appended to the scheduled entry alone.
   *
   * Kept out of `buildAlShrouqTimeline` on purpose: that module is pure and has
   * no clock, so the countdown belongs to the renderer that ticks. Once the row
   * leaves `scheduled` the hook reports `inactive` and nothing is appended — a
   * number ticking down beside an order a worker has already claimed is a lie.
   */
  const countdownLine =
    countdown.state === "waiting"
      ? `Dispatch begins in ${countdown.remainingLabel}`
      : countdown.state === "due"
        ? // The moment has passed but the worker has not reported yet. It has
          // not been sent, and this must not read as though it had.
          "Awaiting dispatch"
        : null;

  /**
   * The fold. Closed by default, and closing again is one click away.
   *
   * Nothing is dropped and nothing is fetched differently — every entry is
   * already in `entries`; this decides how many of them are on screen.
   */
  const [showAll, setShowAll] = useState(false);
  const compact = compactTimelineCount(entries, countdownLine !== null);
  const visible = showAll ? entries : entries.slice(0, compact);
  const hidden = entries.length - compact;

  return (
    <Card className={PANEL_CONTEXT.surface}>
      <CardHeader
        className={cn("flex flex-row items-center justify-between gap-x-3", PANEL_CONTEXT.header)}
      >
        <CardTitle className="flex items-center gap-2 text-sm font-semibold">
          <Clock className="h-4 w-4 text-muted-foreground" /> Activity timeline
        </CardTitle>
        {/* The count lives here rather than beside the fold, so the panel says
            how much history there is whether or not it is folded. */}
        {entries.length > 0 && (
          <span className="shrink-0 text-[11px] tabular-nums text-muted-foreground">
            {entries.length} {entries.length === 1 ? "event" : "events"}
          </span>
        )}
      </CardHeader>
      <CardContent className={PANEL_CONTEXT.body}>
        {isLoading && <div className="text-xs text-muted-foreground">Loading…</div>}
        {!isLoading && entries.length === 0 && (
          <div className="text-xs text-muted-foreground">No activity yet.</div>
        )}
        <ol className="space-y-0">
          {visible.map((e, i, all) => {
            const last = i === all.length - 1;
            const countdownHere =
              countdownLine && e.dispatchKind === "scheduled" ? countdownLine : null;
            return (
              <li key={e.id} className="flex gap-2.5">
                {/* The rail: a dot per event and a hairline joining them, so the
                    column reads as one sequence rather than a stack of cards. */}
                <div className="flex shrink-0 flex-col items-center">
                  <span
                    aria-hidden
                    className={cn(
                      "mt-1.5 h-2 w-2 shrink-0 rounded-full ring-2 ring-background",
                      DOT[e.tone],
                    )}
                  />
                  {!last && <span aria-hidden className="w-px flex-1 bg-border" />}
                </div>
                <div className={cn("min-w-0 flex-1", last ? "pb-0" : "pb-2.5")}>
                  {/* Title, then what it says, then who and when. Three steps,
                      the same three every entry gets, so the column can be read
                      down its left edge rather than parsed row by row. */}
                  <div className="text-[12.5px] font-medium leading-snug">{e.title}</div>
                  {e.detail && (
                    <div
                      className="break-words text-[11px] leading-snug text-muted-foreground"
                      title={e.detail}
                    >
                      {e.detail}
                    </div>
                  )}
                  {countdownHere && (
                    <div className="text-[11px] font-medium leading-snug text-foreground">
                      {countdownHere}
                    </div>
                  )}
                  {e.subtitle && (
                    <div
                      className="truncate text-[11px] leading-snug text-muted-foreground"
                      dir="auto"
                    >
                      {e.subtitle}
                    </div>
                  )}
                  {/* Shown only when the reconciliation persisted a destination.
                      No URL is constructed from a reference, and a missing one
                      renders nothing rather than a dead button. */}
                  {e.trackingUrl && (
                    <a
                      href={e.trackingUrl}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="mt-1 inline-flex items-center gap-1 text-[11px] font-medium text-primary hover:underline"
                    >
                      <ExternalLink className="h-3 w-3" aria-hidden="true" />
                      Open tracking
                    </a>
                  )}
                  <div className="mt-1 flex flex-wrap items-center gap-x-1.5 text-[10.5px] text-muted-foreground">
                    {e.actor && (
                      <span className="inline-flex items-center gap-1 font-medium text-foreground/90">
                        {e.actor.kind === "system" && (
                          <Bot className="h-3 w-3" aria-hidden="true" />
                        )}
                        {e.actor.kind === "delivery" && (
                          <Truck className="h-3 w-3" aria-hidden="true" />
                        )}
                        {e.actor.name}
                      </span>
                    )}
                    <span>· {fmtBusinessTime(e.at)}</span>
                  </div>
                </div>
              </li>
            );
          })}
        </ol>

        {/* Everything is still here — this only decides how much of it is on
            screen. `aria-expanded` on a real button, so a screen reader is told
            the same thing the chevron says. */}
        {hidden > 0 && (
          <button
            type="button"
            onClick={() => setShowAll((v) => !v)}
            aria-expanded={showAll}
            /* Foreground, not `text-primary`. The brand turquoise measures
               2.35:1 on a card in light mode, which is thin for a 12px label
               and thinner still for the panel's only affordance — and this
               control does not need colour to read as one: it is full width,
               under a rule, centred, and carries a chevron. Primary arrives on
               hover, where it confirms rather than announces. */
            className={cn(
              "mt-1 flex w-full items-center justify-center gap-1 border-t pt-2.5 text-xs font-medium text-foreground transition-colors hover:text-primary",
              PANEL_CONTEXT.divider,
            )}
          >
            {showAll ? "Show recent activity" : "View full activity"}
            {!showAll && <span className="tabular-nums text-muted-foreground">+{hidden}</span>}
            <ChevronDown
              aria-hidden="true"
              className={cn("h-3.5 w-3.5 transition-transform", showAll && "rotate-180")}
            />
          </button>
        )}
      </CardContent>
    </Card>
  );
}
