/**
 * Which dispatch a surface reports on, and whether the AlShrouq card shows at
 * all. Pure — no React, no query client, no network.
 *
 * Both decisions used to be inline: the row split lived in
 * `use-order-dispatch.ts`, the "which row is on display" fallback lived in
 * `dispatch-section.tsx`, and the card's *visibility* lived in a JSX guard in
 * `order-form.tsx`. Three places, no test between them, and the one that broke
 * broke silently.
 *
 * ## Why visibility is not `form.delivery_type === "AlShrouq"`
 *
 * That is what it was, and it is the whole of the disappearing-card bug. The
 * form's `delivery_type` is React state seeded by an effect that runs once per
 * order id, after the `orders` fetch resolves — so it is empty on the first
 * render of every page load, and stays empty for any reason the hydration does
 * not happen (a detail query still in flight, a re-used route component whose
 * `hydratedFor` ref already names the id, an SSR pass where effects do not run
 * at all). The order timeline, meanwhile, renders from the persisted dispatch
 * rows and has no such dependency.
 *
 * Two surfaces describing one delivery from two different sources is what let
 * the timeline go on narrating a scheduled dispatch beside no card at all. So
 * visibility is decided here, from persisted facts, with the transient value as
 * one *additional* reason to show rather than the only one:
 *
 *   * the stored order says AlShrouq — survives every reload, because it is the
 *     column, not a copy of it in component state;
 *   * the order has dispatch history — the same rows the timeline reads, so the
 *     card can no longer vanish while the timeline reports a delivery;
 *   * the form says AlShrouq — a draft, and the moment an agent picks the
 *     method on an order that has not been saved yet.
 *
 * A cancelled or resolved dispatch counts as history on purpose. It is
 * something that happened to this order, and hiding the card would delete the
 * only place an agent can read what.
 */

import { ALSHROUQ } from "./constants";
import { branchCoverage, type BranchCoverage } from "./order-requirements";
import type { AlShrouqBranchResolution } from "@/lib/shams-crm/alshrouq-branches";

/** The columns these decisions actually read. Any dispatch row satisfies it. */
export interface DispatchRowLike {
  cancelled_at?: string | null;
}

/**
 * The live dispatch: the one that is not cancelled.
 *
 * The same predicate as the unique index `alshrouq_dispatches_live_order_key`
 * — `UNIQUE (order_id) WHERE cancelled_at IS NULL` — so at most one row can
 * match, and this returning a single row is the database's guarantee rather
 * than this function's assumption.
 */
export function currentDispatch<T extends DispatchRowLike>(rows: readonly T[]): T | null {
  return rows.find((row) => row.cancelled_at == null) ?? null;
}

/**
 * The most recent row, cancelled or not.
 *
 * The rows arrive oldest first (`order("created_at", { ascending: true })`), so
 * the last one is the newest. Ordering is the query's job and is not redone
 * here: a second sort on a nullable `created_at` would disagree with the
 * database for exactly the rows written in the same millisecond.
 */
export function latestDispatch<T>(rows: readonly T[]): T | null {
  return rows.length > 0 ? (rows[rows.length - 1] ?? null) : null;
}

/**
 * The row the card *reports on*, which is not always the row that owns the slot.
 *
 * `currentDispatch` answers "may this order still be sent"; this answers "what
 * happened to it". They differ only for an order whose every dispatch has been
 * cancelled — which used to come back from the orders list looking as though it
 * had never had one.
 */
export function shownDispatch<T extends DispatchRowLike>(rows: readonly T[]): T | null {
  return currentDispatch(rows) ?? latestDispatch(rows);
}

export interface AlShrouqSectionInput {
  /** `orders.delivery_type` as stored. Undefined while the order is loading. */
  storedDeliveryType: string | null | undefined;
  /** The form's own value. Transient: empty until hydration, and on a draft. */
  formDeliveryType: string | null | undefined;
  /** Whether this order has any dispatch row at all — cancelled ones included. */
  hasDispatchHistory: boolean;
}

/**
 * Whether the order page shows the AlShrouq card.
 *
 * Any one of the three is enough. There is deliberately no condition that can
 * *hide* the card once one of them holds: a card that suppresses itself is how
 * a delivery stops being visible to the person responsible for it.
 */
export function showAlShrouqSection({
  storedDeliveryType,
  formDeliveryType,
  hasDispatchHistory,
}: AlShrouqSectionInput): boolean {
  return hasDispatchHistory || storedDeliveryType === ALSHROUQ || formDeliveryType === ALSHROUQ;
}

/**
 * Which branch-coverage answer the card reports.
 *
 * Two sources exist and they are not interchangeable. `useAlShrouqOrder` derives
 * coverage from the **form**, which is right while the form is the thing being
 * answered — an agent changing the branch watches coverage follow. But it
 * short-circuits to `{ kind: "no_branch" }` the moment `form.delivery_type` is
 * not AlShrouq, and that is not a fact about the order.
 *
 * It produced the worst screen this card has shown: a saved AlShrouq order,
 * reopened, reporting **"Not available — choose a branch to check AlShrouq
 * coverage"** beside a branch that was plainly filled in, on an order the agent
 * had just created *with* a handover. Transient state read as persisted truth.
 *
 * `alshrouqDispatchContext` already resolves the order's own `branch_no`
 * server-side against the same live `branch_options`, and the card already
 * fetches it. So when the form is not answering, that is the answer — no second
 * query, no new state, no new source of truth.
 */
export function cardCoverage(
  formActive: boolean,
  formCoverage: BranchCoverage,
  orderBranch: AlShrouqBranchResolution | null | undefined,
  /**
   * `AlShrouqDispatchContext.optionsError` — set when the CRM could not be read.
   *
   * **This was produced and never consumed.** The server function catches a CRM
   * failure, records the error kind here, and falls back to
   * `{ kind: "unknown", reason: "not_in_crm" }` for the branch. That fallback is
   * indistinguishable from a real answer, so the card reported an outage as
   * *"This branch is not in AlShrouq's list… Report it to whoever maintains the
   * branch list"* — a false claim about the branch, and an errand for someone
   * who cannot fix it. The field existed precisely to prevent that; it simply
   * was never read.
   *
   * Checked before the branch resolution for that reason: when the list never
   * arrived, nothing derived from it is evidence about this branch.
   *
   * It does **not** override the form, which keeps the existing rule that the
   * form's answer is the live one while the form is the thing being answered.
   * `useAlShrouqOrder` reports its own failure as `unavailable` now, so the
   * form's coverage is already terminal on its own account and does not need
   * this one's help.
   */
  optionsError?: string | null,
): BranchCoverage {
  if (formActive) return formCoverage;
  if (optionsError) return { kind: "unavailable", errorKind: optionsError };
  return orderBranch ? branchCoverage(orderBranch) : formCoverage;
}
