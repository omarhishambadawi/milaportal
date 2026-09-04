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
 *   - **All** — the whole population, worked or not, open or closed. Its
 *     defaults widen `status` and `lifecycle`, which is the entire difference.
 *     Archived leads stay out: archiving is a supervisor's explicit decision
 *     that a lead is not part of the desk's work, and it is still reachable
 *     from the lifecycle control on the page.
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
  /** Where `status` and `lifecycle` rest when the URL says nothing. */
  defaults: Partial<QueueDefaults>;
}

export const WASFATY_VIEWS: WasfatyViewDef[] = [
  {
    id: "generated",
    label: "Generated Leads",
    to: "/telesales/wasfaty",
    description:
      "Today's actionable prescriptions, from the daily generation run. Open and still current.",
    worked: "all",
    // The queue's own defaults. Named by omission on purpose: this view is the
    // one that must not drift from what the daily process produces.
    defaults: {},
  },
  {
    id: "all",
    label: "All Leads",
    to: "/telesales/wasfaty/all",
    description: "Every Wasfaty lead ever generated, whatever its status.",
    worked: "all",
    defaults: { status: "all", lifecycle: "all" },
  },
  {
    id: "worked",
    label: "Worked Leads",
    to: "/telesales/wasfaty/worked",
    description: "Leads with a recorded action, whether or not the action closed them.",
    worked: "worked",
    defaults: { status: "all", lifecycle: "all" },
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
