import { createFileRoute } from "@tanstack/react-router";
import { WasfatyPage } from "@/features/telesales/components/wasfaty-page";
import { validateQueueSearch } from "@/features/telesales/queue-search";
import { wasfatyView } from "@/features/telesales/wasfaty-views";

/**
 * Wasfaty — All Leads.
 *
 * The complete population, worked or not, open or closed. Not a second copy of
 * anything: the same rows the Generated view shows, asked without the two
 * narrowing defaults.
 *
 * The route is thin on purpose: it owns the URL and nothing else. What the view
 * *means* lives in `wasfaty-views.ts`, and the list itself is the same
 * `LeadQueue` the Cash desk renders.
 */

const VIEW = wasfatyView("all");

export const Route = createFileRoute("/_app/crm/wasfaty/all")({
  head: () => ({ meta: [{ title: "Wasfaty — All leads — MilaServ Portal" }] }),
  // Bound to this view's defaults, so a filter set back to the view's own
  // resting position writes nothing to the URL and reads back unchanged.
  validateSearch: (s: Record<string, unknown>) => validateQueueSearch(s, VIEW.defaults()),
  component: Page,
});

function Page() {
  const search = Route.useSearch();
  const navigate = Route.useNavigate();
  return (
    <WasfatyPage
      view="all"
      search={search}
      onSearchChange={(next, replace) => void navigate({ search: () => next, replace })}
    />
  );
}
