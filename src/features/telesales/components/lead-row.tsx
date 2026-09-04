import { Link } from "@tanstack/react-router";
import { Phone, PhoneOff, UserPlus } from "lucide-react";
import { Checkbox } from "@/components/ui/checkbox";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { fmtSAR } from "@/lib/branches";
import {
  daysBetween,
  describeDue,
  formatBusinessDate,
  type BusinessDate,
} from "@/lib/telesales/dates";
import { leadLifecycle } from "@/lib/telesales/lifecycle";
import { familyLabel } from "@/lib/telesales/products";
import { LEAD_STATUS_LABELS, LEAD_TYPE_LABELS } from "@/lib/telesales/types";
import {
  DUE_TONE_STYLES,
  LEAD_STATUS_STYLES,
  LEAD_TYPE_STYLES,
  STALE_BADGE_STYLE,
  formatPhone,
  relativeDays,
  telHref,
} from "@/features/telesales/constants";
import { OutcomeBadge } from "@/features/telesales/components/outcome-badge";
import { RefillBadge } from "@/features/telesales/components/refill-badge";
import type { QueueLead } from "@/features/telesales/types";

/**
 * One row of the agent queue.
 *
 * The row carries three actions and no menu: **call**, **claim** and **record**.
 * A dropdown would cost a click on every single lead to reach a list of three
 * things, and the whole point of the queue is that an agent can work down it
 * without navigating.
 *
 * The identity shown adapts to the pipeline, because the pipelines identify
 * people differently. A Cash lead has a name and an invoice; a Wasfaty lead
 * frequently has neither and is worked by Patient ID and Prescription No — those
 * are what the agent types into the Wasfaty portal, so those are what the row
 * shows.
 */

export interface LeadRowProps {
  lead: QueueLead;
  today: BusinessDate;
  /** Display name of the assignee, resolved by the page from one roster fetch
   *  rather than one lookup per row. */
  assigneeName: string | null;
  /** Display name of whoever last *called*, from the same roster fetch. */
  lastContactName: string | null;
  /** Who archived it, from that same roster fetch. Only meaningful on an
   *  archived row. */
  archivedByLabel?: string | null;
  isMine: boolean;
  canWork: boolean;
  /** Selection, for the bulk bar. Only rendered when the viewer can manage. */
  selectable: boolean;
  selected: boolean;
  onSelect: (leadId: string, selected: boolean) => void;
  onClaim: (lead: QueueLead) => void;
  onRecord: (lead: QueueLead) => void;
  claiming: boolean;
  /**
   * The queue's current filters, as one opaque string, so the lead can offer a
   * Back that returns here rather than to the default queue.
   *
   * Opaque on purpose: the row does not read it and the lead page does not
   * either — it is produced by `encodeQueueContext` and consumed by
   * `decodeQueueContext`, so adding a filter tomorrow changes neither file.
   */
  queueContext?: string;
}

export function LeadRow({
  lead,
  today,
  assigneeName,
  lastContactName,
  archivedByLabel,
  isMine,
  canWork,
  selectable,
  selected,
  onSelect,
  onClaim,
  onRecord,
  claiming,
  queueContext,
}: LeadRowProps) {
  const due = describeDue(lead.next_followup_on, today);
  /*
   * Retention leads get the agent-facing refill wording; Cash and Wasfaty keep
   * the neutral "in N days", because for them the date is a callback the agent
   * chose rather than a dose the customer is running out of.
   */
  const showRefill = lead.lead_type === "retention";

  /*
   * The refill lifecycle.
   *
   * The state comes from the view -- the same column the queue filtered on, so
   * a row can never contradict the filter that selected it. The wording comes
   * from `leadLifecycle`, which is also what the recommendation engine uses, so
   * the sentence here and the exclusion there are the same rule spoken twice.
   */
  const isStale = lead.lifecycle === "stale";
  const lifecycle = isStale
    ? leadLifecycle({
        dueOn: lead.refill_due_on,
        cycleDays: lead.refill_cycle_days,
        today,
      })
    : null;
  const daysSinceDue =
    isStale && lead.refill_due_on ? daysBetween(lead.refill_due_on, today) : null;
  const archivedOn = lead.archived_at ? relativeDays(lead.archived_at, today) : null;
  const archivedByName = lead.archived_by ? (archivedByLabel ?? null) : null;

  const lastContact = relativeDays(lead.last_contacted_at, today);
  const tel = telHref(lead.phone);

  const identity =
    lead.lead_type === "wasfaty"
      ? [lead.patient_id, lead.prescription_no].filter(Boolean).join(" · ")
      : [lead.document_no ? `Inv ${lead.document_no}` : null, lead.branch_no]
          .filter(Boolean)
          .join(" · ");

  return (
    <div className="grid grid-cols-1 gap-3 border-b border-border px-3 py-3 transition-colors last:border-0 hover:bg-muted/40 sm:grid-cols-12 sm:items-center">
      {/* Selection. Rendered only for a viewer who can act on a selection --
          a checkbox that leads nowhere is worse than no checkbox. */}
      {selectable ? (
        <div className="flex items-start sm:col-span-1 sm:items-center">
          <Checkbox
            checked={selected}
            onCheckedChange={(v) => onSelect(lead.id, v === true)}
            aria-label={`Select ${lead.customer_name ?? "lead"}`}
          />
        </div>
      ) : null}

      {/* Who */}
      {/* The checkbox takes a column, so "who" gives one back to keep the row
          at twelve. */}
      <div className={cn("min-w-0", selectable ? "sm:col-span-2" : "sm:col-span-3")}>
        <div className="flex items-center gap-2">
          <Link
            to="/telesales/$id"
            params={{ id: lead.id }}
            search={queueContext ? { from: queueContext } : {}}
            className="truncate font-medium hover:underline"
          >
            {lead.customer_name || (lead.lead_type === "wasfaty" ? "Wasfaty patient" : "No name")}
          </Link>
          {lead.cycle_number > 1 ? (
            <span className="shrink-0 rounded border border-border px-1 text-[10px] text-muted-foreground">
              cycle {lead.cycle_number}
            </span>
          ) : null}
        </div>
        <p className="truncate text-xs text-muted-foreground">{identity || "—"}</p>
      </div>

      {/* What */}
      <div className="min-w-0 sm:col-span-3">
        <div className="flex items-baseline gap-2">
          <p className="min-w-0 flex-1 truncate text-sm">
            {lead.item_name ?? (lead.lead_type === "wasfaty" ? "Prescription" : "—")}
          </p>
          {/*
           * The value, on the row rather than inside the lead.
           *
           * It was the last fragment of a dot-joined secondary line, in muted
           * grey at 12px, behind the family and the city — which meant deciding
           * which of forty Wasfaty prescriptions to call first required opening
           * forty of them. It is a number an agent prioritises by, so it is
           * rendered as one: tabular figures, foreground ink, right of the
           * product where the eye already stops.
           */}
          {lead.total_value != null ? (
            <span className="shrink-0 text-sm font-medium tabular-nums">
              {fmtSAR(lead.total_value)}
            </span>
          ) : null}
        </div>
        <p className="truncate text-xs text-muted-foreground">
          {[familyLabel(lead.product_family), lead.city, formatBusinessDate(lead.source_date)]
            .filter((v) => v && v !== "—")
            .join(" · ") || "—"}
        </p>
      </div>

      {/* State */}
      <div className="flex flex-wrap items-center gap-1.5 sm:col-span-2">
        <span
          className={cn(
            "rounded-full border px-2 py-0.5 text-[11px] font-medium",
            LEAD_STATUS_STYLES[lead.status],
          )}
        >
          {LEAD_STATUS_LABELS[lead.status]}
        </span>
        <span
          className={cn(
            "rounded-full border px-2 py-0.5 text-[11px]",
            LEAD_TYPE_STYLES[lead.lead_type],
          )}
        >
          {LEAD_TYPE_LABELS[lead.lead_type]}
        </span>
        {/*
         * What was actually recorded, which the status alone does not say.
         *
         * Three of the eight Wasfaty actions land on `follow_up` and two on
         * `closed_lost`, so a queue showing only the status collapses "out of
         * stock" and "refill too soon" into one indistinguishable badge — and
         * the Worked Leads view exists precisely to tell them apart.
         */}
        <OutcomeBadge outcome={lead.last_outcome} />
      </div>

      {/* When / who owns it */}
      <div className="min-w-0 sm:col-span-2">
        {lead.archived_at ? (
          /*
           * An archived lead is not work, so it shows neither a countdown nor a
           * lifecycle badge -- just what happened to it and when. Who archived
           * it is resolved from the roster the page already fetched.
           */
          <>
            <span
              className={cn(
                "inline-block rounded border px-1.5 py-0.5 text-[10px] tracking-wide",
                STALE_BADGE_STYLE,
              )}
              title={lead.archive_reason ?? undefined}
            >
              ARCHIVED
            </span>
            <p className="truncate text-[11px] text-muted-foreground/80">
              {archivedOn ? `Archived ${archivedOn}` : "Archived"}
              {archivedByName ? ` · ${archivedByName}` : ""}
            </p>
          </>
        ) : isStale ? (
          /*
           * A stale lead never shows a refill countdown. Telling an agent
           * "REFILL OVERDUE - 214 DAYS" invites them to open a call with
           * something that stopped being true months ago; the badge says what
           * this actually is, and the line underneath says why.
           */
          <>
            <span
              className={cn(
                "inline-block rounded border px-1.5 py-0.5 text-[10px] tracking-wide",
                STALE_BADGE_STYLE,
              )}
              title={lifecycle?.reason ?? undefined}
            >
              STALE
            </span>
            <p className="truncate text-[11px] text-muted-foreground/80">
              No longer a current refill
              {lead.refill_due_on ? ` · due ${formatBusinessDate(lead.refill_due_on)}` : ""}
              {/* How long ago it lapsed: the figure a supervisor sorts a
                  backlog by, and the one that makes "archive these" an easy
                  call. Counted from the due date, not from the boundary. */}
              {daysSinceDue != null ? ` · ${daysSinceDue}d ago` : ""}
            </p>
          </>
        ) : showRefill ? (
          <RefillBadge dueOn={lead.next_followup_on} today={today} />
        ) : (
          <p className={cn("text-xs", DUE_TONE_STYLES[due.tone])}>{due.label}</p>
        )}
        <p className="truncate text-xs text-muted-foreground">
          {lead.assigned_to ? (isMine ? "You" : (assigneeName ?? "Assigned")) : "Unassigned"}
          {lead.contact_attempts > 0
            ? ` · ${lead.contact_attempts} attempt${lead.contact_attempts === 1 ? "" : "s"}`
            : ""}
        </p>
        {/*
         * Who last actually dialled, which is not who owns the lead.
         * Shown only when somebody has -- an empty line here on 700 untouched
         * leads would be noise, and the absence already reads as "nobody yet".
         */}
        {lastContact ? (
          <p className="truncate text-[11px] text-muted-foreground">
            Last call: {lastContactName ?? "an agent"} · {lastContact}
          </p>
        ) : null}
      </div>

      {/* Actions */}
      <div className="flex items-center justify-end gap-1 sm:col-span-2">
        {tel ? (
          <Button asChild size="sm" variant="ghost" title={formatPhone(lead.phone)}>
            <a href={tel}>
              <Phone className="h-4 w-4" />
              <span className="sr-only">Call {formatPhone(lead.phone)}</span>
            </a>
          </Button>
        ) : (
          /*
           * No number is a state, not an absence.
           *
           * For a Wasfaty lead it is the normal state — the number is looked up
           * in the portal — so the row says so rather than leaving a gap the
           * agent has to interpret.
           */
          <Button
            size="sm"
            variant="ghost"
            className="text-muted-foreground"
            title="No phone number on this lead"
            disabled
          >
            <PhoneOff className="h-4 w-4" />
            <span className="sr-only">No phone number</span>
          </Button>
        )}

        {canWork && !lead.assigned_to ? (
          <Button
            size="sm"
            variant="outline"
            disabled={claiming}
            onClick={() => onClaim(lead)}
            title="Claim this lead"
          >
            <UserPlus className="h-4 w-4" />
            <span className="sr-only">Claim</span>
          </Button>
        ) : null}

        {canWork ? (
          <Button size="sm" onClick={() => onRecord(lead)}>
            Record
          </Button>
        ) : null}
      </div>
    </div>
  );
}
