import { createFileRoute, redirect } from "@tanstack/react-router";
import { validateQueueSearch } from "@/features/telesales/queue-search";

/**
 * `/telesales/wasfaty/worked` — where this view used to live.
 *
 * A redirect, not a second copy of the page. The Wasfaty views moved to
 * `/crm/wasfaty` with the rest of the CRM; an existing bookmark keeps working
 * and keeps its filters, and there is still exactly one implementation of the
 * view behind `/crm/wasfaty/worked`.
 */
export const Route = createFileRoute("/_app/telesales/wasfaty/worked")({
  validateSearch: validateQueueSearch,
  beforeLoad: ({ search }) => {
    throw redirect({ to: "/crm/wasfaty/worked", search, replace: true });
  },
});
