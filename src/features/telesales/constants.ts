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
  /*
   * Wasfaty is the one that carries a colour, and only since the two domains
   * were separated.
   *
   * `#584C7E` is the brief's value and it is used as the *ink*, not as the
   * fill: at 15% the same hue makes a ground pale enough to keep the label
   * legible, and in dark mode the ink lifts to a tint of the same purple
   * because #584C7E against a dark card is roughly 2:1 and unreadable. The
   * exact hue is preserved where it is seen -- the light-mode text and the
   * border -- which is what "use #584C7E" means for a badge.
   */
  wasfaty: "bg-[#584C7E]/15 text-[#584C7E] border-[#584C7E]/40 dark:text-violet-200",
};

/**
 * Recorded action → badge classes.
 *
 * One colour per action and no two alike, because the Worked Leads view is read
 * by scanning this column: a supervisor asking "how many went out of stock
 * yesterday" should be able to answer it without reading a word.
 *
 * Same construction as every other badge in the app — 15% ground, a 40% border
 * and a dark-mode ink that clears contrast on a dark card — so these sit beside
 * the status badges rather than competing with them.
 */
export const OUTCOME_STYLES: Record<string, string> = {
  // Green: the only outcome that made money.
  order_created: "bg-[#10B981]/15 text-[#047857] border-[#10B981]/40 dark:text-emerald-200",
  // Red: reached, and refused.
  no_order: "bg-[#EF4444]/15 text-[#B91C1C] border-[#EF4444]/40 dark:text-red-200",
  // Yellow: nobody picked up. Distinct from the amber below on purpose.
  no_answer: "bg-[#EAB308]/15 text-[#A16207] border-[#EAB308]/40 dark:text-yellow-200",
  // Blue: a promise with a date on it.
  reschedule: "bg-[#3B82F6]/15 text-[#1D4ED8] border-[#3B82F6]/40 dark:text-blue-200",
  // Muted purple: nothing to sell, through no fault of the call.
  dispensed_expired: "bg-[#7C6FA8]/15 text-[#5B4E86] border-[#7C6FA8]/40 dark:text-violet-200",
  // Amber: real, but not worth the dispensing.
  low_price: "bg-[#F59E0B]/15 text-[#B45309] border-[#F59E0B]/40 dark:text-amber-200",
  // Cyan: still supplied; come back later.
  refill_too_soon: "bg-[#06B6D4]/15 text-[#0E7490] border-[#06B6D4]/40 dark:text-cyan-200",
  // Orange: ours to fix, not the customer's.
  out_of_stock: "bg-[#F97316]/15 text-[#C2410C] border-[#F97316]/40 dark:text-orange-200",
  /*
   * The Cash-side vocabulary. Not in the brief's table, which covers the eight
   * Wasfaty actions, but the badge renders wherever an outcome does — so every
   * key the desk can record has an entry and none falls back to a grey nobody
   * can tell apart from another grey.
   */
  interested: "bg-[#8B5CF6]/15 text-[#6D28D9] border-[#8B5CF6]/40 dark:text-violet-200",
  not_interested: "bg-[#EF4444]/10 text-[#B91C1C] border-[#EF4444]/25 dark:text-red-200",
  rejected: "bg-[#EF4444]/10 text-[#B91C1C] border-[#EF4444]/25 dark:text-red-200",
  wrong_number: "bg-muted text-muted-foreground border-border",
  unavailable: "bg-muted text-muted-foreground border-border",
  duplicate: "bg-muted text-muted-foreground border-border",
};

/** The fallback, for an outcome recorded before its key had a colour. */
export const OUTCOME_STYLE_FALLBACK = "bg-muted text-muted-foreground border-border";

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

/**
 * Refill severity to styling.
 *
 * Three states with three jobs, and only one of them moves.
 *
 *   - **Due today** is green, because it is the good case: this is the call
 *     that is exactly on time. It carries a slow breathing dot (see
 *     `refill-today-dot` in `styles.css`) so it is findable while scrolling a
 *     page of fifty rows without being the flashing thing in the corner of
 *     somebody's eye all afternoon.
 *   - **Due later** is light blue — present, informational, not urgent.
 *   - **Overdue** is unchanged, deliberately. It is the only genuinely bad
 *     state and it already reads as one; recolouring it to make the set look
 *     tidier would cost the queue its one real alarm.
 *
 * `none` is unchanged for the same reason it always was: a lead with no cycle
 * has not failed at anything.
 */
export const REFILL_SEVERITY_STYLES: Record<string, string> = {
  due: "bg-[#10B981]/15 text-[#047857] border-[#10B981]/40 dark:text-emerald-200 font-semibold",
  overdue: "bg-[#EF4444]/15 text-[#B91C1C] border-[#EF4444]/40 dark:text-red-200 font-semibold",
  soon: "bg-[#38BDF8]/15 text-[#0369A1] border-[#38BDF8]/40 dark:text-sky-200",
  future: "bg-[#38BDF8]/10 text-[#0369A1] border-[#38BDF8]/25 dark:text-sky-200",
  none: "bg-transparent text-muted-foreground/70 border-transparent",
};

/**
 * "3 days ago" / "today" for a last-contact timestamp.
 *
 * Coarse on purpose: an agent deciding whether to dial cares about the order of
 * magnitude, not the hour.
 */
export function relativeDays(iso: string | null | undefined, today: string): string | null {
  if (!iso) return null;
  const day = iso.slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) return null;
  const diff = Math.round(
    (Date.parse(today + "T00:00:00Z") - Date.parse(day + "T00:00:00Z")) / 86400000,
  );
  if (diff <= 0) return "today";
  if (diff === 1) return "yesterday";
  return diff + " days ago";
}

export const PAGE_SIZE_OPTIONS = [25, 50, 100] as const;
export const DEFAULT_PAGE_SIZE = 50;

/**
 * How a phone number is shown, and how it is dialled.
 *
 * Both re-exported from `src/lib/phone.ts` rather than reimplemented here. This
 * file used to carry its own `+966 53 532 3292` grouping, which was a second
 * format for the desk to reconcile against the one in the database — precisely
 * the drift the canonical format exists to end. The screen now shows exactly
 * what is stored: `0535323292`.
 *
 * `telHref` still emits E.164, because a `tel:` URI is a protocol value rather
 * than a stored one and `+966…` is what dials correctly from a softphone or a
 * roaming handset.
 */
export { formatSaudiPhone as formatPhone, telHref } from "@/lib/phone";

/**
 * The operational filter: which leads are on the board at all.
 *
 * "Active" is the default and includes leads that never had a refill date to
 * expire — a Wasfaty prescription or a Cash invoice is not stale, it simply has
 * no cycle — because setting those aside would hide work that is perfectly
 * current.
 *
 * "Archived" is on this control rather than in a tab of its own, which is the
 * whole reason the control exists: an agent picks where they are working from
 * one place, and archived rows can only be reached by asking for them. It is
 * also the only one of the four that is not a *lifecycle* value — the first
 * three read the derived `lifecycle` column, while archived selects on
 * `archived_at`. They share a control because an operator is choosing a view,
 * not a column.
 */
export const LIFECYCLE_FILTER_OPTIONS = [
  { value: "active", label: "Active leads" },
  { value: "stale", label: "Stale" },
  { value: "all", label: "Active + stale" },
  { value: "archived", label: "Archived" },
] as const;

/**
 * How a stale lead is drawn.
 *
 * Muted, not alarming. A stale lead is not an error and not a failure — it is
 * an old opportunity, and the brief is explicit that it should read that way.
 * Rendering 501 of 712 rows in red would make the queue unreadable and would
 * mean the genuinely urgent leads no longer stand out, which is the exact
 * problem this phase set out to solve.
 */
export const STALE_BADGE_STYLE = "bg-muted text-muted-foreground border-border font-normal";
