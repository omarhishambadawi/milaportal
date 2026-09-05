import { businessToday, wasfatyWindow } from "@/lib/telesales/dates";
import { DEFAULT_SETTINGS } from "@/lib/telesales/types";
import type { QueueDefaults } from "./queue-search";

/**
 * The three Wasfaty views, as data.
 *
 * ===========================================================================
 * One lead, three questions
 * ===========================================================================
 * There is exactly one Wasfaty lead record, and these are three predicates over
 * it. Nothing here copies, mirrors or re-generates a lead: a prescription that
 * appears in Generated Leads this morning and is called at noon is the same row
 * in Worked Leads that afternoon, and the same row in All Leads forever.
 *
 * That is worth stating because the obvious alternative — a table per view, or
 * a `view` column maintained by the generator — is how a desk ends up with
 * three different answers to "how many leads did we have on Tuesday". Every
 * predicate below is a `WHERE` clause applied by the database on the way out.
 *
 * ===========================================================================
 * What each one actually asks
 * ===========================================================================
 *   - **Generated** — open work that is still current. This is the daily
 *     process's output as the desk experiences it, and it is the default page
 *     because it is the only one of the three that is a to-do list. Its
 *     defaults are the queue's own, unchanged from before the split.
 *
 *   - **All** — the whole of the *current cycle*, worked or not, open or
 *     closed. Its defaults widen `status` and `lifecycle`; the cycle is not a
 *     default in this file because "current" is a datum — whichever month was
 *     imported last — and only the data knows it.
 *
 *     "The current cycle" rather than "every Wasfaty lead ever generated" is
 *     the correction this phase makes. Each monthly file is a cycle of some
 *     3,500 prescriptions; a page that accumulated them would be 6,900 rows
 *     after two months and 10,500 after three, and none of those totals is a
 *     number anybody at the desk has a use for. Historical cycles are one
 *     click away on the Period control, which is where they belong.
 *
 *     Archived leads stay out: archiving is a supervisor's explicit decision
 *     that a lead is not part of the desk's work.
 *
 *   - **Worked** — a recorded action exists. Deliberately `last_outcome IS NOT
 *     NULL` rather than a status test: three of the eight Wasfaty actions leave
 *     the lead open, so a status-based Worked view would silently omit every
 *     lead that was called, actioned, and correctly left in the queue.
 *
 * Generated and Worked overlap, and that is correct rather than a defect. A
 * prescription recorded as "No Answer" this morning is both worked and still
 * to do; a view model that forced it to be one or the other would have to lie
 * about one of them.
 */

export const WASFATY_VIEW_IDS = ["generated", "all", "worked"] as const;
export type WasfatyViewId = (typeof WASFATY_VIEW_IDS)[number];

export interface WasfatyViewDef {
  id: WasfatyViewId;
  label: string;
  /** The route this view lives at. */
  to: string;
  /** One line under the page title, so the three are told apart on sight. */
  description: string;
  /** The queue's `worked` predicate: "all" | "worked" | "unworked". */
  worked: string;
  /**
   * Where `status`, `lifecycle` and the date range rest when the URL says
   * nothing.
   *
   * A function rather than a constant because one of the four is a date, and a
   * date evaluated once at module load is wrong by the following morning. It is
   * called per render; `businessToday()` reads the Riyadh calendar and nothing
   * here caches it.
   */
  defaults: () => Partial<QueueDefaults>;
  /** Does this view work one import cycle at a time? */
  cycles: boolean;
}

/**
 * Generated Leads' resting date range: today and tomorrow.
 *
 * Not a constant, and not a second expression of the rule. `wasfatyWindow` is
 * the function the daily generator itself calls, so the page opens on exactly
 * the window the run produced — on 5 September, the 5th to the 6th — and if the
 * window is ever widened the page follows without being edited.
 *
 * `DEFAULT_SETTINGS` rather than a read of `telesales_settings`: the setting is
 * server-side configuration behind a permission, and a query on every page load
 * to discover a number that has never moved would be a request per agent per
 * morning to say "2".
 */
export function generatedLeadsWindow(): { dateFrom: string; dateTo: string } {
  const w = wasfatyWindow(businessToday(), { days: DEFAULT_SETTINGS.wasfatyWindowDays });
  return { dateFrom: w.from, dateTo: w.to };
}

export const WASFATY_VIEWS: WasfatyViewDef[] = [
  {
    id: "generated",
    label: "Generated Leads",
    to: "/crm/wasfaty",
    description:
      "Prescriptions actionable for the current daily cycle — today and tomorrow, open and still current.",
    worked: "all",
    /*
     * The queue's own status and lifecycle defaults, plus the daily window.
     *
     * The two it inherits are inherited on purpose: this view is the one that
     * must not drift from what the daily process produces. The dates are stated
     * because the agent should not have to reproduce a business rule by hand
     * every morning — the range is already chosen when the page opens.
     */
    defaults: () => generatedLeadsWindow(),
    // A daily view, not a monthly one. The 24-hour rule decides what is on it.
    cycles: false,
  },
  {
    id: "all",
    label: "All Leads",
    to: "/crm/wasfaty/all",
    description:
      "Every prescription in the selected import cycle, whatever its status. Pick a period to see an earlier cycle.",
    worked: "all",
    defaults: () => ({ status: "all", lifecycle: "all" }),
    cycles: true,
  },
  {
    id: "worked",
    label: "Worked Leads",
    to: "/crm/wasfaty/worked",
    description:
      "Prescriptions in the selected cycle that carry a recorded action, whether or not it closed them.",
    worked: "worked",
    defaults: () => ({ status: "all", lifecycle: "all" }),
    cycles: true,
  },
];

export function wasfatyView(id: WasfatyViewId): WasfatyViewDef {
  const found = WASFATY_VIEWS.find((v) => v.id === id);
  // Not a fallback: an unknown id here is a route that was added without a view
  // definition, which should fail loudly in development rather than quietly
  // render the wrong list of leads.
  if (!found) throw new Error(`Unknown Wasfaty view: ${id}`);
  return found;
}
