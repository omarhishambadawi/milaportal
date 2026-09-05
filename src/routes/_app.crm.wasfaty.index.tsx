import { createFileRoute } from "@tanstack/react-router";
import { WasfatyPage } from "@/features/telesales/components/wasfaty-page";
import { validateQueueSearch } from "@/features/telesales/queue-search";
import { wasfatyView } from "@/features/telesales/wasfaty-views";

/**
 * Wasfaty — Generated Leads. The desk's default page.
 *
 * The daily generation run's output, as work: open leads whose prescription is
 * still current. Nothing about that run changed in this phase — this page is
 * the same query the combined queue ran with the Wasfaty chip selected.
 *
 * The route is thin on purpose: it owns the URL and nothing else. What the view
 * *means* lives in `wasfaty-views.ts`, and the list itself is the same
 * `LeadQueue` the Cash desk renders.
 */

const VIEW = wasfatyView("generated");

export const Route = createFileRoute("/_app/crm/wasfaty/")({
  head: () => ({ meta: [{ title: "Wasfaty — MilaServ Portal" }] }),
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
      view="generated"
      search={search}
      onSearchChange={(next, replace) => void navigate({ search: () => next, replace })}
    />
  );
}
