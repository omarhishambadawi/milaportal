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
