import type { LeadStatus, LeadType } from "@/lib/telesales/types";

/**
 * Presentation constants for the Telesales module.
 *
 * The colour vocabulary is the app's existing one — the amber / emerald / red
 * triple that `STATUS_STYLES` in `src/lib/branches.ts` uses for orders and
 * complaints — so a lead badge reads the same way an order badge does. Nothing
 * here introduces a new palette; the brief is explicit that the module must not
 * have its own visual identity.
 */

/** Lead status → badge classes. Same shape and tokens as `STATUS_STYLES`. */
export const LEAD_STATUS_STYLES: Record<LeadStatus, string> = {
  new: "bg-primary/10 text-primary border-primary/30",
  assigned: "bg-[#3B82F6]/15 text-[#1D4ED8] border-[#3B82F6]/40 dark:text-blue-200",
  in_progress: "bg-[#F59E0B]/15 text-[#B45309] border-[#F59E0B]/40 dark:text-amber-200",
  follow_up: "bg-[#8B5CF6]/15 text-[#6D28D9] border-[#8B5CF6]/40 dark:text-violet-200",
  converted: "bg-[#10B981]/15 text-[#047857] border-[#10B981]/40 dark:text-emerald-200",
  closed_lost: "bg-[#EF4444]/15 text-[#B91C1C] border-[#EF4444]/40 dark:text-red-200",
  closed_unreachable: "bg-muted text-muted-foreground border-border",
  closed_duplicate: "bg-muted text-muted-foreground border-border",
};

/**
 * Lead type → badge classes.
 *
 * Muted on purpose. The type is context, not a warning: an agent scanning the
 * queue is looking for the status and the due date, and three saturated
 * pipeline colours competing with them would make the column that matters
 * harder to find.
 */
export const LEAD_TYPE_STYLES: Record<LeadType, string> = {
  cash: "bg-secondary text-secondary-foreground border-border",
  retention: "bg-secondary text-secondary-foreground border-border",
  wasfaty: "bg-secondary text-secondary-foreground border-border",
};

/** How a follow-up's urgency colours its cell. Mirrors `describeDue`'s tones. */
export const DUE_TONE_STYLES: Record<"overdue" | "today" | "upcoming" | "none", string> = {
  overdue: "text-[#B91C1C] dark:text-red-300 font-medium",
  today: "text-[#B45309] dark:text-amber-200 font-medium",
  upcoming: "text-muted-foreground",
  none: "text-muted-foreground/60",
};

export const STATUS_FILTER_OPTIONS = [
  { value: "open", label: "Open" },
  { value: "all", label: "All statuses" },
  { value: "new", label: "New" },
  { value: "assigned", label: "Assigned" },
  { value: "in_progress", label: "In progress" },
  { value: "follow_up", label: "Follow-up" },
  { value: "converted", label: "Converted" },
  { value: "closed_lost", label: "Not interested" },
  { value: "closed_unreachable", label: "Unreachable" },
  { value: "closed_duplicate", label: "Duplicate" },
] as const;

export const FOLLOWUP_FILTER_OPTIONS = [
  { value: "all", label: "Any follow-up" },
  { value: "today", label: "Due today" },
  { value: "overdue", label: "Overdue" },
  { value: "upcoming", label: "Upcoming" },
  { value: "none", label: "Not scheduled" },
] as const;

export const PAGE_SIZE_OPTIONS = [25, 50, 100] as const;
export const DEFAULT_PAGE_SIZE = 50;

/**
 * How a phone number is shown.
 *
 * `+966 53 532 3292`. Grouped because an agent reads it aloud while dialling,
 * and a 13-character run of digits is the shape people misread.
 */
export function formatPhone(e164: string | null | undefined): string {
  if (!e164) return "—";
  const m = /^\+966(\d{2})(\d{3})(\d{4})$/.exec(e164);
  return m ? `+966 ${m[1]} ${m[2]} ${m[3]}` : e164;
}

/** `tel:` href, or null when there is nothing to dial. */
export function telHref(e164: string | null | undefined): string | null {
  return e164 ? `tel:${e164}` : null;
}
