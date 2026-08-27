import { useQuery } from "@tanstack/react-query";
import { Bike, Clock, Copy, ExternalLink, Info, MapPin, Navigation, Phone } from "lucide-react";
import { supabase } from "@/integrations/supabase/client";
import { queryKeys } from "@/lib/query-keys";
import { PANEL_CONTEXT, PANEL_FIELD } from "@/lib/panel";
import { cn } from "@/lib/utils";
import { copyText } from "../clipboard";
import { REFERENCE_LABEL, dutyHoursLabel } from "../normalize";
import { decorate } from "../search";
import type { Branch, BranchView } from "../types";
import { contactBlock } from "./branch-card";

/**
 * Everything about a branch, inline, wherever a branch has just been chosen.
 *
 * Built for one moment: an agent is on the phone, has picked a branch on the
 * order form, and the customer immediately asks something the form does not
 * show — is it open, does it deliver, what is the address, who do I call. Every
 * one of those answers used to be a navigation away from a half-typed order.
 *
 * Deliberately a *reusable* component rather than part of the order form: the
 * complaint form, the future Smart Branch Finder and the AI assistant all need
 * the same panel, and the Branch Directory is the single source of this data.
 *
 * The panel is also what tells the agent the code they just picked is *not* a
 * pharmacy. The picker lists every row in the directory, head office and the
 * warehouses included, and raising a customer order against a warehouse is a
 * mistake nothing else on this form would catch.
 */

/** Columns the panel renders. Explicitly listed to avoid pulling the geography blob. */
const PREVIEW_COLUMNS =
  "branch_no,city,phone,area_manager,area_manager_phone,email,address,maps_url,latitude,longitude,scooter,scooter_note,working_hours,friday_hours,duty_hours,active,created_at,updated_at";

/**
 * A compact secondary action: Copy all, Open map, Copy map link, Navigate.
 *
 * Four outlined pills in a panel this small was four more rectangles on a page
 * whose whole Phase 1 brief was to have fewer of them — and an outline is the
 * design system's way of saying "this is one of the two or three things to do
 * here", which is not what any of these are. A resting muted fill gives the
 * same affordance at a fraction of the weight, and keeps them plainly
 * subordinate to the panels above.
 */
const PANEL_ACTION =
  "inline-flex items-center gap-1 rounded-md bg-muted/60 px-2 py-1 text-[11px] font-medium text-muted-foreground transition-colors hover:bg-accent hover:text-accent-foreground dark:bg-muted/40";

/**
 * One fact, with its own copy control.
 *
 * A two-column grid rather than the stacked label-over-value rows this replaces:
 * stacking cost two lines per fact and put eight facts over sixteen lines in the
 * middle of a form somebody is filling in. Same information, half the height.
 */
function Row({
  icon: Icon,
  label,
  value,
  href,
  copyValue,
  mono,
}: {
  icon: typeof MapPin;
  label: string;
  value: string | null;
  href?: string | null;
  copyValue?: string | null;
  mono?: boolean;
}) {
  if (!value) return null;
  return (
    <div className="flex items-start gap-2 py-1.5">
      <Icon className="mt-px h-3.5 w-3.5 shrink-0 text-muted-foreground/70" aria-hidden />
      <span className={cn("w-16 shrink-0 pt-px", PANEL_FIELD.label)}>{label}</span>
      <div className={cn("min-w-0 flex-1 text-xs leading-[16px]", mono && "font-mono")}>
        {href ? (
          <a
            href={href}
            target={href.startsWith("tel:") ? undefined : "_blank"}
            rel="noopener noreferrer"
            className="break-words text-primary-ink hover:underline"
            dir={mono ? "ltr" : "auto"}
          >
            {value}
          </a>
        ) : (
          <span className="block break-words text-foreground/90" dir={mono ? "ltr" : "auto"}>
            {value}
          </span>
        )}
      </div>
      {copyValue && (
        <button
          type="button"
          onClick={() => copyText(copyValue, label)}
          aria-label={`Copy ${label.toLowerCase()}`}
          title={`Copy ${label.toLowerCase()}`}
          className="mt-px shrink-0 rounded p-0.5 text-muted-foreground/60 transition-colors hover:bg-accent hover:text-accent-foreground"
        >
          <Copy className="h-3 w-3" />
        </button>
      )}
    </div>
  );
}

export function BranchPreviewPanel({
  branchNo,
  className,
}: {
  branchNo: string | null | undefined;
  className?: string;
}) {
  const code = branchNo?.trim() || null;

  const { data, isLoading } = useQuery({
    queryKey: queryKeys.branches.preview(code),
    queryFn: async (): Promise<BranchView | null> => {
      if (!code) return null;
      const { data: row, error } = await supabase
        .from("branches")
        .select(PREVIEW_COLUMNS)
        .eq("branch_no", code)
        .maybeSingle();
      if (error) throw new Error(error.message);
      if (!row) return null;
      // Reuses the directory's own decoration, so the phone formatting and map
      // links here are identical to the ones on the branch card by construction.
      return decorate([row as unknown as Branch])[0] ?? null;
    },
    enabled: Boolean(code),
    // Branch details change only on import or a card edit, and both invalidate
    // the `branches` root. Holding them for the length of a call means switching
    // between branches on the form is instant.
    staleTime: 5 * 60 * 1000,
  });

  if (!code) return null;

  if (isLoading) {
    return (
      <div
        className={cn(
          "animate-pulse space-y-2 rounded-xl border bg-card",
          PANEL_CONTEXT.surface,
          PANEL_CONTEXT.body,
          className,
        )}
      >
        <div className="h-4 w-24 rounded bg-muted" />
        <div className="h-3 w-full rounded bg-muted/70" />
        <div className="h-3 w-3/4 rounded bg-muted/70" />
      </div>
    );
  }

  if (!data) {
    return (
      <div
        className={cn(
          "rounded-xl border border-dashed border-border/70 bg-muted/30 text-xs text-muted-foreground",
          PANEL_CONTEXT.body,
          className,
        )}
      >
        No directory entry for <span className="font-mono">{code}</span>. The order can still be
        saved — the branch may simply not be in the directory yet.
      </div>
    );
  }

  const referenceLabel = data.reference ? REFERENCE_LABEL[data.reference] : null;
  const dutyLabel = data.duty_hours != null ? dutyHoursLabel(data.duty_hours) : null;

  return (
    <div
      className={cn(
        "rounded-xl border bg-card",
        PANEL_CONTEXT.surface,
        referenceLabel ? "border-[var(--attention)]/40" : "border-border/60",
        className,
      )}
    >
      {/* Code, then city, then how long it is open — the three questions a
          branch is looked up to answer, in that order. The code and the city
          are one statement joined by a middot rather than two runs of text
          separated by a gap, which is how the header line reads everywhere
          else on this page now. */}
      <header className={cn("flex items-start justify-between gap-2", PANEL_CONTEXT.header)}>
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-x-1.5 gap-y-0.5">
            <span className="font-mono text-sm font-semibold">{data.branch_no}</span>
            <span aria-hidden="true" className="text-muted-foreground/50">
              &middot;
            </span>
            <span className="truncate text-xs text-muted-foreground" dir="auto">
              {data.city}
              {data.cityEnglish && ` · ${data.cityEnglish}`}
            </span>
          </div>
          <div className="mt-1.5 flex flex-wrap items-center gap-1">
            {dutyLabel && !referenceLabel && (
              <span
                className={cn(
                  "rounded-full px-2 py-0.5 text-[10px] font-semibold leading-4",
                  data.duty_hours != null && data.duty_hours >= 24
                    ? "bg-[var(--badge-violet)]/12 text-[var(--badge-violet)]"
                    : "bg-muted text-muted-foreground",
                )}
              >
                {dutyLabel}
              </span>
            )}
            {!referenceLabel &&
              (data.scooter ? (
                <span className="inline-flex items-center gap-1 rounded-full bg-[var(--positive)]/12 px-2 py-0.5 text-[10px] font-semibold leading-4 text-[var(--positive)]">
                  <Bike className="h-3 w-3" />
                  {data.scooter_note ?? "Scooter"}
                </span>
              ) : (
                <span className="rounded-full bg-muted px-2 py-0.5 text-[10px] font-medium leading-4 text-muted-foreground">
                  No scooter
                </span>
              ))}
          </div>
        </div>
        <button
          type="button"
          onClick={() => copyText(contactBlock(data), "Branch details")}
          className={cn("shrink-0", PANEL_ACTION)}
        >
          <Copy className="h-3 w-3" aria-hidden="true" />
          Copy all
        </button>
      </header>

      {referenceLabel && (
        <p className="flex items-center gap-1.5 border-b border-[var(--attention)]/25 bg-[var(--attention)]/10 px-4 py-2 text-[11px] font-medium text-[var(--attention)]">
          <Info className="h-3.5 w-3.5 shrink-0" aria-hidden />
          {referenceLabel} — a reference location, not a pharmacy. Customers are not sent here.
        </p>
      )}

      <div className="divide-y divide-border/30 px-4 py-1.5">
        <Row
          icon={Phone}
          label="Phone"
          value={data.phoneDisplay}
          href={data.phoneE164 ? `tel:${data.phoneE164}` : null}
          copyValue={data.phoneDisplay}
          mono
        />
        <Row
          icon={MapPin}
          label="Address"
          value={data.addressLine}
          copyValue={data.address ?? data.addressLine}
        />
        <Row icon={Clock} label="Hours" value={data.working_hours} />
        <Row icon={Clock} label="Friday" value={data.friday_hours} />
        <Row
          icon={Phone}
          label="Manager"
          value={
            data.area_manager && data.managerPhoneDisplay
              ? `${data.area_manager} · ${data.managerPhoneDisplay}`
              : (data.area_manager ?? data.managerPhoneDisplay)
          }
          copyValue={data.managerPhoneDisplay}
        />
        {/* Email is gone. It is a shared mailbox nobody reads inside the length
            of a phone call, and it was the one row on this panel that never
            answered a question a customer had asked. */}
      </div>

      {(data.mapsLink || data.navLink) && (
        <div className={cn("flex flex-wrap gap-1.5 border-t px-4 py-2.5", PANEL_CONTEXT.divider)}>
          {data.mapsLink && (
            <>
              <a
                href={data.mapsLink}
                target="_blank"
                rel="noopener noreferrer"
                className={PANEL_ACTION}
              >
                <ExternalLink className="h-3 w-3" />
                Open map
              </a>
              <button
                type="button"
                onClick={() => copyText(data.mapsLink ?? "", "Maps link")}
                className={PANEL_ACTION}
              >
                <Copy className="h-3 w-3" />
                Copy map link
              </button>
            </>
          )}
          {data.navLink && (
            <a
              href={data.navLink}
              target="_blank"
              rel="noopener noreferrer"
              className={PANEL_ACTION}
            >
              <Navigation className="h-3 w-3" />
              Navigate
            </a>
          )}
        </div>
      )}
    </div>
  );
}
