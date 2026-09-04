import { createFileRoute } from "@tanstack/react-router";
import { WasfatyPage } from "@/features/telesales/components/wasfaty-page";
import { validateQueueSearch } from "@/features/telesales/queue-search";
import { wasfatyView } from "@/features/telesales/wasfaty-views";

/**
 * Wasfaty — Worked Leads.
 *
 * Leads carrying a recorded action. `last_outcome IS NOT NULL` rather than a
 * status test, because three of the eight Wasfaty actions leave the lead open
 * and a status-based answer would omit every one of them.
 *
 * The route is thin on purpose: it owns the URL and nothing else. What the view
 * *means* lives in `wasfaty-views.ts`, and the list itself is the same
 * `LeadQueue` the Cash desk renders.
 */

const VIEW = wasfatyView("worked");

export const Route = createFileRoute("/_app/telesales/wasfaty/worked")({
  head: () => ({ meta: [{ title: "Wasfaty — Worked leads — MilaServ Portal" }] }),
  // Bound to this view's defaults, so a filter set back to the view's own
  // resting position writes nothing to the URL and reads back unchanged.
  validateSearch: (s: Record<string, unknown>) => validateQueueSearch(s, VIEW.defaults),
  component: Page,
});

function Page() {
  const search = Route.useSearch();
  const navigate = Route.useNavigate();
  return (
    <WasfatyPage
      view="worked"
      search={search}
      onSearchChange={(next, replace) => void navigate({ search: () => next, replace })}
    />
  );
}
