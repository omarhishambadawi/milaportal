import { createFileRoute, redirect } from "@tanstack/react-router";
import { validateQueueSearch } from "@/features/telesales/queue-search";

/**
 * `/telesales` — the CRM's old front door.
 *
 * ===========================================================================
 * Why this file is a redirect and not a page
 * ===========================================================================
 * The CRM is not called Telesales at the route level any more. It has two
 * domains and each has a name: `/crm/cash` and `/crm/wasfaty`. The tables, the
 * permission keys and the feature folder are still `telesales`, because those
 * are storage and renaming them would be a migration and a re-grant to change a
 * string nobody outside the code reads — but the address bar is read by
 * everybody, and it should say which desk you are on.
 *
 * What is deliberately *not* here is a second implementation. Somebody's
 * bookmark, a link in a month-old message, a supervisor's saved filter: all of
 * them still work, and they work by arriving at the one page that exists rather
 * than at a copy of it that will drift.
 *
 * ```
 *   /telesales                 → /crm/cash
 *   /telesales?type=wasfaty    → /crm/wasfaty
 * ```
 *
 * Every other filter travels with the redirect, so a saved "overdue, page 3"
 * lands as exactly that. `type=wasfaty` is dropped on the way, because the
 * Wasfaty pages carry one pipeline and a chip that cannot change anything is
 * not a filter worth preserving.
 */
export const Route = createFileRoute("/_app/telesales/")({
  // Validated before it is forwarded: a hand-edited legacy URL should not be
  // able to hand the new route a filter it has no rendering for.
  validateSearch: validateQueueSearch,
  beforeLoad: ({ search }) => {
    if (search.type === "wasfaty") {
      const { type: _type, ...rest } = search;
      throw redirect({ to: "/crm/wasfaty", search: rest, replace: true });
    }
    throw redirect({ to: "/crm/cash", search, replace: true });
  },
});
